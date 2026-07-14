import { parseSompiString } from "@kaspa-x402/core";
import {
  parseKip10AdditiveRedeemScript,
  payToScriptHashScript,
  serializedScriptPublicKey,
} from "@kaspa-x402/covenant";
import type {
  ExactHeadRecord,
  ExactHeadLineageApply,
  ExactHeadManifest,
  ExactHeadSelectionRequest,
  ExactSettlementAttemptRecord,
} from "./types.js";

const MAX_EXTERNAL_LINEAGE_STEPS = 64;

export function exactHeadManifest(input: ExactHeadRecord): ExactHeadManifest {
  const head = normalizeExactHeadRecord(input);
  const template = parseKip10AdditiveRedeemScript(head.redeemScript);
  return {
    format: "kaspa-x402-exact-head-manifest-v1",
    headId: head.headId,
    network: head.network,
    payTo: head.payTo,
    ownerPublicKey: template.ownerPublicKey,
    additiveThresholdSompi: head.additiveThresholdSompi,
    redeemScript: head.redeemScript,
    scriptPublicKey: head.scriptPublicKey,
    currentOutpoint: structuredClone(head.currentOutpoint),
    currentAmount: head.currentAmount,
    version: head.version,
    status: head.status,
    createdAt: head.createdAt,
    updatedAt: head.updatedAt,
    ...(head.lastTransactionId
      ? { lastTransactionId: head.lastTransactionId }
      : {}),
    ...(head.unavailableReason
      ? { unavailableReason: head.unavailableReason }
      : {}),
  };
}

export function normalizeExactHeadRecord(
  input: ExactHeadRecord,
): ExactHeadRecord {
  if (!/^[0-9a-fA-F]{64}$/.test(input.headId))
    throw new Error("exact head id must be 32-byte hex");
  if (!/^[0-9a-fA-F]{64}$/.test(input.currentOutpoint.txid))
    throw new Error("exact head outpoint txid must be 32-byte hex");
  if (
    !Number.isInteger(input.currentOutpoint.index) ||
    input.currentOutpoint.index < 0 ||
    input.currentOutpoint.index > 0xffff_ffff
  ) {
    throw new Error("exact head outpoint index is invalid");
  }
  if (
    input.templateId !== "kaspa-x402-kip10-additive-v1" ||
    input.transactionEncoding !== "kaspa-sdk-safe-json-v2.0.0"
  ) {
    throw new Error(
      "exact head template or transaction encoding is unsupported",
    );
  }
  if (parseSompiString(input.currentAmount) <= 0n)
    throw new Error("exact head amount must be positive");
  if (parseSompiString(input.version) < 0n)
    throw new Error("exact head version cannot be negative");
  const threshold = parseSompiString(input.additiveThresholdSompi);
  if (threshold <= 0n)
    throw new Error("exact head additive threshold must be positive");
  const template = parseKip10AdditiveRedeemScript(input.redeemScript);
  if (template.amount !== input.additiveThresholdSompi)
    throw new Error("exact head threshold does not match its KIP-10 script");
  const scriptPublicKey = serializedScriptPublicKey(
    payToScriptHashScript(input.redeemScript),
  ).toLowerCase();
  if (scriptPublicKey !== input.scriptPublicKey.toLowerCase())
    throw new Error(
      "exact head redeem script does not match its script public key",
    );
  if (
    Number.isNaN(Date.parse(input.createdAt)) ||
    Number.isNaN(Date.parse(input.updatedAt))
  ) {
    throw new Error("exact head timestamps must be ISO date strings");
  }
  if (input.status === "claimed" && !input.claimTransactionId)
    throw new Error("claimed exact head requires a transaction id");
  if (
    input.claimTransactionId &&
    !/^[0-9a-fA-F]{64}$/.test(input.claimTransactionId)
  ) {
    throw new Error("exact head claim transaction id must be 32-byte hex");
  }
  return {
    ...structuredClone(input),
    headId: input.headId.toLowerCase(),
    currentOutpoint: {
      txid: input.currentOutpoint.txid.toLowerCase(),
      index: input.currentOutpoint.index,
    },
    scriptPublicKey,
    redeemScript: input.redeemScript.toLowerCase(),
    ...(input.claimTransactionId
      ? { claimTransactionId: input.claimTransactionId.toLowerCase() }
      : {}),
    ...(input.lastTransactionId
      ? { lastTransactionId: input.lastTransactionId.toLowerCase() }
      : {}),
  };
}

export function normalizeExactSettlementAttempt(
  input: ExactSettlementAttemptRecord,
): ExactSettlementAttemptRecord {
  if (!/^[0-9a-fA-F]{64}$/.test(input.transactionId))
    throw new Error("exact settlement transaction id must be 32-byte hex");
  if (!/^[0-9a-fA-F]{64}$/.test(input.requestFingerprint))
    throw new Error("exact settlement request fingerprint must be 32-byte hex");
  if (
    !/^[0-9a-fA-F]{64}$/.test(input.paymentRequirementsHash) ||
    !/^[0-9a-fA-F]{64}$/.test(input.paymentPayloadHash) ||
    !/^[0-9a-fA-F]{64}$/.test(input.requestAuthorizationId)
  ) {
    throw new Error("exact settlement hashes must be 32-byte hex");
  }
  if (
    input.status !== "pending" ||
    input.finality ||
    input.handlerStartedAt ||
    input.handlerResult ||
    input.handlerCompletedAt ||
    input.recoveryReason
  ) {
    throw new Error(
      "new exact settlement attempt must begin pending without finality or handler state",
    );
  }
  if (parseSompiString(input.amount) <= 0n)
    throw new Error("exact settlement amount must be positive");
  if (typeof input.transaction !== "string" || input.transaction.length === 0)
    throw new Error("exact settlement transaction is required");
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(input.payToScriptPublicKey)) {
    throw new Error(
      "exact settlement payTo script public key must be byte hex",
    );
  }
  if (
    Number.isNaN(Date.parse(input.createdAt)) ||
    Number.isNaN(Date.parse(input.updatedAt))
  ) {
    throw new Error("exact settlement timestamps must be ISO date strings");
  }
  const attempt: ExactSettlementAttemptRecord = {
    ...structuredClone(input),
    transactionId: input.transactionId.toLowerCase(),
    requestFingerprint: input.requestFingerprint.toLowerCase(),
    paymentRequirementsHash: input.paymentRequirementsHash.toLowerCase(),
    paymentPayloadHash: input.paymentPayloadHash.toLowerCase(),
    requestAuthorizationId: input.requestAuthorizationId.toLowerCase(),
    payToScriptPublicKey: input.payToScriptPublicKey.toLowerCase(),
  };
  if (attempt.head) {
    if (attempt.profile !== "additive")
      throw new Error("only additive exact may claim a head");
    if (
      attempt.head.expectedOutpoint.index !== 0 ||
      attempt.head.successor.outpoint.index !== 0
    ) {
      throw new Error(
        "additive exact head and successor must remain at index 0",
      );
    }
    if (
      attempt.head.successor.outpoint.txid.toLowerCase() !==
      attempt.transactionId
    ) {
      throw new Error(
        "additive exact successor must belong to the claimed transaction",
      );
    }
    if (
      parseSompiString(attempt.head.successor.amount) !==
      parseSompiString(attempt.head.expectedAmount) +
        parseSompiString(attempt.amount)
    ) {
      throw new Error(
        "additive exact successor delta must equal the settlement amount",
      );
    }
    attempt.head = {
      ...attempt.head,
      headId: attempt.head.headId.toLowerCase(),
      expectedOutpoint: {
        txid: attempt.head.expectedOutpoint.txid.toLowerCase(),
        index: attempt.head.expectedOutpoint.index,
      },
      successor: {
        ...attempt.head.successor,
        outpoint: {
          txid: attempt.head.successor.outpoint.txid.toLowerCase(),
          index: attempt.head.successor.outpoint.index,
        },
        scriptPublicKey: attempt.head.successor.scriptPublicKey.toLowerCase(),
      },
    };
  }
  return attempt;
}

export function exactHeadMatchesSelection(
  head: ExactHeadRecord,
  request: ExactHeadSelectionRequest,
): boolean {
  return (
    head.status === "available" &&
    head.network === request.network &&
    head.payTo === request.payTo &&
    head.scriptPublicKey.toLowerCase() ===
      request.payToScriptPublicKey.toLowerCase() &&
    parseSompiString(head.additiveThresholdSompi) >=
      parseSompiString(request.minimumAdditiveThresholdSompi) &&
    parseSompiString(request.amount) >=
      parseSompiString(head.additiveThresholdSompi)
  );
}

export function exactSettlementAttemptsMatch(
  current: ExactSettlementAttemptRecord,
  expected: ExactSettlementAttemptRecord,
): boolean {
  return (
    stableJson(exactAttemptTerms(current)) ===
    stableJson(exactAttemptTerms(expected))
  );
}

export function claimExactHead(
  head: ExactHeadRecord,
  attempt: ExactSettlementAttemptRecord,
): ExactHeadRecord {
  const claim = attempt.head;
  if (
    !claim ||
    head.status !== "available" ||
    head.headId !== claim.headId ||
    head.version !== claim.expectedVersion ||
    !sameOutpoint(head.currentOutpoint, claim.expectedOutpoint) ||
    head.currentAmount !== claim.expectedAmount ||
    head.scriptPublicKey.toLowerCase() !==
      claim.successor.scriptPublicKey.toLowerCase()
  ) {
    throw new Error("exact head changed before settlement claim");
  }
  return {
    ...head,
    status: "claimed",
    claimTransactionId: attempt.transactionId,
    updatedAt: attempt.updatedAt,
  };
}

export function acceptExactHead(
  head: ExactHeadRecord,
  attempt: ExactSettlementAttemptRecord,
  observedAt: string,
): ExactHeadRecord {
  const claim = attempt.head;
  if (!claim)
    throw new Error("additive exact settlement is missing its head claim");
  const alreadyAdvanced =
    head.lastTransactionId?.toLowerCase() === attempt.transactionId &&
    sameOutpoint(head.currentOutpoint, claim.successor.outpoint) &&
    head.currentAmount === claim.successor.amount;
  if (alreadyAdvanced) return head;
  if (
    head.status !== "claimed" ||
    head.claimTransactionId?.toLowerCase() !== attempt.transactionId ||
    head.version !== claim.expectedVersion ||
    !sameOutpoint(head.currentOutpoint, claim.expectedOutpoint) ||
    head.currentAmount !== claim.expectedAmount ||
    head.scriptPublicKey.toLowerCase() !==
      claim.successor.scriptPublicKey.toLowerCase()
  ) {
    throw new Error("exact head changed before settlement acceptance");
  }
  return {
    ...head,
    currentOutpoint: structuredClone(claim.successor.outpoint),
    currentAmount: claim.successor.amount,
    version: (parseSompiString(head.version) + 1n).toString(),
    status: "available",
    updatedAt: observedAt,
    lastTransactionId: attempt.transactionId,
    claimTransactionId: undefined,
    unavailableReason: undefined,
  };
}

export function releaseExactHeadClaim(
  head: ExactHeadRecord,
  attempt: ExactSettlementAttemptRecord,
  observedAt: string,
): ExactHeadRecord {
  if (head.claimTransactionId?.toLowerCase() !== attempt.transactionId)
    return head;
  return {
    ...head,
    status: "available",
    claimTransactionId: undefined,
    updatedAt: observedAt,
    unavailableReason: undefined,
  };
}

export function applyExactHeadLineage(
  head: ExactHeadRecord,
  input: ExactHeadLineageApply,
): ExactHeadRecord {
  if (
    head.headId !== input.headId.toLowerCase() ||
    head.version !== input.expectedVersion ||
    !sameOutpoint(head.currentOutpoint, input.expectedOutpoint) ||
    head.currentAmount !== input.expectedAmount ||
    head.status === "claimed" ||
    head.status === "retired"
  ) {
    throw new Error("exact head changed before lineage reconciliation");
  }
  if (
    input.steps.length === 0 ||
    input.steps.length > MAX_EXTERNAL_LINEAGE_STEPS
  ) {
    throw new Error("exact head lineage must contain between 1 and 64 steps");
  }
  if (Number.isNaN(Date.parse(input.observedAt))) {
    throw new Error(
      "exact head lineage observation time must be an ISO date string",
    );
  }

  const threshold = parseSompiString(head.additiveThresholdSompi);
  let currentOutpoint = structuredClone(head.currentOutpoint);
  let currentAmount = parseSompiString(head.currentAmount);
  let lastTransactionId: string | undefined;
  for (const step of input.steps) {
    if (step.finality !== "accepted" && step.finality !== "confirmed") {
      throw new Error("exact head lineage finality is invalid");
    }
    if (!/^[0-9a-fA-F]{64}$/.test(step.transactionId)) {
      throw new Error("exact head lineage transaction id must be 32-byte hex");
    }
    if (
      !sameOutpoint(step.spentOutpoint, currentOutpoint) ||
      step.successor.outpoint.txid.toLowerCase() !==
        step.transactionId.toLowerCase() ||
      step.successor.outpoint.index !== currentOutpoint.index ||
      step.successor.scriptPublicKey.toLowerCase() !==
        head.scriptPublicKey.toLowerCase()
    ) {
      throw new Error(
        "exact head lineage does not prove the same-index successor",
      );
    }
    const successorAmount = parseSompiString(step.successor.amount);
    if (successorAmount < currentAmount + threshold) {
      throw new Error(
        "exact head lineage successor is below the KIP-10 threshold",
      );
    }
    currentOutpoint = {
      txid: step.successor.outpoint.txid.toLowerCase(),
      index: step.successor.outpoint.index,
    };
    currentAmount = successorAmount;
    lastTransactionId = step.transactionId.toLowerCase();
  }

  return normalizeExactHeadRecord({
    ...head,
    currentOutpoint,
    currentAmount: currentAmount.toString(),
    version: (
      parseSompiString(head.version) + BigInt(input.steps.length)
    ).toString(),
    status: "available",
    updatedAt: input.observedAt,
    lastTransactionId: lastTransactionId!,
    claimTransactionId: undefined,
    unavailableReason: undefined,
  });
}

function exactAttemptTerms(
  record: ExactSettlementAttemptRecord,
): Omit<
  ExactSettlementAttemptRecord,
  | "status"
  | "createdAt"
  | "updatedAt"
  | "finality"
  | "handlerStartedAt"
  | "handlerResult"
  | "handlerCompletedAt"
  | "recoveryReason"
> {
  const {
    status: _status,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    finality: _finality,
    handlerStartedAt: _handlerStartedAt,
    handlerResult: _handlerResult,
    handlerCompletedAt: _handlerCompletedAt,
    recoveryReason: _recoveryReason,
    ...terms
  } = record;
  return terms;
}

function sameOutpoint(
  left: { txid: string; index: number },
  right: { txid: string; index: number },
): boolean {
  return (
    left.txid.toLowerCase() === right.txid.toLowerCase() &&
    left.index === right.index
  );
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}
