import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { DirectModeClient, MemoryChannelStore, paidMcpToolCall } from '@kaspa-x402/client';
import { schnorr } from '@noble/curves/secp256k1.js';
import { VerifiedExactTransactionVerifier, NativeAddressCodec, ScriptAddressBook } from '@kaspa-x402/adapters';
import { addressForScriptPublicKey } from '@kaspa-x402/adapters/native';
import { DirectModeServer, MemoryServerChannelStore, handlePaidMcpToolCall } from '@kaspa-x402/server';
import { exactRequestAuthorizationDigest, sha256Hex, stableStringify, paymentIdentifierExtension, encodePaymentRequiredHeader, decodePaymentRequiredHeader, encodePaymentSignatureHeader, readMcpPaymentRequired, readMcpPaymentResponse, mcpToolCallFingerprint, withMcpPaymentPayload } from '@kaspa-x402/core';
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
let active = server(), origin, nextId = 0;
const envelopes = [], bindingRejections = [], providerAttempts = new Map();
const host = http.createServer(async (req, res) => {
    counts.httpRequests++;
    try {
        assert.equal(req.method, 'POST');
        const chunks = [];
        for await (const c of req)
            chunks.push(c);
        const message = JSON.parse(Buffer.concat(chunks).toString());
        assert.equal(message.jsonrpc, '2.0');
        assert.equal(message.method, 'tools/call');
        assert.ok(Number.isSafeInteger(message.id));
        const result = await handlePaidMcpToolCall(active, { routeAccess: 'public', scheme: 'exact', audience: origin + req.url, name: 'quote' }, message.params, () => { counts.mcpHandler++; return { result: { content: [{ type: 'text', text: 'paid KAS quote' }] } }; });
        envelopes.push({ id: message.id, requestPayment: !!message.params._meta, responseRequired: !!readMcpPaymentRequired(result), responsePaid: !!readMcpPaymentResponse(result) });
        if (req.headers['x-drop-response'] === '1') {
            res.destroy();
            return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    }
    catch (error) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: String(error) }));
    }
});
await new Promise(r => host.listen(0, '127.0.0.1', r));
origin = `http://127.0.0.1:${host.address().port}`;
const audience = origin + '/mcp';
async function rpc(params, { path = '/mcp', drop = false } = {}) {
    const id = ++nextId;
    const r = await fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(drop ? { 'x-drop-response': '1' } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params }) });
    assert.equal(r.status, 200);
    const envelope = await r.json();
    assert.equal(envelope.jsonrpc, '2.0');
    assert.equal(envelope.id, id);
    assert.ok(envelope.result);
    return envelope.result;
}
const provider = { networkId: 'kaspa:testnet-10', sourceKind: 'hot-wallet', async getPublicIdentity() { return { address: addressForScriptPublicKey(vector.transaction.inputs[0].utxo.scriptPublicKey, 'kaspa:testnet-10'), publicKey: Buffer.from(schnorr.getPublicKey(new Uint8Array(32).fill(7))).toString('hex') }; }, async payExactTransaction(request) {
        const previous = providerAttempts.get(request.attemptId);
        if (previous) {
            assert.equal(previous.intentHash, request.intentHash);
            return structuredClone(previous.result);
        }
        const digest = exactRequestAuthorizationDigest({ network: request.network, profile: 'standard-native', transactionId: tx.id, paymentOutputIndex: 0, amount: request.amount, payTo: request.payTo, payToScriptPublicKey: request.payToScriptPublicKey, paymentRequirementsHash: request.paymentRequirementsHash, requestHash: request.requestHash, paymentIdentifier: request.paymentIdentifier, inputIndex: 0, expiresAt: request.authorizationExpiresAt });
        const result = { transaction: JSON.stringify(tx), transactionEncoding: 'kaspa-sdk-safe-json-v2.0.0', transactionId: tx.id, paymentOutputIndex: 0, inputOutpoints: vector.transaction.inputs.map(x => x.previousOutpoint), authorization: { version: 'kaspa-x402-exact-request-authorization-v2', inputIndex: 0, expiresAt: request.authorizationExpiresAt, digest, signature: Buffer.from(schnorr.sign(Buffer.from(digest, 'hex'), new Uint8Array(32).fill(7), new Uint8Array(32))).toString('hex') }, fundingSource: 'hot-wallet' };
        providerAttempts.set(request.attemptId, { intentHash: request.intentHash, result: structuredClone(result) });
        return result;
    }, async finalizeExactPaymentAttempt() { }, async sendTransaction() { throw Error('no broadcasting allowed'); } };
function client() { return new DirectModeClient({ addressCodec: new NativeAddressCodec(new ScriptAddressBook()), confirmationThreshold: 30, fundingProvider: provider, store: new MemoryChannelStore(), fundingPolicy: { requiredSource: 'hot-wallet', allowedMcpAudiences: [audience], allowedExactProfiles: ['standard-native'], allowedPayTo: [payTo], maximumExactAmountSompi: vector.amount } }); }
async function test(name, fn) { const before = { ...counts }; await fn(); cases.push({ name, passed: true, delta: Object.fromEntries(Object.keys(counts).map(k => [k, counts[k] - before[k]])) }); }
let paid;
const params = { name: 'quote', arguments: { symbol: 'KAS', quantity: 3 } };
try {
    await test('public paidMcpToolCall client challenge payment and settlement over real HTTP JSON-RPC', async () => {
        paid = await paidMcpToolCall(client(), rpc, params, { audience, paymentIdentifier: 'mcp_http_signed_standard_1' });
        assert.equal(paid.result.content[0].text, 'paid KAS quote');
        assert.equal(paid.settlement.response.success, true);
        assert.equal(paid.settlement.chargedAmount, vector.amount);
        assert.equal(readMcpPaymentResponse(paid.result).success, true);
        assert.equal(counts.mcpHandler, 1);
        assert.equal(providerAttempts.size, 1);
        assert.equal(counts.broadcasts, 0);
        assert.ok(envelopes[0].responseRequired);
        assert.ok(envelopes[1].responsePaid);
    });
    await test('serialized paid retries preserve one handler and args/audience binding', async () => {
        const paidParams = withMcpPaymentPayload(params, paid.payment.paymentPayload);
        for (let i = 0; i < 3; i++)
            assert.deepEqual(await rpc(paidParams), paid.result);
        assert.equal(counts.mcpHandler, 1);
        const args = await rpc({ ...paidParams, arguments: { symbol: 'KAS', quantity: 99 } });
        assert.equal(args.isError, true, JSON.stringify(args));
        assert.notEqual(readMcpPaymentResponse(args)?.success, true);
        bindingRejections.push({ kind: 'changed_arguments', result: args });
        const other = await rpc(paidParams, { path: '/other-audience' });
        assert.equal(other.isError, true, JSON.stringify(other));
        assert.notEqual(readMcpPaymentResponse(other)?.success, true);
        bindingRejections.push({ kind: 'changed_audience', result: other });
        assert.equal(counts.mcpHandler, 1);
    });
    await test('lost first paid HTTP response replays same signed MCP result once', async () => {
        active = server();
        const payer = client();
        const required = readMcpPaymentRequired(await rpc(params));
        assert.ok(required);
        const accepted = required.accepts[0];
        const requestHash = mcpToolCallFingerprint({ audience, toolName: params.name, arguments: params.arguments, accepted, resource: required.resource });
        const payment = await payer.createMcpPayment(encodePaymentRequiredHeader(required), { url: required.resource.url, audience, requestHash, paymentIdentifier: 'mcp_http_signed_standard_lost' });
        const paidParams = withMcpPaymentPayload(params, payment.paymentPayload);
        await assert.rejects(() => rpc(paidParams, { drop: true }));
        assert.equal(counts.mcpHandler, 2);
        const recovered = await rpc(paidParams);
        assert.equal(readMcpPaymentResponse(recovered).success, true);
        assert.equal(counts.mcpHandler, 2);
        const settlement = await payer.applySettlement(payment, readMcpPaymentResponse(recovered));
        assert.equal(settlement.response.success, true);
        assert.equal(settlement.chargedAmount, vector.amount);
        assert.equal(counts.broadcasts, 0);
    });
}
finally {
    host.closeAllConnections();
    await new Promise(r => host.close(r));
    const report = { cases, counts, envelopes, bindingRejections, providerSignedAttempts: providerAttempts.size, transactionId: tx.id, harnessSha256: sha256Hex(await fs.readFile(new URL('./mcp-http.mjs', import.meta.url))), vectorSha256: sha256Hex(await fs.readFile(new URL('../fixtures/vectors/exact/consensus-profiles.json', import.meta.url))), archiveManifest: JSON.parse(await fs.readFile(new URL('../manifest.json', import.meta.url), 'utf8')), limits: ['Real loopback HTTP POST carrying serialized JSON-RPC tools/call envelopes; this is a narrow carrier, not full MCP Streamable HTTP interoperability certification.', 'Actual native funding and request Schnorr signature validation via explicitly installed private adapters source-support archive.', 'Accepted chain/origin observations are controlled fixtures; no live chain, funded transaction or broadcast.', 'Single process memory stores; no restart durability or production throughput claim.'], command: 'node standard/mcp-http.mjs' };
    await fs.writeFile(new URL('./mcp-http-report.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ cases: cases.length, counts, signedAttempts: providerAttempts.size }));
}
