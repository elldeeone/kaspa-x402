import type {
  BatchCommitmentRecord,
  ClaimAttemptRecord,
  ExactPaymentRecord,
  ExactSettlementCommit,
  PaymentIdentifierRecord,
  ServerChannelRecord,
  SettlementCommit,
} from "@kaspa-x402/server";
import type { GatewayStateClient, GatewayStateMethod, GatewayStateRequest } from "./state.js";

export type GatewayStateNamespace = DurableObjectNamespace;

export class RemoteGatewayState implements GatewayStateClient {
  readonly #stub: DurableObjectStub;

  constructor(namespace: GatewayStateNamespace, name = "demo-gateway") {
    this.#stub = namespace.get(namespace.idFromName(name));
  }

  loadChannel(channelId: string): Promise<ServerChannelRecord | undefined> {
    return this.#call("loadChannel", { channelId });
  }

  saveChannel(channel: ServerChannelRecord): Promise<void> {
    return this.#call("saveChannel", { channel });
  }

  retireChannel(channelId: string, reason?: string): Promise<void> {
    return this.#call("retireChannel", { channelId, reason });
  }

  listChannels(): Promise<ServerChannelRecord[]> {
    return this.#call("listChannels");
  }

  loadCommitment(commitmentId: string): Promise<BatchCommitmentRecord | undefined> {
    return this.#call("loadCommitment", { commitmentId });
  }

  loadPaymentIdentifier(id: string): Promise<PaymentIdentifierRecord | undefined> {
    return this.#call("loadPaymentIdentifier", { id });
  }

  loadExactPayment(transactionId: string): Promise<ExactPaymentRecord | undefined> {
    return this.#call("loadExactPayment", { transactionId });
  }

  commitSettlement(record: SettlementCommit): Promise<void> {
    return this.#call("commitSettlement", { record });
  }

  commitExactPayment(record: ExactSettlementCommit): Promise<void> {
    return this.#call("commitExactPayment", { record });
  }

  loadOpenClaimAttempt(channelId: string): Promise<ClaimAttemptRecord | undefined> {
    return this.#call("loadOpenClaimAttempt", { channelId });
  }

  saveClaimAttempt(record: ClaimAttemptRecord): Promise<void> {
    return this.#call("saveClaimAttempt", { record });
  }

  applyClaimAttempt(channel: ServerChannelRecord, attempt: ClaimAttemptRecord): Promise<void> {
    return this.#call("applyClaimAttempt", { channel, attempt });
  }

  abandonClaimAttempt(attemptId: string, reason?: string): Promise<void> {
    return this.#call("abandonClaimAttempt", { attemptId, reason });
  }

  acquireLock(key: string, token: string, nowMs: number, ttlMs: number): Promise<boolean> {
    return this.#call("acquireLock", { key, token, nowMs, ttlMs });
  }

  releaseLock(key: string, token: string): Promise<void> {
    return this.#call("releaseLock", { key, token });
  }

  checkRateLimit(scope: string, nowMs: number, limit: number, windowMs: number): Promise<{ allowed: boolean; count: number; resetAt: number }> {
    return this.#call("checkRateLimit", { scope, nowMs, limit, windowMs });
  }

  incrementMetric(name: string, amount?: number): Promise<void> {
    return this.#call("incrementMetric", { name, amount });
  }

  metrics(): Promise<Record<string, number>> {
    return this.#call("metrics");
  }

  async #call<T>(method: GatewayStateMethod, payload?: unknown): Promise<T> {
    const body: GatewayStateRequest = { method, payload };
    const response = await this.#stub.fetch("https://gateway-state/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
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
