import { parseSompiString, type Hash32Hex } from "@kaspa-x402/core";
import type {
  BatchCommitmentRecord,
  ChannelLockManager,
  ClaimAttemptRecord,
  ExactPaymentRecord,
  ExactSettlementCommit,
  PaymentIdentifierRecord,
  ServerChannelRecord,
  ServerStateStore,
  SettlementCommit,
  UptoAuthorizationRecord,
  UptoBroadcastAuthorizationRecord,
  UptoPendingAuthorizationRecord,
  UptoSettlementCommit,
} from "./types.js";

export class MemoryServerChannelStore implements ServerStateStore {
  readonly #channels = new Map<Hash32Hex, ServerChannelRecord>();
  readonly #commitments = new Map<Hash32Hex, BatchCommitmentRecord>();
  readonly #exactPayments = new Map<string, ExactPaymentRecord>();
  readonly #uptoAuthorizations = new Map<Hash32Hex, UptoAuthorizationRecord>();
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

  async loadUptoAuthorization(scopeId: Hash32Hex): Promise<UptoAuthorizationRecord | undefined> {
    const record = this.#uptoAuthorizations.get(scopeId);
    return record ? clone(record) : undefined;
  }

  async reserveUptoAuthorization(record: UptoPendingAuthorizationRecord, paymentIdentifier?: PaymentIdentifierRecord): Promise<void> {
    const authorization = clone(record);
    const existingByOutpoint = this.#uptoAuthorizations.get(authorization.authorizationScopeId);
    const existingByNonce = this.#uptoAuthorizations.get(authorization.nonceScopeId);
    if (paymentIdentifier) this.#assertPaymentIdentifierAvailable(paymentIdentifier);
    for (const existing of [existingByOutpoint, existingByNonce]) {
      if (!existing) continue;
      if (!sameUptoAuthorization(existing, authorization)) {
        throw new Error("upto authorization was already consumed");
      }
      if (paymentIdentifier) this.#paymentIdentifiers.set(paymentIdentifier.id, clone(paymentIdentifier));
      return;
    }
    if (paymentIdentifier) this.#paymentIdentifiers.set(paymentIdentifier.id, clone(paymentIdentifier));
    this.#uptoAuthorizations.set(authorization.authorizationScopeId, authorization);
    this.#uptoAuthorizations.set(authorization.nonceScopeId, authorization);
  }

  async markUptoAuthorizationBroadcast(record: UptoBroadcastAuthorizationRecord, paymentIdentifier?: PaymentIdentifierRecord): Promise<void> {
    const authorization = clone(record);
    const existingByOutpoint = this.#uptoAuthorizations.get(authorization.authorizationScopeId);
    const existingByNonce = this.#uptoAuthorizations.get(authorization.nonceScopeId);
    if (paymentIdentifier) this.#assertPaymentIdentifierAvailable(paymentIdentifier);
    for (const existing of [existingByOutpoint, existingByNonce]) {
      if (!existing) continue;
      if (!sameUptoAuthorization(existing, authorization)) {
        throw new Error("upto authorization was already consumed");
      }
      if (paymentIdentifier) this.#paymentIdentifiers.set(paymentIdentifier.id, clone(paymentIdentifier));
      if (existing.status === "settled") return;
    }
    if (paymentIdentifier) this.#paymentIdentifiers.set(paymentIdentifier.id, clone(paymentIdentifier));
    this.#uptoAuthorizations.set(authorization.authorizationScopeId, authorization);
    this.#uptoAuthorizations.set(authorization.nonceScopeId, authorization);
  }

  async commitUptoSettlement(record: UptoSettlementCommit): Promise<void> {
    const authorization = clone(record.authorization);
    const existingByOutpoint = this.#uptoAuthorizations.get(authorization.authorizationScopeId);
    const existingByNonce = this.#uptoAuthorizations.get(authorization.nonceScopeId);
    for (const existing of [existingByOutpoint, existingByNonce]) {
      if (!existing) continue;
      if (!sameUptoAuthorization(existing, authorization)) {
        throw new Error("upto authorization was already consumed");
      }
      if (existing.status === "settled") return;
      break;
    }
    if (record.paymentIdentifier) {
      this.#assertPaymentIdentifierAvailable(record.paymentIdentifier);
      this.#paymentIdentifiers.set(record.paymentIdentifier.id, clone(record.paymentIdentifier));
    }
    this.#uptoAuthorizations.set(authorization.authorizationScopeId, authorization);
    this.#uptoAuthorizations.set(authorization.nonceScopeId, authorization);
  }

  async abandonUptoAuthorization(scopeId: Hash32Hex): Promise<void> {
    const existing = this.#uptoAuthorizations.get(scopeId);
    if (!existing || existing.status !== "pending") return;
    this.#uptoAuthorizations.delete(existing.authorizationScopeId);
    this.#uptoAuthorizations.delete(existing.nonceScopeId);
    if (existing.paymentIdentifier) this.#paymentIdentifiers.delete(existing.paymentIdentifier);
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

function sameUptoAuthorization(a: UptoAuthorizationRecord, b: UptoAuthorizationRecord): boolean {
  return (
    a.authorizationScopeId === b.authorizationScopeId &&
    a.nonceScopeId === b.nonceScopeId &&
    a.requestFingerprint === b.requestFingerprint &&
    a.paymentPayloadHash === b.paymentPayloadHash
  );
}
