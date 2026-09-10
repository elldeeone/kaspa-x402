import {
  KASPA_X402_RESOURCE_BUDGET,
  applyBatchClaimAccounting,
  batchLaneAccounting,
  parseBatchLaneAmount,
  parseSompiString,
  sha256Hex,
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
import {
  acceptExactHead,
  applyExactHeadLineage as applyExactHeadLineageRecord,
  assertServerChannelLineageConsistency,
  assertServerCovenantLineageExtension,
  assertServerCovenantJournalExtension,
  sameCovenantLineage,
  assertBatchDepositTransition,
  assertBatchHandlerResultTransition,
  batchSettlementAttemptIsReadyToCommit,
  batchSettlementAttemptsMatch,
  claimAttemptsMatch,
  claimExactHead,
  exactHeadMatchesSelection,
  exactSettlementAttemptsMatch,
  normalizeExactHeadRecord,
  normalizeExactSettlementAttempt,
  normalizeBatchSettlementAttempt,
  normalizeClaimAttempt,
  releaseExactHeadClaim,
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
};

type PublicAdmissionState = {
  leases: Record<string, PublicAdmissionRecord>;
};

export interface GatewayPublicAdmissionResult {
  allowed: boolean;
  active: number;
  retryAt?: number;
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

const MAX_RATE_SCOPES_PER_WINDOW = 1_024;
const MAX_PUBLIC_ADMISSION_LEASES = 256;
const MAX_PUBLIC_ADMISSION_TTL_MS = 10 * 60 * 1_000;
const MAX_DURABLE_HANDLER_RESULT_BYTES = 256 * 1024;
const MAX_DURABLE_RESPONSE_BYTES =
  MAX_DURABLE_HANDLER_RESULT_BYTES +
  KASPA_X402_RESOURCE_BUDGET.maxEncodedHeaderBytes +
  1024;
export const GATEWAY_COORDINATION_DOMAIN = "demo-gateway-state:alpha.11";
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
  | "metrics";

export interface GatewayStateRequest {
  method: GatewayStateMethod;
  payload?: unknown;
}

export class GatewayLedger implements ServerStateStore {
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
      await reservePaymentIdentifier(
        txn,
        attempt.paymentIdentifier,
        attempt.createdAt,
      );
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
      await updatePaymentIdentifierReservation(txn, attempt.paymentIdentifier, {
        status: "pending",
        updatedAt: startedAt,
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
      await updatePaymentIdentifierReservation(txn, attempt.paymentIdentifier, {
        status: "pending",
        recoveryReason: undefined,
        updatedAt: completedAt,
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
      await updatePaymentIdentifierReservation(txn, attempt.paymentIdentifier, {
        status: "recovery-required",
        recoveryReason: reason,
        updatedAt: observedAt,
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
      await releasePaymentIdentifierReservation(
        txn,
        attempt.paymentIdentifier,
        reason,
        observedAt,
      );
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
    const record = normalizeExactHeadRecord(input);
    return this.#storage.transaction(async (txn) => {
      const existing = await txn.get<ExactHeadRecord>(
        exactHeadKey(record.headId),
      );
      if (existing) {
        if (stableJson(existing) !== stableJson(record))
          throw new Error(
            "exact head id is already registered for different state",
          );
        // Re-registering an unchanged pre-alpha.8 head also repairs its
        // bounded selection index without changing the head itself.
        await putExactHead(txn, existing, existing);
        return clone(existing);
      }
      const heads = await txn.list<ExactHeadRecord>({ prefix: "exact-head:" });
      if (heads.size >= this.#limits.maxExactHeads) {
        throw new Error("exact head admission limit exceeded");
      }
      for (const current of heads.values()) {
        if (sameOutpoint(current.currentOutpoint, record.currentOutpoint))
          throw new Error("exact head outpoint is already registered");
      }
      await putExactHead(txn, undefined, record);
      return clone(record);
    });
  }

  async loadExactHead(headId: string): Promise<ExactHeadRecord | undefined> {
    return cloneOrUndefined(
      await this.#storage.get<ExactHeadRecord>(exactHeadKey(headId)),
    );
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

  async exactHeadStats(): Promise<ExactHeadStats> {
    return this.#storage.transaction(async (txn) => {
      const stats = await loadOrRebuildExactHeadStats(txn);
      await txn.put(exactHeadStatsKey(), stats);
      return clone(stats);
    });
  }

  async selectExactHead(
    request: ExactHeadSelectionRequest,
  ): Promise<ExactHeadRecord | undefined> {
    return this.#storage.transaction(async (txn) => {
      const range = exactHeadSelectionIndexRange(request);
      const indexed = await txn.list<ExactHeadSelectionIndexRecord>({
        prefix: range.prefix,
        start: range.start,
        end: range.end,
        limit: EXACT_HEAD_SELECTION_WINDOW,
      });
      const candidates: ExactHeadRecord[] = [];
      for (const entry of indexed.values()) {
        const head = await txn.get<ExactHeadRecord>(exactHeadKey(entry.headId));
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
    const attempt = normalizeExactSettlementAttempt(input);
    await this.#storage.transaction((txn) =>
      pruneTerminalDurableBudgets(txn, this.#limits, this.#now()),
    );
    return this.#storage.transaction(async (txn) => {
      const existing = await txn.get<ExactSettlementAttemptRecord>(
        exactAttemptKey(attempt.transactionId),
      );
      if (existing) {
        if (!exactSettlementAttemptsMatch(existing, attempt))
          throw new Error(
            "exact transaction is already claimed for a different request",
          );
        return { attempt: clone(existing), created: false };
      }
      await assertPaymentIdentifierClaimAvailable(
        txn,
        attempt.paymentIdentifier,
      );
      await reclaimSafelyReleasedPaymentIdentifier(
        txn,
        attempt.paymentIdentifier,
      );
      await admitDurableBudget(txn, this.#limits, this.#now(), {
        key: `exact:${attempt.transactionId}`,
        kind: "exact",
        attemptId: attempt.transactionId,
        payerId: attempt.payerId,
        bytes: durableOpenRecordBytes(attempt),
        ...(attempt.paymentIdentifier
          ? { paymentIdentifier: attempt.paymentIdentifier.id }
          : {}),
      });
      if (attempt.profile === "additive") {
        if (!attempt.head)
          throw new Error("additive exact settlement requires a head claim");
        const head = await txn.get<ExactHeadRecord>(
          exactHeadKey(attempt.head.headId),
        );
        if (!head)
          throw new Error("exact head changed before settlement claim");
        await putExactHead(txn, head, claimExactHead(head, attempt));
      } else if (attempt.head) {
        throw new Error("standard-native exact settlement cannot claim a head");
      }
      await reservePaymentIdentifier(
        txn,
        attempt.paymentIdentifier,
        attempt.createdAt,
      );
      await txn.put(exactAttemptKey(attempt.transactionId), clone(attempt));
      return { attempt: clone(attempt), created: true };
    });
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
    await this.#storage.transaction(async (txn) => {
      const attempt = await requireExactAttempt(txn, transactionId);
      if (attempt.status === "accepted" || attempt.status === "applied") return;
      await txn.put(exactAttemptKey(attempt.transactionId), {
        ...attempt,
        status: "broadcast",
        finality,
        updatedAt: observedAt,
      });
      await updatePaymentIdentifierReservation(txn, attempt.paymentIdentifier, {
        status: "pending",
        updatedAt: observedAt,
      });
    });
  }

  async acceptExactSettlement(
    transactionId: string,
    finality: "accepted" | "confirmed",
    observedAt: string,
  ): Promise<void> {
    await this.#storage.transaction(async (txn) => {
      const attempt = await requireExactAttempt(txn, transactionId);
      if (attempt.status === "applied") return;
      if (attempt.head) {
        const head = await txn.get<ExactHeadRecord>(
          exactHeadKey(attempt.head.headId),
        );
        if (!head)
          throw new Error(
            "exact head was not found during settlement acceptance",
          );
        await putExactHead(
          txn,
          head,
          acceptExactHead(head, attempt, observedAt),
        );
      }
      await txn.put(exactAttemptKey(attempt.transactionId), {
        ...attempt,
        status: "accepted",
        finality,
        updatedAt: observedAt,
      });
      await updatePaymentIdentifierReservation(txn, attempt.paymentIdentifier, {
        status: "pending",
        updatedAt: observedAt,
      });
    });
  }

  async beginExactHandler(
    transactionId: string,
    startedAt: string,
  ): Promise<boolean> {
    return this.#storage.transaction(async (txn) => {
      const attempt = await requireExactAttempt(txn, transactionId);
      if (attempt.status !== "accepted" || attempt.handlerStartedAt)
        return false;
      await txn.put(exactAttemptKey(attempt.transactionId), {
        ...attempt,
        handlerStartedAt: startedAt,
        updatedAt: startedAt,
      });
      await updatePaymentIdentifierReservation(txn, attempt.paymentIdentifier, {
        status: "pending",
        updatedAt: startedAt,
      });
      return true;
    });
  }

  async recordExactHandlerResult(
    transactionId: string,
    result: ProtectedHandlerResult,
    completedAt: string,
  ): Promise<void> {
    await this.#storage.transaction(async (txn) => {
      const attempt = await requireExactAttempt(txn, transactionId);
      assertExactHandlerResultTransition(attempt, result, completedAt);
      if (attempt.handlerResult) {
        if (stableJson(attempt.handlerResult) !== stableJson(result))
          throw new Error("exact handler result conflicts with durable state");
        return;
      }
      await txn.put(exactAttemptKey(attempt.transactionId), {
        ...attempt,
        handlerResult: clone(result),
        handlerCompletedAt: completedAt,
        recoveryReason: undefined,
        updatedAt: completedAt,
      });
      await updatePaymentIdentifierReservation(txn, attempt.paymentIdentifier, {
        status: "pending",
        recoveryReason: undefined,
        updatedAt: completedAt,
      });
    });
  }

  async markExactHandlerRecoveryRequired(
    transactionId: string,
    reason: string,
    observedAt: string,
  ): Promise<void> {
    await this.#storage.transaction(async (txn) => {
      const attempt = await requireExactAttempt(txn, transactionId);
      if (
        attempt.status !== "accepted" ||
        !attempt.handlerStartedAt ||
        attempt.handlerResult
      ) {
        throw new Error("exact handler is not awaiting recovery");
      }
      await txn.put(exactAttemptKey(attempt.transactionId), {
        ...attempt,
        recoveryReason: reason,
        updatedAt: observedAt,
      });
      await updatePaymentIdentifierReservation(txn, attempt.paymentIdentifier, {
        status: "recovery-required",
        recoveryReason: reason,
        updatedAt: observedAt,
      });
    });
  }

  async abandonExactSettlement(
    transactionId: string,
    reason: string,
    observedAt: string,
  ): Promise<void> {
    await this.#storage.transaction(async (txn) => {
      const attempt = await requireExactAttempt(txn, transactionId);
      if (attempt.status === "accepted" || attempt.status === "applied")
        throw new Error("accepted exact settlement cannot be abandoned");
      if (
        attempt.handlerStartedAt ||
        attempt.handlerResult ||
        attempt.recoveryReason
      )
        throw new Error("uncertain exact settlement cannot be abandoned");
      if (attempt.head) {
        const head = await txn.get<ExactHeadRecord>(
          exactHeadKey(attempt.head.headId),
        );
        if (head)
          await putExactHead(
            txn,
            head,
            releaseExactHeadClaim(head, attempt, observedAt),
          );
      }
      await txn.delete(exactAttemptKey(attempt.transactionId));
      await releasePaymentIdentifierReservation(
        txn,
        attempt.paymentIdentifier,
        reason,
        observedAt,
        true,
      );
      if (attempt.paymentIdentifier) {
        await terminalizeDurableBudget(
          txn,
          `exact:${attempt.transactionId}`,
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
        await deleteDurableBudget(txn, `exact:${attempt.transactionId}`);
      }
    });
  }

  async markExactHeadUnavailable(
    input: ExactHeadUnavailableApply,
  ): Promise<ExactHeadUnavailableResult> {
    return this.#storage.transaction(async (txn) => {
      const head = await txn.get<ExactHeadRecord>(exactHeadKey(input.headId));
      if (!head) throw new Error("exact head was not found");
      if (head.status === "retired")
        throw new Error("retired exact head cannot be marked unavailable");
      if (
        head.version !== input.expectedVersion ||
        !sameOutpoint(head.currentOutpoint, input.expectedOutpoint) ||
        head.currentAmount !== input.expectedAmount ||
        head.status !== input.expectedStatus
      ) {
        return { applied: false, head: clone(head) };
      }
      const unavailable = {
        ...head,
        status: "unavailable",
        unavailableReason: input.reason,
        updatedAt: input.observedAt,
      } as const;
      await putExactHead(txn, head, unavailable);
      return { applied: true, head: clone(unavailable) };
    });
  }

  async applyExactHeadLineage(
    input: ExactHeadLineageApply,
  ): Promise<ExactHeadRecord> {
    return this.#storage.transaction(async (txn) => {
      const head = await txn.get<ExactHeadRecord>(exactHeadKey(input.headId));
      if (!head) throw new Error("exact head was not found");
      const advanced = applyExactHeadLineageRecord(head, input);
      await putExactHead(txn, head, advanced);
      return clone(advanced);
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
        await completePaymentIdentifierReservation(
          txn,
          attempt.paymentIdentifier!,
          attempt.updatedAt,
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
    await this.#storage.transaction(async (txn) => {
      const payment = clone(record.payment);
      const existing = await txn.get<ExactPaymentRecord>(
        exactPaymentKey(payment.transactionId),
      );
      if (existing) {
        if (
          existing.requestFingerprint !== payment.requestFingerprint ||
          existing.paymentPayloadHash !== payment.paymentPayloadHash ||
          existing.paymentOutputIndex !== payment.paymentOutputIndex
        ) {
          throw new Error(
            "exact payment transaction was already committed for a different request",
          );
        }
        return;
      }
      const attempt = await txn.get<ExactSettlementAttemptRecord>(
        exactAttemptKey(payment.transactionId),
      );
      if (record.paymentIdentifier) {
        if (!attempt)
          throw new Error(
            "payment identifier completion requires its reserved attempt",
          );
        await assertCompletedPaymentIdentifier(
          txn,
          attempt,
          record.paymentIdentifier,
        );
      }
      let appliedAttempt: ExactSettlementAttemptRecord | undefined;
      if (attempt) {
        if (
          attempt.status !== "accepted" ||
          !attempt.handlerStartedAt ||
          !attempt.handlerResult
        )
          throw new Error("exact settlement attempt is not ready to apply");
        const {
          handlerResult: _handlerResult,
          handlerCompletedAt: _handlerCompletedAt,
          ...compactAttempt
        } = attempt;
        appliedAttempt = {
          ...compactAttempt,
          status: "applied",
          transaction: "",
          recoveryReason: undefined,
          updatedAt: new Date().toISOString(),
        };
        await txn.put(exactAttemptKey(payment.transactionId), appliedAttempt);
      }
      if (record.paymentIdentifier) {
        await txn.put(
          paymentIdentifierKey(record.paymentIdentifier.id),
          clone(record.paymentIdentifier),
        );
        await completePaymentIdentifierReservation(
          txn,
          attempt!.paymentIdentifier!,
          new Date().toISOString(),
        );
      }
      await txn.put(exactPaymentKey(payment.transactionId), payment);
      if (attempt)
        await terminalizeDurableBudget(
          txn,
          `exact:${attempt.transactionId}`,
          durableByteLength({
            attempt: appliedAttempt,
            payment,
            paymentIdentifier: record.paymentIdentifier,
          }),
          this.#now(),
          undefined,
          record.paymentIdentifier?.id,
        );
    });
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
    nowMs: number,
    limit: number,
    ttlMs: number,
  ): Promise<GatewayPublicAdmissionResult> {
    assertPublicAdmissionInput(token, nowMs, limit, ttlMs);
    return this.#storage.transaction(async (txn) => {
      const key = publicAdmissionKey();
      const stored = await txn.get<PublicAdmissionState>(key);
      const leases = readPublicAdmissionLeases(stored);
      for (const [leaseToken, lease] of Object.entries(leases)) {
        if (lease.expiresAt <= nowMs) delete leases[leaseToken];
      }

      const existing = leases[token];
      if (existing) {
        existing.expiresAt = nowMs + ttlMs;
        await txn.put(key, { leases });
        return { allowed: true, active: Object.keys(leases).length };
      }

      const active = Object.keys(leases).length;
      if (active >= limit) {
        return {
          allowed: false,
          active,
          retryAt: Math.min(
            ...Object.values(leases).map((lease) => lease.expiresAt),
          ),
        };
      }

      leases[token] = { expiresAt: nowMs + ttlMs };
      await txn.put(key, { leases });
      return { allowed: true, active: active + 1 };
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
  ): Promise<string> {
    const current = parseSompiString(currentDaa);
    const delta = parseSompiString(refundDeltaDaa);
    const minimumLead = parseSompiString(minimumLeadDaa);
    if (delta <= minimumLead)
      throw new Error("refund DAA delta must exceed minimum lead");
    const next = current + delta;
    return this.#storage.transaction(async (txn) => {
      const key = batchRefundTimeoutKey();
      const stored = await txn.get<string>(key);
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

export type GatewayStateClient = ServerStateStore & {
  exactHeadStats(): Promise<ExactHeadStats>;
  acquireLock(
    key: string,
    token: string,
    nowMs: number,
    ttlMs: number,
  ): Promise<boolean>;
  releaseLock(key: string, token: string): Promise<void>;
  acquirePublicAdmission(
    token: string,
    nowMs: number,
    limit: number,
    ttlMs: number,
  ): Promise<GatewayPublicAdmissionResult>;
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
  ): Promise<string>;
  loadCanaryReport(): Promise<GatewayCanaryReport | undefined>;
  saveCanaryReport(report: GatewayCanaryReport): Promise<void>;
  incrementMetric(name: string, amount?: number): Promise<void>;
  metrics(): Promise<Record<string, number>>;
};

export async function dispatchGatewayState(
  ledger: GatewayLedger,
  request: GatewayStateRequest,
): Promise<unknown> {
  switch (request.method) {
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
      return ledger.exactHeadStats();
    case "selectExactHead":
      return ledger.selectExactHead(
        readPayload<{ request: ExactHeadSelectionRequest }>(request).request,
      );
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
      );
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
  assertPaymentIdentifierReservationClaim(claim);
  const existing = await txn.get<PaymentIdentifierRecord>(
    paymentIdentifierKey(claim.id),
  );
  if (
    existing &&
    (existing.fingerprint !== claim.fingerprint ||
      existing.paymentPayloadHash !== claim.paymentPayloadHash ||
      existing.paymentScopeId !== claim.paymentScopeId)
  )
    throw new Error("payment identifier is already owned by another payment");
  const reservation = await txn.get<PaymentIdentifierReservationRecord>(
    paymentIdentifierReservationKey(claim.id),
  );
  if (
    reservation &&
    reservation.status !== "safely-released" &&
    !paymentIdentifierReservationClaimsMatch(reservation, claim)
  )
    throw new Error("payment identifier is already owned by another payment");
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

async function reservePaymentIdentifier(
  txn: GatewayTransaction,
  claim: PaymentIdentifierReservationClaim | undefined,
  observedAt: string,
): Promise<void> {
  if (!claim) return;
  const existing = await txn.get<PaymentIdentifierReservationRecord>(
    paymentIdentifierReservationKey(claim.id),
  );
  if (existing && existing.status !== "safely-released") return;
  await txn.put(paymentIdentifierReservationKey(claim.id), {
    ...clone(claim),
    status: "reserved",
    createdAt: observedAt,
    updatedAt: observedAt,
  } satisfies PaymentIdentifierReservationRecord);
}

async function updatePaymentIdentifierReservation(
  txn: GatewayTransaction,
  claim: PaymentIdentifierReservationClaim | undefined,
  update: Pick<PaymentIdentifierReservationRecord, "status" | "updatedAt"> &
    Pick<Partial<PaymentIdentifierReservationRecord>, "recoveryReason">,
): Promise<void> {
  if (!claim) return;
  const existing = await txn.get<PaymentIdentifierReservationRecord>(
    paymentIdentifierReservationKey(claim.id),
  );
  if (!existing || !paymentIdentifierReservationClaimsMatch(existing, claim))
    throw new Error("payment identifier reservation ownership changed");
  if (existing.status === "completed" || existing.status === "safely-released")
    throw new Error("terminal payment identifier reservation cannot change");
  await txn.put(paymentIdentifierReservationKey(claim.id), {
    ...existing,
    ...update,
  });
}

async function completePaymentIdentifierReservation(
  txn: GatewayTransaction,
  claim: PaymentIdentifierReservationClaim,
  observedAt: string,
): Promise<void> {
  const existing = await txn.get<PaymentIdentifierReservationRecord>(
    paymentIdentifierReservationKey(claim.id),
  );
  if (!existing || !paymentIdentifierReservationClaimsMatch(existing, claim))
    throw new Error("payment identifier completion lost its reservation");
  if (existing.status === "safely-released")
    throw new Error("released payment identifier cannot be completed");
  await txn.put(paymentIdentifierReservationKey(claim.id), {
    ...existing,
    status: "completed",
    recoveryReason: undefined,
    updatedAt: observedAt,
  });
}

async function releasePaymentIdentifierReservation(
  txn: GatewayTransaction,
  claim: PaymentIdentifierReservationClaim | undefined,
  reason: string,
  observedAt: string,
  allowPending = false,
): Promise<void> {
  if (!claim) return;
  const existing = await txn.get<PaymentIdentifierReservationRecord>(
    paymentIdentifierReservationKey(claim.id),
  );
  if (!existing || !paymentIdentifierReservationClaimsMatch(existing, claim))
    throw new Error("payment identifier release lost its reservation");
  if (
    (existing.status !== "reserved" &&
      !(allowPending && existing.status === "pending")) ||
    existing.recoveryReason !== undefined
  )
    throw new Error(
      "uncertain or completed payment identifier cannot be released",
    );
  await txn.put(paymentIdentifierReservationKey(claim.id), {
    ...existing,
    status: "safely-released",
    recoveryReason: reason,
    updatedAt: observedAt,
  });
}

async function assertCompletedPaymentIdentifier(
  txn: GatewayTransaction,
  attempt:
    BatchSettlementAttemptRecord | ExactSettlementAttemptRecord | undefined,
  completed: PaymentIdentifierRecord | undefined,
): Promise<void> {
  const claim = attempt?.paymentIdentifier;
  if (!claim && !completed) return;
  if (
    !claim ||
    !completed ||
    claim.id !== completed.id ||
    claim.fingerprint !== completed.fingerprint ||
    claim.paymentPayloadHash !== completed.paymentPayloadHash ||
    claim.paymentScopeId !== completed.paymentScopeId ||
    claim.channelId !== completed.channelId ||
    claim.transactionId !== completed.transactionId ||
    claim.paymentOutputIndex !== completed.paymentOutputIndex
  )
    throw new Error("payment identifier completion does not match reservation");
  const reservation = await txn.get<PaymentIdentifierReservationRecord>(
    paymentIdentifierReservationKey(claim.id),
  );
  if (
    !reservation ||
    !paymentIdentifierReservationClaimsMatch(reservation, claim) ||
    reservation.status === "safely-released"
  )
    throw new Error("payment identifier completion lost its reservation");
  await assertPaymentIdentifierClaimAvailable(txn, claim);
}

function assertPaymentIdentifierReservationClaim(
  claim: PaymentIdentifierReservationClaim,
): void {
  if (
    typeof claim.id !== "string" ||
    claim.id.length === 0 ||
    claim.id.length > 256 ||
    typeof claim.payerId !== "string" ||
    claim.payerId.length === 0 ||
    claim.payerId.length > 256 ||
    !isLowerHash32(claim.fingerprint) ||
    !isLowerHash32(claim.paymentPayloadHash) ||
    !isLowerHash32(claim.paymentScopeId) ||
    !isLowerHash32(claim.ownerId)
  )
    throw new Error("payment identifier reservation is invalid");
  if (claim.paymentKind === "batch-settlement") {
    if (
      !claim.channelId ||
      claim.transactionId ||
      claim.paymentOutputIndex !== undefined
    )
      throw new Error("batch payment identifier ownership is invalid");
  } else if (claim.paymentKind === "exact") {
    if (
      !claim.transactionId ||
      claim.channelId ||
      !Number.isInteger(claim.paymentOutputIndex) ||
      claim.paymentOutputIndex! < 0
    )
      throw new Error("exact payment identifier ownership is invalid");
  } else throw new Error("payment identifier kind is invalid");
}

function paymentIdentifierReservationClaimsMatch(
  left: PaymentIdentifierReservationClaim,
  right: PaymentIdentifierReservationClaim,
): boolean {
  const project = (value: PaymentIdentifierReservationClaim) => ({
    id: value.id,
    fingerprint: value.fingerprint,
    paymentPayloadHash: value.paymentPayloadHash,
    paymentScopeId: value.paymentScopeId,
    paymentKind: value.paymentKind,
    ownerId: value.ownerId,
    payerId: value.payerId,
    channelId: value.channelId,
    transactionId: value.transactionId,
    paymentOutputIndex: value.paymentOutputIndex,
  });
  return stableJson(project(left)) === stableJson(project(right));
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
    const compactBytes = durableByteLength({
      attemptId: record.attemptId,
      payment: await txn.get(exactPaymentKey(record.attemptId)),
      commitment: record.commitmentId
        ? await txn.get(commitmentKey(record.commitmentId))
        : undefined,
      paymentIdentifier: record.paymentIdentifier
        ? await txn.get(paymentIdentifierKey(record.paymentIdentifier))
        : undefined,
    });
    const meta = await txn.get<DurableBudgetMeta>(durableBudgetMetaKey());
    if (!meta) throw new Error("durable budget metadata is missing");
    await txn.put(durableBudgetRecordKey(key), {
      ...record,
      bytes: compactBytes,
      compactedAt: now,
    } satisfies DurableBudgetRecord);
    await txn.put(durableBudgetMetaKey(), {
      ...meta,
      bytes: meta.bytes + compactBytes - record.bytes,
    });
    await txn.delete(terminalKey);
  }
}

function durableByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function durableOpenRecordBytes(value: unknown): number {
  return durableByteLength(value) + 2 * MAX_DURABLE_RESPONSE_BYTES;
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
  nowMs: number,
  limit: number,
  ttlMs: number,
): void {
  assertPublicAdmissionToken(token);
  if (!Number.isSafeInteger(nowMs) || nowMs < 0)
    throw new Error("public admission time must be a non-negative safe integer");
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_PUBLIC_ADMISSION_LEASES
  )
    throw new Error("public admission limit must be between 1 and 256");
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
    if (
      !lease ||
      !Number.isSafeInteger(lease.expiresAt) ||
      lease.expiresAt < 0
    )
      throw new Error("public admission lease is invalid");
    leases[token] = { expiresAt: lease.expiresAt };
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

async function requireExactAttempt(
  txn: GatewayTransaction,
  transactionId: string,
): Promise<ExactSettlementAttemptRecord> {
  const attempt = await txn.get<ExactSettlementAttemptRecord>(
    exactAttemptKey(transactionId),
  );
  if (!attempt) throw new Error("exact settlement attempt was not found");
  return attempt;
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

function assertExactHandlerResultTransition(
  attempt: ExactSettlementAttemptRecord,
  result: ProtectedHandlerResult,
  completedAt: string,
): void {
  if (attempt.status !== "accepted" || !attempt.handlerStartedAt)
    throw new Error("exact handler has not started on an accepted settlement");
  if (Number.isNaN(Date.parse(completedAt)))
    throw new Error("exact handler completion time must be an ISO date string");
  if (
    result.status !== undefined &&
    (!Number.isInteger(result.status) ||
      result.status < 100 ||
      result.status > 599)
  ) {
    throw new Error("exact handler status is invalid");
  }
  if (
    result.headers &&
    Object.values(result.headers).some((value) => typeof value !== "string")
  ) {
    throw new Error("exact handler headers are invalid");
  }
  if (result.headers && Object.keys(result.headers).length > 64)
    throw new Error("exact handler has too many response headers");
  let serialized: string;
  try {
    serialized = JSON.stringify(result);
  } catch {
    throw new Error("exact handler result must be JSON serializable");
  }
  if (
    new TextEncoder().encode(serialized).byteLength >
    MAX_DURABLE_HANDLER_RESULT_BYTES
  )
    throw new Error("exact handler result exceeds the durable size limit");
  if (
    result.chargedAmount !== undefined &&
    result.chargedAmount !== attempt.amount
  ) {
    throw new Error("exact handler charge must equal the accepted amount");
  }
}
