import {
  batchLaneAccounting,
  parseBatchLaneAmount,
  type Hash32Hex,
} from "@kaspa-x402/core";
import type {
  BatchSettlementAttemptRecord,
  ProtectedHandlerResult,
  ServerChannelRecord,
  SettlementCommit,
} from "./types.js";
import {
  assertServerChannelLineageConsistency,
  assertServerCovenantJournalExtension,
  sameCovenantLineage,
} from "./channel-lineage.js";

export function normalizeBatchSettlementAttempt(
  input: BatchSettlementAttemptRecord,
): BatchSettlementAttemptRecord {
  if (input.status !== "pending")
    throw new Error("new batch settlement attempt must be pending");
  if (
    !isLowerHash32(input.attemptId) ||
    !isLowerHash32(input.channelId) ||
    !isNonzeroLowerHash32(input.covenantId)
  ) {
    throw new Error("batch settlement identifiers must be canonical lowercase");
  }
  if (
    input.operationKind !== "payment" &&
    input.operationKind !== "deposit" &&
    input.operationKind !== "top-up"
  )
    throw new Error("batch settlement operation kind is invalid");
  if (
    typeof input.payerId !== "string" ||
    input.payerId.length === 0 ||
    input.payerId.length > 256
  )
    throw new Error("batch settlement payer identity is invalid");
  if (input.channelTransition) {
    if (input.operationKind === "payment")
      throw new Error("ordinary payment cannot install a channel transition");
    if (
      input.channelTransition.next.channelId !== input.channelId ||
      input.channelTransition.next.covenantId !== input.covenantId ||
      stableJson(input.channelTransition.next) !== stableJson(input.expected)
    )
      throw new Error("batch channel transition is inconsistent");
  } else if (input.operationKind !== "payment") {
    throw new Error("deposit and top-up attempts require an atomic channel transition");
  }
  if (
    input.paymentIdentifier &&
    input.paymentIdentifier.ownerId !== input.attemptId
  )
    throw new Error("batch payment identifier owner does not match its attempt");
  if (
    input.channelId !== input.expected.channelId ||
    input.covenantId !== input.expected.covenantId
  ) {
    throw new Error("batch settlement attempt identity is inconsistent");
  }
  for (const [value, label] of [
    [input.requestFingerprint, "request fingerprint"],
    [input.paymentRequirementsHash, "payment requirements hash"],
    [input.paymentPayloadHash, "payment payload hash"],
    [input.expected.activeOutpoint.txid, "active outpoint transaction id"],
  ] as const) {
    if (!isLowerHash32(value))
      throw new Error(`${label} must be canonical lowercase hash hex`);
  }
  parseBatchLaneAmount(input.maximumCharge, "maximum batch charge");
  batchLaneAccounting({
    chargedCumulativeAmount: input.expected.chargedCumulativeAmount,
    claimedCumulativeAmount: input.expected.claimedCumulativeAmount,
    signedMaxClaimable: input.expected.signedMaxClaimable,
    fundingAmount: input.expected.fundingAmount,
  });
  assertIsoDate(input.createdAt, "batch settlement creation time");
  assertIsoDate(input.updatedAt, "batch settlement update time");
  return structuredClone(input);
}

export function batchSettlementAttemptsMatch(
  left: BatchSettlementAttemptRecord,
  right: BatchSettlementAttemptRecord,
): boolean {
  return (
    left.attemptId === right.attemptId &&
    left.channelId === right.channelId &&
    left.covenantId === right.covenantId &&
    left.requestFingerprint === right.requestFingerprint &&
    left.paymentRequirementsHash === right.paymentRequirementsHash &&
    left.paymentPayloadHash === right.paymentPayloadHash &&
    left.maximumCharge === right.maximumCharge &&
    left.operationKind === right.operationKind &&
    left.payerId === right.payerId &&
    stableJson(left.paymentIdentifier) === stableJson(right.paymentIdentifier) &&
    stableJson(left.channelTransition) === stableJson(right.channelTransition) &&
    stableJson(left.expected) === stableJson(right.expected)
  );
}

export function assertBatchDepositTransition(
  previous: ServerChannelRecord | null,
  next: ServerChannelRecord,
  kind: BatchSettlementAttemptRecord["operationKind"],
): void {
  batchLaneAccounting(next);
  if (!previous) {
    assertServerChannelLineageConsistency(next);
    if (kind !== "deposit")
      throw new Error("new channel requires a deposit operation");
    if (next.version !== "0")
      throw new Error("new channel must begin at version zero");
    if (next.status !== "active")
      throw new Error("new channel must begin active");
    return;
  }
  assertImmutableChannelIdentity(previous, next);
  if (previous.status !== "active" || next.status !== "active")
    throw new Error("deposit transition requires an active channel");
  if (
    next.chargedCumulativeAmount !== previous.chargedCumulativeAmount ||
    next.claimedCumulativeAmount !== previous.claimedCumulativeAmount ||
    next.lastCommitmentId !== previous.lastCommitmentId ||
    next.version !== incrementVersion(previous.version) ||
    parseBatchLaneAmount(next.signedMaxClaimable, "next signed ceiling") <
      parseBatchLaneAmount(
        previous.signedMaxClaimable,
        "previous signed ceiling",
      ) ||
    parseBatchLaneAmount(next.fundingAmount, "next funding amount") <
      parseBatchLaneAmount(previous.fundingAmount, "previous funding amount")
  ) {
    throw new Error("deposit transition would roll back monotonic channel state");
  }
  const outpointChanged = !sameOutpoint(
    previous.activeOutpoint,
    next.activeOutpoint,
  );
  if (outpointChanged && kind !== "top-up")
    throw new Error("only a verified top-up may replace the active outpoint");
  if (!outpointChanged && kind === "top-up")
    throw new Error("top-up must replace the active outpoint");
  if (
    !outpointChanged &&
    (next.fundingAmount !== previous.fundingAmount ||
      next.activeScriptPublicKey.toLowerCase() !==
        previous.activeScriptPublicKey.toLowerCase() ||
      next.escrowAddress !== previous.escrowAddress)
  ) {
    throw new Error("same-outpoint deposit state is inconsistent");
  }
  if (!outpointChanged && !sameCovenantLineage(previous.lineage, next.lineage)) {
    throw new Error("same-outpoint deposit cannot replace covenant lineage");
  }
  assertServerCovenantJournalExtension(previous, next);
  if (
    outpointChanged &&
    parseBatchLaneAmount(next.fundingAmount, "top-up funding amount") <=
      parseBatchLaneAmount(previous.fundingAmount, "previous funding amount")
  ) {
    throw new Error("top-up funding must increase");
  }
}

export function batchSettlementAttemptIsReadyToCommit(
  attempt: BatchSettlementAttemptRecord | undefined,
  record: SettlementCommit,
): attempt is BatchSettlementAttemptRecord {
  return Boolean(
    attempt &&
    attempt.status === "pending" &&
    attempt.handlerStartedAt &&
    attempt.handlerResult &&
    attempt.channelId === record.channel.channelId &&
    attempt.covenantId === record.channel.covenantId &&
    attempt.requestFingerprint === record.commitment.requestFingerprint &&
    attempt.paymentRequirementsHash ===
      record.commitment.paymentRequirementsHash &&
    attempt.paymentPayloadHash === record.commitment.paymentPayloadHash &&
    (attempt.handlerResult.chargedAmount ?? attempt.maximumCharge) ===
      record.commitment.chargedAmount &&
    stableJson(attempt.expected) === stableJson(record.expected),
  );
}

export function assertBatchHandlerResultTransition(
  attempt: BatchSettlementAttemptRecord,
  result: ProtectedHandlerResult,
  completedAt: string,
): void {
  if (attempt.status !== "pending" || !attempt.handlerStartedAt)
    throw new Error("batch handler has not started on a pending settlement");
  assertDurableHandlerResult(result, completedAt);
  if (
    result.chargedAmount !== undefined &&
    parseBatchLaneAmount(result.chargedAmount, "batch handler charge") !==
      parseBatchLaneAmount(attempt.maximumCharge, "accepted batch charge")
  ) {
    throw new Error("batch handler charge must equal the accepted fixed charge");
  }
  if (
    attempt.handlerResult &&
    stableJson(attempt.handlerResult) !== stableJson(result)
  ) {
    throw new Error("batch handler result conflicts with durable state");
  }
}

function assertDurableHandlerResult(
  result: ProtectedHandlerResult,
  completedAt: string,
): void {
  assertIsoDate(completedAt, "batch handler completion time");
  if (
    result.status !== undefined &&
    (!Number.isInteger(result.status) ||
      result.status < 100 ||
      result.status > 599)
  ) {
    throw new Error("batch handler status is invalid");
  }
  if (
    result.headers &&
    Object.values(result.headers).some((value) => typeof value !== "string")
  ) {
    throw new Error("batch handler headers are invalid");
  }
  if (result.headers && Object.keys(result.headers).length > 64)
    throw new Error("batch handler has too many response headers");
  let serialized: string;
  try {
    serialized = JSON.stringify(result);
  } catch {
    throw new Error("batch handler result must be JSON serializable");
  }
  if (new TextEncoder().encode(serialized).byteLength > 256 * 1024)
    throw new Error("batch handler result exceeds the durable size limit");
}

function assertIsoDate(value: string, label: string): void {
  if (Number.isNaN(Date.parse(value)))
    throw new Error(`${label} must be an ISO date string`);
}

function isLowerHash32(value: string): value is Hash32Hex {
  return /^[0-9a-f]{64}$/.test(value);
}

function isNonzeroLowerHash32(value: string): value is Hash32Hex {
  return isLowerHash32(value) && !/^0{64}$/.test(value);
}

function assertImmutableChannelIdentity(
  previous: ServerChannelRecord,
  next: ServerChannelRecord,
): void {
  if (
    previous.channelId !== next.channelId ||
    previous.covenantId.toLowerCase() !== next.covenantId.toLowerCase() ||
    stableJson(previous.genesisEvidence) !== stableJson(next.genesisEvidence) ||
    stableJson(previous.channelConfig) !== stableJson(next.channelConfig)
  ) {
    throw new Error("channel immutable identity cannot change");
  }
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

function incrementVersion(version: string): string {
  return (parseBatchLaneAmount(version, "channel version") + 1n).toString();
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
