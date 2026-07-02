import {
  isFacilitatorRequest,
  toX402ErrorReason,
  validatePaymentRetry,
  type FacilitatorRequest,
  type SettleResponse,
  type SettlementResponse,
  type SupportedKind,
  type SupportedResponse,
  type VerifyResponse,
} from "@kaspa-x402/core";
import { KaspaX402Error } from "@kaspa-x402/core";
import { DirectModeServer } from "@kaspa-x402/server";

type FacilitatorMode = "verify" | "settle" | "claim" | "refund";
const FACILITATOR_MODES = new Set<FacilitatorMode>(["verify", "settle", "claim", "refund"]);

export interface FacilitatorConfig {
  server: DirectModeServer;
  supportedKinds?: SupportedKind[];
  extensions?: string[];
  signers?: Record<string, string[]>;
  claimSettler?: FacilitatorActionSettler;
  refundSettler?: FacilitatorActionSettler;
}

export interface FacilitatorActionContext {
  facilitator: DirectModeFacilitator;
  server: DirectModeServer;
}

export type FacilitatorActionSettler = (
  request: FacilitatorRequest,
  context: FacilitatorActionContext,
) => Promise<SettlementResponse> | SettlementResponse;

export interface FacilitatorHttpRequest {
  method: string;
  path: string;
  body?: unknown;
}

export interface FacilitatorHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export class DirectModeFacilitator {
  readonly #config: FacilitatorConfig;

  constructor(config: FacilitatorConfig) {
    this.#config = config;
  }

  supported(): SupportedResponse {
    return {
      kinds: executableKinds(this.#config.supportedKinds ?? this.#config.server.supportedKinds(), this.#config),
      extensions: this.#config.extensions ?? [],
      signers: this.#config.signers ?? {},
    };
  }

  async verify(input: unknown): Promise<VerifyResponse> {
    if (!isFacilitatorRequest(input)) {
      return invalidVerify("invalid_kaspa_x402_payload");
    }
    const unsupportedReason = this.#unsupportedReason(input, "verify");
    if (unsupportedReason) return invalidVerify(unsupportedReason);
    try {
      const verification = await this.#config.server.verifyPayment(input);
      return {
        isValid: true,
        ...(verification.payer ? { payer: verification.payer } : {}),
        ...(verification.extra ? { extra: verification.extra } : {}),
      };
    } catch (error) {
      return invalidVerify(errorCode(error));
    }
  }

  async settle(input: unknown): Promise<SettleResponse> {
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
        return await actionSettler(input, { facilitator: this, server: this.#config.server });
      } catch (error) {
        return invalidSettlement(errorCode(error), network);
      }
    }
    try {
      return await this.#config.server.settlePayment(input);
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
    if (!isFacilitatorRequest(request.body)) {
      return jsonResponse(400, invalidVerify("invalid_kaspa_x402_payload"));
    }
    const body = await facilitator.verify(request.body);
    return jsonResponse(200, body);
  }
  if (method === "POST" && path === "/settle") {
    if (!isFacilitatorRequest(request.body)) {
      return jsonResponse(400, invalidSettlement("invalid_kaspa_x402_payload"));
    }
    const body = await facilitator.settle(request.body);
    return jsonResponse(200, body);
  }
  return jsonResponse(404, { error: "not_found" });
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

function networkFromRequest(request: FacilitatorRequest): string {
  const network = request.paymentRequirements.network;
  return typeof network === "string" ? network : "kaspa:testnet-10";
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

function invalidSettlement(errorReason: string, network = "kaspa:testnet-10"): SettlementResponse {
  return {
    success: false,
    errorReason: toX402ErrorReason(errorReason),
    transaction: "",
    network: network === "kaspa:mainnet" ? "kaspa:mainnet" : "kaspa:testnet-10",
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
