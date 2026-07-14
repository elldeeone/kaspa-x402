import { parseSompiString, type Hash32Hex } from "@kaspa-x402/core";
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
  ChannelLockManager,
  ClaimAttemptRecord,
  ExactPaymentRecord,
  ExactSettlementCommit,
  ExactHeadRecord,
  ExactHeadLineageApply,
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
  readonly #commitments = new Map<Hash32Hex, BatchCommitmentRecord>();
  readonly #exactPayments = new Map<string, ExactPaymentRecord>();
  readonly #exactHeads = new Map<Hash32Hex, ExactHeadRecord>();
  readonly #exactAttempts = new Map<Hash32Hex, ExactSettlementAttemptRecord>();
  readonly #paymentIdentifiers = new Map<string, PaymentIdentifierRecord>();
  readonly #claimAttempts = new Map<Hash32Hex, ClaimAttemptRecord>();

  constructor(channels: readonly ServerChannelRecord[] = []) {
    for (const channel of channels)
      this.#channels.set(channel.channelId, clone(channel));
  }

  async loadChannel(
    channelId: Hash32Hex,
  ): Promise<ServerChannelRecord | undefined> {
    const channel = this.#channels.get(channelId);
    return channel ? clone(channel) : undefined;
  }

  async saveChannel(channel: ServerChannelRecord): Promise<void> {
    this.#channels.set(channel.channelId, clone(channel));
  }

  async retireChannel(channelId: Hash32Hex): Promise<void> {
    const channel = this.#channels.get(channelId);
    if (!channel) return;
    this.#channels.set(channelId, { ...channel, status: "retired" });
  }

  async listChannels(): Promise<ServerChannelRecord[]> {
    return Array.from(this.#channels.values()).map(clone);
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
    const current = this.#channels.get(record.expected.channelId);
    if (!matchesExpectedChannel(current, record.expected)) {
      throw new Error("channel state changed before settlement commit");
    }
    const paymentIdentifier = record.paymentIdentifier
      ? clone(record.paymentIdentifier)
      : undefined;
    const commitment = clone(record.commitment);
    const channel = clone(record.channel);
    if (paymentIdentifier)
      this.#assertPaymentIdentifierAvailable(paymentIdentifier);
    this.#commitments.set(commitment.commitmentId, commitment);
    if (paymentIdentifier)
      this.#paymentIdentifiers.set(paymentIdentifier.id, paymentIdentifier);
    this.#channels.set(channel.channelId, channel);
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
      if (attempt.status !== "accepted" || !attempt.handlerStartedAt) {
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
    headId: Hash32Hex,
    reason: string,
    observedAt: string,
  ): Promise<void> {
    const head = this.#exactHeads.get(headId.toLowerCase());
    if (!head) throw new Error("exact head was not found");
    if (head.status === "retired")
      throw new Error("retired exact head cannot be marked unavailable");
    this.#exactHeads.set(head.headId, {
      ...head,
      status: "unavailable",
      unavailableReason: reason,
      updatedAt: observedAt,
    });
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

  #assertPaymentIdentifierAvailable(
    paymentIdentifier: PaymentIdentifierRecord,
  ): void {
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
    for (const record of this.#claimAttempts.values()) {
      if (record.channelId === channelId && record.status !== "applied")
        return clone(record);
    }
    return undefined;
  }

  async saveClaimAttempt(record: ClaimAttemptRecord): Promise<void> {
    for (const existing of this.#claimAttempts.values()) {
      if (
        existing.channelId === record.channelId &&
        existing.status !== "applied" &&
        existing.attemptId !== record.attemptId
      ) {
        throw new Error("claim attempt is already pending");
      }
    }
    this.#claimAttempts.set(record.attemptId, clone(record));
  }

  async applyClaimAttempt(
    channel: ServerChannelRecord,
    attempt: ClaimAttemptRecord,
  ): Promise<void> {
    const currentAttempt = this.#claimAttempts.get(attempt.attemptId);
    if (!currentAttempt || currentAttempt.status === "applied") {
      throw new Error("claim attempt is not open");
    }
    const currentChannel = this.#channels.get(channel.channelId);
    if (
      !currentChannel ||
      currentChannel.activeOutpoint.txid.toLowerCase() !==
        attempt.activeOutpoint.txid.toLowerCase() ||
      currentChannel.activeOutpoint.index !== attempt.activeOutpoint.index ||
      currentChannel.activeScriptPublicKey.toLowerCase() !==
        attempt.activeScriptPublicKey.toLowerCase() ||
      currentChannel.fundingAmount !== attempt.fundingAmount ||
      currentChannel.chargedCumulativeAmount !==
        attempt.chargedCumulativeAmount ||
      currentChannel.claimedCumulativeAmount !==
        attempt.claimedCumulativeAmount ||
      currentChannel.signedMaxClaimable !== attempt.signedMaxClaimable ||
      currentChannel.voucherSignature !== attempt.voucherSignature ||
      currentChannel.status !== attempt.channelStatus
    ) {
      throw new Error("channel state changed before claim apply");
    }
    this.#channels.set(channel.channelId, clone(channel));
    this.#claimAttempts.set(attempt.attemptId, {
      ...clone(attempt),
      status: "applied",
    });
  }

  async abandonClaimAttempt(attemptId: Hash32Hex): Promise<void> {
    const currentAttempt = this.#claimAttempts.get(attemptId);
    if (!currentAttempt || currentAttempt.status === "applied") return;
    this.#claimAttempts.delete(attemptId);
  }
}

export class MemoryChannelLockManager implements ChannelLockManager {
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
  const charged = parseSompiString(channel.chargedCumulativeAmount);
  const claimed = parseSompiString(channel.claimedCumulativeAmount);
  if (claimed > charged)
    throw new Error("claimed amount cannot exceed charged amount");
  return charged - claimed;
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
    current.chargedCumulativeAmount === expected.chargedCumulativeAmount &&
    current.claimedCumulativeAmount === expected.claimedCumulativeAmount &&
    current.signedMaxClaimable === expected.signedMaxClaimable &&
    current.status === expected.status &&
    current.activeOutpoint.txid.toLowerCase() ===
      expected.activeOutpoint.txid.toLowerCase() &&
    current.activeOutpoint.index === expected.activeOutpoint.index &&
    current.activeScriptPublicKey.toLowerCase() ===
      expected.activeScriptPublicKey.toLowerCase()
  );
}
