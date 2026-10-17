// Controlled RPC authority over real bounded WebSockets. No consensus or live
// network claim: exercise the public client's handling of a moving checkpoint.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import { KaspaPnnClient } from "@kaspa-x402/adapters";
import { createNodeBoundedPnnWebSocket } from "@kaspa-x402/adapters/pnn-node";

const args = process.argv.slice(2);
assert.equal(args[0], "--out"); assert.equal(args.length, 2);
const out = path.resolve(args[1]); fs.mkdirSync(path.dirname(out), { recursive: true });
const cases = [];
for (const mode of ["moves-once", "always-moves", "wrong-hash", "missing-chain-flag", "changed-metadata", "aborted"]) {
  const peer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise(resolve => peer.once("listening", resolve));
  let generation = 0;
  const reads = [], blockReads = new Map(), abort = new AbortController();
  const hash = generation => generation.toString(16).padStart(2, "0").repeat(32);
  peer.on("connection", remote => remote.on("message", bytes => {
    const r = JSON.parse(String(bytes)); reads.push(r.method);
    let result;
    if (r.method === "getServerInfo") result = { networkId: "testnet-10", isSynced: true };
    else if (r.method === "getBlockDagInfo") { generation++; result = { sink: hash(generation) }; }
    else if (r.method === "getUtxosByAddresses") {
      result = { entries: [{ outpoint: { transactionId: hash(generation + 10), index: 0 },
        amount: String(generation * 100000000), scriptPublicKey: { version: 0, script: `20${"11".repeat(32)}ac` } }] };
      if (mode === "aborted") abort.abort(Error("cancelled snapshot"));
    } else if (r.method === "getBlock") {
      const count = (blockReads.get(r.params.hash) ?? 0) + 1; blockReads.set(r.params.hash, count);
      const recheck = count > 1;
      result = { block: { header: { hash: mode === "wrong-hash" && recheck ? "ff".repeat(32) : r.params.hash,
        blueScore: String(100 + generation + (mode === "changed-metadata" && recheck ? 1 : 0)), daaScore: String(100 + generation) },
        verboseData: { isChainBlock: !(recheck && (mode === "always-moves" || mode === "moves-once" && generation === 1)) } } };
      if (mode === "missing-chain-flag" && recheck) delete result.block.verboseData.isChainBlock;
    } else throw Error(`unexpected RPC ${r.method}`);
    if (remote.readyState === 1) remote.send(JSON.stringify({ id: r.id, params: result }));
  }));
  try {
    const client = new KaspaPnnClient({ endpoints: [`ws://127.0.0.1:${peer.address().port}`],
      allowInsecureLoopback: true, boundedWebSocketFactory: createNodeBoundedPnnWebSocket, timeoutMs: 1000 });
    if (mode === "moves-once") {
      const snapshot = await client.snapshotHashChainUtxos([], abort.signal);
      assert.equal(snapshot.checkpoint.blockHash, hash(2));
      assert.equal(snapshot.utxos.length, 1);
      assert.equal(snapshot.utxos[0].amount, "200000000", "discard origins from the invalidated checkpoint");
      assert.equal(generation, 2);
    } else {
      await assert.rejects(client.snapshotHashChainUtxos([], abort.signal), mode === "aborted" ? /cancelled snapshot/ : /checkpoint|selected-chain/);
      assert.equal(generation, mode === "always-moves" ? 3 : 1, "retry only explicit chain movement and keep it bounded");
    }
    cases.push({ name: mode, passed: true, snapshots: generation, rpcReads: reads.length });
  } catch (error) {
    cases.push({ name: mode, passed: false, snapshots: generation, error: error.message });
  } finally {
    for (const remote of peer.clients) remote.terminate();
    await new Promise(resolve => peer.close(resolve));
  }
}
const report = { kind: "pnn-snapshot-e2e", scope: "controlled-RPC-real-bounded-transport", ok: cases.every(c => c.passed), cases };
fs.writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ ok: report.ok, cases: cases.length, report: out }));
if (!report.ok) process.exitCode = 1;
