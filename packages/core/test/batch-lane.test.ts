import { describe, expect, it } from "vitest";

import {
  BATCH_SCRIPT_INT_MAX,
  applyBatchClaimAccounting,
  assertBatchVoucherReserve,
  batchLaneAccounting,
  batchPaymentRequirementsPreimageHex,
  parseBatchLaneAmount,
  requiredBatchVoucherAmount,
  voucherDigest,
  voucherPreimageHex,
  type BatchLaneState,
} from "../src/index.js";

const state: BatchLaneState = {
  fundingAmount: "10000000",
  chargedCumulativeAmount: "4000000",
  claimedCumulativeAmount: "2500000",
  signedMaxClaimable: "5000000",
};

describe("Alpha.10 batch lane accounting", () => {
  it("derives unsettled charges and remaining lifetime authorization", () => {
    expect(batchLaneAccounting(state)).toMatchObject({
      activeChargedAmount: 1_500_000n,
      remainingAuthorizedAmount: 2_500_000n,
    });
    expect(requiredBatchVoucherAmount(state, "2000000")).toBe("6000000");
    expect(assertBatchVoucherReserve(state, "7500000")).toBe(true);
  });

  it("advances on-chain settlement without resetting the voucher ceiling", () => {
    expect(applyBatchClaimAccounting(state, "1500000")).toEqual({
      fundingAmount: "8500000",
      chargedCumulativeAmount: "4000000",
      claimedCumulativeAmount: "4000000",
      signedMaxClaimable: "5000000",
    });
  });

  it("enforces actual-charge, authorization, successor, and reserve bounds", () => {
    expect(() => applyBatchClaimAccounting(state, "1500001")).toThrow(
      "unsettled actual charges",
    );
    expect(() => assertBatchVoucherReserve(state, "7500001")).toThrow(
      "authorization plus reserve",
    );
    expect(() =>
      applyBatchClaimAccounting(
        {
          ...state,
          fundingAmount: "1500000",
          signedMaxClaimable: "4000000",
        },
        "1500000",
      ),
    ).toThrow("positive covenant successor");
  });

  it("accepts signed-int64 max and rejects max plus one", () => {
    expect(parseBatchLaneAmount(BATCH_SCRIPT_INT_MAX.toString())).toBe(
      BATCH_SCRIPT_INT_MAX,
    );
    expect(() =>
      parseBatchLaneAmount((BATCH_SCRIPT_INT_MAX + 1n).toString()),
    ).toThrow("signed-int64 range");
    expect(() =>
      requiredBatchVoucherAmount(
        {
          fundingAmount: BATCH_SCRIPT_INT_MAX.toString(),
          chargedCumulativeAmount: BATCH_SCRIPT_INT_MAX.toString(),
          claimedCumulativeAmount: BATCH_SCRIPT_INT_MAX.toString(),
          signedMaxClaimable: BATCH_SCRIPT_INT_MAX.toString(),
        },
        "1",
      ),
    ).toThrow("signed-int64 range");
  });

  it("enforces signed-int64 money fields and the deposit reserve floor", () => {
    const claimReserve = 2_000_000n;
    const accepted = {
      scheme: "batch-settlement" as const,
      network: "kaspa:testnet-10" as const,
      amount: (BATCH_SCRIPT_INT_MAX - claimReserve).toString(),
      asset: "KAS" as const,
      payTo: "kaspatest:provider",
      maxTimeoutSeconds: 60,
      extra: {
        binding: "kaspa-escrow-v2" as const,
        templateId: "kaspa-x402-escrow-v2" as const,
        serverPublicKey: "22".repeat(32),
        minDepositSompi: BATCH_SCRIPT_INT_MAX.toString(),
        claimReserveSompi: claimReserve.toString(),
        refundTimeoutDaa: "123456789",
      },
    };

    expect(batchPaymentRequirementsPreimageHex(accepted)).toHaveLength(592);
    expect(() =>
      batchPaymentRequirementsPreimageHex({
        ...accepted,
        amount: (BATCH_SCRIPT_INT_MAX + 1n).toString(),
      }),
    ).toThrow("signed-int64 range");
    expect(() =>
      batchPaymentRequirementsPreimageHex({
        ...accepted,
        extra: {
          ...accepted.extra,
          minDepositSompi: (BATCH_SCRIPT_INT_MAX + 1n).toString(),
        },
      }),
    ).toThrow("signed-int64 range");
    expect(() =>
      batchPaymentRequirementsPreimageHex({
        ...accepted,
        extra: {
          ...accepted.extra,
          claimReserveSompi: (BATCH_SCRIPT_INT_MAX + 1n).toString(),
        },
      }),
    ).toThrow("signed-int64 range");
    expect(() =>
      batchPaymentRequirementsPreimageHex({
        ...accepted,
        amount: (BATCH_SCRIPT_INT_MAX - claimReserve + 1n).toString(),
      }),
    ).toThrow("amount plus claim reserve exceeds");
    expect(() =>
      batchPaymentRequirementsPreimageHex({
        ...accepted,
        extra: {
          ...accepted.extra,
          minDepositSompi: (BATCH_SCRIPT_INT_MAX - 1n).toString(),
        },
      }),
    ).toThrow("minimum deposit must cover");
  });
});

describe("Alpha.10 voucher identity", () => {
  const input = {
    network: "kaspa:testnet-10" as const,
    covenantId: "11".repeat(32),
    amount: "5000000",
  };

  it("binds network, stable covenant id, and lifetime ceiling", () => {
    expect(voucherPreimageHex(input)).toHaveLength(208);
    expect(voucherDigest(input)).toHaveLength(64);
    expect(
      voucherDigest({ ...input, covenantId: "22".repeat(32) }),
    ).not.toBe(voucherDigest(input));
    expect(voucherDigest({ ...input, amount: "5000001" })).not.toBe(
      voucherDigest(input),
    );
  });

  it("rejects the all-zero KIP-20 unbound sentinel", () => {
    expect(() =>
      voucherDigest({ ...input, covenantId: "00".repeat(32) }),
    ).toThrow("bound KIP-20 lineage");
  });
});
