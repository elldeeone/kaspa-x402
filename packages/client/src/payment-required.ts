import {
  X402_VERSION,
  decodePaymentRequiredHeader,
  parseSompiString,
  type BatchPaymentRequirements,
  type NetworkId,
  type PaymentRequired,
} from "@kaspa-x402/core";
import { KaspaX402Error } from "@kaspa-x402/core";
import type { ParsedPaymentRequired } from "./types.js";

export interface ParsePaymentRequiredOptions {
  supportedNetworks?: readonly NetworkId[];
}

const DEFAULT_SUPPORTED_NETWORKS: readonly NetworkId[] = ["kaspa:mainnet", "kaspa:testnet-10"];

export function parsePaymentRequiredHeaderValue(header: string, options: ParsePaymentRequiredOptions = {}): ParsedPaymentRequired {
  const paymentRequired = decodePaymentRequiredHeader(header);
  return selectBatchPaymentRequired(paymentRequired, options);
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
