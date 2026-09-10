import {
  canonicalTrustedSecurityContext,
  stableStringify,
  type TrustedSecurityContext,
} from "@kaspa-x402/core";

export interface PublicBoundaryPolicy {
  /** Maximum admitted requests per authenticated caller in one window. */
  callerQuota: number;
  callerQuotaWindowMs: number;
  maxTrackedCallers: number;
  maxGlobalConcurrency: number;
  maxCallerConcurrency: number;
  maxChannelConcurrency: number;
  maxAdapterConcurrency: number;
  adapterTimeoutMs: number;
}

export const DEFAULT_PUBLIC_BOUNDARY_POLICY: Readonly<PublicBoundaryPolicy> =
  Object.freeze({
    callerQuota: 1_000,
    callerQuotaWindowMs: 60_000,
    maxTrackedCallers: 10_000,
    maxGlobalConcurrency: 64,
    maxCallerConcurrency: 16,
    maxChannelConcurrency: 8,
    maxAdapterConcurrency: 16,
    adapterTimeoutMs: 10_000,
  });

export type PublicBoundaryRejection =
  | "caller_quota_exceeded"
  | "global_concurrency_exceeded"
  | "caller_concurrency_exceeded"
  | "channel_concurrency_exceeded"
  | "adapter_concurrency_exceeded"
  | "adapter_timeout";

export class PublicBoundaryError extends Error {
  readonly reason: PublicBoundaryRejection;
  readonly status: 429 | 503 | 504;

  constructor(reason: PublicBoundaryRejection, message: string) {
    super(message);
    this.name = "PublicBoundaryError";
    this.reason = reason;
    this.status = reason === "adapter_timeout" ? 504 : reason.includes("adapter") ? 503 : 429;
  }
}

export interface PublicBoundaryPermit {
  release(): void;
}

export interface PublicBoundaryController {
  enterRequest(context?: TrustedSecurityContext): PublicBoundaryPermit;
  enterChannel(channelKey: string): PublicBoundaryPermit;
  runAdapter<T>(adapter: string, operation: () => Promise<T> | T): Promise<T>;
}

type QuotaWindow = { count: number; resetAt: number };

export class MemoryPublicBoundaryController
  implements PublicBoundaryController
{
  readonly #policy: PublicBoundaryPolicy;
  readonly #now: () => number;
  readonly #quota = new Map<string, QuotaWindow>();
  readonly #callerConcurrency = new Map<string, number>();
  readonly #channelConcurrency = new Map<string, number>();
  readonly #adapterConcurrency = new Map<string, number>();
  #globalConcurrency = 0;
  #quotaAdmissions = 0;

  constructor(
    policy: Partial<PublicBoundaryPolicy> = {},
    now: () => number = Date.now,
  ) {
    this.#policy = { ...DEFAULT_PUBLIC_BOUNDARY_POLICY, ...policy };
    this.#now = now;
    assertPublicBoundaryPolicy(this.#policy);
  }

  enterRequest(context?: TrustedSecurityContext): PublicBoundaryPermit {
    const caller = context ? authenticatedCallerKey(context) : "anonymous";
    this.#admitCallerQuota(caller);
    if (this.#globalConcurrency >= this.#policy.maxGlobalConcurrency) {
      throw new PublicBoundaryError(
        "global_concurrency_exceeded",
        "public request concurrency limit exceeded",
      );
    }
    const callerCount = this.#callerConcurrency.get(caller) ?? 0;
    if (callerCount >= this.#policy.maxCallerConcurrency) {
      throw new PublicBoundaryError(
        "caller_concurrency_exceeded",
        "authenticated caller concurrency limit exceeded",
      );
    }
    this.#globalConcurrency += 1;
    this.#callerConcurrency.set(caller, callerCount + 1);
    return permit(() => {
      this.#globalConcurrency -= 1;
      decrement(this.#callerConcurrency, caller);
    });
  }

  enterChannel(channelKey: string): PublicBoundaryPermit {
    const count = this.#channelConcurrency.get(channelKey) ?? 0;
    if (count >= this.#policy.maxChannelConcurrency) {
      throw new PublicBoundaryError(
        "channel_concurrency_exceeded",
        "payment channel concurrency limit exceeded",
      );
    }
    this.#channelConcurrency.set(channelKey, count + 1);
    return permit(() => decrement(this.#channelConcurrency, channelKey));
  }

  async runAdapter<T>(
    adapter: string,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const count = this.#adapterConcurrency.get(adapter) ?? 0;
    if (count >= this.#policy.maxAdapterConcurrency) {
      throw new PublicBoundaryError(
        "adapter_concurrency_exceeded",
        `${adapter} concurrency limit exceeded`,
      );
    }
    this.#adapterConcurrency.set(adapter, count + 1);

    const pending = Promise.resolve().then(operation);
    void pending.then(
      () => decrement(this.#adapterConcurrency, adapter),
      () => decrement(this.#adapterConcurrency, adapter),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new PublicBoundaryError(
              "adapter_timeout",
              `${adapter} exceeded the configured timeout`,
            ),
          ),
        this.#policy.adapterTimeoutMs,
      );
    });
    try {
      return await Promise.race([pending, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #admitCallerQuota(caller: string): void {
    const now = this.#now();
    this.#quotaAdmissions += 1;
    if (this.#quotaAdmissions % 256 === 0) this.#pruneExpiredQuotas(now);
    let existing = this.#quota.get(caller);
    if (!existing && this.#quota.size >= this.#policy.maxTrackedCallers) {
      this.#pruneExpiredQuotas(now);
      existing = this.#quota.get(caller);
      if (!existing && this.#quota.size >= this.#policy.maxTrackedCallers) {
        throw new PublicBoundaryError(
          "caller_quota_exceeded",
          "authenticated caller tracking capacity exceeded",
        );
      }
    }
    const window =
      !existing || existing.resetAt <= now
        ? { count: 0, resetAt: now + this.#policy.callerQuotaWindowMs }
        : existing;
    if (window.count >= this.#policy.callerQuota) {
      throw new PublicBoundaryError(
        "caller_quota_exceeded",
        "authenticated caller request quota exceeded",
      );
    }
    window.count += 1;
    this.#quota.set(caller, window);
  }

  #pruneExpiredQuotas(now: number): void {
    for (const [caller, window] of this.#quota) {
      if (window.resetAt <= now) this.#quota.delete(caller);
    }
  }
}

function authenticatedCallerKey(context: TrustedSecurityContext): string {
  const canonical = canonicalTrustedSecurityContext(context);
  return stableStringify({
    scope: "kaspa:x402:authenticated-caller:v1",
    principal: canonical.principal,
    tenant: canonical.tenant,
  });
}

export function assertPublicBoundaryPolicy(
  policy: PublicBoundaryPolicy,
): void {
  for (const [value, label] of [
    [policy.callerQuota, "caller quota"],
    [policy.callerQuotaWindowMs, "caller quota window"],
    [policy.maxTrackedCallers, "tracked caller capacity"],
    [policy.maxGlobalConcurrency, "global concurrency"],
    [policy.maxCallerConcurrency, "caller concurrency"],
    [policy.maxChannelConcurrency, "channel concurrency"],
    [policy.maxAdapterConcurrency, "adapter concurrency"],
    [policy.adapterTimeoutMs, "adapter timeout"],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${label} must be a positive safe integer`);
    }
  }
  if (policy.maxCallerConcurrency > policy.maxGlobalConcurrency) {
    throw new Error("caller concurrency must not exceed global concurrency");
  }
}

function permit(release: () => void): PublicBoundaryPermit {
  let active = true;
  return {
    release() {
      if (!active) return;
      active = false;
      release();
    },
  };
}

function decrement(counts: Map<string, number>, key: string): void {
  const count = counts.get(key);
  if (count === undefined || count <= 1) counts.delete(key);
  else counts.set(key, count - 1);
}
