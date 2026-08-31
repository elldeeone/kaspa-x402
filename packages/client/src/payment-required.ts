import {
  X402_VERSION,
  KASPA_LOCK_TIME_THRESHOLD,
  decodePaymentRequiredEnvelopeHeader,
  narrowPaymentRequiredEnvelope,
  parseBatchLaneAmount,
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
import {
  parseKip10AdditiveRedeemScript,
  payToScriptHashScript,
  serializedScriptPublicKey,
} from "@kaspa-x402/covenant";
import type { ParsedPaymentRequired } from "./types.js";

export interface ParsePaymentRequiredOptions {
  supportedNetworks?: readonly NetworkId[];
  supportedSchemes?: readonly PaymentScheme[];
  supportsRequirement?: (
    requirement: ExactPaymentRequirements | BatchPaymentRequirements,
  ) => boolean;
}

const DEFAULT_SUPPORTED_NETWORKS: readonly NetworkId[] = ["kaspa:testnet-10"];
const DEFAULT_SUPPORTED_SCHEMES: readonly PaymentScheme[] = [
  "exact",
  "batch-settlement",
];

export function parsePaymentRequiredHeaderValue(
  header: string,
  options: ParsePaymentRequiredOptions = {},
): ParsedPaymentRequired {
  const paymentRequired = decodePaymentRequiredEnvelopeHeader(header);
  return selectPaymentRequirement(paymentRequired, options);
}

export function selectPaymentRequirement(
  paymentRequired: PaymentRequired | PaymentRequiredEnvelope,
  options: ParsePaymentRequiredOptions = {},
): ParsedPaymentRequired {
  const narrowed = narrowKaspaPaymentRequired(paymentRequired);

  const supportedNetworks =
    options.supportedNetworks ?? DEFAULT_SUPPORTED_NETWORKS;
  const supportedSchemes =
    options.supportedSchemes ?? DEFAULT_SUPPORTED_SCHEMES;
  const accepted = narrowed.accepts.find(
    (
      requirement,
    ): requirement is ExactPaymentRequirements | BatchPaymentRequirements => {
      if (
        !supportedNetworks.includes(requirement.network) ||
        !supportedSchemes.includes(requirement.scheme)
      )
        return false;
      if (!isSupportedKaspaRequirement(requirement)) return false;
      return options.supportsRequirement?.(requirement) ?? true;
    },
  );

  if (!accepted) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_accepted",
      "no supported Kaspa x402 requirement was offered",
    );
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

  const supportedNetworks =
    options.supportedNetworks ?? DEFAULT_SUPPORTED_NETWORKS;
  const accepted = narrowed.accepts.find(
    (requirement): requirement is BatchPaymentRequirements => {
      return (
        requirement.scheme === "batch-settlement" &&
        supportedNetworks.includes(requirement.network) &&
        requirement.asset === "KAS" &&
        requirement.extra.binding === "kaspa-escrow-v2" &&
        requirement.extra.templateId === "kaspa-x402-escrow-v3"
      );
    },
  );

  if (!accepted) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_accepted",
      "no supported Kaspa batch-settlement requirement was offered",
    );
  }

  validateBatchTerms(accepted);

  return {
    paymentRequired: narrowed,
    accepted,
  };
}

function narrowKaspaPaymentRequired(
  paymentRequired: PaymentRequired | PaymentRequiredEnvelope,
): PaymentRequired {
  if (paymentRequired.x402Version !== X402_VERSION) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_version",
      "only x402 v2 payment requirements are supported",
    );
  }

  const narrowed = narrowPaymentRequiredEnvelope(paymentRequired);
  if (!narrowed.ok) throw narrowed.error;
  return narrowed.value.paymentRequired;
}

function isSupportedKaspaRequirement(
  requirement: PaymentRequirements,
): requirement is ExactPaymentRequirements | BatchPaymentRequirements {
  if (requirement.asset !== "KAS") return false;
  if (requirement.scheme === "exact") {
    return (
      requirement.extra.binding === "kaspa-exact-v2" &&
      requirement.extra.paymentFlow === "upfront"
    );
  }
  return (
    requirement.scheme === "batch-settlement" &&
    requirement.extra.binding === "kaspa-escrow-v2" &&
    requirement.extra.templateId === "kaspa-x402-escrow-v3"
  );
}

function validateSupportedRequirement(
  accepted: ExactPaymentRequirements | BatchPaymentRequirements,
): void {
  parseSompiString(accepted.amount);
  if (accepted.scheme === "exact") {
    validateExactTerms(accepted);
  }
  if (accepted.scheme === "batch-settlement") {
    validateBatchTerms(accepted);
  }
}

function validateBatchTerms(accepted: BatchPaymentRequirements): void {
  const amount = parseBatchLaneAmount(accepted.amount, "batch payment amount");
  const minimumDeposit = parseBatchLaneAmount(
    accepted.extra.minDepositSompi,
    "minimum deposit",
  );
  const reserve = parseBatchLaneAmount(
    accepted.extra.claimReserveSompi,
    "claim reserve",
  );
  const requiredInitialCapacity = amount + reserve;
  parseBatchLaneAmount(
    requiredInitialCapacity.toString(),
    "initial batch capacity",
  );
  if (minimumDeposit < requiredInitialCapacity) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_amount",
      "minimum deposit does not cover the first batch charge and claim reserve",
    );
  }
  assertDaaLockTime(accepted.extra.refundTimeoutDaa);
}

function validateExactTerms(accepted: ExactPaymentRequirements): void {
  if (parseSompiString(accepted.amount) <= 0n) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_amount",
      "exact payment amount must be positive",
    );
  }
  const extra = accepted.extra;
  if (extra.paymentFlow !== "upfront") {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_binding",
      "exact payment flow must be upfront",
    );
  }
  if (extra.profile !== "standard-native" && extra.profile !== "additive") {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      "exact v2 requirements must select a profile",
    );
  }
  if (
    extra.transactionEncoding !== "kaspa-sdk-safe-json-v2.0.0" ||
    typeof extra.payToScriptPublicKey !== "string"
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      "exact v2 requirements must bind transaction encoding and payTo script",
    );
  }
  if (extra.profile === "standard-native") return;
  if (
    extra.templateId !== "kaspa-x402-kip10-additive-v1" ||
    !isFundingOutpoint(extra.expectedHeadOutpoint) ||
    typeof extra.headId !== "string" ||
    typeof extra.headVersion !== "string" ||
    typeof extra.headAmount !== "string" ||
    typeof extra.headScriptPublicKey !== "string" ||
    typeof extra.headRedeemScript !== "string" ||
    typeof extra.additiveThresholdSompi !== "string" ||
    typeof extra.challengeId !== "string" ||
    typeof extra.challengeExpiresAt !== "string" ||
    extra.paymentOutputIndex !== 0
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      "additive exact head challenge terms are incomplete",
    );
  }
  parseSompiString(extra.headVersion);
  if (parseSompiString(extra.headAmount) <= 0n) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_amount",
      "additive exact head amount must be positive",
    );
  }
  const threshold = parseSompiString(extra.additiveThresholdSompi);
  if (threshold <= 0n || parseSompiString(accepted.amount) < threshold) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_amount",
      "additive exact amount must meet the positive head threshold",
    );
  }
  if (
    !/^[0-9a-fA-F]{64}$/.test(extra.headId) ||
    !/^[0-9a-fA-F]{64}$/.test(extra.challengeId)
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      "additive exact head and challenge ids must be 32-byte hex",
    );
  }
  const expiresAt = Date.parse(extra.challengeExpiresAt);
  if (Number.isNaN(expiresAt) || expiresAt <= Date.now()) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      "additive exact challenge expiry must be a future ISO date string",
    );
  }
  try {
    const template = parseKip10AdditiveRedeemScript(extra.headRedeemScript);
    const expectedScript = serializedScriptPublicKey(
      payToScriptHashScript(extra.headRedeemScript),
    ).toLowerCase();
    if (
      template.amount !== extra.additiveThresholdSompi ||
      expectedScript !== extra.headScriptPublicKey.toLowerCase() ||
      expectedScript !== extra.payToScriptPublicKey.toLowerCase()
    ) {
      throw new Error("head challenge script terms do not match");
    }
  } catch {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      "additive exact challenge must bind the canonical KIP-10 script, threshold, head, and payTo script",
    );
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
