import { readFileSync as qualificationReadFileSync } from "node:fs";
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { schnorr } from '@noble/curves/secp256k1.js';
import { DirectModeServer, MemoryServerChannelStore, MemoryChannelLockManager, HashChainExactTransactionVerifier, handleHashChainGrantClaimHttp } from '@kaspa-x402/server';
import { HashChainGrantIssuer, hashChainGrantClaimDigest } from '@kaspa-x402/server/hash-chain-grants';
import { signHashChainExactTransaction } from '@kaspa-x402/client';
import { generateHashChainBorrowGrants, hashChainHeadScriptPublicKey } from '@kaspa-x402/covenant';
import { bindRequestHashToTrustedContext, decodePaymentRequiredHeader, encodePaymentSignatureHeader, paymentIdentifierExtension, sha256Hex, stableStringify } from '@kaspa-x402/core';
if (process.argv[2] === '--inspect-db') {
    const reopened = await HashChainGrantIssuer.open({ databasePath: process.argv[3], encryptionKey: Buffer.alloc(32, 19), admissionPolicy: { maxGrantsPerClaimant: 10000, windowSeconds: 86400, resolveFundingOutpoint: async () => { throw Error('inspection never admits'); } } });
    const snapshot = reopened.getCurrent(process.argv[4]);
    const payment = reopened.getAcceptedPayment(process.argv[5]);
    reopened.close();
    console.log(JSON.stringify({ snapshot, payment }));
    process.exit(0);
}
const folder = path.dirname(fileURLToPath(import.meta.url));
const state = fs.mkdtempSync(path.join(folder, 'state-'));
const cases = [];
let protectedCalls = 0, broadcasts = 0, nonce = 1, clock = Date.now();
const id = n => n.toString(16).padStart(64, '0');
const owner = Buffer.from(schnorr.getPublicKey(Buffer.alloc(32, 3))).toString('hex');
const context = { principal: 'qualified-payer', tenant: 'qualification' };
const keys = [Buffer.alloc(32, 7), Buffer.alloc(32, 8)];
const pub = i => Buffer.from(schnorr.getPublicKey(keys[i])).toString('hex');
const script = i => `000020${pub(i)}ac`;
const origins = new Map(), selected = new Map(), currentUtxos = new Map();
const codecScripts = new Map();
let issuer, server, headId, networkError = false;
const open = () => HashChainGrantIssuer.open({ databasePath: path.join(state, 'issuer.sqlite'), encryptionKey: Buffer.alloc(32, 19), now: () => new Date(clock), admissionPolicy: { maxGrantsPerClaimant: 10000, windowSeconds: 86400, resolveFundingOutpoint: async (claim) => ({ txid: sha256Hex(claim.grantId + claim.payerPublicKey), index: 0 }) } });
const view = { network: 'kaspa:testnet-10', getAcceptedOrigins: async (points) => points.map(p => origins.get(p.txid + ':' + p.index) || null), getSelectedTransaction: async (tx) => selected.get(tx) || null };
const store = new MemoryServerChannelStore(), lockManager = new MemoryChannelLockManager();
let claimUrl;
function configure() {
    server = new DirectModeServer({ network: 'kaspa:testnet-10', payTo: 'kaspatest:merchant', amount: '20000000', confirmationThreshold: 30,
        batch: { serverPublicKey: owner, minDepositSompi: '1000', claimReserveSompi: '10', refundTimeoutDaa: '1000', minimumRefundLeadDaa: '0', voucherVerifier: { verifyVoucher: () => true }, batchPresentationVerifier: { verifyPresentation: () => true } }, store, lockManager,
        chainProvider: { getVirtualDaaScore: async () => '0', getUtxo: async () => { throw Error('unused'); }, verifyCovenantGenesis: async () => { throw Error('unused'); }, discoverCovenantLineage: async () => { throw Error('unused'); }, estimateClaimFee: async () => { throw Error('unused'); }, sendTransaction: async () => { broadcasts++; throw Error('broadcast forbidden'); } },
        addressCodec: { scriptPublicKeyForAddress: a => codecScripts.get(a) || script(0), encodeScriptAddress: ({ serializedScriptPublicKey: s }) => { const a = 'kaspatest:hash-' + sha256Hex(s).slice(0, 32); codecScripts.set(a, s); return a; } }, exactProfile: 'hash-chain-additive', exactTransactionVerifier: new HashChainExactTransactionVerifier(view), hashChainIssuer: issuer, hashChainHeadId: headId, hashChainGrantClaimUrl: claimUrl, admitHashChainChallenge: async () => true, hashChainIsSelected: async (tx) => selected.has(tx), hashChainGetCurrentUtxo: async (p) => { if (networkError)
            throw Error('controlled observer unavailable'); return currentUtxos.get(p.txid + ':' + p.index) || null; } });
}
function install(links = 8) { const chain = generateHashChainBorrowGrants(links); headId = id(nonce++); const outpoint = { txid: id(nonce++), index: 0 }; const head = { outpoint, amount: '100000000', guard: chain.initialGuard, scriptPublicKey: hashChainHeadScriptPublicKey({ ownerPublicKey: owner, guard: chain.initialGuard }), covenantId: id(nonce++) }; issuer.installHead({ headId, network: 'kaspa:testnet-10', ownerPublicKey: owner, head, grants: chain.grants }); origins.set(outpoint.txid + ':0', head); currentUtxos.set(outpoint.txid + ':0', head); configure(); return chain; }
function route(suffix) { const url = new URL(claimUrl).origin + '/hash-chain/' + suffix; return { routeAccess: 'authenticated', url, resource: { url }, paymentScheme: 'exact', trustedSecurityContext: context }; }
const handler = async () => { protectedCalls++; return { body: 'paid' }; };
async function challenge(suffix) { const r = route(suffix), unpaid = await server.handlePaidRequest(r, handler); assert.equal(unpaid.status, 402); const accepted = decodePaymentRequiredHeader(unpaid.headers['PAYMENT-REQUIRED']).accepts[0]; const requestHash = bindRequestHashToTrustedContext(sha256Hex(stableStringify({ method: 'GET', url: r.url, body: null })), context); return { r, accepted, extra: accepted.extra, requestHash }; }
function signedClaim(c, payer = 0) { const unsigned = { grantId: c.extra.grantId, challengeId: c.extra.challengeId, requestHash: c.requestHash, payerPublicKey: pub(payer), expiresAt: new Date(clock + 10000).toISOString() }; return { ...unsigned, signature: Buffer.from(schnorr.sign(hashChainGrantClaimDigest('kaspa:testnet-10', unsigned), keys[payer], Buffer.alloc(32))).toString('hex') }; }
async function claim(c, payer = 0) { const response = await fetch(claimUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signedClaim(c, payer)) }); return { status: response.status, cache: response.headers.get('cache-control'), body: await response.json() }; }
function sign(c, grant, payer = 0) { const e = c.extra; const tx = id(nonce++); origins.set(tx + ':0', { amount: '50000000', scriptPublicKey: script(payer), covenantId: null }); const request = { attemptId: id(nonce++), intentHash: id(nonce++), paymentIdentifier: 'qualification_payment_' + nonce++, network: 'kaspa:testnet-10', profile: 'hash-chain-additive', origin: new URL(claimUrl).origin, resourceUrl: c.r.url, amount: c.accepted.amount, payTo: c.accepted.payTo, payToScriptPublicKey: e.payToScriptPublicKey, paymentOutputIndex: 0, requestHash: c.requestHash, paymentRequirementsHash: sha256Hex(stableStringify(c.accepted)), authorizationExpiresAt: e.challengeExpiresAt, hashChainHead: { headId: e.headId, headVersion: e.headVersion, covenantId: e.covenantId, expectedHeadOutpoint: e.expectedHeadOutpoint, headAmount: e.headAmount, headScriptPublicKey: e.headScriptPublicKey, headRedeemScript: e.headRedeemScript, currentGuard: e.currentGuard, nextGuard: e.nextGuard, oneTimePublicKey: e.oneTimePublicKey, grantId: e.grantId, grantClaimUrl: e.grantClaimUrl, challengeId: e.challengeId, challengeExpiresAt: e.challengeExpiresAt }, grant }; const signed = signHashChainExactTransaction({ request, funding: { outpoint: { txid: tx, index: 0 }, amount: '50000000', scriptPublicKey: script(payer), privateKey: keys[payer].toString('hex'), payerAddress: 'kaspatest:payer' }, feeSompi: '300000', schnorrAuxRand: Buffer.alloc(32) }); const payment = { x402Version: 2, accepted: c.accepted, payload: { type: 'exact-transaction', profile: 'hash-chain-additive', transaction: signed.transaction, transactionEncoding: signed.transactionEncoding, paymentOutputIndex: 0, authorization: signed.authorization, grantId: e.grantId, challengeId: e.challengeId, requestHash: c.requestHash, payerAddress: 'kaspatest:payer' }, extensions: { 'payment-identifier': paymentIdentifierExtension({ required: true, id: request.paymentIdentifier }) } }; return { signed, payment, request }; }
const paid = (c, p) => server.handlePaidRequest({ ...c.r, headers: { 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(p) } }, handler);
function accept(c, s) { const a = JSON.parse(s.signed.transaction); const successor = { amount: a.outputs[0].value, scriptPublicKey: c.extra.payToScriptPublicKey, covenantId: c.extra.covenantId, authorizingInput: 0 }; selected.set(s.signed.transactionId, { transactionId: s.signed.transactionId, finality: 'accepted', spentHead: c.extra.expectedHeadOutpoint, successor }); currentUtxos.delete(c.extra.expectedHeadOutpoint.txid + ':0'); const h = { outpoint: { txid: s.signed.transactionId, index: 0 }, amount: successor.amount, scriptPublicKey: successor.scriptPublicKey, covenantId: successor.covenantId }; currentUtxos.set(s.signed.transactionId + ':0', h); origins.set(s.signed.transactionId + ':0', h); }
async function check(name, fn) { try {
    const evidence = await fn();
    cases.push({ name, passed: true, evidence });
}
catch (e) {
    cases.push({ name, passed: false, error: e.stack });
} }
const httpServer = http.createServer(async (req, res) => { try {
    const parts = [];
    for await (const b of req)
        parts.push(b);
    const request = new Request(claimUrl, { method: req.method, headers: req.headers, body: Buffer.concat(parts) });
    const r = await handleHashChainGrantClaimHttp(server, request, context);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(await r.text());
}
catch (e) {
    res.writeHead(500);
    res.end('internal');
} });
await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
claimUrl = `http://127.0.0.1:${httpServer.address().port}/grant`;
try {
    issuer = await open();
    await check('real signing and sequential exact links with controlled selected observations', async () => {
        install(8);
        const seen = new Set();
        for (let n = 0; n < 8; n++) {
            const c = await challenge('sequential-' + n), g = await claim(c);
            assert.equal(g.status, 200);
            assert.equal(g.cache, 'no-store');
            assert(!seen.has(g.body.oneTimePublicKey));
            seen.add(g.body.oneTimePublicKey);
            const before = issuer.getCurrent(headId), calls = protectedCalls;
            const s = sign(c, g.body);
            const unknown = await paid(c, s.payment);
            assert.notEqual(unknown.status, 200);
            assert.equal(protectedCalls, calls);
            accept(c, s);
            const response = await paid(c, s.payment);
            assert.equal(response.status, 200);
            assert.equal(protectedCalls, calls + 1);
            assert.equal(BigInt(issuer.getCurrent(headId).head.amount) - BigInt(before.head.amount), 20000000n);
            assert.equal(issuer.getCurrent(headId).headVersion, n + 1);
            const retry = await paid(c, s.payment);
            assert.equal(retry.status, 200);
            assert.equal(protectedCalls, calls + 1);
            if (n === 3) {
                issuer.close();
                const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--inspect-db', path.join(state, 'issuer.sqlite'), headId, s.signed.transactionId], { encoding: 'utf8' });
                assert.equal(child.status, 0, child.stderr);
                const snapshot = JSON.parse(child.stdout);
                assert.equal(snapshot.snapshot.headVersion, n + 1);
                assert.equal(snapshot.payment.transactionId, s.signed.transactionId);
                issuer = await open();
                configure();
                assert(issuer.getAcceptedPayment(s.signed.transactionId));
            }
        }
        assert.equal(issuer.getCurrent(headId).phase, 'exhausted');
        assert.notEqual((await server.handlePaidRequest(route('exhausted'), handler)).status, 402);
        return { links: 8, uniqueKeys: seen.size, independentProcessReopen: true, headAmount: issuer.getCurrent(headId).head.amount };
    });
    await check('concurrent distinct payers receive exactly one assignment; stable retry survives SQLite reopen', async () => { install(3); const c = await challenge('race'); const results = await Promise.all([claim(c, 0), claim(c, 1)]); assert.equal(results.filter(r => r.status === 200).length, 1); const winner = results.findIndex(r => r.status === 200), delivered = results[winner].body; assert.equal(issuer.getDeliveryRecord(headId, c.extra.grantId).payerPublicKey, pub(winner)); issuer.close(); issuer = await open(); configure(); assert.deepEqual((await claim(c, winner)).body, delivered); assert.notEqual((await claim(c, 1 - winner)).status, 200); return { winners: 1, recoveredAssignment: true }; });
    await check('invalid signature and observer outage disclose no private key', async () => { install(3); const c = await challenge('outage'); const bad = { ...signedClaim(c), signature: '00'.repeat(64) }; const r = await fetch(claimUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bad) }); assert.notEqual(r.status, 200); networkError = true; try {
        assert.notEqual((await claim(c)).status, 200);
        assert.equal(issuer.getDeliveryRecord(headId, c.extra.grantId), undefined);
    }
    finally {
        networkError = false;
    } assert.equal((await claim(c)).status, 200); });
    await check('expiry and abandonment require owner rotation; exposed keys cannot be reinstalled', async () => { const original = install(3); const c = await challenge('abandon'), g = await claim(c); assert.equal(g.status, 200); clock = Date.parse(g.body.expiresAt) + 1; assert.equal(issuer.markAbandoned(headId).phase, 'needsRotation'); assert.notEqual((await claim(c)).status, 200); const old = issuer.getCurrent(headId), replacement = generateHashChainBorrowGrants(3), tx = id(nonce++); const successor = { outpoint: { txid: tx, index: 0 }, amount: old.head.amount, guard: replacement.initialGuard, scriptPublicKey: hashChainHeadScriptPublicKey({ ownerPublicKey: owner, guard: replacement.initialGuard }), covenantId: old.head.covenantId }; issuer.recordAcceptedRotation(headId, { finality: 'accepted', predecessor: old.head.outpoint, successor }, replacement.grants); assert.equal(issuer.getCurrent(headId).phase, 'ready'); assert.notEqual(issuer.getCurrent(headId).oneTimePublicKey, g.body.oneTimePublicKey); assert.throws(() => issuer.installHead({ headId: id(nonce++), network: 'kaspa:testnet-10', ownerPublicKey: owner, head: { ...successor, outpoint: { txid: id(nonce++), index: 0 }, guard: original.initialGuard, scriptPublicKey: hashChainHeadScriptPublicKey({ ownerPublicKey: owner, guard: original.initialGuard }) }, grants: original.grants }), /already been used/); clock = Date.now(); return { ownerTransition: 'controlled accepted observation; no owner transaction broadcast' }; });
    await check('selected transaction loss after acceptance holds head and prevents additional work', async () => { install(3); const c = await challenge('reorg'), g = await claim(c), s = sign(c, g.body); accept(c, s); assert.equal((await paid(c, s.payment)).status, 200); const calls = protectedCalls; selected.delete(s.signed.transactionId); assert.equal((await paid(c, s.payment)).status, 503); assert.equal(protectedCalls, calls); assert.equal(issuer.getCurrent(headId).phase, 'hold'); issuer.close(); issuer = await open(); assert.equal(issuer.getCurrent(headId).phase, 'hold'); configure(); });
    await check('network identity and mainnet opt-in fail closed without any broadcast', async () => {
        assert.throws(() => new HashChainExactTransactionVerifier({ ...view, network: 'kaspa:mainnet' }), /mainnet|network/);
        assert.throws(() => new HashChainExactTransactionVerifier({ ...view, network: 'kaspa:testnet-11' }), /network/);
        assert.throws(() => new HashChainExactTransactionVerifier({ ...view, network: undefined }, 10000000n, 8, { network: 'kaspa:mainnet', allowMainnet: true }), /network/);
        const chain = generateHashChainBorrowGrants(1), head = { outpoint: { txid: id(nonce++), index: 0 }, amount: '100000000', guard: chain.initialGuard, scriptPublicKey: hashChainHeadScriptPublicKey({ ownerPublicKey: owner, guard: chain.initialGuard }), covenantId: id(nonce++) };
        assert.throws(() => issuer.installHead({ headId: id(nonce++), network: 'kaspa:mainnet', ownerPublicKey: owner, head, grants: chain.grants }), /mainnet|network/);
        return { rejectedNetworks: 4, broadcasts };
    });
    await check('seeded bounded 240-case signer tamper matrix and durable claim rejection stress', async () => { install(3); const c = await challenge('stress'), g = await claim(c); let seed = 0x53475031, rejected = 0; for (let i = 0; i < 240; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const mode = seed % 4;
        if (mode === 0) {
            const bad = { ...signedClaim(c), requestHash: id(nonce++) };
            await assert.rejects(server.claimHashChainGrant(bad, context));
        }
        else if (mode === 1) {
            const bad = { ...signedClaim(c, 1) };
            await assert.rejects(server.claimHashChainGrant(bad, context));
        }
        else {
            const s = sign(c, g.body);
            const artifact = JSON.parse(s.signed.transaction);
            if (mode === 2)
                artifact.outputs[0].value = (BigInt(artifact.outputs[0].value) + 1n).toString();
            else
                artifact.inputs[1].signatureScript = '00';
            const p = { ...s.payment, payload: { ...s.payment.payload, transaction: JSON.stringify(artifact) } };
            const calls = protectedCalls;
            assert.notEqual((await paid(c, p)).status, 200);
            assert.equal(protectedCalls, calls);
        }
        rejected++;
    } return { seed: '0x53475031', cases: 240, rejected }; });
}
finally {
    issuer?.close();
    await new Promise(resolve => httpServer.close(resolve));
    const report = { base: JSON.parse(qualificationReadFileSync(new URL("../manifest.json", import.meta.url))).revision, profile: 'hash-chain-additive', evidenceBoundary: 'External installed public SDK; real Schnorr and SQLite; loopback private grant HTTP; controlled chain observations, not consensus/live acceptance proof', cases, passed: cases.filter(c => c.passed).length, failed: cases.filter(c => !c.passed).length, protectedCalls, broadcasts, stateDirectory: state, reproduce: 'cd ' + path.dirname(folder) + ' && node hash-chain/qualify.mjs', scriptSha256: crypto.createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex') };
    fs.writeFileSync(path.join(folder, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    if (report.failed)
        process.exitCode = 1;
}
