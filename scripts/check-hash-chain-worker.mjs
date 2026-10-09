import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { generateHashChainBorrowGrants, hashChainHeadScriptPublicKey } from '@kaspa-x402/covenant';
import { createHashChainDemoPayment, readHashChainQuote, addressForScriptPublicKey } from '../site/dist/assets/hash-chain-client.js';

// Use the same local Worker runtime supplied by the existing Wrangler dependency.
const require = createRequire(requireResolve('wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions, WebSocketPair, Response: WorkerResponse } = await import(require.resolve('miniflare'));
function requireResolve(name) { return createRequire(import.meta.url).resolve(name); }
const folder = mkdtempSync(path.join(tmpdir(), 'kaspa-x402-hash-worker-'));
const base = 'https://demo.kaspa-x402.org';
const admin = 'local-worker-test-admin-token-32-characters';
const payerKey = '07'.repeat(32);
const owner = Buffer.from(schnorr.getPublicKey(Buffer.alloc(32, 8))).toString('hex');
const payerScript = `000020${Buffer.from(schnorr.getPublicKey(Buffer.from(payerKey, 'hex'))).toString('hex')}ac`;
const covenantId = 'de'.repeat(32);
const blockHash = 'bc'.repeat(32);
const transactions = new Map();
const utxos = new Map();
let broadcasts = 0;
let lastPaidRequest;
let grantRetryAfterFundingLoss = false;
let selectedHeight = 0;
let reorged = false;
const acceptedBlocks = new Map();
const hashAt = (height) => height.toString(16).padStart(64, '0');
const grants = generateHashChainBorrowGrants(4);
const head = { outpoint: { txid: '11'.repeat(32), index: 0 }, amount: '100000000', guard: grants.initialGuard,
  scriptPublicKey: hashChainHeadScriptPublicKey({ ownerPublicKey: owner, guard: grants.initialGuard }), covenantId };
recordTransaction(head.outpoint.txid, [], [{ value: head.amount, scriptPublicKey: head.scriptPublicKey,
  covenant: { authorizingInput: 0, covenantId } }]);
for (let index = 1; index <= 2; index++) recordTransaction(String(index).padStart(64, '0'), [], [
  { value: '50000000', scriptPublicKey: payerScript, covenant: null },
]);
const options = {
  name: 'kaspa-x402-hash-chain-worker-check',
  modules: true, scriptPath: path.resolve('packages/demo-gateway/dist/index.js'),
  compatibilityDate: '2026-06-02', compatibilityFlags: ['nodejs_compat'],
  durableObjects: { GATEWAY_STATE: { className: 'GatewayState', useSQLite: true,
    unsafeUniqueKey: 'kaspa-x402-hash-chain-worker-check' } },
  durableObjectsPersist: folder,
  resourcePersistencePath: folder,
  bindings: {
    KASPA_X402_GATEWAY_ENABLED: 'true', KASPA_X402_HASH_CHAIN_ENABLED: 'true',
    KASPA_X402_ADMISSION_HMAC_KEY: 'test-admission-key-with-at-least-32-bytes',
    KASPA_X402_ADMIN_TOKEN: admin,
    KASPA_X402_PAY_TO: addressForScriptPublicKey(payerScript, 'kaspa:testnet-10'),
    KASPA_X402_SERVER_PUBLIC_KEY: owner, KASPA_X402_GATEWAY_BASE_URL: base,
    KASPA_X402_HOSTED_EXACT_SETTLEMENT_ENABLED: 'true',
    KASPA_X402_CHAIN_BROADCAST_MODE: 'pnn', KASPA_X402_PNN_ENDPOINTS: 'wss://chain.demo.invalid/wrpc/json',
  },
  outboundService: async (request) => {
    const url = new URL(request.url);
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const [client, server] = Object.values(new WebSocketPair());
      let fullChainReads = 0;
      server.accept();
      server.addEventListener('message', (event) => {
        const { id, method, params } = JSON.parse(event.data);
        try {
          if (method === 'getVirtualChainFromBlockV2') assert(++fullChainReads === 1,
            'payment verification must stop after finding its accepting block');
          server.send(JSON.stringify({ id, params: rpcResult(method, params) }));
        }
        catch (error) { server.send(JSON.stringify({ id, error: String(error) })); }
      });
      return new WorkerResponse(null, { status: 101, webSocket: client });
    }
    throw new Error(`REST is unavailable in the PNN-only Worker check: ${url.pathname}`);
  },
};
const createWorker = () => new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options);
let worker = createWorker();
const fetcher = async (input, init) => {
  const request = new Request(input, init);
  request.headers.set('cf-connecting-ip', '203.0.113.10');
  request.headers.set('x-kaspa-x402-demo-caller', 'forged');
  const grantRetry = new URL(request.url).pathname === '/hash-chain/grant' && !grantRetryAfterFundingLoss
    ? request.clone() : undefined;
  if (request.headers.has('PAYMENT-SIGNATURE')) lastPaidRequest = request.clone();
  const response = await worker.dispatchFetch(request.url, {
    method: request.method, headers: request.headers,
    ...(request.body ? { body: request.body, duplex: 'half' } : {}),
  });
  if (grantRetry && response.status === 200) {
    const assignedGrant = await response.clone().json();
    const payerUtxos = [...utxos.entries()].filter(([, item]) =>
      item.utxoEntry.scriptPublicKey.scriptPublicKey === payerScript.slice(4));
    for (const [key] of payerUtxos) utxos.delete(key);
    try {
      const retry = await worker.dispatchFetch(grantRetry.url, {
        method: grantRetry.method, headers: grantRetry.headers, body: await grantRetry.text(),
      });
      assert.equal(retry.status, 200, 'assigned grant retry must survive loss of payer funding');
      assert.deepEqual(await retry.json(), assignedGrant);
      grantRetryAfterFundingLoss = true;
    } finally {
      for (const [key, value] of payerUtxos) utxos.set(key, value);
    }
  }
  if (request.headers.has('PAYMENT-SIGNATURE') && !response.headers.has('PAYMENT-RESPONSE')) {
    throw new Error(`Local Worker paid response: HTTP ${response.status}; ${await response.clone().text()}`);
  }
  // dispatchFetch bypasses network fetch, which normally supplies this URL.
  Object.defineProperty(response, 'url', { value: request.url });
  return response;
};
const register = (body, token = admin) => worker.dispatchFetch(`${base}/admin/hash-chain/register`, {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
});
try {
  assert.equal((await register({}, 'wrong')).status, 401);
  assert.equal((await worker.dispatchFetch(`${base}/hash-chain/status`)).status, 200);
  const registration = { headId: 'aa'.repeat(32), ownerPublicKey: owner, network: 'kaspa:testnet-10', head, grants: grants.grants };
  const registered = await register(registration);
  assert.equal(registered.status, 200, await registered.text());
  assert.equal((await register(registration)).status, 409, 're-registering a head must not reissue keys');
  const bindings = await worker.getBindings();
  const namespace = bindings.GATEWAY_STATE;
  const stateStub = namespace.get(namespace.idFromName('demo-gateway-state-v2'));
  const stateCall = async (method, payload) => {
    const response = await stateStub.fetch('https://gateway-state/rpc', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, payload }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true, result.error);
    return result.value;
  };
  await stateCall('recordPnnCheckpoint', {
    checkpoint: { blockHash, blueScore: '1000', daaScore: '1000' },
  });
  for (const available of await stateCall('listExactHeads')) {
    if (available.status === 'available')
      await stateCall('recordExactHeadOfferObservation', { head: available });
  }
  const supported = await (await worker.dispatchFetch(`${base}/supported`)).json();
  assert.deepEqual(supported.kinds.map((kind) => kind.extra.profile ?? kind.scheme),
    ['standard-native', 'batch-settlement', 'hash-chain-additive']);
  for (const route of ['/exact/report', '/batch/report']) {
    assert.equal((await worker.dispatchFetch(base + route)).status, 402, `existing ${route} offer`);
  }
  for (let index = 0; index < 4; index++) assert.equal((await worker.dispatchFetch(`${base}/hash-chain/report?quota=${index}`, {
    headers: { 'cf-connecting-ip': '198.51.100.1' },
  })).status, 402);
  assert.equal((await worker.dispatchFetch(`${base}/hash-chain/report?quota=4`, {
    headers: { 'cf-connecting-ip': '198.51.100.1' },
  })).status, 503);
  const spoofed = await worker.dispatchFetch(`${base}/hash-chain/report`, {
    headers: { 'x-kaspa-x402-demo-caller': 'aa'.repeat(32) },
  });
  assert.equal(spoofed.status, 402);
  assert.notEqual(spoofed.headers.get('x-kaspa-x402-demo-caller'), 'aa'.repeat(32),
    'the Worker runtime supplies the ingress IP and replaces public caller input');
  const sdk = { Transaction: { deserializeFromSafeJSON(artifact) {
    return { id: JSON.parse(artifact).id, artifact, free() {} };
  } } };
  const rpc = {
    async getServerInfo() { return { networkId: 'testnet-10', isSynced: true }; },
    async getUtxosByAddresses() {
      return { entries: [...utxos.values()].filter((item) => item.utxoEntry.scriptPublicKey.scriptPublicKey === payerScript.slice(4))
        .map((item) => ({ outpoint: item.outpoint, amount: item.utxoEntry.amount, covenantId: item.utxoEntry.covenantId })) };
    },
    async submitTransaction({ transaction }) {
      const tx = JSON.parse(transaction.artifact);
      for (const input of tx.inputs) utxos.delete(`${input.transactionId}:${input.index}`);
      recordTransaction(tx.id, tx.inputs, tx.outputs);
      selectedHeight += 100; // Many unrelated blocks can arrive between claim and payment.
      selectedHeight++;
      acceptedBlocks.set(selectedHeight, [{ transactionId: tx.id,
        inputs: tx.inputs.map((input) => ({ previousOutpoint: { transactionId: input.transactionId, index: input.index } })),
        outputs: tx.outputs.map((output) => ({ value: output.value, scriptPublicKey: output.scriptPublicKey,
          covenant: output.covenant })) }]);
      selectedHeight += 2;
      broadcasts++;
      return { transactionId: tx.id };
    },
  };
  const results = [];
  for (let index = 0; index < 2; index++) {
    const url = `${base}/hash-chain/report?payment=${index}`;
    const quote = readHashChainQuote(await fetcher(url));
    const payment = createHashChainDemoPayment({ sdk, rpc, privateKey: payerKey,
      address: addressForScriptPublicKey(payerScript, 'kaspa:testnet-10'), url, quote, fetcher });
    const result = await payment.run();
    assert.equal(result.resource.access, 'granted');
    assert.equal((await payment.run()).transactionId, result.transactionId);
    results.push(result.transactionId);
  }
  assert.equal(broadcasts, 2);
  assert.equal(grantRetryAfterFundingLoss, true);
  const savedRetry = lastPaidRequest.clone();
  await worker.dispose();
  worker = createWorker();
  const retry = await fetcher(savedRetry);
  assert.equal(retry.status, 200, await retry.clone().text());
  assert.equal((await retry.json()).transactionId, results[1]);
  const status = await (await worker.dispatchFetch(`${base}/hash-chain/status`)).json();
  assert.equal(status.headVersion, 2);
  assert.equal(status.headAmount, '140000000');
  reorged = true;
  const rejectedRetry = await worker.dispatchFetch(savedRetry.url, {
    method: savedRetry.method, headers: savedRetry.headers,
  });
  assert.notEqual(rejectedRetry.status, 200, 'a reorged accepting block must not return cached paid content');
  console.log(JSON.stringify({ ok: true, chain: 'simulated', runtime: 'Cloudflare Worker with SQLite Durable Object',
    payments: 2, broadcasts, grantRetryAfterFundingLoss, paidRetryAfterRestart: true, reorgedRetryRejected: true,
    existingExactAndBatchOffers: true, callerIsolation: true }, null, 2));
} catch (error) {
  console.error(error.stack?.split('\n').slice(0,5).join('\n') ?? String(error));
  let cause = error;
  for (let index = 0; cause && index < 4; index++) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    cause = cause.cause ?? cause.details?.cause;
  }
  process.exitCode = 1;
} finally {
  await worker.dispose();
  rmSync(folder, { recursive: true, force: true });
}

function rpcResult(method, params) {
  const block = (height) => ({ header: { hash: hashAt(height), blueScore: String(100 + height), daaScore: String(1000000 + height) },
    verboseData: { hash: hashAt(height), isChainBlock: !reorged, selectedParentHash: hashAt(Math.max(0, height - 1)) } });
  if (method === 'getServerInfo') return { networkId: 'testnet-10', isSynced: true };
  if (method === 'getBlockDagInfo') return { sink: hashAt(selectedHeight) };
  if (method === 'getBlock') return { block: block(Number.parseInt(params.hash, 16)) };
  if (method === 'getUtxosByAddresses') return { entries: [...utxos.values()]
    .filter((item) => params.addresses.includes(item.address))
    .map((item) => ({ outpoint: item.outpoint, utxoEntry: { ...item.utxoEntry,
      scriptPublicKey: { version: 0, script: item.utxoEntry.scriptPublicKey.scriptPublicKey } } })) };
  if (method === 'getVirtualChainFromBlock') {
    const heights = Array.from({ length: selectedHeight - Number.parseInt(params.startHash, 16) },
      (_, index) => Number.parseInt(params.startHash, 16) + index + 1);
    return { removedChainBlockHashes: [], addedChainBlockHashes: heights.map(hashAt),
      acceptedTransactionIds: heights.map(height => ({ acceptingBlockHash: hashAt(height),
        acceptedTransactionIds: (acceptedBlocks.get(height) ?? []).map(tx => tx.transactionId) })) };
  }
  if (method === 'getVirtualChainFromBlockV2') {
    const heights = Array.from({ length: selectedHeight - Number.parseInt(params.startHash, 16) },
      (_, index) => Number.parseInt(params.startHash, 16) + index + 1)
      .filter(height => height <= selectedHeight - params.minConfirmationCount);
    assert(heights.length <= 3, 'full transaction readback must start at the payment accepting block parent');
    selectedHeight++; // The live tip keeps moving; fetching until an empty page never converges.
    return { removedChainBlockHashes: [], addedChainBlockHashes: heights.map(hashAt),
      chainBlockAcceptedTransactions: heights.map((height) => ({ chainBlockHeader: block(height).header,
        acceptedTransactions: acceptedBlocks.get(height) ?? [] })) };
  }
  throw new Error(`Unexpected simulated PNN method: ${method}`);
}

function recordTransaction(id, inputs, outputs) {
  transactions.set(id, { transaction_id: id, is_accepted: true, accepting_block_hash: blockHash,
    inputs: inputs.map((input) => ({ previous_outpoint_hash: input.transactionId, previous_outpoint_index: input.index })),
    outputs: outputs.map((output, index) => ({ index, amount: output.value, script_public_key: output.scriptPublicKey,
      covenant: output.covenant })),
  });
  outputs.forEach((output, index) => utxos.set(`${id}:${index}`, {
    address: addressForScriptPublicKey(output.scriptPublicKey, 'kaspa:testnet-10'),
    outpoint: { transactionId: id, index }, utxoEntry: { amount: output.value,
      scriptPublicKey: { scriptPublicKey: output.scriptPublicKey.slice(4) }, covenantId: output.covenant?.covenantId },
  }));
}
