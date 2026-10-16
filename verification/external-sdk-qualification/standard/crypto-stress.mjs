import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { schnorr } from '@noble/curves/secp256k1.js';
import { exactV0SchnorrSignatureEvidence, exactV0TransactionId } from '@kaspa-x402/covenant';
import { exactRequestAuthorizationDigest, sha256Hex, stableStringify, paymentIdentifierExtension, decodePaymentRequiredHeader, encodePaymentSignatureHeader, decodePaymentResponseHeader } from '@kaspa-x402/core';
import { DirectModeServer, MemoryServerChannelStore } from '@kaspa-x402/server';
import { VerifiedExactTransactionVerifier, NativeAddressCodec, ScriptAddressBook } from '@kaspa-x402/adapters';
import { addressForScriptPublicKey } from '@kaspa-x402/adapters/native';
const started = Date.now(), seed = 'standard-native-crypto-stress-0x402', paymentCount = 100, concurrency = 4;
const vector = JSON.parse(await fs.readFile(new URL('../fixtures/vectors/exact/consensus-profiles.json', import.meta.url))).expected.standardNative;
const privateKey = new Uint8Array(32).fill(7), merchantScript = vector.transaction.outputs[0].scriptPublicKey, payTo = addressForScriptPublicKey(merchantScript, 'kaspa:testnet-10');
const candidates = new Map(), origins = new Map(), handlerLedger = new Map(), verifierLedger = new Set(), responseLedger = [];
const counts = { httpRequests: 0, handlerExecutions: 0, verifications: 0, chainReads: 0, signaturesCreated: 0, broadcasts: 0 };
let activeWorkers = 0, peakWorkers = 0, origin;
for (let index = 0; index < paymentCount; index++) {
    const reference = structuredClone(vector.transaction);
    for (let inputIndex = 0; inputIndex < reference.inputs.length; inputIndex++) {
        const input = reference.inputs[inputIndex];
        input.previousOutpoint.txid = sha256Hex(`${seed}:funding:${index}:${inputIndex}`);
        const digest = exactV0SchnorrSignatureEvidence(reference, inputIndex).digest;
        input.signatureScript = '41' + Buffer.from(schnorr.sign(Buffer.from(digest, 'hex'), privateKey, new Uint8Array(32))).toString('hex') + '01';
        counts.signaturesCreated++;
        const evidence = exactV0SchnorrSignatureEvidence(reference, inputIndex);
        assert.ok(schnorr.verify(Buffer.from(evidence.signature, 'hex'), Buffer.from(evidence.digest, 'hex'), Buffer.from(evidence.publicKey, 'hex')));
        origins.set(input.previousOutpoint.txid, { transaction_id: input.previousOutpoint.txid, is_accepted: true, outputs: [{ index: input.previousOutpoint.index, amount: input.utxo.amount, script_public_key: input.utxo.scriptPublicKey.slice(4) }] });
    }
    const transactionId = exactV0TransactionId(reference);
    const artifact = { id: transactionId, ...reference, inputs: reference.inputs.map(({ computeBudget, previousOutpoint, ...x }) => ({ ...x, previousOutpoint: { transactionId: previousOutpoint.txid, index: previousOutpoint.index } })), outputs: reference.outputs.map(({ amount, ...x }) => ({ ...x, value: amount })) };
    const merchantOutputs = artifact.outputs.filter(x => x.scriptPublicKey === merchantScript);
    assert.equal(merchantOutputs.length, 1);
    assert.equal(merchantOutputs[0].value, vector.amount);
    assert.ok(!candidates.has(transactionId));
    candidates.set(transactionId, { index, artifact, payout: BigInt(merchantOutputs[0].value) });
}
assert.equal(candidates.size, paymentCount);
const chain = { network: 'kaspa:testnet-10', async getTransaction(id) { counts.chainReads++; if (origins.has(id))
        return structuredClone(origins.get(id)); const record = candidates.get(id); assert.ok(record, 'unrecognized controlled candidate read'); const a = record.artifact; return { transaction_id: a.id, is_accepted: true, version: a.version, inputs: a.inputs.map(x => ({ previous_outpoint_hash: x.previousOutpoint.transactionId, previous_outpoint_index: x.previousOutpoint.index, signature_script: x.signatureScript, sequence: x.sequence, sig_op_count: x.sigOpCount })), outputs: a.outputs.map((x, index) => ({ index, amount: x.value, script_public_key: x.scriptPublicKey.slice(4) })) }; } };
const nativeVerifier = new VerifiedExactTransactionVerifier(chain);
const server = new DirectModeServer({ network: 'kaspa:testnet-10', payTo, amount: vector.amount, confirmationThreshold: 30, store: new MemoryServerChannelStore(), addressCodec: new NativeAddressCodec(new ScriptAddressBook()), chainProvider: { async sendTransaction() { counts.broadcasts++; throw Error('broadcast prohibited'); } }, exactTransactionVerifier: { async verifyExactPayment(request) { counts.verifications++; const verified = await nativeVerifier.verifyExactPayment(request); assert.ok(candidates.has(verified.transactionId)); verifierLedger.add(verified.transactionId); return verified; } }, publicBoundaryPolicy: { callerQuota: 1000, maxGlobalConcurrency: 16, maxCallerConcurrency: 16, adapterTimeoutMs: 5000 } });
const host = http.createServer(async (req, res) => { counts.httpRequests++; try {
    const chunks = [];
    for await (const c of req)
        chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const out = await server.handlePaidRequest({ routeAccess: 'public', admissionKey: 'ab'.repeat(32), method: req.method, url: origin + req.url, headers: req.headers, body, paymentScheme: 'exact' }, ({ payment }) => { counts.handlerExecutions++; const transactionId = payment.transactionId; const candidate = candidates.get(transactionId); assert.ok(candidate); assert.ok(!handlerLedger.has(transactionId), 'duplicate protected execution'); assert.equal(candidate.index, body.index); handlerLedger.set(transactionId, { index: candidate.index, payoutSompi: candidate.payout.toString() }); return { body: { index: body.index, transactionId, paid: true } }; });
    res.writeHead(out.status, out.headers);
    res.end(JSON.stringify(out.body));
}
catch (error) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: String(error) }));
} });
await new Promise(r => host.listen(0, '127.0.0.1', r));
origin = `http://127.0.0.1:${host.address().port}`;
async function paidSend(attempt) { const response = await fetch(attempt.url, { method: 'POST', body: JSON.stringify(attempt.body), headers: { 'payment-signature': encodePaymentSignatureHeader(attempt.payment) } }); const text = await response.text(); assert.equal(response.status, 200, text); const result = JSON.parse(text); assert.equal(result.transactionId, attempt.artifact.id); assert.equal(result.index, attempt.index); const settlement = decodePaymentResponseHeader(response.headers.get('payment-response')); assert.equal(settlement.success, true); assert.equal(settlement.transaction, attempt.artifact.id); assert.equal(settlement.amount, vector.amount); return result; }
const attempts = [...candidates.values()].map(x => ({ ...x, body: { index: x.index }, url: origin + '/crypto-stress/' + x.index }));
const scenarios = [];
try {
    let next = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => { activeWorkers++; peakWorkers = Math.max(peakWorkers, activeWorkers); try {
        while (next < attempts.length) {
            const a = attempts[next++];
            const response = await fetch(a.url, { method: 'POST', body: JSON.stringify(a.body) });
            assert.equal(response.status, 402);
            await response.text();
            const accepted = decodePaymentRequiredHeader(response.headers.get('payment-required')).accepts[0];
            const requestHash = sha256Hex(stableStringify({ method: 'POST', url: a.url, body: a.body, paymentRequirementsHash: sha256Hex(stableStringify(accepted)) }));
            const id = `standard_crypto_stress_${a.index}`, expiresAt = new Date(Date.now() + 30000).toISOString();
            const digest = exactRequestAuthorizationDigest({ network: accepted.network, profile: 'standard-native', transactionId: a.artifact.id, paymentOutputIndex: 0, amount: accepted.amount, payTo: accepted.payTo, payToScriptPublicKey: accepted.extra.payToScriptPublicKey, paymentRequirementsHash: sha256Hex(stableStringify(accepted)), requestHash, paymentIdentifier: id, inputIndex: 0, expiresAt });
            a.payment = { x402Version: 2, accepted, payload: { type: 'exact-transaction', profile: 'standard-native', transaction: JSON.stringify(a.artifact), transactionEncoding: 'kaspa-sdk-safe-json-v2.0.0', paymentOutputIndex: 0, requestHash, authorization: { version: 'kaspa-x402-exact-request-authorization-v2', inputIndex: 0, expiresAt, digest, signature: Buffer.from(schnorr.sign(Buffer.from(digest, 'hex'), privateKey, new Uint8Array(32))).toString('hex') } }, extensions: { 'payment-identifier': paymentIdentifierExtension({ required: true, id }) } };
            counts.signaturesCreated++;
            responseLedger.push(await paidSend(a));
        }
    }
    finally {
        activeWorkers--;
    } }));
    assert.equal(counts.handlerExecutions, paymentCount);
    assert.equal(handlerLedger.size, paymentCount);
    assert.equal(verifierLedger.size, paymentCount);
    assert.equal(new Set(responseLedger.map(x => x.transactionId)).size, paymentCount);
    scenarios.push({ name: '100 unique freshly signed native transactions through real HTTP and genuine verifier', passed: true });
    const before = counts.handlerExecutions;
    for (let offset = 0; offset < 20; offset += concurrency)
        await Promise.all(attempts.filter(x => x.index % 5 === 0).slice(offset, offset + concurrency).map(a => paidSend(a)));
    assert.equal(counts.handlerExecutions, before);
    assert.equal(handlerLedger.size, paymentCount);
    scenarios.push({ name: '20 deterministic duplicate paid HTTP requests retain exactly 100 callback executions', passed: true });
    const artifactPayout = [...candidates.values()].reduce((sum, x) => sum + x.payout, 0n), handlerPayout = [...handlerLedger.values()].reduce((sum, x) => sum + BigInt(x.payoutSompi), 0n), expected = BigInt(vector.amount) * BigInt(paymentCount);
    assert.equal(artifactPayout, expected);
    assert.equal(handlerPayout, expected);
    assert.equal(counts.broadcasts, 0);
    assert.equal(counts.signaturesCreated, paymentCount * 2);
    scenarios.push({ name: 'independent artifact and handler merchant payout sums equal exact expected total', passed: true });
}
finally {
    host.closeAllConnections();
    await new Promise(r => host.close(r));
    const report = { scenarios, seed, paymentCount, concurrency, peakWorkers, durationMs: Date.now() - started, counts, uniqueTransactionIds: candidates.size, verifiedUniqueTransactionIds: verifierLedger.size, handlerUniqueTransactionIds: handlerLedger.size, expectedPayoutSompi: (BigInt(vector.amount) * BigInt(paymentCount)).toString(), artifactPayoutSompi: [...candidates.values()].reduce((sum, x) => sum + x.payout, 0n).toString(), handlerPayoutSompi: [...handlerLedger.values()].reduce((sum, x) => sum + BigInt(x.payoutSompi), 0n).toString(), signedPayments: attempts.map(a => ({ index: a.index, paymentPayload: a.payment })), ledger: [...handlerLedger.entries()].map(([transactionId, x]) => ({ transactionId, ...x })), harnessSha256: sha256Hex(await fs.readFile(new URL('./crypto-stress.mjs', import.meta.url))), vectorSha256: sha256Hex(await fs.readFile(new URL('../fixtures/vectors/exact/consensus-profiles.json', import.meta.url))), archiveManifest: JSON.parse(await fs.readFile(new URL('../manifest.json', import.meta.url), 'utf8')), limits: ['100 unique funding outpoints/transaction IDs with actual fresh funding and request Schnorr signatures, checked by installed private support VerifiedExactTransactionVerifier.', 'Chain accepted status/origin records are controlled fixtures; no live network observation, broadcast, funding or new consensus cross-validation.', 'Bounded four-worker loopback behavior qualification, not production throughput or persistence/restart proof.', 'Standard-native version0 public helpers used because the installed verifier enforces version0.'], command: 'node standard/crypto-stress.mjs' };
    await fs.writeFile(new URL('./crypto-stress-report.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ scenarios: scenarios.length, counts, unique: candidates.size, handlerPayoutSompi: report.handlerPayoutSompi }));
}
