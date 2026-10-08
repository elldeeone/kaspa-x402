import {
  KASPA_X402_RESOURCE_BUDGET,
  assertJsonResourceBudget,
  canonicalTrustedSecurityContext,
  decodeBoundedJsonBytes,
  isFacilitatorRequest,
  isKaspaX402Network,
  assertMainnetAllowed,
  toX402ErrorReason,
  validatePaymentRetry,
  type FacilitatorRequest,
  type SettleResponse,
  type SettlementResponse,
  type SupportedKind,
  type SupportedResponse,
  type TrustedSecurityContext,
  type VerifyResponse,
} from "@kaspa-x402/core";
import { KaspaX402Error } from "@kaspa-x402/core";
import { DirectModeServer, type PaidRouteAccess } from "@kaspa-x402/server";

type FacilitatorMode = "verify" | "settle" | "claim" | "refund";
const FACILITATOR_MODES = new Set<FacilitatorMode>(["verify", "settle", "claim", "refund"]);

export interface FacilitatorConfig {
  server: DirectModeServer;
  supportedKinds?: SupportedKind[];
  extensions?: string[];
  signers?: Record<string, string[]>;
  claimSettler?: FacilitatorActionSettler;
  refundSettler?: FacilitatorActionSettler;
  allowMainnet?: boolean;
}

export interface FacilitatorActionContext {
  facilitator: DirectModeFacilitator;
  server: DirectModeServer;
  trustedSecurityContext?: TrustedSecurityContext;
  signal: AbortSignal;
}

export type FacilitatorActionSettler = (
  request: FacilitatorRequest,
  context: FacilitatorActionContext,
) => Promise<SettlementResponse> | SettlementResponse;

export interface FacilitatorHttpRequest {
  routeAccess: PaidRouteAccess;
  method: string;
  path: string;
  /** Parsed JSON or bounded raw UTF-8 JSON bytes. */
  body?: unknown;
  /** Host-derived normalized claims, never a value read from body. */
  trustedSecurityContext?: TrustedSecurityContext;
  /** Caller cancellation propagated into verification and chain observers. */
  signal?: AbortSignal;
}

export interface FacilitatorHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export class DirectModeFacilitator {
  readonly #config: FacilitatorConfig;

  constructor(config: FacilitatorConfig) {
    for (const kind of [...config.server.supportedKinds(), ...(config.supportedKinds ?? [])]) {
      assertMainnetAllowed(kind.network, config.allowMainnet, "DirectModeFacilitator");
    }
    this.#config = config;
  }

  supported(): SupportedResponse {
    return {
      kinds: executableKinds(this.#config.supportedKinds ?? this.#config.server.supportedKinds(), this.#config),
      extensions: this.#config.extensions ?? [],
      signers: this.#config.signers ?? {},
    };
  }

  async verify(
    input: unknown,
    routeAccess: PaidRouteAccess,
    trustedSecurityContext?: TrustedSecurityContext,
    signal?: AbortSignal,
  ): Promise<VerifyResponse> {
    try {
      trustedSecurityContext = facilitatorRouteContext(routeAccess, trustedSecurityContext);
    } catch {
      return invalidVerify("invalid_kaspa_x402_payload");
    }
    if (!isFacilitatorRequest(input)) {
      return invalidVerify("invalid_kaspa_x402_payload");
    }
    const unsupportedReason = this.#unsupportedReason(input, "verify");
    if (unsupportedReason) return invalidVerify(unsupportedReason);
    try {
      const verification = await this.#config.server.verifyPayment(
        facilitatorServerOptions(input, routeAccess, trustedSecurityContext, signal),
      );
      return {
        isValid: true,
        ...(verification.payer ? { payer: verification.payer } : {}),
        ...(verification.extra ? { extra: verification.extra } : {}),
      };
    } catch (error) {
      return invalidVerify(errorCode(error));
    }
  }

  async settle(
    input: unknown,
    routeAccess: PaidRouteAccess,
    trustedSecurityContext?: TrustedSecurityContext,
    signal?: AbortSignal,
  ): Promise<SettleResponse> {
    try {
      trustedSecurityContext = facilitatorRouteContext(routeAccess, trustedSecurityContext);
    } catch {
      return invalidSettlement("invalid_kaspa_x402_payload");
    }
    if (!isFacilitatorRequest(input)) {
      return invalidSettlement("invalid_kaspa_x402_payload");
    }
    const network = networkFromRequest(input);
    const mode = settlementMode(input);
    if (!mode) return invalidSettlement("invalid_kaspa_x402_payload", network);
    const unsupportedReason = this.#unsupportedReason(input, mode);
    if (unsupportedReason) return invalidSettlement(unsupportedReason, network);
    if (mode === "claim" || mode === "refund") {
      const actionValidationError = validateActionRequest(input);
      if (actionValidationError) return invalidSettlement(actionValidationError, network);
      const actionSettler = this.#actionSettler(mode);
      if (!actionSettler) return invalidSettlement("unsupported_kaspa_facilitator_action", network);
      try {
        const payload = input.paymentPayload.payload;
        const channelKey =
          isRecord(payload) && typeof payload.channelId === "string"
            ? payload.channelId
            : undefined;
        return await this.#config.server.runPublicAdapter(
          `facilitator-${mode}-settler`,
          trustedSecurityContext,
          channelKey,
          (adapterSignal) =>
            actionSettler(input, {
              facilitator: this,
              server: this.#config.server,
              signal: adapterSignal,
              ...(trustedSecurityContext ? { trustedSecurityContext } : {}),
            }),
          signal,
        );
      } catch (error) {
        return invalidSettlement(errorCode(error), network);
      }
    }
    try {
      return await this.#config.server.settlePayment(
        facilitatorServerOptions(input, routeAccess, trustedSecurityContext, signal),
      );
    } catch (error) {
      return invalidSettlement(errorCode(error), network);
    }
  }

  #actionSettler(mode: "claim" | "refund"): FacilitatorActionSettler | undefined {
    if (mode === "claim") return this.#config.claimSettler;
    if (mode === "refund") return this.#config.refundSettler;
    return undefined;
  }

  #unsupportedReason(request: FacilitatorRequest, mode: FacilitatorMode): string | undefined {
    const kinds = this.supported().kinds;
    const schemeSupported = kinds.some((kind) => kind.scheme === request.paymentRequirements.scheme);
    if (!schemeSupported) return "unsupported_scheme";
    const pair = kinds.find(
      (kind) => kind.scheme === request.paymentRequirements.scheme && kind.network === request.paymentRequirements.network,
    );
    if (!pair) return "invalid_kaspa_x402_network";
    return kindSupportsMode(pair, mode) ? undefined : "unsupported_kaspa_facilitator_action";
  }
}

function facilitatorServerOptions(
  input: FacilitatorRequest,
  routeAccess: PaidRouteAccess,
  trustedSecurityContext?: TrustedSecurityContext,
  signal?: AbortSignal,
) {
  return {
    routeAccess,
    paymentPayload: input.paymentPayload,
    paymentRequirements: input.paymentRequirements,
    ...(input.resource ? { resource: input.resource } : {}),
    ...(input.requestHash ? { requestHash: input.requestHash } : {}),
    ...(trustedSecurityContext ? { trustedSecurityContext } : {}),
    ...(signal ? { signal } : {}),
  };
}

export async function handleFacilitatorRequest(
  facilitator: DirectModeFacilitator,
  request: FacilitatorHttpRequest,
): Promise<FacilitatorHttpResponse> {
  const method = request.method.toUpperCase();
  const path = normalizedPath(request.path);

  if (method === "GET" && path === "/supported") {
    return jsonResponse(200, facilitator.supported());
  }
  if (method === "POST" && path === "/verify") {
    const input = facilitatorBody(request.body);
    if (!isFacilitatorRequest(input)) {
      return jsonResponse(400, invalidVerify("invalid_kaspa_x402_payload"));
    }
    const body = await facilitator.verify(
      input,
      request.routeAccess,
      request.trustedSecurityContext,
      request.signal,
    );
    return jsonResponse(200, body);
  }
  if (method === "POST" && path === "/settle") {
    const input = facilitatorBody(request.body);
    if (!isFacilitatorRequest(input)) {
      return jsonResponse(400, invalidSettlement("invalid_kaspa_x402_payload"));
    }
    const body = await facilitator.settle(
      input,
      request.routeAccess,
      request.trustedSecurityContext,
      request.signal,
    );
    return jsonResponse(200, body);
  }
  return jsonResponse(404, { error: "not_found" });
}

function facilitatorRouteContext(
  routeAccess: PaidRouteAccess,
  context?: TrustedSecurityContext,
): TrustedSecurityContext | undefined {
  if (routeAccess === "public" && context === undefined) return undefined;
  if (routeAccess !== "authenticated" || !context || typeof context !== "object" || Array.isArray(context)) {
    throw new KaspaX402Error("invalid_kaspa_x402_payload", "invalid paid route context");
  }
  const canonical = canonicalTrustedSecurityContext(context) as unknown as {
    principal: string;
    tenant: string | null;
    authorizationScopes: string[];
    handlerState: Record<string, string | number | boolean | null>;
  };
  return {
    principal: canonical.principal,
    ...(canonical.tenant === null ? {} : { tenant: canonical.tenant }),
    authorizationScopes: canonical.authorizationScopes,
    handlerState: canonical.handlerState,
  };
}

export interface FacilitatorBodyReadOptions {
  /** Overall stream deadline. Defaults to 10 seconds. */
  timeoutMs?: number;
}

const DEFAULT_FACILITATOR_BODY_TIMEOUT_MS = 10_000;

/** Read an embedding Request without materializing more than the shared limit. */
export async function readFacilitatorRequestBody(request: {
  body: ReadableStream<Uint8Array> | null;
  headers: { get(name: string): string | null };
  signal?: AbortSignal;
}, options: FacilitatorBodyReadOptions = {}): Promise<unknown> {
  const maximum = KASPA_X402_RESOURCE_BUDGET.maxDecodedHeaderBytes;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FACILITATOR_BODY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      "facilitator request body timeout must be a positive safe integer",
    );
  }
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > maximum)
  )
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      `facilitator request body exceeds decoded limit ${maximum} bytes`,
    );
  if (!request.body)
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      "facilitator request body is required",
    );
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(
        new KaspaX402Error(
          "invalid_kaspa_x402_payload",
          `facilitator request body timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
  });
  const aborted = new Promise<never>((_, reject) => {
    abortHandler = () => {
      reject(
        new KaspaX402Error(
          "invalid_kaspa_x402_payload",
          "facilitator request body was aborted",
        ),
      );
    };
    if (request.signal?.aborted) abortHandler();
    else request.signal?.addEventListener("abort", abortHandler, { once: true });
  });
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), deadline, aborted]);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximum) {
        throw new KaspaX402Error(
          "invalid_kaspa_x402_payload",
          `facilitator request body exceeds decoded limit ${maximum} bytes`,
        );
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    if (abortHandler) request.signal?.removeEventListener("abort", abortHandler);
    try {
      reader.releaseLock();
    } catch {
      // Cancellation still owns a pending read; the stream will release it.
    }
  }
  const raw = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decodeBoundedJsonBytes(raw, "facilitator request body");
}

function facilitatorBody(body: unknown): unknown {
  try {
    if (typeof body === "string" || body instanceof Uint8Array)
      return decodeBoundedJsonBytes(body, "facilitator request body");
    assertJsonResourceBudget(body, { label: "facilitator request body" });
    return body;
  } catch {
    return undefined;
  }
}

function executableKinds(kinds: SupportedKind[], config: FacilitatorConfig): SupportedKind[] {
  const serverKinds = config.server.supportedKinds();
  return kinds.flatMap((kind) => {
    const modes = kind.extra?.modes;
    if (!Array.isArray(modes)) return [];
    if (!modes.every(isFacilitatorMode)) return [];
    const serverKind = serverKinds.find((supported) => supported.scheme === kind.scheme && supported.network === kind.network);
    if (!serverKind) return [];
    const serverModes = supportedModes(serverKind);
    const executableModes = uniqueModes(modes).filter((mode) => {
      if (mode === "verify" || mode === "settle") return serverModes.has(mode);
      if (mode === "claim") return kind.scheme === "batch-settlement" && Boolean(config.claimSettler);
      if (mode === "refund") return kind.scheme === "batch-settlement" && Boolean(config.refundSettler);
      return false;
    });
    if (executableModes.length === 0) return [];
    return {
      ...serverKind,
      extra: {
        ...serverKind.extra,
        modes: executableModes,
      },
    };
  });
}

function supportedModes(kind: SupportedKind): Set<FacilitatorMode> {
  const modes = kind.extra?.modes;
  if (!Array.isArray(modes)) return new Set();
  return new Set(modes.filter(isFacilitatorMode));
}

function uniqueModes(modes: FacilitatorMode[]): FacilitatorMode[] {
  return [...new Set(modes)];
}

function isFacilitatorMode(value: unknown): value is FacilitatorMode {
  return typeof value === "string" && FACILITATOR_MODES.has(value as FacilitatorMode);
}

function kindSupportsMode(kind: SupportedKind, mode: FacilitatorMode): boolean {
  const modes = kind.extra?.modes;
  if (!Array.isArray(modes)) return false;
  return modes.includes(mode);
}

function settlementMode(request: FacilitatorRequest): FacilitatorMode | undefined {
  const type = paymentPayloadType(request);
  if (type === "claim" || type === "refund") return type;
  if (type) return "settle";
  return undefined;
}

function paymentPayloadType(request: FacilitatorRequest): string | undefined {
  const payload = request.paymentPayload.payload;
  if (!isRecord(payload)) return undefined;
  return typeof payload.type === "string" ? payload.type : undefined;
}

function networkFromRequest(request: FacilitatorRequest): string | undefined {
  const network = request.paymentRequirements.network;
  return typeof network === "string" ? network : undefined;
}

function validateActionRequest(request: FacilitatorRequest): string | undefined {
  const retry = validatePaymentRetry({
    paymentPayload: request.paymentPayload,
    paymentRequired: {
      x402Version: request.x402Version,
      resource: request.resource ?? { url: "kaspa-x402:facilitator" },
      accepts: [request.paymentRequirements],
    },
  });
  return retry.ok ? undefined : retry.error.code;
}

function invalidVerify(invalidReason: string): VerifyResponse {
  return {
    isValid: false,
    invalidReason: toX402ErrorReason(invalidReason),
  };
}

function invalidSettlement(errorReason: string, network?: string): SettlementResponse {
  return {
    success: false,
    errorReason: toX402ErrorReason(errorReason),
    transaction: "",
    ...(network && isKaspaX402Network(network) ? { network } : {}),
  };
}

function errorCode(error: unknown): string {
  if (error instanceof KaspaX402Error) return error.code;
  return "invalid_kaspa_x402_payload";
}

function normalizedPath(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) return new URL(path).pathname;
  const [pathname] = path.split("?");
  return pathname || "/";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonResponse(status: number, body: unknown): FacilitatorHttpResponse {
  return {
    status,
    headers: {
      "content-type": "application/json",
    },
    body,
  };
}
