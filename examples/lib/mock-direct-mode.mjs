import { DirectModeClient, MemoryChannelStore } from "@kaspa-x402/client";
import { X402_VERSION, encodePaymentRequiredHeader, sha256Hex, stableStringify } from "@kaspa-x402/core";
import { DirectModeFacilitator } from "@kaspa-x402/facilitator";
import { DirectModeServer, MemoryServerChannelStore } from "@kaspa-x402/server";

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
    network: NETWORK,
    payTo: PAYOUT_ADDRESS,
    serverPublicKey: SERVER_PUBLIC_KEY,
    amount: "100000",
    minDepositSompi: "1000000",
    refundTimeoutDaa: "1000",
    store: serverStore,
    chainProvider,
    addressCodec,
    voucherVerifier: {
      verifyVoucher({ digest, voucher }) {
        return voucher.signature === mockSignature(digest);
      },
    },
    exactTransactionVerifier: {
      verifyExactPayment(request) {
        return {
          transactionId: request.transactionId ?? mockHash(`exact:${request.amount}:${request.payTo}`),
          paymentOutput: {
            amount: request.amount,
            scriptPublicKey: request.payToScriptPublicKey,
          },
          finality: "accepted",
          payerAddress: REFUND_ADDRESS,
        };
      },
    },
    uptoAuthorizationVerifier: {
      verifyUptoAuthorization({ digest, payload }) {
        return payload.authorization.signature === mockSignature(digest);
      },
    },
    uptoSettlementBuilder: {
      async buildUptoSettlementTransaction({ chargeAmount, payload }) {
        return { transaction: mockHash(`upto-settle:${payload.authorizationOutpoint.txid}:${chargeAmount}`) };
      },
    },
    uptoSettlementVerifier: {
      verifyUptoSettlementTransaction({ chargeAmount, payload, payToScriptPublicKey, refundScriptPublicKey, transaction }) {
        const refundAmount = (BigInt(payload.authorizationAmountSompi) - BigInt(chargeAmount)).toString();
        return {
          transactionId: transaction,
          inputAmount: payload.authorizationAmountSompi,
          chargeAmount,
          feeAmount: "0",
          outputCount: 2,
          authorizationOutpoint: payload.authorizationOutpoint,
          paymentOutput: {
            outputIndex: 0,
            amount: chargeAmount,
            scriptPublicKey: payToScriptPublicKey,
          },
          refundOutput: {
            outputIndex: 1,
            amount: refundAmount,
            scriptPublicKey: refundScriptPublicKey,
          },
          paymentOutputIndex: 0,
          refundOutputIndex: 1,
        };
      },
    },
  });
  const client = new DirectModeClient({
    fundingProvider,
    signer: new MockSigner(),
    store: clientStore,
    addressCodec,
    fetch: createMockPaidFetch(server),
    refundBuilder: {
      async buildRefundTransaction({ refundAmount }) {
        return {
          transaction: mockTransaction(`refund:${refundAmount}`),
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
    return new MockResponse(response.status, response.headers, response.body);
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
  constructor(status, headers, body) {
    this.status = status;
    this.headers = new MockHeaders(headers);
    this.body = body;
  }

  async json() {
    return this.body;
  }

  async text() {
    return typeof this.body === "string" ? this.body : JSON.stringify(this.body);
  }
}

export class MockHeaders {
  constructor(headers = {}) {
    this.headers = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
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

  constructor(chainProvider) {
    this.chainProvider = chainProvider;
  }

  async getPublicIdentity() {
    return {
      address: REFUND_ADDRESS,
      publicKey: CLIENT_PUBLIC_KEY,
    };
  }

  async fundEscrowDeposit(request) {
    const outpoint = this.nextOutpoint("deposit");
    const utxo = {
      outpoint,
      amount: request.amount,
      scriptPublicKey: request.escrowScriptPublicKey,
      finality: "accepted",
    };
    this.addAddressUtxo(request.escrowAddress, {
      ...utxo,
      address: request.escrowAddress,
    });
    this.chainProvider.setUtxo(utxo);
    return {
      outpoint,
      amount: request.amount,
      fundingSource: this.sourceKind,
      transaction: mockTransaction(`deposit:${outpoint.txid}`),
    };
  }

  async payExact(request) {
    const transactionId = mockHash(`exact:${this.nextIndex}:${request.amount}`);
    this.nextIndex += 1;
    return {
      transaction: mockTransaction(`exact:${transactionId}`),
      transactionId,
      paymentOutputIndex: 0,
      payerAddress: REFUND_ADDRESS,
      finality: "accepted",
      fundingSource: this.sourceKind,
    };
  }

  async fundUptoAuthorization(request) {
    const outpoint = this.nextOutpoint("upto");
    this.chainProvider.setUtxo({
      outpoint,
      amount: request.amount,
      scriptPublicKey: request.authorizationScriptPublicKey,
      finality: "accepted",
    });
    return {
      outpoint,
      amount: request.amount,
      scriptPublicKey: request.authorizationScriptPublicKey,
      fundingTransaction: mockTransaction(`upto-funding:${outpoint.txid}`),
      payerAddress: REFUND_ADDRESS,
      finality: "accepted",
      fundingSource: this.sourceKind,
    };
  }

  async getUtxos(addresses) {
    return addresses.flatMap((address) => this.utxosByAddress.get(address) ?? []);
  }

  async getVirtualDaaScore() {
    return "100";
  }

  async sendTransaction(transaction) {
    return {
      transactionId: transaction.length === 64 ? transaction : mockHash(`broadcast:${transaction}`),
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
}

class MockChainProvider {
  utxos = new Map();

  setUtxo(utxo) {
    this.utxos.set(outpointKey(utxo.outpoint), structuredClone(utxo));
  }

  async getUtxo(outpoint) {
    const utxo = this.utxos.get(outpointKey(outpoint));
    return utxo ? structuredClone(utxo) : null;
  }

  async getVirtualDaaScore() {
    return "100";
  }

  async estimateClaimFee() {
    return "0";
  }

  async sendTransaction(transaction) {
    return {
      transactionId: transaction.length === 64 ? transaction : mockHash(`chain-broadcast:${transaction}`),
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

  async signUptoAuthorization({ digest }) {
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
      resource: { url, description: "Fixed-price file", mimeType: "application/octet-stream" },
      body: { ok: true, route: "download", bytes: 4096 },
    };
  }
  if (path === "/quote") {
    return {
      scheme: "upto",
      amount: "250000",
      chargedAmount: "175000",
      resource: { url, description: "Variable-price quote", mimeType: "application/json" },
      body: { ok: true, route: "quote", price: "175000" },
    };
  }
  if (path === "/metered") {
    return {
      scheme: "batch-settlement",
      amount: "50000",
      resource: { url, description: "Repeated metered call", mimeType: "application/json" },
      body: { ok: true, route: "metered" },
    };
  }
  return {
    scheme: "exact",
    amount: "100000",
    resource: { url, description: "Default paid route", mimeType: "application/json" },
    body: { ok: true },
  };
}

function outpointKey(outpoint) {
  return `${outpoint.txid.toLowerCase()}:${outpoint.index}`;
}

export { X402_VERSION };
