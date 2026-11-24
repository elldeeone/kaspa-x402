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
const exactPayments = [];
const vector = JSON.parse(fs.readFileSync(new URL('../protocol/vectors/exact/consensus-profiles.json', import.meta.url))).expected.standardNative;

function signedExactPayment(accepted, url, sequence) {
  const reference = structuredClone(vector.transaction);
  const [input] = reference.inputs;
  input.previousOutpoint.txid = sha256Hex('demo-release-exact-' + sequence);
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
  const paymentIdentifier = 'demo-release-exact-' + sequence;
  const expiresAt = new Date(Date.now() + 30_000).toISOString();
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
  return { artifact, header, merchant: accepted.payTo, submissions: [] };
}

function fixtureUtxos(addresses) {
  return exactPayments.flatMap(({ artifact, merchant, submissions }) => {
    const [input] = artifact.inputs;
    const payer = addressForScriptPublicKey(input.utxo.scriptPublicKey, 'kaspa:testnet-10');
    if (!submissions.length && addresses.includes(payer)) {
      return [{ outpoint: input.previousOutpoint, utxoEntry: input.utxo }];
    }
    if (submissions.length && addresses.includes(merchant)) {
      const { value: amount, scriptPublicKey } = artifact.outputs[0];
      return [{ outpoint: { transactionId: artifact.id, index: 0 }, utxoEntry: { amount, scriptPublicKey } }];
    }
    return [];
  });
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
    const payment = exactPayments.find(({ artifact }) => artifact.inputs[0].previousOutpoint.transactionId === input.previousOutpoint.transactionId);
    if (!payment) {
      ws.send(JSON.stringify({ id, method, error: 'Unexpected fixture submission' }));
      return;
    }
    payment.submissions.push(sequenceOnWire);
    result = { transactionId: payment.artifact.id };
  } else if (method === 'getBlock') {
    const block = { header: { hash: params.hash, blueScore: '1000000', daaScore: '1000000' },
      verboseData: { hash: params.hash, isChainBlock: true } };
    if (params.hash === readbackHash && params.includeTransactions) {
      block.transactions = exactPayments.map(({ artifact }) => ({
        ...artifact,
        inputs: artifact.inputs.map(input => ({ ...input, sequence: JSON.rawJSON(input.sequence) })),
      }));
    }
    result = { block };
  } else if (method === 'getServerInfo') {
    result = { networkId: 'testnet-10', isSynced: true, hasUtxoIndex: true, virtualDaaScore: '1000000' };
  } else if (method === 'getUtxosByAddresses') {
    result = { entries: fixtureUtxos(params.addresses) };
  } else {
    result = { network: 'testnet-10', sink: checkpointHash, pruningPointHash: checkpointHash, virtualDaaScore: '1000000' };
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
  for (const sequence of ['0', vector.transaction.inputs[0].sequence]) {
    await check('actual Worker settles and replays a signed native payment with sequence ' + sequence, async () => {
      assert.ok(worker, 'Worker unavailable');
      const url = 'https://demo.kaspa-x402.org/exact/report';
      const headers = { 'cf-connecting-ip': '192.0.2.1' };
      const offer = await worker.dispatchFetch(url, { headers });
      assert.equal(offer.status, 402, await offer.clone().text());
      const accepted = decodePaymentRequiredHeader(offer.headers.get('payment-required')).accepts[0];
      assert.equal(accepted.amount, vector.amount);
      const payment = signedExactPayment(accepted, url, sequence);
      exactPayments.push(payment);
      const pay = () => worker.dispatchFetch(url, { headers: { ...headers, 'payment-signature': payment.header } });
      const first = await pay();
      assert.equal(first.status, 200, await first.clone().text());
      const settlement = decodePaymentResponseHeader(first.headers.get('payment-response'));
      assert.equal(settlement.transaction, payment.artifact.id);
      assert.equal((await first.json()).payment.finality, 'accepted');
      const retry = await pay();
      assert.equal(retry.status, 200, await retry.clone().text());
      assert.equal(retry.headers.get('payment-response'), first.headers.get('payment-response'));
      assert.deepEqual(payment.submissions, [sequence], 'the node must receive one exact, unquoted JSON integer');
      return { sequence, transactionId: payment.artifact.id, submissions: payment.submissions.length, replay: retry.status };
    });
  }
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
      assert.deepEqual(block.transactions.map(transaction => String(transaction.inputs[0].sequence)),
        ['0', vector.transaction.inputs[0].sequence]);
      return { sequences: block.transactions.map(transaction => String(transaction.inputs[0].sequence)) };
    } finally {
      await call('disconnect');
    }
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
