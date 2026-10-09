import { schnorr } from '@noble/curves/secp256k1.js';
import { Buffer } from 'buffer';
import {
  DirectModeClient, MemoryChannelStore, PendingExactPaymentError,
  claimHashChainGrantViaHttp, signHashChainExactTransaction,
} from '@kaspa-x402/client';
import { decodePaymentRequiredHeader, validateKaspaPaymentRequirement } from '@kaspa-x402/core';
import { scriptPublicKeyForAddress, addressForScriptPublicKey } from '@kaspa-x402/adapters/native';
// Demo transport header, shared on the wire with the gateway (not part of x402).
const HASH_CHAIN_CALLER_HEADER = 'X-KASPA-X402-DEMO-CALLER';
export { addressForScriptPublicKey, scriptPublicKeyForAddress };

export const DEMO_FEE_SOMPI = '1000000';
export const DEMO_MAX_FEE_SOMPI = '10000000';

export function isHashChainRequirement(entry) {
  return entry?.extra?.profile === 'hash-chain-additive' && validateKaspaPaymentRequirement(entry).ok;
}

export function readHashChainQuote(response) {
  if (response.status !== 402) throw new Error('Hash-chain demo is busy or unavailable. Try again after the operator resets it.');
  const header = response.headers.get('PAYMENT-REQUIRED');
  if (!header) throw new Error('The gateway did not return a payment quote.');
  const required = decodePaymentRequiredHeader(header);
  const accepted = required.accepts.find((item) => item.scheme === 'exact' &&
    item.network === 'kaspa:testnet-10' && item.extra.profile === 'hash-chain-additive');
  if (!accepted) throw new Error('This gateway does not offer hash-chain exact.');
  const caller = response.headers.get(HASH_CHAIN_CALLER_HEADER);
  if (!/^[0-9a-f]{64}$/.test(caller ?? '')) throw new Error('The gateway did not return the demo caller identity.');
  return { header, required, accepted, trustedSecurityContext: { principal: `public-hash-chain-demo:${caller}` } };
}

/** One in-memory logical payment. Retry always retains its signed transaction. */
export function createHashChainDemoPayment({ sdk, rpc, privateKey, address, url, quote, fetcher = fetch }) {
  const key = Buffer.from(privateKey, 'hex');
  const payerPublicKey = Buffer.from(schnorr.getPublicKey(key)).toString('hex');
  const payerScript = `000020${payerPublicKey}ac`;
  const attempts = new Map();
  const submitted = new Set();
  const origin = new URL(url).origin;
  const paymentIdentifier = globalThis.crypto.randomUUID().replaceAll('-', '_');
  let firstQuote = true;
  let funding;
  async function prepareFunding(amount) {
    if (funding) return funding;
    const info = await rpc.getServerInfo();
    if (String(info.networkId) !== 'testnet-10' || !info.isSynced) throw new Error('Connect to a synced Testnet-10 node.');
    const { entries } = await rpc.getUtxosByAddresses([address]);
    const candidates = entries.map((entry) => {
      const value = entry.entry ?? entry;
      const outpoint = value.outpoint ?? entry.outpoint;
      return { outpoint: { txid: String(outpoint.transactionId), index: Number(outpoint.index) },
        amount: String(value.amount), covenantId: value.covenantId ?? entry.covenantId };
    }).filter((item) => (!item.covenantId || /^0{64}$/.test(item.covenantId)) &&
      BigInt(item.amount) >= BigInt(amount) + BigInt(DEMO_FEE_SOMPI))
      .sort((a, b) => BigInt(a.amount) < BigInt(b.amount) ? -1 : 1);
    if (!candidates.length) throw new Error('Fund this testnet address with enough KAS for the quote and fee.');
    funding = candidates[0];
    return funding;
  }
  const client = new DirectModeClient({
    addressCodec: { scriptPublicKeyForAddress },
    fundingProvider: {
      networkId: 'kaspa:testnet-10',
      sourceKind: 'hot-wallet',
      async getPublicIdentity() {
        return { address, publicKey: payerPublicKey };
      },
      async claimHashChainGrant(request) {
        // Check the wallet before consuming the demo's only available grant.
        await prepareFunding(quote.accepted.amount);
        return claimHashChainGrantViaHttp(
          request,
          (digest) => Buffer.from(schnorr.sign(Buffer.from(digest, 'hex'), key)).toString('hex'),
          fetcher,
        );
      },
      async payHashChainTransaction(request) {
        const saved = attempts.get(request.attemptId);
        if (saved) return saved;
        const selected = await prepareFunding(request.amount);
        const result = signHashChainExactTransaction({
          request,
          funding: { ...selected, scriptPublicKey: payerScript, privateKey, payerAddress: address },
          feeSompi: DEMO_FEE_SOMPI,
        });
        attempts.set(request.attemptId, result);
        return result;
      },
      async finalizeExactPaymentAttempt() {},
      async sendTransaction(artifact) {
        const transaction = sdk.Transaction.deserializeFromSafeJSON(artifact);
        try {
          const id = transaction.id;
          if (submitted.has(id)) return { transactionId: id };
          const result = await rpc.submitTransaction({ transaction, allowOrphan: false });
          if (String(result.transactionId).toLowerCase() !== id.toLowerCase())
            throw new Error('Broadcast returned a different transaction ID.');
          submitted.add(id);
          return { transactionId: id };
        } finally {
          transaction.free();
        }
      },
    },
    store: new MemoryChannelStore(),
    fundingPolicy: {
      requiredSource: 'hot-wallet',
      allowedOrigins: [origin],
      allowedExactProfiles: ['hash-chain-additive'],
      maximumExactAmountSompi: quote.accepted.amount,
      allowedPayTo: [quote.accepted.payTo],
    },
    hashChainGrantDestinationPolicy: { allowedOrigins: [origin] },
    confirmationThreshold: 30,
    fetch: async (input, init) => {
      if (firstQuote && !new Headers(init?.headers).has('PAYMENT-SIGNATURE')) {
        firstQuote = false;
        const response = new Response('{}', {
          status: 402,
          headers: { 'PAYMENT-REQUIRED': quote.header },
        });
        Object.defineProperty(response, 'url', { value: input });
        return response;
      }
      return fetcher(input, init);
    },
  });
  return {
    async run() {
      let lastPending;
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          const result = await client.paidFetch(url, { paymentIdentifier, trustedSecurityContext: quote.trustedSecurityContext });
          if (result.response.status !== 200 || !result.settlement?.response.success) throw new Error('The gateway did not confirm payment.');
          const prepared = [...attempts.values()].find((item) => item.transactionId === result.payment.transactionId);
          const artifact = JSON.parse(prepared.transaction);
          const feeSompi = String(artifact.inputs.reduce((sum, item) => sum + BigInt(item.utxo.amount), 0n) -
            artifact.outputs.reduce((sum, item) => sum + BigInt(item.value), 0n));
          return { transactionId: result.payment.transactionId, resource: await result.response.json(),
            feeSompi,
            paymentHeader: result.response.headers.get('PAYMENT-RESPONSE'),
            headBefore: { version: quote.accepted.extra.headVersion, amount: quote.accepted.extra.headAmount },
            headAfter: { version: String(BigInt(quote.accepted.extra.headVersion) + 1n),
              amount: String(BigInt(quote.accepted.extra.headAmount) + BigInt(quote.accepted.amount)) } };
        } catch (error) {
          if (!(error instanceof PendingExactPaymentError)) throw error;
          lastPending = error;
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
      throw new Error('Payment is still pending. Use Retry same payment; do not start another payment.', { cause: lastPending });
    },
  };
}
