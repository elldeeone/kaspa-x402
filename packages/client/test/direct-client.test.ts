import { describe, expect, it, vi } from "vitest";

import {
  MCP_PAYMENT_RESPONSE_META_KEY,
  X402_VERSION,
  encodePaymentRequiredEnvelopeHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  exactRequestAuthorizationDigest,
  hexToBytes,
  kaspaSettlementExtensions,
  mcpPaymentRequiredResult,
  mcpToolCallFingerprint,
  paymentIdentifierExtension,
  sha256Hex,
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
} from "@kaspa-x402/core";
import {
  buildKip10AdditiveRedeemScript,
  escrowScriptPublicKey,
  payToScriptHashScript,
  serializedScriptPublicKey,
} from "@kaspa-x402/covenant";
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
  type ExactPaymentRequest,
  type ExactTransactionPaymentRequest,
  type ExactTransactionPaymentResult,
  type FeeEstimateRequest,
  type FetchLike,
  type FundingProvider,
  type FundingPolicy,
  type FundingProviderUtxo,
  type FundingSourceKind,
  type FundingTransitionReconciler,
  type HeaderBag,
  type HttpResponseLike,
  type RefundAttemptRecord,
  type RefundReconciler,
  type RefundTransactionBuilder,
  type SendTransactionResult,
  type VoucherSignRequest,
} from "../src/index.js";

const SERVER_KEY = "11".repeat(32);
const CLIENT_KEY = "22".repeat(32);
const SALT = "33".repeat(32);
const COMMITMENT = "44".repeat(32);
const FUNDING_TX = "55".repeat(32);
const COVENANT_ID = "5a".repeat(32);
const REFUND_TX = "66".repeat(32);
const EXACT_TX_ID = "77".repeat(32);
const EXACT_HEAD_ID = "89".repeat(32);
const EXACT_CHALLENGE_ID = "8a".repeat(32);
const MCP_AUDIENCE = "https://mcp.example.test";
const STANDARD_PAY_TO_SCRIPT_PUBLIC_KEY = `0000${sha256Hex("kaspatest:payout")}`;
const ADDITIVE_HEAD_REDEEM_SCRIPT = buildKip10AdditiveRedeemScript({
  ownerPublicKey: SERVER_KEY,
  amount: "10000000",
});
const ADDITIVE_HEAD_SCRIPT_PUBLIC_KEY = serializedScriptPublicKey(
  payToScriptHashScript(ADDITIVE_HEAD_REDEEM_SCRIPT),
);
const EXACT_TRANSACTION_ARTIFACT = '{"transaction":"signed-kip10-exact"}';

describe("direct-mode client", () => {
  it("opens a deposit-voucher channel for the first paid request", async () => {
    const provider = new FakeFundingProvider();
    const store = new MemoryChannelStore();
    const client = makeClient({ provider, store });
    const required = makeRequired({ amount: "100" });

    const payment = await client.createPayment(
      encodePaymentRequiredHeader(required),
      {
        url: "https://api.example.test/data",
      },
    );

    expect(payment.openedChannel).toBe(true);
    expect(payment.paymentPayload.payload.type).toBe("deposit-voucher");
    expect(provider.deposits).toHaveLength(1);
    expect(provider.deposits[0]?.amount).toBe("1000");

    const settlement = await client.applySettlement(
      payment,
      makeSettlement(payment.channel!, "100"),
    );
    expect(settlement.channel!.chargedCumulativeAmount).toBe("100");

    const channels = await store.loadChannels({});
    expect(channels).toHaveLength(1);
    expect(channels[0]?.signedMaxClaimable).toBe("100");
    expect(channels[0]?.chargedCumulativeAmount).toBe("100");
  });

  it("rejects a batch offer whose minimum deposit omits the claim reserve", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({ provider });

    await expect(
      client.createPayment(
        encodePaymentRequiredHeader(
          makeRequired({
            amount: "995",
            minDepositSompi: "1000",
            claimReserveSompi: "10",
          }),
        ),
        { url: "https://api.example.test/data" },
      ),
    ).rejects.toThrow(
      "minimum deposit does not cover the first batch charge and claim reserve",
    );
    expect(provider.deposits).toHaveLength(0);
  });

  it("reuses an active channel and signs a monotonic cumulative voucher", async () => {
    const provider = new FakeFundingProvider();
    const store = new MemoryChannelStore();
    const client = makeClient({ provider, store });
    const firstRequired = makeRequired({ amount: "100" });
    const firstPayment = await client.createPayment(
      encodePaymentRequiredHeader(firstRequired),
      {
        url: "https://api.example.test/data",
      },
    );
    await client.applySettlement(
      firstPayment,
      makeSettlement(firstPayment.channel!, "100"),
    );

    const secondRequired = makeRequired({ amount: "75" });
    const secondPayment = await client.createPayment(
      encodePaymentRequiredHeader(secondRequired),
      {
        url: "https://api.example.test/data",
      },
    );

    expect(secondPayment.openedChannel).toBe(false);
    expect(secondPayment.paymentPayload.payload.type).toBe("voucher");
    expect(provider.deposits).toHaveLength(1);
    expect(
      voucherBearingPayload(secondPayment.paymentPayload).voucher.amount,
    ).toBe("175");
  });

  it("tops up an under-capacity lane as a same-covenant deposit transition", async () => {
    const provider = new FakeFundingProvider();
    const store = new MemoryChannelStore();
    const client = makeClient({ provider, store });
    const first = await client.createPayment(
      encodePaymentRequiredHeader(makeRequired({ amount: "100" })),
      { url: "https://api.example.test/data" },
    );
    await client.applySettlement(first, makeSettlement(first.channel!, "100"));

    const topped = await client.createPayment(
      encodePaymentRequiredHeader(makeRequired({ amount: "950" })),
      { url: "https://api.example.test/data" },
    );

    expect(topped.openedChannel).toBe(false);
    expect(topped.paymentPayload.payload.type).toBe("deposit-voucher");
    expect(provider.topUps).toEqual([{ targetFundingAmount: "2000" }]);
    expect(topped.channel?.covenantId).toBe(first.channel?.covenantId);
    expect(voucherBearingPayload(topped.paymentPayload).voucher.amount).toBe(
      "1050",
    );
  });

  it("tops up a lane before a voucher would consume its advertised claim reserve", async () => {
    const provider = new FakeFundingProvider();
    const store = new MemoryChannelStore();
    const client = makeClient({ provider, store });
    const first = await client.createPayment(
      encodePaymentRequiredHeader(makeRequired({ amount: "900" })),
      { url: "https://api.example.test/data" },
    );
    await client.applySettlement(first, makeSettlement(first.channel!, "900"));

    const topped = await client.createPayment(
      encodePaymentRequiredHeader(makeRequired({ amount: "95" })),
      { url: "https://api.example.test/data" },
    );

    expect(topped.paymentPayload.payload.type).toBe("deposit-voucher");
    expect(provider.topUps).toEqual([{ targetFundingAmount: "2000" }]);
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
      client.createPayment(
        encodePaymentRequiredHeader(makeRequired({ amount: "100" })),
        {
          url: "https://api.example.test/data",
        },
      ),
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

    expect(() =>
      makeClient({
        provider,
        store,
        supportedNetworks: ["kaspa:testnet-10", "kaspa:mainnet"],
      }),
    ).toThrow("allowMainnet");
  });

  it("rejects the wrong funding network before store or funding work", async () => {
    const provider = new FakeFundingProvider("hot-wallet", "kaspa:mainnet");
    const store = new MemoryChannelStore();
    const client = makeClient({ provider, store, allowMainnet: true });

    await expect(
      client.createPayment(
        encodePaymentRequiredHeader(makeRequired({ amount: "100" })),
        {
          url: "https://api.example.test/data",
        },
      ),
    ).rejects.toThrow("funding provider network");
    expect(provider.deposits).toHaveLength(0);
    await expect(store.loadChannels({})).resolves.toHaveLength(0);
  });

  it("creates an exact-transaction payload through the funding adapter", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({ provider, store: new MemoryChannelStore() });
    const required = makeExactRequired({ amount: "250" });

    const payment = await client.createPayment(
      encodePaymentRequiredHeader(required),
      {
        url: "https://api.example.test/file",
        requestHash: "99".repeat(32),
      },
    );

    expect(payment.scheme).toBe("exact");
    expect(payment.openedChannel).toBe(false);
    expect(payment.channel).toBeUndefined();
    expect(provider.deposits).toHaveLength(0);
    expect(provider.exactPayments).toEqual([
      {
        profile: "standard-native",
        amount: "250",
        payTo: "kaspatest:payout",
        payToScriptPublicKey: STANDARD_PAY_TO_SCRIPT_PUBLIC_KEY,
        requestHash: "99".repeat(32),
        authorizationExpiresAt: expect.any(String),
      },
    ]);
    expect(payment.paymentPayload.payload).toMatchObject({
      type: "exact-transaction",
      transaction: EXACT_TRANSACTION_ARTIFACT,
      transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
      paymentOutputIndex: 0,
      requestHash: "99".repeat(32),
    });
  });

  it("enforces static origin, profile, recipient, and amount pins before exact signing", async () => {
    const required = encodePaymentRequiredHeader(
      makeExactRequired({ amount: "250" }),
    );
    const cases: Array<{ policy: FundingPolicy; message: string }> = [
      {
        policy: { allowedOrigins: ["https://other.example"] },
        message: "origin",
      },
      { policy: { allowedExactProfiles: ["additive"] }, message: "profile" },
      { policy: { allowedPayTo: ["kaspatest:other"] }, message: "recipient" },
      { policy: { maximumExactAmountSompi: "249" }, message: "amount" },
    ];

    for (const testCase of cases) {
      const provider = new FakeFundingProvider();
      const client = makeClient({
        provider,
        store: new MemoryChannelStore(),
        fundingPolicy: testCase.policy,
      });
      await expect(
        client.createPayment(required, {
          url: "https://api.example.test/file",
          requestHash: "99".repeat(32),
        }),
      ).rejects.toThrow(testCase.message);
      expect(provider.exactPayments).toHaveLength(0);
    }
  });

  it("creates the default standard-native exact transaction without head state", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({ provider, store: new MemoryChannelStore() });
    const required = makeStandardExactRequired({ amount: "20000000" });

    const payment = await client.createPayment(
      encodePaymentRequiredHeader(required),
      {
        url: "https://api.example.test/file",
        requestHash: "98".repeat(32),
      },
    );

    expect(provider.exactPayments).toEqual([
      expect.objectContaining({
        profile: "standard-native",
        amount: "20000000",
        payToScriptPublicKey: STANDARD_PAY_TO_SCRIPT_PUBLIC_KEY,
      }),
    ]);
    expect(payment.paymentPayload.payload).toMatchObject({
      type: "exact-transaction",
      profile: "standard-native",
      transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
      paymentOutputIndex: 0,
    });
  });

  it("creates a corrected additive exact transaction from non-exclusive head challenge terms", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({ provider, store: new MemoryChannelStore() });
    const required = makeAdditiveExactRequired({ amount: "20000000" });

    const payment = await client.createPayment(
      encodePaymentRequiredHeader(required),
      {
        url: "https://api.example.test/file",
        requestHash: "97".repeat(32),
      },
    );

    expect(provider.exactPayments).toEqual([
      expect.objectContaining({
        profile: "additive",
        amount: "20000000",
        payToScriptPublicKey: ADDITIVE_HEAD_SCRIPT_PUBLIC_KEY,
        head: {
          headId: EXACT_HEAD_ID,
          headVersion: "7",
          expectedHeadOutpoint: { txid: FUNDING_TX, index: 0 },
          headAmount: "100000000",
          headScriptPublicKey: ADDITIVE_HEAD_SCRIPT_PUBLIC_KEY,
          headRedeemScript: ADDITIVE_HEAD_REDEEM_SCRIPT,
          additiveThresholdSompi: "10000000",
          challengeId: EXACT_CHALLENGE_ID,
          challengeExpiresAt: "2099-01-01T00:00:00.000Z",
        },
      }),
    ]);
    expect(payment.paymentPayload.payload).toMatchObject({
      type: "exact-transaction",
      profile: "additive",
      challengeId: EXACT_CHALLENGE_ID,
      transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
      paymentOutputIndex: 0,
    });
  });

  it("does not authorize an additive payment beyond its head challenge", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T00:00:00.000Z"));
    try {
      const provider = new FakeFundingProvider();
      const client = makeClient({ provider, store: new MemoryChannelStore() });
      const challengeExpiresAt = "2026-07-19T00:00:30.000Z";

      await client.createPayment(
        encodePaymentRequiredHeader(
          makeAdditiveExactRequired({
            amount: "20000000",
            challengeExpiresAt,
          }),
        ),
        {
          url: "https://api.example.test/file",
          requestHash: "96".repeat(32),
        },
      );

      expect(provider.exactPayments[0]?.authorizationExpiresAt).toBe(
        challengeExpiresAt,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects additive offers below their head threshold before invoking the funding adapter", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({ provider, store: new MemoryChannelStore() });

    await expect(
      client.createPayment(
        encodePaymentRequiredHeader(
          makeAdditiveExactRequired({ amount: "9999999" }),
        ),
        {
          url: "https://api.example.test/file",
        },
      ),
    ).rejects.toThrow("must meet the positive head threshold");
    expect(provider.exactPayments).toHaveLength(0);
  });

  it("rejects additive offers whose advertised head is not the canonical KIP-10 script", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({ provider, store: new MemoryChannelStore() });
    const required = makeAdditiveExactRequired({ amount: "20000000" });
    (required.accepts[0] as ExactPaymentRequirements).extra.headRedeemScript =
      "51";

    await expect(
      client.createPayment(encodePaymentRequiredHeader(required), {
        url: "https://api.example.test/file",
      }),
    ).rejects.toThrow("must bind the canonical KIP-10 script");
    expect(provider.exactPayments).toHaveLength(0);
  });

  it("rejects zero-value standard-native exact offers", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({ provider, store: new MemoryChannelStore() });

    await expect(
      client.createPayment(
        encodePaymentRequiredHeader(makeStandardExactRequired({ amount: "0" })),
        {
          url: "https://api.example.test/file",
        },
      ),
    ).rejects.toThrow("exact payment amount must be positive");
    expect(provider.exactPayments).toHaveLength(0);
  });

  it("rejects v2 exact offers whose payTo address and payment script disagree", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({ provider, store: new MemoryChannelStore() });
    const required = makeStandardExactRequired({ amount: "20000000" });
    (
      required.accepts[0] as ExactPaymentRequirements
    ).extra.payToScriptPublicKey = `0000${"ff".repeat(32)}`;

    await expect(
      client.createPayment(encodePaymentRequiredHeader(required), {
        url: "https://api.example.test/file",
      }),
    ).rejects.toThrow(
      "payTo address does not match the advertised payment script",
    );
    expect(provider.exactPayments).toHaveLength(0);
  });

  it("rejects exact-transaction adapter results without transaction id evidence", async () => {
    const provider = new FakeFundingProvider();
    provider.exactMode = "transaction";
    provider.omitExactTransactionId = true;
    const client = makeClient({ provider, store: new MemoryChannelStore() });

    await expect(
      client.createPayment(
        encodePaymentRequiredHeader(makeExactRequired({ amount: "250" })),
        {
          url: "https://api.example.test/file",
          requestHash: "99".repeat(32),
        },
      ),
    ).rejects.toThrow("transaction id evidence");

    expect(provider.exactPayments).toHaveLength(1);
  });

  it("rejects exact-transaction adapter results with the wrong output index", async () => {
    const provider = new FakeFundingProvider();
    provider.exactMode = "transaction";
    provider.exactTransactionOutputIndex = 1;
    const client = makeClient({ provider, store: new MemoryChannelStore() });
    const required = makeExactRequired({ amount: "250" });
    (required.accepts[0] as ExactPaymentRequirements).extra.paymentOutputIndex =
      0;

    await expect(
      client.createPayment(encodePaymentRequiredHeader(required), {
        url: "https://api.example.test/file",
        requestHash: "99".repeat(32),
      }),
    ).rejects.toThrow("output index");

    expect(provider.exactPayments).toHaveLength(1);
  });

  it("does not select exact when its transaction adapter is unavailable", async () => {
    const provider = new FakeFundingProvider();
    Object.defineProperty(provider, "payExactTransaction", {
      value: undefined,
    });
    const client = makeClient({ provider, store: new MemoryChannelStore() });

    await expect(
      client.createPayment(
        encodePaymentRequiredHeader(makeExactRequired({ amount: "250" })),
        {
          url: "https://api.example.test/file",
          requestHash: "99".repeat(32),
        },
      ),
    ).rejects.toThrow("no supported Kaspa x402 requirement");

    expect(provider.exactPayments).toHaveLength(0);
  });

  it("rejects exact adapter results without signed transaction artifacts", async () => {
    const provider = new FakeFundingProvider();
    Object.defineProperty(provider, "payExactTransaction", {
      value: async (request: ExactTransactionPaymentRequest) => {
        provider.exactPayments.push({
          profile: request.profile,
          amount: request.amount,
          payTo: request.payTo,
          payToScriptPublicKey: request.payToScriptPublicKey,
          ...(request.requestHash ? { requestHash: request.requestHash } : {}),
        });
        return {
          transactionId: EXACT_TX_ID,
          paymentOutputIndex: 0,
          payerAddress: "kaspatest:refund",
          finality: "accepted",
          fundingSource: provider.sourceKind,
        };
      },
    });
    const client = makeClient({ provider, store: new MemoryChannelStore() });

    await expect(
      client.createPayment(
        encodePaymentRequiredHeader(makeExactRequired({ amount: "250" })),
        {
          url: "https://api.example.test/file",
          requestHash: "99".repeat(32),
        },
      ),
    ).rejects.toThrow("signed transaction artifacts");

    expect(provider.exactPayments).toHaveLength(1);
  });

  it("rejects exact-transaction settlement for a different known transaction id", async () => {
    const provider = new FakeFundingProvider();
    provider.exactMode = "transaction";
    const client = makeClient({ provider, store: new MemoryChannelStore() });
    const payment = await client.createPayment(
      encodePaymentRequiredHeader(makeExactRequired({ amount: "250" })),
      {
        url: "https://api.example.test/file",
        requestHash: "99".repeat(32),
      },
    );

    await expect(
      client.applySettlement(payment, {
        success: true,
        transaction: "79".repeat(32),
        network: "kaspa:testnet-10",
        amount: "250",
        extensions: kaspaSettlementExtensions({
          paymentOutputIndex: 0,
          finality: "accepted",
          requestHash: "99".repeat(32),
        }),
      }),
    ).rejects.toThrow("transaction id");
  });

  it("falls back to batch settlement on mixed offers when exact funding is unavailable", async () => {
    const provider = new FakeFundingProvider();
    Object.defineProperty(provider, "payExactTransaction", {
      value: undefined,
    });
    const client = makeClient({ provider, store: new MemoryChannelStore() });

    const payment = await client.createPayment(
      encodePaymentRequiredHeader(makeMixedRequired({ amount: "100" })),
      {
        url: "https://api.example.test/file",
      },
    );

    expect(payment.scheme).toBe("batch-settlement");
    expect(payment.paymentPayload.payload.type).toBe("deposit-voucher");
    expect(provider.deposits).toHaveLength(1);
    expect(provider.exactPayments).toHaveLength(0);
  });

  it("selects the supported Kaspa entry from an envelope with foreign scheme and network entries", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({ provider, store: new MemoryChannelStore() });
    const kaspaEntry = makeExactRequired({ amount: "250" }).accepts[0]!;
    const header = encodePaymentRequiredEnvelopeHeader({
      x402Version: X402_VERSION,
      resource: {
        url: "https://api.example.test/file",
      },
      accepts: [foreignEvmEntry(), foreignUptoEntry(), kaspaEntry],
    });

    const payment = await client.createPayment(header, {
      url: "https://api.example.test/file",
      requestHash: "99".repeat(32),
    });

    expect(payment.scheme).toBe("exact");
    expect(payment.accepted).toEqual(kaspaEntry);
    expect(payment.paymentRequired.accepts).toEqual([kaspaEntry]);
    expect(payment.paymentPayload.payload.type).toBe("exact-transaction");
  });

  it("rejects envelopes that offer no supported Kaspa entry", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({ provider, store: new MemoryChannelStore() });
    const header = encodePaymentRequiredEnvelopeHeader({
      x402Version: X402_VERSION,
      resource: {
        url: "https://api.example.test/file",
      },
      accepts: [foreignEvmEntry(), foreignUptoEntry()],
    });

    await expect(
      client.createPayment(header, {
        url: "https://api.example.test/file",
      }),
    ).rejects.toMatchObject({ code: "invalid_kaspa_x402_accepted" });
  });

  it("applies successful exact settlement without channel state", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({ provider, store: new MemoryChannelStore() });
    const payment = await client.createPayment(
      encodePaymentRequiredHeader(makeExactRequired({ amount: "250" })),
      {
        url: "https://api.example.test/file",
      },
    );

    const settlement = await client.applySettlement(payment, {
      success: true,
      transaction: EXACT_TX_ID,
      network: "kaspa:testnet-10",
      amount: "250",
      extensions: kaspaSettlementExtensions({
        exactProfile: "standard-native",
        paymentOutputIndex: 0,
        finality: "accepted",
        requestHash: payment.paymentPayload.payload.requestHash,
      }),
    });

    expect(settlement.channel).toBeUndefined();
    expect(settlement.chargedAmount).toBe("250");
    expect(settlement.transactionId).toBe(EXACT_TX_ID);
  });

  it("requires standard-native settlement evidence to echo the exact profile", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({ provider, store: new MemoryChannelStore() });
    const payment = await client.createPayment(
      encodePaymentRequiredHeader(
        makeStandardExactRequired({ amount: "20000000" }),
      ),
      {
        url: "https://api.example.test/file",
      },
    );
    const response: SettlementResponse = {
      success: true,
      transaction: EXACT_TX_ID,
      network: "kaspa:testnet-10",
      amount: "20000000",
      extensions: kaspaSettlementExtensions({
        paymentOutputIndex: 0,
        finality: "accepted",
        exactProfile: "standard-native",
        requestHash: payment.paymentPayload.payload.requestHash,
      }),
    };

    await expect(
      client.applySettlement(payment, response),
    ).resolves.toMatchObject({ chargedAmount: "20000000" });
    await expect(
      client.applySettlement(payment, {
        ...response,
        extensions: kaspaSettlementExtensions({
          paymentOutputIndex: 0,
          finality: "accepted",
          exactProfile: "additive",
          requestHash: payment.paymentPayload.payload.requestHash,
        }),
      }),
    ).rejects.toThrow("settlement profile");
  });

  it("rejects exact settlement below the advertised finality", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({ provider, store: new MemoryChannelStore() });
    const payment = await client.createPayment(
      encodePaymentRequiredHeader(
        makeExactRequired({ amount: "250", finality: "confirmed" }),
      ),
      {
        url: "https://api.example.test/file",
      },
    );

    await expect(
      client.applySettlement(payment, {
        success: true,
        transaction: EXACT_TX_ID,
        network: "kaspa:testnet-10",
        amount: "250",
        extensions: kaspaSettlementExtensions({
          exactProfile: "standard-native",
          paymentOutputIndex: 0,
          finality: "accepted",
        }),
      }),
    ).rejects.toThrow("required finality");
  });

  it("rejects exact settlement with a mismatched request hash echo", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({ provider, store: new MemoryChannelStore() });
    const payment = await client.createPayment(
      encodePaymentRequiredHeader(makeExactRequired({ amount: "250" })),
      {
        url: "https://api.example.test/file",
        requestHash: "99".repeat(32),
      },
    );

    await expect(
      client.applySettlement(payment, {
        success: true,
        transaction: EXACT_TX_ID,
        network: "kaspa:testnet-10",
        amount: "250",
        extensions: kaspaSettlementExtensions({
          exactProfile: "standard-native",
          paymentOutputIndex: 0,
          finality: "accepted",
          requestHash: "98".repeat(32),
        }),
      }),
    ).rejects.toThrow("request hash");
  });

  it("rejects prepared genesis whose successor is outside its transaction", async () => {
    const provider = new FakeFundingProvider();
    provider.depositMode = "txid-only-ambiguous";
    const client = makeClient({ provider, store: new MemoryChannelStore() });

    await expect(
      client.createPayment(
        encodePaymentRequiredHeader(makeRequired({ amount: "100" })),
        {
          url: "https://api.example.test/data",
        },
      ),
    ).rejects.toThrow("successor must belong to the signed transaction");
  });

  it("rejects deposit results whose resolved UTXO is below the funding target", async () => {
    const provider = new FakeFundingProvider();
    provider.depositMode = "outpoint-underfunded";
    const client = makeClient({ provider, store: new MemoryChannelStore() });

    await expect(
      client.createPayment(
        encodePaymentRequiredHeader(makeRequired({ amount: "100" })),
        {
          url: "https://api.example.test/data",
        },
      ),
    ).rejects.toThrow("below the required funding target");
  });

  it("recovers a prepared genesis after transport uncertainty without rebuilding it", async () => {
    const provider = new FakeFundingProvider();
    provider.fundingSendError = new Error("transport lost after submission");
    const store = new MemoryChannelStore();
    const client = makeClient({ provider, store });
    const required = encodePaymentRequiredHeader(
      makeRequired({ amount: "100" }),
    );

    await expect(
      client.createPayment(required, {
        url: "https://api.example.test/data",
      }),
    ).rejects.toThrow("transport lost after submission");
    const channelId = provider.deposits[0]!.channelId;
    const attempt = await store.loadFundingTransitionAttempt(channelId);
    expect(attempt).toMatchObject({
      kind: "genesis",
      channelId,
      transaction: "ad".repeat(32),
      transactionId: FUNDING_TX,
      status: "pending",
    });
    await expect(store.loadChannels({})).resolves.toHaveLength(0);
    await expect(
      client.createPayment(required, {
        url: "https://api.example.test/data",
      }),
    ).rejects.toThrow("reconcile it before reopening");
    expect(provider.deposits).toHaveLength(1);

    const restartedStore = new MemoryChannelStore([], [], [attempt!]);
    provider.utxos.push(
      provider.pendingFunding.get(attempt!.transaction)!.successor,
    );
    const recoveringClient = makeClient({
      provider,
      store: restartedStore,
      fundingTransitionReconciler: {
        async reconcileFundingTransition(persisted) {
          return {
            status: "accepted",
            transactionId: persisted.transactionId,
            finality: "accepted",
          };
        },
      },
    });
    const recovered = await recoveringClient.reconcileFundingTransition(
      channelId.toUpperCase(),
    );
    expect(recovered).toMatchObject({
      channelId,
      kind: "genesis",
      transactionId: FUNDING_TX,
      finality: "accepted",
      accepted: true,
      channel: {
        id: channelId,
        activeOutpoint: attempt!.intendedSuccessor.outpoint,
        requiresDepositVoucher: true,
      },
    });
    await expect(
      recoveringClient.reconcileFundingTransition(channelId),
    ).resolves.toEqual(recovered);
    const resumed = await recoveringClient.createPayment(required, {
      url: "https://api.example.test/data",
    });
    expect(resumed.openedChannel).toBe(false);
    expect(resumed.paymentPayload.payload.type).toBe("deposit-voucher");
    expect(provider.deposits).toHaveLength(1);
  });

  it("keeps a broadcast-only top-up on its exact captured head until reconciliation", async () => {
    const provider = new FakeFundingProvider();
    const store = new MemoryChannelStore();
    const client = makeClient({ provider, store });
    const first = await client.createPayment(
      encodePaymentRequiredHeader(makeRequired({ amount: "100" })),
      { url: "https://api.example.test/data" },
    );
    await client.applySettlement(first, makeSettlement(first.channel!, "100"));
    const [captured] = await store.loadChannels({});
    provider.fundingSendFinality = "broadcast";

    await expect(
      client.createPayment(
        encodePaymentRequiredHeader(makeRequired({ amount: "950" })),
        { url: "https://api.example.test/data" },
      ),
    ).rejects.toThrow("reconcile the persisted transaction");
    const attempt = await store.loadFundingTransitionAttempt(captured!.id);
    expect(attempt).toMatchObject({
      kind: "top-up",
      expectedChannel: {
        activeOutpoint: captured!.activeOutpoint,
        chargedCumulativeAmount: "100",
        claimedCumulativeAmount: "0",
        signedMaxClaimable: "100",
      },
      intendedSuccessor: {
        amount: "2000",
      },
      status: "broadcast",
      finality: "broadcast",
    });
    await expect(
      store.applyFundingTransitionAttempt({
        kind: "top-up",
        channelId: captured!.id,
        transactionId: "ff".repeat(32),
        finality: "accepted",
        evidence: {
          covenantId: captured!.covenantId,
          spentOutpoint: captured!.activeOutpoint,
          successorOutpoint: attempt!.intendedSuccessor.outpoint,
          successorScriptPublicKey:
            attempt!.intendedSuccessor.scriptPublicKey,
          successorAmount: attempt!.intendedSuccessor.amount,
          authorizedSuccessorCount: 1,
        },
      }),
    ).rejects.toThrow("transaction id does not match");
    await expect(
      store.saveChannel({ ...captured!, status: "suspicious" }),
    ).rejects.toThrow("open funding transition");
    await expect(
      client.createPayment(
        encodePaymentRequiredHeader(makeRequired({ amount: "50" })),
        { url: "https://api.example.test/data" },
      ),
    ).rejects.toThrow("unresolved");
    expect(provider.topUps).toHaveLength(1);

    const restartedStore = new MemoryChannelStore(
      await store.loadChannels({}),
      [],
      [attempt!],
    );
    provider.utxos.push(
      provider.pendingFunding.get(attempt!.transaction)!.successor,
    );
    const recoveringClient = makeClient({
      provider,
      store: restartedStore,
      fundingTransitionReconciler: {
        async reconcileFundingTransition(persisted) {
          return {
            status: "accepted",
            transactionId: persisted.transactionId.toUpperCase(),
            finality: "confirmed",
          };
        },
      },
    });
    const recovered = await recoveringClient.reconcileFundingTransition(
      captured!.id.toUpperCase(),
    );
    expect(recovered).toMatchObject({
      kind: "top-up",
      accepted: true,
      finality: "confirmed",
      channel: {
        activeOutpoint: attempt!.intendedSuccessor.outpoint,
        fundingAmount: "2000",
        chargedCumulativeAmount: "100",
        claimedCumulativeAmount: "0",
        signedMaxClaimable: "100",
        requiresDepositVoucher: true,
      },
    });
    const appliedAttempt = await restartedStore.loadFundingTransitionAttempt(
      captured!.id,
    );
    expect(
      () =>
        new MemoryChannelStore(
          [recovered.channel!],
          [],
          [appliedAttempt!],
        ),
    ).not.toThrow();
  });

  it("requires trusted absence before releasing a broadcast genesis for retry", async () => {
    const provider = new FakeFundingProvider();
    provider.fundingSendFinality = "broadcast";
    const store = new MemoryChannelStore();
    const required = encodePaymentRequiredHeader(
      makeRequired({ amount: "100" }),
    );
    const client = makeClient({
      provider,
      store,
      fundingTransitionReconciler: {
        async reconcileFundingTransition(attempt) {
          return {
            status: "absent",
            transactionId: attempt.transactionId,
            reason: "authoritative rejection",
          };
        },
      },
    });

    await expect(
      client.createPayment(required, {
        url: "https://api.example.test/data",
      }),
    ).rejects.toThrow("not accepted");
    const channelId = provider.deposits[0]!.channelId;
    await expect(
      client.reconcileFundingTransition(channelId),
    ).resolves.toMatchObject({ accepted: false, finality: "absent" });
    await expect(
      store.loadFundingTransitionAttempt(channelId),
    ).resolves.toBeUndefined();

    provider.fundingSendFinality = "accepted";
    await expect(
      client.createPayment(required, {
        url: "https://api.example.test/data",
      }),
    ).resolves.toMatchObject({ openedChannel: true });
    expect(provider.deposits).toHaveLength(2);
  });

  it("rejects accepted genesis evidence when the funding transaction has another output", async () => {
    const provider = new FakeFundingProvider();
    provider.genesisTotalOutputCount = 2;
    const store = new MemoryChannelStore();
    const client = makeClient({ provider, store });

    await expect(
      client.createPayment(
        encodePaymentRequiredHeader(makeRequired({ amount: "100" })),
        { url: "https://api.example.test/data" },
      ),
    ).rejects.toThrow("single-output KIP-20 covenant");
    const attempt = await store.loadFundingTransitionAttempt(
      provider.deposits[0]!.channelId,
    );
    expect(attempt).toMatchObject({
      status: "broadcast",
      transactionId: FUNDING_TX,
    });
    await expect(store.loadChannels({})).resolves.toHaveLength(0);
  });

  it("funds the advertised minimum that includes the first charge and reserve", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({ provider, store: new MemoryChannelStore() });

    await client.createPayment(
      encodePaymentRequiredHeader(
        makeRequired({ amount: "1001", minDepositSompi: "1011" }),
      ),
      {
        url: "https://api.example.test/data",
      },
    );

    expect(provider.deposits).toEqual([
      { amount: "1011", channelId: expect.any(String) },
    ]);
  });

  it("marks a channel suspicious when settlement state identifies another channel", async () => {
    const provider = new FakeFundingProvider();
    const store = new MemoryChannelStore();
    const client = makeClient({ provider, store });
    const payment = await client.createPayment(
      encodePaymentRequiredHeader(makeRequired({ amount: "100" })),
      {
        url: "https://api.example.test/data",
      },
    );
    const bad = makeSettlement(payment.channel!, "100", {
      channelId: "ff".repeat(32),
    });

    await expect(client.applySettlement(payment, bad)).rejects.toThrow(
      "channel id",
    );
    const [stored] = await store.loadChannels({});
    expect(stored?.status).toBe("suspicious");
  });

  it("rejects settlement state that does not match this request transition", async () => {
    const provider = new FakeFundingProvider();
    const store = new MemoryChannelStore();
    const client = makeClient({ provider, store });
    const payment = await client.createPayment(
      encodePaymentRequiredHeader(makeRequired({ amount: "100" })),
      {
        url: "https://api.example.test/data",
      },
    );
    const bad = makeSettlement(payment.channel!, "100", {
      chargedCumulativeAmount: "99",
    });

    await expect(client.applySettlement(payment, bad)).rejects.toThrow(
      "charged cumulative",
    );
    const [stored] = await store.loadChannels({});
    expect(stored?.status).toBe("suspicious");
  });

  it("rejects successful voucher settlement without durable commitment state", async () => {
    const provider = new FakeFundingProvider();
    const store = new MemoryChannelStore();
    const client = makeClient({ provider, store });
    const payment = await client.createPayment(
      encodePaymentRequiredHeader(makeRequired({ amount: "100" })),
      {
        url: "https://api.example.test/data",
      },
    );
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

    await expect(client.applySettlement(payment, bad)).rejects.toThrow(
      "commitment id",
    );
    const [stored] = await store.loadChannels({});
    expect(stored?.status).toBe("suspicious");
  });

  it("rejects mismatched charged amount in settlement extension", async () => {
    const provider = new FakeFundingProvider();
    const store = new MemoryChannelStore();
    const client = makeClient({ provider, store });
    const payment = await client.createPayment(
      encodePaymentRequiredHeader(makeRequired({ amount: "100" })),
      {
        url: "https://api.example.test/data",
      },
    );
    const bad: SettlementResponse = {
      success: true,
      transaction: "",
      network: payment.accepted.network,
      amount: "100",
      extensions: kaspaSettlementExtensions({
        commitmentId: COMMITMENT,
        chargedAmount: "99",
        channelState: channelState(
          payment.channel!,
          "100",
          payment.channel!.signedMaxClaimable,
        ),
      }),
    };

    await expect(client.applySettlement(payment, bad)).rejects.toThrow(
      "charged amount",
    );
  });

  it("verifies deposit settlement funding amount", async () => {
    const provider = new FakeFundingProvider();
    const store = new MemoryChannelStore();
    const client = makeClient({ provider, store });
    const payment = await client.createPayment(
      encodePaymentRequiredHeader(makeRequired({ amount: "100" })),
      {
        url: "https://api.example.test/data",
      },
    );
    const bad = makeSettlement(payment.channel!, "100");
    if (!bad.extensions?.kaspa) throw new Error("missing extension");
    bad.extensions.kaspa.fundingAmount = "999";

    await expect(client.applySettlement(payment, bad)).rejects.toThrow(
      "funding amount",
    );
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
    const firstPayment = await client.createPayment(
      encodePaymentRequiredHeader(makeRequired({ amount: "100" })),
      {
        url: "https://api.example.test/data",
      },
    );
    await client.applySettlement(
      firstPayment,
      makeSettlement(firstPayment.channel!, "100"),
    );

    const correctiveState = channelState(firstPayment.channel!, "100", "200");
    const correctiveRequired = makeRequired({
      amount: "50",
      channelState: correctiveState,
      voucherState: {
        amount: "200",
        signature: "aa".repeat(64),
      },
    });
    const correctivePayment = await client.createPayment(
      encodePaymentRequiredHeader(correctiveRequired),
      {
        url: "https://api.example.test/data",
      },
    );

    expect(verified).toBe(1);
    expect(correctivePayment.openedChannel).toBe(false);
    expect(correctivePayment.paymentPayload.payload.type).toBe("voucher");
    expect(
      voucherBearingPayload(correctivePayment.paymentPayload).voucher.amount,
    ).toBe("200");
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
        verifierSawReplacement =
          channel.activeOutpoint.txid === replacementOutpoint.txid;
        return true;
      },
    });
    const firstPayment = await client.createPayment(
      encodePaymentRequiredHeader(makeRequired({ amount: "100" })),
      {
        url: "https://api.example.test/data",
      },
    );
    await client.applySettlement(
      firstPayment,
      makeSettlement(firstPayment.channel!, "100"),
    );
    const successorScriptPublicKey = v2EscrowScriptPublicKey(
      firstPayment.channel!,
      "100",
    );
    provider.utxos.push({
      outpoint: replacementOutpoint,
      covenantId: firstPayment.channel!.covenantId,
      amount: "900",
      address: firstPayment.channel!.escrowAddress,
      scriptPublicKey: successorScriptPublicKey,
    });
    const correctiveRequired = makeRequired({
      amount: "50",
      channelState: {
        ...channelState(firstPayment.channel!, "100", "100"),
        activeOutpoint: replacementOutpoint,
        activeScriptPublicKey: successorScriptPublicKey,
        fundingAmount: "900",
        claimedCumulativeAmount: "100",
      },
      voucherState: {
        amount: "100",
        signature: "aa".repeat(64),
      },
    });

    const payment = await client.createPayment(
      encodePaymentRequiredHeader(correctiveRequired),
      {
        url: "https://api.example.test/data",
      },
    );

    expect(verifierSawReplacement).toBe(true);
    expect(payment.openedChannel).toBe(false);
    expect(
      voucherBearingPayload(payment.paymentPayload).fundingOutpoint,
    ).toEqual(replacementOutpoint);
    expect(voucherBearingPayload(payment.paymentPayload).voucher.amount).toBe(
      "150",
    );
    const [stored] = await store.loadChannels({});
    expect(stored?.escrowAddress).toBe(
      `kaspatest:${sha256Hex(successorScriptPublicKey).slice(0, 32)}`,
    );
  });

  it("rejects corrective state whose script does not encode its claimed amount", async () => {
    const provider = new FakeFundingProvider();
    const store = new MemoryChannelStore();
    const client = makeClient({
      provider,
      store,
      verifyVoucherSignature: () => true,
    });
    const firstPayment = await client.createPayment(
      encodePaymentRequiredHeader(makeRequired({ amount: "100" })),
      {
        url: "https://api.example.test/data",
      },
    );
    await client.applySettlement(
      firstPayment,
      makeSettlement(firstPayment.channel!, "100"),
    );
    const [original] = await store.loadChannels({});
    if (!original) throw new Error("missing stored channel");
    const replacementOutpoint = { txid: "78".repeat(32), index: 0 };
    provider.utxos.push({
      outpoint: replacementOutpoint,
      covenantId: original.covenantId,
      amount: "900",
      address: original.escrowAddress,
      scriptPublicKey: original.activeScriptPublicKey,
    });
    const correctiveRequired = makeRequired({
      amount: "50",
      channelState: {
        ...channelState(original, "100", "100"),
        activeOutpoint: replacementOutpoint,
        fundingAmount: "900",
        claimedCumulativeAmount: "100",
      },
      voucherState: {
        amount: "100",
        signature: "aa".repeat(64),
      },
    });

    await expect(
      client.createPayment(encodePaymentRequiredHeader(correctiveRequired), {
        url: "https://api.example.test/data",
      }),
    ).rejects.toThrow(
      "corrective active script does not match lifetime settled accounting",
    );

    const [afterRejection] = await store.loadChannels({});
    expect(afterRejection).toEqual(original);
    expect(afterRejection?.status).toBe("active");
  });

  it("rejects corrective channel state without voucher proof", async () => {
    const provider = new FakeFundingProvider();
    const store = new MemoryChannelStore();
    const client = makeClient({ provider, store });
    const firstPayment = await client.createPayment(
      encodePaymentRequiredHeader(makeRequired({ amount: "100" })),
      {
        url: "https://api.example.test/data",
      },
    );
    await client.applySettlement(
      firstPayment,
      makeSettlement(firstPayment.channel!, "100"),
    );

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
    const firstPayment = await client.createPayment(
      encodePaymentRequiredHeader(makeRequired({ amount: "100" })),
      {
        url: "https://api.example.test/data",
      },
    );
    await client.applySettlement(
      firstPayment,
      makeSettlement(firstPayment.channel!, "100"),
    );
    const [stored] = await store.loadChannels({});
    if (!stored) throw new Error("missing stored channel");
    await store.saveChannel({
      ...stored,
      chargedCumulativeAmount: "300",
      claimedCumulativeAmount: "250",
      signedMaxClaimable: "300",
      latestVoucher: {
        covenantId: stored.covenantId,
        amount: "300",
        signature: "dd".repeat(64),
      },
    });

    const payment = await client.createPayment(
      encodePaymentRequiredHeader(makeRequired({ amount: "75" })),
      {
        url: "https://api.example.test/data",
      },
    );

    expect(payment.openedChannel).toBe(false);
    expect(voucherBearingPayload(payment.paymentPayload).voucher.amount).toBe(
      "375",
    );
  });

  it("drives paid HTTP fetch with PAYMENT headers", async () => {
    const provider = new FakeFundingProvider();
    const store = new MemoryChannelStore();
    const requiredHeader = encodePaymentRequiredHeader(
      makeRequired({ amount: "100" }),
    );
    let capturedPayment: PaymentPayload | undefined;
    const client = makeClient({
      provider,
      store,
      fetch: async (_input, init) => {
        const paymentHeader =
          init?.headers && !Array.isArray(init.headers)
            ? (init.headers as Record<string, string>)[PAYMENT_SIGNATURE_HEADER]
            : undefined;
        if (!paymentHeader) {
          return response(402, {
            "PAYMENT-REQUIRED": requiredHeader,
          });
        }
        capturedPayment = JSON.parse(
          Buffer.from(paymentHeader, "base64").toString("utf8"),
        ) as PaymentPayload;
        const [channel] = await store.loadChannels({});
        if (!channel) throw new Error("missing channel");
        return response(200, {
          [PAYMENT_RESPONSE_HEADER]: encodePaymentResponseHeader(
            makeSettlement(channel, "100"),
          ),
        });
      },
    });

    const result = await client.paidFetch("https://api.example.test/data");

    expect(result.response.status).toBe(200);
    expect(capturedPayment?.payload.type).toBe("deposit-voucher");
    expect(result.settlement?.channel!.chargedCumulativeAmount).toBe("100");
  });

  it("rejects redirected payment challenges before signing", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({
      provider,
      store: new MemoryChannelStore(),
      fetch: async (_input, init) => {
        expect(init?.redirect).toBe("error");
        return response(
          402,
          {
            "PAYMENT-REQUIRED": encodePaymentRequiredHeader(
              makeExactRequired({ amount: "100" }),
            ),
          },
          "https://attacker.example/payment",
          true,
        );
      },
    });

    await expect(
      client.paidFetch("https://api.example.test/data"),
    ).rejects.toThrow("redirected away from the authorized request URL");
    expect(provider.exactPayments).toHaveLength(0);
  });

  it("accepts same-origin relative paidFetch URLs in browsers", async () => {
    vi.stubGlobal("location", {
      href: "https://api.example.test/application",
    });
    try {
      const client = makeClient({
        provider: new FakeFundingProvider(),
        store: new MemoryChannelStore(),
        fetch: async (input, init) => {
          expect(input).toBe("/data");
          expect(init?.redirect).toBe("error");
          return response(200, {}, "https://api.example.test/data");
        },
      });

      const result = await client.paidFetch("/data");

      expect(result.response.status).toBe(200);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects redirected relative paidFetch URLs in browsers", async () => {
    vi.stubGlobal("location", {
      href: "https://api.example.test/application",
    });
    try {
      const client = makeClient({
        provider: new FakeFundingProvider(),
        store: new MemoryChannelStore(),
        fetch: async () =>
          response(200, {}, "https://attacker.example/data", true),
      });

      await expect(client.paidFetch("/data")).rejects.toThrow(
        "redirected away from the authorized request URL",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects a changed effective URL on the paid retry", async () => {
    const provider = new FakeFundingProvider();
    let attempts = 0;
    const client = makeClient({
      provider,
      store: new MemoryChannelStore(),
      fetch: async (_input, init) => {
        attempts += 1;
        expect(init?.redirect).toBe("error");
        if (attempts === 1) {
          return response(402, {
            "PAYMENT-REQUIRED": encodePaymentRequiredHeader(
              makeExactRequired({ amount: "100" }),
            ),
          });
        }
        return response(200, {}, "https://attacker.example/payment", true);
      },
    });

    await expect(
      client.paidFetch("https://api.example.test/data"),
    ).rejects.toThrow("redirected away from the authorized request URL");
    expect(attempts).toBe(2);
    expect(provider.exactPayments).toHaveLength(1);
  });

  it("requires explicit requestHash for paidFetch bodies outside the JSON canonicalization profile", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({
      provider,
      store: new MemoryChannelStore(),
      fetch: async () =>
        response(
          402,
          {
            "PAYMENT-REQUIRED": encodePaymentRequiredHeader(
              makeExactRequired({ amount: "100" }),
            ),
          },
          "https://api.example.test/variable",
        ),
    });

    await expect(
      client.paidFetch("https://api.example.test/variable", {
        body: new URLSearchParams([["a", "b"]]),
      }),
    ).rejects.toThrow("requestHash is required");
  });

  it("drives paid MCP tool calls from structured payment requirements", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({ provider, store: new MemoryChannelStore() });
    const required = makeExactRequired({ amount: "100" });
    const expectedRequestHash = mcpToolCallFingerprint({
      audience: MCP_AUDIENCE,
      toolName: "download",
      arguments: { id: "alpha" },
      accepted: required.accepts[0]!,
    });
    let attempts = 0;

    const result = await paidMcpToolCall(
      client,
      async (params) => {
        attempts += 1;
        if (!params._meta?.["x402/payment"])
          return mcpPaymentRequiredResult(required);
        return {
          content: [{ type: "text", text: "paid data" }],
          _meta: {
            [MCP_PAYMENT_RESPONSE_META_KEY]: exactSettlement(
              "100",
              expectedRequestHash,
            ),
          },
        };
      },
      { name: "download", arguments: { id: "alpha" } },
      { audience: MCP_AUDIENCE },
    );

    expect(attempts).toBe(2);
    expect(result.result.content?.[0]?.text).toBe("paid data");
    expect(result.settlement?.chargedAmount).toBe("100");
    expect(provider.exactPayments[0]?.requestHash).toBe(expectedRequestHash);
  });

  it("uses client mainnet opt-in for paid MCP tool calls", async () => {
    const provider = new FakeFundingProvider("hot-wallet", "kaspa:mainnet");
    const client = makeClient({
      provider,
      store: new MemoryChannelStore(),
      allowMainnet: true,
    });
    const required = makeExactRequired({
      amount: "100",
      network: "kaspa:mainnet",
    });
    const expectedRequestHash = mcpToolCallFingerprint({
      audience: MCP_AUDIENCE,
      toolName: "download",
      arguments: { id: "mainnet" },
      accepted: required.accepts[0]!,
    });

    const result = await paidMcpToolCall(
      client,
      async (params) => {
        if (!params._meta?.["x402/payment"])
          return mcpPaymentRequiredResult(required);
        return {
          content: [{ type: "text", text: "paid data" }],
          _meta: {
            [MCP_PAYMENT_RESPONSE_META_KEY]: exactSettlement(
              "100",
              expectedRequestHash,
              "kaspa:mainnet",
            ),
          },
        };
      },
      { name: "download", arguments: { id: "mainnet" } },
      { audience: MCP_AUDIENCE },
    );

    expect(result.payment?.accepted.network).toBe("kaspa:mainnet");
    expect(result.settlement?.response.network).toBe("kaspa:mainnet");
    expect(provider.exactPayments[0]?.requestHash).toBe(expectedRequestHash);
  });

  it("uses client scheme policy when fingerprinting MCP payment requirements", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({
      provider,
      store: new MemoryChannelStore(),
      supportedSchemes: ["exact"],
    });
    const exactRequired = makeExactRequired({ amount: "100" });
    const required: PaymentRequired = {
      ...exactRequired,
      accepts: [
        makeRequired({ amount: "100" }).accepts[0],
        exactRequired.accepts[0],
      ],
    };
    const expectedRequestHash = mcpToolCallFingerprint({
      audience: MCP_AUDIENCE,
      toolName: "download",
      arguments: { id: "scheme-policy" },
      accepted: exactRequired.accepts[0]!,
    });

    const result = await paidMcpToolCall(
      client,
      async (params) => {
        if (!params._meta?.["x402/payment"])
          return mcpPaymentRequiredResult(required);
        return {
          content: [{ type: "text", text: "paid data" }],
          _meta: {
            [MCP_PAYMENT_RESPONSE_META_KEY]: exactSettlement(
              "100",
              expectedRequestHash,
            ),
          },
        };
      },
      { name: "download", arguments: { id: "scheme-policy" } },
      { audience: MCP_AUDIENCE },
    );

    expect(result.payment?.accepted.scheme).toBe("exact");
    expect(provider.exactPayments[0]?.requestHash).toBe(expectedRequestHash);
  });

  it("parses MCP payment requirements from text fallback content", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({ provider, store: new MemoryChannelStore() });
    const required = makeExactRequired({ amount: "100" });
    const expectedRequestHash = mcpToolCallFingerprint({
      audience: MCP_AUDIENCE,
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
            [MCP_PAYMENT_RESPONSE_META_KEY]: exactSettlement(
              "100",
              expectedRequestHash,
            ),
          },
        };
      },
      { name: "download", arguments: { id: "fallback" } },
      { audience: MCP_AUDIENCE },
    );

    expect(result.result.content?.[0]?.text).toBe("fallback paid");
    expect(result.payment?.paymentPayload.payload.type).toBe(
      "exact-transaction",
    );
  });

  it("returns MCP settlement failure results without treating them as paid content", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({ provider, store: new MemoryChannelStore() });
    const required = makeExactRequired({ amount: "100" });

    const result = await paidMcpToolCall(
      client,
      async (params) => {
        if (!params._meta?.["x402/payment"])
          return mcpPaymentRequiredResult(required);
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
      { audience: MCP_AUDIENCE },
    );

    expect(result.result.isError).toBe(true);
    expect(result.settlement?.chargedAmount).toBe("0");
    expect(result.settlement?.response.success).toBe(false);
  });

  it("treats hybrid MCP settlement failures as terminal without retrying again", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({ provider, store: new MemoryChannelStore() });
    const required = makeExactRequired({ amount: "100" });
    const settlement: SettlementResponse = {
      success: false,
      errorReason: "invalid_transaction_state",
      transaction: "",
      network: "kaspa:testnet-10",
    };
    let calls = 0;

    const result = await paidMcpToolCall(
      client,
      async (params) => {
        calls += 1;
        if (!params._meta?.["x402/payment"])
          return mcpPaymentRequiredResult(required);
        const challenge = { ...required, error: "invalid_transaction_state" };
        return {
          isError: true,
          structuredContent: challenge,
          content: [{ type: "text", text: JSON.stringify(challenge) }],
          _meta: {
            [MCP_PAYMENT_RESPONSE_META_KEY]: settlement,
          },
        };
      },
      { name: "download", arguments: { id: "hybrid-fail" } },
      { audience: MCP_AUDIENCE },
    );

    expect(calls).toBe(2);
    expect(provider.exactPayments).toHaveLength(1);
    expect(result.result.isError).toBe(true);
    expect(result.settlement?.chargedAmount).toBe("0");
    expect(result.settlement?.response).toEqual(settlement);
  });

  it("does not sign a second MCP payment for corrective requirements", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({ provider, store: new MemoryChannelStore() });
    const required = makeExactRequired({ amount: "100" });
    let calls = 0;

    await expect(
      paidMcpToolCall(
        client,
        async (params) => {
          calls += 1;
          if (!params._meta?.["x402/payment"])
            return mcpPaymentRequiredResult(required);
          return mcpPaymentRequiredResult({
            ...required,
            error: "invalid_transaction_state",
          });
        },
        { name: "download", arguments: { id: "corrective" } },
        { audience: MCP_AUDIENCE },
      ),
    ).rejects.toThrow("new explicit payment authorization");

    expect(calls).toBe(2);
    expect(provider.exactPayments).toHaveLength(1);
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
            tenant: "tenant-a",
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
          init?.headers && !Array.isArray(init.headers)
            ? (init.headers as Record<string, string>)[PAYMENT_SIGNATURE_HEADER]
            : undefined;
        if (!paymentHeader) {
          return response(402, {
            "PAYMENT-REQUIRED": requiredHeader,
          });
        }
        capturedPayment = JSON.parse(
          Buffer.from(paymentHeader, "base64").toString("utf8"),
        ) as PaymentPayload;
        const [channel] = await store.loadChannels({});
        if (!channel) throw new Error("missing channel");
        return response(200, {
          [PAYMENT_RESPONSE_HEADER]: encodePaymentResponseHeader(
            makeSettlement(channel, "100"),
          ),
        });
      },
    });

    await client.paidFetch("https://api.example.test/data", {
      paymentIdentifier: "pay_7d5d747be160e280504c099d984bcfe0",
    });

    expect(capturedPayment?.extensions?.["payment-identifier"]).toEqual(
      paymentIdentifierExtension({
        required: true,
        tenant: "tenant-a",
        id: "pay_7d5d747be160e280504c099d984bcfe0",
      }),
    );
  });

  it("requires a new explicit authorization for a corrective paid-fetch 402", async () => {
    const provider = new FakeFundingProvider();
    const store = new MemoryChannelStore();
    let retryCount = 0;
    const client = makeClient({
      provider,
      store,
      verifyVoucherSignature: () => true,
      fetch: async (_input, init) => {
        const paymentHeader =
          init?.headers && !Array.isArray(init.headers)
            ? (init.headers as Record<string, string>)[PAYMENT_SIGNATURE_HEADER]
            : undefined;
        if (!paymentHeader) {
          return response(402, {
            "PAYMENT-REQUIRED": encodePaymentRequiredHeader(
              makeRequired({ amount: "100" }),
            ),
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
          [PAYMENT_RESPONSE_HEADER]: encodePaymentResponseHeader(
            makeSettlement(channel, "50"),
          ),
        });
      },
    });

    await expect(
      client.paidFetch("https://api.example.test/data"),
    ).rejects.toThrow("requires a new explicit payment authorization");
    expect(retryCount).toBe(1);
  });

  it("lists and refunds timeout-unlocked channels through adapters", async () => {
    const provider = new FakeFundingProvider();
    provider.daa = "999";
    provider.sendFinality = "accepted";
    const store = new MemoryChannelStore();
    const refundDigest = "dd".repeat(32);
    const signedDigests: string[] = [];
    const client = makeClient({
      provider,
      store,
      refundBuilder: {
        async buildRefundTransaction(request) {
          expect(request.refundAmount).toBe("1000");
          expect(await request.signDigest(refundDigest)).toBe("cc".repeat(64));
          signedDigests.push(refundDigest);
          return {
            transaction: "ab".repeat(32),
            transactionId: REFUND_TX,
            refundAmount: request.refundAmount,
          };
        },
      },
    });
    const payment = await client.createPayment(
      encodePaymentRequiredHeader(makeRequired({ amount: "100" })),
      {
        url: "https://api.example.test/data",
      },
    );
    await client.applySettlement(
      payment,
      makeSettlement(payment.channel!, "100"),
    );

    await expect(client.listRefundableChannels()).resolves.toHaveLength(0);
    provider.daa = "1000";
    await expect(client.listRefundableChannels()).resolves.toHaveLength(0);
    provider.daa = "1001";
    await expect(client.listRefundableChannels()).resolves.toHaveLength(1);

    const refund = await client.refundChannel(
      payment.channel!.id.toUpperCase(),
    );
    expect(refund.transactionId).toBe(REFUND_TX);
    expect(refund.accepted).toBe(true);
    expect(refund.channel.status).toBe("refunded");
    expect(signedDigests).toEqual([refundDigest]);
  });

  it("does not mark a channel refunded for broadcast-only refund submission", async () => {
    const provider = new FakeFundingProvider();
    provider.daa = "1001";
    provider.sendFinality = "broadcast";
    const store = new MemoryChannelStore();
    const client = makeClient({
      provider,
      store,
      refundReconciler: {
        async reconcileRefund(attempt) {
          return {
            status: "unknown",
            transactionId: attempt.transactionId,
            reason: "not yet indexed",
          };
        },
      },
      refundBuilder: {
        async buildRefundTransaction(request) {
          await request.signDigest("dd".repeat(32));
          return {
            transaction: "ab".repeat(32),
            transactionId: REFUND_TX,
            refundAmount: request.refundAmount,
          };
        },
      },
    });
    const payment = await client.createPayment(
      encodePaymentRequiredHeader(makeRequired({ amount: "100" })),
      {
        url: "https://api.example.test/data",
      },
    );

    const refund = await client.refundChannel(payment.channel!.id);

    expect(refund.accepted).toBe(false);
    expect(refund.finality).toBe("broadcast");
    await expect(
      store.loadRefundAttempt(payment.channel!.id),
    ).resolves.toMatchObject({
      transaction: "ab".repeat(32),
      transactionId: REFUND_TX,
      status: "broadcast",
      finality: "broadcast",
    });
    await expect(client.refundChannel(payment.channel!.id)).rejects.toThrow(
      "refund attempt is unresolved",
    );
    const sendsBeforeReconcile = provider.sendCount;
    provider.utxos.length = 0;
    await expect(
      client.reconcileRefund(payment.channel!.id),
    ).resolves.toMatchObject({
      accepted: false,
      finality: "unknown",
      transactionId: REFUND_TX,
    });
    expect(provider.sendCount).toBe(sendsBeforeReconcile);
    await expect(
      store.loadRefundAttempt(payment.channel!.id),
    ).resolves.toMatchObject({ status: "broadcast", finality: "broadcast" });
    await expect(client.listRefundableChannels()).resolves.toHaveLength(0);
    const [stored] = await store.loadChannels({});
    expect(stored?.status).toBe("active");
  });

  it("rejects refund transactions whose amount differs from the signed amount", async () => {
    const provider = new FakeFundingProvider();
    provider.daa = "1001";
    provider.sendFinality = "accepted";
    const store = new MemoryChannelStore();
    const client = makeClient({
      provider,
      store,
      refundBuilder: {
        async buildRefundTransaction(request) {
          await request.signDigest("dd".repeat(32));
          return {
            transaction: "ab".repeat(32),
            transactionId: REFUND_TX,
            refundAmount: "999",
          };
        },
      },
    });
    const payment = await client.createPayment(
      encodePaymentRequiredHeader(makeRequired({ amount: "100" })),
      {
        url: "https://api.example.test/data",
      },
    );

    await expect(client.refundChannel(payment.channel!.id)).rejects.toThrow(
      "refund transaction amount",
    );
    const [stored] = await store.loadChannels({});
    expect(stored?.status).toBe("active");
  });

  it("atomically applies a durable refund attempt only against its captured head", async () => {
    const provider = new FakeFundingProvider();
    const store = new MemoryChannelStore();
    const client = makeClient({ provider, store });
    const payment = await client.createPayment(
      encodePaymentRequiredHeader(makeRequired({ amount: "100" })),
      { url: "https://api.example.test/data" },
    );
    const channel = payment.channel!;
    const attempt: RefundAttemptRecord = {
      channelId: channel.id,
      covenantId: channel.covenantId,
      activeOutpoint: channel.activeOutpoint,
      activeScriptPublicKey: channel.activeScriptPublicKey,
      fundingAmount: channel.fundingAmount,
      channelStatus: channel.status,
      refundAmount: channel.fundingAmount,
      transaction: "ab".repeat(32),
      transactionId: REFUND_TX,
      status: "pending",
    };

    await store.claimRefundAttempt(attempt);
    await expect(store.claimRefundAttempt(attempt)).rejects.toThrow(
      "already pending",
    );
    const changed = {
      ...channel,
      activeOutpoint: { txid: "67".repeat(32), index: 0 },
    };
    await expect(store.saveChannel(changed)).rejects.toThrow("open refund");
    await expect(
      store.saveChannel({ ...channel, id: channel.id.toUpperCase() }),
    ).rejects.toThrow("open refund");
    await expect(store.retireChannel(channel.id)).rejects.toThrow(
      "open refund",
    );
    await expect(store.deleteChannel(channel.id)).rejects.toThrow(
      "open refund",
    );
    expect(() => new MemoryChannelStore([changed], [attempt])).toThrow(
      "does not match channel state",
    );
    expect(
      () =>
        new MemoryChannelStore(
          [channel],
          [{ ...attempt, status: "corrupt" as never }],
        ),
    ).toThrow("does not match channel state");
    await expect(
      store.applyRefundAttempt({
        channelId: channel.id,
        transactionId: REFUND_TX,
        finality: "broadcast" as never,
      }),
    ).rejects.toThrow("accepted finality");
    const applied = await store.applyRefundAttempt({
      channelId: channel.id,
      transactionId: REFUND_TX,
      finality: "accepted",
    });
    expect(applied.channel.status).toBe("refunded");
    expect(applied.attempt.status).toBe("applied");
    await expect(store.saveChannel(applied.channel)).rejects.toThrow(
      "terminal refund",
    );
    await expect(store.retireChannel(channel.id)).rejects.toThrow(
      "terminal refund",
    );
    await expect(store.deleteChannel(channel.id)).rejects.toThrow(
      "terminal refund",
    );
    await expect(
      store.applyRefundAttempt({
        channelId: channel.id,
        transactionId: "67".repeat(32),
        finality: "accepted",
      }),
    ).rejects.toThrow("transaction id does not match");
    await expect(store.loadRefundAttempt(channel.id)).resolves.toMatchObject({
      status: "applied",
    });
  });

  it("recovers a pending refund after a send exception and is idempotent", async () => {
    const provider = new FakeFundingProvider();
    provider.daa = "1001";
    provider.sendError = new Error("transport lost after submission");
    const store = new MemoryChannelStore();
    const refundBuilder: RefundTransactionBuilder = {
      async buildRefundTransaction(request) {
        await request.signDigest("dd".repeat(32));
        return {
          transaction: "ab".repeat(32),
          transactionId: REFUND_TX,
          refundAmount: request.refundAmount,
        };
      },
    };
    const client = makeClient({ provider, store, refundBuilder });
    const payment = await client.createPayment(
      encodePaymentRequiredHeader(makeRequired({ amount: "100" })),
      { url: "https://api.example.test/data" },
    );

    await expect(client.refundChannel(payment.channel!.id)).rejects.toThrow(
      "transport lost",
    );
    await expect(
      store.loadRefundAttempt(payment.channel!.id),
    ).resolves.toMatchObject({
      transaction: "ab".repeat(32),
      transactionId: REFUND_TX,
      activeOutpoint: payment.channel!.activeOutpoint,
      activeScriptPublicKey: payment.channel!.activeScriptPublicKey,
      covenantId: payment.channel!.covenantId,
      refundAmount: payment.channel!.fundingAmount,
      status: "pending",
    });

    const persistedChannels = await store.loadChannels({});
    const persistedAttempt = await store.loadRefundAttempt(payment.channel!.id);
    const restartedStore = new MemoryChannelStore(persistedChannels, [
      persistedAttempt!,
    ]);
    const restarted = makeClient({
      provider,
      store: restartedStore,
      refundBuilder,
    });
    await expect(restarted.refundChannel(payment.channel!.id)).rejects.toThrow(
      "refund attempt is unresolved",
    );
    const reconciler: RefundReconciler = {
      async reconcileRefund(attempt) {
        expect(attempt.transactionId).toBe(REFUND_TX);
        expect(attempt.transaction).toBe("ab".repeat(32));
        return {
          status: "accepted",
          transactionId: attempt.transactionId,
          finality: "accepted",
        };
      },
    };
    const recoveringClient = makeClient({
      provider,
      store: restartedStore,
      refundBuilder,
      refundReconciler: reconciler,
    });
    const recovered = await recoveringClient.reconcileRefund(
      payment.channel!.id.toUpperCase(),
    );
    expect(recovered.channel.status).toBe("refunded");
    expect(recovered.accepted).toBe(true);
    await expect(
      recoveringClient.reconcileRefund(payment.channel!.id),
    ).resolves.toEqual(recovered);
    await expect(
      restartedStore.loadRefundAttempt(payment.channel!.id),
    ).resolves.toMatchObject({
      status: "applied",
      finality: "accepted",
    });
  });

  it("fails closed when the refund transaction id does not match", async () => {
    const provider = new FakeFundingProvider();
    provider.daa = "1001";
    const store = new MemoryChannelStore();
    const client = makeClient({
      provider,
      store,
      refundBuilder: {
        async buildRefundTransaction(request) {
          await request.signDigest("dd".repeat(32));
          return {
            transaction: "ab".repeat(32),
            transactionId: "68".repeat(32),
            refundAmount: request.refundAmount,
          };
        },
      },
      refundReconciler: {
        async reconcileRefund() {
          return {
            status: "accepted",
            transactionId: "69".repeat(32),
            finality: "confirmed",
          };
        },
      },
    });
    const payment = await client.createPayment(
      encodePaymentRequiredHeader(makeRequired({ amount: "100" })),
      { url: "https://api.example.test/data" },
    );

    await expect(client.refundChannel(payment.channel!.id)).rejects.toThrow(
      "transaction id does not match",
    );
    await expect(client.reconcileRefund(payment.channel!.id)).rejects.toThrow(
      "transaction id does not match",
    );
    await expect(
      store.loadRefundAttempt(payment.channel!.id),
    ).resolves.toMatchObject({
      transactionId: "68".repeat(32),
      status: "pending",
    });
    const [stored] = await store.loadChannels({});
    expect(stored?.status).toBe("active");
  });
});

function makeClient(options: {
  provider?: FakeFundingProvider;
  store?: MemoryChannelStore;
  fundingSource?: FundingSourceKind;
  fetch?: FetchLike;
  verifyVoucherSignature?: (
    voucher: { covenantId: string; amount: string; signature: string },
    channel: DirectModeChannel,
  ) => boolean;
  refundBuilder?: RefundTransactionBuilder;
  refundReconciler?: RefundReconciler;
  fundingTransitionReconciler?: FundingTransitionReconciler;
  allowMainnet?: boolean;
  supportedNetworks?: readonly NetworkId[];
  supportedSchemes?: readonly PaymentScheme[];
  fundingPolicy?: FundingPolicy;
}): DirectModeClient {
  const provider = options.provider ?? new FakeFundingProvider();
  return new DirectModeClient({
    fundingProvider: provider,
    signer: new FakeSigner(),
    store: options.store ?? new MemoryChannelStore(),
    addressCodec: new FakeAddressCodec(),
    fundingPolicy:
      options.fundingPolicy ??
      (options.fundingSource
        ? { requiredSource: options.fundingSource }
        : undefined),
    fetch: options.fetch as never,
    verifyVoucherSignature: options.verifyVoucherSignature,
    refundBuilder: options.refundBuilder,
    refundReconciler: options.refundReconciler,
    fundingTransitionReconciler: options.fundingTransitionReconciler,
    allowMainnet: options.allowMainnet,
    supportedNetworks: options.supportedNetworks,
    supportedSchemes: options.supportedSchemes,
  });
}

function makeRequired(input: {
  amount: string;
  minDepositSompi?: string;
  claimReserveSompi?: string;
  channelState?: ChannelState;
  voucherState?: { covenantId?: string; amount: string; signature: string };
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
          binding: "kaspa-escrow-v2",
          templateId: "kaspa-x402-escrow-v2",
          serverPublicKey: SERVER_KEY,
          minDepositSompi: input.minDepositSompi ?? "1000",
          claimReserveSompi: input.claimReserveSompi ?? "10",
          refundTimeoutDaa: "1000",
          ...(input.channelState ? { channelState: input.channelState } : {}),
          ...(input.voucherState
            ? {
                voucherState: {
                  covenantId:
                    input.voucherState.covenantId ??
                    input.channelState?.covenantId ??
                    COVENANT_ID,
                  amount: input.voucherState.amount,
                  signature: input.voucherState.signature,
                },
              }
            : {}),
        },
      } satisfies BatchPaymentRequirements,
    ],
    ...(input.extensions ? { extensions: input.extensions } : {}),
  };
}

function makeExactRequired(input: {
  amount: string;
  finality?: "mempool" | "accepted" | "confirmed";
  network?: NetworkId;
}): PaymentRequired {
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
          binding: "kaspa-exact-v2",
          profile: "standard-native",
          finality: input.finality ?? "accepted",
          transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
          payToScriptPublicKey: STANDARD_PAY_TO_SCRIPT_PUBLIC_KEY,
        },
      } satisfies ExactPaymentRequirements,
    ],
  };
}

function makeStandardExactRequired(input: {
  amount: string;
  network?: NetworkId;
}): PaymentRequired {
  return {
    x402Version: X402_VERSION,
    resource: { url: "https://api.example.test/file" },
    accepts: [
      {
        scheme: "exact",
        network: input.network ?? "kaspa:testnet-10",
        amount: input.amount,
        asset: "KAS",
        payTo: "kaspatest:payout",
        maxTimeoutSeconds: 60,
        extra: {
          binding: "kaspa-exact-v2",
          profile: "standard-native",
          finality: "accepted",
          transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
          payToScriptPublicKey: STANDARD_PAY_TO_SCRIPT_PUBLIC_KEY,
        },
      } satisfies ExactPaymentRequirements,
    ],
  };
}

function makeAdditiveExactRequired(input: {
  amount: string;
  network?: NetworkId;
  challengeExpiresAt?: string;
}): PaymentRequired {
  return {
    x402Version: X402_VERSION,
    resource: { url: "https://api.example.test/file" },
    accepts: [
      {
        scheme: "exact",
        network: input.network ?? "kaspa:testnet-10",
        amount: input.amount,
        asset: "KAS",
        payTo: "kaspatest:head",
        maxTimeoutSeconds: 60,
        extra: {
          binding: "kaspa-exact-v2",
          profile: "additive",
          finality: "accepted",
          transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
          payToScriptPublicKey: ADDITIVE_HEAD_SCRIPT_PUBLIC_KEY,
          templateId: "kaspa-x402-kip10-additive-v1",
          headId: EXACT_HEAD_ID,
          headVersion: "7",
          expectedHeadOutpoint: { txid: FUNDING_TX, index: 0 },
          headAmount: "100000000",
          headScriptPublicKey: ADDITIVE_HEAD_SCRIPT_PUBLIC_KEY,
          headRedeemScript: ADDITIVE_HEAD_REDEEM_SCRIPT,
          additiveThresholdSompi: "10000000",
          paymentOutputIndex: 0,
          challengeId: EXACT_CHALLENGE_ID,
          challengeExpiresAt:
            input.challengeExpiresAt ?? "2099-01-01T00:00:00.000Z",
        },
      } satisfies ExactPaymentRequirements,
    ],
  };
}

function makeMixedRequired(input: { amount: string }): PaymentRequired {
  return {
    x402Version: X402_VERSION,
    resource: {
      url: "https://api.example.test/file",
    },
    accepts: [
      makeExactRequired(input).accepts[0],
      makeRequired(input).accepts[0],
    ],
  };
}

function foreignEvmEntry(): Record<string, unknown> {
  return {
    scheme: "exact",
    network: "eip155:8453",
    amount: "1000",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    payTo: "0x0000000000000000000000000000000000000001",
    maxTimeoutSeconds: 60,
    extra: {},
  };
}

function foreignUptoEntry(): Record<string, unknown> {
  return {
    scheme: "upto",
    network: "kaspa:testnet-10",
    amount: "1000",
    asset: "KAS",
    payTo: "kaspatest:payout",
    maxTimeoutSeconds: 60,
    extra: {
      binding: "kaspa-upto-v1",
    },
  };
}

function makeSettlement(
  channel: DirectModeChannel,
  chargedAmount: string,
  stateOverrides: Partial<ChannelState> = {},
): SettlementResponse {
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
        ...channelState(
          channel,
          addAmounts(channel.chargedCumulativeAmount, chargedAmount),
          channel.signedMaxClaimable,
        ),
        ...stateOverrides,
      },
    }),
  };
}

function exactSettlement(
  amount: string,
  requestHash: Hash32Hex,
  network: NetworkId = "kaspa:testnet-10",
): SettlementResponse {
  return {
    success: true,
    transaction: EXACT_TX_ID,
    network,
    payer: "kaspatest:refund",
    amount,
    extensions: kaspaSettlementExtensions({
      exactProfile: "standard-native",
      paymentOutputIndex: 0,
      finality: "accepted",
      requestHash,
      transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
    }),
  };
}

function addAmounts(a: string, b: string): string {
  return (BigInt(a) + BigInt(b)).toString();
}

function voucherBearingPayload(
  paymentPayload: PaymentPayload,
): Extract<KaspaPaymentPayload, { type: "deposit-voucher" | "voucher" }> {
  const payload = paymentPayload.payload;
  if (payload.type !== "deposit-voucher" && payload.type !== "voucher") {
    throw new Error("expected voucher-bearing payload");
  }
  return payload;
}

function channelState(
  channel: DirectModeChannel,
  chargedCumulativeAmount: string,
  signedMaxClaimable: string,
): ChannelState {
  return {
    channelId: channel.id,
    covenantId: channel.covenantId,
    activeOutpoint: channel.activeOutpoint,
    activeScriptPublicKey: channel.activeScriptPublicKey,
    fundingAmount: channel.fundingAmount,
    chargedCumulativeAmount,
    claimedCumulativeAmount: channel.claimedCumulativeAmount,
    signedMaxClaimable,
  };
}

function v2EscrowScriptPublicKey(
  channel: DirectModeChannel,
  settledTotal: string,
): string {
  const codec = new FakeAddressCodec();
  return serializedScriptPublicKey(
    escrowScriptPublicKey({
      clientPublicKey: channel.config.clientPublicKey,
      serverPublicKey: channel.config.serverPublicKey,
      network: channel.config.network,
      payoutScriptPublicKeyHash: sha256Hex(
        hexToBytes(codec.scriptPublicKeyForAddress(channel.config.payTo)),
      ),
      refundScriptPublicKeyHash: sha256Hex(
        hexToBytes(
          codec.scriptPublicKeyForAddress(channel.config.refundAddress),
        ),
      ),
      timeoutDaa: channel.config.refundTimeoutDaa,
      settledTotal,
    }),
  );
}

function response(
  status: number,
  headers: Record<string, string>,
  url = "https://api.example.test/data",
  redirected = false,
): HttpResponseLike {
  return {
    status,
    headers: new TestHeaders(headers),
    url,
    redirected,
  };
}

class TestHeaders implements HeaderBag {
  readonly #headers: Record<string, string>;

  constructor(headers: Record<string, string>) {
    this.#headers = Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
    );
  }

  get(name: string): string | null {
    return this.#headers[name.toLowerCase()] ?? null;
  }
}

class FakeFundingProvider implements FundingProvider {
  readonly networkId: NetworkId;
  readonly sourceKind: FundingSourceKind;
  readonly deposits: Array<{ amount: string; channelId: string }> = [];
  readonly topUps: Array<{ targetFundingAmount: string }> = [];
  readonly exactPayments: Array<{
    profile: ExactPaymentRequest["profile"];
    amount: string;
    payTo: string;
    payToScriptPublicKey?: string;
    requestHash?: string;
    authorizationExpiresAt?: string;
    head?: ExactPaymentRequest["head"];
  }> = [];
  readonly utxos: FundingProviderUtxo[] = [];
  readonly pendingFunding = new Map<
    string,
    { transactionId: string; successor: FundingProviderUtxo }
  >();
  depositMode: "outpoint" | "txid-only-ambiguous" | "outpoint-underfunded" =
    "outpoint";
  sendFinality: SendTransactionResult["finality"] = "accepted";
  sendError?: Error;
  fundingSendFinality: SendTransactionResult["finality"] = "accepted";
  fundingSendError?: Error;
  genesisTotalOutputCount = 1;
  genesisAuthorizedOutputCount = 1;
  sendCount = 0;
  exactMode: "transaction" | "artifactless" = "transaction";
  omitExactTransactionId = false;
  exactTransactionOutputIndex?: number;
  daa = "1000";

  constructor(
    sourceKind: FundingSourceKind = "hot-wallet",
    networkId: NetworkId = "kaspa:testnet-10",
  ) {
    this.sourceKind = sourceKind;
    this.networkId = networkId;
  }

  async getPublicIdentity() {
    return { address: "kaspatest:refund", publicKey: CLIENT_KEY };
  }

  async authorizeExactPayment(_request: ExactTransactionPaymentRequest) {}

  async prepareEscrowDeposit(request: EscrowDepositRequest) {
    this.deposits.push({
      amount: request.amount,
      channelId: request.channelId,
    });
    const outpoint = { txid: FUNDING_TX, index: this.deposits.length - 1 };
    const amount =
      this.depositMode === "outpoint-underfunded" ? "50" : request.amount;
    const successor = {
      outpoint,
      covenantId: COVENANT_ID,
      amount,
      address: request.escrowAddress,
      scriptPublicKey: request.escrowScriptPublicKey,
    };
    if (this.depositMode === "txid-only-ambiguous") {
      return {
        transaction: "ad".repeat(32),
        transactionId: FUNDING_TX,
        successor: {
          ...successor,
          outpoint: { txid: "56".repeat(32), index: 10 },
        },
        fundingSource: this.sourceKind,
      };
    }
    this.pendingFunding.set("ad".repeat(32), {
      transactionId: FUNDING_TX,
      successor,
    });
    return {
      transaction: "ad".repeat(32),
      transactionId: FUNDING_TX,
      successor,
      fundingSource: this.sourceKind,
    };
  }

  async payExactTransaction(request: ExactTransactionPaymentRequest) {
    this.exactPayments.push({
      profile: request.profile,
      amount: request.amount,
      payTo: request.payTo,
      payToScriptPublicKey: request.payToScriptPublicKey,
      ...(request.requestHash ? { requestHash: request.requestHash } : {}),
      authorizationExpiresAt: request.authorizationExpiresAt,
      ...(request.head ? { head: request.head } : {}),
    });
    if (this.exactMode === "artifactless") {
      return {
        transactionId: EXACT_TX_ID,
        paymentOutputIndex: 0,
        payerAddress: "kaspatest:refund",
        finality: "accepted",
        fundingSource: this.sourceKind,
      } as unknown as ExactTransactionPaymentResult;
    }
    const paymentOutputIndex =
      this.exactTransactionOutputIndex ?? request.paymentOutputIndex ?? 0;
    const expiresAt = request.authorizationExpiresAt;
    const digest = exactRequestAuthorizationDigest({
      network: request.network,
      profile: request.profile,
      transactionId: EXACT_TX_ID,
      paymentOutputIndex,
      amount: request.amount,
      payTo: request.payTo,
      payToScriptPublicKey: request.payToScriptPublicKey,
      paymentRequirementsHash: request.paymentRequirementsHash,
      requestHash: request.requestHash,
      challengeId: request.head?.challengeId,
      inputIndex: request.profile === "additive" ? 1 : 0,
      expiresAt,
    });
    return {
      transaction: EXACT_TRANSACTION_ARTIFACT,
      transactionEncoding: "kaspa-sdk-safe-json-v2.0.0" as const,
      ...(this.omitExactTransactionId ? {} : { transactionId: EXACT_TX_ID }),
      paymentOutputIndex,
      authorization: {
        version: "kaspa-x402-exact-request-authorization-v1" as const,
        inputIndex: request.profile === "additive" ? 1 : 0,
        expiresAt,
        digest,
        signature: "ab".repeat(64),
      },
      payerAddress: "kaspatest:refund",
      fundingSource: this.sourceKind,
    } as ExactTransactionPaymentResult;
  }

  async prepareEscrowTopUp(request: {
    channel: DirectModeChannel;
    targetFundingAmount: string;
  }) {
    this.topUps.push({ targetFundingAmount: request.targetFundingAmount });
    const outpoint = { txid: "5c".repeat(32), index: this.topUps.length - 1 };
    const successor = {
      outpoint,
      covenantId: request.channel.covenantId,
      amount: request.targetFundingAmount,
      scriptPublicKey: request.channel.activeScriptPublicKey,
      address: request.channel.escrowAddress,
    };
    this.pendingFunding.set("ae".repeat(32), {
      transactionId: outpoint.txid,
      successor,
    });
    return {
      transaction: "ae".repeat(32),
      transactionId: outpoint.txid,
      successor,
      fundingSource: this.sourceKind,
    };
  }

  async getUtxos(addresses: readonly string[]) {
    return this.utxos.filter(
      (utxo) => utxo.address && addresses.includes(utxo.address),
    );
  }

  async getUtxo(outpoint: { txid: string; index: number }) {
    return (
      this.utxos.find(
        (utxo) =>
          utxo.outpoint.txid.toLowerCase() === outpoint.txid.toLowerCase() &&
          utxo.outpoint.index === outpoint.index,
      ) ?? null
    );
  }

  async verifyCovenantGenesis(request: {
    prepared: { successor: FundingProviderUtxo };
    utxo: FundingProviderUtxo;
  }) {
    return {
      covenantId: request.utxo.covenantId!,
      authorizingInput: { txid: "5b".repeat(32), index: 0 },
      genesisOutpoint: request.utxo.outpoint,
      genesisScriptPublicKey: request.utxo.scriptPublicKey,
      genesisAmount: request.utxo.amount,
      totalOutputCount: this.genesisTotalOutputCount,
      authorizedOutputCount: this.genesisAuthorizedOutputCount,
    };
  }

  async verifyCovenantTopUp(request: {
    previous: DirectModeChannel;
    prepared: { successor: FundingProviderUtxo };
    successor: FundingProviderUtxo;
  }) {
    return {
      covenantId: request.previous.covenantId,
      spentOutpoint: request.previous.activeOutpoint,
      successorOutpoint: request.successor.outpoint,
      successorScriptPublicKey: request.successor.scriptPublicKey,
      successorAmount: request.successor.amount,
      authorizedSuccessorCount: 1,
    };
  }

  async getVirtualDaaScore() {
    return this.daa;
  }

  async sendTransaction(transaction: string) {
    this.sendCount += 1;
    const funding = this.pendingFunding.get(transaction.toLowerCase());
    if (funding) {
      if (this.fundingSendError) throw this.fundingSendError;
      const finality = this.fundingSendFinality;
      if (finality === "accepted" || finality === "confirmed") {
        this.utxos.push(funding.successor);
      }
      return { transactionId: funding.transactionId, finality };
    }
    if (this.sendError) throw this.sendError;
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

  async signRefund() {
    return "cc".repeat(64);
  }
}

class FakeAddressCodec implements AddressCodec {
  scriptPublicKeyForAddress(address: string): string {
    if (address === "kaspatest:head") return ADDITIVE_HEAD_SCRIPT_PUBLIC_KEY;
    return `0000${sha256Hex(address)}`;
  }

  encodeScriptAddress(input: { serializedScriptPublicKey: string }): string {
    return `kaspatest:${sha256Hex(input.serializedScriptPublicKey).slice(0, 32)}`;
  }
}
