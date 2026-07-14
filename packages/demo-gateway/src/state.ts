import { parseSompiString, sha256Hex, type NetworkId } from "@kaspa-x402/core";
import { parseKip10AdditiveRedeemScript, payToScriptHashScript, serializedScriptPublicKey } from "@kaspa-x402/covenant";
import type {
  BatchCommitmentRecord,
  ChannelLockManager,
  ExactBorrowContinuation,
  ExactBorrowReservation,
  ExactBorrowReservationRequest,
  ClaimAttemptRecord,
  ExactPaymentRecord,
  ExactReservationRecord,
  ExactSettlementCommit,
  ExactHeadRecord,
  ExactHeadSelectionRequest,
  ExactSettlementAttemptRecord,
  ExactSettlementClaimResult,
  PaymentIdentifierRecord,
  ServerChannelRecord,
  ServerStateStore,
  SettlementCommit,
} from "@kaspa-x402/server";
import {
  acceptExactHead,
  claimExactHead,
  exactHeadMatchesSelection,
  exactSettlementAttemptsMatch,
  normalizeExactHeadRecord,
  normalizeExactSettlementAttempt,
  releaseExactHeadClaim,
} from "@kaspa-x402/server";

type GatewayTransaction = {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean | void>;
  list<T = unknown>(options: { prefix: string }): Promise<Map<string, T>>;
};

export type GatewayStorage = GatewayTransaction & {
  transaction<T>(closure: (txn: GatewayTransaction) => Promise<T>): Promise<T>;
};

type LockRecord = {
  token: string;
  expiresAt: number;
};

type RateRecord = {
  count: number;
  resetAt: number;
};

const MIN_EXACT_INVENTORY_SOMPI = 10_000_000n;

export type GatewayCanaryCheckStatus = "ok" | "failed" | "skipped";

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

export type GatewayExactInventoryStatus = "available" | "reserved" | "consumed" | "retired";

export type GatewayExactInventoryRegistration = Omit<ExactBorrowReservation, "reservationId" | "expiresAt"> & {
  network: NetworkId;
  inventoryId?: string;
  note?: string;
};

export type GatewayExactInventoryRecord = GatewayExactInventoryRegistration & {
  inventoryId: string;
  status: GatewayExactInventoryStatus;
  registeredAt: string;
  updatedAt: string;
  reservationId?: string;
  reservedAt?: string;
  expiresAt?: string;
  transactionId?: string;
  consumedAt?: string;
  retiredAt?: string;
};

export interface GatewayExactInventoryStats {
  total: number;
  available: number;
  reserved: number;
  consumed: number;
  retired: number;
  expiredRetired: number;
}

export type GatewayStateMethod =
  | "loadChannel"
  | "saveChannel"
  | "retireChannel"
  | "listChannels"
  | "loadCommitment"
  | "loadPaymentIdentifier"
  | "loadExactPayment"
  | "registerExactHead"
  | "loadExactHead"
  | "listExactHeads"
  | "selectExactHead"
  | "claimExactSettlement"
  | "loadExactSettlementAttempt"
  | "recordExactSettlementBroadcast"
  | "acceptExactSettlement"
  | "beginExactHandler"
  | "abandonExactSettlement"
  | "markExactHeadUnavailable"
  | "saveExactReservation"
  | "loadExactReservation"
  | "consumeExactReservation"
  | "registerExactInventory"
  | "registerExactInventoryBatch"
  | "reserveExactInventory"
  | "listExactInventory"
  | "exactInventoryStats"
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
  readonly #storage: GatewayStorage;

  constructor(storage: GatewayStorage) {
    this.#storage = storage;
  }

  async loadChannel(channelId: string): Promise<ServerChannelRecord | undefined> {
    return cloneOrUndefined(await this.#storage.get<ServerChannelRecord>(channelKey(channelId)));
  }

  async saveChannel(channel: ServerChannelRecord): Promise<void> {
    await this.#storage.put(channelKey(channel.channelId), clone(channel));
  }

  async retireChannel(channelId: string): Promise<void> {
    await this.#storage.transaction(async (txn) => {
      const channel = await txn.get<ServerChannelRecord>(channelKey(channelId));
      if (!channel) return;
      await txn.put(channelKey(channelId), { ...clone(channel), status: "retired" });
    });
  }

  async listChannels(): Promise<ServerChannelRecord[]> {
    return Array.from((await this.#storage.list<ServerChannelRecord>({ prefix: "channel:" })).values()).map(clone);
  }

  async loadCommitment(commitmentId: string): Promise<BatchCommitmentRecord | undefined> {
    return cloneOrUndefined(await this.#storage.get<BatchCommitmentRecord>(commitmentKey(commitmentId)));
  }

  async loadPaymentIdentifier(id: string): Promise<PaymentIdentifierRecord | undefined> {
    return cloneOrUndefined(await this.#storage.get<PaymentIdentifierRecord>(paymentIdentifierKey(id)));
  }

  async loadExactPayment(transactionId: string): Promise<ExactPaymentRecord | undefined> {
    return cloneOrUndefined(await this.#storage.get<ExactPaymentRecord>(exactPaymentKey(transactionId)));
  }

  async registerExactHead(input: ExactHeadRecord): Promise<ExactHeadRecord> {
    const record = normalizeExactHeadRecord(input);
    return this.#storage.transaction(async (txn) => {
      const existing = await txn.get<ExactHeadRecord>(exactHeadKey(record.headId));
      if (existing) {
        if (stableJson(existing) !== stableJson(record)) throw new Error("exact head id is already registered for different state");
        return clone(existing);
      }
      const heads = await txn.list<ExactHeadRecord>({ prefix: "exact-head:" });
      for (const current of heads.values()) {
        if (sameOutpoint(current.currentOutpoint, record.currentOutpoint)) throw new Error("exact head outpoint is already registered");
      }
      await txn.put(exactHeadKey(record.headId), clone(record));
      return clone(record);
    });
  }

  async loadExactHead(headId: string): Promise<ExactHeadRecord | undefined> {
    return cloneOrUndefined(await this.#storage.get<ExactHeadRecord>(exactHeadKey(headId)));
  }

  async listExactHeads(): Promise<ExactHeadRecord[]> {
    return Array.from((await this.#storage.list<ExactHeadRecord>({ prefix: "exact-head:" })).values())
      .map(clone)
      .sort((left, right) => left.headId.localeCompare(right.headId));
  }

  async selectExactHead(request: ExactHeadSelectionRequest): Promise<ExactHeadRecord | undefined> {
    const candidates = (await this.listExactHeads())
      .filter((head) => exactHeadMatchesSelection(head, request))
      .sort((left, right) => left.headId.localeCompare(right.headId));
    if (candidates.length === 0) return undefined;
    const index = Number(BigInt(`0x${request.selectionKey}`) % BigInt(candidates.length));
    return clone(candidates[index]!);
  }

  async claimExactSettlement(input: ExactSettlementAttemptRecord): Promise<ExactSettlementClaimResult> {
    const attempt = normalizeExactSettlementAttempt(input);
    return this.#storage.transaction(async (txn) => {
      const existing = await txn.get<ExactSettlementAttemptRecord>(exactAttemptKey(attempt.transactionId));
      if (existing) {
        if (!exactSettlementAttemptsMatch(existing, attempt)) throw new Error("exact transaction is already claimed for a different request");
        return { attempt: clone(existing), created: false };
      }
      if (attempt.profile === "additive") {
        if (!attempt.head) throw new Error("additive exact settlement requires a head claim");
        const head = await txn.get<ExactHeadRecord>(exactHeadKey(attempt.head.headId));
        if (!head) throw new Error("exact head changed before settlement claim");
        await txn.put(exactHeadKey(head.headId), claimExactHead(head, attempt));
      } else if (attempt.head) {
        throw new Error("standard-native exact settlement cannot claim a head");
      }
      await txn.put(exactAttemptKey(attempt.transactionId), clone(attempt));
      return { attempt: clone(attempt), created: true };
    });
  }

  async loadExactSettlementAttempt(transactionId: string): Promise<ExactSettlementAttemptRecord | undefined> {
    return cloneOrUndefined(await this.#storage.get<ExactSettlementAttemptRecord>(exactAttemptKey(transactionId)));
  }

  async recordExactSettlementBroadcast(
    transactionId: string,
    finality: "broadcast" | "accepted" | "confirmed",
    observedAt: string,
  ): Promise<void> {
    await this.#storage.transaction(async (txn) => {
      const attempt = await requireExactAttempt(txn, transactionId);
      if (attempt.status === "accepted" || attempt.status === "applied") return;
      await txn.put(exactAttemptKey(attempt.transactionId), { ...attempt, status: "broadcast", finality, updatedAt: observedAt });
    });
  }

  async acceptExactSettlement(transactionId: string, finality: "accepted" | "confirmed", observedAt: string): Promise<void> {
    await this.#storage.transaction(async (txn) => {
      const attempt = await requireExactAttempt(txn, transactionId);
      if (attempt.status === "applied") return;
      if (attempt.head) {
        const head = await txn.get<ExactHeadRecord>(exactHeadKey(attempt.head.headId));
        if (!head) throw new Error("exact head was not found during settlement acceptance");
        await txn.put(exactHeadKey(head.headId), acceptExactHead(head, attempt, observedAt));
      }
      await txn.put(exactAttemptKey(attempt.transactionId), { ...attempt, status: "accepted", finality, updatedAt: observedAt });
    });
  }

  async beginExactHandler(transactionId: string, startedAt: string): Promise<boolean> {
    return this.#storage.transaction(async (txn) => {
      const attempt = await requireExactAttempt(txn, transactionId);
      if (attempt.status !== "accepted" || attempt.handlerStartedAt) return false;
      await txn.put(exactAttemptKey(attempt.transactionId), { ...attempt, handlerStartedAt: startedAt, updatedAt: startedAt });
      return true;
    });
  }

  async abandonExactSettlement(transactionId: string, reason: string, observedAt: string): Promise<void> {
    await this.#storage.transaction(async (txn) => {
      const attempt = await requireExactAttempt(txn, transactionId);
      if (attempt.status === "accepted" || attempt.status === "applied") throw new Error("accepted exact settlement cannot be abandoned");
      if (attempt.head) {
        const head = await txn.get<ExactHeadRecord>(exactHeadKey(attempt.head.headId));
        if (head) await txn.put(exactHeadKey(head.headId), releaseExactHeadClaim(head, attempt, observedAt));
      }
      await txn.delete(exactAttemptKey(attempt.transactionId));
      void reason;
    });
  }

  async markExactHeadUnavailable(headId: string, reason: string, observedAt: string): Promise<void> {
    await this.#storage.transaction(async (txn) => {
      const head = await txn.get<ExactHeadRecord>(exactHeadKey(headId));
      if (!head) throw new Error("exact head was not found");
      if (head.status === "retired") throw new Error("retired exact head cannot be marked unavailable");
      await txn.put(exactHeadKey(head.headId), { ...head, status: "unavailable", unavailableReason: reason, updatedAt: observedAt });
    });
  }

  async commitSettlement(record: SettlementCommit): Promise<void> {
    await this.#storage.transaction(async (txn) => {
      const current = await txn.get<ServerChannelRecord>(channelKey(record.expected.channelId));
      if (!matchesExpectedChannel(current, record.expected)) {
        throw new Error("channel state changed before settlement commit");
      }
      if (record.paymentIdentifier) await assertPaymentIdentifierAvailable(txn, record.paymentIdentifier);
      await txn.put(commitmentKey(record.commitment.commitmentId), clone(record.commitment));
      if (record.paymentIdentifier) await txn.put(paymentIdentifierKey(record.paymentIdentifier.id), clone(record.paymentIdentifier));
      await txn.put(channelKey(record.channel.channelId), clone(record.channel));
    });
  }

  async commitExactPayment(record: ExactSettlementCommit): Promise<void> {
    await this.#storage.transaction(async (txn) => {
      const payment = clone(record.payment);
      const existing = await txn.get<ExactPaymentRecord>(exactPaymentKey(payment.transactionId));
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
      if (record.paymentIdentifier) await assertPaymentIdentifierAvailable(txn, record.paymentIdentifier);
      const attempt = await txn.get<ExactSettlementAttemptRecord>(exactAttemptKey(payment.transactionId));
      if (attempt) {
        if (attempt.status !== "accepted" || !attempt.handlerStartedAt) throw new Error("exact settlement attempt is not ready to apply");
        await txn.put(exactAttemptKey(payment.transactionId), {
          ...attempt,
          status: "applied",
          updatedAt: new Date().toISOString(),
        });
      }
      if (record.paymentIdentifier) await txn.put(paymentIdentifierKey(record.paymentIdentifier.id), clone(record.paymentIdentifier));
      await txn.put(exactPaymentKey(payment.transactionId), payment);
    });
  }

  async saveExactReservation(record: ExactReservationRecord): Promise<void> {
    await this.#storage.transaction(async (txn) => {
      const existing = await txn.get<ExactReservationRecord>(exactReservationKey(record.reservationId));
      if (existing && existing.status !== "reserved") {
        throw new Error("exact reservation was already consumed");
      }
      if (existing && stableJson(exactReservationTerms(existing)) !== stableJson(exactReservationTerms(record))) {
        throw new Error("exact reservation id is already reserved for different terms");
      }
      await txn.put(exactReservationKey(record.reservationId), clone(record));
    });
  }

  async loadExactReservation(reservationId: string): Promise<ExactReservationRecord | undefined> {
    return cloneOrUndefined(await this.#storage.get<ExactReservationRecord>(exactReservationKey(reservationId)));
  }

  async consumeExactReservation(
    reservationId: string,
    transactionId: string,
    continuation?: ExactBorrowContinuation,
  ): Promise<void> {
    await this.#storage.transaction(async (txn) => {
      const current = await txn.get<ExactReservationRecord>(exactReservationKey(reservationId));
      if (!current) throw new Error("exact reservation was not found");
      if (current.status === "consumed") {
        if (current.transactionId?.toLowerCase() === transactionId.toLowerCase()) {
          await markInventoryConsumed(txn, reservationId, transactionId, continuation);
          return;
        }
        throw new Error("exact reservation was already consumed by a different transaction");
      }
      await txn.put(exactReservationKey(reservationId), { ...clone(current), status: "consumed", transactionId: transactionId.toLowerCase() });
      await markInventoryConsumed(txn, reservationId, transactionId, continuation);
    });
  }

  async registerExactInventory(input: GatewayExactInventoryRegistration): Promise<GatewayExactInventoryRecord> {
    return (await this.registerExactInventoryBatch([input]))[0]!;
  }

  async registerExactInventoryBatch(inputs: GatewayExactInventoryRegistration[]): Promise<GatewayExactInventoryRecord[]> {
    const now = new Date().toISOString();
    const records = inputs.map((input) => normalizeExactInventoryRegistration(input, now));
    return this.#storage.transaction(async (txn) => {
      const seen = new Set<string>();
      const registered: GatewayExactInventoryRecord[] = [];
      const pendingWrites: GatewayExactInventoryRecord[] = [];
      for (const record of records) {
        if (seen.has(record.inventoryId)) throw new Error("duplicate exact inventory id in registration batch");
        seen.add(record.inventoryId);
        const key = exactInventoryKey(record.inventoryId);
        const existing = await txn.get<GatewayExactInventoryRecord>(key);
        if (!existing) {
          registered.push(clone(record));
          pendingWrites.push(record);
          continue;
        }
        if (stableJson(exactInventoryTerms(existing)) !== stableJson(exactInventoryTerms(record))) {
          throw new Error("exact inventory id is already registered for different terms");
        }
        if (existing.status === "consumed") throw new Error("exact inventory was already consumed");
        if (existing.status === "retired") throw new Error("exact inventory was retired; register a fresh borrow outpoint");
        registered.push(clone(existing));
      }
      for (const record of pendingWrites) await txn.put(exactInventoryKey(record.inventoryId), clone(record));
      return registered;
    });
  }

  async reserveExactInventory(request: ExactBorrowReservationRequest, nowIso = new Date().toISOString()): Promise<ExactBorrowReservation | undefined> {
    return this.#storage.transaction(async (txn) => {
      await retireExpiredExactInventory(txn, Date.parse(nowIso), nowIso);
      const entries = await txn.list<GatewayExactInventoryRecord>({ prefix: "exact-inventory:" });
      const available = Array.from(entries.values())
        .filter((record) => exactInventoryMatchesRequest(record, request))
        .sort(compareExactInventory)[0];
      if (!available) return undefined;

      const expiresAt = new Date(Date.parse(nowIso) + request.maxTimeoutSeconds * 1000).toISOString();
      const reservation: ExactBorrowReservation = {
        reservationId: exactInventoryReservationId(request, available, expiresAt),
        templateId: available.templateId,
        transactionEncoding: available.transactionEncoding,
        borrowOutpoint: clone(available.borrowOutpoint),
        borrowAmount: available.borrowAmount,
        borrowScriptPublicKey: available.borrowScriptPublicKey,
        borrowRedeemScript: available.borrowRedeemScript,
        additiveThresholdSompi: available.additiveThresholdSompi,
        paymentOutputIndex: available.paymentOutputIndex,
        expiresAt,
      };
      await txn.put(exactInventoryKey(available.inventoryId), {
        ...clone(available),
        status: "reserved",
        reservationId: reservation.reservationId,
        reservedAt: nowIso,
        expiresAt,
        transactionId: undefined,
        consumedAt: undefined,
        updatedAt: nowIso,
      });
      await txn.put(exactInventoryReservationKey(reservation.reservationId), available.inventoryId);
      return reservation;
    });
  }

  async listExactInventory(): Promise<GatewayExactInventoryRecord[]> {
    await this.exactInventoryStats();
    return Array.from((await this.#storage.list<GatewayExactInventoryRecord>({ prefix: "exact-inventory:" })).values())
      .map(clone)
      .sort(compareExactInventory);
  }

  async exactInventoryStats(nowIso = new Date().toISOString()): Promise<GatewayExactInventoryStats> {
    return this.#storage.transaction(async (txn) => {
      const expiredRetired = await retireExpiredExactInventory(txn, Date.parse(nowIso), nowIso);
      const entries = await txn.list<GatewayExactInventoryRecord>({ prefix: "exact-inventory:" });
      const stats: GatewayExactInventoryStats = { total: 0, available: 0, reserved: 0, consumed: 0, retired: 0, expiredRetired };
      for (const record of entries.values()) {
        stats.total += 1;
        stats[record.status] += 1;
      }
      return stats;
    });
  }

  async loadOpenClaimAttempt(channelId: string): Promise<ClaimAttemptRecord | undefined> {
    const attemptId = await this.#storage.get<string>(openClaimKey(channelId));
    return attemptId ? cloneOrUndefined(await this.#storage.get<ClaimAttemptRecord>(claimAttemptKey(attemptId))) : undefined;
  }

  async saveClaimAttempt(record: ClaimAttemptRecord): Promise<void> {
    await this.#storage.transaction(async (txn) => {
      const openAttemptId = await txn.get<string>(openClaimKey(record.channelId));
      if (openAttemptId && openAttemptId !== record.attemptId) {
        const open = await txn.get<ClaimAttemptRecord>(claimAttemptKey(openAttemptId));
        if (open && open.status !== "applied") throw new Error("claim attempt is already pending");
      }
      await txn.put(claimAttemptKey(record.attemptId), clone(record));
      if (record.status !== "applied") await txn.put(openClaimKey(record.channelId), record.attemptId);
    });
  }

  async applyClaimAttempt(channel: ServerChannelRecord, attempt: ClaimAttemptRecord): Promise<void> {
    await this.#storage.transaction(async (txn) => {
      const currentAttempt = await txn.get<ClaimAttemptRecord>(claimAttemptKey(attempt.attemptId));
      if (!currentAttempt || currentAttempt.status === "applied") {
        throw new Error("claim attempt is not open");
      }
      const currentChannel = await txn.get<ServerChannelRecord>(channelKey(channel.channelId));
      if (!matchesClaimSnapshot(currentChannel, attempt)) {
        throw new Error("channel state changed before claim apply");
      }
      await txn.put(channelKey(channel.channelId), clone(channel));
      await txn.put(claimAttemptKey(attempt.attemptId), { ...clone(attempt), status: "applied" });
      await txn.delete(openClaimKey(attempt.channelId));
    });
  }

  async abandonClaimAttempt(attemptId: string): Promise<void> {
    await this.#storage.transaction(async (txn) => {
      const current = await txn.get<ClaimAttemptRecord>(claimAttemptKey(attemptId));
      if (!current || current.status === "applied") return;
      await txn.delete(claimAttemptKey(attemptId));
      await txn.delete(openClaimKey(current.channelId));
    });
  }

  async acquireLock(key: string, token: string, nowMs: number, ttlMs: number): Promise<boolean> {
    return this.#storage.transaction(async (txn) => {
      const current = await txn.get<LockRecord>(lockKey(key));
      if (current && current.token !== token && current.expiresAt > nowMs) return false;
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

  async checkRateLimit(scope: string, nowMs: number, limit: number, windowMs: number): Promise<{ allowed: boolean; count: number; resetAt: number }> {
    if (limit <= 0) return { allowed: true, count: 0, resetAt: nowMs + windowMs };
    const resetAt = Math.floor(nowMs / windowMs) * windowMs + windowMs;
    const key = rateKey(scope, resetAt);
    return this.#storage.transaction(async (txn) => {
      const current = (await txn.get<RateRecord>(key)) ?? { count: 0, resetAt };
      const next = { count: current.count + 1, resetAt };
      await txn.put(key, next);
      return { allowed: next.count <= limit, count: next.count, resetAt };
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
    if (delta <= minimumLead) throw new Error("refund DAA delta must exceed minimum lead");
    const next = current + delta;
    return this.#storage.transaction(async (txn) => {
      const key = batchRefundTimeoutKey();
      const stored = await txn.get<string>(key);
      if (stored !== undefined) {
        const timeout = parseSompiString(stored);
        if (current + minimumLead < timeout && timeout <= next) return timeout.toString();
      }
      await txn.put(key, next.toString());
      return next.toString();
    });
  }

  async loadCanaryReport(): Promise<GatewayCanaryReport | undefined> {
    return cloneOrUndefined(await this.#storage.get<GatewayCanaryReport>(canaryReportKey()));
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
    for (const [key, value] of entries) metrics[key.slice("metric:".length)] = value;
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
      if (await this.#state.acquireLock(channelId, token, Date.now(), this.#ttlMs)) break;
      if (Date.now() - started > this.#ttlMs) throw new Error("gateway lock acquisition timed out");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    try {
      return await fn();
    } finally {
      await this.#state.releaseLock(channelId, token);
    }
  }
}

export type GatewayStateClient = ServerStateStore & {
  acquireLock(key: string, token: string, nowMs: number, ttlMs: number): Promise<boolean>;
  releaseLock(key: string, token: string): Promise<void>;
  checkRateLimit(scope: string, nowMs: number, limit: number, windowMs: number): Promise<{ allowed: boolean; count: number; resetAt: number }>;
  registerExactInventory(record: GatewayExactInventoryRegistration): Promise<GatewayExactInventoryRecord>;
  registerExactInventoryBatch(records: GatewayExactInventoryRegistration[]): Promise<GatewayExactInventoryRecord[]>;
  reserveExactInventory(request: ExactBorrowReservationRequest, nowIso?: string): Promise<ExactBorrowReservation | undefined>;
  listExactInventory(): Promise<GatewayExactInventoryRecord[]>;
  exactInventoryStats(nowIso?: string): Promise<GatewayExactInventoryStats>;
  resolveBatchRefundTimeoutDaa(currentDaa: string, refundDeltaDaa: string, minimumLeadDaa: string): Promise<string>;
  loadCanaryReport(): Promise<GatewayCanaryReport | undefined>;
  saveCanaryReport(report: GatewayCanaryReport): Promise<void>;
  incrementMetric(name: string, amount?: number): Promise<void>;
  metrics(): Promise<Record<string, number>>;
};

export async function dispatchGatewayState(ledger: GatewayLedger, request: GatewayStateRequest): Promise<unknown> {
  switch (request.method) {
    case "loadChannel":
      return ledger.loadChannel(readPayload<{ channelId: string }>(request).channelId);
    case "saveChannel":
      return ledger.saveChannel(readPayload<{ channel: ServerChannelRecord }>(request).channel);
    case "retireChannel":
      return ledger.retireChannel(readPayload<{ channelId: string }>(request).channelId);
    case "listChannels":
      return ledger.listChannels();
    case "loadCommitment":
      return ledger.loadCommitment(readPayload<{ commitmentId: string }>(request).commitmentId);
    case "loadPaymentIdentifier":
      return ledger.loadPaymentIdentifier(readPayload<{ id: string }>(request).id);
    case "loadExactPayment":
      return ledger.loadExactPayment(readPayload<{ transactionId: string }>(request).transactionId);
    case "registerExactHead":
      return ledger.registerExactHead(readPayload<{ record: ExactHeadRecord }>(request).record);
    case "loadExactHead":
      return ledger.loadExactHead(readPayload<{ headId: string }>(request).headId);
    case "listExactHeads":
      return ledger.listExactHeads();
    case "selectExactHead":
      return ledger.selectExactHead(readPayload<{ request: ExactHeadSelectionRequest }>(request).request);
    case "claimExactSettlement":
      return ledger.claimExactSettlement(readPayload<{ record: ExactSettlementAttemptRecord }>(request).record);
    case "loadExactSettlementAttempt":
      return ledger.loadExactSettlementAttempt(readPayload<{ transactionId: string }>(request).transactionId);
    case "recordExactSettlementBroadcast": {
      const payload = readPayload<{ transactionId: string; finality: "broadcast" | "accepted" | "confirmed"; observedAt: string }>(request);
      return ledger.recordExactSettlementBroadcast(payload.transactionId, payload.finality, payload.observedAt);
    }
    case "acceptExactSettlement": {
      const payload = readPayload<{ transactionId: string; finality: "accepted" | "confirmed"; observedAt: string }>(request);
      return ledger.acceptExactSettlement(payload.transactionId, payload.finality, payload.observedAt);
    }
    case "beginExactHandler": {
      const payload = readPayload<{ transactionId: string; startedAt: string }>(request);
      return ledger.beginExactHandler(payload.transactionId, payload.startedAt);
    }
    case "abandonExactSettlement": {
      const payload = readPayload<{ transactionId: string; reason: string; observedAt: string }>(request);
      return ledger.abandonExactSettlement(payload.transactionId, payload.reason, payload.observedAt);
    }
    case "markExactHeadUnavailable": {
      const payload = readPayload<{ headId: string; reason: string; observedAt: string }>(request);
      return ledger.markExactHeadUnavailable(payload.headId, payload.reason, payload.observedAt);
    }
    case "saveExactReservation":
      return ledger.saveExactReservation(readPayload<{ record: ExactReservationRecord }>(request).record);
    case "loadExactReservation":
      return ledger.loadExactReservation(readPayload<{ reservationId: string }>(request).reservationId);
    case "consumeExactReservation": {
      const payload = readPayload<{
        reservationId: string;
        transactionId: string;
        continuation?: ExactBorrowContinuation;
      }>(request);
      return ledger.consumeExactReservation(
        payload.reservationId,
        payload.transactionId,
        payload.continuation,
      );
    }
    case "registerExactInventory":
      return ledger.registerExactInventory(readPayload<{ record: GatewayExactInventoryRegistration }>(request).record);
    case "registerExactInventoryBatch":
      return ledger.registerExactInventoryBatch(readPayload<{ records: GatewayExactInventoryRegistration[] }>(request).records);
    case "reserveExactInventory": {
      const payload = readPayload<{ request: ExactBorrowReservationRequest; nowIso?: string }>(request);
      return ledger.reserveExactInventory(payload.request, payload.nowIso);
    }
    case "listExactInventory":
      return ledger.listExactInventory();
    case "exactInventoryStats":
      return ledger.exactInventoryStats(readPayload<{ nowIso?: string }>(request).nowIso);
    case "resolveBatchRefundTimeoutDaa": {
      const payload = readPayload<{ currentDaa: string; refundDeltaDaa: string; minimumLeadDaa: string }>(request);
      return ledger.resolveBatchRefundTimeoutDaa(payload.currentDaa, payload.refundDeltaDaa, payload.minimumLeadDaa);
    }
    case "commitSettlement":
      return ledger.commitSettlement(readPayload<{ record: SettlementCommit }>(request).record);
    case "commitExactPayment":
      return ledger.commitExactPayment(readPayload<{ record: ExactSettlementCommit }>(request).record);
    case "loadOpenClaimAttempt":
      return ledger.loadOpenClaimAttempt(readPayload<{ channelId: string }>(request).channelId);
    case "saveClaimAttempt":
      return ledger.saveClaimAttempt(readPayload<{ record: ClaimAttemptRecord }>(request).record);
    case "applyClaimAttempt": {
      const payload = readPayload<{ channel: ServerChannelRecord; attempt: ClaimAttemptRecord }>(request);
      return ledger.applyClaimAttempt(payload.channel, payload.attempt);
    }
    case "abandonClaimAttempt":
      return ledger.abandonClaimAttempt(readPayload<{ attemptId: string }>(request).attemptId);
    case "acquireLock": {
      const payload = readPayload<{ key: string; token: string; nowMs: number; ttlMs: number }>(request);
      return ledger.acquireLock(payload.key, payload.token, payload.nowMs, payload.ttlMs);
    }
    case "releaseLock": {
      const payload = readPayload<{ key: string; token: string }>(request);
      return ledger.releaseLock(payload.key, payload.token);
    }
    case "checkRateLimit": {
      const payload = readPayload<{ scope: string; nowMs: number; limit: number; windowMs: number }>(request);
      return ledger.checkRateLimit(payload.scope, payload.nowMs, payload.limit, payload.windowMs);
    }
    case "loadCanaryReport":
      return ledger.loadCanaryReport();
    case "saveCanaryReport":
      return ledger.saveCanaryReport(readPayload<{ report: GatewayCanaryReport }>(request).report);
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

async function assertPaymentIdentifierAvailable(txn: GatewayTransaction, paymentIdentifier: PaymentIdentifierRecord): Promise<void> {
  const existing = await txn.get<PaymentIdentifierRecord>(paymentIdentifierKey(paymentIdentifier.id));
  if (
    existing &&
    (existing.fingerprint !== paymentIdentifier.fingerprint ||
      existing.paymentPayloadHash !== paymentIdentifier.paymentPayloadHash ||
      existing.paymentScopeId !== paymentIdentifier.paymentScopeId)
  ) {
    throw new Error("payment identifier was already committed for a different payment");
  }
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

function matchesClaimSnapshot(current: ServerChannelRecord | undefined, attempt: ClaimAttemptRecord): boolean {
  return Boolean(
    current &&
      current.activeOutpoint.txid.toLowerCase() === attempt.activeOutpoint.txid.toLowerCase() &&
      current.activeOutpoint.index === attempt.activeOutpoint.index &&
      current.activeScriptPublicKey.toLowerCase() === attempt.activeScriptPublicKey.toLowerCase() &&
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

function commitmentKey(commitmentId: string): string {
  return `commitment:${commitmentId.toLowerCase()}`;
}

function exactPaymentKey(transactionId: string): string {
  return `exact:${transactionId.toLowerCase()}`;
}

function exactHeadKey(headId: string): string {
  return `exact-head:${headId.toLowerCase()}`;
}

function exactAttemptKey(transactionId: string): string {
  return `exact-attempt:${transactionId.toLowerCase()}`;
}

function exactReservationKey(reservationId: string): string {
  return `exact-reservation:${reservationId.toLowerCase()}`;
}

function exactInventoryKey(inventoryId: string): string {
  return `exact-inventory:${inventoryId.toLowerCase()}`;
}

function exactInventoryReservationKey(reservationId: string): string {
  return `exact-inventory-reservation:${reservationId.toLowerCase()}`;
}

function paymentIdentifierKey(id: string): string {
  return `payment-identifier:${id}`;
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

function rateKey(scope: string, resetAt: number): string {
  return `rate:${scope}:${resetAt}`;
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

async function requireExactAttempt(txn: GatewayTransaction, transactionId: string): Promise<ExactSettlementAttemptRecord> {
  const attempt = await txn.get<ExactSettlementAttemptRecord>(exactAttemptKey(transactionId));
  if (!attempt) throw new Error("exact settlement attempt was not found");
  return attempt;
}

function sameOutpoint(left: { txid: string; index: number }, right: { txid: string; index: number }): boolean {
  return left.txid.toLowerCase() === right.txid.toLowerCase() && left.index === right.index;
}

function exactReservationTerms(record: ExactReservationRecord): Omit<ExactReservationRecord, "reservedAt" | "status" | "transactionId"> {
  const { reservedAt: _reservedAt, status: _status, transactionId: _transactionId, ...terms } = record;
  return terms;
}

function exactInventoryTerms(
  record: GatewayExactInventoryRecord,
): Omit<
  GatewayExactInventoryRecord,
  "status" | "registeredAt" | "updatedAt" | "reservedAt" | "expiresAt" | "reservationId" | "transactionId" | "consumedAt" | "retiredAt"
> {
  const {
    status: _status,
    registeredAt: _registeredAt,
    updatedAt: _updatedAt,
    reservedAt: _reservedAt,
    expiresAt: _expiresAt,
    reservationId: _reservationId,
    transactionId: _transactionId,
    consumedAt: _consumedAt,
    retiredAt: _retiredAt,
    ...terms
  } = record;
  return terms;
}

function normalizeExactInventoryRegistration(input: GatewayExactInventoryRegistration, nowIso: string): GatewayExactInventoryRecord {
  const inventoryId = (input.inventoryId ?? `${input.borrowOutpoint.txid}:${input.borrowOutpoint.index}`).toLowerCase();
  if (!/^[0-9a-f]{64}:\d+$/.test(inventoryId)) throw new Error("exact inventory id must be <txid>:<index>");
  if (input.network !== "kaspa:testnet-10") throw new Error("exact inventory only supports kaspa:testnet-10");
  if (input.templateId !== "kaspa-x402-kip10-additive-v1") throw new Error("exact inventory templateId must be KIP-10 additive");
  if (input.transactionEncoding !== "kaspa-sdk-safe-json-v2.0.0") throw new Error("exact inventory transaction encoding is not supported");
  if (!/^[0-9a-f]{64}$/i.test(input.borrowOutpoint.txid)) throw new Error("exact inventory borrow txid must be 32-byte hex");
  if (!Number.isInteger(input.borrowOutpoint.index) || input.borrowOutpoint.index < 0 || input.borrowOutpoint.index > 0xffffffff) {
    throw new Error("exact inventory borrow index is outside uint32 range");
  }
  if (!/^0000(?:[0-9a-f]{2})+$/i.test(input.borrowScriptPublicKey)) {
    throw new Error("exact inventory borrow script public key must be serialized script public key hex");
  }
  if (!/^(?:[0-9a-f]{2})+$/i.test(input.borrowRedeemScript)) throw new Error("exact inventory borrow redeem script must be byte hex");
  const borrowAmount = parseSompiString(input.borrowAmount);
  const additiveThreshold = parseSompiString(input.additiveThresholdSompi);
  if (borrowAmount < MIN_EXACT_INVENTORY_SOMPI) throw new Error("exact inventory borrow amount is below the standard output safety floor");
  if (additiveThreshold < MIN_EXACT_INVENTORY_SOMPI) throw new Error("exact inventory additive threshold is below the server minimum");
  const template = parseKip10AdditiveRedeemScript(input.borrowRedeemScript);
  if (template.amount !== input.additiveThresholdSompi) {
    throw new Error("exact inventory KIP-10 script threshold must match additiveThresholdSompi");
  }
  const expectedBorrowScript = serializedScriptPublicKey(payToScriptHashScript(input.borrowRedeemScript)).toLowerCase();
  if (expectedBorrowScript !== input.borrowScriptPublicKey.toLowerCase()) {
    throw new Error("exact inventory KIP-10 redeem script must match borrowScriptPublicKey");
  }
  if (!Number.isInteger(input.paymentOutputIndex) || input.paymentOutputIndex < 0 || input.paymentOutputIndex > 0xffffffff) {
    throw new Error("exact inventory payment output index is outside uint32 range");
  }
  const record: GatewayExactInventoryRecord = {
    inventoryId,
    network: input.network,
    templateId: input.templateId,
    transactionEncoding: input.transactionEncoding,
    borrowOutpoint: { txid: input.borrowOutpoint.txid.toLowerCase(), index: input.borrowOutpoint.index },
    borrowAmount: input.borrowAmount,
    borrowScriptPublicKey: input.borrowScriptPublicKey.toLowerCase(),
    borrowRedeemScript: input.borrowRedeemScript.toLowerCase(),
    additiveThresholdSompi: input.additiveThresholdSompi,
    paymentOutputIndex: input.paymentOutputIndex,
    ...(input.note ? { note: input.note } : {}),
    status: "available",
    registeredAt: nowIso,
    updatedAt: nowIso,
  };
  if (record.inventoryId !== `${record.borrowOutpoint.txid}:${record.borrowOutpoint.index}`) {
    throw new Error("exact inventory id must match borrow outpoint");
  }
  return record;
}

function exactInventoryMatchesRequest(record: GatewayExactInventoryRecord, request: ExactBorrowReservationRequest): boolean {
  return (
    record.status === "available" &&
    record.network === request.network &&
    record.templateId === "kaspa-x402-kip10-additive-v1" &&
    record.transactionEncoding === "kaspa-sdk-safe-json-v2.0.0" &&
    parseSompiString(record.additiveThresholdSompi) >= parseSompiString(request.minimumAdditiveThresholdSompi)
  );
}

function exactInventoryReservationId(request: ExactBorrowReservationRequest, inventory: GatewayExactInventoryRecord, expiresAt: string): string {
  return sha256Hex(
    stableJson({
      domain: "kaspa:x402:gateway-exact-reservation:v1",
      network: request.network,
      amount: request.amount,
      payTo: request.payTo,
      payToScriptPublicKey: request.payToScriptPublicKey.toLowerCase(),
      resource: request.resource.url,
      maxTimeoutSeconds: request.maxTimeoutSeconds,
      minimumAdditiveThresholdSompi: request.minimumAdditiveThresholdSompi,
      inventoryId: inventory.inventoryId,
      borrowOutpoint: inventory.borrowOutpoint,
      borrowAmount: inventory.borrowAmount,
      borrowScriptPublicKey: inventory.borrowScriptPublicKey,
      borrowRedeemScript: inventory.borrowRedeemScript,
      additiveThresholdSompi: inventory.additiveThresholdSompi,
      paymentOutputIndex: inventory.paymentOutputIndex,
      expiresAt,
    }),
  );
}

async function retireExpiredExactInventory(txn: GatewayTransaction, nowMs: number, nowIso: string): Promise<number> {
  const entries = await txn.list<GatewayExactInventoryRecord>({ prefix: "exact-inventory:" });
  let retired = 0;
  for (const record of entries.values()) {
    if (record.status !== "reserved" || !record.expiresAt || Date.parse(record.expiresAt) > nowMs) continue;
    await txn.put(exactInventoryKey(record.inventoryId), {
      ...clone(record),
      status: "retired",
      retiredAt: nowIso,
      updatedAt: nowIso,
    });
    retired += 1;
  }
  return retired;
}

async function markInventoryConsumed(
  txn: GatewayTransaction,
  reservationId: string,
  transactionId: string,
  continuation?: ExactBorrowContinuation,
): Promise<void> {
  const inventoryId = await txn.get<string>(exactInventoryReservationKey(reservationId));
  if (!inventoryId) return;
  const current = await txn.get<GatewayExactInventoryRecord>(exactInventoryKey(inventoryId));
  if (!current) return;
  if (current.status === "consumed") {
    if (current.transactionId?.toLowerCase() !== transactionId.toLowerCase()) {
      throw new Error("exact inventory was already consumed by a different transaction");
    }
  } else {
    if (current.reservationId?.toLowerCase() !== reservationId.toLowerCase()) return;
    const nowIso = new Date().toISOString();
    await txn.put(exactInventoryKey(current.inventoryId), {
      ...clone(current),
      status: "consumed",
      transactionId: transactionId.toLowerCase(),
      consumedAt: nowIso,
      updatedAt: nowIso,
    });
  }
  if (!continuation) return;
  const txid = transactionId.toLowerCase();
  if (continuation.outpoint.txid.toLowerCase() !== txid) {
    throw new Error("exact continuation outpoint must belong to the consumed transaction");
  }
  if (continuation.scriptPublicKey.toLowerCase() !== current.borrowScriptPublicKey) {
    throw new Error("exact continuation script must match the consumed KIP-10 inventory");
  }
  if (
    parseSompiString(continuation.amount) <
    parseSompiString(current.borrowAmount) + parseSompiString(current.additiveThresholdSompi)
  ) {
    throw new Error("exact continuation amount is below the KIP-10 additive threshold");
  }
  const nowIso = new Date().toISOString();
  const recycled = normalizeExactInventoryRegistration(
    {
      network: current.network,
      templateId: current.templateId,
      transactionEncoding: current.transactionEncoding,
      borrowOutpoint: {
        txid,
        index: continuation.outpoint.index,
      },
      borrowAmount: continuation.amount,
      borrowScriptPublicKey: continuation.scriptPublicKey,
      borrowRedeemScript: current.borrowRedeemScript,
      additiveThresholdSompi: current.additiveThresholdSompi,
      paymentOutputIndex: current.paymentOutputIndex,
      note: `recycled from ${current.inventoryId}`,
    },
    nowIso,
  );
  const key = exactInventoryKey(recycled.inventoryId);
  const existing = await txn.get<GatewayExactInventoryRecord>(key);
  if (existing) {
    if (stableJson(exactInventoryTerms(existing)) !== stableJson(exactInventoryTerms(recycled))) {
      throw new Error("exact continuation inventory already exists with different terms");
    }
    return;
  }
  await txn.put(key, recycled);
}

function compareExactInventory(left: GatewayExactInventoryRecord, right: GatewayExactInventoryRecord): number {
  return left.registeredAt.localeCompare(right.registeredAt) || left.inventoryId.localeCompare(right.inventoryId);
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
