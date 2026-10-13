import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { schnorr } from "@noble/curves/secp256k1.js";
import { generateHashChainBorrowGrants, hashChainHeadScriptPublicKey } from "@kaspa-x402/covenant";
import { addressForScriptPublicKey } from "../site/dist/assets/hash-chain-client.js";

// Workers do not expose a pre-delivery WebSocket message limit. The hosted
// chain routes must reject work before opening an unbounded PNN connection.
const require = createRequire(createRequire(import.meta.url).resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = await import(require.resolve("miniflare"));
const folder = mkdtempSync(path.join(tmpdir(), "kaspa-x402-hash-worker-"));
const base = "https://demo.kaspa-x402.org";
const admin = "local-worker-test-admin-token-32-characters";
const owner = Buffer.from(schnorr.getPublicKey(Buffer.alloc(32, 8))).toString("hex");
const payer = Buffer.from(schnorr.getPublicKey(Buffer.alloc(32, 7))).toString("hex");
const payerScript = `000020${payer}ac`;
const grants = generateHashChainBorrowGrants(4);
const head = { outpoint: { txid: "11".repeat(32), index: 0 }, amount: "100000000",
  guard: grants.initialGuard,
  scriptPublicKey: hashChainHeadScriptPublicKey({ ownerPublicKey: owner, guard: grants.initialGuard }),
  covenantId: "de".repeat(32) };
let outboundReads = 0;
const options = {
  name: "kaspa-x402-hash-chain-worker-check",
  modules: true, scriptPath: path.resolve("packages/demo-gateway/dist/index.js"),
  compatibilityDate: "2026-06-02", compatibilityFlags: ["nodejs_compat"],
  durableObjects: { GATEWAY_STATE: { className: "GatewayState", useSQLite: true,
    unsafeUniqueKey: "kaspa-x402-hash-chain-worker-check" } },
  durableObjectsPersist: folder,
  resourcePersistencePath: folder,
  bindings: {
    KASPA_X402_GATEWAY_ENABLED: "true", KASPA_X402_HASH_CHAIN_ENABLED: "true",
    KASPA_X402_ADMISSION_HMAC_KEY: "test-admission-key-with-at-least-32-bytes",
    KASPA_X402_ADMIN_TOKEN: admin,
    KASPA_X402_PAY_TO: addressForScriptPublicKey(payerScript, "kaspa:testnet-10"),
    KASPA_X402_SERVER_PUBLIC_KEY: owner, KASPA_X402_GATEWAY_BASE_URL: base,
    KASPA_X402_HOSTED_EXACT_SETTLEMENT_ENABLED: "true",
    KASPA_X402_CHAIN_BROADCAST_MODE: "pnn", KASPA_X402_PNN_ENDPOINTS: "wss://chain.demo.invalid/wrpc/json",
  },
  outboundService: async () => { outboundReads += 1; throw new Error("unbounded Worker PNN dial"); },
};
const worker = new Miniflare(convertV4MiniflareOptions
  ? convertV4MiniflareOptions(options) : options);
try {
  const status = await worker.dispatchFetch(`${base}/hash-chain/status`);
  assert.equal(status.status, 200);
  const registration = { headId: "aa".repeat(32), ownerPublicKey: owner,
    network: "kaspa:testnet-10", head, grants: grants.grants };
  const register = (token) => worker.dispatchFetch(`${base}/admin/hash-chain/register`, {
    method: "POST", headers: { authorization: `Bearer ${token}`,
      "content-type": "application/json" }, body: JSON.stringify(registration),
  });
  assert.equal((await register("wrong")).status, 401);
  const rejected = await register(admin);
  assert.equal(rejected.status, 409, await rejected.clone().text());
  assert.equal((await rejected.json()).error, "hash_chain_registration_rejected");
  assert.equal(outboundReads, 0, "Worker dialed PNN without a pre-delivery limit");
  console.log(JSON.stringify({ ok: true, runtime: "Cloudflare Worker with SQLite Durable Object",
    pnnTransport: "fail-closed", registrationStatus: rejected.status, outboundReads }, null, 2));
} finally {
  await worker.dispose();
  rmSync(folder, { recursive: true, force: true });
}
