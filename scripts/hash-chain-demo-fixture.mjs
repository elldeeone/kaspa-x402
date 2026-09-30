import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { generateHashChainBorrowGrants, hashChainHeadScriptPublicKey } from '@kaspa-x402/covenant';
import { HashChainGrantIssuer } from '@kaspa-x402/server/hash-chain-grants';
import { createHashChainDemoHandler } from './hash-chain-demo-service.mjs';
import { openHashChainDemoStore } from './hash-chain-demo-store.mjs';
import { addressForScriptPublicKey, scriptPublicKeyForAddress, readHashChainQuote } from '../site/dist/assets/hash-chain-client.js';

export const TEST_PAYER_KEY = '07'.repeat(32);
const owner = Buffer.from(schnorr.getPublicKey(Buffer.alloc(32, 8))).toString('hex');
const payerScript = `000020${Buffer.from(schnorr.getPublicKey(Buffer.from(TEST_PAYER_KEY, 'hex'))).toString('hex')}ac`;
const HEAD_ID = 'aa'.repeat(32);
const COVENANT_ID = 'de'.repeat(32);

/** Simulated chain only. Real encrypted issuer, HTTP handler, and signatures. */
export async function createHashChainDemoFixture(publicBaseUrl) {
  const folder = mkdtempSync(path.join(tmpdir(), 'hash-chain-demo-'));
  const encryptionKey = randomBytes(32);
  let now = Date.now();
  let issuer;
  let handler;
  let payments;
  let broadcasts = 0;
  let protectedCalls = 0;
  let fundingIndex = 1;
  const origins = new Map();
  const selected = new Map();
  const chainView = {
    async getAcceptedOrigins(outpoints) { return outpoints.map((item) => origins.get(`${item.txid}:${item.index}`) ?? null); },
    async getSelectedTransaction(txid) { return selected.get(txid) ?? null; },
    async isSelected(txid) { return selected.has(txid); },
  };
  async function reopen() {
    issuer?.close();
    await payments?.close();
    issuer = await HashChainGrantIssuer.open({ databasePath: path.join(folder, 'grants.sqlite'), encryptionKey,
      canClaim: () => true, now: () => new Date(now) });
    payments = await openHashChainDemoStore(path.join(folder, 'payments.sqlite'));
    handler = createHashChainDemoHandler({ issuer, headId: HEAD_ID, publicBaseUrl,
      store: payments.store,
      payTo: 'kaspatest:merchant', ownerPublicKey: owner, chainView,
      addressCodec: { scriptPublicKeyForAddress,
        encodeScriptAddress: ({ serializedScriptPublicKey }) => addressForScriptPublicKey(serializedScriptPublicKey, 'kaspa:testnet-10') },
      protectedHandler: ({ payment }) => {
        protectedCalls++;
        return { status: 200, body: { access: 'granted', resource: 'hash-chain demo report',
          network: 'kaspa:testnet-10', transactionId: payment.transactionId,
          amountSompi: payment.accepted.amount } };
      },
      getCurrentUtxo: async (outpoint) => {
        const current = issuer.getCurrent(HEAD_ID).head;
        return current.outpoint.txid === outpoint.txid && current.outpoint.index === outpoint.index
          ? { outpoint, amount: current.amount, scriptPublicKey: current.scriptPublicKey, covenantId: COVENANT_ID } : null;
      },
    });
  }
  await reopen();
  const grants = generateHashChainBorrowGrants(4);
  const head = { outpoint: { txid: '11'.repeat(32), index: 0 }, amount: '100000000',
    guard: grants.initialGuard, scriptPublicKey: hashChainHeadScriptPublicKey({ ownerPublicKey: owner, guard: grants.initialGuard }), covenantId: COVENANT_ID };
  issuer.installHead({ headId: HEAD_ID, ownerPublicKey: owner, network: 'kaspa:testnet-10', head, grants: grants.grants });
  origins.set(`${head.outpoint.txid}:0`, { amount: head.amount, scriptPublicKey: head.scriptPublicKey, covenantId: COVENANT_ID });
  const fixture = {
    get state() { return issuer.getCurrent(HEAD_ID); },
    get broadcasts() { return broadcasts; },
    get protectedCalls() { return protectedCalls; },
    funding() {
      const transactionId = String(fundingIndex++).padStart(64, '0');
      origins.set(`${transactionId}:0`, { amount: '50000000', scriptPublicKey: payerScript, covenantId: null });
      return { entries: [{ outpoint: { transactionId, index: 0 }, amount: '50000000', covenantId: null }] };
    },
    broadcast(artifact) {
      const tx = JSON.parse(artifact);
      const first = tx.inputs[0];
      const output = tx.outputs[0];
      selected.set(tx.id, { transactionId: tx.id, finality: 'accepted',
        spentHead: { txid: first.transactionId, index: first.index },
        successor: { amount: output.value, scriptPublicKey: output.scriptPublicKey,
          covenantId: output.covenant.covenantId, authorizingInput: output.covenant.authorizingInput } });
      origins.set(`${tx.id}:0`, { amount: output.value, scriptPublicKey: output.scriptPublicKey, covenantId: output.covenant.covenantId });
      broadcasts++;
      return { transactionId: tx.id };
    },
    reopen,
    async fetch(request, init) {
      const target = request instanceof Request ? request : new Request(request, init);
      if (!target.headers.has('x-kaspa-x402-demo-caller')) {
        target.headers.set('x-kaspa-x402-demo-caller', 'cd'.repeat(32));
      }
      const response = await handler(target);
      Object.defineProperty(response, 'url', { value: target.url });
      return response;
    },
    async abandonAndRotate() {
      const response = await fixture.fetch(`${publicBaseUrl}/hash-chain/report?abandon=1`);
      const { accepted, trustedSecurityContext } = readHashChainQuote(response);
      // Use the same request hashing as the real client for a signed grant claim.
      const { DirectModeClient } = await import('@kaspa-x402/client');
      const { claimHashChainGrantViaHttp } = await import('@kaspa-x402/client');
      const key = Buffer.from(TEST_PAYER_KEY, 'hex');
      const payerPublicKey = Buffer.from(schnorr.getPublicKey(key)).toString('hex');
      let claimed;
      const client = new DirectModeClient({
        fundingProvider: { networkId: 'kaspa:testnet-10', sourceKind: 'hot-wallet',
          async getPublicIdentity() { return { address: 'kaspatest:payer', publicKey: payerPublicKey }; },
          async claimHashChainGrant(request) {
            claimed = await claimHashChainGrantViaHttp(request, (digest) =>
              Buffer.from(schnorr.sign(Buffer.from(digest, 'hex'), key)).toString('hex'), fixture.fetch);
            return claimed;
          },
          async payHashChainTransaction() { throw new Error('Deliberately abandoned after grant delivery'); },
          async finalizeExactPaymentAttempt() {},
        },
        signer: {}, store: new (await import('@kaspa-x402/client')).MemoryChannelStore(), addressCodec: { scriptPublicKeyForAddress },
        fundingPolicy: { allowedOrigins: [publicBaseUrl], allowedExactProfiles: ['hash-chain-additive'] },
        hashChainGrantDestinationPolicy: { allowedOrigins: [publicBaseUrl] }, confirmationThreshold: 30,
      });
      try { await client.createPayment(response.headers.get('PAYMENT-REQUIRED'), {
        url: accepted.grantClaimUrl ?? `${publicBaseUrl}/hash-chain/report?abandon=1`,
        trustedSecurityContext, paymentIdentifier: 'abandoned_demo_payment',
      }); } catch (error) {
        if (!claimed) throw error;
      }
      now = Date.parse(accepted.extra.challengeExpiresAt) + 1;
      issuer.markAbandoned(HEAD_ID);
      const before = issuer.getCurrent(HEAD_ID).head;
      const replacement = generateHashChainBorrowGrants(2);
      const successor = { ...before, outpoint: { txid: '99'.repeat(32), index: 0 },
        guard: replacement.initialGuard, scriptPublicKey: hashChainHeadScriptPublicKey({ ownerPublicKey: owner, guard: replacement.initialGuard }) };
      issuer.recordAcceptedRotation(HEAD_ID, { finality: 'accepted', predecessor: before.outpoint, successor }, replacement.grants);
      origins.set(`${successor.outpoint.txid}:0`, { amount: successor.amount, scriptPublicKey: successor.scriptPublicKey, covenantId: COVENANT_ID });
    },
    async close() { await payments.close(); issuer.close(); rmSync(folder, { recursive: true, force: true }); },
  };
  return fixture;
}
