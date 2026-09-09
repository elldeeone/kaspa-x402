import { DirectModeClient, MemoryChannelStore } from "@kaspa-x402/client";
import {
  X402_VERSION,
  encodePaymentRequiredHeader,
  exactRequestAuthorizationDigest,
  exactRequestAuthorizationId,
  sha256Hex,
  stableStringify,
  TESTNET_10_CONFIRMATION_THRESHOLD,
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

export function createMockDirectModeEnvironment() {
  const chainProvider = new MockChainProvider();
  const fundingProvider = new MockFundingProvider(chainProvider);
  const addressCodec = new MockAddressCodec();
  const serverStore = new MemoryServerChannelStore();
  const clientStore = new MemoryChannelStore();
  const server = new DirectModeServer({
    confirmationThreshold: TESTNET_10_CONFIRMATION_THRESHOLD,
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
    voucherVerifier: {
      verifyVoucher({ digest, voucher }) {
        return voucher.signature === mockSignature(digest);
      },
    },
    batchPresentationVerifier: {
      verifyPresentation({ digest, signature }) {
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
          finality: "accepted",
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
            claimedCumulativeAmount,
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
          const acceptance = acceptedChainEvidence(transaction);
          chainProvider.setUtxo({
            outpoint: continuationOutpoint,
            covenantId: channel.covenantId,
            amount: continuationFundingAmount,
            scriptPublicKey: continuationScriptPublicKey,
            acceptance,
            finality: "accepted",
          });
          chainProvider.recordTransition({
            kind: "claim",
            covenantId: channel.covenantId,
            templateId: channel.channelConfig.templateId,
            consumedOutpoint: channel.activeOutpoint,
            transactionId: transaction,
            authorizedSuccessorCount: 1,
            successor: {
              outpoint: continuationOutpoint,
              covenantId: channel.covenantId,
              authorizingInput: 0,
              scriptPublicKey: continuationScriptPublicKey,
              value: continuationFundingAmount,
              claimedCumulativeAmount,
            },
            terminalOutput: null,
            acceptance,
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
  });
  const client = new DirectModeClient({
    confirmationThreshold: TESTNET_10_CONFIRMATION_THRESHOLD,
    fundingProvider,
    signer: new MockSigner(),
    store: clientStore,
    addressCodec,
    fetch: createMockPaidFetch(server),
    refundBuilder: {
      async buildRefundTransaction({ channel, refundAmount, signDigest }) {
        await signDigest(mockHash(`refund-digest:${refundAmount}`));
        const transaction = mockTransaction(`refund:${refundAmount}`);
        const transactionId = mockHash(`broadcast:${transaction}`);
        const refundScriptPublicKey = addressCodec.scriptPublicKeyForAddress(
          channel.config.refundAddress,
          channel.config.network,
        );
        chainProvider.prepareTransaction(transaction, () => {
          chainProvider.deleteUtxo(channel.activeOutpoint);
          fundingProvider.removeAddressUtxo(
            channel.escrowAddress,
            channel.activeOutpoint,
          );
          chainProvider.recordTransition({
            kind: "refund",
            covenantId: channel.covenantId,
            templateId: channel.templateId,
            consumedOutpoint: channel.activeOutpoint,
            transactionId,
            authorizedSuccessorCount: 0,
            successor: null,
            terminalOutput: {
              index: 0,
              scriptPublicKey: refundScriptPublicKey,
              value: refundAmount,
            },
            acceptance: acceptedChainEvidence(transactionId),
          });
        });
        return {
          transaction,
          transactionId,
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
  }

  async getPublicIdentity() {
    return {
      address: REFUND_ADDRESS,
      publicKey: CLIENT_PUBLIC_KEY,
    };
  }

  async authorizeExactPayment() {}

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
      acceptance: acceptedChainEvidence(transactionId),
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
      acceptance: acceptedChainEvidence(transactionId),
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
      acceptance: acceptedChainEvidence(transactionId),
      finality: "accepted",
    };
    this.preparedTransitions.set(transaction, () => {
      this.removeAddressUtxo(previous.escrowAddress, previous.activeOutpoint);
      this.chainProvider.deleteUtxo(previous.activeOutpoint);
      const acceptance = acceptedChainEvidence(transactionId);
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
        authorizingInput: 0,
        acceptance,
      });
      this.chainProvider.recordTransition({
        kind: "top-up",
        covenantId: previous.covenantId,
        templateId: previous.templateId,
        consumedOutpoint: previous.activeOutpoint,
        transactionId,
        authorizedSuccessorCount: 1,
        successor: {
          outpoint,
          covenantId: previous.covenantId,
          authorizingInput: 0,
          scriptPublicKey: previous.activeScriptPublicKey,
          value: request.targetFundingAmount,
          claimedCumulativeAmount: previous.claimedCumulativeAmount,
        },
        terminalOutput: null,
        acceptance,
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
    return {
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

  async discoverCovenantLineage(request) {
    return this.chainProvider.discoverCovenantLineage(request);
  }

  async sendTransaction(transaction) {
    const apply = this.preparedTransitions.get(transaction);
    if (apply) {
      apply();
      this.preparedTransitions.delete(transaction);
    }
    this.chainProvider.applyPreparedTransaction(transaction);
    const transactionId =
      transaction.length === 64
        ? transaction
        : mockHash(`broadcast:${transaction}`);
    return {
      transactionId,
      evidence: acceptedChainEvidence(transactionId),
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
  utxos = new Map();
  genesisEvidence = new Map();
  topUpEvidence = new Map();
  preparedTransactions = new Map();
  transitions = new Map();

  prepareTransaction(transaction, apply) {
    this.preparedTransactions.set(transaction, apply);
  }

  applyPreparedTransaction(transaction) {
    const apply = this.preparedTransactions.get(transaction);
    if (!apply) return false;
    apply();
    this.preparedTransactions.delete(transaction);
    return true;
  }

  recordTransition(transition) {
    this.transitions.set(
      transition.transactionId.toLowerCase(),
      structuredClone(transition),
    );
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

  async discoverCovenantLineage(request) {
    const seenTransactionIds = new Set([
      request.lineage.manifest.genesis.transactionId.toLowerCase(),
    ]);
    for (const event of request.lineage.journal) {
      if (event.event === "accepted") {
        seenTransactionIds.add(event.transition.transactionId.toLowerCase());
      } else if (event.event === "genesis-accepted") {
        seenTransactionIds.add(event.acceptance.transactionId.toLowerCase());
      }
    }
    const unseen = Array.from(this.transitions.values()).filter(
      (transition) =>
        transition.covenantId.toLowerCase() ===
          request.covenantId.toLowerCase() &&
        !seenTransactionIds.has(transition.transactionId.toLowerCase()),
    );
    if (unseen.length === 0) return unchangedLineageUpdate(request);
    const checkpoint = structuredClone(unseen.at(-1).acceptance.checkpoint);
    return {
      fromCheckpoint: request.lineage.checkpoint,
      checkpoint,
      continuity: "complete",
      removedChainBlockHashes: [],
      addedChainBlocks: unseen.map((transition) => ({
        blockHash: transition.acceptance.acceptingBlockHash,
        transitions: [structuredClone(transition)],
      })),
    };
  }

  async estimateClaimFee() {
    return "0";
  }

  async sendTransaction(transaction) {
    this.applyPreparedTransaction(transaction);
    const transactionId =
      transaction.length === 64
        ? transaction
        : mockHash(`chain-broadcast:${transaction}`);
    return {
      transactionId,
      evidence: acceptedChainEvidence(transactionId),
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

  async signBatchPresentation({ digest }) {
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

function acceptedChainEvidence(transactionId) {
  const checkpointBlueScore = 1_000n;
  return {
    status: "accepted",
    transactionId: transactionId.toLowerCase(),
    acceptingBlockHash: mockHash(`accepting-block:${transactionId}`),
    acceptingBlockBlueScore: (
      checkpointBlueScore - BigInt(TESTNET_10_CONFIRMATION_THRESHOLD) + 1n
    ).toString(),
    confirmationCount: TESTNET_10_CONFIRMATION_THRESHOLD,
    checkpoint: {
      blockHash: mockHash("selected-chain-checkpoint"),
      blueScore: checkpointBlueScore.toString(),
      daaScore: "1000",
    },
  };
}

function unchangedLineageUpdate(request) {
  return {
    fromCheckpoint: request.lineage.checkpoint,
    checkpoint: request.lineage.checkpoint,
    continuity: "complete",
    removedChainBlockHashes: [],
    addedChainBlocks: [],
  };
}

export { X402_VERSION };
