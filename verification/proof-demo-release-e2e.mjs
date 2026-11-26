import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { WebSocketServer } from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';
import { addressForScriptPublicKey } from '@kaspa-x402/adapters/native';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader,
  exactRequestAuthorizationDigest, paymentIdentifierExtension, sha256Hex, stableStringify } from '@kaspa-x402/core';
import { exactV0SchnorrSignatureEvidence, exactV0TransactionId } from '@kaspa-x402/covenant';
const out = process.argv[process.argv.indexOf('--out') + 1];
assert.ok(process.argv.includes('--out') && out, '--out is required');
fs.mkdirSync(path.dirname(out), { recursive: true });
const releaseVersion = JSON.parse(fs.readFileSync(new URL('../protocol/packages/core/package.json', import.meta.url))).version;
const cases = [];
async function check(name, fn) { try { cases.push({ name, passed: true, evidence: await fn() }); }
  catch (error) { cases.push({ name, passed: false, error: error.message }); } }
let relay;
let worker;
let upstreamCalls = 0;
let connections = 0;
const checkpointHash = '11'.repeat(32);
const readbackHash = '22'.repeat(32);
const recoveryChain = Array.from({ length: 30 }, (_, index) => sha256Hex('recovery-block-' + index));
const removedRecoveryTip = sha256Hex('removed-recovery-tip');
const removedReceiptCheckpoint = sha256Hex('removed-receipt-checkpoint');
let pendingPayment;
let acceptedOriginMatches = false;
let acceptanceHistoryUnavailable = false;
let recoveryReadbacks = 0;
let recoveryDagReads = 0;
let removedRecoveryTipsServed = 0;
const vector = JSON.parse(fs.readFileSync(new URL('../protocol/vectors/exact/consensus-profiles.json', import.meta.url))).expected.standardNative;

function signedExactPayment(accepted, url, sequence, {
  paymentIdentifier = 'demo-release-exact-recovery', fundingId = paymentIdentifier, submissionFailure,
  authorizationLifetimeMs = 30_000,
} = {}) {
  const reference = structuredClone(vector.transaction);
  const [input] = reference.inputs;
  input.previousOutpoint.txid = sha256Hex(fundingId);
  input.sequence = sequence;
  reference.outputs[0].scriptPublicKey = accepted.extra.payToScriptPublicKey;
  const sign = digest => Buffer.from(schnorr.sign(Buffer.from(digest, 'hex'), new Uint8Array(32).fill(7), new Uint8Array(32))).toString('hex');
  input.signatureScript = '41' + sign(exactV0SchnorrSignatureEvidence(reference, 0).digest) + '01';
  const id = exactV0TransactionId(reference);
  const { computeBudget: _unusedBudget, previousOutpoint, ...legacyInput } = input;
  const artifact = {
    ...reference, id,
    inputs: [{ ...legacyInput, previousOutpoint: { transactionId: previousOutpoint.txid, index: previousOutpoint.index } }],
    outputs: reference.outputs.map(({ amount, ...output }) => ({ ...output, value: amount })),
  };
  const paymentRequirementsHash = sha256Hex(stableStringify(accepted));
  const requestHash = sha256Hex(stableStringify({ method: 'GET', url, body: null, paymentRequirementsHash }));
  const expiresAt = new Date(Date.now() + authorizationLifetimeMs).toISOString();
  const digest = exactRequestAuthorizationDigest({
    network: accepted.network, profile: 'standard-native', transactionId: id, paymentOutputIndex: 0,
    amount: accepted.amount, payTo: accepted.payTo, payToScriptPublicKey: accepted.extra.payToScriptPublicKey,
    paymentRequirementsHash, requestHash, paymentIdentifier, inputIndex: 0, expiresAt,
  });
  const header = encodePaymentSignatureHeader({
    x402Version: 2, accepted,
    extensions: { 'payment-identifier': paymentIdentifierExtension({ required: true, id: paymentIdentifier }) },
    payload: { type: 'exact-transaction', profile: 'standard-native', transaction: JSON.stringify(artifact),
      transactionEncoding: accepted.extra.transactionEncoding, paymentOutputIndex: 0, requestHash,
      authorization: { version: 'kaspa-x402-exact-request-authorization-v2', inputIndex: 0,
        expiresAt, digest, signature: sign(digest) } },
  });
  return { artifact, header, merchant: accepted.payTo, authorizationExpiresAt: expiresAt,
    submissionFailure, submissions: [], accepted: false };
}

function recoveryBlockHeader(hash) {
  const position = hash === removedRecoveryTip ? recoveryChain.length
    : hash === removedReceiptCheckpoint ? 0 : recoveryChain.indexOf(hash);
  const score = String(1_000_001 + position);
  return { hash, blueScore: score, daaScore: score };
}

function transactionReadback({ artifact }) {
  return {
    ...artifact,
    inputs: artifact.inputs.map(input => ({ ...input, sequence: JSON.rawJSON(input.sequence) })),
  };
}

function fixtureUtxos(addresses) {
  if (!pendingPayment) return [];
  const { artifact, merchant, accepted } = pendingPayment;
  const [input] = artifact.inputs;
  const payer = addressForScriptPublicKey(input.utxo.scriptPublicKey, 'kaspa:testnet-10');
  if (!accepted && addresses.includes(payer)) {
    return [{ outpoint: input.previousOutpoint, utxoEntry: input.utxo }];
  }
  if (accepted && addresses.includes(merchant)) {
    const { value: amount, scriptPublicKey } = artifact.outputs[0];
    return [{ outpoint: { transactionId: artifact.id, index: 0 }, utxoEntry: { amount, scriptPublicKey } }];
  }
  return [];
}
const peer = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await new Promise(r => peer.once('listening', r));
const endpoint = `ws://127.0.0.1:${peer.address().port}/wrpc/json`;
peer.on('connection', ws => { connections++; ws.on('message', raw => {
  upstreamCalls++;
  let sequenceOnWire;
  const { id, method, params } = JSON.parse(raw.toString(), (key, value, context) => {
    if (key === 'sequence') sequenceOnWire = context.source;
    return value;
  });
  if (params?.hash === 'oversize') {
    ws.send('a'.repeat(2_200_000), { fin: false });
    ws.send('b'.repeat(2_200_000), { fin: true }); return;
  }
  if (params?.hash === 'timeout') return;
  let result;
  if (method === 'submitTransaction') {
    const input = params.transaction.inputs[0];
    if (!pendingPayment || input.previousOutpoint.transactionId !== pendingPayment.artifact.inputs[0].previousOutpoint.transactionId) {
      ws.send(JSON.stringify({ id, method, error: 'Unexpected fixture submission' }));
      return;
    }
    pendingPayment.submissions.push(sequenceOnWire);
    if (pendingPayment.submissionFailure === 'reject') {
      ws.send(JSON.stringify({ id, method, error: 'Fixture rejected transaction before broadcast' }));
      return;
    }
    pendingPayment.accepted = true;
    if (pendingPayment.submissionFailure === 'lost-acknowledgement') {
      // The node accepted the payment but the submission response was lost.
      ws.close();
      return;
    }
    result = { transactionId: pendingPayment.artifact.id };
  } else if (method === 'getBlock') {
    if (acceptanceHistoryUnavailable && params.hash === recoveryChain[0]) {
      ws.send(JSON.stringify({ id, method, error: 'Fixture accepting block temporarily unavailable' }));
      return;
    }
    const position = recoveryChain.indexOf(params.hash);
    const isChainBlock = params.hash !== removedRecoveryTip &&
      !(params.hash === removedReceiptCheckpoint && pendingPayment?.accepted);
    const block = { header: recoveryBlockHeader(params.hash),
      verboseData: { hash: params.hash, isChainBlock,
        selectedParentHash: recoveryChain[position - 1] ?? checkpointHash } };
    if (params.hash === readbackHash && params.includeTransactions && pendingPayment) {
      block.transactions = [transactionReadback(pendingPayment)];
    }
    result = { block };
  } else if (method === 'getVirtualChainFromBlock' && pendingPayment?.accepted) {
    const start = recoveryChain.indexOf(params.startHash) + 1;
    const addedChainBlockHashes = recoveryChain.slice(start);
    const [acceptingBlockHash] = recoveryChain;
    const acceptedTransactionIds = start === 0
      ? [{ acceptingBlockHash, acceptedTransactionIds: [pendingPayment.artifact.id] }]
      : [];
    const removedChainBlockHashes = params.startHash === removedReceiptCheckpoint ? [removedReceiptCheckpoint] : [];
    result = { addedChainBlockHashes, removedChainBlockHashes, acceptedTransactionIds };
  } else if (method === 'getVirtualChainFromBlockV2' && pendingPayment?.accepted) {
    const [acceptingBlockHash] = recoveryChain;
    recoveryReadbacks += 1;
    const transaction = transactionReadback(pendingPayment);
    for (const input of transaction.inputs) {
      input.verboseData = {
        utxoEntry: { ...input.utxo, amount: acceptedOriginMatches ? input.utxo.amount : '1' },
      };
    }
    result = { addedChainBlockHashes: [acceptingBlockHash], removedChainBlockHashes: [],
      chainBlockAcceptedTransactions: [{
        chainBlockHeader: recoveryBlockHeader(acceptingBlockHash),
        acceptedTransactions: [transaction],
      }] };
  } else if (method === 'getServerInfo') {
    result = { networkId: 'testnet-10', isSynced: true, hasUtxoIndex: true, virtualDaaScore: '1000000' };
  } else if (method === 'getUtxosByAddresses') {
    result = { entries: fixtureUtxos(params.addresses) };
  } else {
    let sink = pendingPayment ? removedReceiptCheckpoint : checkpointHash;
    if (pendingPayment?.accepted) {
      recoveryDagReads += 1;
      // The gateway and funding snapshots are the first two reads. Lose the
      // tip during transaction lookup and again during the depth confirmation.
      const lookupTipMoved = recoveryDagReads === 3;
      const confirmationTipMoved = recoveryReadbacks === 1 && removedRecoveryTipsServed === 1;
      if (lookupTipMoved || confirmationTipMoved) {
        removedRecoveryTipsServed += 1;
        sink = removedRecoveryTip;
      } else {
        sink = recoveryChain.at(-1);
      }
    }
    result = { network: 'testnet-10', sink, pruningPointHash: checkpointHash, virtualDaaScore: recoveryBlockHeader(sink).daaScore };
  }
  ws.send(JSON.stringify({ id, method, params: result }));
}); });
const token = 'test-only-private-relay-token-at-least-32-bytes';
const temporary = mkdtempSync(path.join(tmpdir(), 'x402-demo-release-'));
try {
  await check('bounded authenticated relay rejects unauthorized and arbitrary destinations', async () => {
    const { startDemoPnnRelay } = await import('../scripts/demo-pnn-relay.mjs');
    relay = await startDemoPnnRelay({ endpoints: [endpoint], token, allowInsecureLoopback: true, timeoutMs: 1000 });
    const call = (body, auth = token) => fetch(relay.origin + '/rpc', { method: 'POST',
      headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await call({ endpoint, method: 'getServerInfo', params: {} }, 'wrong')).status, 401);
    assert.equal((await call({ endpoint: 'ws://127.0.0.1:1/', method: 'getServerInfo', params: {} })).status, 400);
    assert.equal((await call({ endpoint, method: 'subscribeBlockAdded', params: {} })).status, 400);
    assert.equal(upstreamCalls, 0);
    const sessionId = '12345678-1234-4123-8123-123456789012';
    assert.equal((await call({ endpoint, sessionId, method: 'connect', params: {} })).status, 200);
    const good = await call({ endpoint, sessionId, method: 'getServerInfo', params: {} });
    assert.equal(good.status, 200);
    assert.equal((await good.json()).networkId, 'testnet-10');
    assert.equal((await call({ endpoint, sessionId, method: 'getServerInfo', params: {} })).status, 200);
    assert.equal(connections, 1, 'RPC methods must share the same bounded node connection');
    for (const hash of ['oversize', 'timeout']) {
      await call({ endpoint, sessionId, method: 'disconnect', params: {} });
      assert.equal((await call({ endpoint, sessionId, method: 'connect', params: {} })).status, 200);
      const response = await call({ endpoint, sessionId, method: 'getBlock', params: { hash, includeTransactions: true } });
      assert.equal(response.status, 503, hash);
    }
    const large = await fetch(relay.origin + '/rpc', { method: 'POST',
      headers: { authorization: `Bearer ${token}` }, body: 'a'.repeat(4_259_841) });
    assert.equal(large.status, 413);
    return { fragmentedMessageCap: 4_259_840, deadlineMs: 1000, unauthorizedDials: 0 };
  });
  await check('actual Worker accepts the release version and serves current payable offers through the relay', async () => {
    assert.ok(relay, 'relay unavailable');
    const require = createRequire(createRequire(import.meta.url).resolve('wrangler/package.json'));
    const { Miniflare, convertV4MiniflareOptions } = await import(require.resolve('miniflare'));
    const options = { modules: true, scriptPath: path.resolve('packages/demo-gateway/dist/index.js'),
      compatibilityDate: '2026-06-02', compatibilityFlags: ['nodejs_compat'],
      durableObjects: { GATEWAY_STATE: { className: 'GatewayState', useSQLite: true } },
      durableObjectsPersist: temporary,
      bindings: {
        KASPA_X402_GATEWAY_ENABLED: 'true', KASPA_X402_HOSTED_EXACT_SETTLEMENT_ENABLED: 'true', KASPA_X402_RELEASE_VERSION: releaseVersion,
        KASPA_X402_CHAIN_TRUST_MODE: 'trusted-single-source',
        KASPA_X402_ADMISSION_HMAC_KEY: 'private-test-admission-key-at-least-32-bytes',
        KASPA_X402_ADMIN_TOKEN: token,
        KASPA_X402_PAY_TO: 'kaspatest:qzlws9lm7uyt0tftzffshnyeu2zcqk4kf7hw5ghk6v0zh093vnkljcy2fl0fh',
        KASPA_X402_SERVER_PUBLIC_KEY: 'bee817fbf708b7ad2b12530bcc99e285805ab64faeea22f6d31e2bbcb164edf9',
        KASPA_X402_PNN_ENDPOINTS: endpoint, KASPA_X402_ALLOW_INSECURE_LOOPBACK: 'true',
        KASPA_X402_PNN_RPC_ORIGIN: relay.origin, KASPA_X402_PNN_RPC_TOKEN: token,
      } };
    worker = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options);
    const request = route => worker.dispatchFetch('https://demo.kaspa-x402.org' + route, {
      headers: { 'cf-connecting-ip': '192.0.2.1' } });
    assert.equal((await (await request('/health')).json()).releaseVersion, releaseVersion);
    const { GATEWAY_STATE } = await worker.getBindings();
    const state = GATEWAY_STATE.get(GATEWAY_STATE.idFromName('demo-gateway-state-v2'));
    const seeded = await state.fetch('https://state/rpc', { method: 'POST',
      body: JSON.stringify({ method: 'recordPnnCheckpoint', payload: { checkpoint: {
        blockHash: '11'.repeat(32), daaScore: '1000000', blueScore: '1000000' } } }) });
    assert.equal(seeded.status, 200);
    const exact = await request('/exact/report');
    assert.equal(exact.status, 402, await exact.clone().text());
    const batch = await request('/batch/report');
    assert.equal(batch.status, 402, await batch.clone().text());
    const offer = JSON.parse(Buffer.from(batch.headers.get('payment-required'), 'base64').toString());
    assert.equal(offer.accepts[0].extra.templateId, 'kaspa-x402-escrow-v5');
    return { exact: exact.status, batch: batch.status, batchTemplate: offer.accepts[0].extra.templateId };
  });
  await check('actual Worker recovers a maximum-sequence payment whose receipt checkpoint was removed', async () => {
    const url = 'https://demo.kaspa-x402.org/exact/report';
    const headers = { 'cf-connecting-ip': '192.0.2.1' };
    const offer = await worker.dispatchFetch(url, { headers });
    assert.equal(offer.status, 402, await offer.clone().text());
    const accepted = decodePaymentRequiredHeader(offer.headers.get('payment-required')).accepts[0];
    const sequence = vector.transaction.inputs[0].sequence;
    pendingPayment = signedExactPayment(accepted, url, sequence, {
      submissionFailure: 'lost-acknowledgement', authorizationLifetimeMs: 5_000,
    });
    const pay = () => worker.dispatchFetch(url, { headers: { ...headers, 'payment-signature': pendingPayment.header } });

    const first = await pay();
    assert.equal(first.status, 503, await first.clone().text());
    assert.deepEqual(await first.json(), { error: 'exact_settlement_recovery_required' });
    assert.equal(first.headers.get('payment-response'), null);
    assert.deepEqual(pendingPayment.submissions, [sequence], 'the node must receive one exact, unquoted JSON integer');
    assert.equal(recoveryReadbacks, 0);
    const { GATEWAY_STATE } = await worker.getBindings();
    const state = GATEWAY_STATE.get(GATEWAY_STATE.idFromName('demo-gateway-state-v2'));
    const receipt = await state.fetch('https://state/rpc', { method: 'POST',
      body: JSON.stringify({ method: 'loadPnnEvidence', payload: { transactionId: pendingPayment.artifact.id } }) });
    assert.equal((await receipt.json()).value.checkpoint.blockHash, removedReceiptCheckpoint);

    const conflicting = await pay();
    assert.equal(conflicting.status, 503);
    assert.deepEqual(await conflicting.json(), { error: 'exact_settlement_recovery_required' });
    assert.equal(conflicting.headers.get('payment-required'), null);
    assert.deepEqual(pendingPayment.submissions, [sequence]);

    acceptedOriginMatches = true;
    await new Promise(resolve => setTimeout(resolve,
      Math.max(0, Date.parse(pendingPayment.authorizationExpiresAt) - Date.now() + 100)));
    const retry = await pay();
    assert.equal(retry.status, 200, await retry.clone().text());
    const settlementHeader = retry.headers.get('payment-response');
    const settlement = decodePaymentResponseHeader(settlementHeader);
    assert.equal(settlement.transaction, pendingPayment.artifact.id);
    const recoveredBody = await retry.json();
    assert.equal(recoveredBody.payment.finality, 'accepted');

    const replay = await pay();
    assert.equal(replay.status, 200, await replay.clone().text());
    assert.equal(replay.headers.get('payment-response'), settlementHeader);
    assert.deepEqual(await replay.json(), recoveredBody);
    assert.deepEqual(pendingPayment.submissions, [sequence]);
    assert.equal(recoveryReadbacks, 2);
    assert.equal(removedRecoveryTipsServed, 2);
    return { sequence, transactionId: settlement.transaction, first: first.status,
      recovered: retry.status, replay: replay.status, submissions: pendingPayment.submissions.length, selectedChainReads: recoveryReadbacks,
      removedCheckpoints: removedRecoveryTipsServed, conflictingOrigin: conflicting.status };
  });
  await check('relay preserves the exact sequence in accepted transaction readback', async () => {
    const sessionId = '12345678-1234-4123-8123-123456789013';
    const call = (method, params = {}) => fetch(relay.origin + '/rpc', { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint, sessionId, method, params }) });
    assert.equal((await call('connect')).status, 200);
    try {
      const response = await call('getBlock', { hash: readbackHash, includeTransactions: true });
      assert.equal(response.status, 200);
      const { block } = await response.json();
      assert.equal(block.transactions.length, 1);
      const [transaction] = block.transactions;
      assert.equal(transaction.id, pendingPayment.artifact.id);
      const sequence = String(transaction.inputs[0].sequence);
      assert.equal(sequence, vector.transaction.inputs[0].sequence);
      return { transactionId: transaction.id, sequence };
    } finally {
      await call('disconnect');
    }
  });
  await check('actual Worker refuses a fresh authorization for an already paid transaction', async () => {
    acceptedOriginMatches = false;
    const url = 'https://demo.kaspa-x402.org/exact/report';
    const headers = { 'cf-connecting-ip': '192.0.2.1' };
    const offer = await worker.dispatchFetch(url, { headers });
    assert.equal(offer.status, 402, await offer.clone().text());
    const accepted = decodePaymentRequiredHeader(offer.headers.get('payment-required')).accepts[0];
    const sequence = vector.transaction.inputs[0].sequence;
    const fundingId = 'demo-release-claimed-funding';
    const original = signedExactPayment(accepted, url, sequence, {
      paymentIdentifier: 'demo-release-original', fundingId, submissionFailure: 'lost-acknowledgement',
    });
    pendingPayment = original;
    const pay = payment => worker.dispatchFetch(url, { headers: { ...headers, 'payment-signature': payment.header } });

    const first = await pay(original);
    assert.equal(first.status, 503, await first.clone().text());
    assert.equal((await first.json()).error, 'exact_settlement_recovery_required');
    const { GATEWAY_STATE } = await worker.getBindings();
    const state = GATEWAY_STATE.get(GATEWAY_STATE.idFromName('demo-gateway-state-v2'));
    const loadAttempt = async () => {
      const response = await state.fetch('https://state/rpc', { method: 'POST',
        body: JSON.stringify({ method: 'loadExactSettlementAttempt', payload: { transactionId: original.artifact.id } }) });
      assert.equal(response.status, 200);
      return (await response.json()).value;
    };
    const recordedAttempt = await loadAttempt();
    assert.equal(recordedAttempt.status, 'pending');
    const statusUrl = 'https://demo.kaspa-x402.org/admin/exact-settlements/status?transactionId=' + original.artifact.id;
    const unauthenticated = await worker.dispatchFetch(statusUrl);
    assert.equal(unauthenticated.status, 401);
    const status = await worker.dispatchFetch(statusUrl, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(status.status, 200, await status.clone().text());
    const statusBody = await status.json();
    assert.equal(statusBody.claim.status, 'pending');
    assert.equal(statusBody.transactionId, original.artifact.id);
    assert.equal(status.headers.get('cache-control'), 'private, no-store, max-age=0');
    assert.equal(JSON.stringify(statusBody).includes(original.header), false);
    assert.equal(JSON.stringify(statusBody).includes(original.artifact.inputs[0].signatureScript), false);
    acceptedOriginMatches = true;

    const reauthorized = signedExactPayment(accepted, url, sequence, { paymentIdentifier: 'demo-release-reauthorized', fundingId });
    assert.equal(reauthorized.artifact.id, original.artifact.id);
    const conflict = await pay(reauthorized);
    assert.equal(conflict.status, 409, await conflict.clone().text());
    assert.deepEqual(await conflict.json(), { error: 'exact_settlement_claim_conflict' });
    assert.equal(conflict.headers.get('payment-required'), null);
    assert.deepEqual(original.submissions, [sequence], 'neither retry may rebroadcast the claimed transaction');
    assert.deepEqual(await loadAttempt(), recordedAttempt);
    const retry = await pay(original);
    assert.equal(retry.status, 200, await retry.clone().text());
    assert.equal(decodePaymentResponseHeader(retry.headers.get('payment-response')).transaction, original.artifact.id);
    assert.deepEqual(original.submissions, [sequence]);
    const applied = await worker.dispatchFetch(statusUrl, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(applied.status, 200, await applied.clone().text());
    const appliedBody = await applied.json();
    assert.equal(appliedBody.claim.status, 'applied');
    assert.equal(appliedBody.claim.handlerStarted, true);
    assert.equal(appliedBody.claim.handlerCompleted, true);
    assert.equal(appliedBody.payment.finality, 'accepted');
    acceptanceHistoryUnavailable = true;
    const unavailableConflict = await pay(reauthorized);
    assert.equal(unavailableConflict.status, 409, await unavailableConflict.clone().text());
    assert.deepEqual(await unavailableConflict.json(), { error: 'exact_settlement_claim_conflict' });
    assert.equal(unavailableConflict.headers.get('payment-required'), null);
    acceptanceHistoryUnavailable = false;
    const afterPayment = await pay(reauthorized);
    assert.equal(afterPayment.status, 409, await afterPayment.clone().text());
    assert.equal(afterPayment.headers.get('payment-response'), null);
    assert.equal(afterPayment.headers.get('payment-required'), null);
    return { first: first.status, conflict: conflict.status,
      retry: retry.status, unavailableConflict: unavailableConflict.status, afterPayment: afterPayment.status,
      originalSubmissions: original.submissions.length };
  });
  await check('actual Worker reaches the bounded node transport during head registration', async () => {
    const before = upstreamCalls;
    const response = await worker.dispatchFetch('https://demo.kaspa-x402.org/admin/hash-chain/register', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ network: 'kaspa:testnet-10', headId: 'aa'.repeat(32),
        ownerPublicKey: 'bee817fbf708b7ad2b12530bcc99e285805ab64faeea22f6d31e2bbcb164edf9',
        grants: [], head: { outpoint: { txid: '11'.repeat(32), index: 0 }, amount: '100000000',
          scriptPublicKey: '000020bee817fbf708b7ad2b12530bcc99e285805ab64faeea22f6d31e2bbcb164edf9ac',
          covenantId: '22'.repeat(32) } }) });
    assert.equal(response.status, 409, 'nonexistent fixture head must remain rejected');
    assert.ok(upstreamCalls > before, 'Worker could not invoke the configured bounded transport');
    return { nodeCalls: upstreamCalls - before, missingHeadRejected: true };
  });

} finally {
  await worker?.dispose(); await relay?.close();
  for (const client of peer.clients) client.terminate();
  await new Promise(r => peer.close(r));
  fs.rmSync(temporary, { recursive: true, force: true });
  fs.writeFileSync(out, JSON.stringify({ ok: cases.every(c => c.passed), cases }, null, 2) + '\n');
}
console.log(JSON.stringify(cases));
if (cases.some(c => !c.passed)) process.exitCode = 1;
