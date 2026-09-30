import test from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { hashChainGrantClaimDigest } from '@kaspa-x402/server/hash-chain-grants';
import { createHashChainDemoFixture, TEST_PAYER_KEY } from './hash-chain-demo-fixture.mjs';
import { createHashChainDemoPayment, readHashChainQuote } from '../site/dist/assets/hash-chain-client.js';

test('bundled browser client pays twice, preserves paid retries across restart and expiry, and supports manual rotation', async (t) => {
  const origin = 'http://127.0.0.1:9876';
  const fixture = await createHashChainDemoFixture(origin);
  const sdk = { Transaction: { deserializeFromSafeJSON(artifact) {
    return { id: JSON.parse(artifact).id, artifact, free() {} };
  } } };
  const rpc = {
    async getServerInfo() { return { networkId: 'testnet-10', isSynced: true }; },
    async getUtxosByAddresses() { return fixture.funding(); },
    async submitTransaction({ transaction }) { return fixture.broadcast(transaction.artifact); },
  };
  let lastPaidRequest;
  let lastResult;
  let lastExpiry;
  try {
    for (let index = 0; index < 2; index++) {
      const url = `${origin}/hash-chain/report?payment=${index}`;
      const quote = readHashChainQuote(await fixture.fetch(url));
      const payment = createHashChainDemoPayment({ sdk, rpc, privateKey: TEST_PAYER_KEY,
        address: 'kaspatest:payer', url, quote, fetcher: async (input, init) => {
          const response = await fixture.fetch(input, init);
          if (new Headers(init?.headers).has('PAYMENT-SIGNATURE')) {
            lastPaidRequest = new Request(input, init);
            assert.equal(response.status, 200, await response.clone().text());
            assert.ok(response.headers.get('PAYMENT-RESPONSE'), await response.clone().text());
          }
          return response;
        } });
      const result = await payment.run();
      lastResult = result;
      lastExpiry = quote.accepted.extra.challengeExpiresAt;
      assert.equal(result.resource.access, 'granted');
      assert.equal(result.resource.amountSompi, '20000000');
      assert.equal(result.headAfter.amount, String(120_000_000 + index * 20_000_000));
      assert.equal(fixture.broadcasts, index + 1);
      assert.equal(fixture.protectedCalls, index + 1);
      await fixture.reopen();
      const retry = await payment.run();
      assert.equal(retry.transactionId, result.transactionId);
      assert.equal(fixture.broadcasts, index + 1);
      assert.equal(fixture.protectedCalls, index + 1, 'restart must not run protected work twice');
    }
    assert.equal(fixture.state.headVersion, 2);
    await fixture.abandonAndRotate();
    assert.equal(fixture.state.phase, 'ready');
    assert.equal(fixture.state.headVersion, 3);
    t.mock.method(Date, 'now', () => Date.parse(lastExpiry) + 1);
    await fixture.reopen();
    const lateRetry = await fixture.fetch(lastPaidRequest);
    assert.equal(lateRetry.status, 200, await lateRetry.clone().text());
    assert.deepEqual(await lateRetry.json(), lastResult.resource);
    assert.equal(lateRetry.headers.get('PAYMENT-RESPONSE'), lastResult.paymentHeader);
    assert.equal(fixture.protectedCalls, 2);
    assert.equal(fixture.broadcasts, 2);
  } finally { await fixture.close(); }
});

test('a shorter delivered grant expires independently of its public challenge', async (t) => {
  const schedule = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) =>
    schedule(callback, delay === 1000 ? 0 : delay, ...args));
  const fixture = await createHashChainDemoFixture('http://127.0.0.1:9877');
  const key = Buffer.from(TEST_PAYER_KEY, 'hex');
  let grantExpiry;
  let paidResponse;
  const sdk = { Transaction: { deserializeFromSafeJSON(artifact) {
    return { id: JSON.parse(artifact).id, artifact, free() {} };
  } } };
  const rpc = {
    async getServerInfo() { return { networkId: 'testnet-10', isSynced: true }; },
    async getUtxosByAddresses() { return fixture.funding(); },
    async submitTransaction({ transaction }) {
      const result = fixture.broadcast(transaction.artifact);
      t.mock.method(Date, 'now', () => Date.parse(grantExpiry) + 1);
      return result;
    },
  };
  try {
    const url = 'http://127.0.0.1:9877/hash-chain/report?short-grant=1';
    const quote = readHashChainQuote(await fixture.fetch(url));
    const payment = createHashChainDemoPayment({ sdk, rpc, privateKey: TEST_PAYER_KEY,
      address: 'kaspatest:payer', url, quote, fetcher: async (input, init) => {
        if (new URL(input).pathname === '/hash-chain/grant') {
          const claim = JSON.parse(init.body);
          grantExpiry = new Date(Date.now() + 10_000).toISOString();
          claim.expiresAt = grantExpiry;
          claim.signature = Buffer.from(schnorr.sign(hashChainGrantClaimDigest('kaspa:testnet-10', claim), key)).toString('hex');
          init = { ...init, body: JSON.stringify(claim) };
        }
        const response = await fixture.fetch(input, init);
        if (new Headers(init?.headers).has('PAYMENT-SIGNATURE')) paidResponse = response.clone();
        return response;
      } });
    await assert.rejects(payment.run());
    assert.ok(Date.now() < Date.parse(quote.accepted.extra.challengeExpiresAt));
    assert.notEqual(paidResponse.status, 200);
    assert.equal(fixture.protectedCalls, 0);
    assert.equal(fixture.state.headVersion, 0);
  } finally { await fixture.close(); }
});
