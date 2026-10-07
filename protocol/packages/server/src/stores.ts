import {
  durableByteLength,
  durableOpenRecordBytes,
} from "./durable-record-budget.js";
import {
  exactTransitionScope,
  prepareExactTransition,
  type ExactTransitionCommand,
  type ExactTransitionResult,
  type ExactTransitionSnapshot,
} from "./exact-payment-transitions.js";
import {
  assertPaymentIdentifierAvailable,
  assertPaymentIdentifierCompletion,
  transitionPaymentIdentifierReservation,
  type PaymentIdentifierReservationTransition,
} from "./payment-identifier-state.js";
import {
  applyBatchClaimAccounting,
  batchLaneAccounting,
  decideChainEvidence,
  parseBatchLaneAmount,
  type Hash32Hex,
} from "@kaspa-x402/core";
import {
  assertBatchDepositTransition,
  assertBatchHandlerResultTransition,
  batchSettlementAttemptIsReadyToCommit,
  batchSettlementAttemptsMatch,
  normalizeBatchSettlementAttempt,
} from "./batch-settlement-attempts.js";
import { exactHeadMatchesSelection as sharedExactHeadMatchesSelection } from "./exact-heads.js";
import {
  assertServerChannelLineageConsistency,
  assertServerCovenantLineageExtension,
  assertServerCovenantJournalExtension,
  sameCovenantLineage,
} from "./channel-lineage.js";
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
  ServerChannelRecord,
  ServerStateStore,
  SettlementCommit,
} from "./types.js";

let memoryCoordinationSequence = 0;

export interface ServerDurableStateLimits {
  /** Maximum logical protected-payment records, open plus retained terminal. */
  maxRecords: number;
  /** Maximum aggregate bytes reserved by those record bundles. */
  maxBytes: number;
  /** Maximum record bundles owned by one authenticated payer identity. */
  maxRecordsPerPayer: number;
  /** Maximum independently provisioned additive exact heads. */
  maxExactHeads: number;
  /** Replay/cache retention horizon for terminal record bundles. */
  terminalRetentionMs: number;
}

export interface MemoryServerStateStoreOptions {
  limits?: Partial<ServerDurableStateLimits>;
  now?: () => number;
}

export interface ServerDurableStateStats {
  records: number;
  bytes: number;
  openRecords: number;
  recoveryRequiredRecords: number;
  payerRecords: Readonly<Record<string, number>>;
}

const DEFAULT_DURABLE_STATE_LIMITS: ServerDurableStateLimits = {
  maxRecords: 10_000,
  maxBytes: 512 * 1024 * 1024,
  maxRecordsPerPayer: 1_000,
  maxExactHeads: 256,
  terminalRetentionMs: 24 * 60 * 60 * 1_000,
};

type BudgetRecord = {
  key: string;
  kind: "batch" | "exact";
  attemptId: Hash32Hex;
  payerId: string;
  bytes: number;
  terminalAt?: number;
  compactedAt?: number;
  commitmentId?: Hash32Hex;
  paymentIdentifier?: string;
  safelyReleased?: boolean;
};

export class MemoryServerChannelStore implements ServerStateStore {
  readonly coordinationScope = "process-local" as const;
  readonly coordinationDomain: string;
  readonly #channels = new Map<Hash32Hex, ServerChannelRecord>();
  readonly #channelByCovenantId = new Map<Hash32Hex, Hash32Hex>();
  readonly #commitments = new Map<Hash32Hex, BatchCommitmentRecord>();
  readonly #batchAttempts = new Map<Hash32Hex, BatchSettlementAttemptRecord>();
  readonly #exactPayments = new Map<string, ExactPaymentRecord>();
  readonly #exactHeads = new Map<Hash32Hex, ExactHeadRecord>();
  readonly #exactAttempts = new Map<Hash32Hex, ExactSettlementAttemptRecord>();
  readonly #paymentIdentifiers = new Map<string, PaymentIdentifierRecord>();
  readonly #paymentIdentifierReservations = new Map<
    string,
    PaymentIdentifierReservationRecord
  >();
  readonly #claimAttempts = new Map<Hash32Hex, ClaimAttemptRecord>();
  readonly #channelOperations = new Map<
    Hash32Hex,
    ChannelOperationLeaseRecord
  >();
  readonly #channelByLeaseId = new Map<Hash32Hex, Hash32Hex>();
  readonly #openBatchAttemptByChannel = new Map<Hash32Hex, Hash32Hex>();
  readonly #openClaimAttemptByChannel = new Map<Hash32Hex, Hash32Hex>();
  readonly #limits: ServerDurableStateLimits;
  readonly #now: () => number;
  readonly #budgetRecords = new Map<string, BudgetRecord>();
  readonly #payerBudgetCounts = new Map<string, number>();
  readonly #terminalBudgetQueue = new Map<string, number>();
  #budgetBytes = 0;

  constructor(
    channels: readonly ServerChannelRecord[] = [],
    options: MemoryServerStateStoreOptions = {},
  ) {
    this.coordinationDomain = `memory-store:${++memoryCoordinationSequence}`;
    this.#limits = { ...DEFAULT_DURABLE_STATE_LIMITS, ...options.limits };
    this.#now = options.now ?? Date.now;
    assertDurableStateLimits(this.#limits);
    for (const channel of channels) this.#setChannel(channel);
  }

  durableStateStats(): ServerDurableStateStats {
    this.#pruneTerminalBudgetRecords();
    let openRecords = 0;
    let recoveryRequiredRecords = 0;
    for (const record of this.#budgetRecords.values()) {
      if (record.terminalAt === undefined) openRecords += 1;
      const reservation = record.paymentIdentifier
        ? this.#paymentIdentifierReservations.get(record.paymentIdentifier)
        : undefined;
      const batch =
        record.kind === "batch"
          ? this.#batchAttempts.get(record.attemptId)
          : undefined;
      const exact =
        record.kind === "exact"
          ? this.#exactAttempts.get(record.attemptId)
          : undefined;
      if (
        reservation?.status === "recovery-required" ||
        batch?.recoveryReason !== undefined ||
        exact?.recoveryReason !== undefined
      )
        recoveryRequiredRecords += 1;
    }
    return {
      records: this.#budgetRecords.size,
      bytes: this.#budgetBytes,
      openRecords,
      recoveryRequiredRecords,
      payerRecords: Object.fromEntries(this.#payerBudgetCounts),
    };
  }

  async loadChannel(
    channelId: Hash32Hex,
  ): Promise<ServerChannelRecord | undefined> {
    const channel = this.#channels.get(channelId);
    return channel ? clone(channel) : undefined;
  }

  async registerChannel(channel: ServerChannelRecord): Promise<void> {
    const existing = this.#channels.get(channel.channelId);
    if (existing) {
      if (stableJson(existing) !== stableJson(channel))
        throw new Error("existing channel state cannot be replaced");
      return;
    }
    this.#setChannel(channel);
  }

  async retireChannel(
    channelId: Hash32Hex,
    leaseId: Hash32Hex,
    expected: ServerChannelRecord,
  ): Promise<void> {
    const channel = this.#channels.get(channelId);
    if (!channel) return;
    const lease = this.#requireChannelOperation(channelId, leaseId);
    if (lease.kind !== "retirement")
      throw new Error("channel operation lease is not a retirement");
    if (
      !sameChannelSnapshot(channel, expected) ||
      !sameChannelSnapshot(channel, lease.expected)
    )
      throw new Error("channel state changed before retirement");
    if (channel.status === "refunded" || channel.lineage.currentHead === null) {
      throw new Error("terminal refunded channel cannot be retired");
    }
    const retired = {
      ...channel,
      version: incrementVersion(channel.version),
      status: "retired" as const,
    };
    assertServerChannelLineageConsistency(retired);
    this.#channels.set(channelId, retired);
    this.#channelOperations.delete(channelId);
    this.#channelByLeaseId.delete(leaseId);
  }

  async listChannels(): Promise<ServerChannelRecord[]> {
    return Array.from(this.#channels.values()).map(clone);
  }

  async applyCovenantLineage(
    expected: ServerChannelRecord,
    channel: ServerChannelRecord,
    leaseId: Hash32Hex,
  ): Promise<void> {
    const current = this.#channels.get(expected.channelId);
    if (!sameChannelSnapshot(current, expected)) {
      throw new Error("channel state changed before covenant lineage apply");
    }
    const lease = this.#requireChannelOperation(expected.channelId, leaseId);
    if (
      (lease.kind !== "refund" && lease.kind !== "recovery") ||
      !sameChannelSnapshot(lease.expected, expected)
    )
      throw new Error(
        "covenant lineage apply does not own the channel snapshot",
      );
    if (
      this.#openBatchAttemptByChannel.has(expected.channelId) ||
      this.#openClaimAttemptByChannel.has(expected.channelId)
    )
      throw new Error(
        "channel has an open attempt during covenant lineage apply",
      );
    assertServerCovenantLineageExtension(expected, channel);
    this.#setChannel(channel);
    this.#channelOperations.delete(expected.channelId);
    this.#channelByLeaseId.delete(leaseId);
  }

  async claimChannelOperation(
    input: ChannelOperationLeaseRecord,
  ): Promise<ChannelOperationLeaseClaimResult> {
    const lease = normalizeChannelOperationLease(input);
    const existing = this.#channelOperations.get(lease.channelId);
    if (existing) {
      if (!channelOperationLeasesMatch(existing, lease))
        throw new Error("channel already has a conflicting durable operation");
      return { lease: clone(existing), created: false };
    }
    if (
      !sameChannelSnapshot(this.#channels.get(lease.channelId), lease.expected)
    )
      throw new Error("channel state changed before operation claim");
    this.#channelOperations.set(lease.channelId, clone(lease));
    this.#channelByLeaseId.set(lease.leaseId, lease.channelId);
    return { lease: clone(lease), created: true };
  }

  async loadChannelOperation(
    channelId: Hash32Hex,
  ): Promise<ChannelOperationLeaseRecord | undefined> {
    const lease = this.#channelOperations.get(channelId.toLowerCase());
    return lease ? clone(lease) : undefined;
  }

  async abandonChannelOperation(
    leaseId: Hash32Hex,
    _reason: string,
    observedAt: string,
  ): Promise<void> {
    assertIsoDate(observedAt, "channel operation abandonment time");
    const lease = this.#findChannelOperationByLeaseId(leaseId);
    if (!lease) return;
    if (lease.status !== "reserved")
      throw new Error("uncertain channel operation cannot be abandoned");
    if (
      this.#openBatchAttemptByChannel.get(lease.channelId) === lease.leaseId ||
      this.#openClaimAttemptByChannel.get(lease.channelId) !== undefined
    ) {
      throw new Error(
        "attempt-owned channel operation must use its safe abandon path",
      );
    }
    this.#channelOperations.delete(lease.channelId);
    this.#channelByLeaseId.delete(lease.leaseId);
  }

  #setChannel(channel: ServerChannelRecord): void {
    assertServerChannelLineageConsistency(channel);
    const { channelId, covenantId } = this.#assertChannelBinding(channel);
    this.#channelByCovenantId.set(covenantId, channelId);
    this.#channels.set(channelId, clone(channel));
  }

  #assertChannelBinding(channel: ServerChannelRecord): {
    channelId: Hash32Hex;
    covenantId: Hash32Hex;
  } {
    const channelId = channel.channelId.toLowerCase() as Hash32Hex;
    const covenantId = channel.covenantId.toLowerCase() as Hash32Hex;
    const current = this.#channels.get(channelId);
    if (current && current.covenantId.toLowerCase() !== covenantId) {
      throw new Error("channel covenant lineage cannot change");
    }
    const registeredChannelId = this.#channelByCovenantId.get(covenantId);
    if (registeredChannelId && registeredChannelId !== channelId) {
      throw new Error(
        "covenant lineage is already registered to another channel",
      );
    }
    return { channelId, covenantId };
  }

  async loadCommitment(
    commitmentId: Hash32Hex,
  ): Promise<BatchCommitmentRecord | undefined> {
    const record = this.#commitments.get(commitmentId);
    return record ? clone(record) : undefined;
  }

  async loadPaymentIdentifier(
    id: string,
  ): Promise<PaymentIdentifierRecord | undefined> {
    const record = this.#paymentIdentifiers.get(id);
    return record ? clone(record) : undefined;
  }

  async loadPaymentIdentifierReservation(
    id: string,
  ): Promise<PaymentIdentifierReservationRecord | undefined> {
    const record = this.#paymentIdentifierReservations.get(id);
    return record ? clone(record) : undefined;
  }

  async loadExactPayment(
    transactionId: Hash32Hex,
  ): Promise<ExactPaymentRecord | undefined> {
    const record = this.#exactPayments.get(exactPaymentKey(transactionId));
    return record ? clone(record) : undefined;
  }

  async commitSettlement(record: SettlementCommit): Promise<void> {
    const current = this.#channels.get(record.expected.channelId);
    if (!matchesExpectedChannel(current, record.expected)) {
      throw new Error("channel state changed before settlement commit");
    }
    const attempt = this.#batchAttempts.get(record.batchAttemptId);
    if (!batchSettlementAttemptIsReadyToCommit(attempt, record)) {
      throw new Error("batch settlement attempt is not ready to apply");
    }
    const lease = this.#requireChannelOperation(
      attempt.channelId,
      attempt.attemptId,
    );
    if (
      lease.kind !== attempt.operationKind ||
      (lease.status !== "pending" && lease.status !== "recovery-required")
    ) {
      throw new Error("batch settlement does not own the channel operation");
    }
    const paymentIdentifier = record.paymentIdentifier
      ? clone(record.paymentIdentifier)
      : undefined;
    const commitment = clone(record.commitment);
    const channel = clone(record.channel);
    this.#assertSettlementTransition(current!, channel, commitment);
    this.#assertCompletedPaymentIdentifier(attempt, paymentIdentifier);
    this.#assertChannelBinding(channel);
    const {
      handlerResult: _handlerResult,
      handlerCompletedAt: _handlerCompletedAt,
      channelTransition: _channelTransition,
      ...compactAttempt
    } = attempt;
    const appliedAttempt: BatchSettlementAttemptRecord = {
      ...compactAttempt,
      status: "applied",
      recoveryReason: undefined,
      commitmentId: commitment.commitmentId,
      completedPaymentIdentifier: paymentIdentifier?.id,
      updatedAt: new Date().toISOString(),
    };
    const terminalBudgetBytes = durableByteLength({
      attempt: appliedAttempt,
      commitment,
      paymentIdentifier,
    });
    this.#assertTerminalBudgetFits(
      `batch:${attempt.attemptId}`,
      terminalBudgetBytes,
    );
    this.#commitments.set(commitment.commitmentId, commitment);
    if (paymentIdentifier) {
      this.#paymentIdentifiers.set(paymentIdentifier.id, paymentIdentifier);
      this.#applyPaymentIdentifierTransition(attempt.paymentIdentifier!, {
        kind: "complete",
        observedAt: attempt.updatedAt,
      });
    }
    this.#setChannel(channel);
    this.#batchAttempts.set(attempt.attemptId, appliedAttempt);
    this.#openBatchAttemptByChannel.delete(attempt.channelId);
    this.#channelOperations.delete(attempt.channelId);
    this.#channelByLeaseId.delete(attempt.attemptId);
    this.#terminalizeBudgetRecord(
      `batch:${attempt.attemptId}`,
      terminalBudgetBytes,
      commitment.commitmentId,
      paymentIdentifier?.id,
    );
  }

  async claimBatchSettlement(
    input: BatchSettlementAttemptRecord,
  ): Promise<BatchSettlementClaimResult> {
    const attempt = normalizeBatchSettlementAttempt(input);
    const existing = this.#batchAttempts.get(attempt.attemptId);
    if (existing) {
      if (!batchSettlementAttemptsMatch(existing, attempt))
        throw new Error(
          "batch payment is already claimed for a different request",
        );
      return { attempt: clone(existing), created: false };
    }
    const current = this.#channels.get(attempt.channelId);
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
      this.#assertChannelBinding(transition.next);
    } else if (!matchesExpectedChannel(current, attempt.expected)) {
      throw new Error("channel state changed before batch settlement claim");
    }
    const openAttemptId = this.#openBatchAttemptByChannel.get(
      attempt.channelId,
    );
    if (openAttemptId)
      throw new Error("channel already has a pending batch settlement");
    if (this.#channelOperations.has(attempt.channelId))
      throw new Error("channel already has a conflicting durable operation");
    this.#assertPaymentIdentifierClaimAvailable(attempt.paymentIdentifier);
    this.#admitBudgetRecord(
      `batch:${attempt.attemptId}`,
      "batch",
      attempt.attemptId,
      attempt.payerId,
      attempt.paymentIdentifier?.id,
      durableOpenRecordBytes(attempt),
      attempt.paymentIdentifier,
    );
    if (transition) this.#setChannel(transition.next);
    this.#applyPaymentIdentifierTransition(attempt.paymentIdentifier, {
      kind: "reserve",
      observedAt: attempt.createdAt,
    });
    this.#batchAttempts.set(attempt.attemptId, clone(attempt));
    this.#openBatchAttemptByChannel.set(attempt.channelId, attempt.attemptId);
    this.#channelOperations.set(attempt.channelId, {
      leaseId: attempt.attemptId,
      channelId: attempt.channelId,
      covenantId: attempt.covenantId,
      kind: attempt.operationKind,
      expected: clone(attempt.expected),
      status: "reserved",
      createdAt: attempt.createdAt,
      updatedAt: attempt.updatedAt,
    });
    this.#channelByLeaseId.set(attempt.attemptId, attempt.channelId);
    return { attempt: clone(attempt), created: true };
  }

  async loadBatchSettlementAttempt(
    attemptId: Hash32Hex,
  ): Promise<BatchSettlementAttemptRecord | undefined> {
    const attempt = this.#batchAttempts.get(attemptId.toLowerCase());
    return attempt ? clone(attempt) : undefined;
  }

  async beginBatchHandler(
    attemptId: Hash32Hex,
    startedAt: string,
  ): Promise<boolean> {
    const attempt = this.#requireBatchAttempt(attemptId);
    if (attempt.status !== "pending" || attempt.handlerStartedAt) return false;
    assertIsoDate(startedAt, "batch handler start time");
    this.#batchAttempts.set(attempt.attemptId, {
      ...attempt,
      handlerStartedAt: startedAt,
      updatedAt: startedAt,
    });
    this.#updateChannelOperation(attempt.channelId, attempt.attemptId, {
      status: "pending",
      updatedAt: startedAt,
    });
    this.#applyPaymentIdentifierTransition(attempt.paymentIdentifier, {
      kind: "update",
      update: {
        status: "pending",
        updatedAt: startedAt,
      },
    });
    return true;
  }

  async recordBatchHandlerResult(
    attemptId: Hash32Hex,
    result: import("./types.js").ProtectedHandlerResult,
    completedAt: string,
  ): Promise<void> {
    const attempt = this.#requireBatchAttempt(attemptId);
    assertBatchHandlerResultTransition(attempt, result, completedAt);
    if (attempt.handlerResult) return;
    this.#batchAttempts.set(attempt.attemptId, {
      ...attempt,
      handlerResult: clone(result),
      handlerCompletedAt: completedAt,
      recoveryReason: undefined,
      updatedAt: completedAt,
    });
    this.#updateChannelOperation(attempt.channelId, attempt.attemptId, {
      status: "pending",
      recoveryReason: undefined,
      updatedAt: completedAt,
    });
    this.#applyPaymentIdentifierTransition(attempt.paymentIdentifier, {
      kind: "update",
      update: {
        status: "pending",
        recoveryReason: undefined,
        updatedAt: completedAt,
      },
    });
  }

  async abandonBatchSettlement(
    attemptId: Hash32Hex,
    reason: string,
    observedAt: string,
  ): Promise<void> {
    const attempt = this.#requireBatchAttempt(attemptId);
    assertIsoDate(observedAt, "batch settlement abandonment time");
    if (
      attempt.status !== "pending" ||
      attempt.handlerStartedAt ||
      attempt.handlerResult ||
      attempt.recoveryReason
    ) {
      throw new Error(
        "uncertain or completed batch settlement cannot be abandoned",
      );
    }
    this.#requireChannelOperation(attempt.channelId, attempt.attemptId);
    this.#applyPaymentIdentifierTransition(attempt.paymentIdentifier, {
      kind: "release",
      reason: reason,
      observedAt: observedAt,
      allowPending: false,
    });
    this.#batchAttempts.delete(attempt.attemptId);
    this.#openBatchAttemptByChannel.delete(attempt.channelId);
    this.#channelOperations.delete(attempt.channelId);
    this.#channelByLeaseId.delete(attempt.attemptId);
    if (attempt.paymentIdentifier) {
      this.#terminalizeBudgetRecord(
        `batch:${attempt.attemptId}`,
        durableByteLength({
          paymentIdentifierReservation: this.#paymentIdentifierReservations.get(
            attempt.paymentIdentifier.id,
          ),
        }),
        undefined,
        attempt.paymentIdentifier.id,
        true,
      );
    } else {
      this.#deleteBudgetRecord(`batch:${attempt.attemptId}`);
    }
  }

  async markBatchHandlerRecoveryRequired(
    attemptId: Hash32Hex,
    reason: string,
    observedAt: string,
  ): Promise<void> {
    const attempt = this.#requireBatchAttempt(attemptId);
    if (
      attempt.status !== "pending" ||
      !attempt.handlerStartedAt ||
      attempt.handlerResult
    ) {
      throw new Error("batch handler is not awaiting recovery");
    }
    assertIsoDate(observedAt, "batch handler recovery time");
    this.#batchAttempts.set(attempt.attemptId, {
      ...attempt,
      recoveryReason: reason,
      updatedAt: observedAt,
    });
    this.#updateChannelOperation(attempt.channelId, attempt.attemptId, {
      status: "recovery-required",
      recoveryReason: reason,
      updatedAt: observedAt,
    });
    this.#applyPaymentIdentifierTransition(attempt.paymentIdentifier, {
      kind: "update",
      update: {
        status: "recovery-required",
        recoveryReason: reason,
        updatedAt: observedAt,
      },
    });
  }

  async commitExactPayment(record: ExactSettlementCommit): Promise<void> {
    this.#applyExactTransition({ kind: "commit", args: [record] });
  }

  async registerExactHead(input: ExactHeadRecord): Promise<ExactHeadRecord> {
    return this.#applyExactTransition({ kind: "register-head", args: [input] });
  }

  async loadExactHead(headId: Hash32Hex): Promise<ExactHeadRecord | undefined> {
    const record = this.#exactHeads.get(headId.toLowerCase());
    return record ? clone(record) : undefined;
  }

  async listExactHeads(): Promise<ExactHeadRecord[]> {
    return Array.from(this.#exactHeads.values())
      .map(clone)
      .sort((left, right) => left.headId.localeCompare(right.headId));
  }

  async selectExactHead(
    request: ExactHeadSelectionRequest,
  ): Promise<ExactHeadRecord | undefined> {
    const candidates = Array.from(this.#exactHeads.values())
      .filter((head) => sharedExactHeadMatchesSelection(head, request))
      .sort((left, right) => left.headId.localeCompare(right.headId));
    if (candidates.length === 0) return undefined;
    const index = Number(
      BigInt(`0x${request.selectionKey}`) % BigInt(candidates.length),
    );
    return clone(candidates[index]!);
  }

  async claimExactSettlement(
    input: ExactSettlementAttemptRecord,
  ): Promise<ExactSettlementClaimResult> {
    return this.#applyExactTransition({ kind: "claim", args: [input] });
  }

  async loadExactSettlementAttempt(
    transactionId: Hash32Hex,
  ): Promise<ExactSettlementAttemptRecord | undefined> {
    const attempt = this.#exactAttempts.get(transactionId.toLowerCase());
    return attempt ? clone(attempt) : undefined;
  }

  async recordExactSettlementBroadcast(
    transactionId: Hash32Hex,
    finality: import("./types.js").SettlementFinality,
    observedAt: string,
  ): Promise<void> {
    this.#applyExactTransition({
      kind: "broadcast",
      args: [transactionId, finality, observedAt],
    });
  }

  async acceptExactSettlement(
    transactionId: Hash32Hex,
    finality: "accepted" | "confirmed",
    observedAt: string,
  ): Promise<void> {
    this.#applyExactTransition({
      kind: "accept",
      args: [transactionId, finality, observedAt],
    });
  }

  async beginExactHandler(
    transactionId: Hash32Hex,
    startedAt: string,
  ): Promise<boolean> {
    return this.#applyExactTransition({
      kind: "begin-handler",
      args: [transactionId, startedAt],
    });
  }

  async recordExactHandlerResult(
    transactionId: Hash32Hex,
    result: import("./types.js").ProtectedHandlerResult,
    completedAt: string,
  ): Promise<void> {
    this.#applyExactTransition({
      kind: "record-result",
      args: [transactionId, result, completedAt],
    });
  }

  async markExactHandlerRecoveryRequired(
    transactionId: Hash32Hex,
    reason: string,
    observedAt: string,
  ): Promise<void> {
    this.#applyExactTransition({
      kind: "recovery",
      args: [transactionId, reason, observedAt],
    });
  }

  async abandonExactSettlement(
    transactionId: Hash32Hex,
    reason: string,
    observedAt: string,
  ): Promise<void> {
    this.#applyExactTransition({
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

  #applyExactTransition<C extends ExactTransitionCommand>(
    command: C,
  ): ExactTransitionResult<C> {
    const initial = exactTransitionScope(command);
    const attempt = initial.transactionId
      ? this.#exactAttempts.get(initial.transactionId)
      : undefined;
    const scope = exactTransitionScope(command, attempt);
    const snapshot: ExactTransitionSnapshot = {
      now: new Date().toISOString(),
      attempt,
      head: scope.headId ? this.#exactHeads.get(scope.headId) : undefined,
      payment: scope.transactionId
        ? this.#exactPayments.get(exactPaymentKey(scope.transactionId))
        : undefined,
      identifier: scope.identifierId
        ? this.#paymentIdentifiers.get(scope.identifierId)
        : undefined,
      reservation: scope.identifierId
        ? this.#paymentIdentifierReservations.get(scope.identifierId)
        : undefined,
    };
    if (command.kind === "register-head" && !snapshot.head) {
      snapshot.heads = Array.from(this.#exactHeads.values());
      snapshot.maxHeads = this.#limits.maxExactHeads;
    }
    const changes = prepareExactTransition(command, snapshot);
    const budget = changes.budget;
    // All fallible quota checks precede record writes; there is no async yield here.
    if (budget?.kind === "admit") {
      const next = budget.attempt;
      this.#admitBudgetRecord(
        `exact:${next.transactionId}`,
        "exact",
        next.transactionId,
        next.payerId,
        next.paymentIdentifier?.id,
        budget.bytes,
        next.paymentIdentifier,
      );
    } else if (budget?.kind === "terminal") {
      this.#assertTerminalBudgetFits(
        `exact:${budget.transactionId}`,
        budget.bytes,
      );
    }
    if (changes.head)
      this.#exactHeads.set(changes.head.headId, clone(changes.head));
    if (changes.reservation)
      this.#paymentIdentifierReservations.set(
        changes.reservation.id,
        clone(changes.reservation),
      );
    if (changes.identifier)
      this.#paymentIdentifiers.set(
        changes.identifier.id,
        clone(changes.identifier),
      );
    if (changes.payment)
      this.#exactPayments.set(
        exactPaymentKey(changes.payment.transactionId),
        clone(changes.payment),
      );
    if (changes.attempt === null)
      this.#exactAttempts.delete(changes.transactionId!);
    else if (changes.attempt)
      this.#exactAttempts.set(
        changes.attempt.transactionId,
        clone(changes.attempt),
      );
    if (budget?.kind === "terminal") {
      this.#terminalizeBudgetRecord(
        `exact:${budget.transactionId}`,
        budget.bytes,
        undefined,
        budget.identifierId,
        budget.safelyReleased,
      );
    } else if (budget?.kind === "delete")
      this.#deleteBudgetRecord(`exact:${budget.transactionId}`);
    return changes.result;
  }

  #requireBatchAttempt(attemptId: Hash32Hex): BatchSettlementAttemptRecord {
    const attempt = this.#batchAttempts.get(attemptId.toLowerCase());
    if (!attempt) throw new Error("batch settlement attempt was not found");
    return attempt;
  }

  #assertPaymentIdentifierClaimAvailable(
    claim: PaymentIdentifierReservationClaim | undefined,
  ): void {
    assertPaymentIdentifierAvailable(
      claim,
      claim ? this.#paymentIdentifierReservations.get(claim.id) : undefined,
      claim ? this.#paymentIdentifiers.get(claim.id) : undefined,
    );
  }

  #safelyReleasedPaymentIdentifierReclaim(
    claim: PaymentIdentifierReservationClaim | undefined,
  ): { reservationId: string; budget: BudgetRecord } | undefined {
    if (!claim) return undefined;
    const released = this.#paymentIdentifierReservations.get(claim.id);
    if (!released || released.status !== "safely-released") return undefined;
    const budgetKey = `${
      released.paymentKind === "exact" ? "exact" : "batch"
    }:${released.ownerId}`;
    const budget = this.#budgetRecords.get(budgetKey);
    if (
      !budget?.safelyReleased ||
      budget.attemptId !== released.ownerId ||
      budget.paymentIdentifier !== claim.id
    ) {
      throw new Error(
        "safely released payment identifier budget is inconsistent",
      );
    }
    return { reservationId: claim.id, budget };
  }

  #applyPaymentIdentifierTransition(
    claim: PaymentIdentifierReservationClaim | undefined,
    transition: PaymentIdentifierReservationTransition,
  ): void {
    const next = transitionPaymentIdentifierReservation(
      claim,
      claim ? this.#paymentIdentifierReservations.get(claim.id) : undefined,
      transition,
    );
    if (next) this.#paymentIdentifierReservations.set(next.id, next);
  }

  #assertCompletedPaymentIdentifier(
    attempt:
      | BatchSettlementAttemptRecord
      | ExactSettlementAttemptRecord
      | undefined,
    completed: PaymentIdentifierRecord | undefined,
  ): void {
    const claim = attempt?.paymentIdentifier;
    assertPaymentIdentifierCompletion(
      claim,
      completed,
      claim ? this.#paymentIdentifierReservations.get(claim.id) : undefined,
      claim ? this.#paymentIdentifiers.get(claim.id) : undefined,
    );
  }

  #requireChannelOperation(
    channelId: Hash32Hex,
    leaseId: Hash32Hex,
  ): ChannelOperationLeaseRecord {
    const lease = this.#channelOperations.get(channelId);
    if (!lease || lease.leaseId !== leaseId)
      throw new Error("channel operation lease was not found");
    return lease;
  }

  #findChannelOperationByLeaseId(
    leaseId: Hash32Hex,
  ): ChannelOperationLeaseRecord | undefined {
    const channelId = this.#channelByLeaseId.get(leaseId);
    return channelId ? this.#channelOperations.get(channelId) : undefined;
  }

  #updateChannelOperation(
    channelId: Hash32Hex,
    leaseId: Hash32Hex,
    update: Pick<ChannelOperationLeaseRecord, "status" | "updatedAt"> &
      Pick<Partial<ChannelOperationLeaseRecord>, "recoveryReason">,
  ): void {
    const lease = this.#requireChannelOperation(channelId, leaseId);
    this.#channelOperations.set(channelId, { ...lease, ...update });
  }

  #assertSettlementTransition(
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
      parseBatchLaneAmount(
        next.chargedCumulativeAmount,
        "next charged amount",
      ) <
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
    ) {
      throw new Error("settlement would roll back or replace channel state");
    }
    batchLaneAccounting(next);
    assertServerChannelLineageConsistency(next);
  }

  #assertClaimTransition(
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
      throw new Error(
        "claim transition is not the reserved monotonic successor",
      );
    batchLaneAccounting(next);
    assertServerCovenantJournalExtension(previous, next);
  }

  async loadOpenClaimAttempt(
    channelId: Hash32Hex,
  ): Promise<ClaimAttemptRecord | undefined> {
    const attemptId = this.#openClaimAttemptByChannel.get(channelId);
    const record = attemptId ? this.#claimAttempts.get(attemptId) : undefined;
    return record && record.status !== "applied" ? clone(record) : undefined;
  }

  async saveClaimAttempt(record: ClaimAttemptRecord): Promise<void> {
    const existing = this.#claimAttempts.get(record.attemptId);
    const attempt = normalizeClaimAttempt(record, existing);
    const openAttemptId = this.#openClaimAttemptByChannel.get(
      attempt.channelId,
    );
    if (openAttemptId && openAttemptId !== attempt.attemptId) {
      throw new Error("claim attempt is already pending");
    }
    const lease = this.#requireChannelOperation(
      attempt.channelId,
      attempt.operationLeaseId,
    );
    if (
      lease.kind !== "claim" ||
      !sameChannelSnapshot(lease.expected, attempt.expected)
    )
      throw new Error("claim attempt does not own the channel snapshot");
    this.#claimAttempts.set(attempt.attemptId, attempt);
    this.#openClaimAttemptByChannel.set(attempt.channelId, attempt.attemptId);
    this.#updateChannelOperation(attempt.channelId, attempt.operationLeaseId, {
      status: "pending",
      updatedAt: new Date().toISOString(),
    });
  }

  async applyClaimAttempt(
    channel: ServerChannelRecord,
    attempt: ClaimAttemptRecord,
  ): Promise<void> {
    const currentAttempt = this.#claimAttempts.get(attempt.attemptId);
    if (
      !currentAttempt ||
      currentAttempt.status !== "accepted" ||
      attempt.status !== "accepted" ||
      !claimAttemptsMatch(currentAttempt, attempt)
    ) {
      throw new Error("claim apply must match the persisted accepted attempt");
    }
    const lease = this.#requireChannelOperation(
      currentAttempt.channelId,
      currentAttempt.operationLeaseId,
    );
    if (lease.kind !== "claim")
      throw new Error("claim apply does not own the channel operation");
    const currentChannel = this.#channels.get(channel.channelId);
    if (
      !currentChannel ||
      currentChannel.channelId !== currentAttempt.channelId ||
      currentChannel.covenantId.toLowerCase() !==
        currentAttempt.covenantId.toLowerCase() ||
      currentChannel.activeOutpoint.txid.toLowerCase() !==
        currentAttempt.activeOutpoint.txid.toLowerCase() ||
      currentChannel.activeOutpoint.index !==
        currentAttempt.activeOutpoint.index ||
      currentChannel.activeScriptPublicKey.toLowerCase() !==
        currentAttempt.activeScriptPublicKey.toLowerCase() ||
      currentChannel.fundingAmount !== currentAttempt.fundingAmount ||
      currentChannel.chargedCumulativeAmount !==
        currentAttempt.chargedCumulativeAmount ||
      currentChannel.claimedCumulativeAmount !==
        currentAttempt.claimedCumulativeAmount ||
      currentChannel.signedMaxClaimable !== currentAttempt.signedMaxClaimable ||
      currentChannel.voucherSignature !== currentAttempt.voucherSignature ||
      currentChannel.status !== currentAttempt.channelStatus
    ) {
      throw new Error("channel state changed before claim apply");
    }
    this.#assertClaimTransition(currentChannel, channel, currentAttempt);
    this.#setChannel(channel);
    this.#claimAttempts.set(currentAttempt.attemptId, {
      ...clone(currentAttempt),
      status: "applied",
    });
    this.#openClaimAttemptByChannel.delete(currentAttempt.channelId);
    this.#channelOperations.delete(currentAttempt.channelId);
    this.#channelByLeaseId.delete(currentAttempt.operationLeaseId);
  }

  async abandonClaimAttempt(attemptId: Hash32Hex): Promise<void> {
    const currentAttempt = this.#claimAttempts.get(attemptId);
    if (!currentAttempt || currentAttempt.status === "applied") return;
    if (currentAttempt.status === "accepted")
      throw new Error("accepted claim attempt cannot be abandoned");
    this.#requireChannelOperation(
      currentAttempt.channelId,
      currentAttempt.operationLeaseId,
    );
    this.#claimAttempts.delete(attemptId);
    this.#openClaimAttemptByChannel.delete(currentAttempt.channelId);
    this.#channelOperations.delete(currentAttempt.channelId);
    this.#channelByLeaseId.delete(currentAttempt.operationLeaseId);
  }

  #admitBudgetRecord(
    key: string,
    kind: BudgetRecord["kind"],
    attemptId: Hash32Hex,
    payerId: string,
    paymentIdentifier: string | undefined,
    bytes: number,
    replacementClaim: PaymentIdentifierReservationClaim | undefined,
  ): void {
    this.#pruneTerminalBudgetRecords();
    const replacement =
      this.#safelyReleasedPaymentIdentifierReclaim(replacementClaim);
    const existing = this.#budgetRecords.get(key);
    if (existing && existing !== replacement?.budget)
      throw new Error("durable budget reservation already exists");
    const replacedRecordCount = replacement ? 1 : 0;
    const replacedBytes = replacement?.budget.bytes ?? 0;
    const replacedPayerRecordCount =
      replacement?.budget.payerId === payerId ? 1 : 0;
    const projectedPayerRecords =
      (this.#payerBudgetCounts.get(payerId) ?? 0) -
      replacedPayerRecordCount +
      1;
    if (
      this.#budgetRecords.size - replacedRecordCount + 1 >
      this.#limits.maxRecords
    ) {
      throw new Error("durable protected-payment record limit exceeded");
    }
    if (this.#budgetBytes - replacedBytes + bytes > this.#limits.maxBytes)
      throw new Error("durable protected-payment byte limit exceeded");
    if (projectedPayerRecords > this.#limits.maxRecordsPerPayer)
      throw new Error("durable protected-payment per-payer limit exceeded");
    if (replacement) {
      this.#deleteBudgetRecord(replacement.budget.key);
      this.#paymentIdentifierReservations.delete(replacement.reservationId);
    }
    const payerRecords = this.#payerBudgetCounts.get(payerId) ?? 0;
    this.#budgetRecords.set(key, {
      key,
      kind,
      attemptId,
      payerId,
      bytes,
      ...(paymentIdentifier ? { paymentIdentifier } : {}),
    });
    this.#budgetBytes += bytes;
    this.#payerBudgetCounts.set(payerId, payerRecords + 1);
  }

  #terminalizeBudgetRecord(
    key: string,
    bytes: number,
    commitmentId?: Hash32Hex,
    paymentIdentifier?: string,
    safelyReleased = false,
  ): void {
    const current = this.#budgetRecords.get(key);
    if (!current) throw new Error("durable budget reservation is missing");
    if (bytes > current.bytes)
      throw new Error(
        "durable terminal bundle exceeded its reserved byte quota",
      );
    const terminalAt = this.#now();
    this.#budgetBytes += bytes - current.bytes;
    this.#budgetRecords.set(key, {
      ...current,
      bytes,
      terminalAt,
      ...(commitmentId ? { commitmentId } : {}),
      ...(paymentIdentifier ? { paymentIdentifier } : {}),
      ...(safelyReleased ? { safelyReleased: true } : {}),
    });
    this.#terminalBudgetQueue.set(key, terminalAt);
    this.#pruneTerminalBudgetRecords();
  }

  #assertTerminalBudgetFits(key: string, bytes: number): void {
    const current = this.#budgetRecords.get(key);
    if (!current) throw new Error("durable budget reservation is missing");
    if (bytes > current.bytes)
      throw new Error(
        "durable terminal bundle exceeded its reserved byte quota",
      );
  }

  #deleteBudgetRecord(key: string): void {
    const record = this.#budgetRecords.get(key);
    if (!record) return;
    this.#terminalBudgetQueue.delete(key);
    this.#budgetRecords.delete(key);
    this.#budgetBytes -= record.bytes;
    const payerRecords = this.#payerBudgetCounts.get(record.payerId) ?? 0;
    if (payerRecords <= 1) this.#payerBudgetCounts.delete(record.payerId);
    else this.#payerBudgetCounts.set(record.payerId, payerRecords - 1);
  }

  #pruneTerminalBudgetRecords(): void {
    const cutoff = this.#now() - this.#limits.terminalRetentionMs;
    while (this.#terminalBudgetQueue.size > 0) {
      const key = this.#terminalBudgetQueue.keys().next().value!;
      const record = this.#budgetRecords.get(key);
      if (!record || record.terminalAt === undefined) {
        this.#terminalBudgetQueue.delete(key);
        continue;
      }
      if (record.terminalAt > cutoff) break;
      this.#terminalBudgetQueue.delete(key);
      if (record.safelyReleased) {
        if (record.paymentIdentifier) {
          const reservation = this.#paymentIdentifierReservations.get(
            record.paymentIdentifier,
          );
          if (
            reservation?.status === "safely-released" &&
            reservation.ownerId === record.attemptId
          ) {
            this.#paymentIdentifierReservations.delete(
              record.paymentIdentifier,
            );
          }
        }
        this.#deleteBudgetRecord(key);
        continue;
      }
      if (record.kind === "batch") {
        this.#batchAttempts.delete(record.attemptId);
        if (record.commitmentId) {
          const commitment = this.#commitments.get(record.commitmentId);
          if (commitment)
            this.#commitments.set(record.commitmentId, {
              ...commitment,
              response: expiredReplayResponse(),
            });
        }
      } else {
        this.#exactAttempts.delete(record.attemptId);
        const payment = this.#exactPayments.get(
          exactPaymentKey(record.attemptId),
        );
        if (payment)
          this.#exactPayments.set(exactPaymentKey(record.attemptId), {
            ...payment,
            response: expiredReplayResponse(),
          });
      }
      if (record.paymentIdentifier) {
        const paymentIdentifier = this.#paymentIdentifiers.get(
          record.paymentIdentifier,
        );
        if (paymentIdentifier)
          this.#paymentIdentifiers.set(record.paymentIdentifier, {
            ...paymentIdentifier,
            response: expiredReplayResponse(),
          });
      }
      // The compact payment/commitment records above remain authoritative
      // replay tombstones, but no longer consume active-attempt admission.
      this.#deleteBudgetRecord(key);
    }
  }
}

export class MemoryChannelLockManager implements ChannelLockManager {
  readonly coordinationScope = "process-local" as const;
  readonly coordinationDomain = `memory-lock:${++memoryCoordinationSequence}`;
  readonly #tails = new Map<Hash32Hex, Promise<void>>();

  async runExclusive<T>(
    channelId: Hash32Hex,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#tails.get(channelId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => next);
    this.#tails.set(channelId, tail);
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.#tails.get(channelId) === tail) this.#tails.delete(channelId);
    }
  }
}

export function activeChargedAmount(channel: ServerChannelRecord): bigint {
  return batchLaneAccounting(channel).activeChargedAmount;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function exactPaymentKey(transactionId: Hash32Hex): string {
  return transactionId.toLowerCase();
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

function expiredReplayResponse(): import("./types.js").ServerResponse {
  return {
    status: 409,
    headers: {},
    body: { error: "replay_record_retained" },
  };
}

function assertDurableStateLimits(limits: ServerDurableStateLimits): void {
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
  existing: ChannelOperationLeaseRecord,
  input: ChannelOperationLeaseRecord,
): boolean {
  return (
    existing.leaseId === input.leaseId &&
    existing.channelId === input.channelId &&
    existing.covenantId === input.covenantId &&
    existing.kind === input.kind &&
    sameChannelSnapshot(existing.expected, input.expected)
  );
}

/** Validates one durable claim record and, when present, its legal next state. */
export function normalizeClaimAttempt(
  input: ClaimAttemptRecord,
  existing?: ClaimAttemptRecord,
): ClaimAttemptRecord {
  assertClaimAttemptShape(input);
  if (input.status === "applied")
    throw new Error("claim attempts can only be applied atomically");
  if (!existing) {
    if (input.status !== "pending")
      throw new Error("new claim attempt must be pending");
    return clone(input);
  }
  assertClaimAttemptShape(existing);
  if (!claimAttemptArtifactsMatch(existing, input)) {
    throw new Error(
      "claim attempt immutable artifact conflicts with durable state",
    );
  }
  if (existing.status === input.status) {
    if (!claimAttemptsMatch(existing, input))
      throw new Error(
        "claim attempt same-state update conflicts with durable state",
      );
    return clone(input);
  }
  if (
    !(
      (existing.status === "pending" && input.status === "broadcast") ||
      (existing.status === "broadcast" && input.status === "accepted")
    )
  ) {
    throw new Error("invalid claim attempt status transition");
  }
  return clone(input);
}

/** Exact equality used before atomically applying a persisted accepted claim. */
export function claimAttemptsMatch(
  left: ClaimAttemptRecord,
  right: ClaimAttemptRecord,
): boolean {
  return stableJson(left) === stableJson(right);
}

function claimAttemptArtifactsMatch(
  left: ClaimAttemptRecord,
  right: ClaimAttemptRecord,
): boolean {
  const {
    status: _leftStatus,
    finality: _leftFinality,
    acceptance: _leftAcceptance,
    ...leftArtifact
  } = left;
  const {
    status: _rightStatus,
    finality: _rightFinality,
    acceptance: _rightAcceptance,
    ...rightArtifact
  } = right;
  return stableJson(leftArtifact) === stableJson(rightArtifact);
}

function assertClaimAttemptShape(attempt: ClaimAttemptRecord): void {
  if (
    !Number.isSafeInteger(attempt.requiredConfirmations) ||
    attempt.requiredConfirmations < 1
  ) {
    throw new Error("claim attempt confirmation threshold is invalid");
  }
  if (
    !isLowerHash32(attempt.attemptId) ||
    !isLowerHash32(attempt.channelId) ||
    !isNonzeroLowerHash32(attempt.covenantId) ||
    !isLowerHash32(attempt.activeOutpoint.txid) ||
    !isLowerHash32(attempt.transactionId) ||
    !isLowerHash32(attempt.operationLeaseId)
  ) {
    throw new Error("claim attempt identifiers must be canonical lowercase");
  }
  if (
    !Number.isInteger(attempt.activeOutpoint.index) ||
    attempt.activeOutpoint.index < 0 ||
    attempt.activeOutpoint.index > 0xffff_ffff
  ) {
    throw new Error("claim attempt active outpoint index is invalid");
  }
  if (
    typeof attempt.transaction !== "string" ||
    attempt.transaction.length === 0
  ) {
    throw new Error("claim attempt transaction artifact is required");
  }
  const claim = parseBatchLaneAmount(attempt.claimAmount, "claim amount");
  if (claim === 0n) throw new Error("claim amount must be positive");
  batchLaneAccounting({
    fundingAmount: attempt.fundingAmount,
    chargedCumulativeAmount: attempt.chargedCumulativeAmount,
    claimedCumulativeAmount: attempt.claimedCumulativeAmount,
    signedMaxClaimable: attempt.signedMaxClaimable,
  });
  if (
    attempt.expected.channelId !== attempt.channelId ||
    attempt.expected.covenantId !== attempt.covenantId ||
    attempt.expected.fundingAmount !== attempt.fundingAmount ||
    attempt.expected.chargedCumulativeAmount !==
      attempt.chargedCumulativeAmount ||
    attempt.expected.claimedCumulativeAmount !==
      attempt.claimedCumulativeAmount ||
    attempt.expected.signedMaxClaimable !== attempt.signedMaxClaimable ||
    attempt.expected.voucherSignature !== attempt.voucherSignature ||
    attempt.expected.status !== attempt.channelStatus ||
    !sameOutpoint(attempt.expected.activeOutpoint, attempt.activeOutpoint) ||
    attempt.expected.activeScriptPublicKey.toLowerCase() !==
      attempt.activeScriptPublicKey.toLowerCase()
  )
    throw new Error("claim attempt snapshot is inconsistent");
  const continuationFields = [
    attempt.continuationOutpoint,
    attempt.continuationScriptPublicKey,
    attempt.continuationFundingAmount,
  ].filter((value) => value !== undefined).length;
  if (continuationFields !== 0 && continuationFields !== 3)
    throw new Error("claim continuation state must be complete");
  if (attempt.continuationOutpoint) {
    if (
      !isLowerHash32(attempt.continuationOutpoint.txid) ||
      attempt.continuationOutpoint.txid !== attempt.transactionId ||
      !Number.isInteger(attempt.continuationOutpoint.index) ||
      attempt.continuationOutpoint.index < 0 ||
      attempt.continuationOutpoint.index > 0xffff_ffff
    ) {
      throw new Error("claim continuation outpoint is invalid");
    }
    parseBatchLaneAmount(
      attempt.continuationFundingAmount,
      "claim continuation funding amount",
    );
  }
  if (attempt.status === "pending") {
    if (attempt.finality !== undefined || attempt.acceptance !== undefined)
      throw new Error("pending claim attempt cannot have chain evidence");
    return;
  }
  if (attempt.status === "broadcast") {
    if (
      attempt.finality !== "broadcast" &&
      attempt.finality !== "accepted" &&
      attempt.finality !== "confirmed"
    ) {
      throw new Error("broadcast claim attempt requires observed finality");
    }
    if (attempt.finality === "broadcast" && attempt.acceptance !== undefined) {
      throw new Error(
        "broadcast-only claim attempt cannot have acceptance evidence",
      );
    }
    if (
      (attempt.finality === "accepted" || attempt.finality === "confirmed") &&
      (!attempt.acceptance ||
        attempt.acceptance.transactionId !== attempt.transactionId)
    ) {
      throw new Error("accepted claim observation requires matching evidence");
    }
    return;
  }
  if (attempt.status === "accepted" || attempt.status === "applied") {
    if (
      attempt.finality !== "confirmed" ||
      !attempt.acceptance ||
      attempt.acceptance.transactionId !== attempt.transactionId ||
      decideChainEvidence(attempt.acceptance, attempt.requiredConfirmations)
        .status !== "confirmed"
    ) {
      throw new Error("accepted claim attempt lacks confirmed chain evidence");
    }
    return;
  }
  throw new Error("claim attempt status is invalid");
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

function matchesExpectedChannel(
  current: ServerChannelRecord | undefined,
  expected: SettlementCommit["expected"],
): boolean {
  return sameChannelSnapshot(current, expected);
}
