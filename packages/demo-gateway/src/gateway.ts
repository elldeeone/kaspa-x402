import {
  decodePaymentSignatureHeader,
  KaspaX402Error,
  toX402ErrorReason,
  type ResourceInfo,
} from "@kaspa-x402/core";
import {
  DirectModeServer,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  type ServerStateStore,
} from "@kaspa-x402/server";
import {
  KaspaRestClient,
  NativeAddressCodec,
  NativeVoucherVerifier,
  RestExactTransactionVerifier,
  RestKaspaChainProvider,
  ScriptAddressBook,
} from "./adapters.js";
import { readGatewayConfig, type GatewayConfig, type GatewayEnv } from "./config.js";
import { RemoteGatewayState } from "./remote-state.js";
import { DurableGatewayLockManager, type GatewayStateClient } from "./state.js";

type Profile = "exact" | "batch-settlement";

export async function handleGatewayRequest(request: Request, env: GatewayEnv, context: ExecutionContext): Promise<Response> {
  let config: GatewayConfig;
  try {
    config = readGatewayConfig(env);
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, { status: 503, headers: corsHeaders(undefined) });
  }

  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(config) });

  const state = new RemoteGatewayState(env.GATEWAY_STATE);
  if (url.pathname === "/" && request.method === "GET") return json(indexBody(url), { headers: corsHeaders(config) });
  if (url.pathname === "/health" && request.method === "GET") return healthResponse(config, state);
  if (url.pathname === "/metrics" && request.method === "GET") return json({ ok: true, metrics: await state.metrics() }, { headers: corsHeaders(config) });

  const gateway = createGateway(config, state);
  if (url.pathname === "/supported" && request.method === "GET") {
    return json({ ok: true, kinds: gateway.server.supportedKinds() }, { headers: corsHeaders(config) });
  }

  const profile = routeProfile(url.pathname);
  if (!profile) return json({ ok: false, error: "not_found" }, { status: 404, headers: corsHeaders(config) });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ ok: false, error: "method_not_allowed" }, { status: 405, headers: corsHeaders(config) });
  }

  const rate = await state.checkRateLimit(rateScope(request, profile), Date.now(), config.rateLimitPerMinute, 60_000);
  if (!rate.allowed) {
    return json(
      { ok: false, error: "rate_limited", resetAt: new Date(rate.resetAt).toISOString() },
      { status: 429, headers: { ...corsHeaders(config), "retry-after": String(Math.max(1, Math.ceil((rate.resetAt - Date.now()) / 1000))) } },
    );
  }

  const resource = resourceFor(url, profile);
  const unsupported = gatewayUnsupportedPaymentResponse(request, gateway.server, resource, profile, config);
  if (unsupported) {
    context.waitUntil(state.incrementMetric("unsupported_payment_retries"));
    return withCors(unsupported, config);
  }

  context.waitUntil(state.incrementMetric(`requests_${profileMetric(profile)}`));
  const result = await gateway.server.handlePaidRequest(
    {
      method: request.method,
      url: url.toString(),
      headers: request.headers,
      resource,
      paymentAmount: amountFor(config, profile),
      paymentScheme: profile,
    },
    async ({ payment, requestFingerprint, paymentIdentifier }) => ({
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: {
        ok: true,
        network: config.network,
        profile,
        resource: resource.url,
        requestFingerprint,
        paymentIdentifier,
        payment:
          payment.scheme === "exact"
            ? {
                scheme: payment.scheme,
                transactionId: payment.transactionId,
                paymentOutputIndex: payment.paymentOutputIndex,
                finality: payment.finality,
              }
            : {
                scheme: payment.scheme,
                channelId: payment.channel.channelId,
                openedChannel: payment.openedChannel,
                chargedCumulativeAmount: payment.channel.chargedCumulativeAmount,
              },
      },
      chargedAmount: payment.accepted.amount,
    }),
  );

  if (result.status === 402) context.waitUntil(state.incrementMetric(`offers_${profileMetric(profile)}`));
  else if (result.status >= 200 && result.status < 300) context.waitUntil(state.incrementMetric(`paid_${profileMetric(profile)}`));
  else context.waitUntil(state.incrementMetric("errors_total"));
  return serverResponse(result, config, request.method === "HEAD");
}

function createGateway(config: GatewayConfig, state: GatewayStateClient): { server: DirectModeServer } {
  const book = new ScriptAddressBook();
  const addressCodec = new NativeAddressCodec(book);
  const rest = new KaspaRestClient(config.chainApiBase);
  const store = new AddressRecordingStore(state, book);
  const server = new DirectModeServer({
    network: config.network,
    payTo: config.payTo,
    serverPublicKey: config.serverPublicKey,
    minDepositSompi: config.minDepositSompi,
    amount: config.batchAmount,
    refundTimeoutDaa: config.refundTimeoutDaa,
    maxTimeoutSeconds: config.maxTimeoutSeconds,
    store,
    chainProvider: new RestKaspaChainProvider(rest, book, config.claimFeeSompi),
    addressCodec,
    voucherVerifier: new NativeVoucherVerifier(),
    exactTransactionVerifier: new RestExactTransactionVerifier(rest),
    lockManager: new DurableGatewayLockManager(state),
    acceptedFinality: "accepted",
    requirePaymentIdentifier: false,
  });
  return { server };
}

class AddressRecordingStore implements ServerStateStore {
  readonly #inner: GatewayStateClient;
  readonly #book: ScriptAddressBook;

  constructor(inner: GatewayStateClient, book: ScriptAddressBook) {
    this.#inner = inner;
    this.#book = book;
  }

  async loadChannel(channelId: string) {
    const channel = await this.#inner.loadChannel(channelId);
    if (channel) this.#book.record(channel.activeScriptPublicKey, channel.escrowAddress);
    return channel;
  }

  async saveChannel(channel: Parameters<ServerStateStore["saveChannel"]>[0]) {
    this.#book.record(channel.activeScriptPublicKey, channel.escrowAddress);
    return this.#inner.saveChannel(channel);
  }

  async listChannels() {
    const channels = await this.#inner.listChannels();
    for (const channel of channels) this.#book.record(channel.activeScriptPublicKey, channel.escrowAddress);
    return channels;
  }

  retireChannel(channelId: string, reason?: string) {
    return this.#inner.retireChannel(channelId, reason);
  }

  loadCommitment(commitmentId: string) {
    return this.#inner.loadCommitment(commitmentId);
  }

  loadPaymentIdentifier(id: string) {
    return this.#inner.loadPaymentIdentifier(id);
  }

  loadExactPayment(transactionId: string) {
    return this.#inner.loadExactPayment(transactionId);
  }

  commitSettlement(record: Parameters<ServerStateStore["commitSettlement"]>[0]) {
    return this.#inner.commitSettlement(record);
  }

  commitExactPayment(record: Parameters<ServerStateStore["commitExactPayment"]>[0]) {
    return this.#inner.commitExactPayment(record);
  }

  loadOpenClaimAttempt(channelId: string) {
    return this.#inner.loadOpenClaimAttempt(channelId);
  }

  saveClaimAttempt(record: Parameters<ServerStateStore["saveClaimAttempt"]>[0]) {
    return this.#inner.saveClaimAttempt(record);
  }

  applyClaimAttempt(channel: Parameters<ServerStateStore["applyClaimAttempt"]>[0], attempt: Parameters<ServerStateStore["applyClaimAttempt"]>[1]) {
    return this.#inner.applyClaimAttempt(channel, attempt);
  }

  abandonClaimAttempt(attemptId: string, reason?: string) {
    return this.#inner.abandonClaimAttempt(attemptId, reason);
  }
}

async function healthResponse(config: GatewayConfig, state: GatewayStateClient): Promise<Response> {
  try {
    const rest = new KaspaRestClient(config.chainApiBase);
    const chain = await rest.health();
    return json(
      {
        ok: true,
        gateway: "kaspa-x402-testnet",
        chain,
        metrics: await state.metrics(),
      },
      { headers: corsHeaders(config) },
    );
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, { status: 503, headers: corsHeaders(config) });
  }
}

function gatewayUnsupportedPaymentResponse(
  request: Request,
  server: DirectModeServer,
  resource: ResourceInfo,
  profile: Profile,
  config: GatewayConfig,
): Response | undefined {
  const header = request.headers.get(PAYMENT_SIGNATURE_HEADER);
  if (!header) return undefined;
  const decoded = unsafeDecodePaymentHeader(header);
  const scheme = decoded?.accepted?.scheme;
  if (scheme === undefined || scheme === "exact" || scheme === "batch-settlement") return undefined;
  const response = server.paymentRequiredResponse({
    resource,
    amount: amountFor(config, profile),
    scheme: profile,
    error: toX402ErrorReason("unsupported_scheme"),
  });
  return serverResponse({ ...response, body: { error: toX402ErrorReason("unsupported_scheme") } }, config, false);
}

function unsafeDecodePaymentHeader(header: string): { accepted?: { scheme?: unknown } } | undefined {
  try {
    return decodePaymentSignatureHeader(header) as { accepted?: { scheme?: unknown } };
  } catch {
    try {
      return JSON.parse(atob(header)) as { accepted?: { scheme?: unknown } };
    } catch {
      return undefined;
    }
  }
}

function serverResponse(response: { status: number; headers: Record<string, string>; body?: unknown }, config: GatewayConfig, head: boolean): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(config))) headers.set(key, value);
  if (!headers.has("content-type") && response.body !== undefined) headers.set("content-type", "application/json; charset=utf-8");
  const body = head ? null : responseBody(response);
  return new Response(body, { status: response.status, headers });
}

function responseBody(response: { status: number; body?: unknown }): BodyInit | null {
  if (response.body === undefined) {
    if (response.status === 402) return JSON.stringify({ ok: false, error: "payment_required" });
    if (response.status >= 400) return JSON.stringify({ ok: false, error: "gateway_error" });
    return null;
  }
  return typeof response.body === "string" ? response.body : JSON.stringify(response.body);
}

function withCors(response: Response, config: GatewayConfig): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(config))) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function corsHeaders(config: GatewayConfig | undefined): Record<string, string> {
  return {
    "access-control-allow-origin": config?.corsOrigin ?? "https://kaspa-x402.org",
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": `${PAYMENT_SIGNATURE_HEADER}, content-type`,
    "access-control-expose-headers": `${PAYMENT_REQUIRED_HEADER}, ${PAYMENT_RESPONSE_HEADER}`,
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function routeProfile(pathname: string): Profile | undefined {
  if (pathname === "/exact" || pathname === "/exact/report") return "exact";
  if (pathname === "/batch" || pathname === "/batch/report") return "batch-settlement";
  return undefined;
}

function resourceFor(url: URL, profile: Profile): ResourceInfo {
  return {
    url: url.toString(),
    description: profile === "exact" ? "Kaspa x402 exact testnet resource" : "Kaspa x402 batch-settlement testnet resource",
    mimeType: "application/json",
  };
}

function amountFor(config: GatewayConfig, profile: Profile): string {
  return profile === "exact" ? config.exactAmount : config.batchAmount;
}

function profileMetric(profile: Profile): string {
  return profile === "exact" ? "exact" : "batch";
}

function rateScope(request: Request, profile: Profile): string {
  const ip = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  return `${ip}:${profile}`;
}

function indexBody(url: URL): unknown {
  return {
    ok: true,
    service: "kaspa-x402-testnet-gateway",
    endpoints: {
      health: new URL("/health", url).toString(),
      supported: new URL("/supported", url).toString(),
      exact: new URL("/exact/report", url).toString(),
      batch: new URL("/batch/report", url).toString(),
    },
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof KaspaX402Error) return toX402ErrorReason(error.code);
  return error instanceof Error ? error.message : String(error);
}
