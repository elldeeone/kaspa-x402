import test from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bindRequestHashToTrustedContext, sha256Hex, stableStringify } from '@kaspa-x402/core';
import { hashChainGrantClaimDigest } from '@kaspa-x402/server/hash-chain-grants';
import { createHashChainDemoFixture, TEST_PAYER_KEY } from './hash-chain-demo-fixture.mjs';
import { createHashChainDemoPayment, readHashChainQuote } from '../site/dist/assets/hash-chain-client.js';

test('one caller exhausting unpaid quotes does not block another caller', async () => {
  const origin = 'http://127.0.0.1:9878';
  const fixture = await createHashChainDemoFixture(origin);
  const quote = (caller, payment) => fixture.fetch(`${origin}/hash-chain/report?payment=${payment}`, {
    headers: { 'x-kaspa-x402-demo-caller': caller.repeat(32) },
  });
  try {
    for (let index = 0; index < 4; index++) {
      assert.equal((await quote('aa', index)).status, 402);
    }
    assert.equal((await quote('aa', 4)).status, 503, 'the original caller keeps its four-quote limit');
    assert.equal((await quote('bb', 'second-caller')).status, 402, 'another caller must still get a quote');
    assert.equal((await quote('aa', 0)).status, 402, 'an existing quote remains usable');
    assert.equal(fixture.state.phase, 'ready');
  } finally { await fixture.close(); }
});

test('an unfunded self-signed claimant cannot reserve the sole grant', async () => {
  const origin = 'http://127.0.0.1:9879';
  const fixture = await createHashChainDemoFixture(origin);
  const caller = 'ef'.repeat(32);
  const url = `${origin}/hash-chain/report?unfunded=1`;
  const key = Buffer.alloc(32, 9);
  try {
    const quote = readHashChainQuote(await fixture.fetch(url, {
      headers: { 'x-kaspa-x402-demo-caller': caller },
    }));
    const requestHash = bindRequestHashToTrustedContext(
      sha256Hex(stableStringify({ method: 'GET', url, body: null })),
      quote.trustedSecurityContext,
    );
    const unsigned = {
      grantId: quote.accepted.extra.grantId,
      challengeId: quote.accepted.extra.challengeId,
      requestHash,
      payerPublicKey: Buffer.from(schnorr.getPublicKey(key)).toString('hex'),
      expiresAt: quote.accepted.extra.challengeExpiresAt,
    };
    const response = await fixture.fetch(`${origin}/hash-chain/grant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kaspa-x402-demo-caller': caller },
      body: JSON.stringify({ ...unsigned, signature: Buffer.from(schnorr.sign(
        hashChainGrantClaimDigest('kaspa:testnet-10', unsigned), key,
      )).toString('hex') }),
    });
    assert.equal(response.status, 409);
    assert.equal(fixture.state.phase, 'ready');
  } finally { await fixture.close(); }
});

test('assigned grant retries survive funding loss and restart but still require the authenticated caller and unspent head', async () => {
  const origin = 'http://127.0.0.1:9880';
  const fixture = await createHashChainDemoFixture(origin);
  const caller = 'ef'.repeat(32);
  const url = `${origin}/hash-chain/report?grant-retry=1`;
  const key = Buffer.from(TEST_PAYER_KEY, 'hex');
  try {
    const funding = fixture.funding().entries[0].outpoint;
    const quote = readHashChainQuote(await fixture.fetch(url, {
      headers: { 'x-kaspa-x402-demo-caller': caller },
    }));
    const unsigned = {
      grantId: quote.accepted.extra.grantId,
      challengeId: quote.accepted.extra.challengeId,
      requestHash: bindRequestHashToTrustedContext(
        sha256Hex(stableStringify({ method: 'GET', url, body: null })),
        quote.trustedSecurityContext,
      ),
      payerPublicKey: Buffer.from(schnorr.getPublicKey(key)).toString('hex'),
      expiresAt: quote.accepted.extra.challengeExpiresAt,
    };
    const body = JSON.stringify({ ...unsigned, signature: Buffer.from(schnorr.sign(
      hashChainGrantClaimDigest('kaspa:testnet-10', unsigned), key,
    )).toString('hex') });
    const claim = (identity = caller) => fixture.fetch(`${origin}/hash-chain/grant`, {
      method: 'POST', headers: {
        'content-type': 'application/json', 'x-kaspa-x402-demo-caller': identity,
      }, body,
    });
    const first = await claim();
    assert.equal(first.status, 200);
    const grant = await first.json();
    const head = fixture.state.head;
    fixture.spend({ txid: funding.transactionId, index: funding.index });
    await fixture.reopen();

    const retry = await claim();
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), grant);
    assert.equal(fixture.state.phase, 'assigned');
    assert.deepEqual(fixture.state.head, head);
    assert.equal((await claim('ab'.repeat(32))).status, 409);

    fixture.spend(head.outpoint);
    assert.equal((await claim()).status, 409);
    assert.equal(fixture.state.phase, 'hold');
  } finally { await fixture.close(); }
});

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
