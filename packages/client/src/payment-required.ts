import {
  X402_VERSION,
  decodePaymentRequiredHeader,
  parseSompiString,
  type BatchPaymentRequirements,
  type ExactPaymentRequirements,
  type NetworkId,
  type PaymentRequirements,
  type PaymentRequired,
  type PaymentScheme,
  type UptoPaymentRequirements,
} from "@kaspa-x402/core";
import { KaspaX402Error } from "@kaspa-x402/core";
import type { ParsedPaymentRequired } from "./types.js";

export interface ParsePaymentRequiredOptions {
  supportedNetworks?: readonly NetworkId[];
  supportedSchemes?: readonly PaymentScheme[];
}

const DEFAULT_SUPPORTED_NETWORKS: readonly NetworkId[] = ["kaspa:testnet-10"];
const DEFAULT_SUPPORTED_SCHEMES: readonly PaymentScheme[] = ["exact", "upto", "batch-settlement"];

export function parsePaymentRequiredHeaderValue(header: string, options: ParsePaymentRequiredOptions = {}): ParsedPaymentRequired {
  const paymentRequired = decodePaymentRequiredHeader(header);
  return selectPaymentRequirement(paymentRequired, options);
}

export function selectPaymentRequirement(paymentRequired: PaymentRequired, options: ParsePaymentRequiredOptions = {}): ParsedPaymentRequired {
  if (paymentRequired.x402Version !== X402_VERSION) {
    throw new KaspaX402Error("invalid_kaspa_x402_version", "only x402 v2 payment requirements are supported");
  }

  const supportedNetworks = options.supportedNetworks ?? DEFAULT_SUPPORTED_NETWORKS;
  const supportedSchemes = options.supportedSchemes ?? DEFAULT_SUPPORTED_SCHEMES;
  const accepted = paymentRequired.accepts.find((requirement): requirement is ExactPaymentRequirements | UptoPaymentRequirements | BatchPaymentRequirements => {
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
    paymentRequired,
    accepted,
  };
}

export function selectBatchPaymentRequired(
  paymentRequired: PaymentRequired,
  options: ParsePaymentRequiredOptions = {},
): ParsedPaymentRequired {
  if (paymentRequired.x402Version !== X402_VERSION) {
    throw new KaspaX402Error("invalid_kaspa_x402_version", "only x402 v2 payment requirements are supported");
  }

  const supportedNetworks = options.supportedNetworks ?? DEFAULT_SUPPORTED_NETWORKS;
  const accepted = paymentRequired.accepts.find((requirement): requirement is BatchPaymentRequirements => {
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
    paymentRequired,
    accepted,
  };
}

function isSupportedKaspaRequirement(requirement: PaymentRequirements): requirement is ExactPaymentRequirements | UptoPaymentRequirements | BatchPaymentRequirements {
  if (requirement.asset !== "KAS") return false;
  if (requirement.scheme === "exact") return requirement.extra.binding === "kaspa-exact-v1";
  if (requirement.scheme === "upto") {
    return (
      requirement.extra.binding === "kaspa-upto-v1" &&
      requirement.extra.authorizationTemplateId === "kaspa-x402-upto-v1" &&
      typeof requirement.extra.serverPublicKey === "string" &&
      typeof requirement.extra.settlementFeeReserveSompi === "string"
    );
  }
  return (
    requirement.scheme === "batch-settlement" &&
    requirement.extra.binding === "kaspa-escrow-v1" &&
    requirement.extra.templateId === "kaspa-x402-escrow-v1"
  );
}

function validateSupportedRequirement(accepted: ExactPaymentRequirements | UptoPaymentRequirements | BatchPaymentRequirements): void {
  parseSompiString(accepted.amount);
  if (accepted.scheme === "upto") {
    parseSompiString(accepted.extra.authorizationTimeoutDaa);
    parseSompiString(accepted.extra.settlementFeeReserveSompi);
  }
  if (accepted.scheme === "batch-settlement") {
    parseSompiString(accepted.extra.minDepositSompi);
    parseSompiString(accepted.extra.refundTimeoutDaa);
  }
}
