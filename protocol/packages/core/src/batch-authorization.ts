import {
  BATCH_PAYMENT_INTENT_SCOPE,
  KASPA_LOCK_TIME_THRESHOLD,
} from "./constants.js";
import { hexToBytes, sha256Hex } from "./binary.js";
import { parseBatchLaneAmount } from "./batch-lane.js";
import { KaspaX402Error } from "./errors.js";
import { stableStringify } from "./stable-json.js";
import type {
  BatchPaymentAuthorizationIntent,
  BatchPaymentAuthorizationPolicy,
  Hash32Hex,
} from "./types.js";

export function batchPaymentAuthorizationIntentPreimage(
  intent: BatchPaymentAuthorizationIntent,
): string {
  const snapshot = snapshotIntent(intent);
  validateIntentForDigest(snapshot);
  return stableStringify(normalizedIntent(snapshot));
}

export function batchPaymentAuthorizationIntentDigest(
  intent: BatchPaymentAuthorizationIntent,
): Hash32Hex {
  return sha256Hex(batchPaymentAuthorizationIntentPreimage(intent));
}

/**
 * Validates the immutable intent and every payer-owned economic/audience cap.
 * Callers must run this before key generation, signing, persistence, or wallet
 * preparation.
 */
export function validateBatchPaymentAuthorization(
  intent: BatchPaymentAuthorizationIntent,
  policy: BatchPaymentAuthorizationPolicy,
): true {
  const snapshot = snapshotIntent(intent);
  const {
    fixedCharge,
    before,
    after,
    claimed,
    initialDeposit,
    currentFunding,
    topUp,
    resultingFunding,
    resultingExposure,
    reserve,
    timeout,
    currentDaa,
    distance,
    errorCharge,
  } = validateIntentForDigest(snapshot);

  if (fixedCharge === 0n) failAmount("fixed charge must be positive");
  if (before + fixedCharge !== after) {
    failAmount("authorized cumulative after must equal before plus fixed charge");
  }
  if (claimed > before) {
    failAmount("claimed cumulative amount cannot exceed prior authorization");
  }
  if (claimed + resultingFunding !== resultingExposure) {
    failAmount(
      "resulting exposure must equal claimed cumulative amount plus resulting funding",
    );
  }
  if (after - claimed + reserve > resultingFunding) {
    failAmount(
      "resulting funding must cover remaining authorization plus claim reserve",
    );
  }
  if (timeout <= currentDaa || timeout - currentDaa !== distance) {
    failAmount(
      "refund distance must equal a future timeout minus authoritative current DAA",
    );
  }

  if (errorCharge !== null) {
    if (errorCharge !== fixedCharge) {
      failAmount("MCP error charge must equal the fixed charge");
    }
  }

  if (snapshot.operation === "open") {
    if (
      initialDeposit === 0n ||
      currentFunding !== 0n ||
      topUp !== 0n ||
      resultingFunding !== initialDeposit ||
      before !== 0n ||
      claimed !== 0n
    ) {
      failAmount("open intent has inconsistent genesis funding or accounting");
    }
  } else if (snapshot.operation === "charge") {
    if (
      initialDeposit !== 0n ||
      topUp !== 0n ||
      resultingFunding !== currentFunding
    ) {
      failAmount("charge intent must preserve existing lane funding");
    }
  } else {
    if (
      initialDeposit !== 0n ||
      topUp === 0n ||
      currentFunding + topUp !== resultingFunding
    ) {
      failAmount("top-up intent has inconsistent funding delta");
    }
  }

  const maximumCharge = amount(
    policy.maximumBatchChargeSompi,
    "maximum batch charge",
  );
  const maximumInitialDeposit = amount(
    policy.maximumInitialDepositSompi,
    "maximum initial deposit",
  );
  const maximumTopUp = amount(policy.maximumTopUpSompi, "maximum top-up");
  const maximumCumulative = amount(
    policy.maximumCumulativeAuthorizationSompi,
    "maximum cumulative authorization",
  );
  const maximumExposure = amount(
    policy.maximumTotalExposureSompi,
    "maximum total exposure",
  );
  const minimumLead = amount(
    policy.minimumRefundLeadDaa,
    "minimum refund lead DAA",
  );
  const maximumHorizon = amount(
    policy.maximumRefundHorizonDaa,
    "maximum refund horizon DAA",
  );

  if (fixedCharge > maximumCharge) failPolicy("fixed charge exceeds payer cap");
  if (initialDeposit > maximumInitialDeposit) {
    failPolicy("initial deposit exceeds payer cap");
  }
  if (topUp > maximumTopUp) failPolicy("top-up exceeds payer cap");
  if (after > maximumCumulative) {
    failPolicy("cumulative authorization exceeds payer cap");
  }
  if (resultingExposure > maximumExposure) {
    failPolicy("total exposure exceeds payer cap");
  }
  if (distance < minimumLead) {
    failPolicy("refund timeout is below the payer minimum lead");
  }
  if (maximumHorizon === 0n || distance >= maximumHorizon) {
    failPolicy("refund timeout reaches or exceeds the payer maximum horizon");
  }

  requireAllowed(policy.allowedOrigins, snapshot.origin, "origin");
  requireAllowed(policy.allowedResources, snapshot.resource, "resource");
  requireAllowed(policy.allowedPayTo, snapshot.payTo, "payee");
  requireAllowed(
    policy.allowedServerPublicKeys.map((key) => key.toLowerCase()),
    snapshot.serverPublicKey.toLowerCase(),
    "server key",
  );
  requireAllowed(
    policy.allowedFundingSources,
    snapshot.fundingSource,
    "funding source",
  );
  return true;
}

interface ParsedIntentEconomics {
  fixedCharge: bigint;
  before: bigint;
  after: bigint;
  claimed: bigint;
  initialDeposit: bigint;
  currentFunding: bigint;
  topUp: bigint;
  resultingFunding: bigint;
  resultingExposure: bigint;
  reserve: bigint;
  timeout: bigint;
  currentDaa: bigint;
  distance: bigint;
  errorCharge: bigint | null;
}

function validateIntentForDigest(
  intent: BatchPaymentAuthorizationIntent,
): ParsedIntentEconomics {
  validateIntentShape(intent);
  const economics: ParsedIntentEconomics = {
    fixedCharge: amount(intent.fixedChargeSompi, "fixed charge"),
    before: amount(
      intent.authorizedCumulativeBefore,
      "authorized cumulative before",
    ),
    after: amount(
      intent.authorizedCumulativeAfter,
      "authorized cumulative after",
    ),
    claimed: amount(
      intent.claimedCumulativeAmount,
      "claimed cumulative amount",
    ),
    initialDeposit: amount(intent.initialDepositSompi, "initial deposit"),
    currentFunding: amount(intent.currentFundingSompi, "current funding"),
    topUp: amount(intent.topUpSompi, "top-up"),
    resultingFunding: amount(
      intent.resultingFundingSompi,
      "resulting funding",
    ),
    resultingExposure: amount(
      intent.resultingExposureSompi,
      "resulting exposure",
    ),
    reserve: amount(intent.claimReserveSompi, "claim reserve"),
    timeout: amount(intent.refundTimeoutDaa, "refund timeout DAA"),
    currentDaa: amount(
      intent.authoritativeCurrentDaa,
      "authoritative current DAA",
    ),
    distance: amount(intent.refundDistanceDaa, "refund distance DAA"),
    errorCharge:
      intent.mcpErrorChargeSompi === null
        ? null
        : amount(intent.mcpErrorChargeSompi, "MCP error charge"),
  };
  if (economics.timeout >= KASPA_LOCK_TIME_THRESHOLD) {
    failAmount(
      "refund timeout DAA must remain below the consensus timestamp boundary",
    );
  }
  return economics;
}

function validateIntentShape(intent: BatchPaymentAuthorizationIntent): void {
  if (intent.scope !== BATCH_PAYMENT_INTENT_SCOPE) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_binding",
      "unsupported batch payment intent scope",
    );
  }
  if (!["open", "charge", "top-up"].includes(intent.operation)) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      "unsupported batch payment operation",
    );
  }
  if (intent.network !== "kaspa:testnet-10" || intent.asset !== "KAS") {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_binding",
      "batch payment intent must target Testnet-10 native KAS",
    );
  }
  for (const [label, value] of [
    ["origin", intent.origin],
    ["resource", intent.resource],
    ["payTo", intent.payTo],
    ["fundingSource", intent.fundingSource],
  ] as const) {
    if (typeof value !== "string" || value.length === 0) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_payload",
        `${label} must be non-empty`,
      );
    }
  }
  hash32(intent.serverPublicKey, "serverPublicKey");
  if (intent.clientPublicKey !== null) hash32(intent.clientPublicKey, "clientPublicKey");
  hash32(intent.requestFingerprint, "requestFingerprint");
  hash32(intent.acceptedRequirementsHash, "acceptedRequirementsHash");
  hash32(intent.securityContextHash, "securityContextHash");
  if (intent.channelId !== null) hash32(intent.channelId, "channelId");
  if (intent.covenantId !== null) nonZeroHash32(intent.covenantId, "covenantId");
  if (intent.operation !== "open") requireExistingLane(intent);
  if (
    intent.paymentIdentifier !== null &&
    (typeof intent.paymentIdentifier !== "string" ||
      intent.paymentIdentifier.length === 0)
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      "paymentIdentifier must be a non-empty string or null",
    );
  }
}

function snapshotIntent(
  intent: BatchPaymentAuthorizationIntent,
): BatchPaymentAuthorizationIntent {
  return {
    scope: intent.scope,
    operation: intent.operation,
    origin: intent.origin,
    resource: intent.resource,
    network: intent.network,
    asset: intent.asset,
    payTo: intent.payTo,
    serverPublicKey: intent.serverPublicKey,
    clientPublicKey: intent.clientPublicKey,
    requestFingerprint: intent.requestFingerprint,
    acceptedRequirementsHash: intent.acceptedRequirementsHash,
    securityContextHash: intent.securityContextHash,
    fixedChargeSompi: intent.fixedChargeSompi,
    mcpErrorChargeSompi: intent.mcpErrorChargeSompi,
    authorizedCumulativeBefore: intent.authorizedCumulativeBefore,
    authorizedCumulativeAfter: intent.authorizedCumulativeAfter,
    claimedCumulativeAmount: intent.claimedCumulativeAmount,
    initialDepositSompi: intent.initialDepositSompi,
    currentFundingSompi: intent.currentFundingSompi,
    topUpSompi: intent.topUpSompi,
    resultingFundingSompi: intent.resultingFundingSompi,
    resultingExposureSompi: intent.resultingExposureSompi,
    claimReserveSompi: intent.claimReserveSompi,
    refundTimeoutDaa: intent.refundTimeoutDaa,
    authoritativeCurrentDaa: intent.authoritativeCurrentDaa,
    refundDistanceDaa: intent.refundDistanceDaa,
    fundingSource: intent.fundingSource,
    channelId: intent.channelId,
    covenantId: intent.covenantId,
    paymentIdentifier: intent.paymentIdentifier,
  };
}

function normalizedIntent(
  intent: BatchPaymentAuthorizationIntent,
): BatchPaymentAuthorizationIntent {
  return {
    scope: BATCH_PAYMENT_INTENT_SCOPE,
    operation: intent.operation,
    origin: intent.origin,
    resource: intent.resource,
    network: intent.network,
    asset: intent.asset,
    payTo: intent.payTo,
    serverPublicKey: intent.serverPublicKey.toLowerCase(),
    clientPublicKey: intent.clientPublicKey?.toLowerCase() ?? null,
    requestFingerprint: intent.requestFingerprint.toLowerCase(),
    acceptedRequirementsHash: intent.acceptedRequirementsHash.toLowerCase(),
    securityContextHash: intent.securityContextHash.toLowerCase(),
    fixedChargeSompi: intent.fixedChargeSompi,
    mcpErrorChargeSompi: intent.mcpErrorChargeSompi,
    authorizedCumulativeBefore: intent.authorizedCumulativeBefore,
    authorizedCumulativeAfter: intent.authorizedCumulativeAfter,
    claimedCumulativeAmount: intent.claimedCumulativeAmount,
    initialDepositSompi: intent.initialDepositSompi,
    currentFundingSompi: intent.currentFundingSompi,
    topUpSompi: intent.topUpSompi,
    resultingFundingSompi: intent.resultingFundingSompi,
    resultingExposureSompi: intent.resultingExposureSompi,
    claimReserveSompi: intent.claimReserveSompi,
    refundTimeoutDaa: intent.refundTimeoutDaa,
    authoritativeCurrentDaa: intent.authoritativeCurrentDaa,
    refundDistanceDaa: intent.refundDistanceDaa,
    fundingSource: intent.fundingSource,
    channelId: intent.channelId?.toLowerCase() ?? null,
    covenantId: intent.covenantId?.toLowerCase() ?? null,
    paymentIdentifier: intent.paymentIdentifier,
  };
}

function requireExistingLane(intent: BatchPaymentAuthorizationIntent): void {
  if (
    intent.channelId === null ||
    intent.covenantId === null ||
    intent.clientPublicKey === null
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      "existing-lane intent requires channel, covenant, and client public key",
    );
  }
}

function amount(value: string, label: string): bigint {
  return parseBatchLaneAmount(value, label);
}

function hash32(value: string, label: string): void {
  hexToBytes(value, { expectedLength: 32, label });
}

function nonZeroHash32(value: string, label: string): void {
  const bytes = hexToBytes(value, { expectedLength: 32, label });
  if (bytes.every((byte) => byte === 0)) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_binding",
      `${label} must not be zero`,
    );
  }
}

function requireAllowed(
  allowed: readonly string[],
  value: string,
  label: string,
): void {
  if (!allowed.includes(value)) failPolicy(`${label} is not payer-approved`);
}

function failAmount(message: string): never {
  throw new KaspaX402Error("invalid_kaspa_x402_amount", message);
}

function failPolicy(message: string): never {
  throw new KaspaX402Error("invalid_kaspa_x402_payload", message);
}
