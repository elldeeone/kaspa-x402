import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { schnorr } from '@noble/curves/secp256k1.js';
import { VerifiedExactTransactionVerifier, NativeAddressCodec, ScriptAddressBook } from '@kaspa-x402/adapters';
import { addressForScriptPublicKey } from '@kaspa-x402/adapters/native';
import { DirectModeServer, MemoryServerChannelStore, handlePaidMcpToolCall } from '@kaspa-x402/server';
import { exactRequestAuthorizationDigest, sha256Hex, stableStringify, paymentIdentifierExtension, decodePaymentRequiredHeader, encodePaymentSignatureHeader, readMcpPaymentRequired, readMcpPaymentResponse, mcpToolCallFingerprint, withMcpPaymentPayload } from '@kaspa-x402/core';
const vector = JSON.parse(await fs.readFile(new URL('../fixtures/vectors/exact/consensus-profiles.json', import.meta.url))).expected.standardNative;
const tx = { id: vector.transactionId, ...vector.transaction, inputs: vector.transaction.inputs.map(({ computeBudget, previousOutpoint, ...x }) => ({ ...x, previousOutpoint: { transactionId: previousOutpoint.txid, index: previousOutpoint.index } })), outputs: vector.transaction.outputs.map(({ amount, ...x }) => ({ ...x, value: amount })) };
const payTo = addressForScriptPublicKey(tx.outputs[0].scriptPublicKey, 'kaspa:testnet-10');
const control = { mode: 'accepted', originMismatch: false, delay: false }, counts = { handler: 0, mcpHandler: 0, httpRequests: 0, chainReads: 0, verifier: 0, broadcasts: 0 }, cases = [];
const chain = { network: 'kaspa:testnet-10', async getTransaction(id) {
        counts.chainReads++;
        if (id === tx.id)
            return { transaction_id: tx.id, is_accepted: true, version: tx.version, inputs: tx.inputs.map(x => ({ previous_outpoint_hash: x.previousOutpoint.transactionId, previous_outpoint_index: x.previousOutpoint.index, signature_script: x.signatureScript, sequence: x.sequence, sig_op_count: x.sigOpCount })), outputs: tx.outputs.map((x, index) => ({ index, amount: x.value, script_public_key: x.scriptPublicKey.slice(4) })) };
        const input = vector.transaction.inputs.find(x => x.previousOutpoint.txid === id);
        assert.ok(input, 'unexpected controlled chain read');
        return { transaction_id: id, is_accepted: true, outputs: [{ index: input.previousOutpoint.index, amount: control.originMismatch ? '1' : input.utxo.amount, script_public_key: input.utxo.scriptPublicKey.slice(4) }] };
    } };
const verifier = new VerifiedExactTransactionVerifier(chain);
function server(options = {}) { return new DirectModeServer({ network: 'kaspa:testnet-10', payTo, amount: vector.amount, store: new MemoryServerChannelStore(), confirmationThreshold: 30, addressCodec: new NativeAddressCodec(new ScriptAddressBook()), chainProvider: { async sendTransaction() { counts.broadcasts++; throw Error('no broadcasts allowed'); } }, exactTransactionVerifier: { async verifyExactPayment(request) { counts.verifier++; if (control.delay)
            await new Promise((resolve, reject) => { request.signal.addEventListener('abort', () => reject(Error('controlled adapter cancellation')), { once: true }); }); return verifier.verifyExactPayment(request); } }, publicBoundaryPolicy: { callerQuota: 1000, maxGlobalConcurrency: 16, maxCallerConcurrency: 16, adapterTimeoutMs: 60 }, ...options }); }
let active = server(), origin;
const host = http.createServer(async (req, res) => { counts.httpRequests++; const chunks = []; for await (const c of req)
    chunks.push(c); const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined; const transportAbort = new AbortController(); res.once('close', () => { if (!res.writableEnded)
    transportAbort.abort(); }); const out = await active.handlePaidRequest({ signal: transportAbort.signal, routeAccess: 'public', admissionKey: 'ab'.repeat(32), method: req.method, url: origin + req.url, headers: req.headers, body, paymentScheme: 'exact' }, () => { counts.handler++; return { body: { secret: 'crypto-paid', calls: counts.handler } }; }); res.writeHead(out.status, out.headers); res.end(JSON.stringify(out.body)); });
await new Promise(r => host.listen(0, '127.0.0.1', r));
origin = `http://127.0.0.1:${host.address().port}`;
function payload(accepted, requestHash, id) { const expiresAt = new Date(Date.now() + 30000).toISOString(); const digest = exactRequestAuthorizationDigest({ network: accepted.network, profile: 'standard-native', transactionId: tx.id, paymentOutputIndex: 0, amount: accepted.amount, payTo: accepted.payTo, payToScriptPublicKey: accepted.extra.payToScriptPublicKey, paymentRequirementsHash: sha256Hex(stableStringify(accepted)), requestHash, paymentIdentifier: id, inputIndex: 0, expiresAt }); return { x402Version: 2, accepted, payload: { type: 'exact-transaction', profile: 'standard-native', transaction: JSON.stringify(tx), transactionEncoding: 'kaspa-sdk-safe-json-v2.0.0', paymentOutputIndex: 0, requestHash, authorization: { version: 'kaspa-x402-exact-request-authorization-v2', inputIndex: 0, expiresAt, digest, signature: Buffer.from(schnorr.sign(Buffer.from(digest, 'hex'), new Uint8Array(32).fill(7), new Uint8Array(32))).toString('hex') } }, extensions: { 'payment-identifier': paymentIdentifierExtension({ required: true, id }) } }; }
async function prepare(id) { const url = origin + '/crypto', body = { id }; const response = await fetch(url, { method: 'POST', body: JSON.stringify(body) }); const challengeBody = await response.text(); assert.equal(response.status, 402, challengeBody); const required = decodePaymentRequiredHeader(response.headers.get('payment-required')); const accepted = required.accepts[0]; const requestHash = sha256Hex(stableStringify({ method: 'POST', url, body, paymentRequirementsHash: sha256Hex(stableStringify(accepted)) })); return { url, body, payment: payload(accepted, requestHash, 'crypto_standard_' + id) }; }
async function send(a, p = a.payment) { const r = await fetch(a.url, { method: 'POST', body: JSON.stringify(a.body), headers: { 'payment-signature': Buffer.from(JSON.stringify(p)).toString('base64') } }); const text = await r.text(); return { status: r.status, body: text ? JSON.parse(text) : null }; }
async function test(name, fn) { const before = { ...counts }; await fn(); cases.push({ name, passed: true, delta: Object.fromEntries(Object.keys(counts).map(k => [k, counts[k] - before[k]])) }); }
try {
    await test('real Schnorr transaction and request auth validation rejects corrupt signatures and origin facts', async () => {
        const a = await prepare('valid');
        const invalid = structuredClone(a.payment);
        invalid.payload.authorization.signature = '00'.repeat(64);
        assert.equal((await send(a, invalid)).status, 402);
        const corrupted = structuredClone(a.payment);
        const artifact = JSON.parse(corrupted.payload.transaction);
        artifact.inputs[0].signatureScript = '00' + artifact.inputs[0].signatureScript.slice(2);
        corrupted.payload.transaction = JSON.stringify(artifact);
        assert.equal((await send(a, corrupted)).status, 402);
        control.originMismatch = true;
        assert.equal((await send(a)).status, 402);
        control.originMismatch = false;
        assert.equal(counts.handler, 0);
        const good = await send(a);
        assert.equal(good.status, 200);
        assert.equal(counts.handler, 1);
        const duplicate = await send(a);
        assert.deepEqual(duplicate, good);
        assert.equal(counts.handler, 1);
        assert.equal(counts.broadcasts, 0);
    });
    await test('adapter deadline and concurrency admission bound pending verification; same signed artifact recovers', async () => {
        active = server({ publicBoundaryPolicy: { callerQuota: 1000, maxGlobalConcurrency: 1, maxCallerConcurrency: 1, maxChannelConcurrency: 1, maxAdapterConcurrency: 1, adapterTimeoutMs: 60 } });
        const a = await prepare('deadline');
        control.delay = true;
        const started = Date.now();
        const before = counts.verifier;
        const pending = send(a);
        while (counts.verifier === before)
            await new Promise(r => setTimeout(r, 1));
        assert.equal((await send(a)).status, 429);
        const failed = await pending;
        const elapsed = Date.now() - started;
        assert.equal(failed.status, 504);
        assert.ok(elapsed < 1500);
        assert.equal(counts.handler, 1);
        control.delay = false;
        assert.equal((await send(a)).status, 200);
        assert.equal(counts.handler, 2);
    });
    await test('real HTTP caller abort cancels pending verifier with no callback and allows retry', async () => {
        active = server();
        const a = await prepare('caller_abort');
        control.delay = true;
        const before = counts.handler, verifications = counts.verifier, cancel = new AbortController();
        const pending = fetch(a.url, { method: 'POST', body: JSON.stringify(a.body), headers: { 'payment-signature': encodePaymentSignatureHeader(a.payment) }, signal: cancel.signal });
        while (counts.verifier === verifications)
            await new Promise(r => setTimeout(r, 1));
        cancel.abort();
        await assert.rejects(() => pending);
        await new Promise(r => setTimeout(r, 30));
        assert.equal(counts.handler, before);
        control.delay = false;
        assert.equal((await send(a)).status, 200);
        assert.equal(counts.handler, before + 1);
    });
    await test('MCP tool arguments and audience bind real Schnorr authorization and cached result', async () => {
        const s = server(), params = { name: 'quote', arguments: { symbol: 'KAS', quantity: 3 } }, options = { routeAccess: 'public', scheme: 'exact', audience: 'https://mcp.example.test', name: 'quote' };
        const handler = () => { counts.mcpHandler++; return { result: { content: [{ type: 'text', text: 'paid quote' }] } }; };
        const challenge = await handlePaidMcpToolCall(s, options, params, handler), required = readMcpPaymentRequired(challenge);
        assert.ok(required);
        const accepted = required.accepts[0];
        const requestHash = mcpToolCallFingerprint({ audience: options.audience, toolName: params.name, arguments: params.arguments, accepted, resource: required.resource });
        const p = payload(accepted, requestHash, 'crypto_mcp_standard_1'), paidParams = withMcpPaymentPayload(params, p);
        const changed = await handlePaidMcpToolCall(s, options, { ...paidParams, arguments: { quantity: 999 } }, handler);
        assert.ok(readMcpPaymentRequired(changed));
        assert.equal(counts.mcpHandler, 0);
        const audience = await handlePaidMcpToolCall(s, { ...options, audience: 'https://other.example.test' }, paidParams, handler);
        assert.ok(readMcpPaymentRequired(audience));
        assert.equal(counts.mcpHandler, 0);
        const good = await handlePaidMcpToolCall(s, options, paidParams, handler);
        assert.equal(good.isError, undefined);
        assert.equal(readMcpPaymentResponse(good).success, true);
        assert.equal(counts.mcpHandler, 1);
        const duplicate = await handlePaidMcpToolCall(s, options, paidParams, handler);
        assert.deepEqual(duplicate, good);
        assert.equal(counts.mcpHandler, 1);
    });
}
finally {
    host.closeAllConnections();
    await new Promise(r => host.close(r));
    const report = { cases, counts, transactionId: tx.id, vectorSha256: sha256Hex(await fs.readFile(new URL('../fixtures/vectors/exact/consensus-profiles.json', import.meta.url))), limits: ['Actual native transaction and request authorization Schnorr verification using private source-support @kaspa-x402/adapters archive.', 'Chain accepted status, transaction origin and UTXO facts are controlled fixture observations, not independent or live consensus evidence.', 'MCP SDK call surface is invoked directly; HTTP is real loopback.', 'Only public installed archive imports; no repository runtime imports.'], archiveManifest: JSON.parse(await fs.readFile(new URL('../manifest.json', import.meta.url), 'utf8')), harnessSha256: sha256Hex(await fs.readFile(new URL('./crypto-mcp.mjs', import.meta.url))), command: 'node standard/crypto-mcp.mjs' };
    await fs.writeFile(new URL('./crypto-mcp-report.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ cases: cases.length, counts }));
}
