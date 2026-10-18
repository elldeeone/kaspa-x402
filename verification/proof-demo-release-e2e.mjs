import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { WebSocketServer } from 'ws';
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
const peer = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await new Promise(r => peer.once('listening', r));
const endpoint = `ws://127.0.0.1:${peer.address().port}/wrpc/json`;
peer.on('connection', ws => { connections++; ws.on('message', raw => {
  upstreamCalls++;
  const { id, method, params } = JSON.parse(raw.toString());
  if (params?.hash === 'oversize') {
    ws.send('a'.repeat(2_200_000), { fin: false });
    ws.send('b'.repeat(2_200_000), { fin: true }); return;
  }
  if (params?.hash === 'timeout') return;
  const result = method === 'getServerInfo'
    ? { networkId: 'testnet-10', isSynced: true, hasUtxoIndex: true, virtualDaaScore: '1000000' }
    : method === 'getUtxosByAddresses' ? { entries: [] }
    : { network: 'testnet-10', pruningPointHash: '11'.repeat(32), virtualDaaScore: '1000000' };
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
