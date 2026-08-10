import { parseSompiString } from "./amount.js";
import { BATCH_SCRIPT_INT_MAX } from "./constants.js";
import { KaspaX402Error } from "./errors.js";
import type { SompiString } from "./types.js";

/** The accounting fields shared by client, server, facilitator, and gateway. */
export interface BatchLaneState {
  /** Current value of the active covenant UTXO. */
  fundingAmount: SompiString;
  /** Lifetime actual resource charges. */
  chargedCumulativeAmount: SompiString;
  /** On-chain lifetime gross amount removed from the covenant (S). */
  claimedCumulativeAmount: SompiString;
  /** Latest buyer-signed lifetime cumulative ceiling (T). */
  signedMaxClaimable: SompiString;
}

export interface BatchLaneAccounting {
  fundingAmount: bigint;
  chargedCumulativeAmount: bigint;
  claimedCumulativeAmount: bigint;
  signedMaxClaimable: bigint;
  /** Actual charges not yet removed from the covenant. */
  activeChargedAmount: bigint;
  /** Remaining value authorized by the latest voucher. */
  remainingAuthorizedAmount: bigint;
}

/** Parses a covenant arithmetic value and enforces SilverScript's signed-int64 ceiling. */
export function parseBatchLaneAmount(
  value: unknown,
  label = "batch lane amount",
): bigint {
  const parsed = parseSompiString(value);
  if (parsed > BATCH_SCRIPT_INT_MAX) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_amount",
      `${label} exceeds the batch covenant signed-int64 range`,
    );
  }
  return parsed;
}

/** Validates one lane snapshot and returns all derived amounts. */
export function batchLaneAccounting(
  state: BatchLaneState,
): BatchLaneAccounting {
  const fundingAmount = parseBatchLaneAmount(
    state.fundingAmount,
    "funding amount",
  );
  const chargedCumulativeAmount = parseBatchLaneAmount(
    state.chargedCumulativeAmount,
    "charged cumulative amount",
  );
  const claimedCumulativeAmount = parseBatchLaneAmount(
    state.claimedCumulativeAmount,
    "claimed cumulative amount",
  );
  const signedMaxClaimable = parseBatchLaneAmount(
    state.signedMaxClaimable,
    "signed cumulative ceiling",
  );

  if (claimedCumulativeAmount > chargedCumulativeAmount) {
    throw amountError("claimed cumulative amount cannot exceed charged cumulative amount");
  }
  if (chargedCumulativeAmount > signedMaxClaimable) {
    throw amountError("charged cumulative amount cannot exceed the signed cumulative ceiling");
  }

  const activeChargedAmount =
    chargedCumulativeAmount - claimedCumulativeAmount;
  const remainingAuthorizedAmount =
    signedMaxClaimable - claimedCumulativeAmount;
  if (activeChargedAmount > fundingAmount) {
    throw amountError("unsettled charges cannot exceed the active covenant value");
  }
  if (remainingAuthorizedAmount > fundingAmount) {
    throw amountError("remaining voucher authorization cannot exceed the active covenant value");
  }

  return {
    fundingAmount,
    chargedCumulativeAmount,
    claimedCumulativeAmount,
    signedMaxClaimable,
    activeChargedAmount,
    remainingAuthorizedAmount,
  };
}

/** Computes the monotonic cumulative voucher ceiling required for one request. */
export function requiredBatchVoucherAmount(
  state: BatchLaneState,
  maximumNewCharge: SompiString,
): SompiString {
  const accounting = batchLaneAccounting(state);
  const maximumCharge = parseBatchLaneAmount(
    maximumNewCharge,
    "maximum new charge",
  );
  const requiredForCharge =
    accounting.chargedCumulativeAmount + maximumCharge;
  if (requiredForCharge > BATCH_SCRIPT_INT_MAX) {
    throw amountError("required voucher ceiling exceeds the batch covenant signed-int64 range");
  }
  const required =
    requiredForCharge > accounting.signedMaxClaimable
      ? requiredForCharge
      : accounting.signedMaxClaimable;
  if (required - accounting.claimedCumulativeAmount > accounting.fundingAmount) {
    throw amountError("required voucher authorization exceeds the active covenant value");
  }
  return required.toString();
}

/** Enforces the covenant balance left after the latest authorization and reserve. */
export function assertBatchVoucherReserve(
  state: BatchLaneState,
  reserveAmount: SompiString,
): true {
  const accounting = batchLaneAccounting(state);
  const reserve = parseBatchLaneAmount(reserveAmount, "batch reserve");
  if (
    accounting.remainingAuthorizedAmount + reserve >
    accounting.fundingAmount
  ) {
    throw amountError(
      "remaining voucher authorization plus reserve cannot exceed the active covenant value",
    );
  }
  return true;
}

/** Applies the application-level claim policy while preserving the lifetime voucher ceiling. */
export function applyBatchClaimAccounting(
  state: BatchLaneState,
  claimAmount: SompiString,
): BatchLaneState {
  const accounting = batchLaneAccounting(state);
  const claim = parseBatchLaneAmount(claimAmount, "claim amount");
  if (claim === 0n) throw amountError("claim amount must be positive");
  if (claim > accounting.activeChargedAmount) {
    throw amountError("claim amount cannot exceed unsettled actual charges");
  }
  if (claim > accounting.remainingAuthorizedAmount) {
    throw amountError("claim amount cannot exceed remaining voucher authorization");
  }
  if (claim >= accounting.fundingAmount) {
    throw amountError("claim must leave a positive covenant successor");
  }

  return {
    fundingAmount: (accounting.fundingAmount - claim).toString(),
    chargedCumulativeAmount: accounting.chargedCumulativeAmount.toString(),
    claimedCumulativeAmount: (
      accounting.claimedCumulativeAmount + claim
    ).toString(),
    signedMaxClaimable: accounting.signedMaxClaimable.toString(),
  };
}

function amountError(message: string): KaspaX402Error {
  return new KaspaX402Error("invalid_kaspa_x402_amount", message);
}
