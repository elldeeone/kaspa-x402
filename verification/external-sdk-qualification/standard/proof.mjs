import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { DirectModeClient, MemoryChannelStore } from '@kaspa-x402/client';
import { DirectModeServer, MemoryServerChannelStore, handlePaidMcpToolCall } from '@kaspa-x402/server';
import { exactRequestAuthorizationId, encodePaymentSignatureHeader, decodePaymentResponseHeader, readMcpPaymentRequired, encodePaymentRequiredHeader, mcpToolCallFingerprint, withMcpPaymentPayload } from '@kaspa-x402/core';
import { createMockDirectModeEnvironment, PAYOUT_ADDRESS } from '../fixtures/mock-testnet.mjs';
const started = Date.now();
const env = createMockDirectModeEnvironment();
const cases = [], results = [], counts = { httpRequests: 0, handler: 0, broadcasts: 0, mcpHandler: 0 };
let activeServer = env.server, origin;
const realSend = env.chainProvider.sendTransaction.bind(env.chainProvider);
env.chainProvider.sendTransaction = async (...args) => { counts.broadcasts++; return realSend(...args); };
const host = http.createServer({ maxHeaderSize: 262144 }, async (req, res) => {
    counts.httpRequests++;
    try {
        const chunks = [];
        for await (const chunk of req)
            chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString();
        const body = raw ? JSON.parse(raw) : undefined;
        const tenant = req.headers['x-tenant'];
        const out = await activeServer.handlePaidRequest({ routeAccess: tenant ? 'authenticated' : 'public', admissionKey: 'ab'.repeat(32), method: req.method, url: origin + req.url, headers: req.headers, body, paymentScheme: 'exact', ...(tenant ? { trustedSecurityContext: { principal: 'payer', tenant, authorizationScopes: ['read'] } } : {}) }, async () => { counts.handler++; return { body: { id: body?.id ?? null, secret: 'paid', invocation: counts.handler } }; });
        if (req.headers['x-drop-response'] === '1') {
            res.destroy();
            return;
        }
        res.writeHead(out.status, out.headers);
        res.end(JSON.stringify(out.body));
    }
    catch (error) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: String(error) }));
    }
});
await new Promise(r => host.listen(0, '127.0.0.1', r));
origin = `http://127.0.0.1:${host.address().port}`;
const client = new DirectModeClient({ addressCodec: env.addressCodec, confirmationThreshold: 30, fundingProvider: env.fundingProvider, store: new MemoryChannelStore(), fundingPolicy: { requiredSource: 'hot-wallet', allowedOrigins: [origin, 'https://mcp.example.test'], allowedExactProfiles: ['standard-native'], allowedPayTo: [PAYOUT_ADDRESS], maximumExactAmountSompi: '100000' } });
async function prepare(id, extra = {}) {
    const url = origin + '/paid', body = { id };
    const response = await fetch(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...(extra.tenant ? { 'x-tenant': extra.tenant } : {}) } });
    assert.equal(response.status, 402);
    await response.text();
    const payment = await client.createPayment(response.headers.get('payment-required'), { url, method: 'POST', body, paymentIdentifier: `standard_external_${id}`, ...(extra.tenant ? { trustedSecurityContext: { principal: 'payer', tenant: extra.tenant, authorizationScopes: ['read'] } } : {}) });
    return { url, body, payment, tenant: extra.tenant };
}
async function send(attempt, { payload = attempt.payment.paymentPayload, url = attempt.url, body = attempt.body, tenant = attempt.tenant, signal } = {}) {
    const response = await fetch(url, { method: 'POST', body: JSON.stringify(body), signal, headers: { 'content-type': 'application/json', 'payment-signature': Buffer.from(JSON.stringify(payload)).toString('base64'), ...(tenant ? { 'x-tenant': tenant } : {}) } });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: Object.fromEntries(response.headers) };
}
async function test(name, fn) { const before = { ...counts }; await fn(); cases.push({ name, passed: true, delta: Object.fromEntries(Object.keys(counts).map(k => [k, counts[k] - before[k]])) }); }
try {
    await test('fixed seed 0x402 bounded concurrency duplicate stress', async () => {
        let seed = 0x402;
        for (let n = 0; n < 80; n++) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            const attempt = await prepare(`stress_${n}_${seed}`);
            const before = counts.handler, sendsBefore = counts.broadcasts;
            const [first, ...duplicates] = await Promise.all(Array.from({ length: 6 }, () => send(attempt)));
            assert.equal(first.status, 200);
            assert.equal(first.body.id, attempt.body.id);
            for (const result of duplicates) {
                assert.equal(result.status, 200);
                assert.deepEqual(result.body, first.body);
                assert.equal(decodePaymentResponseHeader(result.headers['payment-response']).success, true);
            }
            assert.equal(counts.handler - before, 1);
            assert.equal(counts.broadcasts - sendsBefore, 0);
        }
    });
    await test('URL body method and tenant bindings reject changed requests', async () => {
        const attempt = await prepare('binding', { tenant: 'A' });
        const before = counts.handler;
        for (const change of [{ body: { id: 'changed' } }, { url: attempt.url + '?different=1' }, { tenant: 'B' }])
            assert.equal((await send(attempt, change)).status, 402);
        const get = await fetch(attempt.url, { headers: { 'payment-signature': encodePaymentSignatureHeader(attempt.payment.paymentPayload), 'x-tenant': 'A' } });
        assert.equal(get.status, 402);
        await get.text();
        assert.equal(counts.handler, before);
        assert.equal((await send(attempt)).status, 200);
    });
    await test('invalid expiry digest network profile and output rejected before callback', async () => {
        const attempt = await prepare('invalid'), before = counts.handler;
        for (const mutate of [p => p.payload.authorization.expiresAt = '2000-01-01T00:00:00.000Z', p => p.payload.authorization.digest = '00'.repeat(32), p => p.accepted.network = 'kaspa:mainnet', p => p.payload.profile = 'additive', p => p.payload.paymentOutputIndex = 99]) {
            const payload = structuredClone(attempt.payment.paymentPayload);
            mutate(payload);
            assert.equal((await send(attempt, { payload })).status, 402);
        }
        assert.equal(counts.handler, before);
    });
    await test('lost response replay retains original callback result', async () => {
        const attempt = await prepare('lost'), before = counts.handler;
        await assert.rejects(() => fetch(attempt.url, { method: 'POST', body: JSON.stringify(attempt.body), headers: { 'payment-signature': encodePaymentSignatureHeader(attempt.payment.paymentPayload), 'x-drop-response': '1' } }));
        const recovered = await send(attempt);
        assert.equal(recovered.status, 200);
        assert.equal(recovered.body.id, attempt.body.id);
        assert.equal(counts.handler - before, 1);
    });
    await test('malformed headers and oversized headers/parsed body reject before callback', async () => {
        const before = counts.handler;
        for (const value of ['not-base64', 'a'.repeat(180000)]) {
            const r = await fetch(origin + '/paid', { headers: { 'payment-signature': value } });
            assert.ok([400, 402].includes(r.status));
            await r.text();
        }
        const largeBody = await fetch(origin + '/paid', { method: 'POST', body: JSON.stringify({ id: 'x'.repeat(150000) }) });
        assert.equal(largeBody.status, 400);
        await largeBody.text();
        assert.equal(counts.handler, before);
    });
    await test('rejected and unknown settlement never runs callback or rebroadcasts', async () => {
        for (const outcome of ['unknown', 'rejected']) {
            const attempt = await prepare('settlement_' + outcome), before = counts.handler;
            const store = new MemoryServerChannelStore();
            let sends = 0;
            activeServer = new DirectModeServer({ network: 'kaspa:testnet-10', payTo: PAYOUT_ADDRESS, amount: '100000', store, confirmationThreshold: 30, addressCodec: env.addressCodec, chainProvider: { async sendTransaction() { sends++; throw Error('controlled lost settlement response'); } }, exactTransactionVerifier: { verifyExactPayment(request) { return { transactionId: attempt.payment.transactionId, paymentOutput: { amount: request.amount, scriptPublicKey: request.payToScriptPublicKey }, requestAuthorization: { authorizationId: exactRequestAuthorizationId(request.authorization), digest: request.authorization.digest, inputIndex: 0, publicKey: '22'.repeat(32) } }; } }, exactSettlementReconciler: { reconcileExactSettlement(a) { return { status: outcome, transactionId: a.transactionId, reason: 'controlled fixture' }; } } });
            const first = await send(attempt), second = await send(attempt);
            assert.notEqual(first.status, 200);
            assert.notEqual(second.status, 200);
            assert.equal(counts.handler, before);
            assert.equal(sends, 1);
            results.push({ settlement: outcome, statuses: [first.status, second.status], sends });
            activeServer = env.server;
        }
    });
}
finally {
    host.closeAllConnections();
    await new Promise(r => host.close(r));
    const manifest = JSON.parse(await fs.readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
    const report = { profile: 'standard-native', started: new Date(started).toISOString(), durationMs: Date.now() - started, cases, counts, results, archiveManifest: manifest, limits: ['Controlled mock chain and verifier facts: transport/state tests do not validate signatures, consensus or live chain.', 'Memory store and one process only; no production throughput or persistence/restart claim.', 'Lost response test destroys the server socket after SDK completion; arbitrary settlement-time failures remain controlled adapter cases.'], command: 'node standard/proof.mjs' };
    report.inputHashes = { harness: crypto.createHash('sha256').update(await fs.readFile(new URL('./proof.mjs', import.meta.url))).digest('hex'), fixture: crypto.createHash('sha256').update(await fs.readFile(new URL('../fixtures/mock-testnet.mjs', import.meta.url))).digest('hex') };
    await fs.writeFile(new URL('./report.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ cases: cases.length, counts, results }));
}
