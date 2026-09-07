import {
  DirectModeClient,
  MemoryChannelStore,
  exactPaymentAttemptIntentHash,
} from "@kaspa-x402/client";
import {
  X402_VERSION,
  encodePaymentRequiredHeader,
  exactRequestAuthorizationDigest,
  exactRequestAuthorizationId,
  sha256Hex,
  stableStringify,
} from "@kaspa-x402/core";
import { DirectModeFacilitator } from "@kaspa-x402/facilitator";
import { DirectModeServer, MemoryServerChannelStore } from "@kaspa-x402/server";
import {
  escrowScriptPublicKey,
  serializedScriptPublicKey,
  transactionV1CovenantId,
} from "@kaspa-x402/covenant";

export const NETWORK = "kaspa:testnet-10";
export const SERVER_PUBLIC_KEY = "11".repeat(32);
export const CLIENT_PUBLIC_KEY = "22".repeat(32);
export const REFUND_ADDRESS = "kaspatest:refund";
export const PAYOUT_ADDRESS = "kaspatest:payout";

export function createMockDirectModeEnvironment({
  requirePaymentIdentifier = false,
} = {}) {
  const chainProvider = new MockChainProvider();
  const fundingProvider = new MockFundingProvider(chainProvider);
  const addressCodec = new MockAddressCodec();
  const serverStore = new MemoryServerChannelStore();
  const clientStore = new MemoryChannelStore();
  const server = new DirectModeServer({
    network: NETWORK,
    payTo: PAYOUT_ADDRESS,
    serverPublicKey: SERVER_PUBLIC_KEY,
    amount: "100000",
    minDepositSompi: "4000000",
    claimReserveSompi: "2000000",
    refundTimeoutDaa: "1000",
    minimumRefundLeadDaa: "0",
    store: serverStore,
    chainProvider,
    addressCodec,
    channelSignatureVerifier: {
      verifySignature({ digest, signature }) {
        return signature === mockSignature(digest);
      },
    },
    exactTransactionVerifier: {
      verifyExactPayment(request) {
        const transactionId = mockHash(
          `chain-broadcast:${request.transaction}`,
        );
        return {
          transactionId,
          paymentOutput: {
            amount: request.amount,
            scriptPublicKey: request.payToScriptPublicKey,
          },
          payerAddress: REFUND_ADDRESS,
          finality: chainProvider.acceptedTransactions.has(request.transaction) ? "accepted" : "mempool",
          requestAuthorization: {
            authorizationId: exactRequestAuthorizationId(request.authorization),
            digest: request.authorization.digest,
            inputIndex: request.authorization.inputIndex,
            publicKey: CLIENT_PUBLIC_KEY,
          },
        };
      },
    },
    topUpVerifier: {
      verifyTopUp({ previous, next }) {
        return chainProvider.verifyCovenantTopUp({ previous, next });
      },
    },
    claimBuilder: {
      async buildClaimTransaction({ channel, claimAmount }) {
        const claimedCumulativeAmount = (
          BigInt(channel.claimedCumulativeAmount) + BigInt(claimAmount)
        ).toString();
        const payoutScriptPublicKey = addressCodec.scriptPublicKeyForAddress(
          channel.channelConfig.payTo,
          channel.channelConfig.network,
        );
        const refundScriptPublicKey = addressCodec.scriptPublicKeyForAddress(
          channel.channelConfig.refundAddress,
          channel.channelConfig.network,
        );
        const continuationScriptPublicKey = serializedScriptPublicKey(
          escrowScriptPublicKey({
            clientPublicKey: channel.channelConfig.clientPublicKey,
            serverPublicKey: channel.channelConfig.serverPublicKey,
            network: channel.channelConfig.network,
            payoutScriptPublicKeyHash: sha256Hex(
              Buffer.from(payoutScriptPublicKey, "hex"),
            ),
            refundScriptPublicKeyHash: sha256Hex(
              Buffer.from(refundScriptPublicKey, "hex"),
            ),
            timeoutDaa: channel.channelConfig.refundTimeoutDaa,
            settledTotal: claimedCumulativeAmount,
          }),
        );
        const transaction = mockHash(
          `claim:${channel.covenantId}:${claimedCumulativeAmount}`,
        );
        const continuationOutpoint = { txid: transaction, index: 1 };
        const continuationFundingAmount = (
          BigInt(channel.fundingAmount) - BigInt(claimAmount)
        ).toString();
        chainProvider.prepareTransaction(transaction, () => {
          chainProvider.deleteUtxo(channel.activeOutpoint);
          chainProvider.setUtxo({
            outpoint: continuationOutpoint,
            covenantId: channel.covenantId,
            amount: continuationFundingAmount,
            scriptPublicKey: continuationScriptPublicKey,
            finality: "accepted",
          });
        });
        return {
          transaction,
          transactionId: transaction,
          claimAmount,
          continuationOutpoint,
          continuationScriptPublicKey,
          continuationFundingAmount,
        };
      },
    },
    exactProfile: "standard-native",
    requirePaymentIdentifier,
  });
  const client = new DirectModeClient({
    fundingProvider,
    signer: new MockSigner(),
    store: clientStore,
    addressCodec,
    fetch: createMockPaidFetch(server),
    refundBuilder: {
      async buildRefundTransaction({ refundAmount, signDigest }) {
        await signDigest(mockHash(`refund-digest:${refundAmount}`));
        const transaction = mockTransaction(`refund:${refundAmount}`);
        return {
          transaction,
          transactionId: mockHash(`broadcast:${transaction}`),
          refundAmount,
        };
      },
    },
  });
  const facilitator = new DirectModeFacilitator({ server });

  return {
    addressCodec,
    chainProvider,
    client,
    clientStore,
    facilitator,
    fundingProvider,
    server,
    serverStore,
  };
}

export function createMockPaidFetch(server) {
  return async function mockPaidFetch(input, init = {}) {
    const url = String(input);
    const route = routeForUrl(url);
    const response = await server.handlePaidRequest(
      {
        method: init.method ?? "GET",
        url,
        body: init.body ?? null,
        headers: init.headers,
        resource: route.resource,
        paymentAmount: route.amount,
        paymentScheme: route.scheme,
        requestHash: init.requestHash,
      },
      async () => ({
        status: 200,
        body: route.body,
        chargedAmount: route.chargedAmount,
      }),
    );
    return new MockResponse(
      response.status,
      response.headers,
      response.body,
      url,
    );
  };
}

export function paymentRequiredFor(server, input) {
  return encodePaymentRequiredHeader(server.buildPaymentRequired(input));
}

export function mockRequestHash(input) {
  return sha256Hex(stableStringify(input));
}

export function mockHash(input) {
  return sha256Hex(`kaspa-x402-example:${input}`);
}

export function mockTransaction(input) {
  return `${mockHash(input)}${mockHash(`${input}:body`)}`;
}

export function mockSignature(digest) {
  return `${digest}${digest}`;
}

export class MockResponse {
  constructor(status, headers, body, url) {
    this.status = status;
    this.headers = new MockHeaders(headers);
    this.body = body;
    this.url = url;
    this.redirected = false;
  }

  async json() {
    return this.body;
  }

  async text() {
    return typeof this.body === "string"
      ? this.body
      : JSON.stringify(this.body);
  }
}

export class MockHeaders {
  constructor(headers = {}) {
    this.headers = new Map(
      Object.entries(headers).map(([key, value]) => [
        key.toLowerCase(),
        String(value),
      ]),
    );
  }

  get(name) {
    return this.headers.get(name.toLowerCase()) ?? null;
  }

  entries() {
    return this.headers.entries();
  }
}

class MockFundingProvider {
  networkId = NETWORK;
  sourceKind = "hot-wallet";
  nextIndex = 0;
  utxosByAddress = new Map();
  preparedTransitions = new Map();

  constructor(chainProvider) {
    this.chainProvider = chainProvider;
    this.exactPaymentAttempts = new Map();
  }

  async getPublicIdentity() {
    return {
      address: REFUND_ADDRESS,
      publicKey: CLIENT_PUBLIC_KEY,
    };
  }

  async authorizeBatchPayment() {}

  async prepareEscrowDeposit(request) {
    const authorizingInput = this.nextOutpoint("genesis-authorizer");
    const transaction = mockTransaction(`deposit:${authorizingInput.txid}`);
    const transactionId = mockHash(`broadcast:${transaction}`);
    const outpoint = { txid: transactionId, index: 0 };
    const covenantId = transactionV1CovenantId(authorizingInput, [
      {
        index: outpoint.index,
        output: {
          amount: request.amount,
          scriptPublicKey: request.escrowScriptPublicKey,
          covenant: null,
        },
      },
    ]);
    const utxo = {
      outpoint,
      covenantId,
      amount: request.amount,
      scriptPublicKey: request.escrowScriptPublicKey,
      finality: "accepted",
    };
    const genesisEvidence = {
      covenantId,
      authorizingInput,
      genesisOutpoint: outpoint,
      genesisScriptPublicKey: request.escrowScriptPublicKey,
      genesisAmount: request.amount,
      totalOutputCount: 1,
      authorizedOutputCount: 1,
    };
    this.preparedTransitions.set(transaction, () => {
      this.addAddressUtxo(request.escrowAddress, {
        ...utxo,
        address: request.escrowAddress,
      });
      this.chainProvider.setUtxo(utxo);
      this.chainProvider.setGenesisEvidence(outpoint, genesisEvidence);
    });
    return {
      transaction,
      transactionId,
      successor: {
        outpoint,
        covenantId,
        amount: request.amount,
        scriptPublicKey: request.escrowScriptPublicKey,
      },
      fundingSource: this.sourceKind,
    };
  }

  async prepareEscrowTopUp(request) {
    const previous = request.channel;
    const transaction = mockTransaction(
      `top-up:${previous.covenantId}:${this.nextIndex}`,
    );
    this.nextIndex += 1;
    const transactionId = mockHash(`broadcast:${transaction}`);
    const outpoint = { txid: transactionId, index: 0 };
    const utxo = {
      outpoint,
      covenantId: previous.covenantId,
      amount: request.targetFundingAmount,
      scriptPublicKey: previous.activeScriptPublicKey,
      finality: "accepted",
    };
    this.preparedTransitions.set(transaction, () => {
      this.removeAddressUtxo(previous.escrowAddress, previous.activeOutpoint);
      this.chainProvider.deleteUtxo(previous.activeOutpoint);
      this.addAddressUtxo(previous.escrowAddress, {
        ...utxo,
        address: previous.escrowAddress,
      });
      this.chainProvider.setUtxo(utxo);
      this.chainProvider.setTopUpEvidence(outpoint, {
        covenantId: previous.covenantId,
        spentOutpoint: previous.activeOutpoint,
        successorOutpoint: outpoint,
        successorScriptPublicKey: previous.activeScriptPublicKey,
        successorAmount: request.targetFundingAmount,
        authorizedSuccessorCount: 1,
      });
    });
    return {
      transaction,
      transactionId,
      successor: {
        outpoint,
        covenantId: previous.covenantId,
        amount: request.targetFundingAmount,
        scriptPublicKey: previous.activeScriptPublicKey,
      },
      fundingSource: this.sourceKind,
    };
  }

  async payExactTransaction(request) {
    const key = request.attemptId.toLowerCase();
    const intentHash = exactPaymentAttemptIntentHash(request);
    const existing = this.exactPaymentAttempts.get(key);
    if (existing) {
      if (existing.intentHash !== intentHash)
        throw new Error("exact payment attempt intent changed");
      return structuredClone(existing.result);
    }
    const paymentIdentity =
      request.profile === "additive"
        ? request.head?.challengeId
        : `${request.profile}:${request.payTo}:${request.amount}:${request.requestHash ?? "unbound"}`;
    if (!paymentIdentity)
      throw new Error("additive exact requires head challenge terms");
    const transaction = mockTransaction(`exact-transaction:${paymentIdentity}`);
    const transactionId = mockHash(`chain-broadcast:${transaction}`);
    const paymentOutputIndex =
      request.paymentOutputIndex ?? request.head?.paymentOutputIndex ?? 0;
    const inputIndex = request.profile === "additive" ? 1 : 0;
    const digest = exactRequestAuthorizationDigest({
      network: request.network,
      profile: request.profile,
      transactionId,
      paymentOutputIndex,
      amount: request.amount,
      payTo: request.payTo,
      payToScriptPublicKey: request.payToScriptPublicKey,
      paymentRequirementsHash: request.paymentRequirementsHash,
      requestHash: request.requestHash,
      challengeId: request.head?.challengeId,
      inputIndex,
      expiresAt: request.authorizationExpiresAt,
    });
    const result = {
      transaction,
      transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
      transactionId,
      paymentOutputIndex,
      authorization: {
        version: "kaspa-x402-exact-request-authorization-v1",
        inputIndex,
        expiresAt: request.authorizationExpiresAt,
        digest,
        signature: mockSignature(digest),
      },
      payerAddress: REFUND_ADDRESS,
      fundingSource: this.sourceKind,
    };
    this.exactPaymentAttempts.set(key, {
      intentHash,
      result: structuredClone(result),
    });
    return result;
  }

  async finalizeExactPaymentAttempt(request) {
    const key = request.attemptId.toLowerCase();
    const existing = this.exactPaymentAttempts.get(key);
    if (!existing) return;
    if (
      existing.result.transactionId.toLowerCase() !==
      request.transactionId.toLowerCase()
    ) {
      throw new Error("exact transaction id does not match provider attempt");
    }
    this.exactPaymentAttempts.delete(key);
  }

  async getUtxos(addresses) {
    return addresses.flatMap(
      (address) => this.utxosByAddress.get(address) ?? [],
    );
  }

  async getUtxo(outpoint) {
    return this.chainProvider.getUtxo(outpoint);
  }

  async verifyCovenantGenesis({ utxo }) {
    return this.chainProvider.verifyCovenantGenesis({ utxo });
  }

  async verifyCovenantTopUp({ previous, successor }) {
    return this.chainProvider.verifyCovenantTopUp({
      previous,
      next: {
        ...previous,
        activeOutpoint: successor.outpoint,
        activeScriptPublicKey: successor.scriptPublicKey,
        fundingAmount: successor.amount,
      },
    });
  }

  async getVirtualDaaScore() {
    return "100";
  }

  async sendTransaction(transaction) {
    const apply = this.preparedTransitions.get(transaction);
    if (apply) {
      apply();
      this.preparedTransitions.delete(transaction);
    }
    return {
      transactionId:
        transaction.length === 64
          ? transaction
          : mockHash(`broadcast:${transaction}`),
      finality: "accepted",
    };
  }

  async estimateFees() {
    return {
      feeSompi: "0",
    };
  }

  nextOutpoint(prefix) {
    const txid = mockHash(`${prefix}:${this.nextIndex}`);
    this.nextIndex += 1;
    return { txid, index: 0 };
  }

  addAddressUtxo(address, utxo) {
    const next = this.utxosByAddress.get(address) ?? [];
    next.push(utxo);
    this.utxosByAddress.set(address, next);
  }

  removeAddressUtxo(address, outpoint) {
    const current = this.utxosByAddress.get(address) ?? [];
    this.utxosByAddress.set(
      address,
      current.filter(
        (utxo) => outpointKey(utxo.outpoint) !== outpointKey(outpoint),
      ),
    );
  }
}

class MockChainProvider {
  acceptedTransactions = new Set();
  utxos = new Map();
  genesisEvidence = new Map();
  topUpEvidence = new Map();
  preparedTransactions = new Map();

  prepareTransaction(transaction, apply) {
    this.preparedTransactions.set(transaction, apply);
  }

  setUtxo(utxo) {
    this.utxos.set(outpointKey(utxo.outpoint), structuredClone(utxo));
  }

  deleteUtxo(outpoint) {
    this.utxos.delete(outpointKey(outpoint));
  }

  setGenesisEvidence(outpoint, evidence) {
    this.genesisEvidence.set(outpointKey(outpoint), structuredClone(evidence));
  }

  setTopUpEvidence(outpoint, evidence) {
    this.topUpEvidence.set(outpointKey(outpoint), structuredClone(evidence));
  }

  async getUtxo(outpoint) {
    const utxo = this.utxos.get(outpointKey(outpoint));
    return utxo ? structuredClone(utxo) : null;
  }

  async verifyCovenantGenesis({ utxo }) {
    const evidence = this.genesisEvidence.get(outpointKey(utxo.outpoint));
    if (!evidence || evidence.covenantId !== utxo.covenantId) return null;
    const derived = transactionV1CovenantId(evidence.authorizingInput, [
      {
        index: evidence.genesisOutpoint.index,
        output: {
          amount: evidence.genesisAmount,
          scriptPublicKey: evidence.genesisScriptPublicKey,
          covenant: null,
        },
      },
    ]);
    return derived === evidence.covenantId ? structuredClone(evidence) : null;
  }

  async verifyCovenantTopUp({ previous, next }) {
    const evidence = this.topUpEvidence.get(outpointKey(next.activeOutpoint));
    if (
      !evidence ||
      evidence.covenantId !== previous.covenantId ||
      outpointKey(evidence.spentOutpoint) !==
        outpointKey(previous.activeOutpoint)
    ) {
      return null;
    }
    return structuredClone(evidence);
  }

  async getVirtualDaaScore() {
    return "100";
  }

  async estimateClaimFee() {
    return "0";
  }

  async sendTransaction(transaction) {
    this.acceptedTransactions.add(transaction);
    const apply = this.preparedTransactions.get(transaction);
    if (apply) {
      apply();
      this.preparedTransactions.delete(transaction);
    }
    return {
      transactionId:
        transaction.length === 64
          ? transaction
          : mockHash(`chain-broadcast:${transaction}`),
      finality: "accepted",
    };
  }
}

class MockSigner {
  async generateChannelKey() {
    return {
      privateKey: "example-private-key",
      publicKey: CLIENT_PUBLIC_KEY,
    };
  }

  async randomSalt() {
    return mockHash("salt");
  }

  async randomNonce() {
    return mockHash(`nonce:${Date.now()}`);
  }

  async signVoucher({ digest }) {
    return mockSignature(digest);
  }

  async signBatchRequestAuthorization({ digest }) {
    return mockSignature(digest);
  }

  async signRefund() {
    return mockSignature(mockHash("refund"));
  }
}

class MockAddressCodec {
  scriptPublicKeyForAddress(address, network) {
    return `0000${sha256Hex(`${network}:${address}`)}`;
  }

  encodeScriptAddress(input) {
    return `kaspatest:x402${sha256Hex(JSON.stringify(input)).slice(0, 24)}`;
  }
}

function routeForUrl(url) {
  const path = new URL(url).pathname;
  if (path === "/download") {
    return {
      scheme: "exact",
      amount: "100000",
      resource: {
        url,
        description: "Fixed-price file",
        mimeType: "application/octet-stream",
      },
      body: { ok: true, route: "download", bytes: 4096 },
    };
  }
  if (path === "/metered") {
    return {
      scheme: "batch-settlement",
      amount: "50000",
      resource: {
        url,
        description: "Repeated metered call",
        mimeType: "application/json",
      },
      body: { ok: true, route: "metered" },
    };
  }
  return {
    scheme: "exact",
    amount: "100000",
    resource: {
      url,
      description: "Default paid route",
      mimeType: "application/json",
    },
    body: { ok: true },
  };
}

function outpointKey(outpoint) {
  return `${outpoint.txid.toLowerCase()}:${outpoint.index}`;
}

export { X402_VERSION };
