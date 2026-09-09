import {
  KASPA_X402_RESOURCE_BUDGET,
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
import {
  acceptExactHead,
  applyExactHeadLineage as applyExactHeadLineageRecord,
  claimExactHead,
  exactHeadMatchesSelection as sharedExactHeadMatchesSelection,
  exactSettlementAttemptsMatch,
  normalizeExactHeadRecord,
  normalizeExactSettlementAttempt,
  releaseExactHeadClaim,
} from "./exact-heads.js";
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

const MAX_DURABLE_HANDLER_RESULT_BYTES = 256 * 1024;
const MAX_DURABLE_RESPONSE_BYTES =
  MAX_DURABLE_HANDLER_RESULT_BYTES +
  KASPA_X402_RESOURCE_BUDGET.maxEncodedHeaderBytes +
  1024;

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
    if (!sameChannelSnapshot(channel, expected) ||
        !sameChannelSnapshot(channel, lease.expected))
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
  ): Promise<void> {
    const current = this.#channels.get(expected.channelId);
    if (!sameChannelSnapshot(current, expected)) {
      throw new Error("channel state changed before covenant lineage apply");
    }
    if (
      this.#channelOperations.has(expected.channelId) ||
      this.#openBatchAttemptByChannel.has(expected.channelId) ||
      this.#openClaimAttemptByChannel.has(expected.channelId)
    ) {
      throw new Error("channel has an open operation during covenant lineage apply");
    }
    assertServerCovenantLineageExtension(expected, channel);
    this.#setChannel(channel);
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
    if (!sameChannelSnapshot(this.#channels.get(lease.channelId), lease.expected))
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
      throw new Error("attempt-owned channel operation must use its safe abandon path");
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
      this.#completePaymentIdentifierReservation(
        attempt.paymentIdentifier!,
        attempt.updatedAt,
      );
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
    const openAttemptId = this.#openBatchAttemptByChannel.get(attempt.channelId);
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
    this.#reservePaymentIdentifier(attempt.paymentIdentifier, attempt.createdAt);
    this.#batchAttempts.set(attempt.attemptId, clone(attempt));
    this.#openBatchAttemptByChannel.set(
      attempt.channelId,
      attempt.attemptId,
    );
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
    this.#updatePaymentIdentifierReservation(attempt.paymentIdentifier, {
      status: "pending",
      updatedAt: startedAt,
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
    this.#updatePaymentIdentifierReservation(attempt.paymentIdentifier, {
      status: "pending",
      recoveryReason: undefined,
      updatedAt: completedAt,
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
      throw new Error("uncertain or completed batch settlement cannot be abandoned");
    }
    this.#requireChannelOperation(attempt.channelId, attempt.attemptId);
    this.#releasePaymentIdentifierReservation(
      attempt.paymentIdentifier,
      reason,
      observedAt,
    );
    this.#batchAttempts.delete(attempt.attemptId);
    this.#openBatchAttemptByChannel.delete(attempt.channelId);
    this.#channelOperations.delete(attempt.channelId);
    this.#channelByLeaseId.delete(attempt.attemptId);
    if (attempt.paymentIdentifier) {
      this.#terminalizeBudgetRecord(
        `batch:${attempt.attemptId}`,
        durableByteLength({
          paymentIdentifierReservation:
            this.#paymentIdentifierReservations.get(attempt.paymentIdentifier.id),
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
    this.#updatePaymentIdentifierReservation(attempt.paymentIdentifier, {
      status: "recovery-required",
      recoveryReason: reason,
      updatedAt: observedAt,
    });
  }

  async commitExactPayment(record: ExactSettlementCommit): Promise<void> {
    const payment = clone(record.payment);
    const key = exactPaymentKey(payment.transactionId);
    const existing = this.#exactPayments.get(key);
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
    const attempt = this.#exactAttempts.get(
      payment.transactionId.toLowerCase(),
    );
    if (record.paymentIdentifier) {
      if (!attempt)
        throw new Error("payment identifier completion requires its reserved attempt");
      this.#assertCompletedPaymentIdentifier(attempt, record.paymentIdentifier);
    }
    let appliedAttempt: ExactSettlementAttemptRecord | undefined;
    let terminalBudgetBytes: number | undefined;
    if (attempt) {
      if (
        attempt.status !== "accepted" ||
        !attempt.handlerStartedAt ||
        !attempt.handlerResult
      ) {
        throw new Error("exact settlement attempt is not ready to apply");
      }
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
      terminalBudgetBytes = durableByteLength({
        attempt: appliedAttempt,
        payment,
        paymentIdentifier: record.paymentIdentifier,
      });
      this.#assertTerminalBudgetFits(
        `exact:${attempt.transactionId}`,
        terminalBudgetBytes,
      );
      this.#exactAttempts.set(payment.transactionId, appliedAttempt);
    }
    if (record.paymentIdentifier) {
      this.#paymentIdentifiers.set(
        record.paymentIdentifier.id,
        clone(record.paymentIdentifier),
      );
      this.#completePaymentIdentifierReservation(
        attempt!.paymentIdentifier!,
        new Date().toISOString(),
      );
    }
    this.#exactPayments.set(key, payment);
    if (attempt) {
      this.#terminalizeBudgetRecord(
        `exact:${attempt.transactionId}`,
        terminalBudgetBytes!,
        undefined,
        record.paymentIdentifier?.id,
      );
    }
  }

  async registerExactHead(input: ExactHeadRecord): Promise<ExactHeadRecord> {
    const record = normalizeExactHeadRecord(input);
    const existing = this.#exactHeads.get(record.headId);
    if (existing) {
      if (stableJson(existing) !== stableJson(record))
        throw new Error(
          "exact head id is already registered for different state",
        );
      return clone(existing);
    }
    for (const current of this.#exactHeads.values()) {
      if (sameOutpoint(current.currentOutpoint, record.currentOutpoint)) {
        throw new Error("exact head outpoint is already registered");
      }
    }
    this.#exactHeads.set(record.headId, clone(record));
    return clone(record);
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
    const attempt = normalizeExactSettlementAttempt(input);
    const existing = this.#exactAttempts.get(attempt.transactionId);
    if (existing) {
      if (!exactSettlementAttemptsMatch(existing, attempt))
        throw new Error(
          "exact transaction is already claimed for a different request",
        );
      return { attempt: clone(existing), created: false };
    }
    this.#assertPaymentIdentifierClaimAvailable(attempt.paymentIdentifier);
    let claimedHead: ExactHeadRecord | undefined;
    if (attempt.profile === "additive") {
      if (!attempt.head)
        throw new Error("additive exact settlement requires a head claim");
      const head = this.#exactHeads.get(attempt.head.headId);
      if (!head) throw new Error("exact head changed before settlement claim");
      claimedHead = claimExactHead(head, attempt);
    } else if (attempt.head) {
      throw new Error("standard-native exact settlement cannot claim a head");
    }
    this.#admitBudgetRecord(
      `exact:${attempt.transactionId}`,
      "exact",
      attempt.transactionId,
      attempt.payerId,
      attempt.paymentIdentifier?.id,
      durableOpenRecordBytes(attempt),
      attempt.paymentIdentifier,
    );
    if (claimedHead) this.#exactHeads.set(claimedHead.headId, claimedHead);
    this.#reservePaymentIdentifier(attempt.paymentIdentifier, attempt.createdAt);
    this.#exactAttempts.set(attempt.transactionId, clone(attempt));
    return { attempt: clone(attempt), created: true };
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
    const attempt = this.#requireExactAttempt(transactionId);
    if (attempt.status === "accepted" || attempt.status === "applied") return;
    this.#exactAttempts.set(attempt.transactionId, {
      ...attempt,
      status: "broadcast",
      finality,
      updatedAt: observedAt,
    });
    this.#updatePaymentIdentifierReservation(attempt.paymentIdentifier, {
      status: "pending",
      updatedAt: observedAt,
    });
  }

  async acceptExactSettlement(
    transactionId: Hash32Hex,
    finality: "accepted" | "confirmed",
    observedAt: string,
  ): Promise<void> {
    const attempt = this.#requireExactAttempt(transactionId);
    if (attempt.status === "applied") return;
    if (attempt.head) {
      const head = this.#exactHeads.get(attempt.head.headId);
      if (!head)
        throw new Error(
          "exact head was not found during settlement acceptance",
        );
      this.#exactHeads.set(
        head.headId,
        acceptExactHead(head, attempt, observedAt),
      );
    }
    this.#exactAttempts.set(attempt.transactionId, {
      ...attempt,
      status: "accepted",
      finality,
      updatedAt: observedAt,
    });
    this.#updatePaymentIdentifierReservation(attempt.paymentIdentifier, {
      status: "pending",
      updatedAt: observedAt,
    });
  }

  async beginExactHandler(
    transactionId: Hash32Hex,
    startedAt: string,
  ): Promise<boolean> {
    const attempt = this.#requireExactAttempt(transactionId);
    if (attempt.status !== "accepted" || attempt.handlerStartedAt) return false;
    this.#exactAttempts.set(attempt.transactionId, {
      ...attempt,
      handlerStartedAt: startedAt,
      updatedAt: startedAt,
    });
    this.#updatePaymentIdentifierReservation(attempt.paymentIdentifier, {
      status: "pending",
      updatedAt: startedAt,
    });
    return true;
  }

  async recordExactHandlerResult(
    transactionId: Hash32Hex,
    result: import("./types.js").ProtectedHandlerResult,
    completedAt: string,
  ): Promise<void> {
    const attempt = this.#requireExactAttempt(transactionId);
    assertExactHandlerResultTransition(attempt, result, completedAt);
    if (attempt.handlerResult) {
      if (stableJson(attempt.handlerResult) !== stableJson(result))
        throw new Error("exact handler result conflicts with durable state");
      return;
    }
    this.#exactAttempts.set(attempt.transactionId, {
      ...attempt,
      handlerResult: clone(result),
      handlerCompletedAt: completedAt,
      recoveryReason: undefined,
      updatedAt: completedAt,
    });
    this.#updatePaymentIdentifierReservation(attempt.paymentIdentifier, {
      status: "pending",
      recoveryReason: undefined,
      updatedAt: completedAt,
    });
  }

  async markExactHandlerRecoveryRequired(
    transactionId: Hash32Hex,
    reason: string,
    observedAt: string,
  ): Promise<void> {
    const attempt = this.#requireExactAttempt(transactionId);
    if (
      attempt.status !== "accepted" ||
      !attempt.handlerStartedAt ||
      attempt.handlerResult
    ) {
      throw new Error("exact handler is not awaiting recovery");
    }
    this.#exactAttempts.set(attempt.transactionId, {
      ...attempt,
      recoveryReason: reason,
      updatedAt: observedAt,
    });
    this.#updatePaymentIdentifierReservation(attempt.paymentIdentifier, {
      status: "recovery-required",
      recoveryReason: reason,
      updatedAt: observedAt,
    });
  }

  async abandonExactSettlement(
    transactionId: Hash32Hex,
    reason: string,
    observedAt: string,
  ): Promise<void> {
    const attempt = this.#requireExactAttempt(transactionId);
    if (attempt.status === "accepted" || attempt.status === "applied")
      throw new Error("accepted exact settlement cannot be abandoned");
    if (
      attempt.handlerStartedAt ||
      attempt.handlerResult ||
      attempt.recoveryReason
    ) {
      throw new Error("uncertain exact settlement cannot be abandoned");
    }
    let releasedHead: ExactHeadRecord | undefined;
    if (attempt.head) {
      const head = this.#exactHeads.get(attempt.head.headId);
      if (head) releasedHead = releaseExactHeadClaim(head, attempt, observedAt);
    }
    this.#releasePaymentIdentifierReservation(
      attempt.paymentIdentifier,
      reason,
      observedAt,
      true,
    );
    if (releasedHead) this.#exactHeads.set(releasedHead.headId, releasedHead);
    this.#exactAttempts.delete(attempt.transactionId);
    if (attempt.paymentIdentifier) {
      this.#terminalizeBudgetRecord(
        `exact:${attempt.transactionId}`,
        durableByteLength({
          paymentIdentifierReservation:
            this.#paymentIdentifierReservations.get(attempt.paymentIdentifier.id),
        }),
        undefined,
        attempt.paymentIdentifier.id,
        true,
      );
    } else {
      this.#deleteBudgetRecord(`exact:${attempt.transactionId}`);
    }
  }

  async markExactHeadUnavailable(
    input: ExactHeadUnavailableApply,
  ): Promise<ExactHeadUnavailableResult> {
    const head = this.#exactHeads.get(input.headId.toLowerCase());
    if (!head) throw new Error("exact head was not found");
    if (head.status === "retired")
      throw new Error("retired exact head cannot be marked unavailable");
    if (!exactHeadMatchesUnavailableSnapshot(head, input)) {
      return { applied: false, head: clone(head) };
    }
    const unavailable = {
      ...head,
      status: "unavailable",
      unavailableReason: input.reason,
      updatedAt: input.observedAt,
    } as const;
    this.#exactHeads.set(head.headId, unavailable);
    return { applied: true, head: clone(unavailable) };
  }

  async applyExactHeadLineage(
    input: ExactHeadLineageApply,
  ): Promise<ExactHeadRecord> {
    const head = this.#exactHeads.get(input.headId.toLowerCase());
    if (!head) throw new Error("exact head was not found");
    const advanced = applyExactHeadLineageRecord(head, input);
    this.#exactHeads.set(advanced.headId, clone(advanced));
    return clone(advanced);
  }

  #requireExactAttempt(transactionId: Hash32Hex): ExactSettlementAttemptRecord {
    const attempt = this.#exactAttempts.get(transactionId.toLowerCase());
    if (!attempt) throw new Error("exact settlement attempt was not found");
    return attempt;
  }

  #requireBatchAttempt(attemptId: Hash32Hex): BatchSettlementAttemptRecord {
    const attempt = this.#batchAttempts.get(attemptId.toLowerCase());
    if (!attempt) throw new Error("batch settlement attempt was not found");
    return attempt;
  }

  #assertPaymentIdentifierClaimAvailable(
    claim: PaymentIdentifierReservationClaim | undefined,
  ): void {
    if (!claim) return;
    assertPaymentIdentifierReservationClaim(claim);
    const completed = this.#paymentIdentifiers.get(claim.id);
    if (
      completed &&
      (completed.fingerprint !== claim.fingerprint ||
        completed.paymentPayloadHash !== claim.paymentPayloadHash ||
        completed.paymentScopeId !== claim.paymentScopeId)
    ) {
      throw new Error("payment identifier is already owned by another payment");
    }
    const existing = this.#paymentIdentifierReservations.get(claim.id);
    if (
      existing &&
      existing.status !== "safely-released" &&
      !paymentIdentifierReservationClaimsMatch(existing, claim)
    ) {
      throw new Error("payment identifier is already owned by another payment");
    }
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

  #reservePaymentIdentifier(
    claim: PaymentIdentifierReservationClaim | undefined,
    observedAt: string,
  ): void {
    if (!claim) return;
    const existing = this.#paymentIdentifierReservations.get(claim.id);
    if (existing && existing.status !== "safely-released") return;
    this.#paymentIdentifierReservations.set(claim.id, {
      ...clone(claim),
      status: "reserved",
      createdAt: observedAt,
      updatedAt: observedAt,
    });
  }

  #updatePaymentIdentifierReservation(
    claim: PaymentIdentifierReservationClaim | undefined,
    update: Pick<PaymentIdentifierReservationRecord, "status" | "updatedAt"> &
      Pick<Partial<PaymentIdentifierReservationRecord>, "recoveryReason">,
  ): void {
    if (!claim) return;
    const existing = this.#paymentIdentifierReservations.get(claim.id);
    if (!existing || !paymentIdentifierReservationClaimsMatch(existing, claim))
      throw new Error("payment identifier reservation ownership changed");
    if (
      existing.status === "completed" ||
      existing.status === "safely-released"
    )
      throw new Error("terminal payment identifier reservation cannot change");
    this.#paymentIdentifierReservations.set(claim.id, {
      ...existing,
      ...update,
    });
  }

  #completePaymentIdentifierReservation(
    claim: PaymentIdentifierReservationClaim,
    observedAt: string,
  ): void {
    const existing = this.#paymentIdentifierReservations.get(claim.id);
    if (!existing || !paymentIdentifierReservationClaimsMatch(existing, claim))
      throw new Error("payment identifier completion lost its reservation");
    if (existing.status === "safely-released")
      throw new Error("released payment identifier cannot be completed");
    this.#paymentIdentifierReservations.set(claim.id, {
      ...existing,
      status: "completed",
      recoveryReason: undefined,
      updatedAt: observedAt,
    });
  }

  #releasePaymentIdentifierReservation(
    claim: PaymentIdentifierReservationClaim | undefined,
    reason: string,
    observedAt: string,
    allowPending = false,
  ): void {
    if (!claim) return;
    const existing = this.#paymentIdentifierReservations.get(claim.id);
    if (!existing || !paymentIdentifierReservationClaimsMatch(existing, claim))
      throw new Error("payment identifier release lost its reservation");
    if (
      (existing.status !== "reserved" &&
        !(allowPending && existing.status === "pending")) ||
      existing.recoveryReason !== undefined
    )
      throw new Error("uncertain or completed payment identifier cannot be released");
    this.#paymentIdentifierReservations.set(claim.id, {
      ...existing,
      status: "safely-released",
      recoveryReason: reason,
      updatedAt: observedAt,
    });
  }

  #assertCompletedPaymentIdentifier(
    attempt:
      | BatchSettlementAttemptRecord
      | ExactSettlementAttemptRecord
      | undefined,
    completed: PaymentIdentifierRecord | undefined,
  ): void {
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
    ) {
      throw new Error("payment identifier completion does not match reservation");
    }
    const reservation = this.#paymentIdentifierReservations.get(claim.id);
    if (
      !reservation ||
      !paymentIdentifierReservationClaimsMatch(reservation, claim) ||
      reservation.status === "safely-released"
    )
      throw new Error("payment identifier completion lost its reservation");
    this.#assertPaymentIdentifierClaimAvailable(claim);
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
      parseBatchLaneAmount(next.chargedCumulativeAmount, "next charged amount") <
        parseBatchLaneAmount(previous.chargedCumulativeAmount, "previous charged amount") ||
      parseBatchLaneAmount(next.signedMaxClaimable, "next signed ceiling") <
        parseBatchLaneAmount(previous.signedMaxClaimable, "previous signed ceiling") ||
      next.lastCommitmentId !== commitment.commitmentId
      || next.version !== incrementVersion(previous.version) ||
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
      throw new Error("claim transition is not the reserved monotonic successor");
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
    const openAttemptId = this.#openClaimAttemptByChannel.get(attempt.channelId);
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
      throw new Error("durable terminal bundle exceeded its reserved byte quota");
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
      throw new Error("durable terminal bundle exceeded its reserved byte quota");
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
            this.#paymentIdentifierReservations.delete(record.paymentIdentifier);
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
      const bytes = durableByteLength({
        attemptId: record.attemptId,
        payment: this.#exactPayments.get(exactPaymentKey(record.attemptId)),
        commitment: record.commitmentId
          ? this.#commitments.get(record.commitmentId)
          : undefined,
        paymentIdentifier: record.paymentIdentifier
          ? this.#paymentIdentifiers.get(record.paymentIdentifier)
          : undefined,
      });
      this.#budgetBytes += bytes - record.bytes;
      this.#budgetRecords.set(key, {
        ...record,
        bytes,
        compactedAt: this.#now(),
      });
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

function exactHeadMatchesUnavailableSnapshot(
  head: ExactHeadRecord,
  input: ExactHeadUnavailableApply,
): boolean {
  return (
    head.version === input.expectedVersion &&
    sameOutpoint(head.currentOutpoint, input.expectedOutpoint) &&
    head.currentAmount === input.expectedAmount &&
    head.status === input.expectedStatus
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

function durableByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function durableOpenRecordBytes(value: unknown): number {
  // Terminal replay state may cache the response in both the payment or
  // commitment and the payment-identifier record. Reserve both copies before
  // protected work starts so a successful effect cannot exceed the byte quota.
  return durableByteLength(value) + 2 * MAX_DURABLE_RESPONSE_BYTES;
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
    throw new Error("channel operation identifiers must be canonical lowercase");
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
    if (!claim.channelId || claim.transactionId || claim.paymentOutputIndex !== undefined)
      throw new Error("batch payment identifier ownership is invalid");
  } else if (claim.paymentKind === "exact") {
    if (
      !claim.transactionId ||
      claim.channelId ||
      !Number.isInteger(claim.paymentOutputIndex) ||
      claim.paymentOutputIndex! < 0
    )
      throw new Error("exact payment identifier ownership is invalid");
  } else {
    throw new Error("payment identifier kind is invalid");
  }
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

function assertExactHandlerResultTransition(
  attempt: ExactSettlementAttemptRecord,
  result: import("./types.js").ProtectedHandlerResult,
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
  if (!(
    (existing.status === "pending" && input.status === "broadcast") ||
    (existing.status === "broadcast" && input.status === "accepted")
  )) {
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
      throw new Error("broadcast-only claim attempt cannot have acceptance evidence");
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
      decideChainEvidence(
        attempt.acceptance,
        attempt.requiredConfirmations,
      ).status !== "confirmed"
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
