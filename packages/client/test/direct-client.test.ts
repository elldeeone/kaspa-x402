import { describe, expect, it, vi } from "vitest";

import {
  MCP_PAYMENT_RESPONSE_META_KEY,
  X402_VERSION,
  encodePaymentRequiredEnvelopeHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  exactRequestAuthorizationDigest,
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
    expect(channels[0]?.signedCumulativeAmount).toBe("100");
    expect(channels[0]?.chargedCumulativeAmount).toBe("100");
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

  it("rejects ambiguous txid-only deposit results", async () => {
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
    ).rejects.toThrow("resolvable escrow outpoint");
  });

  it("rejects deposit results whose resolved UTXO is below the minimum deposit", async () => {
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
    ).rejects.toThrow("below the required minimum deposit");
  });

  it("rejects underfunded offers before funding escrow", async () => {
    const provider = new FakeFundingProvider();
    const client = makeClient({ provider, store: new MemoryChannelStore() });

    await expect(
      client.createPayment(
        encodePaymentRequiredHeader(makeRequired({ amount: "1001" })),
        {
          url: "https://api.example.test/data",
        },
      ),
    ).rejects.toThrow("minimum deposit cannot cover");
    expect(provider.deposits).toHaveLength(0);
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
          payment.channel!.signedCumulativeAmount,
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
      "50",
    );
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
      signedCumulativeAmount: "50",
      latestVoucher: {
        amount: "50",
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
      "125",
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

    const refund = await client.refundChannel(payment.channel!.id);
    expect(refund.transactionId).toBe(REFUND_TX);
    expect(refund.accepted).toBe(true);
    expect(refund.channel.status).toBe("refunded");
  });

  it("does not mark a channel refunded for broadcast-only refund submission", async () => {
    const provider = new FakeFundingProvider();
    provider.daa = "1001";
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
    const payment = await client.createPayment(
      encodePaymentRequiredHeader(makeRequired({ amount: "100" })),
      {
        url: "https://api.example.test/data",
      },
    );

    const refund = await client.refundChannel(payment.channel!.id);

    expect(refund.accepted).toBe(false);
    expect(refund.finality).toBe("broadcast");
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
        async buildRefundTransaction() {
          return { transaction: "ab".repeat(32), refundAmount: "999" };
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
});

function makeClient(options: {
  provider?: FakeFundingProvider;
  store?: MemoryChannelStore;
  fundingSource?: FundingSourceKind;
  fetch?: FetchLike;
  verifyVoucherSignature?: (
    voucher: { amount: string; signature: string },
    channel: DirectModeChannel,
  ) => boolean;
  refundBuilder?: RefundTransactionBuilder;
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
          channel.signedCumulativeAmount,
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
    activeOutpoint: channel.activeOutpoint,
    activeScriptPublicKey: channel.activeScriptPublicKey,
    fundingAmount: channel.fundingAmount,
    chargedCumulativeAmount,
    claimedCumulativeAmount: "0",
    signedMaxClaimable,
  };
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
  depositMode: "outpoint" | "txid-only-ambiguous" | "outpoint-underfunded" =
    "outpoint";
  sendFinality: SendTransactionResult["finality"] = "accepted";
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

  async fundEscrowDeposit(request: EscrowDepositRequest) {
    this.deposits.push({
      amount: request.amount,
      channelId: request.channelId,
    });
    const outpoint = { txid: FUNDING_TX, index: this.deposits.length - 1 };
    const amount =
      this.depositMode === "outpoint-underfunded" ? "50" : request.amount;
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

  async getUtxos(addresses: readonly string[]) {
    return this.utxos.filter(
      (utxo) => utxo.address && addresses.includes(utxo.address),
    );
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
