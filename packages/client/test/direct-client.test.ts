import { describe, expect, it } from "vitest";

import {
  MCP_PAYMENT_RESPONSE_META_KEY,
  X402_VERSION,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  kaspaSettlementExtensions,
  mcpPaymentRequiredResult,
  mcpToolCallFingerprint,
  minimumUptoAuthorizationAmount,
  paymentIdentifierExtension,
  sha256Hex,
  uptoAuthorizationDigest,
} from "@kaspa-x402/core";
import type {
  BatchPaymentRequirements,
  ChannelState,
  ExactPaymentRequirements,
  Hash32Hex,
  KaspaPaymentPayload,
  NetworkId,
  PaymentPayload,
  PaymentRequired,
  PaymentScheme,
  SettlementResponse,
  UptoPaymentRequirements,
} from "@kaspa-x402/core";
import {
  DirectModeClient,
  MemoryChannelStore,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  paidMcpToolCall,
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
  type UptoAuthorizationFundingRequest,
  type UptoAuthorizationSignRequest,
  type VoucherSignRequest,
} from "../src/index.js";

const SERVER_KEY = "11".repeat(32);
const CLIENT_KEY = "22".repeat(32);
const SALT = "33".repeat(32);
const COMMITMENT = "44".repeat(32);
const FUNDING_TX = "55".repeat(32);
const REFUND_TX = "66".repeat(32);
const EXACT_TX_ID = "77".repeat(32);
const EXACT_TX = "aa".repeat(96);
const UPTO_TX_ID = "88".repeat(32);
const UPTO_RESERVE = "25";

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

    const settlement = await client.applySettlement(payment, makeSettlement(payment.channel!, "100"));
    expect(settlement.channel!.chargedCumulativeAmount).toBe("100");

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
    await client.applySettlement(firstPayment, makeSettlement(firstPayment.channel!, "100"));

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

  it("rejects mainnet funding providers without opt-in", async () => {
    const provider = new FakeFundingProvider("hot-wallet", "kaspa:mainnet");
    const store = new MemoryChannelStore();

    expect(() => makeClient({ provider, store })).toThrow("allowMainnet");
    await expect(store.loadChannels({})).resolves.toHaveLength(0);
  });

  it("rejects mainnet offer selection without opt-in", async () => {
    const provider = new FakeFundingProvider();
    const store = new MemoryChannelStore();

    expect(() => makeClient({ provider, store, supportedNetworks: ["kaspa:testnet-10", "kaspa:mainnet"] })).toThrow("allowMainnet");
  });

  it("rejects the wrong funding network before store or funding work", async () => {
    const provider = new FakeFundingProvider("hot-wallet", "kaspa:mainnet");
    const store = new MemoryChannelStore();
    const client = makeClient({ provider, store, allowMainnet: true });

    await expect(
      client.createPayment(encodePaymentRequiredHeader(makeRequired({ amount: "100" })), {
        url: "https://api.example.test/data",
      }),
    ).rejects.toThrow("funding provider network");
    expect(provider.deposits).toHaveLength(0);
    await expect(store.loadChannels({})).resolves.toHaveLength(0);
  });

  it("creates an exact transfer payload through the funding adapter", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({ provider, store: new MemoryChannelStore() });
    const required = makeExactRequired({ amount: "250" });

    const payment = await client.createPayment(encodePaymentRequiredHeader(required), {
      url: "https://api.example.test/file",
      requestHash: "99".repeat(32),
    });

    expect(payment.scheme).toBe("exact");
    expect(payment.openedChannel).toBe(false);
    expect(payment.channel).toBeUndefined();
    expect(provider.deposits).toHaveLength(0);
    expect(provider.exactPayments).toEqual([
      {
        amount: "250",
        payTo: "kaspatest:payout",
        requestHash: "99".repeat(32),
      },
    ]);
    expect(payment.paymentPayload.payload).toMatchObject({
      type: "exact-transfer",
      transaction: EXACT_TX,
      transactionId: EXACT_TX_ID,
      paymentOutputIndex: 1,
      requestHash: "99".repeat(32),
    });
  });

  it("creates an upto authorization payload through the funding adapter", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({ provider, store: new MemoryChannelStore() });
    const required = makeUptoRequired({ amount: "250" });
    const requestHash = "99".repeat(32);

    const payment = await client.createPayment(encodePaymentRequiredHeader(required), {
      url: "https://api.example.test/variable",
      requestHash,
    });

    expect(payment.scheme).toBe("upto");
    expect(payment.openedChannel).toBe(false);
    expect(payment.channel).toBeUndefined();
    expect(provider.uptoAuthorizations).toEqual([
      expect.objectContaining({
        amount: minimumUptoAuthorizationAmount("250", UPTO_RESERVE),
        payTo: "kaspatest:payout",
        requestHash,
      }),
    ]);
    const payload = payment.paymentPayload.payload;
    if (payload.type !== "upto-authorization") throw new Error("expected upto payload");
    expect(provider.uptoAuthorizations[0]?.authorizationScriptPublicKey).toBe(payload.authorizationScriptPublicKey);
    const digest = uptoAuthorizationDigest({
      network: payment.accepted.network,
      activeScriptPublicKey: payload.authorizationScriptPublicKey,
      authorizationOutpoint: payload.authorizationOutpoint,
      requestHash: payload.authorization.requestHash,
      nonce: payload.authorization.nonce,
    });
    expect(payload).toMatchObject({
      type: "upto-authorization",
      clientPublicKey: CLIENT_KEY,
      authorizationOutpoint: { txid: UPTO_TX_ID, index: 0 },
      authorizationAmountSompi: minimumUptoAuthorizationAmount("250", UPTO_RESERVE),
      refundAddress: "kaspatest:refund",
      authorization: {
        maxAmountSompi: "250",
        payTo: "kaspatest:payout",
        settlementFeeReserveSompi: UPTO_RESERVE,
        validAfterDaa: "1000",
        validBeforeDaa: "1500",
        nonce: SALT,
        serverPublicKey: SERVER_KEY,
        requestHash,
        signature: `${digest}${digest}`,
      },
    });
  });

  it("rejects upto authorization windows that start at the timeout", async () => {
    const provider = new FakeFundingProvider();
    provider.daa = "1500";
    const client = makeClient({ provider, store: new MemoryChannelStore() });

    await expect(
      client.createPayment(encodePaymentRequiredHeader(makeUptoRequired({ amount: "250" })), {
        url: "https://api.example.test/variable",
        requestHash: "12".repeat(32),
      }),
    ).rejects.toThrow("upto authorization window is already expired");
    expect(provider.uptoAuthorizations).toHaveLength(0);
  });

  it("derives a request hash for upto authorizations when one is not supplied", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({ provider, store: new MemoryChannelStore() });

    const payment = await client.createPayment(encodePaymentRequiredHeader(makeUptoRequired({ amount: "250" })), {
      url: "https://api.example.test/variable",
    });

    expect(payment.paymentPayload.payload.type).toBe("upto-authorization");
    expect(provider.uptoAuthorizations).toHaveLength(1);
    expect(provider.uptoAuthorizations[0]?.requestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("falls back to batch settlement on mixed offers when exact funding is unavailable", async () => {
    const provider = new FakeFundingProvider();
    Object.defineProperty(provider, "payExact", { value: undefined });
    const client = makeClient({ provider, store: new MemoryChannelStore() });

    const payment = await client.createPayment(encodePaymentRequiredHeader(makeMixedRequired({ amount: "100" })), {
      url: "https://api.example.test/file",
    });

    expect(payment.scheme).toBe("batch-settlement");
    expect(payment.paymentPayload.payload.type).toBe("deposit-voucher");
    expect(provider.deposits).toHaveLength(1);
    expect(provider.exactPayments).toHaveLength(0);
  });

  it("applies successful exact settlement without channel state", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({ provider, store: new MemoryChannelStore() });
    const payment = await client.createPayment(encodePaymentRequiredHeader(makeExactRequired({ amount: "250" })), {
      url: "https://api.example.test/file",
    });

    const settlement = await client.applySettlement(payment, {
      success: true,
      transaction: EXACT_TX_ID,
      network: "kaspa:testnet-10",
      amount: "250",
      extensions: kaspaSettlementExtensions({
        paymentOutputIndex: 1,
        finality: "accepted",
        requestHash: payment.paymentPayload.payload.type === "exact-transfer" ? payment.paymentPayload.payload.requestHash! : "99".repeat(32),
      }),
    });

    expect(settlement.channel).toBeUndefined();
    expect(settlement.chargedAmount).toBe("250");
    expect(settlement.transactionId).toBe(EXACT_TX_ID);
  });

  it("applies successful upto settlement without channel state", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({ provider, store: new MemoryChannelStore() });
    const payment = await client.createPayment(encodePaymentRequiredHeader(makeUptoRequired({ amount: "250" })), {
      url: "https://api.example.test/variable",
      requestHash: "99".repeat(32),
    });

    const settlement = await client.applySettlement(payment, {
      success: true,
      transaction: UPTO_TX_ID,
      network: "kaspa:testnet-10",
      amount: "125",
      extensions: kaspaSettlementExtensions({
        maxAmountSompi: "250",
        authorizationOutpoint: { txid: UPTO_TX_ID, index: 0 },
        refundAddress: "kaspatest:refund",
        finality: "accepted",
      }),
    });

    expect(settlement.channel).toBeUndefined();
    expect(settlement.chargedAmount).toBe("125");
    expect(settlement.transactionId).toBe(UPTO_TX_ID);
  });

  it("applies pending upto settlement without treating it as final", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({ provider, store: new MemoryChannelStore() });
    const payment = await client.createPayment(encodePaymentRequiredHeader(makeUptoRequired({ amount: "250" })), {
      url: "https://api.example.test/variable",
      requestHash: "99".repeat(32),
    });

    const settlement = await client.applySettlement(payment, {
      success: false,
      errorReason: "upto_authorization_pending",
      transaction: UPTO_TX_ID,
      network: "kaspa:testnet-10",
      amount: "125",
      extensions: kaspaSettlementExtensions({
        maxAmountSompi: "250",
        authorizationOutpoint: { txid: UPTO_TX_ID, index: 0 },
        refundAddress: "kaspatest:refund",
        finality: "mempool",
      }),
    });

    expect(settlement.pending).toBe(true);
    expect(settlement.finality).toBe("mempool");
    expect(settlement.transactionId).toBe(UPTO_TX_ID);
    expect(settlement.chargedAmount).toBe("125");
  });

  it("applies zero-charge upto settlement without a transaction", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({ provider, store: new MemoryChannelStore() });
    const payment = await client.createPayment(encodePaymentRequiredHeader(makeUptoRequired({ amount: "250" })), {
      url: "https://api.example.test/variable",
      requestHash: "99".repeat(32),
    });

    const settlement = await client.applySettlement(payment, {
      success: true,
      transaction: "",
      network: "kaspa:testnet-10",
      amount: "0",
      extensions: kaspaSettlementExtensions({
        chargedAmount: "0",
        maxAmountSompi: "250",
        authorizationOutpoint: { txid: UPTO_TX_ID, index: 0 },
        refundAddress: "kaspatest:refund",
      }),
    });

    expect(settlement.chargedAmount).toBe("0");
    expect(settlement.transactionId).toBeUndefined();
  });

  it("rejects upto settlements that exceed the signed maximum", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({ provider, store: new MemoryChannelStore() });
    const payment = await client.createPayment(encodePaymentRequiredHeader(makeUptoRequired({ amount: "250" })), {
      url: "https://api.example.test/variable",
      requestHash: "99".repeat(32),
    });

    await expect(
      client.applySettlement(payment, {
        success: true,
        transaction: UPTO_TX_ID,
        network: "kaspa:testnet-10",
        amount: "251",
        extensions: kaspaSettlementExtensions({
          maxAmountSompi: "250",
          authorizationOutpoint: { txid: UPTO_TX_ID, index: 0 },
          refundAddress: "kaspatest:refund",
          finality: "accepted",
        }),
      }),
    ).rejects.toThrow("exceeds signed maximum");
  });

  it("rejects exact settlement below the advertised finality", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({ provider, store: new MemoryChannelStore() });
    const payment = await client.createPayment(encodePaymentRequiredHeader(makeExactRequired({ amount: "250", finality: "confirmed" })), {
      url: "https://api.example.test/file",
    });

    await expect(
      client.applySettlement(payment, {
        success: true,
        transaction: EXACT_TX_ID,
        network: "kaspa:testnet-10",
        amount: "250",
        extensions: kaspaSettlementExtensions({
          paymentOutputIndex: 1,
          finality: "accepted",
        }),
      }),
    ).rejects.toThrow("required finality");
  });

  it("rejects exact settlement with a mismatched request hash echo", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({ provider, store: new MemoryChannelStore() });
    const payment = await client.createPayment(encodePaymentRequiredHeader(makeExactRequired({ amount: "250" })), {
      url: "https://api.example.test/file",
      requestHash: "99".repeat(32),
    });

    await expect(
      client.applySettlement(payment, {
        success: true,
        transaction: EXACT_TX_ID,
        network: "kaspa:testnet-10",
        amount: "250",
        extensions: kaspaSettlementExtensions({
          paymentOutputIndex: 1,
          finality: "accepted",
          requestHash: "98".repeat(32),
        }),
      }),
    ).rejects.toThrow("request hash");
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
    const bad = makeSettlement(payment.channel!, "100", {
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
    const bad = makeSettlement(payment.channel!, "100", {
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
      amount: "100",
      extensions: kaspaSettlementExtensions({
        chargedAmount: "100",
        fundingAmount: payment.channel!.fundingAmount,
        channelId: payment.channel!.id,
      }),
    };

    await expect(client.applySettlement(payment, bad)).rejects.toThrow("commitment id");
    const [stored] = await store.loadChannels({});
    expect(stored?.status).toBe("suspicious");
  });

  it("rejects mismatched charged amount in settlement extension", async () => {
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
      extensions: kaspaSettlementExtensions({
        commitmentId: COMMITMENT,
        chargedAmount: "99",
        channelState: channelState(payment.channel!, "100", payment.channel!.signedCumulativeAmount),
      }),
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
    const bad = makeSettlement(payment.channel!, "100");
    if (!bad.extensions?.kaspa) throw new Error("missing extension");
    bad.extensions.kaspa.fundingAmount = "999";

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
    await client.applySettlement(firstPayment, makeSettlement(firstPayment.channel!, "100"));

    const correctiveState = channelState(firstPayment.channel!, "100", "200");
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
    await client.applySettlement(firstPayment, makeSettlement(firstPayment.channel!, "100"));
    provider.utxos.push({
      outpoint: replacementOutpoint,
      amount: "900",
      address: firstPayment.channel!.escrowAddress,
      scriptPublicKey: firstPayment.channel!.activeScriptPublicKey,
    });
    const correctiveRequired = makeRequired({
      amount: "50",
      channelState: {
        ...channelState(firstPayment.channel!, "100", "0"),
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
    await client.applySettlement(firstPayment, makeSettlement(firstPayment.channel!, "100"));

    await expect(
      client.createPayment(
        encodePaymentRequiredHeader(
          makeRequired({
            amount: "50",
            channelState: channelState(firstPayment.channel!, "100", "200"),
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
    await client.applySettlement(firstPayment, makeSettlement(firstPayment.channel!, "100"));
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
    expect(result.settlement?.channel!.chargedCumulativeAmount).toBe("100");
  });

  it("requires explicit requestHash for paidFetch bodies outside the JSON canonicalization profile", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({
      provider,
      store: new MemoryChannelStore(),
      fetch: async () =>
        response(402, {
          "PAYMENT-REQUIRED": encodePaymentRequiredHeader(makeUptoRequired({ amount: "100" })),
        }),
    });

    await expect(
      client.paidFetch("https://api.example.test/variable", {
        body: new URLSearchParams([["a", "b"]]),
      }),
    ).rejects.toThrow("requestHash is required");
  });

  it("does not create a second upto authorization for pending paidFetch settlement", async () => {
    const provider = new FakeFundingProvider();
    const requiredHeader = encodePaymentRequiredHeader(makeUptoRequired({ amount: "100" }));
    let capturedPayment: PaymentPayload | undefined;
    const client = makeClient({
      provider,
      store: new MemoryChannelStore(),
      fetch: async (_input, init) => {
        const paymentHeader =
          init?.headers && !Array.isArray(init.headers) ? (init.headers as Record<string, string>)[PAYMENT_SIGNATURE_HEADER] : undefined;
        if (!paymentHeader) {
          return response(402, {
            "PAYMENT-REQUIRED": requiredHeader,
          });
        }
        capturedPayment = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf8")) as PaymentPayload;
        return response(202, {
          [PAYMENT_RESPONSE_HEADER]: encodePaymentResponseHeader({
            success: false,
            errorReason: "upto_authorization_pending",
            transaction: UPTO_TX_ID,
            network: "kaspa:testnet-10",
            payer: "kaspatest:refund",
            amount: "60",
            extensions: kaspaSettlementExtensions({
              maxAmountSompi: "100",
              authorizationOutpoint: { txid: UPTO_TX_ID, index: 0 },
              refundAddress: "kaspatest:refund",
              finality: "mempool",
            }),
          }),
        });
      },
    });

    const result = await client.paidFetch("https://api.example.test/variable");

    expect(result.response.status).toBe(202);
    expect(result.settlement?.pending).toBe(true);
    expect(result.settlement?.finality).toBe("mempool");
    expect(capturedPayment?.payload.type).toBe("upto-authorization");
    expect(provider.uptoAuthorizations).toHaveLength(1);
  });

  it("drives paid MCP tool calls from structured payment requirements", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({ provider, store: new MemoryChannelStore() });
    const required = makeExactRequired({ amount: "100" });
    const expectedRequestHash = mcpToolCallFingerprint({
      toolName: "download",
      arguments: { id: "alpha" },
      accepted: required.accepts[0]!,
    });
    let attempts = 0;

    const result = await paidMcpToolCall(
      client,
      async (params) => {
        attempts += 1;
        if (!params._meta?.["x402/payment"]) return mcpPaymentRequiredResult(required);
        return {
          content: [{ type: "text", text: "paid data" }],
          _meta: {
            [MCP_PAYMENT_RESPONSE_META_KEY]: exactSettlement("100", expectedRequestHash),
          },
        };
      },
      { name: "download", arguments: { id: "alpha" } },
    );

    expect(attempts).toBe(2);
    expect(result.result.content?.[0]?.text).toBe("paid data");
    expect(result.settlement?.chargedAmount).toBe("100");
    expect(provider.exactPayments[0]?.requestHash).toBe(expectedRequestHash);
  });

  it("uses client mainnet opt-in for paid MCP tool calls", async () => {
    const provider = new FakeFundingProvider("hot-wallet", "kaspa:mainnet");
    const client = makeClient({ provider, store: new MemoryChannelStore(), allowMainnet: true });
    const required = makeExactRequired({ amount: "100", network: "kaspa:mainnet" });
    const expectedRequestHash = mcpToolCallFingerprint({
      toolName: "download",
      arguments: { id: "mainnet" },
      accepted: required.accepts[0]!,
    });

    const result = await paidMcpToolCall(
      client,
      async (params) => {
        if (!params._meta?.["x402/payment"]) return mcpPaymentRequiredResult(required);
        return {
          content: [{ type: "text", text: "paid data" }],
          _meta: {
            [MCP_PAYMENT_RESPONSE_META_KEY]: exactSettlement("100", expectedRequestHash, "kaspa:mainnet"),
          },
        };
      },
      { name: "download", arguments: { id: "mainnet" } },
    );

    expect(result.payment?.accepted.network).toBe("kaspa:mainnet");
    expect(result.settlement?.response.network).toBe("kaspa:mainnet");
    expect(provider.exactPayments[0]?.requestHash).toBe(expectedRequestHash);
  });

  it("uses client scheme policy when fingerprinting MCP payment requirements", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({ provider, store: new MemoryChannelStore(), supportedSchemes: ["exact"] });
    const exactRequired = makeExactRequired({ amount: "100" });
    const required: PaymentRequired = {
      ...exactRequired,
      accepts: [makeRequired({ amount: "100" }).accepts[0], exactRequired.accepts[0]],
    };
    const expectedRequestHash = mcpToolCallFingerprint({
      toolName: "download",
      arguments: { id: "scheme-policy" },
      accepted: exactRequired.accepts[0]!,
    });

    const result = await paidMcpToolCall(
      client,
      async (params) => {
        if (!params._meta?.["x402/payment"]) return mcpPaymentRequiredResult(required);
        return {
          content: [{ type: "text", text: "paid data" }],
          _meta: {
            [MCP_PAYMENT_RESPONSE_META_KEY]: exactSettlement("100", expectedRequestHash),
          },
        };
      },
      { name: "download", arguments: { id: "scheme-policy" } },
    );

    expect(result.payment?.accepted.scheme).toBe("exact");
    expect(provider.exactPayments[0]?.requestHash).toBe(expectedRequestHash);
  });

  it("parses MCP payment requirements from text fallback content", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({ provider, store: new MemoryChannelStore() });
    const required = makeExactRequired({ amount: "100" });
    const expectedRequestHash = mcpToolCallFingerprint({
      toolName: "download",
      arguments: { id: "fallback" },
      accepted: required.accepts[0]!,
    });

    const result = await paidMcpToolCall(
      client,
      async (params) => {
        if (!params._meta?.["x402/payment"]) {
          return {
            isError: true,
            content: [{ type: "text", text: JSON.stringify(required) }],
          };
        }
        return {
          content: [{ type: "text", text: "fallback paid" }],
          _meta: {
            [MCP_PAYMENT_RESPONSE_META_KEY]: exactSettlement("100", expectedRequestHash),
          },
        };
      },
      { name: "download", arguments: { id: "fallback" } },
    );

    expect(result.result.content?.[0]?.text).toBe("fallback paid");
    expect(result.payment?.paymentPayload.payload.type).toBe("exact-transfer");
  });

  it("returns MCP settlement failure results without treating them as paid content", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({ provider, store: new MemoryChannelStore() });
    const required = makeExactRequired({ amount: "100" });

    const result = await paidMcpToolCall(
      client,
      async (params) => {
        if (!params._meta?.["x402/payment"]) return mcpPaymentRequiredResult(required);
        return {
          isError: true,
          content: [{ type: "text", text: "settlement failed" }],
          _meta: {
            [MCP_PAYMENT_RESPONSE_META_KEY]: {
              success: false,
              errorReason: "invalid_kaspa_transaction",
              transaction: "",
              network: "kaspa:testnet-10",
            } satisfies SettlementResponse,
          },
        };
      },
      { name: "download", arguments: { id: "fail" } },
    );

    expect(result.result.isError).toBe(true);
    expect(result.settlement?.chargedAmount).toBe("0");
    expect(result.settlement?.response.success).toBe(false);
  });

  it("handles MCP pending settlements before corrective challenges", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({ provider, store: new MemoryChannelStore() });
    const required = makeUptoRequired({ amount: "100" });
    const expectedRequestHash = mcpToolCallFingerprint({
      toolName: "variable",
      arguments: { id: "pending" },
      accepted: required.accepts[0]!,
    });
    let attempts = 0;

    const result = await paidMcpToolCall(
      client,
      async (params) => {
        attempts += 1;
        if (!params._meta?.["x402/payment"]) return mcpPaymentRequiredResult(required);
        return {
          isError: true,
          structuredContent: required,
          content: [{ type: "text", text: JSON.stringify(required) }],
          _meta: {
            [MCP_PAYMENT_RESPONSE_META_KEY]: {
              success: false,
              errorReason: "upto_authorization_pending",
              transaction: UPTO_TX_ID,
              network: "kaspa:testnet-10",
              payer: "kaspatest:refund",
              amount: "60",
              extensions: kaspaSettlementExtensions({
                maxAmountSompi: "100",
                authorizationOutpoint: { txid: UPTO_TX_ID, index: 0 },
                refundAddress: "kaspatest:refund",
                finality: "mempool",
              }),
            } satisfies SettlementResponse,
          },
        };
      },
      { name: "variable", arguments: { id: "pending" } },
    );

    expect(attempts).toBe(2);
    expect(provider.uptoAuthorizations[0]?.requestHash).toBe(expectedRequestHash);
    expect(result.result.isError).toBe(true);
    expect(result.settlement?.pending).toBe(true);
    expect(result.settlement?.response.errorReason).toBe("upto_authorization_pending");
  });

  it("passes payment identifiers through paidFetch retries", async () => {
    const provider = new FakeFundingProvider();
    const store = new MemoryChannelStore();
    const requiredHeader = encodePaymentRequiredHeader(
      makeRequired({
        amount: "100",
        extensions: {
          "payment-identifier": paymentIdentifierExtension({
            required: true,
          }),
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

    expect(capturedPayment?.extensions?.["payment-identifier"]).toEqual(
      paymentIdentifierExtension({
        required: true,
        id: "pay_7d5d747be160e280504c099d984bcfe0",
      }),
    );
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
    await client.applySettlement(payment, makeSettlement(payment.channel!, "100"));

    await expect(client.listRefundableChannels()).resolves.toHaveLength(0);
    provider.daa = "1000";
    await expect(client.listRefundableChannels()).resolves.toHaveLength(1);

    const refund = await client.refundChannel(payment.channel!.id);
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

    const refund = await client.refundChannel(payment.channel!.id);

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

    await expect(client.refundChannel(payment.channel!.id)).rejects.toThrow("refund transaction amount");
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
  allowMainnet?: boolean;
  supportedNetworks?: readonly NetworkId[];
  supportedSchemes?: readonly PaymentScheme[];
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
    allowMainnet: options.allowMainnet,
    supportedNetworks: options.supportedNetworks,
    supportedSchemes: options.supportedSchemes,
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

function makeExactRequired(input: { amount: string; finality?: "mempool" | "accepted" | "confirmed"; network?: NetworkId }): PaymentRequired {
  return {
    x402Version: X402_VERSION,
    resource: {
      url: "https://api.example.test/file",
    },
    accepts: [
      {
        scheme: "exact",
        network: input.network ?? "kaspa:testnet-10",
        amount: input.amount,
        asset: "KAS",
        payTo: "kaspatest:payout",
        maxTimeoutSeconds: 60,
        extra: {
          binding: "kaspa-exact-v1",
          ...(input.finality ? { finality: input.finality } : {}),
        },
      } satisfies ExactPaymentRequirements,
    ],
  };
}

function makeUptoRequired(input: { amount: string; finality?: "accepted" | "confirmed" }): PaymentRequired {
  return {
    x402Version: X402_VERSION,
    resource: {
      url: "https://api.example.test/variable",
    },
    accepts: [
      {
        scheme: "upto",
        network: "kaspa:testnet-10",
        amount: input.amount,
        asset: "KAS",
        payTo: "kaspatest:payout",
        maxTimeoutSeconds: 60,
        extra: {
          binding: "kaspa-upto-v1",
          authorizationTemplateId: "kaspa-x402-upto-v1",
          serverPublicKey: SERVER_KEY,
          authorizationTimeoutDaa: "1500",
          settlementFeeReserveSompi: UPTO_RESERVE,
          ...(input.finality ? { finality: input.finality } : {}),
        },
      } satisfies UptoPaymentRequirements,
    ],
  };
}

function makeMixedRequired(input: { amount: string }): PaymentRequired {
  return {
    x402Version: X402_VERSION,
    resource: {
      url: "https://api.example.test/file",
    },
    accepts: [makeExactRequired(input).accepts[0], makeRequired(input).accepts[0]],
  };
}

function makeSettlement(channel: DirectModeChannel, chargedAmount: string, stateOverrides: Partial<ChannelState> = {}): SettlementResponse {
  return {
    success: true,
    transaction: COMMITMENT,
    network: channel.config.network,
    amount: chargedAmount,
    extensions: kaspaSettlementExtensions({
      commitmentId: COMMITMENT,
      chargedAmount,
      fundingAmount: channel.fundingAmount,
      channelState: {
        ...channelState(channel, addAmounts(channel.chargedCumulativeAmount, chargedAmount), channel.signedCumulativeAmount),
        ...stateOverrides,
      },
    }),
  };
}

function exactSettlement(amount: string, requestHash: Hash32Hex, network: NetworkId = "kaspa:testnet-10"): SettlementResponse {
  return {
    success: true,
    transaction: EXACT_TX_ID,
    network,
    payer: "kaspatest:refund",
    amount,
    extensions: kaspaSettlementExtensions({
      paymentOutputIndex: 1,
      finality: "accepted",
      requestHash,
    }),
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
  readonly exactPayments: Array<{ amount: string; payTo: string; requestHash?: string }> = [];
  readonly uptoAuthorizations: Array<{ amount: string; payTo: string; requestHash: string; authorizationScriptPublicKey: string }> = [];
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

  async payExact(request: { amount: string; payTo: string; requestHash?: string }) {
    this.exactPayments.push({
      amount: request.amount,
      payTo: request.payTo,
      ...(request.requestHash ? { requestHash: request.requestHash } : {}),
    });
    return {
      transaction: EXACT_TX,
      transactionId: EXACT_TX_ID,
      paymentOutputIndex: 1,
      payerAddress: "kaspatest:refund",
      finality: "accepted" as const,
      fundingSource: this.sourceKind,
    };
  }

  async fundUptoAuthorization(request: UptoAuthorizationFundingRequest) {
    this.uptoAuthorizations.push({
      amount: request.amount,
      payTo: request.payTo,
      requestHash: request.requestHash,
      authorizationScriptPublicKey: request.authorizationScriptPublicKey,
    });
    return {
      outpoint: { txid: UPTO_TX_ID, index: this.uptoAuthorizations.length - 1 },
      amount: request.amount,
      scriptPublicKey: request.authorizationScriptPublicKey,
      payerAddress: "kaspatest:refund",
      finality: "accepted" as const,
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

  async randomNonce(): Promise<Hash32Hex> {
    return SALT;
  }

  async signVoucher({ digest }: VoucherSignRequest) {
    return `${digest}${digest}`;
  }

  async signUptoAuthorization({ digest }: UptoAuthorizationSignRequest) {
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
