import {
  ASSET_ID,
  BATCH_COMMITMENT_DOMAIN_TAG,
  BATCH_PAYMENT_REQUIREMENTS_DOMAIN_TAG,
  BATCH_SCRIPT_INT_MAX,
  ESCROW_BINDING_ID,
  ESCROW_TEMPLATE_ID,
  KASPA_LOCK_TIME_THRESHOLD,
} from "./constants.js";
import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  le32,
  le64,
  sha256,
  utf8Bytes,
} from "./binary.js";
import { KaspaX402Error } from "./errors.js";
import { parseBatchLaneAmount } from "./batch-lane.js";
import { stableStringify } from "./stable-json.js";
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
  presentationDigest: Hash32Hex;
  requestFingerprint: Hash32Hex;
  activeOutpoint: FundingOutpoint;
  voucher: Voucher;
  fixedCharge: SompiString;
  authorizedCumulativeBefore: SompiString;
  authorizedCumulativeAfter: SompiString;
  claimedCumulativeAmount: SompiString;
}

export function batchPaymentRequirementsPreimage(
  accepted: BatchPaymentRequirements,
): Uint8Array {
  const preimage = stableStringify({
    scope: BATCH_PAYMENT_REQUIREMENTS_DOMAIN_TAG,
    accepted,
  });
  const snapshot = (
    JSON.parse(preimage) as { accepted: BatchPaymentRequirements }
  ).accepted;

  if (snapshot.network !== "kaspa:testnet-10") {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_network",
      "batch settlement v3 requires Kaspa Testnet-10",
    );
  }
  if (
    snapshot.scheme !== "batch-settlement" ||
    snapshot.asset !== ASSET_ID ||
    snapshot.extra.binding !== ESCROW_BINDING_ID ||
    snapshot.extra.templateId !== ESCROW_TEMPLATE_ID
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_binding",
      "unsupported batch payment requirements",
    );
  }

  const amount = parseBatchLaneAmount(
    snapshot.amount,
    "payment requirement amount",
  );
  if (amount === 0n) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_amount",
      "batch fixed charge must be positive",
    );
  }
  const minimumDeposit = parseBatchLaneAmount(
    snapshot.extra.minDepositSompi,
    "minimum deposit",
  );
  const claimReserve = parseBatchLaneAmount(
    snapshot.extra.claimReserveSompi,
    "claim reserve",
  );
  const refundTimeoutDaa = parseBatchLaneAmount(
    snapshot.extra.refundTimeoutDaa,
    "refund timeout DAA",
  );
  if (refundTimeoutDaa >= KASPA_LOCK_TIME_THRESHOLD) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_amount",
      "refund timeout DAA must remain below the consensus timestamp boundary",
    );
  }
  le64(snapshot.maxTimeoutSeconds);
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
  hexToBytes(snapshot.extra.securityContextHash, {
    expectedLength: 32,
    label: "securityContextHash",
  });
  if (
    snapshot.extra.mcpErrorChargeSompi !== undefined &&
    parseBatchLaneAmount(
      snapshot.extra.mcpErrorChargeSompi,
      "MCP error charge",
    ) !== amount
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_amount",
      "MCP error charge must equal the batch fixed charge",
    );
  }

  hexToBytes(snapshot.extra.serverPublicKey, {
    expectedLength: 32,
    errorCode: "invalid_kaspa_public_key",
    label: "serverPublicKey",
  });
  return utf8Bytes(preimage);
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
    hexToBytes(input.presentationDigest, {
      expectedLength: 32,
      label: "presentationDigest",
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
    le64(
      parseBatchLaneAmount(
        input.authorizedCumulativeBefore,
        "authorized cumulative before",
      ),
    ),
    le64(
      parseBatchLaneAmount(
        input.authorizedCumulativeAfter,
        "authorized cumulative after",
      ),
    ),
    sha256(
      hexToBytes(input.voucher.signature, {
        expectedLength: 64,
        label: "voucher.signature",
      }),
    ),
    le64(parseBatchLaneAmount(input.fixedCharge, "fixed charge")),
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
    input.authorizedCumulativeBefore,
    "authorized cumulative before",
  );
  const fixedCharge = parseBatchLaneAmount(input.fixedCharge, "fixed charge");
  const after = parseBatchLaneAmount(
    input.authorizedCumulativeAfter,
    "authorized cumulative after",
  );
  const claimed = parseBatchLaneAmount(
    input.claimedCumulativeAmount,
    "claimed cumulative amount",
  );
  const voucherAuthorized = parseBatchLaneAmount(
    input.voucher.authorizedCumulativeAmount,
    "voucher authorized cumulative amount",
  );
  if (claimed > before) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_amount",
      "claimed cumulative amount cannot exceed the prior authorization",
    );
  }
  if (fixedCharge === 0n || before + fixedCharge !== after) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_amount",
      "authorized cumulative amount must equal the prior amount plus the positive fixed charge",
    );
  }
  if (after !== voucherAuthorized) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_amount",
      "voucher must sign the exact authorized cumulative amount after this charge",
    );
  }
  return bytesToHex(sha256(batchCommitmentPreimage(input)));
}
