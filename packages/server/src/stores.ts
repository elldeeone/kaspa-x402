import { parseSompiString, type Hash32Hex } from "@kaspa-x402/core";
import type {
  BatchCommitmentRecord,
  ChannelLockManager,
  ClaimAttemptRecord,
  ExactReservationRecord,
  ExactPaymentRecord,
  ExactSettlementCommit,
  PaymentIdentifierRecord,
  ServerChannelRecord,
  ServerStateStore,
  SettlementCommit,
} from "./types.js";

export class MemoryServerChannelStore implements ServerStateStore {
  readonly #channels = new Map<Hash32Hex, ServerChannelRecord>();
  readonly #commitments = new Map<Hash32Hex, BatchCommitmentRecord>();
  readonly #exactPayments = new Map<string, ExactPaymentRecord>();
  readonly #exactReservations = new Map<Hash32Hex, ExactReservationRecord>();
  readonly #paymentIdentifiers = new Map<string, PaymentIdentifierRecord>();
  readonly #claimAttempts = new Map<Hash32Hex, ClaimAttemptRecord>();

  constructor(channels: readonly ServerChannelRecord[] = []) {
    for (const channel of channels) this.#channels.set(channel.channelId, clone(channel));
  }

  async loadChannel(channelId: Hash32Hex): Promise<ServerChannelRecord | undefined> {
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

  async loadCommitment(commitmentId: Hash32Hex): Promise<BatchCommitmentRecord | undefined> {
    const record = this.#commitments.get(commitmentId);
    return record ? clone(record) : undefined;
  }

  async loadPaymentIdentifier(id: string): Promise<PaymentIdentifierRecord | undefined> {
    const record = this.#paymentIdentifiers.get(id);
    return record ? clone(record) : undefined;
  }

  async loadExactPayment(transactionId: Hash32Hex): Promise<ExactPaymentRecord | undefined> {
    const record = this.#exactPayments.get(exactPaymentKey(transactionId));
    return record ? clone(record) : undefined;
  }

  async commitSettlement(record: SettlementCommit): Promise<void> {
    const current = this.#channels.get(record.expected.channelId);
    if (!matchesExpectedChannel(current, record.expected)) {
      throw new Error("channel state changed before settlement commit");
    }
    const paymentIdentifier = record.paymentIdentifier ? clone(record.paymentIdentifier) : undefined;
    const commitment = clone(record.commitment);
    const channel = clone(record.channel);
    if (paymentIdentifier) this.#assertPaymentIdentifierAvailable(paymentIdentifier);
    this.#commitments.set(commitment.commitmentId, commitment);
    if (paymentIdentifier) this.#paymentIdentifiers.set(paymentIdentifier.id, paymentIdentifier);
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
        throw new Error("exact payment transaction was already committed for a different request");
      }
      return;
    }
    if (record.paymentIdentifier) {
      const existingIdentifier = this.#paymentIdentifiers.get(record.paymentIdentifier.id);
      if (
        existingIdentifier &&
        (existingIdentifier.fingerprint !== record.paymentIdentifier.fingerprint ||
          existingIdentifier.paymentPayloadHash !== record.paymentIdentifier.paymentPayloadHash ||
          existingIdentifier.paymentScopeId !== record.paymentIdentifier.paymentScopeId)
      ) {
        throw new Error("payment identifier was already committed for a different payment");
      }
      this.#paymentIdentifiers.set(record.paymentIdentifier.id, clone(record.paymentIdentifier));
    }
    this.#exactPayments.set(key, payment);
  }

  async saveExactReservation(record: ExactReservationRecord): Promise<void> {
    const existing = this.#exactReservations.get(record.reservationId);
    if (existing && existing.status !== "reserved") {
      throw new Error("exact reservation was already consumed");
    }
    if (existing && stableJson(exactReservationTerms(existing)) !== stableJson(exactReservationTerms(record))) {
      throw new Error("exact reservation id is already reserved for different terms");
    }
    this.#exactReservations.set(record.reservationId, clone(record));
  }

  async loadExactReservation(reservationId: Hash32Hex): Promise<ExactReservationRecord | undefined> {
    const record = this.#exactReservations.get(reservationId);
    return record ? clone(record) : undefined;
  }

  async consumeExactReservation(reservationId: Hash32Hex, transactionId: Hash32Hex): Promise<void> {
    const current = this.#exactReservations.get(reservationId);
    if (!current) {
      throw new Error("exact reservation was not found");
    }
    if (current.status === "consumed") {
      if (current.transactionId?.toLowerCase() === transactionId.toLowerCase()) return;
      throw new Error("exact reservation was already consumed by a different transaction");
    }
    this.#exactReservations.set(reservationId, { ...clone(current), status: "consumed", transactionId: transactionId.toLowerCase() });
  }

  #assertPaymentIdentifierAvailable(paymentIdentifier: PaymentIdentifierRecord): void {
    const existingIdentifier = this.#paymentIdentifiers.get(paymentIdentifier.id);
    if (
      existingIdentifier &&
      (existingIdentifier.fingerprint !== paymentIdentifier.fingerprint ||
        existingIdentifier.paymentPayloadHash !== paymentIdentifier.paymentPayloadHash ||
        existingIdentifier.paymentScopeId !== paymentIdentifier.paymentScopeId)
    ) {
      throw new Error("payment identifier was already committed for a different payment");
    }
  }

  async loadOpenClaimAttempt(channelId: Hash32Hex): Promise<ClaimAttemptRecord | undefined> {
    for (const record of this.#claimAttempts.values()) {
      if (record.channelId === channelId && record.status !== "applied") return clone(record);
    }
    return undefined;
  }

  async saveClaimAttempt(record: ClaimAttemptRecord): Promise<void> {
    for (const existing of this.#claimAttempts.values()) {
      if (existing.channelId === record.channelId && existing.status !== "applied" && existing.attemptId !== record.attemptId) {
        throw new Error("claim attempt is already pending");
      }
    }
    this.#claimAttempts.set(record.attemptId, clone(record));
  }

  async applyClaimAttempt(channel: ServerChannelRecord, attempt: ClaimAttemptRecord): Promise<void> {
    const currentAttempt = this.#claimAttempts.get(attempt.attemptId);
    if (!currentAttempt || currentAttempt.status === "applied") {
      throw new Error("claim attempt is not open");
    }
    const currentChannel = this.#channels.get(channel.channelId);
    if (
      !currentChannel ||
      currentChannel.activeOutpoint.txid.toLowerCase() !== attempt.activeOutpoint.txid.toLowerCase() ||
      currentChannel.activeOutpoint.index !== attempt.activeOutpoint.index ||
      currentChannel.activeScriptPublicKey.toLowerCase() !== attempt.activeScriptPublicKey.toLowerCase() ||
      currentChannel.fundingAmount !== attempt.fundingAmount ||
      currentChannel.chargedCumulativeAmount !== attempt.chargedCumulativeAmount ||
      currentChannel.claimedCumulativeAmount !== attempt.claimedCumulativeAmount ||
      currentChannel.signedMaxClaimable !== attempt.signedMaxClaimable ||
      currentChannel.voucherSignature !== attempt.voucherSignature ||
      currentChannel.status !== attempt.channelStatus
    ) {
      throw new Error("channel state changed before claim apply");
    }
    this.#channels.set(channel.channelId, clone(channel));
    this.#claimAttempts.set(attempt.attemptId, { ...clone(attempt), status: "applied" });
  }

  async abandonClaimAttempt(attemptId: Hash32Hex): Promise<void> {
    const currentAttempt = this.#claimAttempts.get(attemptId);
    if (!currentAttempt || currentAttempt.status === "applied") return;
    this.#claimAttempts.delete(attemptId);
  }
}

export class MemoryChannelLockManager implements ChannelLockManager {
  readonly #tails = new Map<Hash32Hex, Promise<void>>();

  async runExclusive<T>(channelId: Hash32Hex, fn: () => Promise<T>): Promise<T> {
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
  if (claimed > charged) throw new Error("claimed amount cannot exceed charged amount");
  return charged - claimed;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function exactPaymentKey(transactionId: Hash32Hex): string {
  return transactionId.toLowerCase();
}

function exactReservationTerms(record: ExactReservationRecord): Omit<ExactReservationRecord, "reservedAt" | "status" | "transactionId"> {
  const { reservedAt: _reservedAt, status: _status, transactionId: _transactionId, ...terms } = record;
  return terms;
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

function matchesExpectedChannel(current: ServerChannelRecord | undefined, expected: SettlementCommit["expected"]): boolean {
  if (!current) {
    return expected.chargedCumulativeAmount === "0" && expected.claimedCumulativeAmount === "0" && expected.signedMaxClaimable === "0";
  }
  return (
    current.channelId === expected.channelId &&
    current.chargedCumulativeAmount === expected.chargedCumulativeAmount &&
    current.claimedCumulativeAmount === expected.claimedCumulativeAmount &&
    current.signedMaxClaimable === expected.signedMaxClaimable &&
    current.status === expected.status &&
    current.activeOutpoint.txid.toLowerCase() === expected.activeOutpoint.txid.toLowerCase() &&
    current.activeOutpoint.index === expected.activeOutpoint.index &&
    current.activeScriptPublicKey.toLowerCase() === expected.activeScriptPublicKey.toLowerCase()
  );
}
