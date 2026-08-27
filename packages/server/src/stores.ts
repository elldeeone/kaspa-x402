import {
  batchLaneAccounting,
  parseBatchLaneAmount,
  type Hash32Hex,
} from "@kaspa-x402/core";
import {
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
  ServerChannelRecord,
  ServerStateStore,
  SettlementCommit,
} from "./types.js";

export class MemoryServerChannelStore implements ServerStateStore {
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
    { attemptId: Hash32Hex; fingerprint: Hash32Hex; paymentEvidenceHash: Hash32Hex; channelId: Hash32Hex }
  >();
  readonly #claimAttempts = new Map<Hash32Hex, ClaimAttemptRecord>();
  readonly #abandonedClaimAttempts = new Map<Hash32Hex, string>();

  constructor(channels: readonly ServerChannelRecord[] = []) {
    for (const channel of channels) this.#setChannel(channel);
  }

  async loadChannel(
    channelId: Hash32Hex,
  ): Promise<ServerChannelRecord | undefined> {
    const channel = this.#channels.get(canonicalHash32(channelId));
    return channel ? clone(channel) : undefined;
  }

  async saveChannel(channel: ServerChannelRecord): Promise<void> {
    this.#setChannel(channel);
  }

  async retireChannel(channelId: Hash32Hex): Promise<void> {
    const key = canonicalHash32(channelId);
    const channel = this.#channels.get(key);
    if (!channel) return;
    this.#channels.set(key, { ...channel, status: "retired" });
  }

  async listChannels(): Promise<ServerChannelRecord[]> {
    return Array.from(this.#channels.values()).map(clone);
  }

  #setChannel(channel: ServerChannelRecord): void {
    const { channelId, covenantId } = this.#assertChannelBinding(channel);
    this.#channelByCovenantId.set(covenantId, channelId);
    this.#channels.set(channelId, canonicalChannelRecord(channel));
  }

  #assertChannelBinding(channel: ServerChannelRecord): {
    channelId: Hash32Hex;
    covenantId: Hash32Hex;
  } {
    const channelId = canonicalHash32(channel.channelId);
    const covenantId = canonicalHash32(channel.covenantId);
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

  async loadExactPayment(
    transactionId: Hash32Hex,
  ): Promise<ExactPaymentRecord | undefined> {
    const record = this.#exactPayments.get(exactPaymentKey(transactionId));
    return record ? clone(record) : undefined;
  }

  async commitSettlement(record: SettlementCommit): Promise<void> {
    const current = this.#channels.get(
      canonicalHash32(record.expected.channelId),
    );
    if (!matchesExpectedChannel(current, record.expected)) {
      throw new Error("channel state changed before settlement commit");
    }
    const attempt = this.#batchAttempts.get(record.batchAttemptId);
    if (!batchSettlementAttemptIsReadyToCommit(attempt, record)) {
      throw new Error("batch settlement attempt is not ready to apply");
    }
    const paymentIdentifier = record.paymentIdentifier
      ? clone(record.paymentIdentifier)
      : undefined;
    const commitment = clone(record.commitment);
    const channel = clone(record.channel);
    if (paymentIdentifier) {
      this.#assertPaymentIdentifierAvailable(
        paymentIdentifier,
        attempt.attemptId,
      );
      const reservation = this.#paymentIdentifierReservations.get(
        paymentIdentifier.id,
      );
      if (!reservation || reservation.attemptId !== attempt.attemptId)
        throw new Error("payment identifier is not reserved by this batch attempt");
    }
    this.#assertChannelBinding(channel);
    this.#commitments.set(commitment.commitmentId, commitment);
    if (paymentIdentifier) {
      this.#paymentIdentifiers.set(paymentIdentifier.id, paymentIdentifier);
      this.#paymentIdentifierReservations.delete(paymentIdentifier.id);
    }
    this.#setChannel(channel);
    this.#batchAttempts.set(attempt.attemptId, {
      ...attempt,
      status: "applied",
      updatedAt: new Date().toISOString(),
    });
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
    const currentChannel = this.#channels.get(
      canonicalHash32(attempt.channelId),
    );
    if (
      attempt.prior
        ? !currentChannel || !matchesExpectedChannel(currentChannel, attempt.prior)
        : currentChannel !== undefined
    ) {
      throw new Error("channel state changed before batch settlement claim");
    }
    for (const current of this.#batchAttempts.values()) {
      if (
        current.channelId === attempt.channelId &&
        current.status === "pending"
      ) {
        throw new Error("channel already has a pending batch settlement");
      }
    }
    for (const current of this.#claimAttempts.values()) {
      if (
        current.channelId === attempt.channelId &&
        current.status !== "applied"
      ) {
        throw new Error("channel already has a pending claim attempt");
      }
    }
    if (attempt.paymentIdentifier) {
      const committed = this.#paymentIdentifiers.get(attempt.paymentIdentifier);
      if (committed)
        throw new Error("payment identifier was already committed");
      const reserved = this.#paymentIdentifierReservations.get(
        attempt.paymentIdentifier,
      );
      if (reserved && reserved.attemptId !== attempt.attemptId)
        throw new Error("payment identifier is already reserved");
    }
    this.#assertChannelBinding(attempt.adoptedChannel);
    if (attempt.paymentIdentifier) {
      this.#paymentIdentifierReservations.set(attempt.paymentIdentifier, {
        attemptId: attempt.attemptId,
        fingerprint: attempt.requestFingerprint,
        paymentEvidenceHash: attempt.paymentEvidenceHash,
        channelId: attempt.channelId,
      });
    }
    this.#setChannel(attempt.adoptedChannel);
    this.#batchAttempts.set(attempt.attemptId, clone(attempt));
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
    if (record.paymentIdentifier) {
      const existingIdentifier = this.#paymentIdentifiers.get(
        record.paymentIdentifier.id,
      );
      if (
        existingIdentifier &&
        (existingIdentifier.fingerprint !==
          record.paymentIdentifier.fingerprint ||
          existingIdentifier.paymentPayloadHash !==
            record.paymentIdentifier.paymentPayloadHash ||
          existingIdentifier.paymentScopeId !==
            record.paymentIdentifier.paymentScopeId)
      ) {
        throw new Error(
          "payment identifier was already committed for a different payment",
        );
      }
      this.#paymentIdentifiers.set(
        record.paymentIdentifier.id,
        clone(record.paymentIdentifier),
      );
    }
    const attempt = this.#exactAttempts.get(
      payment.transactionId.toLowerCase(),
    );
    if (attempt) {
      if (
        attempt.status !== "accepted" ||
        !attempt.handlerStartedAt ||
        !attempt.handlerResult
      ) {
        throw new Error("exact settlement attempt is not ready to apply");
      }
      this.#exactAttempts.set(payment.transactionId, {
        ...attempt,
        status: "applied",
        updatedAt: new Date().toISOString(),
      });
    }
    this.#exactPayments.set(key, payment);
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
    if (attempt.profile === "additive") {
      if (!attempt.head)
        throw new Error("additive exact settlement requires a head claim");
      const head = this.#exactHeads.get(attempt.head.headId);
      if (!head) throw new Error("exact head changed before settlement claim");
      this.#exactHeads.set(head.headId, claimExactHead(head, attempt));
    } else if (attempt.head) {
      throw new Error("standard-native exact settlement cannot claim a head");
    }
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
  }

  async abandonExactSettlement(
    transactionId: Hash32Hex,
    reason: string,
    observedAt: string,
  ): Promise<void> {
    const attempt = this.#requireExactAttempt(transactionId);
    if (attempt.status === "accepted" || attempt.status === "applied")
      throw new Error("accepted exact settlement cannot be abandoned");
    if (attempt.head) {
      const head = this.#exactHeads.get(attempt.head.headId);
      if (head)
        this.#exactHeads.set(
          head.headId,
          releaseExactHeadClaim(head, attempt, observedAt),
        );
    }
    this.#exactAttempts.delete(attempt.transactionId);
    void reason;
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

  #assertPaymentIdentifierAvailable(
    paymentIdentifier: PaymentIdentifierRecord,
    reservedAttemptId?: Hash32Hex,
  ): void {
    const reserved = this.#paymentIdentifierReservations.get(
      paymentIdentifier.id,
    );
    if (reserved && reserved.attemptId !== reservedAttemptId)
      throw new Error("payment identifier is reserved by pending batch work");
    const existingIdentifier = this.#paymentIdentifiers.get(
      paymentIdentifier.id,
    );
    if (
      existingIdentifier &&
      (existingIdentifier.fingerprint !== paymentIdentifier.fingerprint ||
        existingIdentifier.paymentPayloadHash !==
          paymentIdentifier.paymentPayloadHash ||
        existingIdentifier.paymentScopeId !== paymentIdentifier.paymentScopeId)
    ) {
      throw new Error(
        "payment identifier was already committed for a different payment",
      );
    }
  }

  async loadOpenClaimAttempt(
    channelId: Hash32Hex,
  ): Promise<ClaimAttemptRecord | undefined> {
    const key = canonicalHash32(channelId);
    for (const record of this.#claimAttempts.values()) {
      if (record.channelId === key && record.status !== "applied")
        return clone(record);
    }
    return undefined;
  }

  async saveClaimAttempt(record: ClaimAttemptRecord): Promise<void> {
    const abandonedEpoch = this.#abandonedClaimAttempts.get(
      canonicalHash32(record.attemptId),
    );
    if (abandonedEpoch) {
      if (
        record.status !== "pending" ||
        record.attemptEpoch === abandonedEpoch
      ) {
        throw new Error("claim attempt execution epoch was abandoned");
      }
    }
    const existing = this.#claimAttempts.get(record.attemptId);
    const attempt = normalizeClaimAttempt(record, existing);
    for (const batchAttempt of this.#batchAttempts.values()) {
      if (
        batchAttempt.channelId === attempt.channelId &&
        batchAttempt.status === "pending"
      ) {
        throw new Error("batch settlement attempt is already pending");
      }
    }
    for (const existing of this.#claimAttempts.values()) {
      if (
        existing.channelId === attempt.channelId &&
        existing.status !== "applied" &&
        existing.attemptId !== attempt.attemptId
      ) {
        throw new Error("claim attempt is already pending");
      }
    }
    if (abandonedEpoch)
      this.#abandonedClaimAttempts.delete(attempt.attemptId);
    this.#claimAttempts.set(attempt.attemptId, attempt);
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
    const currentChannel = this.#channels.get(
      canonicalHash32(channel.channelId),
    );
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
    this.#setChannel(channel);
    this.#claimAttempts.set(currentAttempt.attemptId, {
      ...clone(currentAttempt),
      status: "applied",
    });
  }

  async abandonClaimAttempt(attemptId: Hash32Hex): Promise<void> {
    const currentAttempt = this.#claimAttempts.get(attemptId);
    if (!currentAttempt || currentAttempt.status === "applied") return;
    this.#claimAttempts.delete(attemptId);
    this.#abandonedClaimAttempts.set(
      canonicalHash32(attemptId),
      currentAttempt.attemptEpoch,
    );
  }
}

export class MemoryChannelLockManager implements ChannelLockManager {
  readonly #tails = new Map<Hash32Hex, Promise<void>>();

  async runExclusive<T>(
    channelId: Hash32Hex,
    fn: () => Promise<T>,
  ): Promise<T> {
    const key = canonicalHash32(channelId);
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => next);
    this.#tails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}

export function activeChargedAmount(channel: ServerChannelRecord): bigint {
  return batchLaneAccounting(channel).activeChargedAmount;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function canonicalHash32(value: Hash32Hex): Hash32Hex {
  return value.toLowerCase() as Hash32Hex;
}

function canonicalChannelRecord(
  channel: ServerChannelRecord,
): ServerChannelRecord {
  const stored = clone(channel);
  stored.channelId = canonicalHash32(stored.channelId);
  stored.covenantId = canonicalHash32(stored.covenantId);
  stored.genesisEvidence.covenantId = stored.covenantId;
  return stored;
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
  if (new TextEncoder().encode(serialized).byteLength > 256 * 1024)
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
    ...leftArtifact
  } = left;
  const {
    status: _rightStatus,
    finality: _rightFinality,
    ...rightArtifact
  } = right;
  return stableJson(leftArtifact) === stableJson(rightArtifact);
}

function assertClaimAttemptShape(attempt: ClaimAttemptRecord): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      attempt.attemptEpoch,
    )
  ) {
    throw new Error("claim attempt execution epoch must be a lowercase UUID v4");
  }
  if (
    attempt.requiredFinality !== "accepted" &&
    attempt.requiredFinality !== "confirmed"
  ) {
    throw new Error("claim attempt required finality is invalid");
  }
  if (
    !isLowerHash32(attempt.attemptId) ||
    !isLowerHash32(attempt.channelId) ||
    !isNonzeroLowerHash32(attempt.covenantId) ||
    !isLowerHash32(attempt.activeOutpoint.txid) ||
    !isLowerHash32(attempt.transactionId)
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
    if (attempt.finality !== undefined)
      throw new Error("pending claim attempt cannot have finality");
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
    return;
  }
  if (attempt.status === "accepted" || attempt.status === "applied") {
    if (attempt.finality !== "accepted" && attempt.finality !== "confirmed")
      throw new Error("accepted claim attempt requires accepted finality");
    if (
      attempt.requiredFinality === "confirmed" &&
      attempt.finality !== "confirmed"
    ) {
      throw new Error(
        "accepted claim attempt has not reached required finality",
      );
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
