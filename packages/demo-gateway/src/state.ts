import {
  applyBatchClaimAccounting,
  batchLaneAccounting,
  parseBatchLaneAmount,
  parseSompiString,
  sha256Hex,
  type ChainCheckpoint,
} from "@kaspa-x402/core";
import type {
  BatchCommitmentRecord,
  BatchSettlementAttemptRecord,
  BatchSettlementClaimResult,
  ChannelOperationLeaseClaimResult,
  ChannelOperationLeaseRecord,
  ChannelLockManager,
  ClaimAttemptRecord,
  ExactPaymentRecord,
  ExactSettlementCommit,
  ExactHeadRecord,
  ExactHeadLineageApply,
  ExactHeadUnavailableApply,
  ExactHeadUnavailableResult,
  ExactHeadSelectionRequest,
  ExactSettlementAttemptRecord,
  ExactSettlementClaimResult,
  PaymentIdentifierRecord,
  PaymentIdentifierReservationClaim,
  PaymentIdentifierReservationRecord,
  ProtectedHandlerResult,
  ServerChannelRecord,
  ServerStateStore,
  SettlementCommit,
} from "@kaspa-x402/server";
import type { PnnEvidenceRecord, PnnEvidenceStore } from "@kaspa-x402/adapters";
import {
  durableByteLength,
  durableOpenRecordBytes,
  exactTransitionScope,
  prepareExactTransition,
  assertPaymentIdentifierAvailable,
  assertPaymentIdentifierCompletion,
  transitionPaymentIdentifierReservation,
  type PaymentIdentifierReservationTransition,
  type ExactTransitionCommand,
  type ExactTransitionResult,
  type ExactTransitionSnapshot,
  assertServerChannelLineageConsistency,
  assertServerCovenantLineageExtension,
  assertServerCovenantJournalExtension,
  sameCovenantLineage,
  assertBatchDepositTransition,
  assertBatchHandlerResultTransition,
  batchSettlementAttemptIsReadyToCommit,
  batchSettlementAttemptsMatch,
  claimAttemptsMatch,
  exactHeadMatchesSelection,
  normalizeBatchSettlementAttempt,
  normalizeClaimAttempt,
} from "@kaspa-x402/server";

type GatewayTransaction = {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean | void>;
  list<T = unknown>(options: {
    prefix?: string;
    start?: string;
    end?: string;
    limit?: number;
  }): Promise<Map<string, T>>;
};

export type GatewayStorage = GatewayTransaction & {
  transaction<T>(closure: (txn: GatewayTransaction) => Promise<T>): Promise<T>;
};

type LockRecord = {
  token: string;
  expiresAt: number;
};

type RateWindowRecord = {
  resetAt: number;
  counts: Record<string, number>;
};

type PublicAdmissionRecord = {
  expiresAt: number;
  callerKey: string;
};

type PublicAdmissionState = {
  leases: Record<string, PublicAdmissionRecord>;
};

export interface GatewayPublicAdmissionResult {
  allowed: boolean;
  active: number;
  retryAt?: number;
  reason?: "caller_concurrency_exceeded" | "global_concurrency_exceeded";
}

export interface GatewayDurableStateLimits {
  maxRecords: number;
  maxBytes: number;
  maxRecordsPerPayer: number;
  maxExactHeads: number;
  terminalRetentionMs: number;
}

export interface GatewayLedgerOptions {
  limits?: Partial<GatewayDurableStateLimits>;
  now?: () => number;
}

type DurableBudgetMeta = {
  records: number;
  bytes: number;
  payerCounts: Record<string, number>;
};

type DurableBudgetRecord = {
  key: string;
  kind: "batch" | "exact";
  attemptId: string;
  payerId: string;
  bytes: number;
  terminalAt?: number;
  compactedAt?: number;
  commitmentId?: string;
  paymentIdentifier?: string;
  safelyReleased?: boolean;
};

type PnnEvidenceBudget = {
  records: number;
  bytes: number;
  reservedBytes: number;
};

const MAX_RATE_SCOPES_PER_WINDOW = 1_024;
const MAX_PUBLIC_ADMISSION_LEASES = 256;
const MAX_PUBLIC_ADMISSION_TTL_MS = 10 * 60 * 1_000;
const MAX_PNN_EVIDENCE_RECORD_BYTES = 64 * 1024;
const MAX_PNN_EVIDENCE_RECORDS = 4_096;
const MAX_PNN_EVIDENCE_TOTAL_BYTES = 64 * 1024 * 1024;
export const GATEWAY_COORDINATION_DOMAIN = "demo-gateway-state:v1.0.0-rc.2";
const DEFAULT_DURABLE_STATE_LIMITS: GatewayDurableStateLimits = {
  maxRecords: 10_000,
  maxBytes: 512 * 1024 * 1024,
  maxRecordsPerPayer: 1_000,
  maxExactHeads: 256,
  terminalRetentionMs: 24 * 60 * 60 * 1_000,
};

export type GatewayCanaryCheckStatus = "ok" | "failed" | "skipped";

export type ExactHeadStats = Record<
  "total" | "available" | "claimed" | "unavailable" | "retired",
  number
>;

export interface GatewayCanaryCheck {
  name: string;
  status: GatewayCanaryCheckStatus;
  detail: string;
  evidence?: Record<string, unknown>;
}

export interface GatewayCanaryReport {
  checkedAt: string;
  trigger: "scheduled" | "manual";
  ok: boolean;
  checks: GatewayCanaryCheck[];
}

export type GatewayStateMethod =
  | "loadChannel"
  | "registerChannel"
  | "retireChannel"
  | "applyCovenantLineage"
  | "listChannels"
  | "claimChannelOperation"
  | "loadChannelOperation"
  | "abandonChannelOperation"
  | "loadCommitment"
  | "claimBatchSettlement"
  | "loadBatchSettlementAttempt"
  | "beginBatchHandler"
  | "recordBatchHandlerResult"
  | "markBatchHandlerRecoveryRequired"
  | "abandonBatchSettlement"
  | "loadPaymentIdentifier"
  | "loadPaymentIdentifierReservation"
  | "loadExactPayment"
  | "registerExactHead"
  | "loadExactHead"
  | "listExactHeads"
  | "exactHeadStats"
  | "selectExactHead"
  | "claimExactSettlement"
  | "claimExactSettlementWithEvidence"
  | "loadExactSettlementAttempt"
  | "recordExactSettlementBroadcast"
  | "acceptExactSettlement"
  | "beginExactHandler"
  | "recordExactHandlerResult"
  | "markExactHandlerRecoveryRequired"
  | "abandonExactSettlement"
  | "markExactHeadUnavailable"
  | "applyExactHeadLineage"
  | "resolveBatchRefundTimeoutDaa"
  | "loadRecentPnnDaaScore"
  | "recordExactHeadOfferObservation"
  | "hasRecentExactHeadOfferObservation"
  | "commitSettlement"
  | "commitExactPayment"
  | "loadOpenClaimAttempt"
  | "saveClaimAttempt"
  | "applyClaimAttempt"
  | "abandonClaimAttempt"
  | "acquireLock"
  | "releaseLock"
  | "checkRateLimit"
  | "loadCanaryReport"
  | "saveCanaryReport"
  | "incrementMetric"
  | "metrics"
  | "loadPnnEvidence"
  | "savePnnEvidence"
  | "recordPnnCheckpoint"
  | "findPnnCheckpointBefore";

export interface GatewayStateRequest {
  method: GatewayStateMethod;
  payload?: unknown;
}

export class GatewayLedger implements ServerStateStore, PnnEvidenceStore {
  readonly coordinationScope = "deployment-wide" as const;
  readonly coordinationDomain = GATEWAY_COORDINATION_DOMAIN;
  readonly #storage: GatewayStorage;
  readonly #limits: GatewayDurableStateLimits;
  readonly #now: () => number;

  constructor(storage: GatewayStorage, options: GatewayLedgerOptions = {}) {
    this.#storage = storage;
    this.#limits = { ...DEFAULT_DURABLE_STATE_LIMITS, ...options.limits };
    this.#now = options.now ?? Date.now;
    assertDurableStateLimits(this.#limits);
  }

  async loadPnnEvidence(transactionId: string): Promise<PnnEvidenceRecord | undefined> {
    assertPnnTransactionId(transactionId);
    return cloneOrUndefined(await this.#storage.get<PnnEvidenceRecord>(`pnn-evidence:${transactionId}`));
  }

  async recordPnnCheckpoint(checkpoint: ChainCheckpoint): Promise<void> {
    assertPnnTransactionId(checkpoint.blockHash);
    const bucket = BigInt(checkpoint.daaScore) / 300n;
    await this.#storage.transaction(async txn => {
      const quote = await txn.get<{ daaScore: string; observedAt: number }>("pnn-quote-observation");
      if (!quote || BigInt(checkpoint.daaScore) >= BigInt(quote.daaScore)) {
        await txn.put("pnn-quote-observation", { daaScore: checkpoint.daaScore, observedAt: Date.now() });
      }
      const checkpoints = await txn.get<ChainCheckpoint[]>("pnn-discovery-checkpoints") ?? [];
      // Keep the earliest observation in each roughly 30-second DAA bucket.
      // A bounded ring covers quote delivery and delayed deposit retries.
      const index = checkpoints.findIndex(item => BigInt(item.daaScore) / 300n === bucket);
      if (index >= 0) {
        if (BigInt(checkpoints[index]!.daaScore) <= BigInt(checkpoint.daaScore)) return;
        checkpoints[index] = checkpoint;
      } else checkpoints.push(checkpoint);
      checkpoints.sort((a, b) => BigInt(a.daaScore) < BigInt(b.daaScore) ? -1 : 1);
      await txn.put("pnn-discovery-checkpoints", checkpoints.slice(-128));
    });
  }

  async loadRecentPnnDaaScore(
    nowMs: number,
    maxAgeMs = 30 * 60_000,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0 || maxAgeMs > 30 * 60_000)
      throw new Error("cached PNN DAA maximum age is invalid");
    const quote = await this.#storage.get<{ daaScore: string; observedAt: number }>("pnn-quote-observation");
    signal?.throwIfAborted();
    if (!quote || !Number.isSafeInteger(quote.observedAt) ||
        quote.observedAt > nowMs || nowMs - quote.observedAt > maxAgeMs)
      return undefined;
    return parseSompiString(quote.daaScore).toString();
  }

  async findPnnCheckpointBefore(daaScore: string): Promise<ChainCheckpoint | undefined> {
    const checkpoints = await this.#storage.get<ChainCheckpoint[]>("pnn-discovery-checkpoints") ?? [];
    return cloneOrUndefined(checkpoints.reverse().find(item => BigInt(item.daaScore) < BigInt(daaScore)));
  }

  async savePnnEvidence(record: PnnEvidenceRecord, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await this.#storage.transaction(async txn => {
      signal?.throwIfAborted();
      const owner = await txn.get<ExactSettlementAttemptRecord>(exactAttemptKey(record.transactionId));
      if (!owner) throw new Error("PNN evidence has no durable exact settlement owner");
      if (!await txn.get<PnnEvidenceRecord>(`pnn-evidence:${record.transactionId}`))
        throw new Error("PNN evidence has no atomic settlement claim");
      await this.#putPnnEvidence(txn, record, false);
      signal?.throwIfAborted();
    });
  }

  async #putPnnEvidence(
    txn: GatewayTransaction,
    record: PnnEvidenceRecord,
    reserveForClaim: boolean,
  ): Promise<void> {
    assertPnnTransactionId(record.transactionId);
    const bytes = durableByteLength(record);
    if (bytes > MAX_PNN_EVIDENCE_RECORD_BYTES)
      throw new Error("PNN evidence exceeds the record byte limit");
    const key = `pnn-evidence:${record.transactionId}`;
    const reservationKey = `pnn-evidence-reservation:${record.transactionId}`;
    const current = await txn.get<PnnEvidenceRecord>(key);
    if (current?.origins && JSON.stringify(current.origins) !== JSON.stringify(record.origins))
      throw new Error("PNN receipt conflicts with its durable funding snapshot");
    const currentReservation = await txn.get<number>(reservationKey);
    if (currentReservation !== undefined &&
        (!Number.isSafeInteger(currentReservation) || currentReservation < 0 ||
         currentReservation > MAX_PNN_EVIDENCE_RECORD_BYTES))
      throw new Error("PNN evidence reservation is invalid");
    const budget = await txn.get<PnnEvidenceBudget>("pnn-evidence:budget") ??
      { records: 0, bytes: 0, reservedBytes: 0 };
    assertPnnEvidenceBudget(budget);
    // An open claim holds the full record limit so accepted readback can grow
    // without exhausting aggregate capacity after the payment has been claimed.
    const nextReservation = reserveForClaim || currentReservation !== undefined
      ? MAX_PNN_EVIDENCE_RECORD_BYTES - bytes : 0;
    const next = {
      records: budget.records + (current ? 0 : 1),
      bytes: budget.bytes - (current ? durableByteLength(current) : 0) + bytes,
      reservedBytes: budget.reservedBytes - (currentReservation ?? 0) + nextReservation,
    };
    if (next.records > MAX_PNN_EVIDENCE_RECORDS ||
        next.bytes + next.reservedBytes > MAX_PNN_EVIDENCE_TOTAL_BYTES)
      throw new Error("PNN evidence capacity exhausted");
    assertPnnEvidenceBudget(next);
    await txn.put(key, clone(record));
    if (reserveForClaim || currentReservation !== undefined)
      await txn.put(reservationKey, nextReservation);
    await txn.put("pnn-evidence:budget", next);
  }

  async #finishPnnEvidenceClaim(
    txn: GatewayTransaction,
    transactionId: string,
    abandoned: boolean,
  ): Promise<void> {
    const reservationKey = `pnn-evidence-reservation:${transactionId}`;
    const reservedBytes = await txn.get<number>(reservationKey);
    if (reservedBytes === undefined) return;
    if (!Number.isSafeInteger(reservedBytes) || reservedBytes < 0 ||
        reservedBytes > MAX_PNN_EVIDENCE_RECORD_BYTES)
      throw new Error("PNN evidence reservation is invalid");
    const key = `pnn-evidence:${transactionId}`;
    const record = await txn.get<PnnEvidenceRecord>(key);
    if (!record) throw new Error("claimed PNN evidence is missing");
    const budget = await txn.get<PnnEvidenceBudget>("pnn-evidence:budget");
    if (!budget) throw new Error("PNN evidence budget is missing");
    assertPnnEvidenceBudget(budget);
    const next = {
      records: budget.records - (abandoned ? 1 : 0),
      bytes: budget.bytes - (abandoned ? durableByteLength(record) : 0),
      reservedBytes: budget.reservedBytes - reservedBytes,
    };
    assertPnnEvidenceBudget(next);
    await txn.put("pnn-evidence:budget", next);
    await txn.delete(reservationKey);
    if (abandoned) await txn.delete(key);
  }

  async loadChannel(
    channelId: string,
  ): Promise<ServerChannelRecord | undefined> {
    return cloneOrUndefined(
      await this.#storage.get<ServerChannelRecord>(channelKey(channelId)),
    );
  }

  async registerChannel(channel: ServerChannelRecord): Promise<void> {
    await this.#storage.transaction(async (txn) => {
      const existing = await txn.get<ServerChannelRecord>(
        channelKey(channel.channelId),
      );
      if (existing) {
        if (stableJson(existing) !== stableJson(channel))
          throw new Error("existing channel state cannot be replaced");
        return;
      }
      await putChannel(txn, channel);
    });
  }

  async retireChannel(
    channelId: string,
    leaseId: string,
    expected: ServerChannelRecord,
  ): Promise<void> {
    await this.#storage.transaction(async (txn) => {
      const channel = await txn.get<ServerChannelRecord>(channelKey(channelId));
      if (!channel) return;
      const lease = await requireChannelOperation(txn, channelId, leaseId);
      if (
        lease.kind !== "retirement" ||
        !sameChannelSnapshot(channel, expected) ||
        !sameChannelSnapshot(channel, lease.expected)
      )
        throw new Error("channel state changed before retirement");
      if (
        channel.status === "refunded" ||
        channel.lineage.currentHead === null
      ) {
        throw new Error("terminal refunded channel cannot be retired");
      }
      const retired = {
        ...clone(channel),
        version: incrementVersion(channel.version),
        status: "retired" as const,
      };
      assertServerChannelLineageConsistency(retired);
      await txn.put(channelKey(channelId), retired);
      await deleteChannelOperation(txn, lease);
    });
  }

  async claimChannelOperation(
    input: ChannelOperationLeaseRecord,
  ): Promise<ChannelOperationLeaseClaimResult> {
    const lease = normalizeChannelOperationLease(input);
    return this.#storage.transaction(async (txn) => {
      const existing = await txn.get<ChannelOperationLeaseRecord>(
        channelOperationKey(lease.channelId),
      );
      if (existing) {
        if (!channelOperationLeasesMatch(existing, lease))
          throw new Error(
            "channel already has a conflicting durable operation",
          );
        return { lease: clone(existing), created: false };
      }
      const current = await txn.get<ServerChannelRecord>(
        channelKey(lease.channelId),
      );
      if (!sameChannelSnapshot(current, lease.expected))
        throw new Error("channel state changed before operation claim");
      await putChannelOperation(txn, lease);
      return { lease: clone(lease), created: true };
    });
  }

  async loadChannelOperation(
    channelId: string,
  ): Promise<ChannelOperationLeaseRecord | undefined> {
    return cloneOrUndefined(
      await this.#storage.get<ChannelOperationLeaseRecord>(
        channelOperationKey(channelId),
      ),
    );
  }

  async abandonChannelOperation(
    leaseId: string,
    _reason: string,
    observedAt: string,
  ): Promise<void> {
    assertIsoDate(observedAt, "channel operation abandonment time");
    await this.#storage.transaction(async (txn) => {
      const channelId = await txn.get<string>(
        channelOperationLeaseKey(leaseId),
      );
      if (!channelId) return;
      const lease = await requireChannelOperation(txn, channelId, leaseId);
      if (lease.status !== "reserved")
        throw new Error("uncertain channel operation cannot be abandoned");
      if (
        (await txn.get(openBatchAttemptKey(channelId))) ||
        (await txn.get(openClaimKey(channelId)))
      )
        throw new Error(
          "attempt-owned channel operation must use its safe abandon path",
        );
      await deleteChannelOperation(txn, lease);
    });
  }

  async listChannels(): Promise<ServerChannelRecord[]> {
    return Array.from(
      (
        await this.#storage.list<ServerChannelRecord>({ prefix: "channel:" })
      ).values(),
    ).map(clone);
  }

  async applyCovenantLineage(
    expected: ServerChannelRecord,
    channel: ServerChannelRecord,
    leaseId: string,
  ): Promise<void> {
    await this.#storage.transaction(async (txn) => {
      const current = await txn.get<ServerChannelRecord>(
        channelKey(expected.channelId),
      );
      if (!sameChannelSnapshot(current, expected)) {
        throw new Error("channel state changed before covenant lineage apply");
      }
      const lease = await requireChannelOperation(
        txn,
        expected.channelId,
        leaseId,
      );
      if (
        (lease.kind !== "refund" && lease.kind !== "recovery") ||
        !sameChannelSnapshot(lease.expected, expected)
      )
        throw new Error(
          "covenant lineage apply does not own the channel snapshot",
        );
      if (
        (await txn.get(openBatchAttemptKey(expected.channelId))) ||
        (await txn.get(openClaimKey(expected.channelId)))
      )
        throw new Error(
          "channel has an open attempt during covenant lineage apply",
        );
      assertServerCovenantLineageExtension(expected, channel);
      await putChannel(txn, channel);
      await deleteChannelOperation(txn, lease);
    });
  }

  async loadCommitment(
    commitmentId: string,
  ): Promise<BatchCommitmentRecord | undefined> {
    return cloneOrUndefined(
      await this.#storage.get<BatchCommitmentRecord>(
        commitmentKey(commitmentId),
      ),
    );
  }

  async claimBatchSettlement(
    input: BatchSettlementAttemptRecord,
  ): Promise<BatchSettlementClaimResult> {
    const attempt = normalizeBatchSettlementAttempt(input);
    await this.#storage.transaction((txn) =>
      pruneTerminalDurableBudgets(txn, this.#limits, this.#now()),
    );
    return this.#storage.transaction(async (txn) => {
      const existing = await txn.get<BatchSettlementAttemptRecord>(
        batchAttemptKey(attempt.attemptId),
      );
      if (existing) {
        if (!batchSettlementAttemptsMatch(existing, attempt)) {
          throw new Error(
            "batch payment is already claimed for a different request",
          );
        }
        return { attempt: clone(existing), created: false };
      }
      const current = await txn.get<ServerChannelRecord>(
        channelKey(attempt.channelId),
      );
      const transition = attempt.channelTransition;
      if (transition) {
        if (!sameChannelSnapshot(current, transition.previous))
          throw new Error("channel state changed before deposit transition");
        if (!sameChannelSnapshot(transition.next, attempt.expected))
          throw new Error("deposit transition does not match attempt snapshot");
        assertBatchDepositTransition(
          transition.previous,
          transition.next,
          attempt.operationKind,
        );
      } else if (!sameChannelSnapshot(current, attempt.expected)) {
        throw new Error("channel state changed before batch settlement claim");
      }
      const openAttemptId = await txn.get<string>(
        openBatchAttemptKey(attempt.channelId),
      );
      if (openAttemptId) {
        const open = await txn.get<BatchSettlementAttemptRecord>(
          batchAttemptKey(openAttemptId),
        );
        if (open?.status === "pending") {
          throw new Error("channel already has a pending batch settlement");
        }
        await txn.delete(openBatchAttemptKey(attempt.channelId));
      }
      if (await txn.get(channelOperationKey(attempt.channelId)))
        throw new Error("channel already has a conflicting durable operation");
      await assertPaymentIdentifierClaimAvailable(
        txn,
        attempt.paymentIdentifier,
      );
      await reclaimSafelyReleasedPaymentIdentifier(
        txn,
        attempt.paymentIdentifier,
      );
      await admitDurableBudget(txn, this.#limits, this.#now(), {
        key: `batch:${attempt.attemptId}`,
        kind: "batch",
        attemptId: attempt.attemptId,
        payerId: attempt.payerId,
        bytes: durableOpenRecordBytes(attempt),
        ...(attempt.paymentIdentifier
          ? { paymentIdentifier: attempt.paymentIdentifier.id }
          : {}),
      });
      if (transition) await putChannel(txn, transition.next);
      await applyPaymentIdentifierTransition(txn, attempt.paymentIdentifier, {
        kind: "reserve",
        observedAt: attempt.createdAt,
      });
      await txn.put(batchAttemptKey(attempt.attemptId), clone(attempt));
      await txn.put(openBatchAttemptKey(attempt.channelId), attempt.attemptId);
      await putChannelOperation(txn, {
        leaseId: attempt.attemptId,
        channelId: attempt.channelId,
        covenantId: attempt.covenantId,
        kind: attempt.operationKind,
        expected: clone(attempt.expected),
        status: "reserved",
        createdAt: attempt.createdAt,
        updatedAt: attempt.updatedAt,
      });
      return { attempt: clone(attempt), created: true };
    });
  }

  async loadBatchSettlementAttempt(
    attemptId: string,
  ): Promise<BatchSettlementAttemptRecord | undefined> {
    return cloneOrUndefined(
      await this.#storage.get<BatchSettlementAttemptRecord>(
        batchAttemptKey(attemptId),
      ),
    );
  }

  async beginBatchHandler(
    attemptId: string,
    startedAt: string,
  ): Promise<boolean> {
    return this.#storage.transaction(async (txn) => {
      const attempt = await requireBatchAttempt(txn, attemptId);
      if (attempt.status !== "pending" || attempt.handlerStartedAt)
        return false;
      assertIsoDate(startedAt, "batch handler start time");
      await txn.put(batchAttemptKey(attempt.attemptId), {
        ...attempt,
        handlerStartedAt: startedAt,
        updatedAt: startedAt,
      });
      await updateChannelOperation(txn, attempt.channelId, attempt.attemptId, {
        status: "pending",
        updatedAt: startedAt,
      });
      await applyPaymentIdentifierTransition(txn, attempt.paymentIdentifier, {
        kind: "update",
        update: {
          status: "pending",
          updatedAt: startedAt,
        },
      });
      return true;
    });
  }

  async recordBatchHandlerResult(
    attemptId: string,
    result: ProtectedHandlerResult,
    completedAt: string,
  ): Promise<void> {
    await this.#storage.transaction(async (txn) => {
      const attempt = await requireBatchAttempt(txn, attemptId);
      assertBatchHandlerResultTransition(attempt, result, completedAt);
      if (attempt.handlerResult) return;
      await txn.put(batchAttemptKey(attempt.attemptId), {
        ...attempt,
        handlerResult: clone(result),
        handlerCompletedAt: completedAt,
        recoveryReason: undefined,
        updatedAt: completedAt,
      });
      await updateChannelOperation(txn, attempt.channelId, attempt.attemptId, {
        status: "pending",
        recoveryReason: undefined,
        updatedAt: completedAt,
      });
      await applyPaymentIdentifierTransition(txn, attempt.paymentIdentifier, {
        kind: "update",
        update: {
          status: "pending",
          recoveryReason: undefined,
          updatedAt: completedAt,
        },
      });
    });
  }

  async markBatchHandlerRecoveryRequired(
    attemptId: string,
    reason: string,
    observedAt: string,
  ): Promise<void> {
    await this.#storage.transaction(async (txn) => {
      const attempt = await requireBatchAttempt(txn, attemptId);
      if (
        attempt.status !== "pending" ||
        !attempt.handlerStartedAt ||
        attempt.handlerResult
      ) {
        throw new Error("batch handler is not awaiting recovery");
      }
      assertIsoDate(observedAt, "batch handler recovery time");
      await txn.put(batchAttemptKey(attempt.attemptId), {
        ...attempt,
        recoveryReason: reason,
        updatedAt: observedAt,
      });
      await updateChannelOperation(txn, attempt.channelId, attempt.attemptId, {
        status: "recovery-required",
        recoveryReason: reason,
        updatedAt: observedAt,
      });
      await applyPaymentIdentifierTransition(txn, attempt.paymentIdentifier, {
        kind: "update",
        update: {
          status: "recovery-required",
          recoveryReason: reason,
          updatedAt: observedAt,
        },
      });
    });
  }

  async abandonBatchSettlement(
    attemptId: string,
    reason: string,
    observedAt: string,
  ): Promise<void> {
    assertIsoDate(observedAt, "batch settlement abandonment time");
    await this.#storage.transaction(async (txn) => {
      const attempt = await requireBatchAttempt(txn, attemptId);
      if (
        attempt.status !== "pending" ||
        attempt.handlerStartedAt ||
        attempt.handlerResult ||
        attempt.recoveryReason
      )
        throw new Error(
          "uncertain or completed batch settlement cannot be abandoned",
        );
      const lease = await requireChannelOperation(
        txn,
        attempt.channelId,
        attempt.attemptId,
      );
      await txn.delete(batchAttemptKey(attempt.attemptId));
      await txn.delete(openBatchAttemptKey(attempt.channelId));
      await deleteChannelOperation(txn, lease);
      await applyPaymentIdentifierTransition(txn, attempt.paymentIdentifier, {
        kind: "release",
        reason: reason,
        observedAt: observedAt,
        allowPending: false,
      });
      if (attempt.paymentIdentifier) {
        await terminalizeDurableBudget(
          txn,
          `batch:${attempt.attemptId}`,
          durableByteLength({
            paymentIdentifierReservation: await txn.get(
              paymentIdentifierReservationKey(attempt.paymentIdentifier.id),
            ),
          }),
          this.#now(),
          undefined,
          attempt.paymentIdentifier.id,
          true,
        );
      } else {
        await deleteDurableBudget(txn, `batch:${attempt.attemptId}`);
      }
    });
  }

  async loadPaymentIdentifier(
    id: string,
  ): Promise<PaymentIdentifierRecord | undefined> {
    return cloneOrUndefined(
      await this.#storage.get<PaymentIdentifierRecord>(
        paymentIdentifierKey(id),
      ),
    );
  }

  async loadPaymentIdentifierReservation(
    id: string,
  ): Promise<PaymentIdentifierReservationRecord | undefined> {
    return cloneOrUndefined(
      await this.#storage.get<PaymentIdentifierReservationRecord>(
        paymentIdentifierReservationKey(id),
      ),
    );
  }

  async loadExactPayment(
    transactionId: string,
  ): Promise<ExactPaymentRecord | undefined> {
    return cloneOrUndefined(
      await this.#storage.get<ExactPaymentRecord>(
        exactPaymentKey(transactionId),
      ),
    );
  }

  async registerExactHead(input: ExactHeadRecord): Promise<ExactHeadRecord> {
    return this.#applyExactTransition({ kind: "register-head", args: [input] });
  }

  async loadExactHead(headId: string): Promise<ExactHeadRecord | undefined> {
    return cloneOrUndefined(
      await this.#storage.get<ExactHeadRecord>(exactHeadKey(headId)),
    );
  }

  async recordExactHeadOfferObservation(head: ExactHeadRecord): Promise<void> {
    await this.#storage.transaction(async (txn) => {
      const current = await txn.get<ExactHeadRecord>(exactHeadKey(head.headId));
      if (!current || current.status !== "available" || head.status !== "available" ||
          current.headId.toLowerCase() !== head.headId.toLowerCase() ||
          current.version !== head.version ||
          stableJson(current.currentOutpoint) !== stableJson(head.currentOutpoint) ||
          current.currentAmount !== head.currentAmount ||
          current.scriptPublicKey.toLowerCase() !== head.scriptPublicKey.toLowerCase() ||
          current.redeemScript.toLowerCase() !== head.redeemScript.toLowerCase() ||
          current.additiveThresholdSompi !== head.additiveThresholdSompi)
        throw new Error("verified exact head changed before offer observation");
      await txn.put(`exact-head-offer-observation:${head.headId.toLowerCase()}`, {
        snapshot: stableJson(current), observedAt: this.#now(),
      });
    });
  }

  async hasRecentExactHeadOfferObservation(headId: string, nowMs: number, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    return this.#storage.transaction(async (txn) => {
      const head = await txn.get<ExactHeadRecord>(exactHeadKey(headId));
      const observation = await txn.get<{ snapshot: string; observedAt: number }>(
        `exact-head-offer-observation:${headId.toLowerCase()}`,
      );
      signal?.throwIfAborted();
      return !!head && head.status === "available" && !!observation &&
        observation.snapshot === stableJson(head) &&
        Number.isSafeInteger(observation.observedAt) &&
        observation.observedAt <= nowMs && nowMs - observation.observedAt <= 30 * 60_000;
    });
  }

  async listExactHeads(): Promise<ExactHeadRecord[]> {
    return Array.from(
      (
        await this.#storage.list<ExactHeadRecord>({ prefix: "exact-head:" })
      ).values(),
    )
      .map(clone)
      .sort((left, right) => left.headId.localeCompare(right.headId));
  }

  async exactHeadStats(signal?: AbortSignal): Promise<ExactHeadStats> {
    signal?.throwIfAborted();
    return this.#storage.transaction(async (txn) => {
      const stats = await loadOrRebuildExactHeadStats(txn);
      signal?.throwIfAborted();
      await txn.put(exactHeadStatsKey(), stats);
      return clone(stats);
    });
  }

  async selectExactHead(
    request: ExactHeadSelectionRequest,
    signal?: AbortSignal,
  ): Promise<ExactHeadRecord | undefined> {
    signal?.throwIfAborted();
    return this.#storage.transaction(async (txn) => {
      const range = exactHeadSelectionIndexRange(request);
      const indexed = await txn.list<ExactHeadSelectionIndexRecord>({
        prefix: range.prefix,
        start: range.start,
        end: range.end,
        limit: EXACT_HEAD_SELECTION_WINDOW,
      });
      signal?.throwIfAborted();
      const candidates: ExactHeadRecord[] = [];
      for (const entry of indexed.values()) {
        const head = await txn.get<ExactHeadRecord>(exactHeadKey(entry.headId));
        signal?.throwIfAborted();
        if (head && exactHeadMatchesSelection(head, request)) {
          candidates.push(head);
        }
      }
      if (candidates.length === 0) return undefined;
      const index = Number(
        BigInt(`0x${request.selectionKey}`) % BigInt(candidates.length),
      );
      return clone(candidates[index]!);
    });
  }

  async claimExactSettlement(
    input: ExactSettlementAttemptRecord,
  ): Promise<ExactSettlementClaimResult> {
    return this.#applyExactTransition({ kind: "claim", args: [input] });
  }

  async claimExactSettlementWithEvidence(
    input: ExactSettlementAttemptRecord,
    receipt: PnnEvidenceRecord,
    signal?: AbortSignal,
  ): Promise<ExactSettlementClaimResult> {
    if (receipt.transactionId !== input.transactionId)
      throw new Error("PNN evidence does not match exact settlement claim");
    return this.#applyExactTransition({ kind: "claim", args: [input] }, receipt, signal);
  }

  async loadExactSettlementAttempt(
    transactionId: string,
  ): Promise<ExactSettlementAttemptRecord | undefined> {
    return cloneOrUndefined(
      await this.#storage.get<ExactSettlementAttemptRecord>(
        exactAttemptKey(transactionId),
      ),
    );
  }

  async recordExactSettlementBroadcast(
    transactionId: string,
    finality: "broadcast" | "accepted" | "confirmed",
    observedAt: string,
  ): Promise<void> {
    await this.#applyExactTransition({
      kind: "broadcast",
      args: [transactionId, finality, observedAt],
    });
  }

  async acceptExactSettlement(
    transactionId: string,
    finality: "accepted" | "confirmed",
    observedAt: string,
  ): Promise<void> {
    await this.#applyExactTransition({
      kind: "accept",
      args: [transactionId, finality, observedAt],
    });
  }

  async beginExactHandler(
    transactionId: string,
    startedAt: string,
  ): Promise<boolean> {
    return this.#applyExactTransition({
      kind: "begin-handler",
      args: [transactionId, startedAt],
    });
  }

  async recordExactHandlerResult(
    transactionId: string,
    result: ProtectedHandlerResult,
    completedAt: string,
  ): Promise<void> {
    await this.#applyExactTransition({
      kind: "record-result",
      args: [transactionId, result, completedAt],
    });
  }

  async markExactHandlerRecoveryRequired(
    transactionId: string,
    reason: string,
    observedAt: string,
  ): Promise<void> {
    await this.#applyExactTransition({
      kind: "recovery",
      args: [transactionId, reason, observedAt],
    });
  }

  async abandonExactSettlement(
    transactionId: string,
    reason: string,
    observedAt: string,
  ): Promise<void> {
    await this.#applyExactTransition({
      kind: "abandon",
      args: [transactionId, reason, observedAt],
    });
  }

  async markExactHeadUnavailable(
    input: ExactHeadUnavailableApply,
  ): Promise<ExactHeadUnavailableResult> {
    return this.#applyExactTransition({
      kind: "unavailable-head",
      args: [input],
    });
  }

  async applyExactHeadLineage(
    input: ExactHeadLineageApply,
  ): Promise<ExactHeadRecord> {
    return this.#applyExactTransition({ kind: "lineage", args: [input] });
  }

  async #applyExactTransition<C extends ExactTransitionCommand>(
    command: C,
    evidence?: PnnEvidenceRecord,
    signal?: AbortSignal,
  ): Promise<ExactTransitionResult<C>> {
    signal?.throwIfAborted();
    command = clone(command);
    const initial = exactTransitionScope(command);
    if (command.kind === "claim") {
      // Commit bounded cleanup even when the later admission rejects the claim.
      await this.#storage.transaction((txn) =>
        pruneTerminalDurableBudgets(txn, this.#limits, this.#now()),
      );
    }
    return this.#storage.transaction(async (txn) => {
      const attempt = initial.transactionId
        ? await txn.get<ExactSettlementAttemptRecord>(
            exactAttemptKey(initial.transactionId),
          )
        : undefined;
      const scope = exactTransitionScope(command, attempt);
      const snapshot: ExactTransitionSnapshot = {
        now: new Date().toISOString(),
        attempt,
        head: scope.headId
          ? await txn.get<ExactHeadRecord>(exactHeadKey(scope.headId))
          : undefined,
        payment: scope.transactionId
          ? await txn.get<ExactPaymentRecord>(
              exactPaymentKey(scope.transactionId),
            )
          : undefined,
        identifier: scope.identifierId
          ? await txn.get<PaymentIdentifierRecord>(
              paymentIdentifierKey(scope.identifierId),
            )
          : undefined,
        reservation: scope.identifierId
          ? await txn.get<PaymentIdentifierReservationRecord>(
              paymentIdentifierReservationKey(scope.identifierId),
            )
          : undefined,
      };
      if (command.kind === "register-head" && !snapshot.head) {
        snapshot.heads = Array.from(
          (await txn.list<ExactHeadRecord>({ prefix: "exact-head:" })).values(),
        );
        snapshot.maxHeads = this.#limits.maxExactHeads;
      }
      const changes = prepareExactTransition(command, snapshot);
      if (evidence && changes.attempt)
        await this.#putPnnEvidence(txn, evidence, true);
      const budget = changes.budget;
      if (budget?.kind === "admit") {
        const next = budget.attempt;
        await reclaimSafelyReleasedPaymentIdentifier(
          txn,
          next.paymentIdentifier,
        );
        await admitDurableBudget(txn, this.#limits, this.#now(), {
          key: `exact:${next.transactionId}`,
          kind: "exact",
          attemptId: next.transactionId,
          payerId: next.payerId,
          bytes: budget.bytes,
          ...(next.paymentIdentifier
            ? { paymentIdentifier: next.paymentIdentifier.id }
            : {}),
        });
      }
      if (changes.head) await putExactHead(txn, snapshot.head, changes.head);
      if (changes.reservation)
        await txn.put(
          paymentIdentifierReservationKey(changes.reservation.id),
          clone(changes.reservation),
        );
      if (changes.identifier)
        await txn.put(
          paymentIdentifierKey(changes.identifier.id),
          clone(changes.identifier),
        );
      if (changes.payment)
        await txn.put(
          exactPaymentKey(changes.payment.transactionId),
          clone(changes.payment),
        );
      if (changes.attempt === null)
        await txn.delete(exactAttemptKey(changes.transactionId!));
      else if (changes.attempt)
        await txn.put(
          exactAttemptKey(changes.attempt.transactionId),
          clone(changes.attempt),
        );
      if (command.kind === "commit" || command.kind === "abandon")
        await this.#finishPnnEvidenceClaim(
          txn, changes.transactionId!, changes.attempt === null,
        );
      if (budget?.kind === "terminal") {
        await terminalizeDurableBudget(
          txn,
          `exact:${budget.transactionId}`,
          budget.bytes,
          this.#now(),
          undefined,
          budget.identifierId,
          budget.safelyReleased,
        );
      } else if (budget?.kind === "delete")
        await deleteDurableBudget(txn, `exact:${budget.transactionId}`);
      signal?.throwIfAborted();
      return changes.result;
    });
  }

  async commitSettlement(record: SettlementCommit): Promise<void> {
    await this.#storage.transaction(async (txn) => {
      const current = await txn.get<ServerChannelRecord>(
        channelKey(record.expected.channelId),
      );
      if (!matchesExpectedChannel(current, record.expected)) {
        throw new Error("channel state changed before settlement commit");
      }
      const attempt = await txn.get<BatchSettlementAttemptRecord>(
        batchAttemptKey(record.batchAttemptId),
      );
      if (!batchSettlementAttemptIsReadyToCommit(attempt, record)) {
        throw new Error("batch settlement attempt is not ready to apply");
      }
      const lease = await requireChannelOperation(
        txn,
        attempt.channelId,
        attempt.attemptId,
      );
      if (
        lease.kind !== attempt.operationKind ||
        (lease.status !== "pending" && lease.status !== "recovery-required")
      )
        throw new Error("batch settlement does not own the channel operation");
      assertSettlementTransition(current!, record.channel, record.commitment);
      await assertCompletedPaymentIdentifier(
        txn,
        attempt,
        record.paymentIdentifier,
      );
      await txn.put(
        commitmentKey(record.commitment.commitmentId),
        clone(record.commitment),
      );
      if (record.paymentIdentifier) {
        await txn.put(
          paymentIdentifierKey(record.paymentIdentifier.id),
          clone(record.paymentIdentifier),
        );
        await applyPaymentIdentifierTransition(
          txn,
          attempt.paymentIdentifier!,
          { kind: "complete", observedAt: attempt.updatedAt },
        );
      }
      await putChannel(txn, record.channel);
      const {
        handlerResult: _handlerResult,
        handlerCompletedAt: _handlerCompletedAt,
        channelTransition: _channelTransition,
        ...compactAttempt
      } = attempt;
      const appliedAttempt = {
        ...compactAttempt,
        status: "applied",
        recoveryReason: undefined,
        commitmentId: record.commitment.commitmentId,
        completedPaymentIdentifier: record.paymentIdentifier?.id,
        updatedAt: new Date().toISOString(),
      } satisfies BatchSettlementAttemptRecord;
      await txn.put(batchAttemptKey(attempt.attemptId), appliedAttempt);
      await txn.delete(openBatchAttemptKey(attempt.channelId));
      await deleteChannelOperation(txn, lease);
      await terminalizeDurableBudget(
        txn,
        `batch:${attempt.attemptId}`,
        durableByteLength({
          attempt: appliedAttempt,
          commitment: record.commitment,
          paymentIdentifier: record.paymentIdentifier,
        }),
        this.#now(),
        record.commitment.commitmentId,
        record.paymentIdentifier?.id,
      );
    });
  }

  async commitExactPayment(record: ExactSettlementCommit): Promise<void> {
    await this.#applyExactTransition({ kind: "commit", args: [record] });
  }

  async loadOpenClaimAttempt(
    channelId: string,
  ): Promise<ClaimAttemptRecord | undefined> {
    const attemptId = await this.#storage.get<string>(openClaimKey(channelId));
    return attemptId
      ? cloneOrUndefined(
          await this.#storage.get<ClaimAttemptRecord>(
            claimAttemptKey(attemptId),
          ),
        )
      : undefined;
  }

  async saveClaimAttempt(record: ClaimAttemptRecord): Promise<void> {
    await this.#storage.transaction(async (txn) => {
      const existing = await txn.get<ClaimAttemptRecord>(
        claimAttemptKey(record.attemptId),
      );
      const attempt = normalizeClaimAttempt(record, existing);
      const openAttemptId = await txn.get<string>(
        openClaimKey(attempt.channelId),
      );
      if (openAttemptId && openAttemptId !== attempt.attemptId) {
        const open = await txn.get<ClaimAttemptRecord>(
          claimAttemptKey(openAttemptId),
        );
        if (open && open.status !== "applied")
          throw new Error("claim attempt is already pending");
      }
      const lease = await requireChannelOperation(
        txn,
        attempt.channelId,
        attempt.operationLeaseId,
      );
      if (
        lease.kind !== "claim" ||
        !sameChannelSnapshot(lease.expected, attempt.expected)
      )
        throw new Error("claim attempt does not own the channel snapshot");
      await txn.put(claimAttemptKey(attempt.attemptId), attempt);
      await txn.put(openClaimKey(attempt.channelId), attempt.attemptId);
      await updateChannelOperation(
        txn,
        attempt.channelId,
        attempt.operationLeaseId,
        { status: "pending", updatedAt: new Date().toISOString() },
      );
    });
  }

  async applyClaimAttempt(
    channel: ServerChannelRecord,
    attempt: ClaimAttemptRecord,
  ): Promise<void> {
    await this.#storage.transaction(async (txn) => {
      const currentAttempt = await txn.get<ClaimAttemptRecord>(
        claimAttemptKey(attempt.attemptId),
      );
      if (
        !currentAttempt ||
        currentAttempt.status !== "accepted" ||
        attempt.status !== "accepted" ||
        !claimAttemptsMatch(currentAttempt, attempt)
      ) {
        throw new Error(
          "claim apply must match the persisted accepted attempt",
        );
      }
      const lease = await requireChannelOperation(
        txn,
        currentAttempt.channelId,
        currentAttempt.operationLeaseId,
      );
      if (lease.kind !== "claim")
        throw new Error("claim apply does not own the channel operation");
      const currentChannel = await txn.get<ServerChannelRecord>(
        channelKey(channel.channelId),
      );
      if (
        !sameChannelSnapshot(currentChannel, currentAttempt.expected) ||
        !sameChannelSnapshot(currentChannel, lease.expected)
      ) {
        throw new Error("channel state changed before claim apply");
      }
      assertClaimTransition(currentChannel!, channel, currentAttempt);
      await putChannel(txn, channel);
      await txn.put(claimAttemptKey(currentAttempt.attemptId), {
        ...clone(currentAttempt),
        status: "applied",
      });
      await txn.delete(openClaimKey(currentAttempt.channelId));
      await deleteChannelOperation(txn, lease);
    });
  }

  async abandonClaimAttempt(attemptId: string): Promise<void> {
    await this.#storage.transaction(async (txn) => {
      const current = await txn.get<ClaimAttemptRecord>(
        claimAttemptKey(attemptId),
      );
      if (!current || current.status === "applied") return;
      if (current.status === "accepted")
        throw new Error("accepted claim attempt cannot be abandoned");
      const lease = await requireChannelOperation(
        txn,
        current.channelId,
        current.operationLeaseId,
      );
      await txn.delete(claimAttemptKey(attemptId));
      await txn.delete(openClaimKey(current.channelId));
      await deleteChannelOperation(txn, lease);
    });
  }

  async acquireLock(
    key: string,
    token: string,
    nowMs: number,
    ttlMs: number,
  ): Promise<boolean> {
    return this.#storage.transaction(async (txn) => {
      const current = await txn.get<LockRecord>(lockKey(key));
      if (current && current.token !== token && current.expiresAt > nowMs)
        return false;
      await txn.put(lockKey(key), { token, expiresAt: nowMs + ttlMs });
      return true;
    });
  }

  async releaseLock(key: string, token: string): Promise<void> {
    await this.#storage.transaction(async (txn) => {
      const current = await txn.get<LockRecord>(lockKey(key));
      if (current?.token === token) await txn.delete(lockKey(key));
    });
  }

  async acquirePublicAdmission(
    token: string,
    callerKey: string,
    nowMs: number,
    globalLimit: number,
    callerLimit: number,
    ttlMs: number,
  ): Promise<GatewayPublicAdmissionResult> {
    assertPublicAdmissionInput(token, callerKey, nowMs, globalLimit, callerLimit, ttlMs);
    return this.#storage.transaction(async (txn) => {
      const key = publicAdmissionKey();
      const stored = await txn.get<PublicAdmissionState>(key);
      const leases = readPublicAdmissionLeases(stored);
      for (const [leaseToken, lease] of Object.entries(leases)) {
        if (lease.expiresAt <= nowMs) delete leases[leaseToken];
      }

      const existing = leases[token];
      if (existing) {
        if (existing.callerKey !== callerKey)
          throw new Error("public admission lease caller changed");
        existing.expiresAt = nowMs + ttlMs;
        await txn.put(key, { leases });
        return { allowed: true, active: Object.keys(leases).length };
      }

      const active = Object.keys(leases).length;
      const callerLeases = Object.values(leases).filter(
        (lease) => lease.callerKey === callerKey,
      );
      if (callerLeases.length >= callerLimit) {
        return {
          allowed: false,
          active,
          reason: "caller_concurrency_exceeded",
          retryAt: Math.min(...callerLeases.map((lease) => lease.expiresAt)),
        };
      }
      if (active >= globalLimit) {
        return {
          allowed: false,
          active,
          reason: "global_concurrency_exceeded",
          retryAt: Math.min(
            ...Object.values(leases).map((lease) => lease.expiresAt),
          ),
        };
      }

      leases[token] = { expiresAt: nowMs + ttlMs, callerKey };
      await txn.put(key, { leases });
      return { allowed: true, active: active + 1 };
    });
  }

  async renewPublicAdmission(
    token: string,
    callerKey: string,
    nowMs: number,
    ttlMs: number,
  ): Promise<boolean> {
    assertPublicAdmissionLeaseInput(token, callerKey, nowMs, ttlMs);
    return this.#storage.transaction(async (txn) => {
      const key = publicAdmissionKey();
      const leases = readPublicAdmissionLeases(
        await txn.get<PublicAdmissionState>(key),
      );
      const existing = leases[token];
      if (!existing || existing.expiresAt <= nowMs) {
        if (existing) {
          delete leases[token];
          await txn.put(key, { leases });
        }
        return false;
      }
      if (existing.callerKey !== callerKey)
        throw new Error("public admission lease caller changed");
      existing.expiresAt = nowMs + ttlMs;
      await txn.put(key, { leases });
      return true;
    });
  }

  async releasePublicAdmission(token: string): Promise<void> {
    assertPublicAdmissionToken(token);
    await this.#storage.transaction(async (txn) => {
      const key = publicAdmissionKey();
      const stored = await txn.get<PublicAdmissionState>(key);
      const leases = readPublicAdmissionLeases(stored);
      if (!leases[token]) return;
      delete leases[token];
      await txn.put(key, { leases });
    });
  }

  async checkRateLimit(
    scope: string,
    nowMs: number,
    limit: number,
    windowMs: number,
  ): Promise<{ allowed: boolean; count: number; resetAt: number }> {
    if (limit <= 0)
      return { allowed: true, count: 0, resetAt: nowMs + windowMs };
    const resetAt = Math.floor(nowMs / windowMs) * windowMs + windowMs;
    const key = rateWindowKey();
    const scopeHash = sha256Hex(scope);
    return this.#storage.transaction(async (txn) => {
      const stored = await txn.get<RateWindowRecord>(key);
      const current =
        stored && stored.resetAt >= resetAt ? stored : { resetAt, counts: {} };
      const previous = current.counts[scopeHash];
      if (
        previous === undefined &&
        Object.keys(current.counts).length >= MAX_RATE_SCOPES_PER_WINDOW
      ) {
        return { allowed: false, count: limit + 1, resetAt: current.resetAt };
      }
      const count = (previous ?? 0) + 1;
      current.counts[scopeHash] = count;
      await txn.put(key, current);
      return { allowed: count <= limit, count, resetAt: current.resetAt };
    });
  }

  async resolveBatchRefundTimeoutDaa(
    currentDaa: string,
    refundDeltaDaa: string,
    minimumLeadDaa: string,
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    const current = parseSompiString(currentDaa);
    const delta = parseSompiString(refundDeltaDaa);
    const minimumLead = parseSompiString(minimumLeadDaa);
    if (delta <= minimumLead)
      throw new Error("refund DAA delta must exceed minimum lead");
    const next = current + delta;
    return this.#storage.transaction(async (txn) => {
      const key = batchRefundTimeoutKey();
      const stored = await txn.get<string>(key);
      signal?.throwIfAborted();
      if (stored !== undefined) {
        const timeout = parseSompiString(stored);
        if (current + minimumLead < timeout && timeout <= next)
          return timeout.toString();
      }
      await txn.put(key, next.toString());
      return next.toString();
    });
  }

  async loadCanaryReport(): Promise<GatewayCanaryReport | undefined> {
    return cloneOrUndefined(
      await this.#storage.get<GatewayCanaryReport>(canaryReportKey()),
    );
  }

  async saveCanaryReport(report: GatewayCanaryReport): Promise<void> {
    await this.#storage.put(canaryReportKey(), clone(report));
  }

  async incrementMetric(name: string, amount = 1): Promise<void> {
    await this.#storage.transaction(async (txn) => {
      const key = metricKey(name);
      const current = (await txn.get<number>(key)) ?? 0;
      await txn.put(key, current + amount);
    });
  }

  async metrics(): Promise<Record<string, number>> {
    const entries = await this.#storage.list<number>({ prefix: "metric:" });
    const metrics: Record<string, number> = {};
    for (const [key, value] of entries)
      metrics[key.slice("metric:".length)] = value;
    return metrics;
  }
}

export class DurableGatewayLockManager implements ChannelLockManager {
  readonly coordinationScope = "deployment-wide" as const;
  readonly coordinationDomain = GATEWAY_COORDINATION_DOMAIN;
  readonly #state: GatewayStateClient;
  readonly #ttlMs: number;

  constructor(state: GatewayStateClient, ttlMs = 30_000) {
    this.#state = state;
    this.#ttlMs = ttlMs;
  }

  async runExclusive<T>(channelId: string, fn: () => Promise<T>): Promise<T> {
    const token = crypto.randomUUID();
    const started = Date.now();
    for (;;) {
      if (
        await this.#state.acquireLock(channelId, token, Date.now(), this.#ttlMs)
      )
        break;
      if (Date.now() - started > this.#ttlMs)
        throw new Error("gateway lock acquisition timed out");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    let renewalInFlight: Promise<void> = Promise.resolve();
    const renewal = setInterval(
      () => {
        renewalInFlight = renewalInFlight
          .then(() =>
            this.#state.acquireLock(channelId, token, Date.now(), this.#ttlMs),
          )
          .then(() => undefined);
      },
      Math.max(50, Math.floor(this.#ttlMs / 3)),
    );
    try {
      return await fn();
    } finally {
      clearInterval(renewal);
      await renewalInFlight.catch(() => undefined);
      await this.#state.releaseLock(channelId, token);
    }
  }
}

export type GatewayStateClient = ServerStateStore & PnnEvidenceStore & {
  claimExactSettlementWithEvidence(
    attempt: ExactSettlementAttemptRecord,
    receipt: PnnEvidenceRecord,
    signal?: AbortSignal,
  ): Promise<ExactSettlementClaimResult>;
  exactHeadStats(signal?: AbortSignal): Promise<ExactHeadStats>;
  recordExactHeadOfferObservation(head: ExactHeadRecord): Promise<void>;
  hasRecentExactHeadOfferObservation(headId: string, nowMs: number, signal?: AbortSignal): Promise<boolean>;
  acquireLock(
    key: string,
    token: string,
    nowMs: number,
    ttlMs: number,
  ): Promise<boolean>;
  releaseLock(key: string, token: string): Promise<void>;
  acquirePublicAdmission(
    token: string,
    callerKey: string,
    nowMs: number,
    globalLimit: number,
    callerLimit: number,
    ttlMs: number,
  ): Promise<GatewayPublicAdmissionResult>;
  renewPublicAdmission(
    token: string,
    callerKey: string,
    nowMs: number,
    ttlMs: number,
  ): Promise<boolean>;
  releasePublicAdmission(token: string): Promise<void>;
  checkRateLimit(
    scope: string,
    nowMs: number,
    limit: number,
    windowMs: number,
  ): Promise<{ allowed: boolean; count: number; resetAt: number }>;
  resolveBatchRefundTimeoutDaa(
    currentDaa: string,
    refundDeltaDaa: string,
    minimumLeadDaa: string,
    signal?: AbortSignal,
  ): Promise<string>;
  loadRecentPnnDaaScore(nowMs: number, maxAgeMs?: number, signal?: AbortSignal): Promise<string | undefined>;
  loadCanaryReport(): Promise<GatewayCanaryReport | undefined>;
  saveCanaryReport(report: GatewayCanaryReport): Promise<void>;
  incrementMetric(name: string, amount?: number): Promise<void>;
  metrics(): Promise<Record<string, number>>;
};

export async function dispatchGatewayState(
  ledger: GatewayLedger,
  request: GatewayStateRequest,
  signal?: AbortSignal,
): Promise<unknown> {
  switch (request.method) {
    case "loadPnnEvidence": return ledger.loadPnnEvidence(readPayload<{ transactionId: string }>(request).transactionId);
    case "savePnnEvidence": return ledger.savePnnEvidence(readPayload<{ record: PnnEvidenceRecord }>(request).record, signal);
    case "recordPnnCheckpoint": return ledger.recordPnnCheckpoint(readPayload<{ checkpoint: ChainCheckpoint }>(request).checkpoint);
    case "findPnnCheckpointBefore": return ledger.findPnnCheckpointBefore(readPayload<{ daaScore: string }>(request).daaScore);
    case "loadChannel":
      return ledger.loadChannel(
        readPayload<{ channelId: string }>(request).channelId,
      );
    case "registerChannel":
      return ledger.registerChannel(
        readPayload<{ channel: ServerChannelRecord }>(request).channel,
      );
    case "retireChannel": {
      const payload = readPayload<{
        channelId: string;
        leaseId: string;
        expected: ServerChannelRecord;
      }>(request);
      return ledger.retireChannel(
        payload.channelId,
        payload.leaseId,
        payload.expected,
      );
    }
    case "applyCovenantLineage": {
      const payload = readPayload<{
        expected: ServerChannelRecord;
        channel: ServerChannelRecord;
        leaseId: string;
      }>(request);
      return ledger.applyCovenantLineage(
        payload.expected,
        payload.channel,
        payload.leaseId,
      );
    }
    case "listChannels":
      return ledger.listChannels();
    case "claimChannelOperation":
      return ledger.claimChannelOperation(
        readPayload<{ record: ChannelOperationLeaseRecord }>(request).record,
      );
    case "loadChannelOperation":
      return ledger.loadChannelOperation(
        readPayload<{ channelId: string }>(request).channelId,
      );
    case "abandonChannelOperation": {
      const payload = readPayload<{
        leaseId: string;
        reason: string;
        observedAt: string;
      }>(request);
      return ledger.abandonChannelOperation(
        payload.leaseId,
        payload.reason,
        payload.observedAt,
      );
    }
    case "loadCommitment":
      return ledger.loadCommitment(
        readPayload<{ commitmentId: string }>(request).commitmentId,
      );
    case "claimBatchSettlement":
      return ledger.claimBatchSettlement(
        readPayload<{ record: BatchSettlementAttemptRecord }>(request).record,
      );
    case "loadBatchSettlementAttempt":
      return ledger.loadBatchSettlementAttempt(
        readPayload<{ attemptId: string }>(request).attemptId,
      );
    case "beginBatchHandler": {
      const payload = readPayload<{ attemptId: string; startedAt: string }>(
        request,
      );
      return ledger.beginBatchHandler(payload.attemptId, payload.startedAt);
    }
    case "recordBatchHandlerResult": {
      const payload = readPayload<{
        attemptId: string;
        result: ProtectedHandlerResult;
        completedAt: string;
      }>(request);
      return ledger.recordBatchHandlerResult(
        payload.attemptId,
        payload.result,
        payload.completedAt,
      );
    }
    case "markBatchHandlerRecoveryRequired": {
      const payload = readPayload<{
        attemptId: string;
        reason: string;
        observedAt: string;
      }>(request);
      return ledger.markBatchHandlerRecoveryRequired(
        payload.attemptId,
        payload.reason,
        payload.observedAt,
      );
    }
    case "abandonBatchSettlement": {
      const payload = readPayload<{
        attemptId: string;
        reason: string;
        observedAt: string;
      }>(request);
      return ledger.abandonBatchSettlement(
        payload.attemptId,
        payload.reason,
        payload.observedAt,
      );
    }
    case "loadPaymentIdentifier":
      return ledger.loadPaymentIdentifier(
        readPayload<{ id: string }>(request).id,
      );
    case "loadPaymentIdentifierReservation":
      return ledger.loadPaymentIdentifierReservation(
        readPayload<{ id: string }>(request).id,
      );
    case "loadExactPayment":
      return ledger.loadExactPayment(
        readPayload<{ transactionId: string }>(request).transactionId,
      );
    case "registerExactHead":
      return ledger.registerExactHead(
        readPayload<{ record: ExactHeadRecord }>(request).record,
      );
    case "loadExactHead":
      return ledger.loadExactHead(
        readPayload<{ headId: string }>(request).headId,
      );
    case "listExactHeads":
      return ledger.listExactHeads();
    case "exactHeadStats":
      return ledger.exactHeadStats(signal);
    case "selectExactHead":
      return ledger.selectExactHead(
        readPayload<{ request: ExactHeadSelectionRequest }>(request).request,
        signal,
      );
    case "claimExactSettlementWithEvidence": {
      const payload = readPayload<{
        record: ExactSettlementAttemptRecord;
        receipt: PnnEvidenceRecord;
      }>(request);
      return ledger.claimExactSettlementWithEvidence(payload.record, payload.receipt, signal);
    }
    case "claimExactSettlement":
      return ledger.claimExactSettlement(
        readPayload<{ record: ExactSettlementAttemptRecord }>(request).record,
      );
    case "loadExactSettlementAttempt":
      return ledger.loadExactSettlementAttempt(
        readPayload<{ transactionId: string }>(request).transactionId,
      );
    case "recordExactSettlementBroadcast": {
      const payload = readPayload<{
        transactionId: string;
        finality: "broadcast" | "accepted" | "confirmed";
        observedAt: string;
      }>(request);
      return ledger.recordExactSettlementBroadcast(
        payload.transactionId,
        payload.finality,
        payload.observedAt,
      );
    }
    case "acceptExactSettlement": {
      const payload = readPayload<{
        transactionId: string;
        finality: "accepted" | "confirmed";
        observedAt: string;
      }>(request);
      return ledger.acceptExactSettlement(
        payload.transactionId,
        payload.finality,
        payload.observedAt,
      );
    }
    case "beginExactHandler": {
      const payload = readPayload<{ transactionId: string; startedAt: string }>(
        request,
      );
      return ledger.beginExactHandler(payload.transactionId, payload.startedAt);
    }
    case "recordExactHandlerResult": {
      const payload = readPayload<{
        transactionId: string;
        result: ProtectedHandlerResult;
        completedAt: string;
      }>(request);
      return ledger.recordExactHandlerResult(
        payload.transactionId,
        payload.result,
        payload.completedAt,
      );
    }
    case "markExactHandlerRecoveryRequired": {
      const payload = readPayload<{
        transactionId: string;
        reason: string;
        observedAt: string;
      }>(request);
      return ledger.markExactHandlerRecoveryRequired(
        payload.transactionId,
        payload.reason,
        payload.observedAt,
      );
    }
    case "abandonExactSettlement": {
      const payload = readPayload<{
        transactionId: string;
        reason: string;
        observedAt: string;
      }>(request);
      return ledger.abandonExactSettlement(
        payload.transactionId,
        payload.reason,
        payload.observedAt,
      );
    }
    case "markExactHeadUnavailable": {
      return ledger.markExactHeadUnavailable(
        readPayload<{ input: ExactHeadUnavailableApply }>(request).input,
      );
    }
    case "applyExactHeadLineage":
      return ledger.applyExactHeadLineage(
        readPayload<{ input: ExactHeadLineageApply }>(request).input,
      );
    case "resolveBatchRefundTimeoutDaa": {
      const payload = readPayload<{
        currentDaa: string;
        refundDeltaDaa: string;
        minimumLeadDaa: string;
      }>(request);
      return ledger.resolveBatchRefundTimeoutDaa(
        payload.currentDaa,
        payload.refundDeltaDaa,
        payload.minimumLeadDaa,
        signal,
      );
    }
    case "loadRecentPnnDaaScore": {
      const { nowMs, maxAgeMs } = readPayload<{
        nowMs: number; maxAgeMs?: number;
      }>(request);
      return ledger.loadRecentPnnDaaScore(nowMs, maxAgeMs, signal);
    }
    case "recordExactHeadOfferObservation":
      return ledger.recordExactHeadOfferObservation(readPayload<{ head: ExactHeadRecord }>(request).head);
    case "hasRecentExactHeadOfferObservation": {
      const payload = readPayload<{ headId: string; nowMs: number }>(request);
      return ledger.hasRecentExactHeadOfferObservation(payload.headId, payload.nowMs, signal);
    }
    case "commitSettlement":
      return ledger.commitSettlement(
        readPayload<{ record: SettlementCommit }>(request).record,
      );
    case "commitExactPayment":
      return ledger.commitExactPayment(
        readPayload<{ record: ExactSettlementCommit }>(request).record,
      );
    case "loadOpenClaimAttempt":
      return ledger.loadOpenClaimAttempt(
        readPayload<{ channelId: string }>(request).channelId,
      );
    case "saveClaimAttempt":
      return ledger.saveClaimAttempt(
        readPayload<{ record: ClaimAttemptRecord }>(request).record,
      );
    case "applyClaimAttempt": {
      const payload = readPayload<{
        channel: ServerChannelRecord;
        attempt: ClaimAttemptRecord;
      }>(request);
      return ledger.applyClaimAttempt(payload.channel, payload.attempt);
    }
    case "abandonClaimAttempt":
      return ledger.abandonClaimAttempt(
        readPayload<{ attemptId: string }>(request).attemptId,
      );
    case "acquireLock": {
      const payload = readPayload<{
        key: string;
        token: string;
        nowMs: number;
        ttlMs: number;
      }>(request);
      return ledger.acquireLock(
        payload.key,
        payload.token,
        payload.nowMs,
        payload.ttlMs,
      );
    }
    case "releaseLock": {
      const payload = readPayload<{ key: string; token: string }>(request);
      return ledger.releaseLock(payload.key, payload.token);
    }
    case "checkRateLimit": {
      const payload = readPayload<{
        scope: string;
        nowMs: number;
        limit: number;
        windowMs: number;
      }>(request);
      return ledger.checkRateLimit(
        payload.scope,
        payload.nowMs,
        payload.limit,
        payload.windowMs,
      );
    }
    case "loadCanaryReport":
      return ledger.loadCanaryReport();
    case "saveCanaryReport":
      return ledger.saveCanaryReport(
        readPayload<{ report: GatewayCanaryReport }>(request).report,
      );
    case "incrementMetric": {
      const payload = readPayload<{ name: string; amount?: number }>(request);
      return ledger.incrementMetric(payload.name, payload.amount);
    }
    case "metrics":
      return ledger.metrics();
  }
}

function readPayload<T>(request: GatewayStateRequest): T {
  return (request.payload ?? {}) as T;
}

async function assertPaymentIdentifierClaimAvailable(
  txn: GatewayTransaction,
  claim: PaymentIdentifierReservationClaim | undefined,
): Promise<void> {
  if (!claim) return;
  assertPaymentIdentifierAvailable(
    claim,
    await txn.get<PaymentIdentifierReservationRecord>(
      paymentIdentifierReservationKey(claim.id),
    ),
    await txn.get<PaymentIdentifierRecord>(paymentIdentifierKey(claim.id)),
  );
}

async function reclaimSafelyReleasedPaymentIdentifier(
  txn: GatewayTransaction,
  claim: PaymentIdentifierReservationClaim | undefined,
): Promise<void> {
  if (!claim) return;
  const released = await txn.get<PaymentIdentifierReservationRecord>(
    paymentIdentifierReservationKey(claim.id),
  );
  if (!released || released.status !== "safely-released") return;
  const budgetKey = `${
    released.paymentKind === "exact" ? "exact" : "batch"
  }:${released.ownerId}`;
  const budget = await txn.get<DurableBudgetRecord>(
    durableBudgetRecordKey(budgetKey),
  );
  if (budget?.safelyReleased) await deleteDurableBudget(txn, budgetKey);
  await txn.delete(paymentIdentifierReservationKey(claim.id));
}

async function applyPaymentIdentifierTransition(
  txn: GatewayTransaction,
  claim: PaymentIdentifierReservationClaim | undefined,
  transition: PaymentIdentifierReservationTransition,
): Promise<void> {
  if (!claim) return;
  const next = transitionPaymentIdentifierReservation(
    claim,
    await txn.get<PaymentIdentifierReservationRecord>(
      paymentIdentifierReservationKey(claim.id),
    ),
    transition,
  );
  if (next) await txn.put(paymentIdentifierReservationKey(next.id), next);
}

async function assertCompletedPaymentIdentifier(
  txn: GatewayTransaction,
  attempt:
    | BatchSettlementAttemptRecord
    | ExactSettlementAttemptRecord
    | undefined,
  completed: PaymentIdentifierRecord | undefined,
): Promise<void> {
  const claim = attempt?.paymentIdentifier;
  assertPaymentIdentifierCompletion(
    claim,
    completed,
    claim
      ? await txn.get<PaymentIdentifierReservationRecord>(
          paymentIdentifierReservationKey(claim.id),
        )
      : undefined,
    claim
      ? await txn.get<PaymentIdentifierRecord>(paymentIdentifierKey(claim.id))
      : undefined,
  );
}

async function putChannel(
  txn: GatewayTransaction,
  channel: ServerChannelRecord,
): Promise<void> {
  assertServerChannelLineageConsistency(channel);
  const channelId = channel.channelId.toLowerCase();
  const covenantId = channel.covenantId.toLowerCase();
  const current = await txn.get<ServerChannelRecord>(channelKey(channelId));
  if (current && current.covenantId.toLowerCase() !== covenantId) {
    throw new Error("channel covenant lineage cannot change");
  }
  const registeredChannelId = await txn.get<string>(
    covenantChannelKey(covenantId),
  );
  if (registeredChannelId && registeredChannelId.toLowerCase() !== channelId) {
    throw new Error(
      "covenant lineage is already registered to another channel",
    );
  }
  await txn.put(covenantChannelKey(covenantId), channelId);
  await txn.put(channelKey(channelId), clone(channel));
}

function normalizeChannelOperationLease(
  input: ChannelOperationLeaseRecord,
): ChannelOperationLeaseRecord {
  if (
    !isLowerHash32(input.leaseId) ||
    !isLowerHash32(input.channelId) ||
    !isNonzeroLowerHash32(input.covenantId)
  )
    throw new Error(
      "channel operation identifiers must be canonical lowercase",
    );
  if (input.status !== "reserved")
    throw new Error("new channel operation must be reserved");
  if (
    input.kind !== "payment" &&
    input.kind !== "deposit" &&
    input.kind !== "top-up" &&
    input.kind !== "claim" &&
    input.kind !== "refund" &&
    input.kind !== "recovery" &&
    input.kind !== "retirement"
  )
    throw new Error("channel operation kind is invalid");
  if (
    input.expected &&
    (input.expected.channelId !== input.channelId ||
      input.expected.covenantId !== input.covenantId)
  )
    throw new Error("channel operation snapshot identity is inconsistent");
  assertIsoDate(input.createdAt, "channel operation creation time");
  assertIsoDate(input.updatedAt, "channel operation update time");
  return clone(input);
}

function channelOperationLeasesMatch(
  left: ChannelOperationLeaseRecord,
  right: ChannelOperationLeaseRecord,
): boolean {
  return (
    left.leaseId === right.leaseId &&
    left.channelId === right.channelId &&
    left.covenantId === right.covenantId &&
    left.kind === right.kind &&
    sameChannelSnapshot(left.expected, right.expected)
  );
}

async function putChannelOperation(
  txn: GatewayTransaction,
  lease: ChannelOperationLeaseRecord,
): Promise<void> {
  await txn.put(channelOperationKey(lease.channelId), clone(lease));
  await txn.put(channelOperationLeaseKey(lease.leaseId), lease.channelId);
}

async function requireChannelOperation(
  txn: GatewayTransaction,
  channelId: string,
  leaseId: string,
): Promise<ChannelOperationLeaseRecord> {
  const lease = await txn.get<ChannelOperationLeaseRecord>(
    channelOperationKey(channelId),
  );
  if (!lease || lease.leaseId !== leaseId)
    throw new Error("channel operation lease was not found");
  return lease;
}

async function updateChannelOperation(
  txn: GatewayTransaction,
  channelId: string,
  leaseId: string,
  update: Pick<ChannelOperationLeaseRecord, "status" | "updatedAt"> &
    Pick<Partial<ChannelOperationLeaseRecord>, "recoveryReason">,
): Promise<void> {
  const lease = await requireChannelOperation(txn, channelId, leaseId);
  await txn.put(channelOperationKey(channelId), { ...lease, ...update });
}

async function deleteChannelOperation(
  txn: GatewayTransaction,
  lease: ChannelOperationLeaseRecord,
): Promise<void> {
  await txn.delete(channelOperationKey(lease.channelId));
  await txn.delete(channelOperationLeaseKey(lease.leaseId));
}

function assertSettlementTransition(
  previous: ServerChannelRecord,
  next: ServerChannelRecord,
  commitment: BatchCommitmentRecord,
): void {
  assertImmutableChannelIdentity(previous, next);
  if (
    next.fundingAmount !== previous.fundingAmount ||
    next.claimedCumulativeAmount !== previous.claimedCumulativeAmount ||
    !sameOutpoint(next.activeOutpoint, previous.activeOutpoint) ||
    next.activeScriptPublicKey.toLowerCase() !==
      previous.activeScriptPublicKey.toLowerCase() ||
    parseBatchLaneAmount(next.chargedCumulativeAmount, "next charged amount") <
      parseBatchLaneAmount(
        previous.chargedCumulativeAmount,
        "previous charged amount",
      ) ||
    parseBatchLaneAmount(next.signedMaxClaimable, "next signed ceiling") <
      parseBatchLaneAmount(
        previous.signedMaxClaimable,
        "previous signed ceiling",
      ) ||
    next.lastCommitmentId !== commitment.commitmentId ||
    next.version !== incrementVersion(previous.version) ||
    !sameCovenantLineage(previous.lineage, next.lineage)
  )
    throw new Error("settlement would roll back or replace channel state");
  batchLaneAccounting(next);
  assertServerChannelLineageConsistency(next);
}

function assertClaimTransition(
  previous: ServerChannelRecord,
  next: ServerChannelRecord,
  attempt: ClaimAttemptRecord,
): void {
  assertImmutableChannelIdentity(previous, next);
  const expected = applyBatchClaimAccounting(previous, attempt.claimAmount);
  if (
    next.fundingAmount !== expected.fundingAmount ||
    next.claimedCumulativeAmount !== expected.claimedCumulativeAmount ||
    next.chargedCumulativeAmount !== previous.chargedCumulativeAmount ||
    next.signedMaxClaimable !== previous.signedMaxClaimable ||
    next.lastCommitmentId !== previous.lastCommitmentId ||
    next.voucherSignature !== previous.voucherSignature ||
    next.version !== incrementVersion(previous.version) ||
    !attempt.continuationOutpoint ||
    !sameOutpoint(next.activeOutpoint, attempt.continuationOutpoint) ||
    next.activeScriptPublicKey.toLowerCase() !==
      attempt.continuationScriptPublicKey?.toLowerCase()
  )
    throw new Error("claim transition is not the reserved monotonic successor");
  batchLaneAccounting(next);
  assertServerCovenantJournalExtension(previous, next);
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
  )
    throw new Error("channel immutable identity cannot change");
}

function sameChannelSnapshot(
  left: ServerChannelRecord | null | undefined,
  right: ServerChannelRecord | null | undefined,
): boolean {
  if (left == null || right == null) return left == null && right == null;
  return stableJson(left) === stableJson(right);
}

function incrementVersion(version: string): string {
  return (parseBatchLaneAmount(version, "channel version") + 1n).toString();
}

function matchesExpectedChannel(
  current: ServerChannelRecord | undefined,
  expected: SettlementCommit["expected"],
): boolean {
  return sameChannelSnapshot(current, expected);
}

function matchesClaimSnapshot(
  current: ServerChannelRecord | undefined,
  attempt: ClaimAttemptRecord,
): boolean {
  return Boolean(
    current &&
      current.channelId === attempt.channelId &&
      current.covenantId.toLowerCase() === attempt.covenantId.toLowerCase() &&
      current.activeOutpoint.txid.toLowerCase() ===
        attempt.activeOutpoint.txid.toLowerCase() &&
      current.activeOutpoint.index === attempt.activeOutpoint.index &&
      current.activeScriptPublicKey.toLowerCase() ===
        attempt.activeScriptPublicKey.toLowerCase() &&
      current.fundingAmount === attempt.fundingAmount &&
      current.chargedCumulativeAmount === attempt.chargedCumulativeAmount &&
      current.claimedCumulativeAmount === attempt.claimedCumulativeAmount &&
      current.signedMaxClaimable === attempt.signedMaxClaimable &&
      current.voucherSignature === attempt.voucherSignature &&
      current.status === attempt.channelStatus,
  );
}

function channelKey(channelId: string): string {
  return `channel:${channelId.toLowerCase()}`;
}

function covenantChannelKey(covenantId: string): string {
  return `covenant-channel:${covenantId.toLowerCase()}`;
}

function commitmentKey(commitmentId: string): string {
  return `commitment:${commitmentId.toLowerCase()}`;
}

function batchAttemptKey(attemptId: string): string {
  return `batch-attempt:${attemptId.toLowerCase()}`;
}

function openBatchAttemptKey(channelId: string): string {
  return `open-batch-attempt:${channelId.toLowerCase()}`;
}

function channelOperationKey(channelId: string): string {
  return `channel-operation:${channelId.toLowerCase()}`;
}

function channelOperationLeaseKey(leaseId: string): string {
  return `channel-operation-lease:${leaseId.toLowerCase()}`;
}

function exactPaymentKey(transactionId: string): string {
  return `exact:${transactionId.toLowerCase()}`;
}

function exactHeadKey(headId: string): string {
  return `exact-head:${headId.toLowerCase()}`;
}

function exactHeadStatsKey(): string {
  return "exact-head-stats";
}

const EXACT_HEAD_SELECTION_WINDOW = 32;

type ExactHeadSelectionIndexRecord = {
  headId: string;
};

function exactHeadSelectionIndexPrefix(head: {
  network: string;
  payTo: string;
  scriptPublicKey: string;
}): string {
  const cohort = sha256Hex(
    JSON.stringify([
      head.network,
      head.payTo,
      head.scriptPublicKey.toLowerCase(),
    ]),
  );
  return `exact-head-select:${cohort}:`;
}

function exactHeadThresholdKey(value: string): string {
  const encoded = parseSompiString(value).toString(16);
  if (encoded.length > 16)
    throw new Error("exact head selection amount exceeds uint64");
  return encoded.padStart(16, "0");
}

function exactHeadSelectionIndexKey(head: ExactHeadRecord): string {
  return `${exactHeadSelectionIndexPrefix(head)}${exactHeadThresholdKey(
    head.additiveThresholdSompi,
  )}:${head.headId.toLowerCase()}`;
}

function exactHeadSelectionIndexRange(request: ExactHeadSelectionRequest): {
  prefix: string;
  start: string;
  end: string;
} {
  const prefix = exactHeadSelectionIndexPrefix({
    network: request.network,
    payTo: request.payTo,
    scriptPublicKey: request.payToScriptPublicKey,
  });
  return {
    prefix,
    start: `${prefix}${exactHeadThresholdKey(
      request.minimumAdditiveThresholdSompi,
    )}:`,
    // Durable Object list ranges are end-exclusive. `;` sorts directly after
    // the `:` separator, so all head ids at the maximum threshold are included.
    end: `${prefix}${exactHeadThresholdKey(request.amount)};`,
  };
}

async function putExactHead(
  txn: GatewayTransaction,
  previous: ExactHeadRecord | undefined,
  next: ExactHeadRecord,
): Promise<void> {
  const stats = await loadOrRebuildExactHeadStats(txn);
  if (!previous) {
    stats.total += 1;
    stats[next.status] += 1;
  } else if (previous.status !== next.status) {
    stats[previous.status] -= 1;
    stats[next.status] += 1;
  }
  if (previous?.status === "available") {
    await txn.delete(exactHeadSelectionIndexKey(previous));
  }
  await txn.put(exactHeadKey(next.headId), clone(next));
  if (next.status === "available") {
    await txn.put<ExactHeadSelectionIndexRecord>(
      exactHeadSelectionIndexKey(next),
      { headId: next.headId.toLowerCase() },
    );
  }
  await txn.put(exactHeadStatsKey(), stats);
}

async function loadOrRebuildExactHeadStats(
  txn: GatewayTransaction,
): Promise<ExactHeadStats> {
  const stored = await txn.get<ExactHeadStats>(exactHeadStatsKey());
  if (stored) return clone(stored);
  const stats: ExactHeadStats = {
    total: 0,
    available: 0,
    claimed: 0,
    unavailable: 0,
    retired: 0,
  };
  for (const head of (
    await txn.list<ExactHeadRecord>({ prefix: "exact-head:" })
  ).values()) {
    stats.total += 1;
    stats[head.status] += 1;
  }
  return stats;
}

function exactAttemptKey(transactionId: string): string {
  return `exact-attempt:${transactionId.toLowerCase()}`;
}

function paymentIdentifierKey(id: string): string {
  return `payment-identifier:${id}`;
}

function paymentIdentifierReservationKey(id: string): string {
  return `payment-identifier-reservation:${id}`;
}

function durableBudgetMetaKey(): string {
  return "durable-budget:meta";
}

function durableBudgetQuotaMigrationKey(): string {
  return "durable-budget:migration:compacted-outside-active-quota-v1";
}

function durableBudgetRecordKey(key: string): string {
  return `durable-budget:record:${key}`;
}

function durableBudgetTerminalKey(terminalAt: number, key: string): string {
  return `durable-budget:terminal:${terminalAt
    .toString()
    .padStart(16, "0")}:${sha256Hex(key)}`;
}

function claimAttemptKey(attemptId: string): string {
  return `claim-attempt:${attemptId.toLowerCase()}`;
}

function openClaimKey(channelId: string): string {
  return `open-claim:${channelId.toLowerCase()}`;
}

function lockKey(key: string): string {
  return `lock:${key.toLowerCase()}`;
}

function rateWindowKey(): string {
  return "rate-window:active";
}

function publicAdmissionKey(): string {
  return "public-admission:v1";
}

function canaryReportKey(): string {
  return "canary:latest";
}

function batchRefundTimeoutKey(): string {
  return "batch:refund-timeout-daa";
}

function metricKey(name: string): string {
  return `metric:${name}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function admitDurableBudget(
  txn: GatewayTransaction,
  limits: GatewayDurableStateLimits,
  _now: number,
  record: DurableBudgetRecord,
): Promise<void> {
  if (await txn.get(durableBudgetRecordKey(record.key))) return;
  const meta = (await txn.get<DurableBudgetMeta>(durableBudgetMetaKey())) ?? {
    records: 0,
    bytes: 0,
    payerCounts: {},
  };
  const payerKey = sha256Hex(record.payerId);
  const payerRecords = meta.payerCounts[payerKey] ?? 0;
  if (meta.records >= limits.maxRecords)
    throw new Error("durable protected-payment record limit exceeded");
  if (meta.bytes + record.bytes > limits.maxBytes)
    throw new Error("durable protected-payment byte limit exceeded");
  if (payerRecords >= limits.maxRecordsPerPayer)
    throw new Error("durable protected-payment per-payer limit exceeded");
  await txn.put(durableBudgetRecordKey(record.key), clone(record));
  await txn.put(durableBudgetMetaKey(), {
    records: meta.records + 1,
    bytes: meta.bytes + record.bytes,
    payerCounts: { ...meta.payerCounts, [payerKey]: payerRecords + 1 },
  } satisfies DurableBudgetMeta);
}

async function terminalizeDurableBudget(
  txn: GatewayTransaction,
  key: string,
  bytes: number,
  terminalAt: number,
  commitmentId?: string,
  paymentIdentifier?: string,
  safelyReleased = false,
): Promise<void> {
  const record = await txn.get<DurableBudgetRecord>(
    durableBudgetRecordKey(key),
  );
  if (!record) throw new Error("durable budget reservation is missing");
  if (bytes > record.bytes)
    throw new Error("durable terminal bundle exceeded its reserved byte quota");
  const meta = await txn.get<DurableBudgetMeta>(durableBudgetMetaKey());
  if (!meta) throw new Error("durable budget metadata is missing");
  await txn.put(durableBudgetRecordKey(key), {
    ...record,
    bytes,
    terminalAt,
    ...(commitmentId ? { commitmentId } : {}),
    ...(paymentIdentifier ? { paymentIdentifier } : {}),
    ...(safelyReleased ? { safelyReleased: true } : {}),
  } satisfies DurableBudgetRecord);
  await txn.put(durableBudgetTerminalKey(terminalAt, key), key);
  await txn.put(durableBudgetMetaKey(), {
    ...meta,
    bytes: meta.bytes + bytes - record.bytes,
  });
}

async function deleteDurableBudget(
  txn: GatewayTransaction,
  key: string,
): Promise<void> {
  const record = await txn.get<DurableBudgetRecord>(
    durableBudgetRecordKey(key),
  );
  if (!record) return;
  const meta = await txn.get<DurableBudgetMeta>(durableBudgetMetaKey());
  if (!meta) throw new Error("durable budget metadata is missing");
  const payerKey = sha256Hex(record.payerId);
  const payerRecords = meta.payerCounts[payerKey] ?? 0;
  const payerCounts = { ...meta.payerCounts };
  if (payerRecords <= 1) delete payerCounts[payerKey];
  else payerCounts[payerKey] = payerRecords - 1;
  if (record.terminalAt !== undefined) {
    await txn.delete(durableBudgetTerminalKey(record.terminalAt, key));
  }
  await txn.delete(durableBudgetRecordKey(key));
  await txn.put(durableBudgetMetaKey(), {
    records: meta.records - 1,
    bytes: meta.bytes - record.bytes,
    payerCounts,
  } satisfies DurableBudgetMeta);
}

async function pruneTerminalDurableBudgets(
  txn: GatewayTransaction,
  limits: GatewayDurableStateLimits,
  now: number,
): Promise<void> {
  // v1 RC1 briefly retained compact tombstones in active quota metadata.
  // Reclaim those legacy reservations lazily while leaving the compact
  // payment/commitment records themselves intact for replay rejection.
  if (!(await txn.get<boolean>(durableBudgetQuotaMigrationKey()))) {
    let start: string | undefined;
    while (true) {
      const legacyPage = await txn.list<DurableBudgetRecord>({
        prefix: "durable-budget:record:",
        ...(start ? { start } : {}),
        limit: 128,
      });
      for (const record of legacyPage.values()) {
        if (record.compactedAt !== undefined) {
          await deleteDurableBudget(txn, record.key);
        }
      }
      if (legacyPage.size < 128) break;
      const lastKey = Array.from(legacyPage.keys()).at(-1)!;
      start = `${lastKey}\u0000`;
    }
    await txn.put(durableBudgetQuotaMigrationKey(), true);
  }
  const cutoff = now - limits.terminalRetentionMs;
  if (cutoff < 0) return;
  const prefix = "durable-budget:terminal:";
  const end = `${prefix}${(cutoff + 1).toString().padStart(16, "0")}`;
  const expired = await txn.list<string>({ prefix, end, limit: 128 });
  for (const [terminalKey, key] of expired) {
    const record = await txn.get<DurableBudgetRecord>(
      durableBudgetRecordKey(key),
    );
    if (
      !record ||
      record.terminalAt === undefined ||
      record.terminalAt > cutoff
    ) {
      await txn.delete(terminalKey);
      continue;
    }
    if (record.safelyReleased) {
      if (record.paymentIdentifier) {
        const reservation = await txn.get<PaymentIdentifierReservationRecord>(
          paymentIdentifierReservationKey(record.paymentIdentifier),
        );
        if (
          reservation?.status === "safely-released" &&
          reservation.ownerId === record.attemptId
        ) {
          await txn.delete(
            paymentIdentifierReservationKey(record.paymentIdentifier),
          );
        }
      }
      await deleteDurableBudget(txn, key);
      await txn.delete(terminalKey);
      continue;
    }
    if (record.kind === "batch") {
      await txn.delete(batchAttemptKey(record.attemptId));
      if (record.commitmentId) {
        const commitment = await txn.get<BatchCommitmentRecord>(
          commitmentKey(record.commitmentId),
        );
        if (commitment)
          await txn.put(commitmentKey(record.commitmentId), {
            ...commitment,
            response: expiredReplayResponse(),
          });
      }
    } else {
      await txn.delete(exactAttemptKey(record.attemptId));
      const payment = await txn.get<ExactPaymentRecord>(
        exactPaymentKey(record.attemptId),
      );
      if (payment)
        await txn.put(exactPaymentKey(record.attemptId), {
          ...payment,
          response: expiredReplayResponse(),
        });
    }
    if (record.paymentIdentifier) {
      const paymentIdentifier = await txn.get<PaymentIdentifierRecord>(
        paymentIdentifierKey(record.paymentIdentifier),
      );
      if (paymentIdentifier)
        await txn.put(paymentIdentifierKey(record.paymentIdentifier), {
          ...paymentIdentifier,
          response: expiredReplayResponse(),
        });
    }
    // Keep the compact payment/commitment records as replay tombstones, but
    // release active record, byte, and per-payer admission capacity.
    await deleteDurableBudget(txn, key);
  }
}

function expiredReplayResponse() {
  return {
    status: 409,
    headers: {},
    body: { error: "replay_record_retained" },
  };
}

function assertDurableStateLimits(limits: GatewayDurableStateLimits): void {
  for (const [value, label] of [
    [limits.maxRecords, "record limit"],
    [limits.maxBytes, "byte limit"],
    [limits.maxRecordsPerPayer, "per-payer record limit"],
    [limits.maxExactHeads, "exact head limit"],
    [limits.terminalRetentionMs, "terminal retention"],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`durable state ${label} must be a positive safe integer`);
  }
}

function assertPublicAdmissionInput(
  token: string,
  callerKey: string,
  nowMs: number,
  globalLimit: number,
  callerLimit: number,
  ttlMs: number,
): void {
  assertPublicAdmissionLeaseInput(token, callerKey, nowMs, ttlMs);
  if (
    !Number.isSafeInteger(globalLimit) ||
    globalLimit < 1 ||
    globalLimit > MAX_PUBLIC_ADMISSION_LEASES
  )
    throw new Error("public admission limit must be between 1 and 256");
  if (!Number.isSafeInteger(callerLimit) || callerLimit < 1 || callerLimit > globalLimit)
    throw new Error("public caller admission limit must be between 1 and global limit");
}

function assertPublicAdmissionLeaseInput(
  token: string,
  callerKey: string,
  nowMs: number,
  ttlMs: number,
): void {
  assertPublicAdmissionToken(token);
  if (!/^[0-9a-f]{64}$/.test(callerKey))
    throw new Error("public admission caller key must be opaque hex");
  if (!Number.isSafeInteger(nowMs) || nowMs < 0)
    throw new Error(
      "public admission time must be a non-negative safe integer",
    );
  if (
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1 ||
    ttlMs > MAX_PUBLIC_ADMISSION_TTL_MS
  )
    throw new Error("public admission TTL must be between 1 and 600000 ms");
  if (!Number.isSafeInteger(nowMs + ttlMs))
    throw new Error("public admission expiry must be a safe integer");
}

function assertPublicAdmissionToken(token: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      token,
    )
  )
    throw new Error("public admission token must be a UUID");
}

function readPublicAdmissionLeases(
  state: PublicAdmissionState | undefined,
): Record<string, PublicAdmissionRecord> {
  if (state === undefined) return {};
  if (
    !state ||
    typeof state !== "object" ||
    !state.leases ||
    typeof state.leases !== "object"
  )
    throw new Error("public admission state is invalid");
  const entries = Object.entries(state.leases);
  if (entries.length > MAX_PUBLIC_ADMISSION_LEASES)
    throw new Error("public admission state exceeds its lease limit");
  const leases: Record<string, PublicAdmissionRecord> = {};
  for (const [token, lease] of entries) {
    assertPublicAdmissionToken(token);
    if (!lease || !Number.isSafeInteger(lease.expiresAt) || lease.expiresAt < 0 ||
        typeof lease.callerKey !== "string" || !/^[0-9a-f]{64}$/.test(lease.callerKey))
      throw new Error("public admission lease is invalid");
    leases[token] = { expiresAt: lease.expiresAt, callerKey: lease.callerKey };
  }
  return leases;
}

function cloneOrUndefined<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : clone(value);
}

async function requireBatchAttempt(
  txn: GatewayTransaction,
  attemptId: string,
): Promise<BatchSettlementAttemptRecord> {
  const attempt = await txn.get<BatchSettlementAttemptRecord>(
    batchAttemptKey(attemptId),
  );
  if (!attempt) throw new Error("batch settlement attempt was not found");
  return attempt;
}

function assertIsoDate(value: string, label: string): void {
  if (Number.isNaN(Date.parse(value)))
    throw new Error(`${label} must be an ISO date string`);
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

function isLowerHash32(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function isNonzeroLowerHash32(value: string): boolean {
  return isLowerHash32(value) && !/^0{64}$/.test(value);
}

function assertPnnTransactionId(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("invalid PNN evidence transaction id");
}

function assertPnnEvidenceBudget(budget: PnnEvidenceBudget): void {
  if (![budget.records, budget.bytes, budget.reservedBytes].every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  ) || budget.records > MAX_PNN_EVIDENCE_RECORDS ||
      budget.bytes + budget.reservedBytes > MAX_PNN_EVIDENCE_TOTAL_BYTES)
    throw new Error("PNN evidence budget is invalid");
}
