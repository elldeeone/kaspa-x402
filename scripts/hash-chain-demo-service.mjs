import {
  DirectModeServer, HashChainExactTransactionVerifier,
  handleHashChainGrantClaimHttp,
} from '@kaspa-x402/server';

const CALLER_HEADER = 'X-KASPA-X402-DEMO-CALLER';

/** Thin Node host; its caller header is trusted only after proxy authentication. */
export function createHashChainDemoHandler({ issuer, headId, publicBaseUrl, payTo,
  ownerPublicKey, addressCodec, chainView, getCurrentUtxo, getPayerFundingUtxo,
  amount = '20000000', claimFeeSompi = '1000000',
  maxTimeoutSeconds = 150, store,
  protectedHandler = ({ payment }) => ({ status: 200, body: {
    access: 'granted', resource: 'hash-chain demo report', network: 'kaspa:testnet-10',
    transactionId: payment.transactionId, amountSompi: payment.accepted.amount,
  } }) }) {
  if (!store) throw new Error('Demo payment store is required');
  if (typeof getPayerFundingUtxo !== 'function') throw new Error('Demo payer funding observer is required');
  const base = new URL(publicBaseUrl);
  if ((base.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) ||
    base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('Demo public URL must be an HTTPS origin, or loopback HTTP for local checks.');
  }
  const server = new DirectModeServer({
    network: 'kaspa:testnet-10', payTo, serverPublicKey: ownerPublicKey,
    amount, minDepositSompi: '1000', claimReserveSompi: '10',
    refundTimeoutDaa: '1000', minimumRefundLeadDaa: '0',
    confirmationThreshold: 30, maxTimeoutSeconds, acceptedFinality: 'accepted',
    store,
    chainProvider: { async getVirtualDaaScore() { return '0'; },
      async sendTransaction() { throw new Error('Hash-chain payer must broadcast.'); } },
    addressCodec, voucherVerifier: { verifyVoucher: () => false },
    batchPresentationVerifier: { verifyPresentation: () => false },
    exactProfile: 'hash-chain-additive', hashChainIssuer: issuer,
    hashChainHeadId: headId, hashChainGrantClaimUrl: `${base.origin}/hash-chain/grant`,
    exactTransactionVerifier: new HashChainExactTransactionVerifier(chainView),
    admitHashChainChallenge: () => true,
    hashChainGetCurrentUtxo: async (outpoint, signal, claim) => {
      if (claim && issuer.getCurrent(headId).phase === 'ready') {
        const challenge = issuer.getChallenge(headId, claim.challengeId);
        const required = challenge
          ? String(BigInt(challenge.quotedAmount) + BigInt(claimFeeSompi))
          : undefined;
        if (!required || !await getPayerFundingUtxo(claim.payerPublicKey, required, signal)) {
          throw new Error('payer has no eligible funding UTXO');
        }
      }
      return getCurrentUtxo(outpoint, signal, claim);
    },
    hashChainIsSelected: (id, signal) => chainView.isSelected(id, { signal }),
  });
  return async (request) => {
    const incoming = new URL(request.url);
    const url = new URL(incoming.pathname + incoming.search, base).href;
    if (incoming.pathname === '/hash-chain/grant') {
      const caller = request.headers.get(CALLER_HEADER);
      if (!/^[0-9a-f]{64}$/.test(caller ?? '')) return json({ error: 'hash_chain_unavailable' }, 503);
      return handleHashChainGrantClaimHttp(
        server,
        new Request(url, request),
        { principal: `public-hash-chain-demo:${caller}` },
      );
    }
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    if (incoming.pathname === '/hash-chain/status' || incoming.pathname === '/hash-chain/supported') {
      const current = issuer.getCurrent(headId);
      const available = current.phase === 'ready' && !!await getCurrentUtxo(current.head.outpoint, request.signal);
      if (incoming.pathname.endsWith('/supported')) return json({ kinds: available ? [{
        x402Version: 2, scheme: 'exact', network: 'kaspa:testnet-10',
        extra: { asset: 'KAS', binding: 'kaspa-hash-chain-exact-v1', profile: 'hash-chain-additive',
          templateId: 'kaspa-x402-hash-chain-head-v2', modes: ['verify', 'settle'],
          transactionEncoding: 'kaspa-sdk-safe-json-v2.0.0' },
      }] : [] });
      return json({ available, phase: current.phase, headVersion: current.headVersion,
        headAmount: current.head.amount, network: 'kaspa:testnet-10' });
    }
    if (!['/hash-chain', '/hash-chain/report'].includes(incoming.pathname)) return json({ error: 'not_found' }, 404);
    const caller = request.headers.get(CALLER_HEADER);
    if (!/^[0-9a-f]{64}$/.test(caller ?? '')) return json({ error: 'hash_chain_unavailable' }, 503);
    const trustedSecurityContext = { principal: `public-hash-chain-demo:${caller}` };
    const answer = await server.handlePaidRequest({ routeAccess: "authenticated",
      method: 'GET', url, headers: Object.fromEntries(request.headers),
      resource: { url, description: 'Native-KAS hash-chain demo report', mimeType: 'application/json' },
      paymentScheme: 'exact', trustedSecurityContext, signal: request.signal,
    }, protectedHandler);
    return json(answer.body, answer.status, { ...answer.headers, [CALLER_HEADER]: caller });
  };
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: {
    ...headers, 'content-type': 'application/json', 'cache-control': 'no-store',
  } });
}
