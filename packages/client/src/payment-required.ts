import {
  X402_VERSION,
  KASPA_LOCK_TIME_THRESHOLD,
  decodePaymentRequiredEnvelopeHeader,
  narrowPaymentRequiredEnvelope,
  parseSompiString,
  type FundingOutpoint,
  type BatchPaymentRequirements,
  type ExactPaymentRequirements,
  type NetworkId,
  type PaymentRequirements,
  type PaymentRequired,
  type PaymentRequiredEnvelope,
  type PaymentScheme,
} from "@kaspa-x402/core";
import { KaspaX402Error } from "@kaspa-x402/core";
import type { ParsedPaymentRequired } from "./types.js";

export interface ParsePaymentRequiredOptions {
  supportedNetworks?: readonly NetworkId[];
  supportedSchemes?: readonly PaymentScheme[];
  supportsRequirement?: (requirement: ExactPaymentRequirements | BatchPaymentRequirements) => boolean;
}

const DEFAULT_SUPPORTED_NETWORKS: readonly NetworkId[] = ["kaspa:testnet-10"];
const DEFAULT_SUPPORTED_SCHEMES: readonly PaymentScheme[] = ["exact", "batch-settlement"];

export function parsePaymentRequiredHeaderValue(header: string, options: ParsePaymentRequiredOptions = {}): ParsedPaymentRequired {
  const paymentRequired = decodePaymentRequiredEnvelopeHeader(header);
  return selectPaymentRequirement(paymentRequired, options);
}

export function selectPaymentRequirement(
  paymentRequired: PaymentRequired | PaymentRequiredEnvelope,
  options: ParsePaymentRequiredOptions = {},
): ParsedPaymentRequired {
  const narrowed = narrowKaspaPaymentRequired(paymentRequired);

  const supportedNetworks = options.supportedNetworks ?? DEFAULT_SUPPORTED_NETWORKS;
  const supportedSchemes = options.supportedSchemes ?? DEFAULT_SUPPORTED_SCHEMES;
  const accepted = narrowed.accepts.find((requirement): requirement is ExactPaymentRequirements | BatchPaymentRequirements => {
    if (!supportedNetworks.includes(requirement.network) || !supportedSchemes.includes(requirement.scheme)) return false;
    if (!isSupportedKaspaRequirement(requirement)) return false;
    return options.supportsRequirement?.(requirement) ?? true;
  });

  if (!accepted) {
    throw new KaspaX402Error("invalid_kaspa_x402_accepted", "no supported Kaspa x402 requirement was offered");
  }

  validateSupportedRequirement(accepted);

  return {
    paymentRequired: narrowed,
    accepted,
  };
}

export function selectBatchPaymentRequired(
  paymentRequired: PaymentRequired | PaymentRequiredEnvelope,
  options: ParsePaymentRequiredOptions = {},
): ParsedPaymentRequired {
  const narrowed = narrowKaspaPaymentRequired(paymentRequired);

  const supportedNetworks = options.supportedNetworks ?? DEFAULT_SUPPORTED_NETWORKS;
  const accepted = narrowed.accepts.find((requirement): requirement is BatchPaymentRequirements => {
    return (
      requirement.scheme === "batch-settlement" &&
      supportedNetworks.includes(requirement.network) &&
      requirement.asset === "KAS" &&
      requirement.extra.binding === "kaspa-escrow-v1" &&
      requirement.extra.templateId === "kaspa-x402-escrow-v1"
    );
  });

  if (!accepted) {
    throw new KaspaX402Error("invalid_kaspa_x402_accepted", "no supported Kaspa batch-settlement requirement was offered");
  }

  parseSompiString(accepted.amount);
  parseSompiString(accepted.extra.minDepositSompi);
  assertDaaLockTime(accepted.extra.refundTimeoutDaa);

  return {
    paymentRequired: narrowed,
    accepted,
  };
}

function narrowKaspaPaymentRequired(paymentRequired: PaymentRequired | PaymentRequiredEnvelope): PaymentRequired {
  if (paymentRequired.x402Version !== X402_VERSION) {
    throw new KaspaX402Error("invalid_kaspa_x402_version", "only x402 v2 payment requirements are supported");
  }

  const narrowed = narrowPaymentRequiredEnvelope(paymentRequired);
  if (!narrowed.ok) throw narrowed.error;
  return narrowed.value.paymentRequired;
}

function isSupportedKaspaRequirement(requirement: PaymentRequirements): requirement is ExactPaymentRequirements | BatchPaymentRequirements {
  if (requirement.asset !== "KAS") return false;
  if (requirement.scheme === "exact") return requirement.extra.binding === "kaspa-exact-v1";
  return (
    requirement.scheme === "batch-settlement" &&
    requirement.extra.binding === "kaspa-escrow-v1" &&
    requirement.extra.templateId === "kaspa-x402-escrow-v1"
  );
}

function validateSupportedRequirement(accepted: ExactPaymentRequirements | BatchPaymentRequirements): void {
  parseSompiString(accepted.amount);
  if (accepted.scheme === "exact") {
    validateExactReservationTerms(accepted);
  }
  if (accepted.scheme === "batch-settlement") {
    parseSompiString(accepted.extra.minDepositSompi);
    assertDaaLockTime(accepted.extra.refundTimeoutDaa);
  }
}

function validateExactReservationTerms(accepted: ExactPaymentRequirements): void {
  const extra = accepted.extra;
  const hasReservation =
    extra.templateId !== undefined ||
    extra.transactionEncoding !== undefined ||
    extra.borrowOutpoint !== undefined ||
    extra.borrowAmount !== undefined ||
    extra.borrowScriptPublicKey !== undefined ||
    extra.borrowRedeemScript !== undefined ||
    extra.additiveThresholdSompi !== undefined ||
    extra.paymentOutputIndex !== undefined ||
    extra.reservationId !== undefined ||
    extra.reservationExpiresAt !== undefined;
  if (!hasReservation) return;
  if (
    extra.templateId !== "kaspa-x402-kip10-additive-v1" ||
    extra.transactionEncoding !== "kaspa-sdk-safe-json-v2.0.0" ||
    !isFundingOutpoint(extra.borrowOutpoint) ||
    typeof extra.borrowAmount !== "string" ||
    typeof extra.borrowScriptPublicKey !== "string" ||
    typeof extra.borrowRedeemScript !== "string" ||
    typeof extra.additiveThresholdSompi !== "string" ||
    !Number.isInteger(extra.paymentOutputIndex) ||
    typeof extra.reservationId !== "string"
  ) {
    throw new KaspaX402Error("invalid_kaspa_x402_payload", "exact reservation terms are incomplete");
  }
  parseSompiString(extra.borrowAmount);
  parseSompiString(extra.additiveThresholdSompi);
  if (!/^[0-9a-fA-F]{64}$/.test(extra.reservationId)) {
    throw new KaspaX402Error("invalid_kaspa_x402_payload", "exact reservation id must be a transaction-like 32-byte hex string");
  }
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(extra.borrowScriptPublicKey)) {
    throw new KaspaX402Error("invalid_kaspa_x402_payload", "exact reservation script public key must be hex");
  }
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(extra.borrowRedeemScript)) {
    throw new KaspaX402Error("invalid_kaspa_x402_payload", "exact reservation redeem script must be hex");
  }
  if (extra.reservationExpiresAt !== undefined && Number.isNaN(Date.parse(extra.reservationExpiresAt))) {
    throw new KaspaX402Error("invalid_kaspa_x402_payload", "exact reservation expiry must be an ISO date string");
  }
}

function assertDaaLockTime(value: string): void {
  if (parseSompiString(value) >= KASPA_LOCK_TIME_THRESHOLD) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      "refundTimeoutDaa must remain below the consensus timestamp boundary",
    );
  }
}

function isFundingOutpoint(value: unknown): value is FundingOutpoint {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    /^[0-9a-fA-F]{64}$/.test(String((value as { txid?: unknown }).txid)) &&
    Number.isInteger((value as { index?: unknown }).index) &&
    Number((value as { index?: unknown }).index) >= 0 &&
    Number((value as { index?: unknown }).index) <= 0xffff_ffff
  );
}
