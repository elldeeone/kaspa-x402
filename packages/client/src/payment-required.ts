import {
  X402_VERSION,
  decodePaymentRequiredEnvelopeHeader,
  narrowPaymentRequiredEnvelope,
  parseSompiString,
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
    return (
      supportedNetworks.includes(requirement.network) &&
      supportedSchemes.includes(requirement.scheme) &&
      isSupportedKaspaRequirement(requirement)
    );
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
  parseSompiString(accepted.extra.refundTimeoutDaa);

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
  if (accepted.scheme === "batch-settlement") {
    parseSompiString(accepted.extra.minDepositSompi);
    parseSompiString(accepted.extra.refundTimeoutDaa);
  }
}
