import { describe, expect, it } from "vitest";

import { X402_VERSION, encodePaymentRequiredHeader, encodePaymentResponseHeader, sha256Hex } from "@kaspa-x402/core";
import type {
  BatchPaymentRequirements,
  ChannelState,
  Hash32Hex,
  KaspaPaymentPayload,
  NetworkId,
  PaymentPayload,
  PaymentRequired,
  SettlementResponse,
} from "@kaspa-x402/core";
import {
  DirectModeClient,
  MemoryChannelStore,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  type AddressCodec,
  type ChannelKey,
  type DirectModeChannel,
  type EscrowDepositRequest,
  type FeeEstimateRequest,
  type FetchLike,
  type FundingProvider,
  type FundingProviderUtxo,
  type FundingSourceKind,
  type HeaderBag,
  type HttpResponseLike,
  type RefundTransactionBuilder,
  type SendTransactionResult,
  type VoucherSignRequest,
} from "../src/index.js";

const SERVER_KEY = "11".repeat(32);
const CLIENT_KEY = "22".repeat(32);
const SALT = "33".repeat(32);
const COMMITMENT = "44".repeat(32);
const FUNDING_TX = "55".repeat(32);
const REFUND_TX = "66".repeat(32);

describe("direct-mode client", () => {
  it("opens a deposit-voucher channel for the first paid request", async () => {
    const provider = new FakeFundingProvider();
    const store = new MemoryChannelStore();
    const client = makeClient({ provider, store });
    const required = makeRequired({ amount: "100" });

    const payment = await client.createPayment(encodePaymentRequiredHeader(required), {
      url: "https://api.example.test/data",
    });

    expect(payment.openedChannel).toBe(true);
    expect(payment.paymentPayload.payload.type).toBe("deposit-voucher");
    expect(provider.deposits).toHaveLength(1);
    expect(provider.deposits[0]?.amount).toBe("1000");

    const settlement = await client.applySettlement(payment, makeSettlement(payment.channel, "100"));
    expect(settlement.channel.chargedCumulativeAmount).toBe("100");

    const channels = await store.loadChannels({});
    expect(channels).toHaveLength(1);
    expect(channels[0]?.signedCumulativeAmount).toBe("100");
    expect(channels[0]?.chargedCumulativeAmount).toBe("100");
  });

  it("reuses an active channel and signs a monotonic cumulative voucher", async () => {
    const provider = new FakeFundingProvider();
    const store = new MemoryChannelStore();
    const client = makeClient({ provider, store });
    const firstRequired = makeRequired({ amount: "100" });
    const firstPayment = await client.createPayment(encodePaymentRequiredHeader(firstRequired), {
      url: "https://api.example.test/data",
    });
    await client.applySettlement(firstPayment, makeSettlement(firstPayment.channel, "100"));

    const secondRequired = makeRequired({ amount: "75" });
    const secondPayment = await client.createPayment(encodePaymentRequiredHeader(secondRequired), {
      url: "https://api.example.test/data",
    });

    expect(secondPayment.openedChannel).toBe(false);
    expect(secondPayment.paymentPayload.payload.type).toBe("voucher");
    expect(provider.deposits).toHaveLength(1);
    expect(voucherBearingPayload(secondPayment.paymentPayload).voucher.amount).toBe("175");
  });

  it("rejects the wrong funding source before funding an escrow deposit", async () => {
    const provider = new FakeFundingProvider("hot-wallet");
    const store = new MemoryChannelStore();
    const client = makeClient({
      provider,
      store,
      fundingSource: "vault-treasury",
    });

    await expect(
      client.createPayment(encodePaymentRequiredHeader(makeRequired({ amount: "100" })), {
        url: "https://api.example.test/data",
      }),
    ).rejects.toThrow("does not satisfy policy");
    expect(provider.deposits).toHaveLength(0);
  });

  it("rejects the wrong funding network before store or funding work", async () => {
    const provider = new FakeFundingProvider("hot-wallet", "kaspa:mainnet");
    const store = new MemoryChannelStore();
    const client = makeClient({ provider, store });

    await expect(
      client.createPayment(encodePaymentRequiredHeader(makeRequired({ amount: "100" })), {
        url: "https://api.example.test/data",
      }),
    ).rejects.toThrow("funding provider network");
    expect(provider.deposits).toHaveLength(0);
    await expect(store.loadChannels({})).resolves.toHaveLength(0);
  });

  it("rejects ambiguous txid-only deposit results", async () => {
    const provider = new FakeFundingProvider();
    provider.depositMode = "txid-only-ambiguous";
    const client = makeClient({ provider, store: new MemoryChannelStore() });

    await expect(
      client.createPayment(encodePaymentRequiredHeader(makeRequired({ amount: "100" })), {
        url: "https://api.example.test/data",
      }),
    ).rejects.toThrow("resolvable escrow outpoint");
  });

  it("rejects deposit results whose resolved UTXO is below the minimum deposit", async () => {
    const provider = new FakeFundingProvider();
    provider.depositMode = "outpoint-underfunded";
    const client = makeClient({ provider, store: new MemoryChannelStore() });

    await expect(
      client.createPayment(encodePaymentRequiredHeader(makeRequired({ amount: "100" })), {
        url: "https://api.example.test/data",
      }),
    ).rejects.toThrow("below the required minimum deposit");
  });

  it("rejects underfunded offers before funding escrow", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({ provider, store: new MemoryChannelStore() });

    await expect(
      client.createPayment(encodePaymentRequiredHeader(makeRequired({ amount: "1001" })), {
        url: "https://api.example.test/data",
      }),
    ).rejects.toThrow("minimum deposit cannot cover");
    expect(provider.deposits).toHaveLength(0);
  });

  it("marks a channel suspicious when settlement state identifies another channel", async () => {
    const provider = new FakeFundingProvider();
    const store = new MemoryChannelStore();
    const client = makeClient({ provider, store });
    const payment = await client.createPayment(encodePaymentRequiredHeader(makeRequired({ amount: "100" })), {
      url: "https://api.example.test/data",
    });
    const bad = makeSettlement(payment.channel, "100", {
      channelId: "ff".repeat(32),
    });

    await expect(client.applySettlement(payment, bad)).rejects.toThrow("channel id");
    const [stored] = await store.loadChannels({});
    expect(stored?.status).toBe("suspicious");
  });

  it("rejects settlement state that does not match this request transition", async () => {
    const provider = new FakeFundingProvider();
    const store = new MemoryChannelStore();
    const client = makeClient({ provider, store });
    const payment = await client.createPayment(encodePaymentRequiredHeader(makeRequired({ amount: "100" })), {
      url: "https://api.example.test/data",
    });
    const bad = makeSettlement(payment.channel, "100", {
      chargedCumulativeAmount: "99",
    });

    await expect(client.applySettlement(payment, bad)).rejects.toThrow("charged cumulative");
    const [stored] = await store.loadChannels({});
    expect(stored?.status).toBe("suspicious");
  });

  it("rejects successful voucher settlement without durable commitment state", async () => {
    const provider = new FakeFundingProvider();
    const store = new MemoryChannelStore();
    const client = makeClient({ provider, store });
    const payment = await client.createPayment(encodePaymentRequiredHeader(makeRequired({ amount: "100" })), {
      url: "https://api.example.test/data",
    });
    const bad: SettlementResponse = {
      success: true,
      transaction: "",
      network: payment.accepted.network,
      extra: {
        chargedAmount: "100",
        fundingAmount: payment.channel.fundingAmount,
        channelId: payment.channel.id,
      },
    };

    await expect(client.applySettlement(payment, bad)).rejects.toThrow("commitment id");
    const [stored] = await store.loadChannels({});
    expect(stored?.status).toBe("suspicious");
  });

  it("requires charged amount in settlement response extra", async () => {
    const provider = new FakeFundingProvider();
    const store = new MemoryChannelStore();
    const client = makeClient({ provider, store });
    const payment = await client.createPayment(encodePaymentRequiredHeader(makeRequired({ amount: "100" })), {
      url: "https://api.example.test/data",
    });
    const bad: SettlementResponse = {
      success: true,
      transaction: "",
      network: payment.accepted.network,
      amount: "100",
      extra: {
        commitmentId: COMMITMENT,
        channelState: channelState(payment.channel, "100", payment.channel.signedCumulativeAmount),
      },
    };

    await expect(client.applySettlement(payment, bad)).rejects.toThrow("charged amount");
  });

  it("verifies deposit settlement funding amount", async () => {
    const provider = new FakeFundingProvider();
    const store = new MemoryChannelStore();
    const client = makeClient({ provider, store });
    const payment = await client.createPayment(encodePaymentRequiredHeader(makeRequired({ amount: "100" })), {
      url: "https://api.example.test/data",
    });
    const bad = makeSettlement(payment.channel, "100");
    if (!bad.extra) throw new Error("missing extra");
    bad.extra.fundingAmount = "999";

    await expect(client.applySettlement(payment, bad)).rejects.toThrow("funding amount");
  });

  it("adopts verified corrective channel state before reusing a channel", async () => {
    const provider = new FakeFundingProvider();
    const store = new MemoryChannelStore();
    let verified = 0;
    const client = makeClient({
      provider,
      store,
      verifyVoucherSignature: () => {
        verified += 1;
        return true;
      },
    });
    const firstPayment = await client.createPayment(encodePaymentRequiredHeader(makeRequired({ amount: "100" })), {
      url: "https://api.example.test/data",
    });
    await client.applySettlement(firstPayment, makeSettlement(firstPayment.channel, "100"));

    const correctiveState = channelState(firstPayment.channel, "100", "200");
    const correctiveRequired = makeRequired({
      amount: "50",
      channelState: correctiveState,
      voucherState: {
        amount: "200",
        signature: "aa".repeat(64),
      },
    });
    const correctivePayment = await client.createPayment(encodePaymentRequiredHeader(correctiveRequired), {
      url: "https://api.example.test/data",
    });

    expect(verified).toBe(1);
    expect(correctivePayment.openedChannel).toBe(false);
    expect(correctivePayment.paymentPayload.payload.type).toBe("voucher");
    expect(voucherBearingPayload(correctivePayment.paymentPayload).voucher.amount).toBe("200");
  });

  it("recovers a changed active outpoint from verified corrective state", async () => {
    const provider = new FakeFundingProvider();
    const store = new MemoryChannelStore();
    const replacementOutpoint = { txid: "77".repeat(32), index: 0 };
    let verifierSawReplacement = false;
    const client = makeClient({
      provider,
      store,
      verifyVoucherSignature: (_voucher, channel) => {
        verifierSawReplacement = channel.activeOutpoint.txid === replacementOutpoint.txid;
        return true;
      },
    });
    const firstPayment = await client.createPayment(encodePaymentRequiredHeader(makeRequired({ amount: "100" })), {
      url: "https://api.example.test/data",
    });
    await client.applySettlement(firstPayment, makeSettlement(firstPayment.channel, "100"));
    provider.utxos.push({
      outpoint: replacementOutpoint,
      amount: "900",
      address: firstPayment.channel.escrowAddress,
      scriptPublicKey: firstPayment.channel.activeScriptPublicKey,
    });
    const correctiveRequired = makeRequired({
      amount: "50",
      channelState: {
        ...channelState(firstPayment.channel, "100", "0"),
        activeOutpoint: replacementOutpoint,
        fundingAmount: "900",
        claimedCumulativeAmount: "100",
      },
      voucherState: {
        amount: "0",
        signature: "aa".repeat(64),
      },
    });

    const payment = await client.createPayment(encodePaymentRequiredHeader(correctiveRequired), {
      url: "https://api.example.test/data",
    });

    expect(verifierSawReplacement).toBe(true);
    expect(payment.openedChannel).toBe(false);
    expect(voucherBearingPayload(payment.paymentPayload).fundingOutpoint).toEqual(replacementOutpoint);
    expect(voucherBearingPayload(payment.paymentPayload).voucher.amount).toBe("50");
  });

  it("rejects corrective channel state without voucher proof", async () => {
    const provider = new FakeFundingProvider();
    const store = new MemoryChannelStore();
    const client = makeClient({ provider, store });
    const firstPayment = await client.createPayment(encodePaymentRequiredHeader(makeRequired({ amount: "100" })), {
      url: "https://api.example.test/data",
    });
    await client.applySettlement(firstPayment, makeSettlement(firstPayment.channel, "100"));

    await expect(
      client.createPayment(
        encodePaymentRequiredHeader(
          makeRequired({
            amount: "50",
            channelState: channelState(firstPayment.channel, "100", "200"),
          }),
        ),
        {
          url: "https://api.example.test/data",
        },
      ),
    ).rejects.toThrow("requires voucher proof");
  });

  it("uses active unclaimed value after claims when checking balance and signing", async () => {
    const provider = new FakeFundingProvider();
    const store = new MemoryChannelStore();
    const client = makeClient({ provider, store });
    const firstPayment = await client.createPayment(encodePaymentRequiredHeader(makeRequired({ amount: "100" })), {
      url: "https://api.example.test/data",
    });
    await client.applySettlement(firstPayment, makeSettlement(firstPayment.channel, "100"));
    const [stored] = await store.loadChannels({});
    if (!stored) throw new Error("missing stored channel");
    await store.saveChannel({
      ...stored,
      chargedCumulativeAmount: "300",
      claimedCumulativeAmount: "250",
      signedCumulativeAmount: "50",
      latestVoucher: {
        amount: "50",
        signature: "dd".repeat(64),
      },
    });

    const payment = await client.createPayment(encodePaymentRequiredHeader(makeRequired({ amount: "75" })), {
      url: "https://api.example.test/data",
    });

    expect(payment.openedChannel).toBe(false);
    expect(voucherBearingPayload(payment.paymentPayload).voucher.amount).toBe("125");
  });

  it("drives paid HTTP fetch with PAYMENT headers", async () => {
    const provider = new FakeFundingProvider();
    const store = new MemoryChannelStore();
    const requiredHeader = encodePaymentRequiredHeader(makeRequired({ amount: "100" }));
    let capturedPayment: PaymentPayload | undefined;
    const client = makeClient({
      provider,
      store,
      fetch: async (_input, init) => {
        const paymentHeader =
          init?.headers && !Array.isArray(init.headers) ? (init.headers as Record<string, string>)[PAYMENT_SIGNATURE_HEADER] : undefined;
        if (!paymentHeader) {
          return response(402, {
            "PAYMENT-REQUIRED": requiredHeader,
          });
        }
        capturedPayment = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf8")) as PaymentPayload;
        const [channel] = await store.loadChannels({});
        if (!channel) throw new Error("missing channel");
        return response(200, {
          [PAYMENT_RESPONSE_HEADER]: encodePaymentResponseHeader(makeSettlement(channel, "100")),
        });
      },
    });

    const result = await client.paidFetch("https://api.example.test/data");

    expect(result.response.status).toBe(200);
    expect(capturedPayment?.payload.type).toBe("deposit-voucher");
    expect(result.settlement?.channel.chargedCumulativeAmount).toBe("100");
  });

  it("passes payment identifiers through paidFetch retries", async () => {
    const provider = new FakeFundingProvider();
    const store = new MemoryChannelStore();
    const requiredHeader = encodePaymentRequiredHeader(
      makeRequired({
        amount: "100",
        extensions: {
          "payment-identifier": {
            info: {
              required: true,
            },
          },
        },
      }),
    );
    let capturedPayment: PaymentPayload | undefined;
    const client = makeClient({
      provider,
      store,
      fetch: async (_input, init) => {
        const paymentHeader =
          init?.headers && !Array.isArray(init.headers) ? (init.headers as Record<string, string>)[PAYMENT_SIGNATURE_HEADER] : undefined;
        if (!paymentHeader) {
          return response(402, {
            "PAYMENT-REQUIRED": requiredHeader,
          });
        }
        capturedPayment = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf8")) as PaymentPayload;
        const [channel] = await store.loadChannels({});
        if (!channel) throw new Error("missing channel");
        return response(200, {
          [PAYMENT_RESPONSE_HEADER]: encodePaymentResponseHeader(makeSettlement(channel, "100")),
        });
      },
    });

    await client.paidFetch("https://api.example.test/data", {
      paymentIdentifier: "pay_7d5d747be160e280504c099d984bcfe0",
    });

    expect(capturedPayment?.extensions?.["payment-identifier"]).toEqual({
      info: {
        required: true,
        id: "pay_7d5d747be160e280504c099d984bcfe0",
      },
    });
  });

  it("handles a corrective paid-fetch 402 before the successful retry", async () => {
    const provider = new FakeFundingProvider();
    const store = new MemoryChannelStore();
    let retryCount = 0;
    const client = makeClient({
      provider,
      store,
      verifyVoucherSignature: () => true,
      fetch: async (_input, init) => {
        const paymentHeader =
          init?.headers && !Array.isArray(init.headers) ? (init.headers as Record<string, string>)[PAYMENT_SIGNATURE_HEADER] : undefined;
        if (!paymentHeader) {
          return response(402, {
            "PAYMENT-REQUIRED": encodePaymentRequiredHeader(makeRequired({ amount: "100" })),
          });
        }
        retryCount += 1;
        const [channel] = await store.loadChannels({});
        if (!channel) throw new Error("missing channel");
        if (retryCount === 1) {
          return response(402, {
            "PAYMENT-REQUIRED": encodePaymentRequiredHeader(
              makeRequired({
                amount: "50",
                channelState: channelState(channel, "0", "200"),
                voucherState: {
                  amount: "200",
                  signature: "aa".repeat(64),
                },
              }),
            ),
          });
        }
        return response(200, {
          [PAYMENT_RESPONSE_HEADER]: encodePaymentResponseHeader(makeSettlement(channel, "50")),
        });
      },
    });

    const result = await client.paidFetch("https://api.example.test/data");

    expect(retryCount).toBe(2);
    expect(result.response.status).toBe(200);
    expect(result.settlement?.chargedAmount).toBe("50");
  });

  it("lists and refunds timeout-unlocked channels through adapters", async () => {
    const provider = new FakeFundingProvider();
    provider.daa = "999";
    provider.sendFinality = "accepted";
    const store = new MemoryChannelStore();
    const client = makeClient({
      provider,
      store,
      refundBuilder: {
        async buildRefundTransaction(request) {
          expect(request.refundAmount).toBe("1000");
          return { transaction: "ab".repeat(32) };
        },
      },
    });
    const payment = await client.createPayment(encodePaymentRequiredHeader(makeRequired({ amount: "100" })), {
      url: "https://api.example.test/data",
    });
    await client.applySettlement(payment, makeSettlement(payment.channel, "100"));

    await expect(client.listRefundableChannels()).resolves.toHaveLength(0);
    provider.daa = "1000";
    await expect(client.listRefundableChannels()).resolves.toHaveLength(1);

    const refund = await client.refundChannel(payment.channel.id);
    expect(refund.transactionId).toBe(REFUND_TX);
    expect(refund.accepted).toBe(true);
    expect(refund.channel.status).toBe("refunded");
  });

  it("does not mark a channel refunded for broadcast-only refund submission", async () => {
    const provider = new FakeFundingProvider();
    provider.sendFinality = "broadcast";
    const store = new MemoryChannelStore();
    const client = makeClient({
      provider,
      store,
      refundBuilder: {
        async buildRefundTransaction() {
          return { transaction: "ab".repeat(32) };
        },
      },
    });
    const payment = await client.createPayment(encodePaymentRequiredHeader(makeRequired({ amount: "100" })), {
      url: "https://api.example.test/data",
    });

    const refund = await client.refundChannel(payment.channel.id);

    expect(refund.accepted).toBe(false);
    expect(refund.finality).toBe("broadcast");
    const [stored] = await store.loadChannels({});
    expect(stored?.status).toBe("active");
  });

  it("rejects refund transactions whose amount differs from the signed amount", async () => {
    const provider = new FakeFundingProvider();
    provider.sendFinality = "accepted";
    const store = new MemoryChannelStore();
    const client = makeClient({
      provider,
      store,
      refundBuilder: {
        async buildRefundTransaction() {
          return { transaction: "ab".repeat(32), refundAmount: "999" };
        },
      },
    });
    const payment = await client.createPayment(encodePaymentRequiredHeader(makeRequired({ amount: "100" })), {
      url: "https://api.example.test/data",
    });

    await expect(client.refundChannel(payment.channel.id)).rejects.toThrow("refund transaction amount");
    const [stored] = await store.loadChannels({});
    expect(stored?.status).toBe("active");
  });
});

function makeClient(options: {
  provider?: FakeFundingProvider;
  store?: MemoryChannelStore;
  fundingSource?: FundingSourceKind;
  fetch?: FetchLike;
  verifyVoucherSignature?: (voucher: { amount: string; signature: string }, channel: DirectModeChannel) => boolean;
  refundBuilder?: RefundTransactionBuilder;
}): DirectModeClient {
  const provider = options.provider ?? new FakeFundingProvider();
  return new DirectModeClient({
    fundingProvider: provider,
    signer: new FakeSigner(),
    store: options.store ?? new MemoryChannelStore(),
    addressCodec: new FakeAddressCodec(),
    fundingPolicy: options.fundingSource ? { requiredSource: options.fundingSource } : undefined,
    fetch: options.fetch as never,
    verifyVoucherSignature: options.verifyVoucherSignature,
    refundBuilder: options.refundBuilder,
  });
}

function makeRequired(input: {
  amount: string;
  channelState?: ChannelState;
  voucherState?: { amount: string; signature: string };
  extensions?: PaymentRequired["extensions"];
}): PaymentRequired {
  return {
    x402Version: X402_VERSION,
    resource: {
      url: "https://api.example.test/data",
    },
    accepts: [
      {
        scheme: "batch-settlement",
        network: "kaspa:testnet-10",
        amount: input.amount,
        asset: "KAS",
        payTo: "kaspatest:payout",
        maxTimeoutSeconds: 60,
        extra: {
          binding: "kaspa-escrow-v1",
          templateId: "kaspa-x402-escrow-v1",
          serverPublicKey: SERVER_KEY,
          minDepositSompi: "1000",
          refundTimeoutDaa: "1000",
          ...(input.channelState ? { channelState: input.channelState } : {}),
          ...(input.voucherState ? { voucherState: input.voucherState } : {}),
        },
      } satisfies BatchPaymentRequirements,
    ],
    ...(input.extensions ? { extensions: input.extensions } : {}),
  };
}

function makeSettlement(channel: DirectModeChannel, chargedAmount: string, stateOverrides: Partial<ChannelState> = {}): SettlementResponse {
  return {
    success: true,
    transaction: "",
    network: channel.config.network,
    extra: {
      commitmentId: COMMITMENT,
      chargedAmount,
      fundingAmount: channel.fundingAmount,
      channelState: {
        ...channelState(channel, addAmounts(channel.chargedCumulativeAmount, chargedAmount), channel.signedCumulativeAmount),
        ...stateOverrides,
      },
    },
  };
}

function addAmounts(a: string, b: string): string {
  return (BigInt(a) + BigInt(b)).toString();
}

function voucherBearingPayload(paymentPayload: PaymentPayload): Extract<KaspaPaymentPayload, { type: "deposit-voucher" | "voucher" }> {
  const payload = paymentPayload.payload;
  if (payload.type !== "deposit-voucher" && payload.type !== "voucher") {
    throw new Error("expected voucher-bearing payload");
  }
  return payload;
}

function channelState(channel: DirectModeChannel, chargedCumulativeAmount: string, signedMaxClaimable: string): ChannelState {
  return {
    channelId: channel.id,
    activeOutpoint: channel.activeOutpoint,
    activeScriptPublicKey: channel.activeScriptPublicKey,
    fundingAmount: channel.fundingAmount,
    chargedCumulativeAmount,
    claimedCumulativeAmount: "0",
    signedMaxClaimable,
  };
}

function response(status: number, headers: Record<string, string>): HttpResponseLike {
  return {
    status,
    headers: new TestHeaders(headers),
  };
}

class TestHeaders implements HeaderBag {
  readonly #headers: Record<string, string>;

  constructor(headers: Record<string, string>) {
    this.#headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  }

  get(name: string): string | null {
    return this.#headers[name.toLowerCase()] ?? null;
  }
}

class FakeFundingProvider implements FundingProvider {
  readonly networkId: NetworkId;
  readonly sourceKind: FundingSourceKind;
  readonly deposits: Array<{ amount: string; channelId: string }> = [];
  readonly utxos: FundingProviderUtxo[] = [];
  depositMode: "outpoint" | "txid-only-ambiguous" | "outpoint-underfunded" = "outpoint";
  sendFinality: SendTransactionResult["finality"] = "accepted";
  daa = "1000";

  constructor(sourceKind: FundingSourceKind = "hot-wallet", networkId: NetworkId = "kaspa:testnet-10") {
    this.sourceKind = sourceKind;
    this.networkId = networkId;
  }

  async getPublicIdentity() {
    return { address: "kaspatest:refund", publicKey: CLIENT_KEY };
  }

  async fundEscrowDeposit(request: EscrowDepositRequest) {
    this.deposits.push({ amount: request.amount, channelId: request.channelId });
    const outpoint = { txid: FUNDING_TX, index: this.deposits.length - 1 };
    const amount = this.depositMode === "outpoint-underfunded" ? "50" : request.amount;
    this.utxos.push({
      outpoint,
      amount,
      address: request.escrowAddress,
      scriptPublicKey: request.escrowScriptPublicKey,
    });
    if (this.depositMode === "txid-only-ambiguous") {
      this.utxos.push({
        outpoint: { txid: FUNDING_TX, index: 10 },
        amount: request.amount,
        address: request.escrowAddress,
        scriptPublicKey: request.escrowScriptPublicKey,
      });
      return {
        txid: FUNDING_TX,
        amount: request.amount,
        fundingSource: this.sourceKind,
      };
    }
    return {
      outpoint,
      fundingSource: this.sourceKind,
    };
  }

  async getUtxos(addresses: readonly string[]) {
    return this.utxos.filter((utxo) => utxo.address && addresses.includes(utxo.address));
  }

  async getVirtualDaaScore() {
    return this.daa;
  }

  async sendTransaction(_transaction: string) {
    return { transactionId: REFUND_TX, finality: this.sendFinality };
  }

  async estimateFees(_request: FeeEstimateRequest) {
    return { feeSompi: "1000" };
  }
}

class FakeSigner {
  async generateChannelKey(): Promise<ChannelKey> {
    return { publicKey: CLIENT_KEY, privateKey: "client-key" };
  }

  async randomSalt(): Promise<Hash32Hex> {
    return SALT;
  }

  async signVoucher({ digest }: VoucherSignRequest) {
    return `${digest}${digest}`;
  }

  async signRefund() {
    return "cc".repeat(64);
  }
}

class FakeAddressCodec implements AddressCodec {
  scriptPublicKeyForAddress(address: string): string {
    return `0000${sha256Hex(address)}`;
  }

  encodeScriptAddress(input: { serializedScriptPublicKey: string }): string {
    return `kaspatest:${sha256Hex(input.serializedScriptPublicKey).slice(0, 32)}`;
  }
}
