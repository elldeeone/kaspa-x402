import {
  decodePaymentRequiredHeader,
  decodePaymentSignatureHeader,
  KaspaX402Error,
  KASPA_LOCK_TIME_THRESHOLD,
  toX402ErrorReason,
  X402_VERSION,
  type ResourceInfo,
  type SupportedKind,
} from "@kaspa-x402/core";
import {
  DirectModeServer,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  type ExactBorrowReservationProvider,
  type ExactBorrowReservationRequest,
  type ServerStateStore,
} from "@kaspa-x402/server";
import {
  KaspaPnnClient,
  KaspaRestClient,
  NativeAddressCodec,
  NativeVoucherVerifier,
  PnnBroadcastChainProvider,
  RestExactTransactionVerifier,
  RestKaspaChainProvider,
  ScriptAddressBook,
} from "./adapters.js";
import { readGatewayConfig, type GatewayConfig, type GatewayEnv } from "./config.js";
import { RemoteGatewayState } from "./remote-state.js";
import {
  DurableGatewayLockManager,
  type GatewayCanaryCheck,
  type GatewayCanaryReport,
  type GatewayExactInventoryRegistration,
  type GatewayStateClient,
} from "./state.js";

type Profile = "exact" | "batch-settlement";
type CanaryTrigger = GatewayCanaryReport["trigger"];
type WaitUntilContext = Pick<ExecutionContext, "waitUntil">;
const MAX_CANARY_DOC_BYTES = 64 * 1024;
const MAX_CANARY_JSON_BYTES = 64 * 1024;
const MAX_ADMIN_JSON_BYTES = 64 * 1024;

export async function handleGatewayRequest(request: Request, env: GatewayEnv, context: WaitUntilContext): Promise<Response> {
  let config: GatewayConfig;
  try {
    config = readGatewayConfig(env);
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, { status: 503, headers: corsHeaders(undefined) });
  }

  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(config) });

  const state = new RemoteGatewayState(env.GATEWAY_STATE);
  if (url.pathname.startsWith("/admin/exact-inventory")) {
    return exactInventoryAdminResponse(request, url, config, state);
  }
  if (url.pathname === "/" && request.method === "GET") return json(indexBody(url), { headers: corsHeaders(config) });
  if (url.pathname === "/health" && request.method === "GET") return healthResponse(config, state);
  if (url.pathname === "/metrics" && request.method === "GET") return json({ ok: true, metrics: await state.metrics() }, { headers: corsHeaders(config) });
  if (url.pathname === "/canary" && request.method === "GET") return canaryResponse(config, state);

  if (url.pathname === "/supported" && request.method === "GET") {
    const exactAvailable = await hostedExactAvailable(config, state);
    return json({ ok: true, enabled: config.enabled, kinds: gatewaySupportedKinds(config, exactAvailable) }, { headers: corsHeaders(config) });
  }

  const profile = routeProfile(url.pathname);
  if (!profile) return json({ ok: false, error: "not_found" }, { status: 404, headers: corsHeaders(config) });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ ok: false, error: "method_not_allowed" }, { status: 405, headers: corsHeaders(config) });
  }
  if (!config.enabled) {
    return json({ ok: false, error: "gateway_disabled" }, { status: 503, headers: corsHeaders(config) });
  }
  const rate = await state.checkRateLimit(rateScope(request, profile), Date.now(), config.rateLimitPerMinute, 60_000);
  if (!rate.allowed) {
    return json(
      { ok: false, error: "rate_limited", resetAt: new Date(rate.resetAt).toISOString() },
      { status: 429, headers: { ...corsHeaders(config), "retry-after": String(Math.max(1, Math.ceil((rate.resetAt - Date.now()) / 1000))) } },
    );
  }

  const exactAvailable = profile === "exact" ? await hostedExactAvailable(config, state) : false;
  if (profile === "exact" && !exactAvailable) {
    return json({ ok: false, error: "exact_unavailable" }, { status: 503, headers: corsHeaders(config) });
  }

  let gateway: { server: DirectModeServer };
  try {
    gateway = await createGateway(config, state, { exactAvailable });
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, { status: 503, headers: corsHeaders(config) });
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

export async function runGatewayCanary(env: GatewayEnv, trigger: CanaryTrigger = "scheduled"): Promise<GatewayCanaryReport> {
  const state = new RemoteGatewayState(env.GATEWAY_STATE);
  const checks: GatewayCanaryCheck[] = [];
  let config: GatewayConfig;
  try {
    config = readGatewayConfig(env);
  } catch (error) {
    checks.push(failedCheck("config", errorMessage(error)));
    const report = canaryReport(trigger, checks);
    await persistCanaryReport(state, report);
    return report;
  }

  checks.push(
    await checked("kaspa-rest", async () => {
      const chain = await new KaspaRestClient(config.chainApiBase).health();
      return { detail: "REST chain health returned testnet-10 evidence", evidence: chain };
    }),
  );
  checks.push(
    await checked("schema-url", async () => {
      const response = await fetchWithTimeout(`${config.siteBaseUrl}/schemas/payment-required.schema.json`);
      if (!response.ok) throw new Error(`schema returned ${response.status}`);
      const schema = await readJsonWithLimit<{ $id?: unknown }>(response, MAX_CANARY_JSON_BYTES, "payment-required schema");
      if (schema.$id !== "https://kaspa-x402.org/schemas/payment-required.schema.json") throw new Error("schema id mismatch");
      return { detail: "payment-required schema resolved", evidence: { status: response.status } };
    }),
  );
  checks.push(
    await checked("release-snapshot", async () => {
      const response = await fetchWithTimeout(`${config.siteBaseUrl}/v0.1.0-alpha.1/release.json?canary=${Date.now()}`);
      if (!response.ok) throw new Error(`release snapshot returned ${response.status}`);
      const release = await readJsonWithLimit<{ version?: unknown }>(response, MAX_CANARY_JSON_BYTES, "release snapshot");
      if (release.version !== "0.1.0-alpha.1") throw new Error("release snapshot version mismatch");
      return { detail: "immutable alpha.1 release snapshot resolved", evidence: { status: response.status } };
    }),
  );
  checks.push(
    await checked("docs-index", async () => {
      const response = await fetchWithTimeout(`${config.siteBaseUrl}/docs/`);
      if (!response.ok) throw new Error(`doc route returned ${response.status}`);
      const text = await readTextUntil(response, "<h1>Docs</h1>", MAX_CANARY_DOC_BYTES);
      if (!text.includes("<h1>Docs</h1>")) throw new Error("docs index content mismatch");
      return { detail: "public docs index resolved", evidence: { status: response.status } };
    }),
  );
  if (config.enabled) {
    const exactAvailable = await hostedExactAvailable(config, state);
    if (exactAvailable) {
      checks.push(await supportedKindCheck(env, config, "exact"));
    } else {
      checks.push(skippedCheck("exact-offer", exactUnavailableReason(config, await state.exactInventoryStats())));
    }
    checks.push(await offerCheck(env, config, "/batch", "batch-settlement"));
    checks.push(await unsupportedSchemeCheck(env, config));
  } else {
    checks.push(skippedCheck("exact-offer", "gateway disabled by operator"));
    checks.push(skippedCheck("batch-offer", "gateway disabled by operator"));
    checks.push(skippedCheck("unsupported-scheme-rejection", "gateway disabled by operator"));
  }
  checks.push({
    name: "paid-exact-canary",
    status: "skipped",
    detail: "scheduled checks do not hold spending keys; run the manual paid exact canary from an isolated funded testnet wallet",
  });
  checks.push({
    name: "replay-rejection-canary",
    status: "skipped",
    detail: "scheduled checks do not reuse paid evidence; run the manual replay canary after a funded exact or batch payment",
  });

  const report = canaryReport(trigger, checks);
  await persistCanaryReport(state, report);
  await state.incrementMetric(report.ok ? "canary_ok" : "canary_failed");
  return report;
}

async function hostedExactAvailable(config: GatewayConfig, state: GatewayStateClient): Promise<boolean> {
  if (!config.hostedExactSettlementEnabled) return false;
  if (config.exactProfile === "standard-native") return true;
  if (config.chainBroadcastMode !== "pnn") return false;
  const stats = await state.exactInventoryStats();
  return stats.available > 0;
}

function gatewaySupportedKinds(config: GatewayConfig, exactAvailable: boolean): SupportedKind[] {
  const kinds: SupportedKind[] = [];
  if (exactAvailable) {
    kinds.push({
      x402Version: X402_VERSION,
      scheme: "exact",
      network: config.network,
      extra: {
        asset: "KAS",
        binding: config.exactProfile === "standard-native" ? "kaspa-exact-v2" : "kaspa-exact-v1",
        ...(config.exactProfile === "standard-native"
          ? { profile: config.exactProfile }
          : { templateId: "kaspa-x402-kip10-additive-v1" }),
        transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
        modes: ["verify", "settle"],
      },
    });
  }
  kinds.push({
    x402Version: X402_VERSION,
    scheme: "batch-settlement",
    network: config.network,
    extra: {
      asset: "KAS",
      binding: "kaspa-escrow-v1",
      templateId: "kaspa-x402-escrow-v1",
      modes: ["verify", "settle"],
    },
  });
  return kinds;
}

async function createGateway(
  config: GatewayConfig,
  state: GatewayStateClient,
  options: { exactAvailable: boolean },
): Promise<{ server: DirectModeServer }> {
  const book = new ScriptAddressBook();
  const addressCodec = new NativeAddressCodec(book);
  const rest = new KaspaRestClient(config.chainApiBase);
  const currentDaa = BigInt(await rest.getVirtualDaaScore());
  if (currentDaa + BigInt(config.refundTimeoutDaaDelta) >= KASPA_LOCK_TIME_THRESHOLD) {
    throw new Error("computed refund DAA crosses the consensus timestamp boundary");
  }
  const refundTimeoutDaa = BigInt(
    await state.resolveBatchRefundTimeoutDaa(
      currentDaa.toString(),
      config.refundTimeoutDaaDelta,
      config.minimumRefundLeadDaa,
    ),
  );
  if (refundTimeoutDaa >= KASPA_LOCK_TIME_THRESHOLD) {
    throw new Error("computed refund DAA crosses the consensus timestamp boundary");
  }
  const restChainProvider = new RestKaspaChainProvider(rest, book, config.claimFeeSompi);
  const store = new AddressRecordingStore(state, book);
  const server = new DirectModeServer({
    network: config.network,
    payTo: config.payTo,
    serverPublicKey: config.serverPublicKey,
    minDepositSompi: config.minDepositSompi,
    amount: config.batchAmount,
    exactProfile: config.exactProfile,
    refundTimeoutDaa: refundTimeoutDaa.toString(),
    minimumRefundLeadDaa: config.minimumRefundLeadDaa,
    allowRollingRefundTimeoutDaa: true,
    maximumRefundHorizonDaa: config.refundTimeoutDaaDelta,
    maxTimeoutSeconds: config.maxTimeoutSeconds,
    store,
    chainProvider:
      config.chainBroadcastMode === "pnn"
        ? new PnnBroadcastChainProvider(
            restChainProvider,
            book,
            new KaspaPnnClient({
              endpoints: config.pnnEndpoints,
              timeoutMs: config.pnnTimeoutMs,
              attempts: config.pnnAttempts,
            }),
          )
        : restChainProvider,
    addressCodec,
    voucherVerifier: new NativeVoucherVerifier(),
    exactTransactionVerifier: new RestExactTransactionVerifier(rest),
    ...(options.exactAvailable && config.exactProfile === "additive"
      ? { exactReservationProvider: new GatewayExactReservationProvider(state) }
      : {}),
    lockManager: new DurableGatewayLockManager(state),
    acceptedFinality: "accepted",
    requirePaymentIdentifier: false,
  });
  return { server };
}

class GatewayExactReservationProvider implements ExactBorrowReservationProvider {
  readonly #state: GatewayStateClient;

  constructor(state: GatewayStateClient) {
    this.#state = state;
  }

  async reserveExactPayment(request: ExactBorrowReservationRequest) {
    const reservation = await this.#state.reserveExactInventory(request);
    if (!reservation) throw new KaspaX402Error("invalid_kaspa_x402_payload", "exact reservation inventory unavailable");
    return reservation;
  }
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

  registerExactHead(record: Parameters<ServerStateStore["registerExactHead"]>[0]) {
    return this.#inner.registerExactHead(record);
  }

  loadExactHead(headId: string) {
    return this.#inner.loadExactHead(headId);
  }

  listExactHeads() {
    return this.#inner.listExactHeads();
  }

  selectExactHead(request: Parameters<ServerStateStore["selectExactHead"]>[0]) {
    return this.#inner.selectExactHead(request);
  }

  claimExactSettlement(record: Parameters<ServerStateStore["claimExactSettlement"]>[0]) {
    return this.#inner.claimExactSettlement(record);
  }

  loadExactSettlementAttempt(transactionId: string) {
    return this.#inner.loadExactSettlementAttempt(transactionId);
  }

  recordExactSettlementBroadcast(
    transactionId: string,
    finality: Parameters<ServerStateStore["recordExactSettlementBroadcast"]>[1],
    observedAt: string,
  ) {
    return this.#inner.recordExactSettlementBroadcast(transactionId, finality, observedAt);
  }

  acceptExactSettlement(
    transactionId: string,
    finality: Parameters<ServerStateStore["acceptExactSettlement"]>[1],
    observedAt: string,
  ) {
    return this.#inner.acceptExactSettlement(transactionId, finality, observedAt);
  }

  beginExactHandler(transactionId: string, startedAt: string) {
    return this.#inner.beginExactHandler(transactionId, startedAt);
  }

  abandonExactSettlement(transactionId: string, reason: string, observedAt: string) {
    return this.#inner.abandonExactSettlement(transactionId, reason, observedAt);
  }

  markExactHeadUnavailable(headId: string, reason: string, observedAt: string) {
    return this.#inner.markExactHeadUnavailable(headId, reason, observedAt);
  }

  commitSettlement(record: Parameters<ServerStateStore["commitSettlement"]>[0]) {
    return this.#inner.commitSettlement(record);
  }

  commitExactPayment(record: Parameters<ServerStateStore["commitExactPayment"]>[0]) {
    return this.#inner.commitExactPayment(record);
  }

  saveExactReservation(record: Parameters<ServerStateStore["saveExactReservation"]>[0]) {
    return this.#inner.saveExactReservation(record);
  }

  loadExactReservation(reservationId: string) {
    return this.#inner.loadExactReservation(reservationId);
  }

  consumeExactReservation(
    reservationId: string,
    transactionId: string,
    continuation?: Parameters<ServerStateStore["consumeExactReservation"]>[2],
  ) {
    return this.#inner.consumeExactReservation(reservationId, transactionId, continuation);
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
        enabled: config.enabled,
        gateway: "kaspa-x402-testnet",
        hostedExactSettlementEnabled: config.hostedExactSettlementEnabled,
        exactProfile: config.exactProfile,
        chainBroadcastMode: config.chainBroadcastMode,
        pnnEndpoints: config.chainBroadcastMode === "pnn" ? config.pnnEndpoints : [],
        chain,
        metrics: await state.metrics(),
        exactInventory: await state.exactInventoryStats(),
        canary: await state.loadCanaryReport(),
      },
      { headers: corsHeaders(config) },
    );
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, { status: 503, headers: corsHeaders(config) });
  }
}

async function exactInventoryAdminResponse(request: Request, url: URL, config: GatewayConfig, state: GatewayStateClient): Promise<Response> {
  if (!config.adminToken) return json({ ok: false, error: "not_found" }, { status: 404, headers: corsHeaders(config) });
  if (request.headers.get("authorization") !== `Bearer ${config.adminToken}`) {
    return json({ ok: false, error: "unauthorized" }, { status: 401, headers: corsHeaders(config) });
  }
  if (url.pathname === "/admin/exact-inventory" && request.method === "GET") {
    return json(
      { ok: true, stats: await state.exactInventoryStats(), inventory: await state.listExactInventory() },
      { headers: corsHeaders(config) },
    );
  }
  if (url.pathname === "/admin/exact-inventory/register" && request.method === "POST") {
    try {
      const body = await readRequestJsonWithLimit<Record<string, unknown>>(request, MAX_ADMIN_JSON_BYTES, "exact inventory registration");
      const registered = await state.registerExactInventoryBatch(exactInventoryRegistrations(body));
      return json({ ok: true, registered, stats: await state.exactInventoryStats() }, { headers: corsHeaders(config) });
    } catch (error) {
      return json({ ok: false, error: errorMessage(error) }, { status: 400, headers: corsHeaders(config) });
    }
  }
  return json({ ok: false, error: "not_found" }, { status: 404, headers: corsHeaders(config) });
}

async function canaryResponse(config: GatewayConfig, state: GatewayStateClient): Promise<Response> {
  return json(
    {
      ok: true,
      enabled: config.enabled,
      exactInventory: await state.exactInventoryStats(),
      canary: await state.loadCanaryReport(),
    },
    { headers: corsHeaders(config) },
  );
}

async function offerCheck(env: GatewayEnv, config: GatewayConfig, path: string, profile: Profile): Promise<GatewayCanaryCheck> {
  return checked(`${profileMetric(profile)}-offer`, async () => {
    const response = await dispatchCanaryRequest(env, `${config.gatewayBaseUrl}${path}`);
    if (response.status !== 402) throw new Error(`expected 402, got ${response.status}`);
    const header = response.headers.get(PAYMENT_REQUIRED_HEADER);
    if (!header) throw new Error("missing payment-required header");
    const paymentRequired = decodePaymentRequiredHeader(header);
    const accepted = paymentRequired.accepts.find((entry) => entry.scheme === profile);
    if (!accepted) throw new Error(`${profile} offer not advertised`);
    if (accepted.network !== config.network) throw new Error(`unexpected network ${accepted.network}`);
    if (profile === "exact" && accepted.amount !== config.exactAmount) throw new Error("exact amount mismatch");
    if (profile === "batch-settlement" && accepted.extra.minDepositSompi !== config.minDepositSompi) throw new Error("batch deposit mismatch");
    return {
      detail: `${profile} unpaid request returned a valid offer`,
      evidence: { status: response.status, amount: accepted.amount, network: accepted.network },
    };
  });
}

async function supportedKindCheck(env: GatewayEnv, config: GatewayConfig, profile: Profile): Promise<GatewayCanaryCheck> {
  return checked(`${profileMetric(profile)}-offer`, async () => {
    const response = await dispatchCanaryRequest(env, `${config.gatewayBaseUrl}/supported`);
    if (response.status !== 200) throw new Error(`expected 200, got ${response.status}`);
    const body = (await response.json()) as { kinds?: Array<{ scheme?: unknown }> };
    if (!body.kinds?.some((kind) => kind.scheme === profile)) throw new Error(`${profile} support not advertised`);
    return {
      detail: `${profile} support is advertised without consuming reservation inventory`,
      evidence: { status: response.status, network: config.network },
    };
  });
}

async function unsupportedSchemeCheck(env: GatewayEnv, config: GatewayConfig): Promise<GatewayCanaryCheck> {
  return checked("unsupported-scheme-rejection", async () => {
    const header = btoa(JSON.stringify({ x402Version: 2, accepted: { scheme: "evm", network: "eip155:1" }, payload: {} }));
    const response = await dispatchCanaryRequest(env, `${config.gatewayBaseUrl}/batch`, { headers: { [PAYMENT_SIGNATURE_HEADER]: header } });
    if (response.status !== 402) throw new Error(`expected 402, got ${response.status}`);
    const body = (await response.json()) as { error?: unknown };
    if (body.error !== "unsupported_scheme") throw new Error(`unexpected error ${String(body.error)}`);
    return { detail: "foreign payment scheme returned unsupported_scheme", evidence: { status: response.status } };
  });
}

async function checked(
  name: string,
  fn: () => Promise<{ detail: string; evidence?: Record<string, unknown> }>,
): Promise<GatewayCanaryCheck> {
  try {
    const result = await fn();
    return { name, status: "ok", ...result };
  } catch (error) {
    return failedCheck(name, errorMessage(error));
  }
}

function failedCheck(name: string, detail: string): GatewayCanaryCheck {
  return { name, status: "failed", detail };
}

function skippedCheck(name: string, detail: string): GatewayCanaryCheck {
  return { name, status: "skipped", detail };
}

function exactUnavailableReason(config: GatewayConfig, stats: { available: number }): string {
  if (!config.hostedExactSettlementEnabled) return "hosted gateway exact verifier/broadcast path is not enabled";
  if (config.exactProfile === "standard-native") return "hosted gateway standard exact is unavailable";
  if (config.chainBroadcastMode !== "pnn") return "hosted gateway exact requires PNN broadcast mode";
  if (stats.available <= 0) return "hosted gateway exact inventory is empty";
  return "hosted gateway exact is unavailable";
}

function canaryReport(trigger: CanaryTrigger, checks: GatewayCanaryCheck[]): GatewayCanaryReport {
  return {
    checkedAt: new Date().toISOString(),
    trigger,
    ok: checks.every((check) => check.status !== "failed"),
    checks,
  };
}

async function persistCanaryReport(state: GatewayStateClient, report: GatewayCanaryReport): Promise<void> {
  try {
    await state.saveCanaryReport(report);
  } catch {
    // A failed state write must not hide the canary result from the caller.
  }
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    return await fetch(url, { signal: controller.signal, headers: { accept: "application/json, text/html;q=0.9, */*;q=0.8" } });
  } finally {
    clearTimeout(timeout);
  }
}

async function readTextUntil(response: Response, marker: string, maxBytes: number): Promise<string> {
  const length = response.headers.get("content-length");
  if (length && Number(length) > maxBytes) throw new Error("docs index response too large");
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return text + decoder.decode();
    bytes += chunk.value.byteLength;
    if (bytes > maxBytes) throw new Error("docs index response too large");
    text += decoder.decode(chunk.value, { stream: true });
    if (text.includes(marker)) {
      await reader.cancel().catch(() => undefined);
      return text;
    }
  }
}

async function readJsonWithLimit<T>(response: Response, maxBytes: number, label: string): Promise<T> {
  const length = response.headers.get("content-length");
  if (length && Number(length) > maxBytes) throw new Error(`${label} response too large`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${label} response body is missing`);
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      text += decoder.decode();
      break;
    }
    bytes += chunk.value.byteLength;
    if (bytes > maxBytes) throw new Error(`${label} response too large`);
    text += decoder.decode(chunk.value, { stream: true });
  }
  return JSON.parse(text) as T;
}

async function readRequestJsonWithLimit<T>(request: Request, maxBytes: number, label: string): Promise<T> {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error(`${label} request body too large`);
  return JSON.parse(text) as T;
}

function exactInventoryRegistrations(body: Record<string, unknown>): GatewayExactInventoryRegistration[] {
  const records = Array.isArray(body.records) ? body.records : body.record ? [body.record] : [body];
  if (records.length === 0) throw new Error("exact inventory registration is empty");
  return records.map((entry) => entry as GatewayExactInventoryRegistration);
}

async function dispatchCanaryRequest(env: GatewayEnv, url: string, init?: RequestInit): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const context: WaitUntilContext = {
    waitUntil(promise: Promise<unknown>) {
      pending.push(Promise.resolve(promise));
    },
  };
  const response = await handleGatewayRequest(new Request(url, init), env, context);
  await Promise.allSettled(pending);
  return response;
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
    "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
    "access-control-allow-headers": `${PAYMENT_SIGNATURE_HEADER}, authorization, content-type`,
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
      canary: new URL("/canary", url).toString(),
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
