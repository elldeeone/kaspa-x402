import { readFileSync as qualificationReadFileSync } from "node:fs";
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { schnorr } from '@noble/curves/secp256k1.js';
import * as core from '@kaspa-x402/core';
import * as cov from '@kaspa-x402/covenant';
import { DirectModeServer, MemoryServerChannelStore, MemoryChannelLockManager } from '@kaspa-x402/server';
// Installed private support package is an explicit fixture, not a public release claim.
import { VerifiedExactTransactionVerifier, VerifiedExactSettlementReconciler, VerifiedExactHeadReconciler } from '@kaspa-x402/adapters';
import { addressForScriptPublicKey } from '../fixtures/sdk-native-address.mjs';
const OUT = new URL('./', import.meta.url);
const network = 'kaspa:testnet-10', amount = '20000000', threshold = '10000000';
const hex = x => Buffer.from(x).toString('hex'), bytes = x => Buffer.from(x, 'hex');
const key = bytes('03'.repeat(32)), pub = hex(schnorr.getPublicKey(key));
const payerScript = '000020' + pub + 'ac';
const redeem = cov.buildKip10AdditiveRedeemScript({ ownerPublicKey: pub, amount: threshold });
const script = cov.serializedScriptPublicKey(cov.payToScriptHashScript(redeem));
const payTo = addressForScriptPublicKey(script, network);
let serial = 0, requests = 0, broadcastCalls = 0, server;
let seed = 0x1973a14;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
const hash = x => core.sha256Hex(x), id = x => hash(`qualification-additive:${x}`);
const txs = new Map(), utxos = new Map(), accepted = new Set(), unknown = new Set(), ledger = new Map();
const store = new MemoryServerChannelStore();
const lockManager = new MemoryChannelLockManager();
const keyOf = o => `${o.txid}:${o.index}`;
const observations = [];
const cases = [];
function origin(txid, value, spk) { txs.set(txid, { transaction_id: txid, is_accepted: true, outputs: [{ index: 0, amount: value, script_public_key: spk }] }); utxos.set(`${txid}:0`, { outpoint: { txid, index: 0 }, amount: value, scriptPublicKey: spk }); }
function rest(t) { return { transaction_id: t.id, is_accepted: true, version: t.version, lock_time: t.lockTime, subnetwork_id: t.subnetworkId, gas: t.gas, payload: t.payload, inputs: t.inputs.map(i => ({ previous_outpoint_hash: i.previousOutpoint.transactionId, previous_outpoint_index: i.previousOutpoint.index, signature_script: i.signatureScript, sequence: i.sequence, sig_op_count: 0, compute_budget: i.computeBudget })), outputs: t.outputs.map((o, index) => ({ index, amount: o.value, script_public_key: o.scriptPublicKey, covenant_id: null })), mass: t.storageMass }; }
function apply(t) { for (const i of t.inputs)
    utxos.delete(`${i.previousOutpoint.transactionId}:${i.previousOutpoint.index}`); for (const [index, o] of t.outputs.entries())
    utxos.set(`${t.id}:${index}`, { outpoint: { txid: t.id, index }, amount: o.value, scriptPublicKey: o.scriptPublicKey }); txs.set(t.id, rest(t)); accepted.add(t.id); }
const evidence = { network, async getTransaction(x) { return txs.get(x) ?? null; }, async getUtxosForAddress(a) { return [...utxos.values()].filter(u => addressForScriptPublicKey(u.scriptPublicKey, network) === a); } };
const verifier = new VerifiedExactTransactionVerifier(evidence, { network });
const reconciler = new VerifiedExactSettlementReconciler(evidence, { network });
const headReconciler = new VerifiedExactHeadReconciler(evidence, { network });
const chain = { async sendTransaction(raw) { broadcastCalls++; const t = JSON.parse(raw); if (unknown.has(t.id))
        throw Error('controlled transport outcome unknown'); for (const i of t.inputs)
        if (!utxos.has(`${i.previousOutpoint.transactionId}:${i.previousOutpoint.index}`))
            throw Error('controlled spent input'); apply(t); return { transactionId: t.id, finality: 'accepted', accepted: true }; } };
function restart() { server = new DirectModeServer({ network, payTo, amount, store, lockManager, chainProvider: chain, addressCodec: { scriptPublicKeyForAddress() { return script; } }, confirmationThreshold: 30, exactProfile: 'additive', exactTransactionVerifier: verifier, exactSettlementReconciler: reconciler, exactHeadReconciler: headReconciler, publicBoundaryPolicy: { callerQuota: 10000, maxCallerConcurrency: 32, maxAdapterConcurrency: 32 } }); }
async function addHead(n) { const txid = id(`head:${n}`); origin(txid, '100000000', script); const now = new Date().toISOString(); return store.registerExactHead({ headId: id(`identity:${n}`), network, payTo, templateId: 'kaspa-x402-kip10-additive-v1', transactionEncoding: 'kaspa-sdk-safe-json-v2.0.0', currentOutpoint: { txid, index: 0 }, currentAmount: '100000000', scriptPublicKey: script, redeemScript: redeem, additiveThresholdSompi: threshold, version: '0', status: 'available', createdAt: now, updatedAt: now }); }
function payment(accepted, path) {
    const e = accepted.extra;
    const funding = id(`funding:${++serial}`);
    origin(funding, '30000000', payerScript);
    const inp = (txid, value, spk, signatureScript, computeBudget) => ({ previousOutpoint: { txid, index: 0 }, signatureScript, sequence: '0', computeBudget, utxo: { amount: value, scriptPublicKey: spk, blockDaaScore: '0', isCoinbase: false, covenantId: null } });
    const reference = { version: 1, inputs: [inp(e.expectedHeadOutpoint.txid, e.headAmount, script, cov.buildKip10AdditiveBorrowSignatureScript(redeem), 0), inp(funding, '30000000', payerScript, '', 10)], outputs: [{ amount: (BigInt(e.headAmount) + BigInt(amount)).toString(), scriptPublicKey: script, covenant: null }, { amount: '9990000', scriptPublicKey: payerScript, covenant: null }], lockTime: '0', subnetworkId: '00'.repeat(20), gas: '0', payload: '', mass: '0', estimatedSerializedSize: 0 };
    reference.mass = cov.calculateKaspaStorageMass({ inputs: reference.inputs.map(i => ({ ...i.utxo, hasCovenant: false })), outputs: reference.outputs.map(o => ({ ...o, hasCovenant: false })) }).toString();
    reference.inputs[1].signatureScript = cov.buildTxV1P2pkSignatureScript(schnorr.sign(bytes(cov.transactionV1Sighash(reference, 1).digest), key, new Uint8Array(32)));
    const txid = cov.transactionV1Id(reference);
    const artifact = { ...reference, id: txid, storageMass: reference.mass, inputs: reference.inputs.map(i => ({ ...i, previousOutpoint: { transactionId: i.previousOutpoint.txid, index: i.previousOutpoint.index }, sigOpCount: 0 })), outputs: reference.outputs.map(o => ({ ...o, value: o.amount })) };
    delete artifact.mass;
    delete artifact.estimatedSerializedSize;
    const requestHash = id(`request:${path}`), paymentIdentifier = `additive_payment_${serial}`, expiresAt = core.exactAuthorizationExpiresAt(accepted.maxTimeoutSeconds, e.challengeExpiresAt);
    const digest = core.exactRequestAuthorizationDigest({ network, profile: 'additive', transactionId: txid, paymentOutputIndex: 0, amount, payTo, payToScriptPublicKey: script, paymentRequirementsHash: hash(core.stableStringify(accepted)), requestHash, paymentIdentifier, challengeId: e.challengeId, inputIndex: 1, expiresAt });
    return { x402Version: 2, accepted, payload: { type: 'exact-transaction', profile: 'additive', challengeId: e.challengeId, transaction: JSON.stringify(artifact), transactionEncoding: 'kaspa-sdk-safe-json-v2.0.0', paymentOutputIndex: 0, requestHash, authorization: { version: 'kaspa-x402-exact-request-authorization-v2', inputIndex: 1, expiresAt, digest, signature: hex(schnorr.sign(bytes(digest), key, new Uint8Array(32))) } }, extensions: { 'payment-identifier': core.paymentIdentifierExtension({ required: true, id: paymentIdentifier }) } };
}
const transport = http.createServer(async (req, res) => { try {
    const r = await server.handlePaidRequest({ routeAccess: 'public', admissionKey: id(`caller:${req.url}`), method: 'GET', url: `http://127.0.0.1${req.url}`, resource: { url: `http://127.0.0.1${req.url}` }, requestHash: id(`request:${req.url}`), paymentScheme: 'exact', headers: req.headers }, ctx => { const count = (ledger.get(ctx.requestFingerprint) ?? 0) + 1; ledger.set(ctx.requestFingerprint, count); if (req.url.startsWith('/handler-unknown'))
        throw Error('controlled side effect completed; response unknown'); return { body: { paid: true, fingerprint: ctx.requestFingerprint }, chargedAmount: amount }; });
    res.writeHead(r.status, r.headers);
    res.end(JSON.stringify(r.body ?? null));
}
catch (e) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
} });
await new Promise(resolve => transport.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${transport.address().port}`;
async function call(path, p) { requests++; const r = await fetch(base + path, { headers: p ? { 'PAYMENT-SIGNATURE': core.encodePaymentSignatureHeader(p) } : {} }); const body = await r.text(); const result = { status: r.status, body, required: r.headers.get('PAYMENT-REQUIRED') }; observations.push({ path, status: r.status, transactionId: p ? JSON.parse(p.payload.transaction).id : undefined, body: body.slice(0, 200) }); return result; }
async function offer(path) { const r = await call(path); assert.equal(r.status, 402, r.body); return core.decodePaymentRequiredHeader(r.required).accepts[0]; }
async function test(name, fn) { try {
    await fn();
    cases.push({ name, pass: true });
    console.log('PASS', name);
}
catch (e) {
    cases.push({ name, pass: false, error: e.stack });
    console.error('FAIL', name, e.message, JSON.stringify(e));
} }
restart();
await addHead(0);
await test('real signatures / repeated exact successor deltas', async () => { for (let n = 0; n < 8; n++) {
    const path = `/repeat/${n}`, a = await offer(path), p = payment(a, path), before = await store.loadExactHead(a.extra.headId), r = await call(path, p);
    assert.equal(r.status, 200, r.body);
    const after = await store.loadExactHead(a.extra.headId);
    assert.equal(BigInt(after.currentAmount) - BigInt(before.currentAmount), BigInt(amount));
    assert.equal(BigInt(after.version), BigInt(before.version) + 1n);
    assert.equal(after.currentOutpoint.txid, JSON.parse(p.payload.transaction).id);
    assert.equal(after.scriptPublicKey, script);
} });
await test('duplicate retries return receipt once across server recreation', async () => { const path = '/retry', p = payment(await offer(path), path); assert.equal((await call(path, p)).status, 200); const broadcasts = broadcastCalls; restart(); assert.equal((await call(path, p)).status, 200); assert.equal(broadcastCalls, broadcasts); assert.equal(Math.max(...ledger.values()), 1); });
await test('concurrent same-head winner and loser / stale offer', async () => { const paths = ['/race/a', '/race/b']; const offers = await Promise.all(paths.map(offer)); assert.equal(offers[0].extra.headId, offers[1].extra.headId); const payments = offers.map((a, i) => payment(a, paths[i])); const results = await Promise.all(paths.map((p, i) => call(p, payments[i]))); assert.deepEqual(results.map(x => x.status).sort(), [200, 402]); const loser = results.findIndex(x => x.status === 402); assert.equal((await call(paths[loser], payments[loser])).status, 402); });
await test('tampered real authorization and wrong exact delta rejected', async () => { const path = '/bad', p = payment(await offer(path), path); p.payload.authorization.signature = '00'.repeat(64); assert.equal((await call(path, p)).status, 402); const q = payment(await offer(path), path), t = JSON.parse(q.payload.transaction); t.outputs[0].value = (BigInt(t.outputs[0].value) + 1n).toString(); q.payload.transaction = JSON.stringify(t); assert.equal((await call(path, q)).status, 402); });
await test('unknown broadcast reserves head; reconciles once after restart', async () => { const path = '/unknown', a = await offer(path), p = payment(a, path), t = JSON.parse(p.payload.transaction); unknown.add(t.id); const before = ledger.size; const r = await call(path, p); assert.notEqual(r.status, 200); const h = await store.loadExactHead(a.extra.headId); assert.equal(h.status, 'claimed'); assert.equal(ledger.size, before); restart(); assert.notEqual((await call(path, p)).status, 200); assert.equal(ledger.size, before); unknown.delete(t.id); apply(t); const recovered = await call(path, p); assert.equal(recovered.status, 200, recovered.body); assert.equal(ledger.size, before + 1); assert.equal((await store.loadExactHead(a.extra.headId)).status, 'available'); });
await test('concurrent identical paid retries execute one handler', async () => { const path = '/duplicate-concurrent', p = payment(await offer(path), path), before = ledger.size; const responses = await Promise.all(Array.from({ length: 8 }, () => call(path, p))); assert.equal(responses.filter(r => r.status === 200).length, 8); assert.equal(ledger.size, before + 1); assert.equal(Math.max(...ledger.values()), 1); });
await test('handler side effect uncertainty is held for explicit recovery', async () => { const path = '/handler-unknown', p = payment(await offer(path), path), before = ledger.size; assert.notEqual((await call(path, p)).status, 200); const t = JSON.parse(p.payload.transaction); let attempt = await store.loadExactSettlementAttempt(t.id); assert.equal(attempt.status, 'accepted'); assert.ok(attempt.handlerStartedAt); assert.ok(attempt.recoveryReason); restart(); assert.notEqual((await call(path, p)).status, 200); assert.equal(ledger.size, before + 1); assert.equal(Math.max(...ledger.values()), 1); await assert.rejects(store.abandonExactSettlement(t.id, 'unsafe abandonment', new Date().toISOString()), /accepted/); });
await test('100 unpaid offers do not lease or advance heads', async () => { const before = await store.listExactHeads(); for (let n = 0; n < 100; n++)
    await offer(`/unpaid/${n}`); assert.deepEqual(await store.listExactHeads(), before); });
await test('controlled external advancement and reorg quarantine', async () => { const path = '/external', a = await offer(path), p = payment(a, path), t = JSON.parse(p.payload.transaction); apply(t); const result = await server.reconcileExactHead(a.extra.headId, [t.id]); assert.equal(result.status, 'available'); assert.equal(result.currentOutpoint.txid, t.id); txs.get(t.id).is_accepted = false; utxos.delete(`${t.id}:0`); const quarantined = await server.reconcileExactHead(a.extra.headId); assert.equal(quarantined.status, 'unavailable'); assert.equal(ledger.has(p.payload.requestHash), false); });
await test('fixed seed 640 HTTP requests / eight shards / bounded concurrency', async () => { for (let n = 1; n <= 8; n++)
    await addHead(n); const start = await store.listExactHeads(), versions = new Map(start.map(h => [h.headId, BigInt(h.version)])), amounts = new Map(start.map(h => [h.headId, BigInt(h.currentAmount)])); const acceptedBefore = accepted.size, ledgerBefore = ledger.size; let winners = 0; for (let round = 0; round < 40; round++) {
    const paths = Array.from({ length: 8 }, (_, i) => `/stress/${round}/${i}/${Math.floor(random() * 100000)}`);
    const offers = await Promise.all(paths.map(offer));
    const ps = offers.map((a, i) => payment(a, paths[i]));
    const rs = await Promise.all(paths.map((p, i) => call(p, ps[i])));
    for (const r of rs) {
        assert.ok([200, 402, 409, 429, 503].includes(r.status), r.body);
        if (r.status === 200)
            winners++;
    }
} const end = await store.listExactHeads(); const increments = end.reduce((s, h) => s + BigInt(h.version) - versions.get(h.headId), 0n); assert.ok(end.filter(h => BigInt(h.version) > versions.get(h.headId)).length >= 2, 'independent shards progressed'); assert.equal(increments, BigInt(winners)); assert.equal(ledger.size - ledgerBefore, winners); assert.equal(accepted.size - acceptedBefore, winners); for (const h of end)
    assert.equal(BigInt(h.currentAmount) - amounts.get(h.headId), (BigInt(h.version) - versions.get(h.headId)) * BigInt(amount)); assert.equal(Math.max(...ledger.values()), 1); });
const report = { baseCommit: JSON.parse(qualificationReadFileSync(new URL("../manifest.json", import.meta.url))).revision, seed: '0x1973a14', requests, broadcastCalls, acceptedTransactions: accepted.size, handlerInvocations: [...ledger.values()].reduce((a, b) => a + b, 0), cases, heads: await store.listExactHeads(), limitations: ['Controlled acceptance/UTXO evidence; no consensus node, live broadcast, funding or production throughput claim.', 'Installed @kaspa-x402/adapters private support verifier and copied native address fixture explicitly used.', 'Recreated server uses same provided MemoryServerChannelStore; no process-crash durability claim.', 'Public server/covenant/core APIs and real Schnorr transaction/intent signatures; no source runtime imports.'] };
await fs.writeFile(new URL('report.json', OUT), JSON.stringify(report, null, 2));
await fs.writeFile(new URL('requests.json', OUT), JSON.stringify(observations, null, 2));
await fs.writeFile(new URL('ledger.json', OUT), JSON.stringify([...ledger], null, 2));
await fs.writeFile(new URL('README.md', OUT), 'Run: `node additive/run.mjs` from campaign root. Outputs report.json, requests.json and ledger.json. See FAILURE-MODES.md written before implementation.\n');
await new Promise(resolve => transport.close(resolve));
console.log(JSON.stringify({ requests, cases: cases.length, passed: cases.filter(c => c.pass).length }));
process.exitCode = cases.some(c => !c.pass) ? 1 : 0;
