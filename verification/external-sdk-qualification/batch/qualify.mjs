import { readFileSync as qualificationReadFileSync } from "node:fs";
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as C from '@kaspa-x402/core';
import * as S from '@kaspa-x402/server';
import * as V from '@kaspa-x402/covenant';
import { NativeVoucherVerifier } from '@kaspa-x402/adapters';
import { schnorr } from '@noble/curves/secp256k1.js';
const DIR = new URL('.', import.meta.url), report = { base: JSON.parse(qualificationReadFileSync(new URL("../manifest.json", import.meta.url))).revision, seed: 20261016, tests: [], limits: ['Controlled chain acceptance; no node, consensus, funds, or broadcast proof.', 'Memory store restart means shared same-process store; no production durable backend qualification.', 'Test address codec; public covenant compiler and genuine Schnorr signatures.', 'Refund exercises real builder/vector boundaries; no timed node execution. Client funding orchestration is outside this server/payer harness.'] };
const key = Uint8Array.from(Buffer.from('02'.repeat(32), 'hex')), pub = Buffer.from(schnorr.getPublicKey(key)).toString('hex');
const serverPub = Buffer.from(schnorr.getPublicKey(Uint8Array.from(Buffer.from('03'.repeat(32), 'hex')))).toString('hex');
const sign = d => Buffer.from(schnorr.sign(Buffer.from(d, 'hex'), key, new Uint8Array(32))).toString('hex');
const hex = x => C.sha256Hex(x instanceof Uint8Array ? x : String(x));
const codec = { scriptPublicKeyForAddress: a => '0000' + hex(a), encodeScriptAddress: i => 'kaspatest:' + hex(i.serializedScriptPublicKey).slice(0, 32) };
const evidence = tx => ({ status: 'accepted', transactionId: tx, acceptingBlockHash: hex('accepted' + tx), acceptingBlockBlueScore: '971', confirmationCount: 30, checkpoint: { blockHash: 'ee'.repeat(32), blueScore: '1000', daaScore: '0' } });
let serial = 0, handlers = 0, requests = 0, active, route, behavior = 'normal';
class Chain {
    daa = '0';
    utxos = new Map();
    pending;
    put(u) { this.utxos.set(C.stableStringify(u.outpoint), { ...u, acceptance: evidence(u.outpoint.txid), finality: 'accepted' }); }
    async getUtxo(o) { return this.utxos.get(C.stableStringify(o)) ?? null; }
    async getVirtualDaaScore() { return this.daa; }
    async verifyCovenantGenesis({ utxo }) { return { covenantId: utxo.covenantId, authorizingInput: { txid: hex('genesis'), index: 0 }, genesisOutpoint: utxo.outpoint, genesisScriptPublicKey: utxo.scriptPublicKey, genesisAmount: utxo.amount, totalOutputCount: 1, authorizedOutputCount: 1, acceptance: utxo.acceptance }; }
    async discoverCovenantLineage({ lineage }) { return { fromCheckpoint: lineage.checkpoint, checkpoint: lineage.checkpoint, continuity: 'complete', removedChainBlockHashes: [], addedChainBlocks: [] }; }
    async estimateClaimFee() { return '10'; }
    async sendTransaction() { throw Error('Network broadcasts disabled in qualification'); }
}
function derive(cfg, S = '0') { const p = { clientPublicKey: pub, serverPublicKey: serverPub, network: cfg.network, payoutScriptPublicKeyHash: hex(Buffer.from(codec.scriptPublicKeyForAddress(cfg.payTo), 'hex')), refundScriptPublicKeyHash: hex(Buffer.from(codec.scriptPublicKeyForAddress(cfg.refundAddress), 'hex')), timeoutDaa: cfg.refundTimeoutDaa, claimedCumulativeAmount: S }; const script = V.escrowScriptPublicKey(p); return { escrowAddress: V.deriveEscrowAddress(p, i => codec.encodeScriptAddress(i)), activeScriptPublicKey: V.serializedScriptPublicKey(script), redeemScript: V.buildEscrowRedeemScript(p) }; }
function setup(opts = {}) { const chain = opts.chain ?? new Chain(), store = opts.store ?? new S.MemoryServerChannelStore(); const verifier = new NativeVoucherVerifier(); const config = { network: 'kaspa:testnet-10', payTo: 'kaspatest:payout', amount: opts.amount ?? '100', confirmationThreshold: 30, lockManager: new S.MemoryChannelLockManager(), store, chainProvider: chain, addressCodec: codec, batch: { serverPublicKey: serverPub, minDepositSompi: '1000000', claimReserveSompi: '10', refundTimeoutDaa: '10000', minimumRefundLeadDaa: '10', voucherVerifier: verifier, batchPresentationVerifier: verifier, ...opts.batch } }; const server = new S.DirectModeServer(config); return { server, chain, store, config }; }
function accepted(s, options = {}) { return s.server.buildPaymentRequired({ routeAccess: options.trustedSecurityContext ? 'authenticated' : 'public', resource: { url: route }, scheme: 'batch-settlement', ...options }).accepts[0]; }
function payment(s, { channel, amount, body, terms, context, fingerprint, type, forceDeposit = false } = {}) { terms ??= accepted(s, context ? { trustedSecurityContext: context } : {}); const cfg = channel?.channelConfig ?? { network: 'kaspa:testnet-10', asset: 'KAS', templateId: 'kaspa-x402-escrow-v5', clientPublicKey: pub, serverPublicKey: serverPub, payTo: terms.payTo, refundAddress: 'kaspatest:refund', refundTimeoutDaa: terms.extra.refundTimeoutDaa, salt: hex('salt' + (++serial)) }; const id = channel?.channelId ?? C.channelId(cfg), cov = channel?.covenantId ?? hex('cov' + serial), derived = derive(cfg, channel?.claimedCumulativeAmount), outpoint = channel?.activeOutpoint ?? { txid: hex('fund' + serial), index: 0 }; amount ??= (BigInt(channel?.chargedCumulativeAmount ?? '0') + BigInt(terms.amount)).toString(); const voucher = { covenantId: cov, authorizedCumulativeAmount: amount }; voucher.signature = sign(C.voucherDigest({ network: terms.network, covenantId: cov, authorizedCumulativeAmount: amount })); const fp = fingerprint ?? C.bindRequestHashToTrustedContext(hex(C.stableStringify({ method: 'GET', url: route, body: body ?? null, paymentRequirementsHash: hex(C.stableStringify(terms)) })), context); const u = { version: 'kaspa-x402-batch-presentation-v1', requestFingerprint: fp, acceptedRequirementsHash: C.batchPaymentRequirementsHash(terms), securityContextHash: terms.extra.securityContextHash, channelId: id, covenantId: cov, voucherDigest: C.voucherDigest({ network: terms.network, covenantId: cov, authorizedCumulativeAmount: amount }), paymentIdentifier: null, nonce: hex('nonce' + (++serial)), expiresAt: new Date(Date.now() + 60000).toISOString() }; const digest = C.batchPresentationDigest(u), presentation = { ...u, digest, signature: sign(digest) }; const payload = channel && !forceDeposit ? { type: type ?? 'voucher', channelId: id, clientPublicKey: pub, fundingOutpoint: outpoint, activeScriptPublicKey: channel.activeScriptPublicKey, voucher, presentation } : { type: 'deposit-voucher', channelConfig: cfg, channelId: id, escrowAddress: derived.escrowAddress, fundingOutpoint: outpoint, fundingAmountSompi: '1000000', activeScriptPublicKey: derived.activeScriptPublicKey, voucher, presentation }; if (!channel)
    s.chain.put({ outpoint, covenantId: cov, amount: '1000000', scriptPublicKey: derived.activeScriptPublicKey }); return { x402Version: 2, accepted: terms, payload }; }
const transport = http.createServer(async (req, res) => { try {
    requests++;
    let raw = '';
    for await (const chunk of req)
        raw += chunk;
    const input = raw ? JSON.parse(raw) : {};
    let result;
    if (req.url === '/mcp') {
        result = await S.handlePaidMcpToolCall(active.server, { routeAccess: 'public', audience: route, name: 'sample', scheme: 'batch-settlement', mcpErrorChargeSompi: '100' }, input, async () => { handlers++; return { result: { content: [{ type: 'text', text: 'mcp:' + handlers }] } }; });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(result));
        return;
    }
    result = await active.server.handlePaidRequest({ admissionKey: hex('qualification-caller'), routeAccess: input.context ? 'authenticated' : 'public', method: 'GET', url: route, resource: { url: route }, body: input.body, paymentScheme: 'batch-settlement', trustedSecurityContext: input.context, headers: input.payment ? { [S.PAYMENT_SIGNATURE_HEADER]: C.encodePaymentSignatureHeader(input.payment) } : {} }, async () => { handlers++; if (behavior === 'throw')
        throw Error('injected unknown handler outcome'); if (behavior === 'slow')
        await new Promise(r => setTimeout(r, 15)); return { body: { handler: handlers, payload: input.body ?? null } }; });
    res.statusCode = result.status;
    for (const [k, v] of Object.entries(result.headers))
        res.setHeader(k, v);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(result.body));
}
catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: e.message }));
} });
await new Promise(r => transport.listen(0, '127.0.0.1', r));
route = `http://127.0.0.1:${transport.address().port}/paid`;
async function call(p, body, context) { const r = await fetch(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payment: p, body, context }) }); const text = await r.text(); return { status: r.status, body: text ? JSON.parse(text) : null, headers: Object.fromEntries(r.headers) }; }
async function test(name, fn) { const start = Date.now(); try {
    await fn();
    report.tests.push({ name, status: 'pass', ms: Date.now() - start });
}
catch (e) {
    report.tests.push({ name, status: 'fail', error: e.stack, ms: Date.now() - start });
} }
try {
    await test('first genuine signed deposit, duplicate retries and independent charge totals', async () => { active = setup(); const p = payment(active), before = handlers; {
        const rr = await call(p);
        assert.equal(rr.status, 200);
    } for (let i = 0; i < 5; i++)
        assert.equal((await call(p)).status, 200); assert.equal(handlers - before, 1); const ch = await active.store.loadChannel(p.payload.channelId); assert.equal(ch.chargedCumulativeAmount, '100'); assert.equal(ch.signedMaxClaimable, '100'); });
    await test('fixed-seed 650 HTTP requests with repeats, concurrent retries, restart and independent accounting', async () => { active = setup(); let p = payment(active), id = p.payload.channelId, charges = 0, before = handlers, seed = 20261016, total = 0; while (total < 650) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const copies = Math.min(1 + seed % 5, 650 - total);
        const results = await Promise.all(Array.from({ length: copies }, () => call(p)));
        assert(results.every(r => r.status === 200), JSON.stringify(results));
        charges++;
        total += copies;
        const ch = await active.store.loadChannel(id);
        assert.equal(ch.chargedCumulativeAmount, String(charges * 100));
        assert.equal(ch.claimedCumulativeAmount, '0');
        assert.equal(ch.signedMaxClaimable, String(charges * 100));
        assert.equal(ch.fundingAmount, '1000000');
        assert.equal(handlers - before, charges);
        if (charges % 19 === 0)
            active = { ...active, server: new S.DirectModeServer(active.config) };
        p = payment(active, { channel: ch });
    } report.stress = { requests: total, independentCharges: charges, expectedA: String(charges * 100), expectedS: '0', expectedV: '1000000', reserve: '10', handlers: handlers - before }; });
    await test('bad voucher and presentation signatures never execute handler', async () => { active = setup(); const before = handlers; for (const target of ['voucher', 'presentation']) {
        const p = payment(active);
        p.payload[target].signature = '00'.repeat(64);
        assert.notEqual((await call(p)).status, 200);
    } assert.equal(handlers, before); });
    await test('body and trusted-principal response binding', async () => { active = setup(); const ctx = { principal: 'alice', tenant: 'merchant' }, other = { principal: 'bob', tenant: 'merchant' }, p = payment(active, { body: { q: 1 }, context: ctx }); const before = handlers; assert.equal((await call(p, { q: 1 }, ctx)).status, 200); assert.notEqual((await call(p, { q: 2 }, ctx)).status, 200); assert.notEqual((await call(p, { q: 1 }, other)).status, 200); assert.equal(handlers - before, 1); });
    await test('stale cumulative voucher and malformed outpoint rejected', async () => { active = setup(); const p = payment(active); assert.equal((await call(p)).status, 200); const ch = await active.store.loadChannel(p.payload.channelId), before = handlers; assert.notEqual((await call(payment(active, { channel: ch, amount: '100' }))).status, 200); const q = payment(active, { channel: ch }); q.payload.fundingOutpoint = { txid: hex('stale'), index: 0 }; assert.notEqual((await call(q)).status, 200); assert.equal(handlers, before); });
    await test('refund boundary admission is fail closed', async () => { for (const daa of ['9990', '9991', '10000']) {
        active = setup();
        const p = payment(active), before = handlers;
        active.chain.daa = daa;
        assert.notEqual((await call(p)).status, 200);
        assert.equal(handlers, before);
    } });
    await test('unknown handler outcome held across shared-store restart and duplicate retry', async () => { active = setup(); const p = payment(active), before = handlers; behavior = 'throw'; assert.notEqual((await call(p)).status, 200); behavior = 'normal'; active.server = new S.DirectModeServer(active.config); for (let i = 0; i < 3; i++)
        assert.notEqual((await call(p)).status, 200); assert.equal(handlers - before, 1); });
    await test('distinct concurrent requests at same cumulative ceiling cannot overcharge', async () => { active = setup(); const p = payment(active); assert.equal((await call(p)).status, 200); const ch = await active.store.loadChannel(p.payload.channelId), before = handlers; behavior = 'slow'; const qs = Array.from({ length: 8 }, (_, i) => ({ body: { i }, p: payment(active, { channel: ch, body: { i } }) })); const results = await Promise.all(qs.map(q => call(q.p, q.body))); behavior = 'normal'; assert.equal(results.filter(r => r.status === 200).length, 1); assert.equal(handlers - before, 1); assert.equal((await active.store.loadChannel(ch.channelId)).chargedCumulativeAmount, '200'); });
    await test('fresh memory store explicitly loses replay protection (non-durable semantics)', async () => { active = setup(); const p = payment(active), before = handlers; assert.equal((await call(p)).status, 200); active = setup({ chain: active.chain }); assert.equal((await call(p)).status, 200); assert.equal(handlers - before, 2); assert.equal((await active.store.loadChannel(p.payload.channelId)).chargedCumulativeAmount, '100'); });
    await test('durable handler result survives interrupted commit and retry across shared-store restart', async () => {
        active = setup();
        const original = active.store.commitSettlement.bind(active.store);
        let fail = true;
        active.store.commitSettlement = async (record) => { if (fail) {
            fail = false;
            throw Error('injected precommit interruption');
        } return original(record); };
        const p = payment(active), before = handlers;
        assert.notEqual((await call(p)).status, 200);
        active.server = new S.DirectModeServer(active.config);
        assert.equal((await call(p)).status, 200);
        assert.equal(handlers - before, 1);
        const ch = await active.store.loadChannel(p.payload.channelId);
        assert.equal(ch.chargedCumulativeAmount, '100');
        assert.equal((await call(p)).status, 200);
        assert.equal(handlers - before, 1);
    });
    await test('operator recovery supplies known result without replaying unknown handler', async () => {
        active = setup();
        const claim = active.store.claimBatchSettlement.bind(active.store);
        let attemptId;
        active.store.claimBatchSettlement = async (a) => { attemptId = a.attemptId; return claim(a); };
        const p = payment(active), before = handlers;
        behavior = 'throw';
        await call(p);
        behavior = 'normal';
        assert(attemptId);
        await assert.rejects(() => active.server.recoverBatchHandler(attemptId, { body: { recovered: true }, chargedAmount: '99' }));
        await active.server.recoverBatchHandler(attemptId, { body: { recovered: true }, chargedAmount: '100' });
        assert.deepEqual((await call(p)).body, { recovered: true });
        assert.equal(handlers - before, 1);
        assert.equal((await active.store.loadChannel(p.payload.channelId)).chargedCumulativeAmount, '100');
    });
    await test('expired signed presentation and exact reserve boundary', async () => {
        active = setup();
        let p = payment(active), before = handlers;
        const u = { ...p.payload.presentation, expiresAt: new Date(Date.now() - 1000).toISOString() };
        u.digest = C.batchPresentationDigest(u);
        u.signature = sign(u.digest);
        p.payload.presentation = u;
        assert.notEqual((await call(p)).status, 200);
        assert.equal(handlers, before);
        active = setup({ amount: '999990' });
        p = payment(active);
        assert.equal((await call(p)).status, 200);
        assert.equal((await active.store.loadChannel(p.payload.channelId)).chargedCumulativeAmount, '999990');
        active = setup({ amount: '999991' });
        p = payment(active);
        before = handlers;
        assert.notEqual((await call(p)).status, 200);
        assert.equal(handlers, before);
        active = setup();
        p = payment(active);
        active.chain.daa = '9989';
        assert.equal((await call(p)).status, 200);
    });
    await test('real public claim builder: partial claim preserves lifetime ceiling and channel reuse', async () => {
        active = setup();
        const artifacts = [];
        let prepared;
        active.config.batch.claimBuilder = { buildClaimTransaction({ channel, claimAmount }) {
                const old = derive(channel.channelConfig, channel.claimedCumulativeAmount), next = derive(channel.channelConfig, String(BigInt(channel.claimedCumulativeAmount) + BigInt(claimAmount)));
                const input = { network: 'kaspa:testnet-10', activeOutpoint: channel.activeOutpoint, activeAmount: channel.fundingAmount, activeScriptPublicKey: old.activeScriptPublicKey, activeRedeemScript: old.redeemScript, covenantId: channel.covenantId, claimedCumulativeAmount: channel.claimedCumulativeAmount, authorizedCumulativeAmount: channel.signedMaxClaimable, claimAmount, successorScriptPublicKey: next.activeScriptPublicKey, successorRedeemScript: next.redeemScript, serverOutputScriptPublicKey: codec.scriptPublicKeyForAddress('kaspatest:payout'), expectedPayoutScriptPublicKeyHash: hex(Buffer.from(codec.scriptPublicKeyForAddress('kaspatest:payout'), 'hex')), fee: '10', serverSignature: '00'.repeat(64) + '01', voucherSignature: channel.voucherSignature, computeBudget: 20, scriptUnitsEstimate: 208049 };
                let a = V.buildBatchClaimTxV1Artifact(input);
                input.serverSignature = Buffer.from(schnorr.sign(Buffer.from(a.sighashes[0].digest, 'hex'), Uint8Array.from(Buffer.from('03'.repeat(32), 'hex')), new Uint8Array(32))).toString('hex') + '01';
                a = V.buildBatchClaimTxV1Artifact(input);
                assert(schnorr.verify(Buffer.from(input.serverSignature.slice(0, 128), 'hex'), Buffer.from(a.sighashes[0].digest, 'hex'), Buffer.from(serverPub, 'hex')));
                artifacts.push(a);
                prepared = { channel, a };
                return { transaction: a.serializedTransaction, transactionId: a.transactionId, claimAmount, continuationOutpoint: a.continuation.outpoint, continuationScriptPublicKey: a.continuation.scriptPublicKey, continuationFundingAmount: a.continuation.amount };
            } };
        active.chain.sendTransaction = async () => { const { channel, a } = prepared; active.chain.utxos.delete(C.stableStringify(channel.activeOutpoint)); active.chain.put({ outpoint: a.continuation.outpoint, covenantId: channel.covenantId, amount: a.continuation.amount, scriptPublicKey: a.continuation.scriptPublicKey }); return { transactionId: a.transactionId, finality: 'confirmed', evidence: evidence(a.transactionId) }; };
        active.server = new S.DirectModeServer(active.config);
        let p = payment(active), id = p.payload.channelId;
        assert.equal((await call(p)).status, 200);
        let ch = await active.store.loadChannel(id);
        assert.equal((await call(payment(active, { channel: ch }))).status, 200);
        await active.server.executeClaim(id, '100');
        ch = await active.store.loadChannel(id);
        assert.equal(ch.chargedCumulativeAmount, '200');
        assert.equal(ch.claimedCumulativeAmount, '100');
        assert.equal(ch.signedMaxClaimable, '200');
        assert.equal(ch.fundingAmount, '999900');
        assert.equal((await call(payment(active, { channel: ch }))).status, 200);
        ch = await active.store.loadChannel(id);
        assert.equal(ch.chargedCumulativeAmount, '300');
        assert.equal(ch.claimedCumulativeAmount, '100');
        assert.equal(ch.signedMaxClaimable, '300');
        assert.equal(ch.fundingAmount, '999900');
        assert.equal((await active.server.previewClaim(id, '201')).claimable, false);
        await fs.writeFile(new URL('claim-artifacts.json', DIR), JSON.stringify(artifacts, null, 2));
    });
    await test('actual top-up builder and server transition preserve A/S/T and reject stale head', async () => {
        active = setup({ batch: { topUpVerifier: { verifyTopUp({ previous, next, utxo }) { return { covenantId: previous.covenantId, spentOutpoint: previous.activeOutpoint, successorOutpoint: next.activeOutpoint, successorScriptPublicKey: next.activeScriptPublicKey, successorAmount: next.fundingAmount, authorizedSuccessorCount: 1, authorizingInput: 0, acceptance: utxo.acceptance }; } } } });
        let p = payment(active);
        assert.equal((await call(p)).status, 200);
        let ch = await active.store.loadChannel(p.payload.channelId), d = derive(ch.channelConfig, ch.claimedCumulativeAmount);
        const i = { activeOutpoint: ch.activeOutpoint, activeAmount: ch.fundingAmount, activeScriptPublicKey: d.activeScriptPublicKey, activeRedeemScript: d.redeemScript, covenantId: ch.covenantId, claimedCumulativeAmount: ch.claimedCumulativeAmount, successorAmount: '1001000', successorScriptPublicKey: d.activeScriptPublicKey, successorRedeemScript: d.redeemScript, clientSignature: '00'.repeat(64) + '01', providerSignature: '00'.repeat(64) + '01', fundingInputs: [{ previousOutpoint: { txid: hex('topupfund'), index: 0 }, amount: '1010', computeBudget: 10, scriptPublicKey: '000020' + pub + 'ac', signature: '00'.repeat(64) }], expectedRefundScriptPublicKeyHash: hex(Buffer.from(codec.scriptPublicKeyForAddress('kaspatest:refund'), 'hex')), fee: '10', computeBudget: 20, scriptUnitsEstimate: 208049 };
        let a = V.buildBatchTopUpTxV1Artifact(i);
        i.clientSignature = sign(a.sighashes[0].digest) + '01';
        i.providerSignature = Buffer.from(schnorr.sign(Buffer.from(a.sighashes[0].digest, 'hex'), Uint8Array.from(Buffer.from('03'.repeat(32), 'hex')), new Uint8Array(32))).toString('hex') + '01';
        i.fundingInputs[0].signature = sign(a.sighashes[1].digest);
        a = V.buildBatchTopUpTxV1Artifact(i);
        assert(schnorr.verify(Buffer.from(i.clientSignature.slice(0, 128), 'hex'), Buffer.from(a.sighashes[0].digest, 'hex'), Buffer.from(pub, 'hex')));
        assert(schnorr.verify(Buffer.from(i.fundingInputs[0].signature, 'hex'), Buffer.from(a.sighashes[1].digest, 'hex'), Buffer.from(pub, 'hex')));
        const q = payment(active, { channel: ch, forceDeposit: true });
        q.payload.fundingOutpoint = a.continuation.outpoint;
        q.payload.fundingAmountSompi = a.continuation.amount;
        active.chain.put({ outpoint: a.continuation.outpoint, covenantId: ch.covenantId, amount: a.continuation.amount, scriptPublicKey: a.continuation.scriptPublicKey });
        active.chain.utxos.delete(C.stableStringify(ch.activeOutpoint));
        assert.equal((await call(q)).status, 200);
        const after = await active.store.loadChannel(ch.channelId);
        assert.equal(after.fundingAmount, '1001000');
        assert.equal(after.chargedCumulativeAmount, '200');
        assert.equal(after.claimedCumulativeAmount, '0');
        assert.equal(after.signedMaxClaimable, '200');
        const stale = payment(active, { channel: ch, amount: '300' });
        assert.notEqual((await call(stale)).status, 200);
        await fs.writeFile(new URL('top-up-artifact.json', DIR), JSON.stringify(a, null, 2));
    });
    await test('public signed vector builders: top-up/refund boundary and claim continuation', async () => {
        const outputs = {};
        for (const [name, builder] of [['batch-claim', V.buildBatchClaimTxV1Artifact], ['batch-claim-second', V.buildBatchClaimTxV1Artifact], ['batch-top-up', V.buildBatchTopUpTxV1Artifact], ['batch-refund', V.buildBatchRefundTxV1Artifact]]) {
            const vector = JSON.parse(await fs.readFile(new URL('../fixtures/vectors/tx-v1/' + name + '.json', DIR)));
            const a = builder(vector.input);
            assert.equal(a.transactionId, vector.expected.transactionId);
            outputs[name] = { transactionId: a.transactionId, kind: a.kind };
            if (name === 'batch-top-up') {
                assert.equal(a.continuation.claimedCumulativeAmount, String(vector.input.claimedCumulativeAmount));
                assert.throws(() => builder({ ...vector.input, successorAmount: vector.input.activeAmount }));
            }
            if (name === 'batch-refund') {
                assert.throws(() => builder({ ...vector.input, lockTimeDaa: String(BigInt(vector.input.timeoutDaa) - 1n) }));
                assert.throws(() => builder({ ...vector.input, inputSequence: '18446744073709551615' }));
            }
        }
        report.vectorBuilders = outputs;
    });
    await test('public lifetime accounting partial claim/top-up/reserve independent arithmetic', async () => { let st = { fundingAmount: '1000000', chargedCumulativeAmount: '800', claimedCumulativeAmount: '0', signedMaxClaimable: '800' }; st = C.applyBatchClaimAccounting(st, '300'); assert.deepEqual(st, { fundingAmount: '999700', chargedCumulativeAmount: '800', claimedCumulativeAmount: '300', signedMaxClaimable: '800' }); st = { ...st, fundingAmount: String(BigInt(st.fundingAmount) + 1000n) }; assert.equal(C.requiredBatchVoucherAmount(st, '100'), '900'); C.assertBatchVoucherReserve(st, '10'); assert.throws(() => C.applyBatchClaimAccounting(st, '501')); assert.throws(() => C.assertBatchVoucherReserve({ ...st, fundingAmount: '500' }, '1')); assert.throws(() => C.batchLaneAccounting({ ...st, claimedCumulativeAmount: '801' })); assert.throws(() => C.parseBatchLaneAmount('9223372036854775808')); });
    await test('loopback MCP genuine signed payment, duplicate result and argument binding', async () => { active = setup(); const invoke = async (params) => (await fetch(route.replace('/paid', '/mcp'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) })).json(); let params = { name: 'sample', arguments: { q: 1 } }; const required = C.readMcpPaymentRequired(await invoke(params)); assert(required); const terms = required.accepts[0], fingerprint = C.mcpToolCallFingerprint({ audience: route, toolName: 'sample', arguments: params.arguments, accepted: terms }); const p = payment(active, { terms, fingerprint }); params = { ...params, _meta: { [C.MCP_PAYMENT_META_KEY]: p } }; const before = handlers; const result = await invoke(params); assert(C.readMcpPaymentResponse(result), JSON.stringify(result)); assert.deepEqual(await invoke(params), result); const bad = await invoke({ ...params, arguments: { q: 2 } }); assert(!C.readMcpPaymentResponse(bad)); assert.equal(handlers - before, 1); });
}
finally {
    await new Promise(r => transport.close(r));
    report.httpRequests = requests;
    report.handlerCalls = handlers;
    report.pass = report.tests.filter(t => t.status === 'pass').length;
    report.fail = report.tests.length - report.pass;
    await fs.writeFile(new URL('report.json', DIR), JSON.stringify(report, null, 2) + '\n');
    const sums = [];
    for (const file of ['qualify.mjs', 'report.json', 'claim-artifacts.json', 'top-up-artifact.json', 'failure-modes.md', 'README.md', 'verify.mjs']) {
        const data = await fs.readFile(new URL(file, DIR));
        sums.push(createHash('sha256').update(data).digest('hex') + '  ' + file);
    }
    await fs.writeFile(new URL('SHA256SUMS', DIR), sums.join('\n') + '\n');
    console.log(JSON.stringify(report, null, 2));
}
process.exitCode = report.fail ? 1 : 0;
