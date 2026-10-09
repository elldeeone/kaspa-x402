import type { PnnEvidenceRecord } from "@kaspa-x402/adapters";
import type { ChainCheckpoint } from "@kaspa-x402/core";
import type {
  BatchCommitmentRecord,
  BatchSettlementAttemptRecord,
  BatchSettlementClaimResult,
  ChannelOperationLeaseClaimResult,
  ChannelOperationLeaseRecord,
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
  PaymentIdentifierReservationRecord,
  ProtectedHandlerResult,
  ServerChannelRecord,
  SettlementCommit,
} from "@kaspa-x402/server";
import type {
  GatewayCanaryReport,
  ExactHeadStats,
  GatewayPublicAdmissionResult,
  GatewayStateClient,
  GatewayStateMethod,
  GatewayStateRequest,
} from "./state.js";
import { GATEWAY_COORDINATION_DOMAIN } from "./state.js";

export type GatewayStateNamespace = Env["GATEWAY_STATE"];
export const GATEWAY_STATE_OBJECT_NAME = "demo-gateway-state-v2";

export class RemoteGatewayState implements GatewayStateClient {
  readonly coordinationScope = "deployment-wide" as const;
  readonly coordinationDomain = GATEWAY_COORDINATION_DOMAIN;
  readonly #stub: ReturnType<GatewayStateNamespace["get"]>;

  constructor(namespace: GatewayStateNamespace) {
    this.#stub = namespace.get(namespace.idFromName(GATEWAY_STATE_OBJECT_NAME));
  }

  loadChannel(channelId: string): Promise<ServerChannelRecord | undefined> {
    return this.#call("loadChannel", { channelId });
  }

  registerChannel(channel: ServerChannelRecord): Promise<void> {
    return this.#call("registerChannel", { channel });
  }

  retireChannel(
    channelId: string,
    leaseId: string,
    expected: ServerChannelRecord,
    reason?: string,
  ): Promise<void> {
    return this.#call("retireChannel", {
      channelId,
      leaseId,
      expected,
      reason,
    });
  }

  listChannels(): Promise<ServerChannelRecord[]> {
    return this.#call("listChannels");
  }

  applyCovenantLineage(
    expected: ServerChannelRecord,
    channel: ServerChannelRecord,
    leaseId: string,
  ): Promise<void> {
    return this.#call("applyCovenantLineage", { expected, channel, leaseId });
  }

  claimChannelOperation(
    record: ChannelOperationLeaseRecord,
  ): Promise<ChannelOperationLeaseClaimResult> {
    return this.#call("claimChannelOperation", { record });
  }

  loadChannelOperation(
    channelId: string,
  ): Promise<ChannelOperationLeaseRecord | undefined> {
    return this.#call("loadChannelOperation", { channelId });
  }

  abandonChannelOperation(
    leaseId: string,
    reason: string,
    observedAt: string,
  ): Promise<void> {
    return this.#call("abandonChannelOperation", {
      leaseId,
      reason,
      observedAt,
    });
  }

  loadCommitment(
    commitmentId: string,
  ): Promise<BatchCommitmentRecord | undefined> {
    return this.#call("loadCommitment", { commitmentId });
  }

  claimBatchSettlement(
    record: BatchSettlementAttemptRecord,
  ): Promise<BatchSettlementClaimResult> {
    return this.#call("claimBatchSettlement", { record });
  }

  loadBatchSettlementAttempt(
    attemptId: string,
  ): Promise<BatchSettlementAttemptRecord | undefined> {
    return this.#call("loadBatchSettlementAttempt", { attemptId });
  }

  beginBatchHandler(attemptId: string, startedAt: string): Promise<boolean> {
    return this.#call("beginBatchHandler", { attemptId, startedAt });
  }

  recordBatchHandlerResult(
    attemptId: string,
    result: ProtectedHandlerResult,
    completedAt: string,
  ): Promise<void> {
    return this.#call("recordBatchHandlerResult", {
      attemptId,
      result,
      completedAt,
    });
  }

  markBatchHandlerRecoveryRequired(
    attemptId: string,
    reason: string,
    observedAt: string,
  ): Promise<void> {
    return this.#call("markBatchHandlerRecoveryRequired", {
      attemptId,
      reason,
      observedAt,
    });
  }

  abandonBatchSettlement(
    attemptId: string,
    reason: string,
    observedAt: string,
  ): Promise<void> {
    return this.#call("abandonBatchSettlement", {
      attemptId,
      reason,
      observedAt,
    });
  }

  loadPaymentIdentifier(
    id: string,
  ): Promise<PaymentIdentifierRecord | undefined> {
    return this.#call("loadPaymentIdentifier", { id });
  }

  loadPaymentIdentifierReservation(
    id: string,
  ): Promise<PaymentIdentifierReservationRecord | undefined> {
    return this.#call("loadPaymentIdentifierReservation", { id });
  }

  loadExactPayment(
    transactionId: string,
  ): Promise<ExactPaymentRecord | undefined> {
    return this.#call("loadExactPayment", { transactionId });
  }

  registerExactHead(record: ExactHeadRecord): Promise<ExactHeadRecord> {
    return this.#call("registerExactHead", { record });
  }

  loadExactHead(headId: string): Promise<ExactHeadRecord | undefined> {
    return this.#call("loadExactHead", { headId });
  }

  recordExactHeadOfferObservation(head: ExactHeadRecord): Promise<void> {
    return this.#call("recordExactHeadOfferObservation", { head });
  }

  hasRecentExactHeadOfferObservation(headId: string, nowMs: number): Promise<boolean> {
    return this.#call("hasRecentExactHeadOfferObservation", { headId, nowMs });
  }

  listExactHeads(): Promise<ExactHeadRecord[]> {
    return this.#call("listExactHeads");
  }

  exactHeadStats(): Promise<ExactHeadStats> {
    return this.#call("exactHeadStats");
  }

  selectExactHead(
    request: ExactHeadSelectionRequest,
  ): Promise<ExactHeadRecord | undefined> {
    return this.#call("selectExactHead", { request });
  }

  claimExactSettlement(
    record: ExactSettlementAttemptRecord,
  ): Promise<ExactSettlementClaimResult> {
    return this.#call("claimExactSettlement", { record });
  }

  claimExactSettlementWithEvidence(
    record: ExactSettlementAttemptRecord,
    receipt: PnnEvidenceRecord,
    signal?: AbortSignal,
  ): Promise<ExactSettlementClaimResult> {
    return this.#call("claimExactSettlementWithEvidence", { record, receipt }, signal);
  }

  loadExactSettlementAttempt(
    transactionId: string,
  ): Promise<ExactSettlementAttemptRecord | undefined> {
    return this.#call("loadExactSettlementAttempt", { transactionId });
  }

  recordExactSettlementBroadcast(
    transactionId: string,
    finality: "broadcast" | "accepted" | "confirmed",
    observedAt: string,
  ): Promise<void> {
    return this.#call("recordExactSettlementBroadcast", {
      transactionId,
      finality,
      observedAt,
    });
  }

  acceptExactSettlement(
    transactionId: string,
    finality: "accepted" | "confirmed",
    observedAt: string,
  ): Promise<void> {
    return this.#call("acceptExactSettlement", {
      transactionId,
      finality,
      observedAt,
    });
  }

  beginExactHandler(
    transactionId: string,
    startedAt: string,
  ): Promise<boolean> {
    return this.#call("beginExactHandler", { transactionId, startedAt });
  }

  recordExactHandlerResult(
    transactionId: string,
    result: ProtectedHandlerResult,
    completedAt: string,
  ): Promise<void> {
    return this.#call("recordExactHandlerResult", {
      transactionId,
      result,
      completedAt,
    });
  }

  markExactHandlerRecoveryRequired(
    transactionId: string,
    reason: string,
    observedAt: string,
  ): Promise<void> {
    return this.#call("markExactHandlerRecoveryRequired", {
      transactionId,
      reason,
      observedAt,
    });
  }

  abandonExactSettlement(
    transactionId: string,
    reason: string,
    observedAt: string,
  ): Promise<void> {
    return this.#call("abandonExactSettlement", {
      transactionId,
      reason,
      observedAt,
    });
  }

  markExactHeadUnavailable(
    input: ExactHeadUnavailableApply,
  ): Promise<ExactHeadUnavailableResult> {
    return this.#call("markExactHeadUnavailable", { input });
  }

  applyExactHeadLineage(
    input: ExactHeadLineageApply,
  ): Promise<ExactHeadRecord> {
    return this.#call("applyExactHeadLineage", { input });
  }

  commitSettlement(record: SettlementCommit): Promise<void> {
    return this.#call("commitSettlement", { record });
  }

  commitExactPayment(record: ExactSettlementCommit): Promise<void> {
    return this.#call("commitExactPayment", { record });
  }

  resolveBatchRefundTimeoutDaa(
    currentDaa: string,
    refundDeltaDaa: string,
    minimumLeadDaa: string,
  ): Promise<string> {
    return this.#call("resolveBatchRefundTimeoutDaa", {
      currentDaa,
      refundDeltaDaa,
      minimumLeadDaa,
    });
  }

  loadRecentPnnDaaScore(nowMs: number, maxAgeMs?: number): Promise<string | undefined> {
    return this.#call("loadRecentPnnDaaScore", { nowMs, maxAgeMs });
  }

  loadOpenClaimAttempt(
    channelId: string,
  ): Promise<ClaimAttemptRecord | undefined> {
    return this.#call("loadOpenClaimAttempt", { channelId });
  }

  saveClaimAttempt(record: ClaimAttemptRecord): Promise<void> {
    return this.#call("saveClaimAttempt", { record });
  }

  applyClaimAttempt(
    channel: ServerChannelRecord,
    attempt: ClaimAttemptRecord,
  ): Promise<void> {
    return this.#call("applyClaimAttempt", { channel, attempt });
  }

  abandonClaimAttempt(attemptId: string, reason?: string): Promise<void> {
    return this.#call("abandonClaimAttempt", { attemptId, reason });
  }

  acquireLock(
    key: string,
    token: string,
    nowMs: number,
    ttlMs: number,
  ): Promise<boolean> {
    return this.#call("acquireLock", { key, token, nowMs, ttlMs });
  }

  releaseLock(key: string, token: string): Promise<void> {
    return this.#call("releaseLock", { key, token });
  }

  acquirePublicAdmission(
    token: string,
    callerKey: string,
    nowMs: number,
    globalLimit: number,
    callerLimit: number,
    ttlMs: number,
  ): Promise<GatewayPublicAdmissionResult> {
    return this.#stub.acquirePublicAdmission(token, callerKey, nowMs, globalLimit, callerLimit, ttlMs);
  }

  renewPublicAdmission(
    token: string,
    callerKey: string,
    nowMs: number,
    ttlMs: number,
  ): Promise<boolean> {
    return this.#stub.renewPublicAdmission(token, callerKey, nowMs, ttlMs);
  }

  releasePublicAdmission(token: string): Promise<void> {
    return this.#stub.releasePublicAdmission(token);
  }

  checkRateLimit(
    scope: string,
    nowMs: number,
    limit: number,
    windowMs: number,
  ): Promise<{ allowed: boolean; count: number; resetAt: number }> {
    return this.#call("checkRateLimit", { scope, nowMs, limit, windowMs });
  }

  loadPnnEvidence(transactionId: string): Promise<PnnEvidenceRecord | undefined> {
    return this.#call("loadPnnEvidence", { transactionId });
  }

  savePnnEvidence(record: PnnEvidenceRecord, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    return this.#call("savePnnEvidence", { record }, signal);
  }

  recordPnnCheckpoint(checkpoint: ChainCheckpoint): Promise<void> {
    return this.#call("recordPnnCheckpoint", { checkpoint });
  }

  findPnnCheckpointBefore(daaScore: string): Promise<ChainCheckpoint | undefined> {
    return this.#call("findPnnCheckpointBefore", { daaScore });
  }

  loadCanaryReport(): Promise<GatewayCanaryReport | undefined> {
    return this.#call("loadCanaryReport");
  }

  saveCanaryReport(report: GatewayCanaryReport): Promise<void> {
    return this.#call("saveCanaryReport", { report });
  }

  incrementMetric(name: string, amount?: number): Promise<void> {
    return this.#call("incrementMetric", { name, amount });
  }

  metrics(): Promise<Record<string, number>> {
    return this.#call("metrics");
  }

  async #call<T>(method: GatewayStateMethod, payload?: unknown, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const body: GatewayStateRequest = { method, payload };
    const response = await this.#stub.fetch("https://gateway-state/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    signal?.throwIfAborted();
    const result = await response.json<GatewayStateResponse<T>>();
    if (!response.ok) throw new Error(`gateway state method failed: ${method}`);
    if (!result.ok) throw new Error(result.error);
    return result.value as T;
  }
}

type GatewayStateResponse<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      error: string;
    };
