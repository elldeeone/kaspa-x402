import { describe, expect, it, vi } from "vitest";

import {
  X402_VERSION,
  batchPaymentRequirementsHash,
  batchRequestAuthorizationDigest,
  channelId,
  exactAuthorizationExpiresAt,
  exactRequestAuthorizationDigest,
  exactRequestAuthorizationId,
  readKaspaSettlementExtension,
  sha256Hex,
  stableStringify,
  voucherDigest,
  type BatchPaymentRequirements,
  type ChannelConfig,
  type DepositVoucherPayload,
  type ExactPaymentRequirements,
  type ExactRequestAuthorization,
  type FundingOutpoint,
  type Hash32Hex,
  type NetworkId,
  type PaymentPayload,
} from "@kaspa-x402/core";
import {
  deriveEscrowAddress,
  escrowScriptPublicKey,
  serializedScriptPublicKey,
} from "@kaspa-x402/covenant";
import {
  DirectModeServer,
  MemoryServerChannelStore,
  type AddressCodec,
  type ChainUtxo,
  type CovenantGenesisVerificationRequest,
  type DirectModeServerConfig,
  type ServerChainProvider,
  type ServerChannelRecord,
  type SettlementFinality,
} from "@kaspa-x402/server";
import {
  DirectModeFacilitator,
  handleFacilitatorRequest,
} from "../src/index.js";

const SERVER_KEY = "11".repeat(32);
const CLIENT_KEY = "22".repeat(32);
const SALT = "33".repeat(32);
const FUNDING_TX = "44".repeat(32);
const COVENANT_ID = "45".repeat(32);
const EXACT_TX_ID = "77".repeat(32);
const EXACT_TRANSACTION_ARTIFACT = '{"transaction":"signed-kip10-exact"}';
const RESOURCE = { url: "https://api.example.test/data" };
const REQUEST_HASH = "99".repeat(32);
const OTHER_REQUEST_HASH = "98".repeat(32);

describe("direct-mode facilitator", () => {
  it("returns supported x402 kinds without hardcoded signer identity", async () => {
    const { facilitator } = makeFacilitator();

    const response = await handleFacilitatorRequest(facilitator, {
      method: "GET",
      path: "/supported",
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      kinds: [
        {
          x402Version: X402_VERSION,
          scheme: "exact",
          network: "kaspa:testnet-10",
        },
        {
          x402Version: X402_VERSION,
          scheme: "batch-settlement",
          network: "kaspa:testnet-10",
        },
      ],
      extensions: [],
      signers: {},
    });
  });

  it("advertises only action modes configured on the facilitator", () => {
    const { server } = makeFacilitator({
      claimBuilder: {
        async buildClaimTransaction({ claimAmount }) {
          return {
            transaction: "ab".repeat(32),
            transactionId: EXACT_TX_ID,
            claimAmount,
          };
        },
      },
    });
    const facilitator = new DirectModeFacilitator({ server });

    const batch = facilitator
      .supported()
      .kinds.find((kind) => kind.scheme === "batch-settlement");

    expect(batch?.extra?.modes).toEqual(["verify", "settle"]);
  });

  it("does not advertise exact when the required server adapter is absent", () => {
    const { facilitator } = makeFacilitator({
      exactTransactionVerifier: undefined,
    });

    expect(facilitator.supported().kinds.map((kind) => kind.scheme)).toEqual([
      "batch-settlement",
    ]);
  });

  it("rejects mainnet facilitator configs unless explicitly enabled", () => {
    expect(() =>
      makeFacilitator({ network: "kaspa:mainnet", allowMainnet: true }),
    ).toThrow("allowMainnet");

    const { facilitator } = makeFacilitator(
      { network: "kaspa:mainnet", allowMainnet: true },
      { allowMainnet: true },
    );
    expect(
      facilitator
        .supported()
        .kinds.every((kind) => kind.network === "kaspa:mainnet"),
    ).toBe(true);
  });

  it("verifies exact payments with the same payer and metadata as direct verification", async () => {
    const { server, facilitator } = makeFacilitator();
    const paymentPayload = makeExactPayment(server);
    const paymentRequirements = paymentPayload.accepted;

    const direct = await server.verifyPayment({
      paymentPayload,
      paymentRequirements,
      resource: RESOURCE,
      requestHash: REQUEST_HASH,
    });
    const verify = await facilitator.verify({
      x402Version: X402_VERSION,
      paymentPayload,
      paymentRequirements,
      resource: RESOURCE,
      requestHash: REQUEST_HASH,
    });

    expect(verify).toEqual({
      isValid: true,
      payer: direct.payer,
      extra: direct.extra,
    });
  });

  it("does not verify accepted evidence below an authenticated confirmed requirement", async () => {
    const requiredFinalities: Array<"accepted" | "confirmed"> = [];
    const { facilitator, server } = makeFacilitator({
      acceptedFinality: "accepted",
      exactTransactionVerifier: {
        verifyExactPayment(request) {
          requiredFinalities.push(request.requiredFinality);
          return {
            transactionId: EXACT_TX_ID,
            paymentOutput: {
              amount: request.amount,
              scriptPublicKey: request.payToScriptPublicKey,
            },
            finality: "accepted",
            payerAddress: "kaspatest:refund",
            requestAuthorization: fakeAuthorizationEvidence(
              request.authorization,
            ),
          };
        },
      },
    });
    const paymentPayload = makeExactPayment(server);
    const confirmed = structuredClone(
      paymentPayload.accepted,
    ) as ExactPaymentRequirements;
    confirmed.extra.finality = "confirmed";
    paymentPayload.accepted = confirmed;
    if (paymentPayload.payload.type !== "exact-transaction")
      throw new Error("expected exact transaction payload");
    paymentPayload.payload.authorization = fakeExactAuthorization(
      confirmed,
      REQUEST_HASH,
    );

    const response = await handleFacilitatorRequest(facilitator, {
      method: "POST",
      path: "/verify",
      body: {
        x402Version: X402_VERSION,
        paymentPayload,
        paymentRequirements: confirmed,
        resource: RESOURCE,
        requestHash: REQUEST_HASH,
      },
    });

    expect(requiredFinalities).toEqual(["confirmed"]);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      isValid: false,
      invalidReason: "invalid_transaction_state",
    });
  });

  it("honors authenticated confirmed requirements above the configured accepted floor", async () => {
    const requiredFinalities: Array<"accepted" | "confirmed"> = [];
    const { facilitator, server } = makeFacilitator({
      acceptedFinality: "accepted",
      exactTransactionVerifier: {
        verifyExactPayment(request) {
          requiredFinalities.push(request.requiredFinality);
          return {
            transactionId: EXACT_TX_ID,
            paymentOutput: {
              amount: request.amount,
              scriptPublicKey: request.payToScriptPublicKey,
            },
            finality: "confirmed",
            payerAddress: "kaspatest:refund",
            requestAuthorization: fakeAuthorizationEvidence(
              request.authorization,
            ),
          };
        },
      },
    });
    const paymentPayload = makeExactPayment(server);
    const confirmed = structuredClone(
      paymentPayload.accepted,
    ) as ExactPaymentRequirements;
    confirmed.extra.finality = "confirmed";
    paymentPayload.accepted = confirmed;
    if (paymentPayload.payload.type !== "exact-transaction")
      throw new Error("expected exact transaction payload");
    paymentPayload.payload.authorization = fakeExactAuthorization(
      confirmed,
      REQUEST_HASH,
    );

    const response = await handleFacilitatorRequest(facilitator, {
      method: "POST",
      path: "/verify",
      body: {
        x402Version: X402_VERSION,
        paymentPayload,
        paymentRequirements: confirmed,
        resource: RESOURCE,
        requestHash: REQUEST_HASH,
      },
    });

    expect(requiredFinalities).toEqual(["confirmed"]);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      isValid: true,
      extra: { finality: "confirmed" },
    });
  });

  it("verifies and settles standard-native exact without head state", async () => {
    const { facilitator, server, store } = makeFacilitator({
      exactProfile: "standard-native",
    });
    const paymentPayload = makeStandardExactPayment(server);

    const verify = await facilitator.verify({
      x402Version: X402_VERSION,
      paymentPayload,
      paymentRequirements: paymentPayload.accepted,
      resource: RESOURCE,
      requestHash: REQUEST_HASH,
    });
    const settlement = await facilitator.settle({
      x402Version: X402_VERSION,
      paymentPayload,
      paymentRequirements: paymentPayload.accepted,
      resource: RESOURCE,
      requestHash: REQUEST_HASH,
    });

    expect(verify).toMatchObject({ isValid: true, payer: "kaspatest:refund" });
    expect(settlement).toMatchObject({
      success: true,
      transaction: EXACT_TX_ID,
      amount: "100",
    });
    expect(readKaspaSettlementExtension(settlement)?.exactProfile).toBe(
      "standard-native",
    );
    await expect(store.listExactHeads()).resolves.toEqual([]);
  });

  it("does not alias an omitted exact request hash to a settled resource", async () => {
    const { facilitator, server, store } = makeFacilitator();
    const paymentPayload = makeExactTransactionPayment(server);
    const paymentRequirements = paymentPayload.accepted;
    const original = await facilitator.settle({
      x402Version: X402_VERSION,
      paymentPayload,
      paymentRequirements,
      resource: RESOURCE,
      requestHash: REQUEST_HASH,
    });
    const otherResource = { url: "https://api.example.test/other" };

    const verify = await facilitator.verify({
      x402Version: X402_VERSION,
      paymentPayload,
      paymentRequirements,
      resource: otherResource,
    });
    const settlement = await facilitator.settle({
      x402Version: X402_VERSION,
      paymentPayload,
      paymentRequirements,
      resource: otherResource,
    });

    expect(original).toMatchObject({
      success: true,
      transaction: EXACT_TX_ID,
    });
    expect(verify).toEqual({
      isValid: false,
      invalidReason: "invalid_payload",
    });
    expect(settlement).toMatchObject({
      success: false,
      transaction: "",
      errorReason: "invalid_payload",
    });
    await expect(store.loadExactPayment(EXACT_TX_ID)).resolves.toMatchObject({
      requestFingerprint: REQUEST_HASH,
      settlement: { success: true, transaction: EXACT_TX_ID },
    });
  });

  it("returns invalid verify responses without mutating settlement state", async () => {
    const { facilitator } = makeFacilitator();
    const paymentPayload = makeExactPayment(makeFacilitator().server);
    const paymentRequirements = {
      ...paymentPayload.accepted,
      amount: "101",
    } as ExactPaymentRequirements;

    const verify = await facilitator.verify({
      x402Version: X402_VERSION,
      paymentPayload,
      paymentRequirements,
      resource: RESOURCE,
      requestHash: REQUEST_HASH,
    });

    expect(verify.isValid).toBe(false);
    expect(verify.invalidReason).toBe("invalid_payment_requirements");
  });

  it("settles exact payments through the shared direct-mode commit path", async () => {
    const { facilitator } = makeFacilitator();
    const paymentPayload = makeExactPayment(makeFacilitator().server);
    const paymentRequirements = paymentPayload.accepted;

    const settlement = await facilitator.settle({
      x402Version: X402_VERSION,
      paymentPayload,
      paymentRequirements,
      resource: RESOURCE,
      requestHash: REQUEST_HASH,
    });

    expect(settlement).toMatchObject({
      success: true,
      transaction: EXACT_TX_ID,
      network: "kaspa:testnet-10",
      amount: "100",
      payer: "kaspatest:refund",
    });
  });

  it("settles batch deposit vouchers with actual charge below the signed ceiling", async () => {
    const { facilitator, server, chain } = makeFacilitator();
    const paymentPayload = makeDepositPayment(server, chain);
    const paymentRequirements = {
      ...paymentPayload.accepted,
      amount: "70",
    } as BatchPaymentRequirements;

    const settlement = await facilitator.settle({
      x402Version: X402_VERSION,
      paymentPayload,
      paymentRequirements,
      resource: RESOURCE,
      requestHash: REQUEST_HASH,
    });

    expect(settlement, JSON.stringify(settlement)).toMatchObject({
      success: true,
    });
    const settlementExtra = readKaspaSettlementExtension(settlement);
    expect(settlement.transaction).toBe(settlementExtra?.commitmentId);
    expect(settlement.amount).toBe("70");
    expect(settlementExtra?.chargedAmount).toBe("70");
    expect(settlementExtra?.fundingAmount).toBe("1000");
    expect(settlementExtra?.channelState).toMatchObject({
      chargedCumulativeAmount: "70",
      signedMaxClaimable: "100",
    });
  });

  it("rejects malformed facilitator requests at the HTTP adapter boundary", async () => {
    const { facilitator } = makeFacilitator();

    const response = await handleFacilitatorRequest(facilitator, {
      method: "POST",
      path: "/verify",
      body: { x402Version: X402_VERSION },
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      isValid: false,
      invalidReason: "invalid_payload",
    });
  });

  it("returns settlement failures for shallow but unusable settlement payloads", async () => {
    const { facilitator } = makeFacilitator();

    const response = await handleFacilitatorRequest(facilitator, {
      method: "POST",
      path: "/settle",
      body: {
        x402Version: X402_VERSION,
        paymentPayload: {},
        paymentRequirements: {
          scheme: "exact",
          network: "kaspa:testnet-10",
        },
        requestHash: REQUEST_HASH,
      },
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: false,
      errorReason: "invalid_payload",
      transaction: "",
      network: "kaspa:testnet-10",
    });
  });

  it("rejects settlement modes omitted from a custom supported kind", async () => {
    const { server } = makeFacilitator();
    const paymentPayload = makeExactPayment(server);
    const facilitator = new DirectModeFacilitator({
      server,
      supportedKinds: [
        {
          x402Version: X402_VERSION,
          scheme: "exact",
          network: "kaspa:testnet-10",
          extra: {
            binding: "kaspa-exact-v2",
            profile: "standard-native",
            modes: ["verify"],
          },
        },
      ],
    });

    const settlement = await facilitator.settle({
      x402Version: X402_VERSION,
      paymentPayload,
      paymentRequirements: paymentPayload.accepted,
      resource: RESOURCE,
      requestHash: REQUEST_HASH,
    });

    expect(settlement).toMatchObject({
      success: false,
      errorReason: "unsupported_scheme",
      transaction: "",
    });
  });

  it("rejects execution when a custom supported kind omits modes", async () => {
    const { server } = makeFacilitator();
    const paymentPayload = makeExactPayment(server);
    const facilitator = new DirectModeFacilitator({
      server,
      supportedKinds: [
        {
          x402Version: X402_VERSION,
          scheme: "exact",
          network: "kaspa:testnet-10",
          extra: {
            binding: "kaspa-exact-v2",
            profile: "standard-native",
          },
        },
      ],
    });

    const verification = await facilitator.verify({
      x402Version: X402_VERSION,
      paymentPayload,
      paymentRequirements: paymentPayload.accepted,
      resource: RESOURCE,
      requestHash: REQUEST_HASH,
    });
    const settlement = await facilitator.settle({
      x402Version: X402_VERSION,
      paymentPayload,
      paymentRequirements: paymentPayload.accepted,
      resource: RESOURCE,
      requestHash: REQUEST_HASH,
    });

    expect(facilitator.supported().kinds).toEqual([]);
    expect(verification).toEqual({
      isValid: false,
      invalidReason: "unsupported_scheme",
    });
    expect(settlement).toMatchObject({
      success: false,
      errorReason: "unsupported_scheme",
      transaction: "",
    });
  });

  it("does not advertise custom supported kinds with invalid modes", () => {
    const { server } = makeFacilitator();
    const facilitator = new DirectModeFacilitator({
      server,
      supportedKinds: [
        {
          x402Version: X402_VERSION,
          scheme: "exact",
          network: "kaspa:testnet-10",
          extra: {
            binding: "kaspa-exact-v2",
            profile: "standard-native",
            modes: ["verify", "withdraw"],
          },
        },
      ],
    });

    expect(facilitator.supported().kinds).toEqual([]);
  });

  it("does not let custom supported kinds expand direct server capabilities", () => {
    const { server } = makeFacilitator({
      exactTransactionVerifier: undefined,
    });
    const facilitator = new DirectModeFacilitator({
      server,
      supportedKinds: [
        {
          x402Version: X402_VERSION,
          scheme: "exact",
          network: "kaspa:testnet-10",
          extra: {
            binding: "kaspa-exact-v2",
            profile: "standard-native",
            modes: ["verify", "settle"],
          },
        },
        {
          x402Version: X402_VERSION,
          scheme: "batch-settlement",
          network: "kaspa:testnet-10",
          extra: {
            binding: "kaspa-escrow-v2",
            modes: ["verify", "settle"],
          },
        },
      ],
    });

    expect(facilitator.supported().kinds.map((kind) => kind.scheme)).toEqual([
      "batch-settlement",
    ]);
  });

  it("does not advertise action modes on non-batch custom supported kinds", () => {
    const { server } = makeFacilitator();
    const facilitator = new DirectModeFacilitator({
      server,
      supportedKinds: [
        {
          x402Version: X402_VERSION,
          scheme: "exact",
          network: "kaspa:testnet-10",
          extra: {
            binding: "kaspa-exact-v2",
            profile: "standard-native",
            modes: ["verify", "claim", "refund"],
          },
        },
      ],
      claimSettler: vi.fn(),
      refundSettler: vi.fn(),
    });

    expect(facilitator.supported().kinds[0]?.extra?.modes).toEqual(["verify"]);
  });

  it("uses wrapped server metadata for custom supported kinds", () => {
    const { facilitator } = makeFacilitator();
    const canonical = facilitator
      .supported()
      .kinds.find((kind) => kind.scheme === "exact");
    const custom = new DirectModeFacilitator({
      server: makeFacilitator().server,
      supportedKinds: [
        {
          x402Version: X402_VERSION,
          scheme: "exact",
          network: "kaspa:testnet-10",
          extra: {
            asset: "BAD",
            binding: "wrong-binding",
            modes: ["verify"],
          },
        },
      ],
    });

    const exact = custom.supported().kinds[0];

    expect(exact).toEqual({
      ...canonical,
      extra: {
        ...canonical?.extra,
        modes: ["verify"],
      },
    });
  });

  it("validates action payloads before invoking claim or refund settlers", async () => {
    const { server, chain } = makeFacilitator();
    const deposit = makeDepositPayment(server, chain);
    const claimSettler = vi.fn();
    const refundSettler = vi.fn();
    const facilitator = new DirectModeFacilitator({
      server,
      supportedKinds: [
        {
          x402Version: X402_VERSION,
          scheme: "batch-settlement",
          network: "kaspa:testnet-10",
          extra: {
            binding: "kaspa-escrow-v2",
            modes: ["claim", "refund"],
          },
        },
      ],
      claimSettler,
      refundSettler,
    });

    for (const type of ["claim", "refund"] as const) {
      const settlement = await facilitator.settle({
        x402Version: X402_VERSION,
        paymentPayload: {
          x402Version: X402_VERSION,
          accepted: deposit.accepted,
          payload: { type },
        } as PaymentPayload,
        paymentRequirements: deposit.accepted,
        resource: RESOURCE,
      });

      expect(settlement).toMatchObject({
        success: false,
        errorReason: "invalid_payload",
        transaction: "",
      });
    }
    expect(claimSettler).not.toHaveBeenCalled();
    expect(refundSettler).not.toHaveBeenCalled();
  });

  it("validates optional action resources before invoking action settlers", async () => {
    const { server, chain } = makeFacilitator();
    const deposit = makeDepositPayment(server, chain);
    const depositPayload = deposit.payload as DepositVoucherPayload;
    const claimSettler = vi.fn();
    const facilitator = new DirectModeFacilitator({
      server,
      supportedKinds: [
        {
          x402Version: X402_VERSION,
          scheme: "batch-settlement",
          network: "kaspa:testnet-10",
          extra: {
            binding: "kaspa-escrow-v2",
            modes: ["claim"],
          },
        },
      ],
      claimSettler,
    });

    const settlement = await facilitator.settle({
      x402Version: X402_VERSION,
      paymentPayload: {
        x402Version: X402_VERSION,
        accepted: deposit.accepted,
        payload: {
          type: "claim",
          channelId: depositPayload.channelId,
          fundingOutpoint: depositPayload.fundingOutpoint,
          activeScriptPublicKey: depositPayload.activeScriptPublicKey,
          claimAmount: depositPayload.voucher.amount,
          voucher: depositPayload.voucher,
        },
      } as PaymentPayload,
      paymentRequirements: deposit.accepted,
      resource: {} as never,
    });

    expect(settlement).toMatchObject({
      success: false,
      errorReason: "invalid_payload",
      transaction: "",
    });
    expect(claimSettler).not.toHaveBeenCalled();
  });

  it("validates action accepted requirements before invoking action settlers", async () => {
    const { server, chain } = makeFacilitator();
    const deposit = makeDepositPayment(server, chain);
    const claimSettler = vi.fn();
    const facilitator = new DirectModeFacilitator({
      server,
      supportedKinds: [
        {
          x402Version: X402_VERSION,
          scheme: "batch-settlement",
          network: "kaspa:testnet-10",
          extra: {
            binding: "kaspa-escrow-v2",
            modes: ["claim"],
          },
        },
      ],
      claimSettler,
    });
    const depositPayload = deposit.payload as DepositVoucherPayload;
    const claimPayload = {
      x402Version: X402_VERSION,
      accepted: deposit.accepted,
      payload: {
        type: "claim",
        channelId: depositPayload.channelId,
        fundingOutpoint: depositPayload.fundingOutpoint,
        activeScriptPublicKey: depositPayload.activeScriptPublicKey,
        claimAmount: depositPayload.voucher.amount,
        voucher: depositPayload.voucher,
      },
    } as PaymentPayload;

    const settlement = await facilitator.settle({
      x402Version: X402_VERSION,
      paymentPayload: claimPayload,
      paymentRequirements: { ...deposit.accepted, amount: "101" },
      resource: RESOURCE,
      requestHash: REQUEST_HASH,
    });

    expect(settlement).toMatchObject({
      success: false,
      errorReason: "invalid_payment_requirements",
      transaction: "",
    });
    expect(claimSettler).not.toHaveBeenCalled();
  });

  it("validates refund accepted requirements before invoking refund settlers", async () => {
    const { server, chain } = makeFacilitator();
    const deposit = makeDepositPayment(server, chain);
    const depositPayload = deposit.payload as DepositVoucherPayload;
    const refundSettler = vi.fn();
    const facilitator = new DirectModeFacilitator({
      server,
      supportedKinds: [
        {
          x402Version: X402_VERSION,
          scheme: "batch-settlement",
          network: "kaspa:testnet-10",
          extra: {
            binding: "kaspa-escrow-v2",
            modes: ["refund"],
          },
        },
      ],
      refundSettler,
    });

    const settlement = await facilitator.settle({
      x402Version: X402_VERSION,
      paymentPayload: {
        x402Version: X402_VERSION,
        accepted: deposit.accepted,
        payload: {
          type: "refund",
          channelId: depositPayload.channelId,
          covenantId: depositPayload.voucher.covenantId,
          fundingOutpoint: depositPayload.fundingOutpoint,
          activeScriptPublicKey: depositPayload.activeScriptPublicKey,
          refundAddress: depositPayload.channelConfig.refundAddress,
          refundAmount: depositPayload.voucher.amount,
          clientSignature: "12".repeat(65),
        },
      } as PaymentPayload,
      paymentRequirements: { ...deposit.accepted, amount: "101" },
      resource: RESOURCE,
      requestHash: REQUEST_HASH,
    });

    expect(settlement).toMatchObject({
      success: false,
      errorReason: "invalid_payment_requirements",
      transaction: "",
    });
    expect(refundSettler).not.toHaveBeenCalled();
  });

  it("reports exact replay during verify after settlement", async () => {
    const { facilitator, server } = makeFacilitator();
    const paymentPayload = makeExactPayment(server);

    const settlement = await facilitator.settle({
      x402Version: X402_VERSION,
      paymentPayload,
      paymentRequirements: paymentPayload.accepted,
      resource: RESOURCE,
      requestHash: REQUEST_HASH,
    });
    const replayPayload = structuredClone(paymentPayload);
    if (replayPayload.payload.type !== "exact-transaction")
      throw new Error("expected exact transaction payload");
    replayPayload.payload.requestHash = OTHER_REQUEST_HASH;
    replayPayload.payload.authorization = fakeExactAuthorization(
      replayPayload.accepted as ExactPaymentRequirements,
      OTHER_REQUEST_HASH,
    );
    const replay = await facilitator.verify({
      x402Version: X402_VERSION,
      paymentPayload: replayPayload,
      paymentRequirements: replayPayload.accepted,
      resource: RESOURCE,
      requestHash: OTHER_REQUEST_HASH,
    });

    expect(settlement.success).toBe(true);
    expect(replay).toEqual({
      isValid: false,
      invalidReason: "invalid_transaction_state",
    });
  });

  it("checks exact replay after deriving the exact-transaction id", async () => {
    const initial = makeFacilitator();
    const paymentPayload = makeExactPayment(initial.server);
    const settlement = await initial.facilitator.settle({
      x402Version: X402_VERSION,
      paymentPayload,
      paymentRequirements: paymentPayload.accepted,
      resource: RESOURCE,
      requestHash: REQUEST_HASH,
    });
    const replayPayload = structuredClone(paymentPayload);
    if (replayPayload.payload.type !== "exact-transaction")
      throw new Error("expected exact transaction payload");
    replayPayload.payload.requestHash = OTHER_REQUEST_HASH;
    replayPayload.payload.authorization = fakeExactAuthorization(
      replayPayload.accepted as ExactPaymentRequirements,
      OTHER_REQUEST_HASH,
    );
    const verifier = vi.fn((request) => ({
      transactionId: EXACT_TX_ID,
      paymentOutput: {
        amount: request.amount,
        scriptPublicKey: request.payToScriptPublicKey,
      },
      finality: "accepted" as const,
      payerAddress: "kaspatest:refund",
      requestAuthorization: fakeAuthorizationEvidence(request.authorization),
    }));
    const replaySetup = makeFacilitator({
      store: initial.store,
      exactTransactionVerifier: {
        verifyExactPayment: verifier,
      },
    });

    const replay = await replaySetup.facilitator.verify({
      x402Version: X402_VERSION,
      paymentPayload: replayPayload,
      paymentRequirements: replayPayload.accepted,
      resource: RESOURCE,
      requestHash: OTHER_REQUEST_HASH,
    });

    expect(settlement.success).toBe(true);
    expect(replay).toEqual({
      isValid: false,
      invalidReason: "invalid_transaction_state",
    });
    expect(verifier).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed top-level request hashes at the HTTP adapter boundary", async () => {
    const { facilitator, server } = makeFacilitator();
    const paymentPayload = makeExactPayment(server);

    const response = await handleFacilitatorRequest(facilitator, {
      method: "POST",
      path: "/verify",
      body: {
        x402Version: X402_VERSION,
        paymentPayload,
        paymentRequirements: paymentPayload.accepted,
        requestHash: "not-a-hash",
      },
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      isValid: false,
      invalidReason: "invalid_payload",
    });
  });

  it("returns settlement failures for unsupported networks", async () => {
    const { facilitator, server } = makeFacilitator();
    const paymentPayload = makeExactPayment(server);
    const paymentRequirements = {
      ...paymentPayload.accepted,
      network: "kaspa:testnet-12",
    } as unknown as ExactPaymentRequirements;

    const response = await handleFacilitatorRequest(facilitator, {
      method: "POST",
      path: "/settle",
      body: {
        x402Version: X402_VERSION,
        paymentPayload: { ...paymentPayload, accepted: paymentRequirements },
        paymentRequirements,
        requestHash: REQUEST_HASH,
      },
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: false,
      errorReason: "invalid_network",
      transaction: "",
    });
    expect(response.body).not.toHaveProperty("network");
  });

  it("does not coerce malformed facilitator settlement networks to testnet", async () => {
    const { facilitator, server } = makeFacilitator();
    const paymentPayload = makeExactPayment(server);
    const paymentRequirements = {
      ...paymentPayload.accepted,
      network: "testnet-10",
    } as unknown as ExactPaymentRequirements;

    const response = await handleFacilitatorRequest(facilitator, {
      method: "POST",
      path: "/settle",
      body: {
        x402Version: X402_VERSION,
        paymentPayload: { ...paymentPayload, accepted: paymentRequirements },
        paymentRequirements,
        requestHash: REQUEST_HASH,
      },
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: false,
      errorReason: "invalid_network",
      transaction: "",
    });
    expect(response.body).not.toHaveProperty("network");
  });

  it("preserves safe mainnet network labels in facilitator settlement failures", async () => {
    const { facilitator, server } = makeFacilitator();
    const paymentPayload = makeExactPayment(server);
    const paymentRequirements = {
      ...paymentPayload.accepted,
      network: "kaspa:mainnet",
    } as ExactPaymentRequirements;

    const response = await handleFacilitatorRequest(facilitator, {
      method: "POST",
      path: "/settle",
      body: {
        x402Version: X402_VERSION,
        paymentPayload: { ...paymentPayload, accepted: paymentRequirements },
        paymentRequirements,
        requestHash: REQUEST_HASH,
      },
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: false,
      errorReason: "invalid_network",
      transaction: "",
      network: "kaspa:mainnet",
    });
  });
});

function makeFacilitator(
  overrides: Partial<DirectModeServerConfig> = {},
  facilitatorOptions: { allowMainnet?: boolean } = {},
) {
  const {
    exactTransactionVerifier: suppliedExactVerifier,
    ...serverOverrides
  } = overrides;
  const store = overrides.store ?? new MemoryServerChannelStore();
  const chain = new FakeChainProvider();
  const rawExactVerifier = suppliedExactVerifier ?? {
    verifyExactPayment(
      request: Parameters<
        NonNullable<
          DirectModeServerConfig["exactTransactionVerifier"]
        >["verifyExactPayment"]
      >[0],
    ) {
      return {
        transactionId: EXACT_TX_ID,
        paymentOutput: {
          amount: request.amount,
          scriptPublicKey: request.payToScriptPublicKey,
        },
        finality: "accepted" as const,
        payerAddress: "kaspatest:refund",
        requestAuthorization: fakeAuthorizationEvidence(request.authorization),
      };
    },
  };
  const exactVerifierExplicitlyDisabled =
    Object.prototype.hasOwnProperty.call(
      overrides,
      "exactTransactionVerifier",
    ) && suppliedExactVerifier === undefined;
  const server = new DirectModeServer({
    network: "kaspa:testnet-10",
    payTo: "kaspatest:payout",
    serverPublicKey: SERVER_KEY,
    minDepositSompi: "1000",
    claimReserveSompi: "10",
    amount: "100",
    refundTimeoutDaa: "1000",
    minimumRefundLeadDaa: "0",
    store,
    chainProvider: chain,
    addressCodec: new FakeAddressCodec(),
    channelSignatureVerifier: {
      verifySignature({ digest, signature }) {
        return signature === `${digest}${digest}`;
      },
    },
    exactProfile: "standard-native",
    ...serverOverrides,
    exactTransactionVerifier: exactVerifierExplicitlyDisabled
      ? undefined
      : {
          async verifyExactPayment(request) {
            const result = await rawExactVerifier.verifyExactPayment(request);
            return {
              ...result,
              requestAuthorization:
                result.requestAuthorization ??
                fakeAuthorizationEvidence(request.authorization),
            };
          },
        },
  });
  (server as unknown as { __testChain?: FakeChainProvider }).__testChain =
    chain;
  return {
    server,
    facilitator: new DirectModeFacilitator({
      server,
      allowMainnet: facilitatorOptions.allowMainnet,
    }),
    chain,
    store,
  };
}

function makeExactTransactionPayment(server: DirectModeServer): PaymentPayload {
  return makeStandardExactPayment(server);
}

function makeExactPayment(server: DirectModeServer): PaymentPayload {
  return makeStandardExactPayment(server);
}

function makeStandardExactPayment(server: DirectModeServer): PaymentPayload {
  const required = server.buildPaymentRequired({
    resource: RESOURCE,
    scheme: "exact",
  });
  const accepted = required.accepts[0] as ExactPaymentRequirements;
  const authorization = fakeExactAuthorization(accepted, REQUEST_HASH);
  return {
    x402Version: X402_VERSION,
    accepted,
    payload: {
      type: "exact-transaction",
      profile: "standard-native",
      payerAddress: "kaspatest:refund",
      transaction: EXACT_TRANSACTION_ARTIFACT,
      transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
      paymentOutputIndex: 0,
      requestHash: REQUEST_HASH,
      authorization,
    },
  };
}

function fakeExactAuthorization(
  accepted: ExactPaymentRequirements,
  requestHash: Hash32Hex,
): ExactRequestAuthorization {
  const expiresAt = exactAuthorizationExpiresAt(
    accepted.maxTimeoutSeconds,
    accepted.extra.profile === "additive"
      ? accepted.extra.challengeExpiresAt
      : undefined,
  );
  return {
    version: "kaspa-x402-exact-request-authorization-v1",
    inputIndex: 0,
    expiresAt,
    digest: exactRequestAuthorizationDigest({
      network: accepted.network,
      profile: "standard-native",
      transactionId: EXACT_TX_ID,
      paymentOutputIndex: 0,
      amount: accepted.amount,
      payTo: accepted.payTo,
      payToScriptPublicKey: accepted.extra.payToScriptPublicKey!,
      paymentRequirementsHash: sha256Hex(stableStringify(accepted)),
      requestHash,
      inputIndex: 0,
      expiresAt,
    }),
    signature: "ab".repeat(64),
  };
}

function fakeAuthorizationEvidence(authorization: ExactRequestAuthorization) {
  return {
    authorizationId: exactRequestAuthorizationId(authorization),
    digest: authorization.digest,
    inputIndex: authorization.inputIndex,
    publicKey: CLIENT_KEY,
  };
}

function makeDepositPayment(
  server: DirectModeServer,
  chain: FakeChainProvider,
): PaymentPayload {
  const required = server.buildPaymentRequired({
    resource: RESOURCE,
    scheme: "batch-settlement",
  });
  const accepted = required.accepts[0] as BatchPaymentRequirements;
  const channelConfig: ChannelConfig = {
    network: accepted.network,
    asset: "KAS",
    templateId: "kaspa-x402-escrow-v3",
    clientPublicKey: CLIENT_KEY,
    serverPublicKey: SERVER_KEY,
    payTo: accepted.payTo,
    refundAddress: "kaspatest:refund",
    refundTimeoutDaa: accepted.extra.refundTimeoutDaa,
    salt: SALT,
  };
  const derived = deriveEscrow(channelConfig);
  const resolvedChannelId = channelId(channelConfig);
  const fundingOutpoint = { txid: FUNDING_TX, index: 0 };
  chain.setUtxo({
    outpoint: fundingOutpoint,
    covenantId: COVENANT_ID,
    amount: accepted.extra.minDepositSompi,
    scriptPublicKey: derived.activeScriptPublicKey,
    finality: "accepted",
  });
  const voucher = signVoucher({
    network: accepted.network,
    covenantId: COVENANT_ID,
    amount: accepted.amount,
  });
  const expiresAt = new Date(Date.now() + 30_000).toISOString();
  const nonce = "97".repeat(32);
  const authorizationDigest = batchRequestAuthorizationDigest({
    network: accepted.network,
    channelId: resolvedChannelId,
    covenantId: COVENANT_ID,
    amount: voucher.amount,
    paymentRequirementsHash: batchPaymentRequirementsHash(accepted),
    requestHash: REQUEST_HASH,
    audience: RESOURCE.url,
    expiresAt,
    nonce,
  });
  return {
    x402Version: X402_VERSION,
    accepted,
    payload: {
      type: "deposit-voucher",
      channelConfig,
      channelId: resolvedChannelId,
      escrowAddress: derived.escrowAddress,
      fundingOutpoint,
      fundingAmountSompi: accepted.extra.minDepositSompi,
      activeScriptPublicKey: derived.activeScriptPublicKey,
      voucher,
      authorization: {
        version: "kaspa-x402-batch-request-authorization-v1",
        expiresAt,
        nonce,
        digest: authorizationDigest,
        signature: `${authorizationDigest}${authorizationDigest}`,
      },
    },
  };
}

function deriveEscrow(channelConfig: ChannelConfig): {
  escrowAddress: string;
  activeScriptPublicKey: string;
} {
  const addressCodec = new FakeAddressCodec();
  const payoutScriptPublicKeyHash = sha256Hex(
    hexBytes(
      addressCodec.scriptPublicKeyForAddress(
        channelConfig.payTo,
        channelConfig.network,
      ),
    ),
  );
  const refundScriptPublicKeyHash = sha256Hex(
    hexBytes(
      addressCodec.scriptPublicKeyForAddress(
        channelConfig.refundAddress,
        channelConfig.network,
      ),
    ),
  );
  const params = {
    clientPublicKey: channelConfig.clientPublicKey,
    serverPublicKey: channelConfig.serverPublicKey,
    network: channelConfig.network,
    payoutScriptPublicKeyHash,
    refundScriptPublicKeyHash,
    timeoutDaa: channelConfig.refundTimeoutDaa,
    settledTotal: "0",
  };
  const script = escrowScriptPublicKey(params);
  return {
    escrowAddress: deriveEscrowAddress(params, (input) =>
      addressCodec.encodeScriptAddress(input),
    ),
    activeScriptPublicKey: serializedScriptPublicKey(script),
  };
}

function signVoucher(input: {
  network: NetworkId;
  covenantId: Hash32Hex;
  amount: string;
}) {
  const digest = voucherDigest(input);
  return {
    covenantId: input.covenantId,
    amount: input.amount,
    signature: `${digest}${digest}`,
  };
}

class FakeAddressCodec implements AddressCodec {
  scriptPublicKeyForAddress(address: string, _network?: NetworkId): string {
    return `0000${sha256Hex(address)}`;
  }

  encodeScriptAddress(input: { serializedScriptPublicKey: string }): string {
    return `kaspatest:${sha256Hex(input.serializedScriptPublicKey).slice(0, 32)}`;
  }
}

class FakeChainProvider implements ServerChainProvider {
  readonly utxos = new Map<string, ChainUtxo>();
  daa = "0";

  setUtxo(utxo: ChainUtxo): void {
    this.utxos.set(outpointKey(utxo.outpoint), structuredClone(utxo));
  }

  async getUtxo(outpoint: FundingOutpoint, _network: NetworkId) {
    return this.utxos.get(outpointKey(outpoint)) ?? null;
  }

  async getVirtualDaaScore() {
    return this.daa;
  }

  async verifyCovenantGenesis(request: CovenantGenesisVerificationRequest) {
    return {
      covenantId: request.utxo.covenantId!,
      authorizingInput: { txid: "46".repeat(32), index: 0 },
      genesisOutpoint: request.utxo.outpoint,
      genesisScriptPublicKey: request.utxo.scriptPublicKey,
      genesisAmount: request.utxo.amount,
      totalOutputCount: 1,
      authorizedOutputCount: 1,
    };
  }

  async estimateClaimFee(_channel: ServerChannelRecord) {
    return "10";
  }

  async sendTransaction(
    _transaction: string,
  ): Promise<{ transactionId: Hash32Hex; finality: SettlementFinality }> {
    return { transactionId: EXACT_TX_ID, finality: "accepted" };
  }
}

function outpointKey(outpoint: FundingOutpoint): string {
  return `${outpoint.txid.toLowerCase()}:${outpoint.index}`;
}

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}
