import {
  ASSET_ID,
  BATCH_COMMITMENT_DOMAIN_TAG,
  BATCH_PAYMENT_REQUIREMENTS_DOMAIN_TAG,
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
    accepted.extra.binding !== "kaspa-escrow-v1" ||
    accepted.extra.templateId !== ESCROW_TEMPLATE_ID
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_binding",
      "unsupported batch payment requirements",
    );
  }

  return concatBytes([
    sha256(BATCH_PAYMENT_REQUIREMENTS_DOMAIN_TAG),
    sha256("batch-settlement"),
    sha256(network),
    sha256(ASSET_ID),
    le64(accepted.amount),
    sha256(accepted.payTo),
    le64(accepted.maxTimeoutSeconds),
    sha256("kaspa-escrow-v1"),
    sha256(accepted.extra.templateId),
    hexToBytes(accepted.extra.serverPublicKey, {
      expectedLength: 32,
      errorCode: "invalid_kaspa_public_key",
      label: "serverPublicKey",
    }),
    le64(accepted.extra.minDepositSompi),
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
    le64(input.voucher.amount),
    sha256(
      hexToBytes(input.voucher.signature, {
        expectedLength: 64,
        label: "voucher.signature",
      }),
    ),
    le64(input.chargedAmount),
    le64(input.chargedCumulativeBefore),
    le64(input.chargedCumulativeAfter),
    le64(input.claimedCumulativeAmount),
  ]);
}

export function batchCommitmentPreimageHex(
  input: BatchCommitmentInput,
): string {
  return bytesToHex(batchCommitmentPreimage(input));
}

export function batchCommitmentId(input: BatchCommitmentInput): Hash32Hex {
  const before = BigInt(input.chargedCumulativeBefore);
  const charged = BigInt(input.chargedAmount);
  const after = BigInt(input.chargedCumulativeAfter);
  if (before + charged !== after) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_amount",
      "charged cumulative amount must equal the prior amount plus the charge",
    );
  }
  return bytesToHex(sha256(batchCommitmentPreimage(input)));
}
