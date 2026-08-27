import { parseSompiString, sha256Hex } from "@kaspa-x402/core";
import type {
  BatchCommitmentRecord,
  BatchSettlementAttemptRecord,
  BatchSettlementClaimResult,
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
  ProtectedHandlerResult,
  ServerChannelRecord,
  ServerStateStore,
  SettlementCommit,
} from "@kaspa-x402/server";
import {
  acceptExactHead,
  applyExactHeadLineage as applyExactHeadLineageRecord,
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

type PaymentIdentifierReservation = {
  attemptId: string;
  fingerprint: string;
  paymentEvidenceHash: string;
  channelId: string;
};

type RateWindowRecord = {
  resetAt: number;
  counts: Record<string, { count: number; lastSeenAt: number }>;
};

const MAX_RATE_SCOPES_PER_WINDOW = 1_024;

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
  | "saveChannel"
  | "retireChannel"
  | "listChannels"
  | "loadCommitment"
  | "claimBatchSettlement"
  | "loadBatchSettlementAttempt"
  | "beginBatchHandler"
  | "recordBatchHandlerResult"
  | "markBatchHandlerRecoveryRequired"
  | "loadPaymentIdentifier"
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
  | "renewLock"
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
  readonly #storage: GatewayStorage;

  constructor(storage: GatewayStorage) {
    this.#storage = storage;
  }

  async loadChannel(
    channelId: string,
  ): Promise<ServerChannelRecord | undefined> {
    return cloneOrUndefined(
      await this.#storage.get<ServerChannelRecord>(channelKey(channelId)),
    );
  }

  async saveChannel(channel: ServerChannelRecord): Promise<void> {
    await this.#storage.transaction(async (txn) => {
      await putChannel(txn, channel);
    });
  }

  async retireChannel(channelId: string): Promise<void> {
    await this.#storage.transaction(async (txn) => {
      const channel = await txn.get<ServerChannelRecord>(channelKey(channelId));
      if (!channel) return;
      await txn.put(channelKey(channelId), {
        ...clone(channel),
        status: "retired",
      });
    });
  }

  async listChannels(): Promise<ServerChannelRecord[]> {
    return Array.from(
      (
        await this.#storage.list<ServerChannelRecord>({ prefix: "channel:" })
      ).values(),
    ).map(clone);
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
      const currentChannel = await txn.get<ServerChannelRecord>(
        channelKey(attempt.channelId),
      );
      if (
        attempt.prior
          ? !currentChannel || !matchesExpectedChannel(currentChannel, attempt.prior)
          : currentChannel !== undefined
      ) {
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
      if (attempt.paymentIdentifier) {
        if (
          await txn.get<PaymentIdentifierRecord>(
            paymentIdentifierKey(attempt.paymentIdentifier),
          )
        )
          throw new Error("payment identifier was already committed");
        const reserved = await txn.get<PaymentIdentifierReservation>(
          paymentIdentifierReservationKey(attempt.paymentIdentifier),
        );
        if (reserved && reserved.attemptId !== attempt.attemptId)
          throw new Error("payment identifier is already reserved");
        await txn.put(
          paymentIdentifierReservationKey(attempt.paymentIdentifier),
          {
            attemptId: attempt.attemptId,
            fingerprint: attempt.requestFingerprint,
            paymentEvidenceHash: attempt.paymentEvidenceHash,
            channelId: attempt.channelId,
          },
        );
      }
      await putChannel(txn, attempt.adoptedChannel);
      await txn.put(batchAttemptKey(attempt.attemptId), clone(attempt));
      await txn.put(openBatchAttemptKey(attempt.channelId), attempt.attemptId);
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
      void reason;
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
      if (record.paymentIdentifier) {
        await assertPaymentIdentifierAvailable(
          txn,
          record.paymentIdentifier,
          attempt.attemptId,
        );
        const reserved = await txn.get<PaymentIdentifierReservation>(
          paymentIdentifierReservationKey(record.paymentIdentifier.id),
        );
        if (!reserved || reserved.attemptId !== attempt.attemptId)
          throw new Error("payment identifier is not reserved by this batch attempt");
      }
      await putChannel(txn, record.channel);
      await txn.put(
        commitmentKey(record.commitment.commitmentId),
        clone(record.commitment),
      );
      if (record.paymentIdentifier) {
        await txn.put(
          paymentIdentifierKey(record.paymentIdentifier.id),
          clone(record.paymentIdentifier),
        );
        await txn.delete(
          paymentIdentifierReservationKey(record.paymentIdentifier.id),
        );
      }
      await txn.put(batchAttemptKey(attempt.attemptId), {
        ...attempt,
        status: "applied",
        updatedAt: new Date().toISOString(),
      });
      await txn.delete(openBatchAttemptKey(attempt.channelId));
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
      if (record.paymentIdentifier)
        await assertPaymentIdentifierAvailable(txn, record.paymentIdentifier);
      const attempt = await txn.get<ExactSettlementAttemptRecord>(
        exactAttemptKey(payment.transactionId),
      );
      if (attempt) {
        if (
          attempt.status !== "accepted" ||
          !attempt.handlerStartedAt ||
          !attempt.handlerResult
        )
          throw new Error("exact settlement attempt is not ready to apply");
        await txn.put(exactAttemptKey(payment.transactionId), {
          ...attempt,
          status: "applied",
          updatedAt: new Date().toISOString(),
        });
      }
      if (record.paymentIdentifier)
        await txn.put(
          paymentIdentifierKey(record.paymentIdentifier.id),
          clone(record.paymentIdentifier),
        );
      await txn.put(exactPaymentKey(payment.transactionId), payment);
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
      await txn.put(claimAttemptKey(attempt.attemptId), attempt);
      await txn.put(openClaimKey(attempt.channelId), attempt.attemptId);
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
      const currentChannel = await txn.get<ServerChannelRecord>(
        channelKey(channel.channelId),
      );
      if (!matchesClaimSnapshot(currentChannel, currentAttempt)) {
        throw new Error("channel state changed before claim apply");
      }
      await putChannel(txn, channel);
      await txn.put(claimAttemptKey(currentAttempt.attemptId), {
        ...clone(currentAttempt),
        status: "applied",
      });
      await txn.delete(openClaimKey(currentAttempt.channelId));
    });
  }

  async abandonClaimAttempt(attemptId: string): Promise<void> {
    await this.#storage.transaction(async (txn) => {
      const current = await txn.get<ClaimAttemptRecord>(
        claimAttemptKey(attemptId),
      );
      if (!current || current.status === "applied") return;
      await txn.delete(claimAttemptKey(attemptId));
      await txn.delete(openClaimKey(current.channelId));
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

  async renewLock(
    key: string,
    token: string,
    nowMs: number,
    ttlMs: number,
  ): Promise<boolean> {
    return this.#storage.transaction(async (txn) => {
      const current = await txn.get<LockRecord>(lockKey(key));
      if (!current || current.token !== token || current.expiresAt <= nowMs)
        return false;
      await txn.put(lockKey(key), { token, expiresAt: nowMs + ttlMs });
      return true;
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
    const key = rateWindowKey(scope);
    const scopeHash = sha256Hex(scope);
    return this.#storage.transaction(async (txn) => {
      const stored = await txn.get<RateWindowRecord>(key);
      const current =
        stored && stored.resetAt >= resetAt
          ? stored
          : { resetAt, counts: {} };
      const previous = current.counts[scopeHash];
      if (
        previous === undefined &&
        Object.keys(current.counts).length >= MAX_RATE_SCOPES_PER_WINDOW
      ) {
        const oldest = Object.entries(current.counts).sort(
          ([leftHash, left], [rightHash, right]) =>
            left.lastSeenAt - right.lastSeenAt ||
            leftHash.localeCompare(rightHash),
        )[0];
        if (oldest) delete current.counts[oldest[0]];
      }
      const count = (previous?.count ?? 0) + 1;
      current.counts[scopeHash] = { count, lastSeenAt: nowMs };
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
    let lost = false;
    let renewal = Promise.resolve();
    const heartbeat = setInterval(() => {
      renewal = renewal.then(async () => {
        if (
          !(await this.#state.renewLock(
            channelId,
            token,
            Date.now(),
            this.#ttlMs,
          ))
        )
          lost = true;
      });
    }, Math.max(10, Math.floor(this.#ttlMs / 3)));
    try {
      const result = await fn();
      clearInterval(heartbeat);
      await renewal;
      if (lost) throw new Error("gateway lock lease was lost during protected work");
      return result;
    } finally {
      clearInterval(heartbeat);
      await renewal;
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
  renewLock(
    key: string,
    token: string,
    nowMs: number,
    ttlMs: number,
  ): Promise<boolean>;
  releaseLock(key: string, token: string): Promise<void>;
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
    case "saveChannel":
      return ledger.saveChannel(
        readPayload<{ channel: ServerChannelRecord }>(request).channel,
      );
    case "retireChannel":
      return ledger.retireChannel(
        readPayload<{ channelId: string }>(request).channelId,
      );
    case "listChannels":
      return ledger.listChannels();
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
    case "loadPaymentIdentifier":
      return ledger.loadPaymentIdentifier(
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
    case "renewLock": {
      const payload = readPayload<{
        key: string;
        token: string;
        nowMs: number;
        ttlMs: number;
      }>(request);
      return ledger.renewLock(
        payload.key,
        payload.token,
        payload.nowMs,
        payload.ttlMs,
      );
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

async function assertPaymentIdentifierAvailable(
  txn: GatewayTransaction,
  paymentIdentifier: PaymentIdentifierRecord,
  reservedAttemptId?: string,
): Promise<void> {
  const reserved = await txn.get<PaymentIdentifierReservation>(
    paymentIdentifierReservationKey(paymentIdentifier.id),
  );
  if (reserved && reserved.attemptId !== reservedAttemptId)
    throw new Error("payment identifier is reserved by pending batch work");
  const existing = await txn.get<PaymentIdentifierRecord>(
    paymentIdentifierKey(paymentIdentifier.id),
  );
  if (
    existing &&
    (existing.fingerprint !== paymentIdentifier.fingerprint ||
      existing.paymentPayloadHash !== paymentIdentifier.paymentPayloadHash ||
      existing.paymentScopeId !== paymentIdentifier.paymentScopeId)
  ) {
    throw new Error(
      "payment identifier was already committed for a different payment",
    );
  }
}

async function putChannel(
  txn: GatewayTransaction,
  channel: ServerChannelRecord,
): Promise<void> {
  const channelId = channel.channelId.toLowerCase();
  const covenantId = channel.covenantId.toLowerCase();
  const current = await txn.get<ServerChannelRecord>(channelKey(channelId));
  if (current && current.covenantId.toLowerCase() !== covenantId) {
    throw new Error("channel covenant lineage cannot change");
  }
  const registeredChannelId = await txn.get<string>(
    covenantChannelKey(covenantId),
  );
  if (
    registeredChannelId &&
    registeredChannelId.toLowerCase() !== channelId
  ) {
    throw new Error(
      "covenant lineage is already registered to another channel",
    );
  }
  await txn.put(covenantChannelKey(covenantId), channelId);
  const stored = clone(channel);
  stored.channelId = channelId;
  stored.covenantId = covenantId;
  stored.genesisEvidence.covenantId = covenantId;
  await txn.put(channelKey(channelId), stored);
}

function matchesExpectedChannel(
  current: ServerChannelRecord | undefined,
  expected: SettlementCommit["expected"],
): boolean {
  if (!current) {
    return (
      expected.chargedCumulativeAmount === "0" &&
      expected.claimedCumulativeAmount === "0" &&
      expected.signedMaxClaimable === "0"
    );
  }
  return (
    current.channelId === expected.channelId &&
    current.covenantId === expected.covenantId &&
    current.fundingAmount === expected.fundingAmount &&
    current.chargedCumulativeAmount === expected.chargedCumulativeAmount &&
    current.claimedCumulativeAmount === expected.claimedCumulativeAmount &&
    current.signedMaxClaimable === expected.signedMaxClaimable &&
    current.voucherSignature === expected.voucherSignature &&
    current.status === expected.status &&
    current.activeOutpoint.txid.toLowerCase() ===
      expected.activeOutpoint.txid.toLowerCase() &&
    current.activeOutpoint.index === expected.activeOutpoint.index &&
    current.activeScriptPublicKey.toLowerCase() ===
      expected.activeScriptPublicKey.toLowerCase()
  );
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

function claimAttemptKey(attemptId: string): string {
  return `claim-attempt:${attemptId.toLowerCase()}`;
}

function openClaimKey(channelId: string): string {
  return `open-claim:${channelId.toLowerCase()}`;
}

function lockKey(key: string): string {
  return `lock:${key.toLowerCase()}`;
}

function rateWindowKey(scope: string): string {
  const profile = scope.slice(scope.lastIndexOf(":") + 1);
  return `rate-window:${profile === "batch" ? "batch" : "exact"}`;
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
  if (new TextEncoder().encode(serialized).byteLength > 256 * 1024)
    throw new Error("exact handler result exceeds the durable size limit");
  if (
    result.chargedAmount !== undefined &&
    result.chargedAmount !== attempt.amount
  ) {
    throw new Error("exact handler charge must equal the accepted amount");
  }
}
