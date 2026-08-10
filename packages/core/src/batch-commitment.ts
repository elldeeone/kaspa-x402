import {
  ASSET_ID,
  BATCH_COMMITMENT_DOMAIN_TAG,
  BATCH_PAYMENT_REQUIREMENTS_DOMAIN_TAG,
  BATCH_SCRIPT_INT_MAX,
  ESCROW_BINDING_ID,
  ESCROW_TEMPLATE_ID,
} from "./constants.js";
import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  le32,
  le64,
  sha256,
} from "./binary.js";
import { KaspaX402Error } from "./errors.js";
import { parseBatchLaneAmount } from "./batch-lane.js";
import { parseKaspaNetwork } from "./network.js";
import type {
  BatchPaymentRequirements,
  FundingOutpoint,
  Hash32Hex,
  SompiString,
  Voucher,
} from "./types.js";

export interface BatchCommitmentInput {
  accepted: BatchPaymentRequirements;
  channelId: Hash32Hex;
  requestFingerprint: Hash32Hex;
  activeOutpoint: FundingOutpoint;
  voucher: Voucher;
  chargedAmount: SompiString;
  chargedCumulativeBefore: SompiString;
  chargedCumulativeAfter: SompiString;
  claimedCumulativeAmount: SompiString;
}

export function batchPaymentRequirementsPreimage(
  accepted: BatchPaymentRequirements,
): Uint8Array {
  const network = parseKaspaNetwork(accepted.network);
  if (
    accepted.scheme !== "batch-settlement" ||
    accepted.asset !== ASSET_ID ||
    accepted.extra.binding !== ESCROW_BINDING_ID ||
    accepted.extra.templateId !== ESCROW_TEMPLATE_ID
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_binding",
      "unsupported batch payment requirements",
    );
  }

  const amount = parseBatchLaneAmount(
    accepted.amount,
    "payment requirement amount",
  );
  const minimumDeposit = parseBatchLaneAmount(
    accepted.extra.minDepositSompi,
    "minimum deposit",
  );
  const claimReserve = parseBatchLaneAmount(
    accepted.extra.claimReserveSompi,
    "claim reserve",
  );
  const requiredMinimumDeposit = amount + claimReserve;
  if (requiredMinimumDeposit > BATCH_SCRIPT_INT_MAX) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_amount",
      "payment requirement amount plus claim reserve exceeds the batch covenant signed-int64 range",
    );
  }
  if (minimumDeposit < requiredMinimumDeposit) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_amount",
      "minimum deposit must cover the payment requirement amount plus claim reserve",
    );
  }

  return concatBytes([
    sha256(BATCH_PAYMENT_REQUIREMENTS_DOMAIN_TAG),
    sha256("batch-settlement"),
    sha256(network),
    sha256(ASSET_ID),
    le64(amount),
    sha256(accepted.payTo),
    le64(accepted.maxTimeoutSeconds),
    sha256(ESCROW_BINDING_ID),
    sha256(accepted.extra.templateId),
    hexToBytes(accepted.extra.serverPublicKey, {
      expectedLength: 32,
      errorCode: "invalid_kaspa_public_key",
      label: "serverPublicKey",
    }),
    le64(minimumDeposit),
    le64(claimReserve),
    le64(accepted.extra.refundTimeoutDaa),
  ]);
}

export function batchPaymentRequirementsPreimageHex(
  accepted: BatchPaymentRequirements,
): string {
  return bytesToHex(batchPaymentRequirementsPreimage(accepted));
}

export function batchPaymentRequirementsHash(
  accepted: BatchPaymentRequirements,
): Hash32Hex {
  return bytesToHex(sha256(batchPaymentRequirementsPreimage(accepted)));
}

export function batchCommitmentPreimage(
  input: BatchCommitmentInput,
): Uint8Array {
  return concatBytes([
    sha256(BATCH_COMMITMENT_DOMAIN_TAG),
    hexToBytes(input.channelId, {
      expectedLength: 32,
      label: "channelId",
    }),
    hexToBytes(input.voucher.covenantId, {
      expectedLength: 32,
      errorCode: "invalid_kaspa_x402_binding",
      label: "voucher.covenantId",
    }),
    hexToBytes(input.requestFingerprint, {
      expectedLength: 32,
      label: "requestFingerprint",
    }),
    hexToBytes(batchPaymentRequirementsHash(input.accepted), {
      expectedLength: 32,
      label: "paymentRequirementsHash",
    }),
    hexToBytes(input.activeOutpoint.txid, {
      expectedLength: 32,
      errorCode: "invalid_kaspa_outpoint",
      label: "activeOutpoint.txid",
    }),
    le32(input.activeOutpoint.index),
    le64(parseBatchLaneAmount(input.voucher.amount, "voucher amount")),
    sha256(
      hexToBytes(input.voucher.signature, {
        expectedLength: 64,
        label: "voucher.signature",
      }),
    ),
    le64(parseBatchLaneAmount(input.chargedAmount, "charged amount")),
    le64(
      parseBatchLaneAmount(
        input.chargedCumulativeBefore,
        "charged cumulative before",
      ),
    ),
    le64(
      parseBatchLaneAmount(
        input.chargedCumulativeAfter,
        "charged cumulative after",
      ),
    ),
    le64(
      parseBatchLaneAmount(
        input.claimedCumulativeAmount,
        "claimed cumulative amount",
      ),
    ),
  ]);
}

export function batchCommitmentPreimageHex(
  input: BatchCommitmentInput,
): string {
  return bytesToHex(batchCommitmentPreimage(input));
}

export function batchCommitmentId(input: BatchCommitmentInput): Hash32Hex {
  const before = parseBatchLaneAmount(
    input.chargedCumulativeBefore,
    "charged cumulative before",
  );
  const charged = parseBatchLaneAmount(input.chargedAmount, "charged amount");
  const after = parseBatchLaneAmount(
    input.chargedCumulativeAfter,
    "charged cumulative after",
  );
  const claimed = parseBatchLaneAmount(
    input.claimedCumulativeAmount,
    "claimed cumulative amount",
  );
  const authorized = parseBatchLaneAmount(input.voucher.amount, "voucher amount");
  if (claimed > before) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_amount",
      "claimed cumulative amount cannot exceed the prior charged amount",
    );
  }
  if (before + charged !== after) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_amount",
      "charged cumulative amount must equal the prior amount plus the charge",
    );
  }
  if (after > authorized) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_amount",
      "charged cumulative amount cannot exceed the signed voucher ceiling",
    );
  }
  return bytesToHex(sha256(batchCommitmentPreimage(input)));
}
