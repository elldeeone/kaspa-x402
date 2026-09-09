import { describe, expect, it } from "vitest";

import {
  batchPaymentAuthorizationIntentPreimage,
  batchPaymentAuthorizationIntentDigest,
  batchPaymentRequirementsHash,
  batchPaymentRequirementsPreimage,
  batchPresentationDigest,
  batchPresentationExpiryError,
  validateBatchPaymentAuthorization,
  validatePaymentPayload,
  type BatchPaymentAuthorizationIntent,
  type BatchPaymentAuthorizationPolicy,
  type BatchPaymentRequirements,
} from "../src/index.js";

const H = (byte: string) => byte.repeat(64);

const accepted: BatchPaymentRequirements = {
  scheme: "batch-settlement",
  network: "kaspa:testnet-10",
  amount: "500",
  asset: "KAS",
  payTo: "kaspatest:merchant",
  maxTimeoutSeconds: 60,
  extra: {
    binding: "kaspa-escrow-v3",
    templateId: "kaspa-x402-escrow-v4",
    serverPublicKey: H("1"),
    minDepositSompi: "10500",
    claimReserveSompi: "10000",
    refundTimeoutDaa: "102000",
    securityContextHash: H("2"),
    mcpErrorChargeSompi: "500",
  },
};

const intent: BatchPaymentAuthorizationIntent = {
  scope: "kaspa:x402:batch-payment-intent:v1",
  operation: "open",
  origin: "https://merchant.example",
  resource: "https://merchant.example/weather",
  network: "kaspa:testnet-10",
  asset: "KAS",
  payTo: accepted.payTo,
  serverPublicKey: accepted.extra.serverPublicKey,
  clientPublicKey: H("3"),
  requestFingerprint: H("4"),
  acceptedRequirementsHash: batchPaymentRequirementsHash(accepted),
  securityContextHash: accepted.extra.securityContextHash,
  fixedChargeSompi: "500",
  mcpErrorChargeSompi: "500",
  authorizedCumulativeBefore: "0",
  authorizedCumulativeAfter: "500",
  claimedCumulativeAmount: "0",
  initialDepositSompi: "10500",
  currentFundingSompi: "0",
  topUpSompi: "0",
  resultingFundingSompi: "10500",
  resultingExposureSompi: "10500",
  claimReserveSompi: "10000",
  refundTimeoutDaa: "102000",
  authoritativeCurrentDaa: "100000",
  refundDistanceDaa: "2000",
  fundingSource: "hot-wallet",
  channelId: null,
  covenantId: null,
  paymentIdentifier: "invoice-7",
};

const policy: BatchPaymentAuthorizationPolicy = {
  maximumBatchChargeSompi: "500",
  maximumInitialDepositSompi: "10500",
  maximumTopUpSompi: "20000",
  maximumCumulativeAuthorizationSompi: "50000",
  maximumTotalExposureSompi: "60000",
  minimumRefundLeadDaa: "1000",
  maximumRefundHorizonDaa: "10000",
  allowedOrigins: [intent.origin],
  allowedResources: [intent.resource],
  allowedPayTo: [intent.payTo],
  allowedServerPublicKeys: [intent.serverPublicKey],
  allowedFundingSources: [intent.fundingSource],
};

describe("batch v3 accepted requirements hash", () => {
  it.each([
    ["mainnet", { ...accepted, network: "kaspa:mainnet" }, "Testnet-10"],
    [
      "the consensus timestamp range",
      {
        ...accepted,
        extra: { ...accepted.extra, refundTimeoutDaa: "500000000000" },
      },
      "timestamp boundary",
    ],
    [
      "a negative max timeout",
      { ...accepted, maxTimeoutSeconds: -1 },
      "non-negative safe integer",
    ],
    [
      "a fractional max timeout",
      { ...accepted, maxTimeoutSeconds: 1.5 },
      "non-negative safe integer",
    ],
    [
      "an unsafe max timeout",
      { ...accepted, maxTimeoutSeconds: Number.MAX_SAFE_INTEGER + 1 },
      "non-negative safe integer",
    ],
  ])("rejects invalid requirements: %s", (_label, requirement, message) => {
    expect(() =>
      batchPaymentRequirementsHash(requirement as BatchPaymentRequirements),
    ).toThrow(message);
  });

  it("validates and hashes one immutable requirements snapshot", () => {
    const stateful = {
      ...accepted,
      extra: { ...accepted.extra },
    };
    let networkReads = 0;
    Object.defineProperty(stateful, "network", {
      enumerable: true,
      get: () =>
        ++networkReads === 1 ? "kaspa:testnet-10" : "kaspa:mainnet",
    });
    let timeoutReads = 0;
    Object.defineProperty(stateful.extra, "refundTimeoutDaa", {
      enumerable: true,
      get: () => (++timeoutReads === 1 ? "102000" : "500000000000"),
    });

    const preimage = new TextDecoder().decode(
      batchPaymentRequirementsPreimage(
        stateful as unknown as BatchPaymentRequirements,
      ),
    );
    expect(networkReads).toBe(1);
    expect(timeoutReads).toBe(1);
    expect(preimage).toContain('"network":"kaspa:testnet-10"');
    expect(preimage).toContain('"refundTimeoutDaa":"102000"');
  });
});

describe("batch v3 payer authorization", () => {
  it("accepts a completely bound open intent and emits a deterministic digest", () => {
    expect(validateBatchPaymentAuthorization(intent, policy)).toBe(true);
    expect(batchPaymentAuthorizationIntentDigest(intent)).toMatch(/^[0-9a-f]{64}$/);
    expect(
      batchPaymentAuthorizationIntentDigest({ ...intent, resource: `${intent.resource}?other=1` }),
    ).not.toBe(batchPaymentAuthorizationIntentDigest(intent));
  });

  it.each([
    ["charge", { fixedChargeSompi: "501", mcpErrorChargeSompi: "501", authorizedCumulativeAfter: "501", initialDepositSompi: "10501", resultingFundingSompi: "10501", resultingExposureSompi: "10501" }, "fixed charge exceeds payer cap"],
    ["deposit", { initialDepositSompi: "10501", resultingFundingSompi: "10501", resultingExposureSompi: "10501" }, "initial deposit exceeds payer cap"],
    ["DAA lead", { refundTimeoutDaa: "100999", refundDistanceDaa: "999" }, "below the payer minimum lead"],
    ["DAA horizon", { refundTimeoutDaa: "110000", refundDistanceDaa: "10000" }, "reaches or exceeds"],
    ["MCP error charge", { mcpErrorChargeSompi: "0" }, "MCP error charge must equal"],
  ])("rejects a payer-policy violation: %s", (_label, mutation, message) => {
    expect(() => validateBatchPaymentAuthorization({ ...intent, ...mutation }, policy)).toThrow(message);
  });

  it("rejects a non-authoritative timeout distance", () => {
    expect(() =>
      validateBatchPaymentAuthorization(
        { ...intent, authoritativeCurrentDaa: "100001" },
        policy,
      ),
    ).toThrow("refund distance must equal");
  });

  it.each([
    ["fixedChargeSompi", { fixedChargeSompi: "not-an-amount" }],
    [
      "authorizedCumulativeBefore",
      { authorizedCumulativeBefore: "not-an-amount" },
    ],
    [
      "authorizedCumulativeAfter",
      { authorizedCumulativeAfter: "not-an-amount" },
    ],
    ["claimedCumulativeAmount", { claimedCumulativeAmount: "not-an-amount" }],
    ["initialDepositSompi", { initialDepositSompi: "not-an-amount" }],
    ["currentFundingSompi", { currentFundingSompi: "not-an-amount" }],
    ["topUpSompi", { topUpSompi: "not-an-amount" }],
    ["resultingFundingSompi", { resultingFundingSompi: "not-an-amount" }],
    ["resultingExposureSompi", { resultingExposureSompi: "not-an-amount" }],
    ["claimReserveSompi", { claimReserveSompi: "not-an-amount" }],
    ["refundTimeoutDaa", { refundTimeoutDaa: "not-an-amount" }],
    [
      "authoritativeCurrentDaa",
      { authoritativeCurrentDaa: "not-an-amount" },
    ],
    ["refundDistanceDaa", { refundDistanceDaa: "not-an-amount" }],
    ["mcpErrorChargeSompi", { mcpErrorChargeSompi: "not-an-amount" }],
  ])("rejects malformed %s before hashing", (_label, mutation) => {
    expect(() =>
      batchPaymentAuthorizationIntentDigest({ ...intent, ...mutation }),
    ).toThrow();
  });

  it.each([
    [
      "the signed-int64 range",
      { fixedChargeSompi: "9223372036854775808" },
      "signed-int64 range",
    ],
    [
      "the consensus timestamp range",
      { refundTimeoutDaa: "500000000000" },
      "timestamp boundary",
    ],
  ])("rejects intent economics in %s before hashing", (_label, mutation, message) => {
    expect(() =>
      batchPaymentAuthorizationIntentDigest({ ...intent, ...mutation }),
    ).toThrow(message);
  });

  it("validates and hashes one immutable intent snapshot", () => {
    const stateful = {
      ...intent,
      operation: "charge" as const,
      authorizedCumulativeBefore: "500",
      authorizedCumulativeAfter: "1000",
      initialDepositSompi: "0",
      currentFundingSompi: "11000",
      resultingFundingSompi: "11000",
      resultingExposureSompi: "11000",
      channelId: H("5"),
      covenantId: H("6"),
    };
    let chargeReads = 0;
    Object.defineProperty(stateful, "fixedChargeSompi", {
      enumerable: true,
      get: () =>
        ++chargeReads === 1 ? "500" : "9223372036854775808",
    });
    let keyReads = 0;
    Object.defineProperty(stateful, "clientPublicKey", {
      enumerable: true,
      get: () => (++keyReads <= 3 ? H("3") : null),
    });

    const preimage = batchPaymentAuthorizationIntentPreimage(stateful);
    expect(chargeReads).toBe(1);
    expect(keyReads).toBe(1);
    expect(preimage).toContain('"fixedChargeSompi":"500"');
    expect(preimage).toContain(`"clientPublicKey":"${H("3")}"`);
  });

  it.each([
    [
      "charge",
      {
        ...intent,
        operation: "charge" as const,
        authorizedCumulativeBefore: "500",
        authorizedCumulativeAfter: "1000",
        initialDepositSompi: "0",
        currentFundingSompi: "11000",
        resultingFundingSompi: "11000",
        resultingExposureSompi: "11000",
        channelId: H("5"),
        covenantId: H("6"),
      },
    ],
    [
      "top-up",
      {
        ...intent,
        operation: "top-up" as const,
        authorizedCumulativeBefore: "500",
        authorizedCumulativeAfter: "1000",
        initialDepositSompi: "0",
        currentFundingSompi: "10500",
        topUpSompi: "1000",
        resultingFundingSompi: "11500",
        resultingExposureSompi: "11500",
        channelId: H("5"),
        covenantId: H("6"),
      },
    ],
  ])("requires the payer key for an existing-lane %s", (_label, existing) => {
    expect(validateBatchPaymentAuthorization(existing, policy)).toBe(true);
    expect(batchPaymentAuthorizationIntentDigest(existing)).toMatch(/^[0-9a-f]{64}$/);
    expect(() =>
      validateBatchPaymentAuthorization(
        { ...existing, clientPublicKey: null },
        policy,
      ),
    ).toThrow("client public key");
    expect(() =>
      batchPaymentAuthorizationIntentDigest({
        ...existing,
        clientPublicKey: null,
      }),
    ).toThrow("client public key");
  });
});

describe("batch v3 request presentation", () => {
  const presentation = {
    requestFingerprint: intent.requestFingerprint,
    acceptedRequirementsHash: intent.acceptedRequirementsHash,
    securityContextHash: intent.securityContextHash,
    channelId: H("5"),
    covenantId: H("6"),
    voucherDigest: H("7"),
    paymentIdentifier: intent.paymentIdentifier,
    nonce: H("8"),
    expiresAt: "2026-09-09T02:00:30.000Z",
  };

  it("binds the request, terms, security context, lane, voucher, id, nonce, and expiry", () => {
    const digest = batchPresentationDigest(presentation);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    for (const mutation of [
      { requestFingerprint: H("9") },
      { acceptedRequirementsHash: H("a") },
      { securityContextHash: H("b") },
      { channelId: H("c") },
      { covenantId: H("d") },
      { voucherDigest: H("e") },
      { paymentIdentifier: "invoice-8" },
      { nonce: H("f") },
      { expiresAt: "2026-09-09T02:00:31.000Z" },
    ]) {
      expect(batchPresentationDigest({ ...presentation, ...mutation })).not.toBe(digest);
    }
  });

  it("enforces a short-lived inclusive-now/exclusive-horizon window", () => {
    const nowMs = Date.parse("2026-09-09T02:00:00.000Z");
    expect(batchPresentationExpiryError({ maxTimeoutSeconds: 60, expiresAt: presentation.expiresAt, nowMs })).toBeUndefined();
    expect(batchPresentationExpiryError({ maxTimeoutSeconds: 60, expiresAt: "2026-09-09T02:00:00.000Z", nowMs })).toBe("expired_presentation");
    expect(batchPresentationExpiryError({ maxTimeoutSeconds: 60, expiresAt: "2026-09-09T02:01:00.001Z", nowMs })).toBe("presentation_exceeds_max_timeout");
  });

  it("fails closed on legacy voucher fields and missing presentations", () => {
    const currentPayload = {
      x402Version: 2,
      accepted,
      payload: {
        type: "voucher",
        channelId: H("5"),
        clientPublicKey: H("3"),
        fundingOutpoint: { txid: H("6"), index: 0 },
        activeScriptPublicKey: "000000",
        voucher: {
          covenantId: H("7"),
          authorizedCumulativeAmount: "500",
          signature: `${H("1")}${H("1")}`,
        },
        presentation: {
          version: "kaspa-x402-batch-presentation-v1",
          ...presentation,
          digest: H("9"),
          signature: `${H("2")}${H("2")}`,
        },
      },
    };
    expect(validatePaymentPayload(currentPayload).ok).toBe(true);

    const legacyVoucher = structuredClone(currentPayload) as Record<string, any>;
    legacyVoucher.payload.voucher.amount =
      legacyVoucher.payload.voucher.authorizedCumulativeAmount;
    delete legacyVoucher.payload.voucher.authorizedCumulativeAmount;
    expect(validatePaymentPayload(legacyVoucher).ok).toBe(false);

    const missingPresentation = structuredClone(currentPayload) as Record<
      string,
      any
    >;
    delete missingPresentation.payload.presentation;
    expect(validatePaymentPayload(missingPresentation).ok).toBe(false);
  });
});
