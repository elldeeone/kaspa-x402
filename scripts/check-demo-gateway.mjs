import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unstable_readConfig } from "wrangler";

import {
  decodePaymentRequiredHeader,
  ESCROW_BINDING_ID,
  ESCROW_TEMPLATE_ID,
} from "../protocol/packages/core/dist/index.js";
import { readBoundedResponseText } from "../protocol/scripts/read-bounded-response.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(createRequire(import.meta.url).resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions, WebSocketPair, Response: WorkerResponse } =
  await import(require.resolve("miniflare"));
const folder = mkdtempSync(path.join(tmpdir(), "kaspa-x402-gateway-smoke-"));
const wranglerVars = unstable_readConfig({
  config: path.join(root, "packages/demo-gateway/wrangler.jsonc"),
}).vars;
const base = String(wranglerVars.KASPA_X402_GATEWAY_BASE_URL);
const blockHash = "ab".repeat(32);
const MAX_RESPONSE_BYTES = 256 * 1024;
let pnnReads = 0;
const options = {
  name: "kaspa-x402-demo-gateway-smoke",
  modules: true,
  scriptPath: path.join(root, "packages/demo-gateway/dist/index.js"),
  compatibilityDate: "2026-06-02",
  compatibilityFlags: ["nodejs_compat"],
  durableObjects: { GATEWAY_STATE: { className: "GatewayState", useSQLite: true,
    unsafeUniqueKey: "kaspa-x402-demo-gateway-smoke" } },
  durableObjectsPersist: folder,
  resourcePersistencePath: folder,
  bindings: {
    ...wranglerVars,
    KASPA_X402_GATEWAY_ENABLED: "true",
    KASPA_X402_PNN_ENDPOINTS: "wss://pnn.demo.invalid/wrpc/json",
    KASPA_X402_ADMISSION_HMAC_KEY: "local-worker-admission-test-secret".repeat(2),
  },
  outboundService: async (request) => {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      throw new Error(`unexpected outbound gateway smoke request: ${request.url}`);
    pnnReads += 1;
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.addEventListener("message", (event) => {
      const { id, method } = JSON.parse(event.data);
      try { server.send(JSON.stringify({ id, params: pnnResult(method) })); }
      catch (error) { server.send(JSON.stringify({ id, error: String(error) })); }
    });
    return new WorkerResponse(null, { status: 101, webSocket: client });
  },
};
const worker = new Miniflare(convertV4MiniflareOptions
  ? convertV4MiniflareOptions(options) : options);

try {
  const missing = await getJson(`${base}/batch`);
  assert(missing.status === 503 && missing.body.error === "quote_unavailable",
    "missing cached DAA did not fail closed");
  const bindings = await worker.getBindings();
  const namespace = bindings.GATEWAY_STATE;
  const state = namespace.get(namespace.idFromName("demo-gateway-state-v2"));
  const seeded = await state.fetch("https://gateway-state/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "recordPnnCheckpoint", payload: {
      checkpoint: { blockHash, blueScore: "1000", daaScore: "1000" },
    } }),
  });
  assert(seeded.status === 200 && (await seeded.json()).ok === true,
    "could not seed a deterministic PNN checkpoint");
  const result = await smokeGateway(base);
  console.log(JSON.stringify({
    ok: true,
    runtime: "isolated local Worker with SQLite Durable Object",
    chain: "simulated PNN",
    ...result,
  }, null, 2));
} finally {
  await worker.dispose();
  rmSync(folder, { recursive: true, force: true });
}

async function smokeGateway(baseUrl) {
  const health = await getJson(`${baseUrl}/health`);
  const supported = await getJson(`${baseUrl}/supported`);
  const exact = await getJson(`${baseUrl}/exact`);
  const batch = await getJson(`${baseUrl}/batch`);
  const exactRequired = exact.status === 402
    ? decodePaymentRequiredHeader(exact.headers.get("PAYMENT-REQUIRED")) : undefined;
  const batchRequired = batch.status === 402
    ? decodePaymentRequiredHeader(batch.headers.get("PAYMENT-REQUIRED")) : undefined;
  const unsupportedHeader = btoa(
    JSON.stringify({
      x402Version: 2,
      accepted: { scheme: "evm", network: "eip155:1" },
      payload: {},
    }),
  );
  const head = await smokeFetch(`${baseUrl}/batch`, { method: "HEAD" });
  const unsignedPnnReads = pnnReads;
  assert(unsignedPnnReads === 0, "unsigned quotes performed a PNN read");
  const unsupported = await getJson(`${baseUrl}/batch`, {
    headers: { "PAYMENT-SIGNATURE": unsupportedHeader },
  });
  const correctiveRequired = unsupported.status === 402
    ? decodePaymentRequiredHeader(unsupported.headers.get("PAYMENT-REQUIRED")) : undefined;

  assert(
    health.status === 200 && health.body.ok === true,
    "health endpoint failed",
  );
  assert(health.body.enabled === true, "health did not report enabled gateway");
  assert(
    health.body.releaseVersion === "1.0.0-rc.2",
    `unexpected release ${health.body.releaseVersion}`,
  );
  assert(exact.status === 402, `exact quote failed with ${exact.status}`);
  assert(exactRequired?.resource?.url === `${baseUrl}/exact`, "exact resource changed");
  assert(exactRequired?.accepts[0]?.scheme === "exact" &&
    exactRequired.accepts[0].amount === "20000000" &&
    exactRequired.accepts[0].maxTimeoutSeconds === 300 &&
    exactRequired.accepts[0].extra?.binding === "kaspa-exact-v2" &&
    exactRequired.accepts[0].extra?.profile === "standard-native",
    "exact offer terms changed");
  assert(batch.status === 402, `batch quote failed with ${batch.status}`);
  assert(batchRequired?.resource?.url === `${baseUrl}/batch`, "batch resource changed");
  assert(batchRequired?.accepts[0]?.scheme === "batch-settlement" &&
    batchRequired.accepts[0].amount === "500" &&
    batchRequired.accepts[0].maxTimeoutSeconds === 300 &&
    batchRequired.accepts[0].extra?.binding === ESCROW_BINDING_ID &&
    batchRequired.accepts[0].extra?.templateId === ESCROW_TEMPLATE_ID &&
    batchRequired.accepts[0].extra?.claimReserveSompi === "10000000" &&
    batchRequired.accepts[0].extra?.minDepositSompi === "20000000" &&
    batchRequired.accepts[0].extra?.refundTimeoutDaa === "37000",
    "batch offer terms changed");
  assert(unsupported.status === 402 && unsupported.body.error === "unsupported_scheme",
    "unsupported signed request did not receive a corrective offer");
  assert(correctiveRequired?.error === "unsupported_scheme" &&
    correctiveRequired.accepts[0]?.scheme === "batch-settlement" &&
    correctiveRequired.accepts[0]?.extra?.binding === ESCROW_BINDING_ID,
    "unsupported payment correction did not contain batch offer terms");
  assert(head.status === 402, `expected HEAD 402, got ${head.status}`);
  assert(head.headers.has("PAYMENT-REQUIRED") && (await head.text()) === "",
    "HEAD omitted payment terms or returned a body");
  assert(
    supported.body.enabled === true,
    "supported endpoint did not report enabled gateway",
  );
  assert(
    Array.isArray(supported.body.kinds) && supported.body.kinds.length === 2,
    "supported kinds changed",
  );
  const supportedBatch = supported.body.kinds.find(
    (kind) => kind.scheme === "batch-settlement",
  );
  assert(
    supportedBatch?.extra?.binding === ESCROW_BINDING_ID &&
      supportedBatch?.extra?.templateId === ESCROW_TEMPLATE_ID,
    "supported endpoint did not expose the v1 RC2 KIP-20 batch kind",
  );

  return {
    url: baseUrl,
    health: {
      releaseVersion: health.body.releaseVersion,
      chainBroadcastMode: health.body.chainBroadcastMode,
    },
    supported: supported.body.kinds.map(
      (kind) => `${kind.scheme}:${kind.network}`,
    ),
    exact: {
      status: exact.status,
      profile: exactRequired.accepts[0].extra.profile,
      amount: exactRequired.accepts[0].amount,
      binding: exactRequired.accepts[0].extra.binding,
    },
    batch: {
      status: batch.status,
      amount: batchRequired.accepts[0].amount,
      binding: batchRequired.accepts[0].extra.binding,
      templateId: batchRequired.accepts[0].extra.templateId,
      claimReserveSompi: batchRequired.accepts[0].extra.claimReserveSompi,
      refundTimeoutDaa: batchRequired.accepts[0].extra.refundTimeoutDaa,
    },
    unsupported: unsupported.body.error,
    headStatus: head.status,
    pnnReadsAfterUnsignedQuotes: unsignedPnnReads,
  };
}

async function getJson(url, init) {
  const response = await smokeFetch(url, init);
  return {
    status: response.status,
    headers: response.headers,
    body: JSON.parse(
      await readBoundedResponseText(response, {
        maxBytes: MAX_RESPONSE_BYTES,
        tooLargeMessage: "gateway smoke response exceeded the size limit",
      }),
    ),
  };
}

async function smokeFetch(url, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("cf-connecting-ip", "203.0.113.10");
  return worker.dispatchFetch(url, {
    ...init,
    headers,
  });
}

function pnnResult(method) {
  if (method === "getServerInfo")
    return { networkId: "testnet-10", isSynced: true };
  if (method === "getBlockDagInfo")
    return { sink: blockHash };
  if (method === "getBlock")
    return { block: { header: { hash: blockHash, blueScore: "1000", daaScore: "1000" },
      verboseData: { hash: blockHash, isChainBlock: true,
        selectedParentHash: "cd".repeat(32) } } };
  if (method === "getUtxosByAddresses")
    return { entries: [] };
  throw new Error(`unexpected simulated PNN method: ${method}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
