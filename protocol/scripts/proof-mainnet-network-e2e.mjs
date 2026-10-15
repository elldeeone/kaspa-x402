#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { WebSocketServer } from "ws";
import { KaspaPnnClient, NativeAddressCodec, ScriptAddressBook, PnnChainEvidence, selectPnnChainEvidenceClient,
  VerifiedKaspaChainProvider, VerifiedExactTransactionVerifier, VerifiedExactSettlementReconciler, PnnBroadcastChainProvider } from "@kaspa-x402/adapters";
import { createNodeBoundedPnnWebSocket } from "@kaspa-x402/adapters/pnn-node";
import { addressForScriptPublicKey } from "@kaspa-x402/adapters/native";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
assert.equal(args[0], "--out"); assert.equal(args.length, 2);
const output = path.resolve(args[1]); fs.mkdirSync(path.dirname(output), { recursive: true });
const records = [], peers = [];
async function check(name, work) {
  try { records.push({ name, passed: true, evidence: await work() }); }
  catch (error) { records.push({ name, passed: false, error: error.message }); }
}
async function authority(networkId) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); peers.push(server);
  await new Promise(resolve => server.once("listening", resolve));
  const state = { networkId, utxos: [], reads: [], unavailable: false };
  server.on("connection", remote => remote.on("message", bytes => {
    const r = JSON.parse(String(bytes)); state.reads.push(r);
    if (state.unavailable) { remote.close(); return; }
    const params = r.method === "getServerInfo" ? { networkId: state.networkId, isSynced: true, virtualDaaScore: "1000" }
      : r.method === "getBlockDagInfo" ? { virtualDaaScore: "1000", sink: "ab".repeat(32) }
      : r.method === "getUtxosByAddresses" ? { entries: state.utxos }
      : r.method === "getBlock" ? { block: { header: { hash: "ab".repeat(32), blueScore: "1000", daaScore: "1000" }, verboseData: { isChainBlock: true } } }
      : {};
    remote.send(JSON.stringify({ id: r.id, params }));
  }));
  const endpoint = `ws://127.0.0.1:${server.address().port}`;
  return { state, endpoint, client: options => new KaspaPnnClient({ endpoints: [endpoint], allowInsecureLoopback: true,
    boundedWebSocketFactory: createNodeBoundedPnnWebSocket, attempts: 1, timeoutMs: 1000, ...options }) };
}
try {
  const a = await authority("mainnet"), b = await authority("mainnet"), t = await authority("testnet-10");
  const main = () => a.client({ network: "kaspa:mainnet", allowMainnet: true });
  await check("default PNN rejects mainnet node", async () => { await assert.rejects(a.client({}).health(), /network/); });
  await check("explicit mainnet PNN checks and reports node identity", async () => {
    assert.equal((await main().health()).networkId, "mainnet");
  });
  await check("mainnet PNN needs explicit opt-in", async () => {
    assert.throws(() => a.client({ network: "kaspa:mainnet" }), /allowMainnet/);
  });
  await check("mainnet PNN rejects Testnet authority", async () => {
    await assert.rejects(t.client({ network: "kaspa:mainnet", allowMainnet: true }).health(), /network/);
  });
  await check("native codec mainnet opt-in and address network binding", async () => {
    const script = "000020" + "11".repeat(32) + "ac";
    const address = addressForScriptPublicKey(script, "kaspa:mainnet");
    assert.equal(new NativeAddressCodec(new ScriptAddressBook(), { allowMainnet: true }).scriptPublicKeyForAddress(address, "kaspa:mainnet"), script);
    assert.throws(() => new NativeAddressCodec(new ScriptAddressBook()).scriptPublicKeyForAddress(address, "kaspa:mainnet"), /allowMainnet/);
    assert.throws(() => new NativeAddressCodec(new ScriptAddressBook(), { allowMainnet: true }).scriptPublicKeyForAddress(address, "kaspa:testnet-10"));
  });
  await check("mainnet evidence refuses single authority policy", async () => {
    assert.throws(() => selectPnnChainEvidenceClient({ mode: "trusted-single-source", verification: main() }), /independent/);
  });
  const policy = () => ({ mode: "independent-corroboration", submission: main(), requiredAuthorities: 2,
    authorities: [{ trustDomain: "operator_a", client: main() }, { trustDomain: "operator_b", client: b.client({ network: "kaspa:mainnet", allowMainnet: true }) }] });
  await check("independent mainnet authorities preserve selected network", async () => {
    const client = selectPnnChainEvidenceClient(policy());
    assert.equal(client.network, "kaspa:mainnet"); assert.equal((await client.health()).networkId, "mainnet");
  });
  await check("mixed-network policy rejected before chain I/O", async () => {
    const p = policy(); p.authorities[1].client = t.client({});
    assert.throws(() => selectPnnChainEvidenceClient(p), /network/);
  });
  await check("Testnet defaults still work", async () => { assert.equal((await t.client({}).health()).networkId, "testnet-10"); });
  await check("lineage request for another network fails before RPC", async () => {
    const count = a.state.reads.length;
    await assert.rejects(main().discoverCovenantLineage({ network: "kaspa:testnet-10" }), /network/);
    assert.equal(a.state.reads.length, count);
  });
  await check("mainnet address read and wrong-prefix rejection", async () => {
    const pnn = selectPnnChainEvidenceClient(policy());
    const store = { loadPnnEvidence: async () => undefined, savePnnEvidence: async () => {},
      recordPnnCheckpoint: async () => {}, findPnnCheckpointBefore: async () => undefined };
    const evidence = new PnnChainEvidence(pnn, new ScriptAddressBook(), store);
    const script = "000020" + "11".repeat(32) + "ac";
    assert.deepEqual(await evidence.getUtxosForAddress(addressForScriptPublicKey(script, "kaspa:mainnet")), []);
    await assert.rejects(evidence.getUtxosForAddress(addressForScriptPublicKey(script, "kaspa:testnet-10")), /prefix/);
    assert.equal(Reflect.set(pnn, "network", "kaspa:testnet-10"), false);
    assert.equal(pnn.network, "kaspa:mainnet");
  });
  await check("independent sources disagree on UTXOs and fail closed", async () => {
    b.state.utxos = [{ outpoint: { transactionId: "11".repeat(32), index: 0 },
      utxoEntry: { amount: "1000", scriptPublicKey: { version: 0, script: "20" + "11".repeat(32) + "ac" }, blockDaaScore: "100", isCoinbase: false } }];
    try { await assert.rejects(selectPnnChainEvidenceClient(policy()).snapshotHashChainUtxos([]), /conflicts/); }
    finally { b.state.utxos = []; }
  });
  await check("unavailable required authority fails closed", async () => {
    b.state.unavailable = true;
    try { await assert.rejects(selectPnnChainEvidenceClient(policy()).health(), /unavailable/); }
    finally { b.state.unavailable = false; }
  });
  await check("mainnet recovery rejects legacy Testnet receipt before RPC", async () => {
    const count = a.state.reads.length + b.state.reads.length;
    const store = { loadPnnEvidence: async id => ({ transactionId: id, checkpoint: { blockHash: "ab".repeat(32), blueScore: "1000" } }),
      savePnnEvidence: async () => {}, recordPnnCheckpoint: async () => {}, findPnnCheckpointBefore: async () => undefined };
    const evidence = new PnnChainEvidence(selectPnnChainEvidenceClient(policy()), new ScriptAddressBook(), store);
    await assert.rejects(evidence.getTransaction("cd".repeat(32)), /network/);
    assert.equal(a.state.reads.length + b.state.reads.length, count);
  });
  await check("untagged legacy evidence cannot be relabeled mainnet", async () => {
    assert.throws(() => new VerifiedExactTransactionVerifier({}, { network: "kaspa:mainnet", allowMainnet: true }), /network/);
  });
  await check("mainnet reads cannot use a Testnet broadcaster", async () => {
    const book = new ScriptAddressBook(), pnn = selectPnnChainEvidenceClient(policy());
    const store = { loadPnnEvidence: async () => undefined, savePnnEvidence: async () => {}, recordPnnCheckpoint: async () => {}, findPnnCheckpointBefore: async () => undefined };
    const reads = new VerifiedKaspaChainProvider(new PnnChainEvidence(pnn, book, store), book, "0", { network: "kaspa:mainnet", allowMainnet: true });
    const testnet = selectPnnChainEvidenceClient({ mode: "trusted-single-source", verification: t.client({}) });
    assert.throws(() => new PnnBroadcastChainProvider(reads, book, testnet, 30), /network/);
    new PnnBroadcastChainProvider(reads, book, pnn, 30);
  });
  await check("mainnet settlement recovery rejects Testnet and legacy attempts before reads", async () => {
    const book = new ScriptAddressBook();
    const store = { loadPnnEvidence: async () => undefined, savePnnEvidence: async () => {}, recordPnnCheckpoint: async () => {}, findPnnCheckpointBefore: async () => undefined };
    const evidence = new PnnChainEvidence(selectPnnChainEvidenceClient(policy()), book, store);
    const reconciler = new VerifiedExactSettlementReconciler(evidence, { network: "kaspa:mainnet", allowMainnet: true });
    const before = a.state.reads.length + b.state.reads.length;
    await assert.rejects(reconciler.reconcileExactSettlement({ network: "kaspa:testnet-10", transactionId: "aa".repeat(32) }), /network/);
    await assert.rejects(reconciler.reconcileExactSettlement({ transactionId: "aa".repeat(32) }), /network/);
    assert.equal(a.state.reads.length + b.state.reads.length, before);
  });
  await check("read-only mainnet authority CLI checks deployment network and quorum", async () => {
    const configFile = path.join(path.dirname(output), "preflight-fixture.json");
    fs.writeFileSync(configFile, JSON.stringify({ network: "kaspa:mainnet", allowMainnet: true,
      allowInsecureLoopback: true, requiredAuthorities: 2, submissionEndpoints: [a.endpoint],
      authorities: [{ trustDomain: "operator_a", endpoints: [a.endpoint] }, { trustDomain: "operator_b", endpoints: [b.endpoint] }] }));
    try {
      const r = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(root, "scripts/check-chain-authorities.mjs"), "--config", configFile]);
        let stdout = "", stderr = "";
        const timer = setTimeout(() => { child.kill(); reject(Error("preflight timeout")); }, 10000);
        child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
        child.on("error", e => { clearTimeout(timer); reject(e); });
        child.on("exit", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      });
      assert.equal(r.code, 0, r.stderr);
      const receipt = JSON.parse(r.stdout); assert.equal(receipt.ok, true); assert.equal(receipt.network, "kaspa:mainnet");
      assert.equal(receipt.requiredAuthorities, 2); return { network: receipt.network, noBroadcast: true };
    } finally { fs.rmSync(configFile, { force: true }); }
  });
  await check("mainnet SDK exact and batch payment, replay and recovery flows", async () => {
    // Fixtures import workspace packages; keep resolution anchored in the SDK
    // even when the retained report is written outside the checkout.
    const fixtures = path.join(root, ".kaspa-x402-live", "mainnet-network");
    fs.mkdirSync(fixtures, { recursive: true });
    const fixture = fs.mkdtempSync(path.join(fixtures, "sdk-profiles-"));
    try {
      const mock = fs.readFileSync(path.join(root, "examples/lib/mock-direct-mode.mjs"), "utf8")
        .replaceAll('"kaspa:testnet-10"', '"kaspa:mainnet"').replaceAll('"kaspatest:', '"kaspa:')
        .replaceAll("new DirectModeServer({", "new DirectModeServer({ allowMainnet: true,")
        .replaceAll("new DirectModeClient({", "new DirectModeClient({ allowMainnet: true,")
        .replaceAll("new DirectModeFacilitator({", "new DirectModeFacilitator({ allowMainnet: true,");
      fs.writeFileSync(path.join(fixture, "mock.mjs"), mock);
      for (const name of ["proof-offline.mjs", "proof-exact-authorization-e2e.mjs"]) {
        let text = fs.readFileSync(path.join(root, "scripts", name), "utf8")
          .replaceAll('"../examples/lib/mock-direct-mode.mjs"', '"./mock.mjs"')
          .replaceAll("new DirectModeServer({", "new DirectModeServer({ allowMainnet: true,")
          .replaceAll("new DirectModeClient({", "new DirectModeClient({ allowMainnet: true,")
          .replaceAll('"./live-adapter-reference.mjs"', JSON.stringify(path.join(root, "scripts/live-adapter-reference.mjs")))
          .replaceAll('"../packages/covenant/dist/index.js"', '"@kaspa-x402/covenant"');
        if (name === "proof-offline.mjs") text = text.replace('const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");', `const root = ${JSON.stringify(root)};`);
        fs.writeFileSync(path.join(fixture, name), text);
      }
      const result = spawnSync(process.execPath, [path.join(fixture, "proof-offline.mjs"), "--out", path.join(fixture, "report.json"), "--quiet"], { encoding: "utf8", timeout: 60000 });
      assert.equal(result.status, 0, result.stderr);
      const r = JSON.parse(fs.readFileSync(path.join(fixture, "report.json")));
      assert.equal(r.network, "kaspa:mainnet"); assert.equal(r.summary.ok, true);
      return { network: r.network, checks: r.checks, chainFacts: "synthetic" };
    } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
  });
} finally {
  await Promise.all(peers.map(peer => new Promise(resolve => peer.close(resolve))));
  const files = ["packages/adapters/src/adapters.ts", "packages/adapters/src/pnn-trust-policy.ts", "packages/adapters/src/pnn-chain-evidence.ts",
    "packages/core/src/batch-commitment.ts", "packages/core/src/batch-authorization.ts", "packages/core/src/generated/schema-validators.js",
    "packages/client/src/direct-client.ts", "packages/client/src/hash-chain-signer.ts", "packages/server/src/direct-server.ts",
    "packages/server/src/exact-heads.ts", "packages/server/src/hash-chain-issuer.ts", "packages/server/src/hash-chain-verifier.ts",
    "scripts/check-chain-authorities.mjs", "scripts/sdk-network-consumer.mjs", "scripts/proof-mainnet-network-e2e.mjs"];
  const report = { schema: "kaspa-x402-mainnet-network-e2e/v1", evidenceBoundary: "Offline SDK APIs and real loopback transport; synthetic chain facts, no funded transactions or independent operator proof.",
    cases: records, passed: records.filter(c => c.passed).length, failed: records.filter(c => !c.passed).length,
    sourceSha256: Object.fromEntries(files.map(f => [f, crypto.createHash("sha256").update(fs.readFileSync(path.join(root, f))).digest("hex")])) };
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n"); console.log(JSON.stringify({ report: output, passed: report.passed, failed: report.failed }));
  if (report.failed) process.exitCode = 1;
}
