import { KaspaPnnClient } from "@kaspa-x402/adapters";
import { PnnChainEvidence } from "@kaspa-x402/adapters";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodePaymentRequiredHeader } from "@kaspa-x402/core";
import {
  buildKip10AdditiveRedeemScript,
  payToScriptHashScript,
  serializedScriptPublicKey,
} from "@kaspa-x402/covenant";
import {
  handleGatewayRequest,
  readRequestJsonWithLimit,
  runGatewayCanary,
} from "../src/gateway.js";
import { addressForScriptPublicKey } from "@kaspa-x402/adapters/native";
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  type ExactHeadRecord,
} from "@kaspa-x402/server";
import {
  dispatchGatewayState,
  GatewayLedger,
  type GatewayStateRequest,
  type GatewayStorage,
} from "../src/state.js";
import type { GatewayEnv } from "../src/config.js";

const FUNDING_TX = "88".repeat(32);

function workerRequest(input: RequestInfo | URL, init?: RequestInit): Request {
  const request = new globalThis.Request(input, init);
  Object.defineProperty(request, "cf", { value: { colo: "SYD" } });
  return request;
}
const SCRIPT = "0000" + "99".repeat(34);
const KIP10_REDEEM_SCRIPT = buildKip10AdditiveRedeemScript({
  ownerPublicKey: "aa".repeat(32),
  amount: "10000000",
});
const KIP10_SCRIPT_PUBLIC_KEY = serializedScriptPublicKey(
  payToScriptHashScript(KIP10_REDEEM_SCRIPT),
);
const KIP10_ADDRESS = addressForScriptPublicKey(
  KIP10_SCRIPT_PUBLIC_KEY,
  "kaspa:testnet-10",
);

const BASE_ENV: Omit<GatewayEnv, "GATEWAY_STATE"> = {
  KASPA_X402_GATEWAY_ENABLED: "true",
  KASPA_X402_NETWORK: "kaspa:testnet-10",
  KASPA_X402_CHAIN_BROADCAST_MODE: "pnn",
  KASPA_X402_PNN_ENDPOINTS: "wss://pnn.example.test",
  KASPA_X402_PAY_TO:
    "kaspatest:qzlws9lm7uyt0tftzffshnyeu2zcqk4kf7hw5ghk6v0zh093vnkljcy2fl0fh",
  KASPA_X402_SERVER_PUBLIC_KEY:
    "bee817fbf708b7ad2b12530bcc99e285805ab64faeea22f6d31e2bbcb164edf9",
  KASPA_X402_SITE_BASE_URL: "https://kaspa-x402.org",
  KASPA_X402_RELEASE_VERSION: "1.0.0-rc.2",
  KASPA_X402_GATEWAY_BASE_URL: "https://demo.kaspa-x402.org",
  KASPA_X402_ADMISSION_HMAC_KEY: "test-admission-key-with-at-least-32-bytes",
};

describe("gateway canary", () => {
  beforeEach(() => {
    vi.spyOn(KaspaPnnClient.prototype, "health").mockResolvedValue({ ok: true, networkId: "testnet-10", endpoint: "pnn.example.test", virtualDaaScore: "507000000" });
    vi.spyOn(PnnChainEvidence.prototype, "getVirtualDaaScore").mockResolvedValue("507000000");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("runs non-spending checks and stores the latest report", async () => {
    const storage = new FakeStorage();
    const env: GatewayEnv = {
      ...BASE_ENV,
      GATEWAY_STATE: fakeNamespace(storage),
    };
    stubCanaryFetches();

    const report = await runGatewayCanary(env, "manual");

    expect(report.ok).toBe(true);
    expect(
      report.checks.map((check) => `${check.name}:${check.status}`),
    ).toEqual([
      "kaspa-chain:ok",
      "schema-url:ok",
      "current-release:ok",
      "docs-index:ok",
      "exact-offer:skipped",
      "batch-offer:ok",
      "unsupported-scheme-rejection:ok",
      "paid-exact-canary:skipped",
      "replay-rejection-canary:skipped",
    ]);
    await expect(
      new GatewayLedger(storage).loadCanaryReport(),
    ).resolves.toEqual(report);
  });

  it("refreshes offer evidence for the ninth available additive head", async () => {
    const storage = new FakeStorage();
    const ledger = new GatewayLedger(storage);
    const heads = Array.from({ length: 9 }, (_, index) => ({
      ...exactHead(),
      headId: (0x90 + index).toString(16).repeat(32),
      currentOutpoint: {
        txid: (0x80 + index).toString(16).repeat(32), index: 0,
      },
    }));
    for (const head of heads) await ledger.registerExactHead(head);
    await ledger.recordPnnCheckpoint({
      blockHash: "ab".repeat(32), blueScore: "507000000", daaScore: "507000000",
    });
    vi.spyOn(PnnChainEvidence.prototype, "getUtxosForAddress")
      .mockResolvedValue(heads.map((head) => ({
        outpoint: head.currentOutpoint,
        amount: head.currentAmount,
        scriptPublicKey: head.scriptPublicKey,
      })));
    const env: GatewayEnv = {
      ...BASE_ENV,
      GATEWAY_STATE: fakeNamespace(storage),
      KASPA_X402_EXACT_PROFILE: "additive",
      KASPA_X402_PAY_TO: KIP10_ADDRESS,
      KASPA_X402_HOSTED_EXACT_SETTLEMENT_ENABLED: "true",
    };
    stubCanaryFetches();

    await runGatewayCanary(env, "scheduled");

    await expect(ledger.hasRecentExactHeadOfferObservation(
      heads[8]!.headId, Date.now(),
    )).resolves.toBe(true);
  });

  it("advertises the deterministic batch claim reserve", async () => {
    const storage = new FakeStorage();
    const env: GatewayEnv = {
      ...BASE_ENV,
      GATEWAY_STATE: fakeNamespace(storage),
    };
    stubCanaryFetches();

    const response = await handleGatewayRequest(
      workerRequest("https://demo.kaspa-x402.org/batch"),
      env,
      fakeContext(),
    );

    expect(response.status).toBe(402);
    const paymentRequired = decodePaymentRequiredHeader(
      response.headers.get(PAYMENT_REQUIRED_HEADER)!,
    );
    expect(paymentRequired.accepts).toMatchObject([
      {
        scheme: "batch-settlement",
        amount: "500",
        extra: {
          minDepositSompi: "20000000",
          claimReserveSompi: "10000000",
        },
      },
    ]);
  });

  it("skips protected-route canaries when the gateway is disabled", async () => {
    const storage = new FakeStorage();
    const env: GatewayEnv = {
      ...BASE_ENV,
      GATEWAY_STATE: fakeNamespace(storage),
      KASPA_X402_GATEWAY_ENABLED: "false",
    };
    stubCanaryFetches();

    const report = await runGatewayCanary(env, "manual");

    expect(report.ok).toBe(true);
    expect(
      report.checks.map((check) => `${check.name}:${check.status}`),
    ).toEqual([
      "kaspa-chain:ok",
      "schema-url:ok",
      "current-release:ok",
      "docs-index:ok",
      "exact-offer:skipped",
      "batch-offer:skipped",
      "unsupported-scheme-rejection:skipped",
      "paid-exact-canary:skipped",
      "replay-rejection-canary:skipped",
    ]);
  });

  it("keeps status routes readable while protected routes are disabled", async () => {
    const storage = new FakeStorage();
    const env: GatewayEnv = {
      ...BASE_ENV,
      GATEWAY_STATE: fakeNamespace(storage),
      KASPA_X402_GATEWAY_ENABLED: "false",
    };
    stubCanaryFetches();

    const health = await requestJson(env, "/health");
    const supported = await requestJson(env, "/supported");
    const exact = await requestJson(env, "/exact");
    const batch = await requestJson(env, "/batch");

    expect(health).toMatchObject({
      status: 200,
      body: { ok: true, enabled: false },
    });
    expect(supported).toMatchObject({
      status: 200,
      body: { ok: true, enabled: false },
    });
    expect(exact).toMatchObject({
      status: 503,
      body: { ok: false, error: "gateway_disabled" },
    });
    expect(batch).toMatchObject({
      status: 503,
      body: { ok: false, error: "gateway_disabled" },
    });
  });

  it("keeps health shallow and omits configured upstream URLs", async () => {
    const storage = new FakeStorage();
    const fetchMock = vi.fn(async () => {
      throw new Error("health must not call upstream services");
    });
    vi.stubGlobal("fetch", fetchMock);
    const env: GatewayEnv = {
      ...BASE_ENV,
      GATEWAY_STATE: fakeNamespace(storage),
      KASPA_X402_CHAIN_BROADCAST_MODE: "pnn",
      KASPA_X402_PNN_ENDPOINTS:
        "wss://pnn.example.test/private/path?token=secret",
    };

    const health = await requestJson(env, "/health");

    expect(health.status).toBe(200);
    expect(JSON.stringify(health.body)).not.toContain("pnn.example.test");
    expect(JSON.stringify(health.body)).not.toContain("token=secret");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps supported and disabled responses independent of Kaspa REST", async () => {
    const storage = new FakeStorage();
    const fetchMock = vi.fn(async () => {
      throw new Error("chain API unavailable");
    });
    vi.stubGlobal("fetch", fetchMock);

    const enabled: GatewayEnv = {
      ...BASE_ENV,
      GATEWAY_STATE: fakeNamespace(storage),
    };
    const disabled: GatewayEnv = {
      ...enabled,
      KASPA_X402_GATEWAY_ENABLED: "false",
    };

    const supported = await requestJson(enabled, "/supported");
    const exact = await requestJson(disabled, "/exact");
    const batch = await requestJson(disabled, "/batch");

    expect(supported).toMatchObject({
      status: 200,
      body: { ok: true, enabled: true },
    });
    expect(exact).toMatchObject({
      status: 503,
      body: { ok: false, error: "gateway_disabled" },
    });
    expect(batch).toMatchObject({
      status: 503,
      body: { ok: false, error: "gateway_disabled" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects invalid and rate-limited requests before Kaspa REST", async () => {
    const storage = new FakeStorage();
    const env: GatewayEnv = {
      ...BASE_ENV,
      GATEWAY_STATE: fakeNamespace(storage),
      KASPA_X402_RATE_LIMIT_PER_MINUTE: "1",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url === "https://api-tn10.kaspa.org/info/blockdag") {
        return Response.json({
          networkName: "kaspa-testnet-10",
          virtualDaaScore: "507000000",
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const missing = await requestJson(env, "/missing");
    const method = await handleGatewayRequest(
      workerRequest("https://demo.kaspa-x402.org/batch", { method: "POST" }),
      env,
      fakeContext(),
    );
    const firstResponse = await handleGatewayRequest(
      workerRequest("https://demo.kaspa-x402.org/batch", {
        headers: { "cf-connecting-ip": "203.0.113.10" },
      }),
      env,
      fakeContext(),
    );
    const fetchesAfterAllowedRequest = fetchMock.mock.calls.length;
    const chainReadsAfterAllowedRequest = vi.mocked(PnnChainEvidence.prototype.getVirtualDaaScore).mock.calls.length;
    const limitedResponse = await handleGatewayRequest(
      workerRequest("https://demo.kaspa-x402.org/batch", {
        headers: { "cf-connecting-ip": "203.0.113.10" },
      }),
      env,
      fakeContext(),
    );
    const limited = {
      status: limitedResponse.status,
      body: await limitedResponse.json(),
    };

    expect(missing).toMatchObject({
      status: 404,
      body: { ok: false, error: "not_found" },
    });
    expect(method.status).toBe(405);
    await expect(method.json()).resolves.toMatchObject({
      ok: false,
      error: "method_not_allowed",
    });
    expect(firstResponse.status).toBe(402);
    expect(chainReadsAfterAllowedRequest).toBe(0);
    expect(PnnChainEvidence.prototype.getVirtualDaaScore).toHaveBeenCalledTimes(chainReadsAfterAllowedRequest);
    expect(fetchesAfterAllowedRequest).toBe(0);
    expect(limited).toMatchObject({
      status: 429,
      body: { ok: false, error: "rate_limited" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(fetchesAfterAllowedRequest);
  });

  it("caps protected requests across Worker isolates through shared state", async () => {
    const storage = new FakeStorage();
    const env: GatewayEnv = {
      ...BASE_ENV,
      GATEWAY_STATE: fakeNamespace(storage),
      KASPA_X402_GLOBAL_CONCURRENCY: "1",
    };
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let blockdagCalls = 0;
    vi.spyOn(PnnChainEvidence.prototype, "getVirtualDaaScore").mockImplementation(async () => {
      blockdagCalls += 1;
      if (blockdagCalls === 1) { markFirstStarted(); await firstMayFinish; }
      return "507000000";
    });
    const foreignPayment = btoa(JSON.stringify({
      x402Version: 2,
      accepted: { scheme: "evm", network: "eip155:1" },
      payload: {},
    }));

    const first = handleGatewayRequest(
      workerRequest("https://demo.kaspa-x402.org/batch", {
        headers: { "cf-connecting-ip": "203.0.113.10", [PAYMENT_SIGNATURE_HEADER]: foreignPayment },
      }),
      env,
      fakeContext(),
    );
    await firstStarted;
    const rejected = await handleGatewayRequest(
      workerRequest("https://demo.kaspa-x402.org/batch", {
        headers: { "cf-connecting-ip": "203.0.113.11", [PAYMENT_SIGNATURE_HEADER]: foreignPayment },
      }),
      env,
      fakeContext(),
    );

    expect(rejected.status).toBe(503);
    await expect(rejected.json()).resolves.toMatchObject({
      ok: false,
      error: "global_concurrency_exceeded",
    });
    expect(blockdagCalls).toBe(1);

    releaseFirst();
    await expect(first).resolves.toMatchObject({ status: 402 });
    const callsAfterFirst = blockdagCalls;
    await expect(
      handleGatewayRequest(
        workerRequest("https://demo.kaspa-x402.org/batch", {
          headers: { [PAYMENT_SIGNATURE_HEADER]: foreignPayment },
        }),
        env,
        fakeContext(),
      ),
    ).resolves.toMatchObject({ status: 402 });
    expect(blockdagCalls).toBeGreaterThan(callsAfterFirst);
  });

  it.each([
    { scenario: "a thrown renewal with a global cap", failure: "throw", global: "1", caller: "1", secondIp: "203.0.113.11" },
    { scenario: "a denied renewal with a per-caller cap", failure: "deny", global: "2", caller: "1", secondIp: "203.0.113.10" },
    { scenario: "a stalled renewal at the confirmed expiry", failure: "stall", global: "1", caller: "1", secondIp: "203.0.113.11" },
  ] as const)("stops protected work after $scenario", async ({ failure, global, caller, secondIp }) => {
    // Failure modes: a logged renewal error leaves the first request active
    // after expiry, or a later caller enters while that work is still active.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T00:00:00.000Z"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const acquiredAt = Date.now();
    const storage = new FakeStorage();
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    let finishFirst: () => void = () => undefined;
    let active = 0;
    let overlap = false;
    let firstStoppedAt: number | undefined;
    const env: GatewayEnv = {
      ...BASE_ENV,
      KASPA_X402_GLOBAL_CONCURRENCY: global,
      KASPA_X402_PER_CALLER_CONCURRENCY: caller,
      KASPA_X402_HASH_CHAIN_ENABLED: "true",
      KASPA_X402_ADMIN_TOKEN: "test-hash-chain-admin-token",
      GATEWAY_STATE: fakeNamespace(storage, {
        renewalError: failure === "throw" ? new Error("coordinator renewal failed") : undefined,
        renewalRejected: failure === "deny",
        renewalHangs: failure === "stall",
        hashChainRequest(request) {
          if (!request.url.includes("slot=first")) {
            overlap = active > 0;
            return Promise.resolve(Response.json({ ok: true }));
          }
          active += 1;
          markFirstStarted();
          return new Promise<Response>((resolve) => {
            let finished = false;
            const finish = (response: Response) => {
              if (finished) return;
              finished = true;
              active -= 1;
              resolve(response);
            };
            finishFirst = () => finish(Response.json({ ok: true }));
            request.signal.addEventListener("abort", () => {
              firstStoppedAt = Date.now();
              finish(Response.json({ error: "aborted" }, { status: 503 }));
            }, { once: true });
          });
        },
      }),
    };
    const call = (slot: string, ip: string) => handleGatewayRequest(
      workerRequest(`https://demo.kaspa-x402.org/hash-chain/report?slot=${slot}`, {
        headers: { "cf-connecting-ip": ip },
      }), env, fakeContext());
    const first = call("first", "203.0.113.10");
    try {
      await firstStarted;
      await vi.advanceTimersByTimeAsync(300_001);
      const second = await call("second", secondIp);
      expect(second.status).toBe(200);
      expect(overlap).toBe(false);
      expect(firstStoppedAt).toBeLessThanOrEqual(acquiredAt + 300_000);
      await expect(first).resolves.toMatchObject({ status: 503 });
    } finally {
      finishFirst();
      await first;
      vi.useRealTimers();
    }
  });

  it("keeps a long protected request admitted while renewals succeed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T00:00:00.000Z"));
    const storage = new FakeStorage();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let finishFirst: () => void = () => undefined;
    const env: GatewayEnv = {
      ...BASE_ENV,
      KASPA_X402_GLOBAL_CONCURRENCY: "1",
      KASPA_X402_HASH_CHAIN_ENABLED: "true",
      KASPA_X402_ADMIN_TOKEN: "test-hash-chain-admin-token",
      GATEWAY_STATE: fakeNamespace(storage, {
        hashChainRequest(request) {
          if (!request.url.includes("slot=first"))
            return Promise.resolve(Response.json({ ok: true }));
          markStarted();
          return new Promise<Response>((resolve) => {
            finishFirst = () => resolve(Response.json({ ok: true }));
          });
        },
      }),
    };
    const call = (slot: string, ip: string) => handleGatewayRequest(
      workerRequest(`https://demo.kaspa-x402.org/hash-chain/report?slot=${slot}`, {
        headers: { "cf-connecting-ip": ip },
      }), env, fakeContext());
    const first = call("first", "203.0.113.10");
    try {
      await started;
      await vi.advanceTimersByTimeAsync(300_001);
      const second = await call("second", "203.0.113.11");
      expect(second.status).toBe(503);
      await expect(second.json()).resolves.toMatchObject({
        error: "global_concurrency_exceeded",
      });
      finishFirst();
      await expect(first).resolves.toMatchObject({ status: 200 });
    } finally {
      finishFirst();
      await first;
      vi.useRealTimers();
    }
  });

  it("rejects work that finishes after the confirmed lease expiry when the deadline callback is delayed", async () => {
    // Failure mode: another isolate prunes the lease before this isolate runs its deadline timer.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T00:00:00.000Z"));
    const storage = new FakeStorage();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let finishFirst: () => void = () => undefined;
    const env: GatewayEnv = {
      ...BASE_ENV,
      KASPA_X402_GLOBAL_CONCURRENCY: "1",
      KASPA_X402_HASH_CHAIN_ENABLED: "true",
      KASPA_X402_ADMIN_TOKEN: "test-hash-chain-admin-token",
      GATEWAY_STATE: fakeNamespace(storage, {
        hashChainRequest(request) {
          if (!request.url.includes("slot=first"))
            return Promise.resolve(Response.json({ ok: true }));
          markStarted();
          return new Promise<Response>((resolve) => {
            finishFirst = () => resolve(Response.json({ ok: true }));
          });
        },
      }),
    };
    const call = (slot: string, ip: string) => handleGatewayRequest(
      workerRequest(`https://demo.kaspa-x402.org/hash-chain/report?slot=${slot}`, {
        headers: { "cf-connecting-ip": ip },
      }), env, fakeContext());
    const first = call("first", "203.0.113.10");
    try {
      await started;
      vi.setSystemTime(new Date("2026-10-09T00:05:00.001Z"));
      const second = await call("second", "203.0.113.11");
      expect(second.status).toBe(200);
      finishFirst();
      await expect(first).resolves.toMatchObject({ status: 503 });
    } finally {
      finishFirst();
      await first;
      vi.useRealTimers();
    }
  });

  it("cancels an in-flight supported-kind lookup before its lease can be reused", async () => {
    // Failure mode: the supported lookup creates its own request and keeps working after admission is lost.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T00:00:00.000Z"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const acquiredAt = Date.now();
    const storage = new FakeStorage();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let finishLookup: () => void = () => undefined;
    let active = false;
    let overlap = false;
    let stoppedAt: number | undefined;
    const env: GatewayEnv = {
      ...BASE_ENV,
      KASPA_X402_GATEWAY_BASE_URL: "https://lease-supported.example.test",
      KASPA_X402_GLOBAL_CONCURRENCY: "1",
      KASPA_X402_HASH_CHAIN_ENABLED: "true",
      KASPA_X402_ADMIN_TOKEN: "test-hash-chain-admin-token",
      GATEWAY_STATE: fakeNamespace(storage, {
        renewalError: new Error("coordinator renewal failed"),
        hashChainRequest(request) {
          if (!request.url.endsWith("/hash-chain/supported")) {
            overlap = active;
            return Promise.resolve(Response.json({ ok: true }));
          }
          active = true;
          markStarted();
          return new Promise<Response>((resolve) => {
            const finish = () => { active = false; resolve(Response.json({ kinds: [] })); };
            finishLookup = finish;
            request.signal.addEventListener("abort", () => {
              stoppedAt = Date.now();
              finish();
            }, { once: true });
          });
        },
      }),
    };
    const first = handleGatewayRequest(workerRequest("https://lease-supported.example.test/supported", {
      headers: { "cf-connecting-ip": "203.0.113.10" },
    }), env, fakeContext());
    try {
      await started;
      await vi.advanceTimersByTimeAsync(300_001);
      const second = await handleGatewayRequest(workerRequest("https://lease-supported.example.test/hash-chain/report", {
        headers: { "cf-connecting-ip": "203.0.113.11" },
      }), env, fakeContext());
      expect(second.status).toBe(200);
      expect(overlap).toBe(false);
      expect(stoppedAt).toBeLessThanOrEqual(acquiredAt + 300_000);
      await expect(first).resolves.toMatchObject({ status: 503 });
    } finally {
      finishLookup();
      await first;
      vi.useRealTimers();
    }
  });

  it.each([
    { route: "/batch", method: "loadRecentPnnDaaScore", profile: "standard-native" },
    { route: "/batch", method: "resolveBatchRefundTimeoutDaa", profile: "standard-native" },
    { route: "/supported", method: "exactHeadStats", profile: "additive" },
    { route: "/exact", method: "selectExactHead", profile: "additive" },
  ] as const)("cancels a stalled $method state call before admitting new work", async ({ route, method, profile }) => {
    // Failure mode: a lost lease races the response while a signal-less state call remains active.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T00:00:00.000Z"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const acquiredAt = Date.now();
    const storage = new FakeStorage();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let finishStateCall: () => void = () => undefined;
    let active = false;
    let overlap = false;
    let stoppedAt: number | undefined;
    const env: GatewayEnv = {
      ...BASE_ENV,
      KASPA_X402_GLOBAL_CONCURRENCY: "1",
      KASPA_X402_EXACT_PROFILE: profile,
      KASPA_X402_HOSTED_EXACT_SETTLEMENT_ENABLED: "true",
      KASPA_X402_HASH_CHAIN_ENABLED: "true",
      KASPA_X402_ADMIN_TOKEN: "test-hash-chain-admin-token",
      GATEWAY_STATE: fakeNamespace(storage, {
        renewalError: new Error("coordinator renewal failed"),
        stateRequest(name, signal) {
          if (method === "selectExactHead" && name === "exactHeadStats")
            return Promise.resolve(Response.json({ ok: true, value: {
              total: 1, available: 1, claimed: 0, unavailable: 0, retired: 0,
            } }));
          if (name !== method) return undefined;
          active = true;
          markStarted();
          return new Promise<Response>((resolve) => {
            const value = method === "exactHeadStats"
              ? { total: 0, available: 0, claimed: 0, unavailable: 0, retired: 0 }
              : method === "loadRecentPnnDaaScore" ? "507000000" : "507036000";
            const finish = () => { active = false; resolve(Response.json({ ok: true, value })); };
            finishStateCall = finish;
            signal?.addEventListener("abort", () => {
              stoppedAt = Date.now();
              finish();
            }, { once: true });
          });
        },
        hashChainRequest() {
          overlap = active;
          return Promise.resolve(Response.json({ ok: true }));
        },
      }),
    };
    const first = handleGatewayRequest(workerRequest(`https://demo.kaspa-x402.org${route}`, {
      headers: { "cf-connecting-ip": "203.0.113.10" },
    }), env, fakeContext());
    try {
      await started;
      await vi.advanceTimersByTimeAsync(300_001);
      const second = await handleGatewayRequest(workerRequest("https://demo.kaspa-x402.org/hash-chain/status", {
        headers: { "cf-connecting-ip": "203.0.113.11" },
      }), env, fakeContext());
      expect(second.status).toBe(200);
      expect(overlap).toBe(false);
      expect(stoppedAt).toBeLessThanOrEqual(acquiredAt + 300_000);
      await expect(first).resolves.toMatchObject({ status: 503 });
    } finally {
      finishStateCall();
      await first;
      vi.useRealTimers();
    }
  });

  it("keeps one caller from occupying another caller's durable lease", async () => {
    const storage = new FakeStorage();
    const env: GatewayEnv = {
      ...BASE_ENV,
      GATEWAY_STATE: fakeNamespace(storage),
      KASPA_X402_HASH_CHAIN_ENABLED: "true",
      KASPA_X402_HASH_CHAIN_ORIGIN: "https://issuer.example.test",
      KASPA_X402_HASH_CHAIN_PROXY_TOKEN: "proxy-test-value",
      KASPA_X402_GLOBAL_CONCURRENCY: "2",
      KASPA_X402_PER_CALLER_CONCURRENCY: "1",
      KASPA_X402_ADMISSION_HMAC_KEY: "test-admission-key-with-at-least-32-bytes",
    };
    let markFirstStarted!: () => void;
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("slot=first")) {
        markFirstStarted();
        await firstMayFinish;
      }
      return Response.json({ ok: true });
    }));
    const request = (slot: string, ip: string) => handleGatewayRequest(
      workerRequest(`https://demo.kaspa-x402.org/hash-chain/report?slot=${slot}`, {
        headers: { "cf-connecting-ip": ip },
      }),
      env,
      fakeContext(),
    );

    const first = request("first", "203.0.113.10");
    await firstStarted;
    try {
      const saturated = await request("second", "203.0.113.10");
      expect(saturated.status).toBe(429);
      await expect(saturated.json()).resolves.toMatchObject({ error: "caller_concurrency_exceeded" });
      const unrelated = await request("other", "203.0.113.11");
      expect(unrelated.status).toBe(200);
    } finally {
      releaseFirst();
      await first;
    }
  });

  it("normalizes equivalent IPv6 ingress addresses to one caller lease", async () => {
    // Failure modes: alternate IPv6 spellings evade the per-caller cap or
    // raw forwarding headers influence the trusted admission identity.
    const storage = new FakeStorage();
    const env: GatewayEnv = {
      ...BASE_ENV,
      GATEWAY_STATE: fakeNamespace(storage),
      KASPA_X402_HASH_CHAIN_ENABLED: "true",
      KASPA_X402_HASH_CHAIN_ORIGIN: "https://issuer.example.test",
      KASPA_X402_HASH_CHAIN_PROXY_TOKEN: "proxy-test-value",
      KASPA_X402_GLOBAL_CONCURRENCY: "2",
      KASPA_X402_PER_CALLER_CONCURRENCY: "1",
    };
    let started!: () => void;
    let finish!: () => void;
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    const firstMayFinish = new Promise<void>((resolve) => { finish = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("slot=first")) {
        started();
        await firstMayFinish;
      }
      return Response.json({ ok: true });
    }));
    const request = (slot: string, ip: string) => handleGatewayRequest(
      workerRequest(`https://demo.kaspa-x402.org/hash-chain/report?slot=${slot}`, {
        headers: { "cf-connecting-ip": ip, "x-forwarded-for": "192.0.2.250" },
      }), env, fakeContext());
    const first = request("first", "2001:0db8::1");
    await firstStarted;
    try {
      const second = await request("second", "2001:db8:0:0:0:0:0:1");
      expect(second.status).toBe(429);
      await expect(second.json()).resolves.toMatchObject({ error: "caller_concurrency_exceeded" });
    } finally {
      finish();
      await first;
    }
  });

  it("uses one bounded aggregate when Cloudflare ingress metadata is absent", async () => {
    const storage = new FakeStorage();
    const env: GatewayEnv = {
      ...BASE_ENV,
      GATEWAY_STATE: fakeNamespace(storage),
      KASPA_X402_HASH_CHAIN_ENABLED: "true",
      KASPA_X402_HASH_CHAIN_ORIGIN: "https://issuer.example.test",
      KASPA_X402_HASH_CHAIN_PROXY_TOKEN: "proxy-test-value",
      KASPA_X402_GLOBAL_CONCURRENCY: "2",
      KASPA_X402_PER_CALLER_CONCURRENCY: "1",
    };
    let markFirstStarted!: () => void;
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("slot=first")) {
        markFirstStarted();
        await firstMayFinish;
      }
      return Response.json({ ok: true });
    }));
    const request = (slot: string, ip: string) => handleGatewayRequest(
      new globalThis.Request(`https://demo.kaspa-x402.org/hash-chain/report?slot=${slot}`, {
        headers: { "cf-connecting-ip": ip, "x-forwarded-for": "192.0.2.250" },
      }), env, fakeContext(),
    );
    const first = request("first", "203.0.113.20");
    await firstStarted;
    try {
      const second = await request("second", "203.0.113.21");
      expect(second.status).toBe(429);
      await expect(second.json()).resolves.toMatchObject({ error: "caller_concurrency_exceeded" });
    } finally {
      releaseFirst();
      await first;
    }
  });

  it("rejects an unsigned paid request before PNN work", async () => {
    const storage = new FakeStorage();
    const env: GatewayEnv = {
      ...BASE_ENV,
      GATEWAY_STATE: fakeNamespace(storage),
      KASPA_X402_ADMISSION_HMAC_KEY: "test-admission-key-with-at-least-32-bytes",
    };
    const pnnRead = vi.spyOn(PnnChainEvidence.prototype, "getVirtualDaaScore")
      .mockResolvedValue("507000000");
    const response = await handleGatewayRequest(
      workerRequest("https://demo.kaspa-x402.org/batch", {
        headers: { "cf-connecting-ip": "203.0.113.12" },
      }),
      env,
      fakeContext(),
    );
    expect(response.status).toBe(402);
    expect(pnnRead).not.toHaveBeenCalled();
  });

  it("rejects a short malformed payment header before PNN work", async () => {
    // Failure modes: a small invalid header passes the size check and starts
    // a chain read; a foreign scheme loses its corrective 402 response.
    const storage = new FakeStorage();
    const env: GatewayEnv = { ...BASE_ENV, GATEWAY_STATE: fakeNamespace(storage) };
    const pnnRead = vi.spyOn(PnnChainEvidence.prototype, "getVirtualDaaScore")
      .mockResolvedValue("507000000");
    const response = await handleGatewayRequest(workerRequest(
      "https://demo.kaspa-x402.org/batch", {
        headers: { [PAYMENT_SIGNATURE_HEADER]: "invalid-payment" },
      }), env, fakeContext());
    expect(response.status).toBe(400);
    expect(pnnRead).not.toHaveBeenCalled();
  });

  it("withholds unsigned quotes when a cached DAA cannot preserve refund lead", async () => {
    // Failure modes: stale DAA plus a tiny configured margin produces a
    // timeout below the required lead, or the request performs a PNN read.
    const storage = new FakeStorage();
    const env: GatewayEnv = {
      ...BASE_ENV,
      GATEWAY_STATE: fakeNamespace(storage),
      KASPA_X402_REFUND_TIMEOUT_DAA_DELTA: "1001",
      KASPA_X402_MINIMUM_REFUND_LEAD_DAA: "1000",
    };
    const pnnRead = vi.spyOn(PnnChainEvidence.prototype, "getVirtualDaaScore")
      .mockResolvedValue("507000000");
    const response = await handleGatewayRequest(workerRequest(
      "https://demo.kaspa-x402.org/batch"), env, fakeContext());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: "quote_unavailable" });
    expect(pnnRead).not.toHaveBeenCalled();
  });

  it("fails closed when the cached DAA is too old for an allowed refund margin", async () => {
    // Failure modes: 30 minutes is treated as safe for every margin, or an
    // unsigned request starts a live PNN read to compensate for stale state.
    const now = Date.UTC(2026, 9, 9);
    vi.spyOn(Date, "now").mockReturnValue(now);
    const storage = new FakeStorage();
    await storage.put("pnn-quote-observation", {
      daaScore: "507000000", observedAt: now - 5 * 60_000,
    });
    const env: GatewayEnv = {
      ...BASE_ENV,
      GATEWAY_STATE: fakeNamespace(storage),
      KASPA_X402_REFUND_TIMEOUT_DAA_DELTA: "9000",
      KASPA_X402_MINIMUM_REFUND_LEAD_DAA: "1000",
    };
    const pnnRead = vi.spyOn(PnnChainEvidence.prototype, "getVirtualDaaScore");
    const response = await handleGatewayRequest(
      workerRequest("https://demo.kaspa-x402.org/batch"), env, fakeContext(),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: "quote_unavailable" });
    expect(pnnRead).not.toHaveBeenCalled();
  });

  it("uses a recent cached DAA to issue a nondefault quote the paid path can retain", async () => {
    // Failure modes: a stored timeout just above the cached head is reused,
    // then paid handling rolls it and rejects the quote's pinned timeout.
    const now = Date.UTC(2026, 9, 9);
    vi.spyOn(Date, "now").mockReturnValue(now);
    const storage = new FakeStorage();
    await storage.put("pnn-quote-observation", {
      daaScore: "507000000", observedAt: now - 30_000,
    });
    const ledger = new GatewayLedger(storage);
    await ledger.resolveBatchRefundTimeoutDaa("506992001", "9000", "1000");
    const env: GatewayEnv = {
      ...BASE_ENV,
      GATEWAY_STATE: fakeNamespace(storage),
      KASPA_X402_REFUND_TIMEOUT_DAA_DELTA: "9000",
      KASPA_X402_MINIMUM_REFUND_LEAD_DAA: "1000",
    };
    const pnnRead = vi.spyOn(PnnChainEvidence.prototype, "getVirtualDaaScore");
    const response = await handleGatewayRequest(
      workerRequest("https://demo.kaspa-x402.org/batch"), env, fakeContext(),
    );
    expect(response.status).toBe(402);
    const required = decodePaymentRequiredHeader(response.headers.get(PAYMENT_REQUIRED_HEADER)!);
    const offeredTimeout = required.accepts[0]!.extra!.refundTimeoutDaa;
    if (typeof offeredTimeout !== "string") throw new Error("missing offered refund timeout");
    expect(offeredTimeout).toBe("507009000");
    const paidHeadDaa = 507000000n + 30n * 10n;
    expect(paidHeadDaa + 1000n).toBeLessThan(BigInt(offeredTimeout));
    await expect(ledger.resolveBatchRefundTimeoutDaa(paidHeadDaa.toString(), "9000", "1000"))
      .resolves.toBe(offeredTimeout);
    expect(pnnRead).not.toHaveBeenCalled();
  });

  it("keeps the default quote available near the 30-minute cache limit", async () => {
    const now = Date.UTC(2026, 9, 9);
    vi.spyOn(Date, "now").mockReturnValue(now);
    const storage = new FakeStorage();
    await storage.put("pnn-quote-observation", {
      daaScore: "507000000", observedAt: now - 29 * 60_000,
    });
    const env: GatewayEnv = { ...BASE_ENV, GATEWAY_STATE: fakeNamespace(storage) };
    const pnnRead = vi.spyOn(PnnChainEvidence.prototype, "getVirtualDaaScore");
    const response = await handleGatewayRequest(
      workerRequest("https://demo.kaspa-x402.org/batch"), env, fakeContext(),
    );
    expect(response.status).toBe(402);
    const required = decodePaymentRequiredHeader(response.headers.get(PAYMENT_REQUIRED_HEADER)!);
    const timeout = required.accepts[0]!.extra!.refundTimeoutDaa;
    if (typeof timeout !== "string") throw new Error("missing offered refund timeout");
    const offeredTimeout = BigInt(timeout);
    expect(507000000n + 29n * 60n * 10n + 1000n).toBeLessThan(offeredTimeout);
    expect(pnnRead).not.toHaveBeenCalled();
  });

  it("keeps missing and stale cached DAA states unavailable", async () => {
    const now = Date.UTC(2026, 9, 9);
    vi.spyOn(Date, "now").mockReturnValue(now);
    const storage = new FakeStorage();
    const env: GatewayEnv = { ...BASE_ENV, GATEWAY_STATE: fakeNamespace(storage) };
    await storage.delete("pnn-quote-observation");
    await expect(requestJson(env, "/batch")).resolves.toMatchObject({
      status: 503, body: { error: "quote_unavailable" },
    });
    await storage.put("pnn-quote-observation", {
      daaScore: "507000000", observedAt: now - 30 * 60_000 - 1,
    });
    await expect(requestJson(env, "/batch")).resolves.toMatchObject({
      status: 503, body: { error: "quote_unavailable" },
    });
  });

  it("fails closed before chain access when global admission is unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const storage = new FakeStorage();
    const env: GatewayEnv = {
      ...BASE_ENV,
      GATEWAY_STATE: fakeNamespace(storage, {
        admissionError: new Error("coordinator unavailable"),
      }),
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleGatewayRequest(
      workerRequest("https://demo.kaspa-x402.org/batch"),
      env,
      fakeContext(),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "admission_unavailable",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires operator auth and keeps hosted exact disabled unless settlement is enabled", async () => {
    const storage = new FakeStorage();
    const env: GatewayEnv = {
      ...BASE_ENV,
      GATEWAY_STATE: fakeNamespace(storage),
      KASPA_X402_ADMIN_TOKEN: "admin-token",
    };

    const unauthorized = await handleGatewayRequest(
      workerRequest("https://demo.kaspa-x402.org/admin/exact-heads/register", {
        method: "POST",
        body: JSON.stringify({ record: exactHead() }),
      }),
      env,
      fakeContext(),
    );
    expect(unauthorized.status).toBe(401);

    const cleartext = await handleGatewayRequest(
      workerRequest("http://demo.kaspa-x402.org/admin/exact-heads", {
        headers: { authorization: "Bearer admin-token" },
      }),
      env,
      fakeContext(),
    );
    expect(cleartext.status).toBe(400);
    await expect(cleartext.json()).resolves.toMatchObject({
      ok: false,
      error: "https_required",
    });

    const registered = await handleGatewayRequest(
      workerRequest("https://demo.kaspa-x402.org/admin/exact-heads/register", {
        method: "POST",
        headers: { authorization: "Bearer admin-token" },
        body: JSON.stringify({ record: exactHead() }),
      }),
      env,
      fakeContext(),
    );
    expect(registered.status).toBe(200);

    const supported = await requestJson(env, "/supported");
    expect(supported).toMatchObject({
      status: 200,
      body: { ok: true, enabled: true },
    });
    expect(
      (
        (supported.body as { kinds: Array<{ scheme: string }> }).kinds ?? []
      ).map((kind) => kind.scheme),
    ).not.toContain("exact");

    const exact = await requestJson(env, "/exact");
    expect(exact).toMatchObject({
      status: 503,
      body: { ok: false, error: "exact_unavailable" },
    });
    await expect(
      new GatewayLedger(storage).listExactHeads(),
    ).resolves.toMatchObject([{ status: "available", version: "0" }]);
  });

  it("advertises standard exact without requiring a head", async () => {
    const storage = new FakeStorage();
    const env: GatewayEnv = {
      ...BASE_ENV,
      GATEWAY_STATE: fakeNamespace(storage),
      KASPA_X402_HOSTED_EXACT_SETTLEMENT_ENABLED: "true",
      KASPA_X402_CHAIN_BROADCAST_MODE: "pnn",
      KASPA_X402_PNN_ENDPOINTS:
        "wss://vector-10.kaspa.green/kaspa/testnet-10/wrpc/json",
    };
    stubCanaryFetches();

    const supported = await requestJson(env, "/supported");
    expect(
      (
        supported.body as {
          kinds: Array<{ scheme: string; extra: Record<string, unknown> }>;
        }
      ).kinds,
    ).toContainEqual(
      expect.objectContaining({
        scheme: "exact",
        extra: expect.objectContaining({
          binding: "kaspa-exact-v2",
          profile: "standard-native",
        }),
      }),
    );

    const exact = await handleGatewayRequest(
      workerRequest("https://demo.kaspa-x402.org/exact"),
      env,
      fakeContext(),
    );
    expect(exact.status).toBe(402);
    expect(exact.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
    await expect(new GatewayLedger(storage).listExactHeads()).resolves.toEqual(
      [],
    );
  });

  it("advertises additive exact only while a reusable v2 head is available", async () => {
    const storage = new FakeStorage();
    const env: GatewayEnv = {
      ...BASE_ENV,
      GATEWAY_STATE: fakeNamespace(storage),
      KASPA_X402_EXACT_PROFILE: "additive",
      KASPA_X402_PAY_TO: KIP10_ADDRESS,
      KASPA_X402_HOSTED_EXACT_SETTLEMENT_ENABLED: "true",
      KASPA_X402_CHAIN_BROADCAST_MODE: "pnn",
      KASPA_X402_PNN_ENDPOINTS:
        "wss://vector-10.kaspa.green/kaspa/testnet-10/wrpc/json",
      KASPA_X402_ADMIN_TOKEN: "admin-token",
    };
    stubCanaryFetches();

    let supported = await requestJson(env, "/supported");
    expect(
      (
        (supported.body as { kinds: Array<{ scheme: string }> }).kinds ?? []
      ).map((kind) => kind.scheme),
    ).not.toContain("exact");
    await expect(requestJson(env, "/exact")).resolves.toMatchObject({
      status: 503,
      body: { ok: false, error: "exact_unavailable" },
    });
    const registration = await handleGatewayRequest(
      workerRequest("https://demo.kaspa-x402.org/admin/exact-heads/register", {
        method: "POST",
        headers: { authorization: "Bearer admin-token" },
        body: JSON.stringify({ record: exactHead() }),
      }),
      { ...env, KASPA_X402_ADMIN_TOKEN: "admin-token" },
      fakeContext(),
    );
    expect(registration.status).toBe(200);
    supported = await requestJson(env, "/supported");
    expect(
      (
        supported.body as {
          kinds: Array<{ scheme: string; extra: Record<string, unknown> }>;
        }
      ).kinds,
    ).toContainEqual(
      expect.objectContaining({
        scheme: "exact",
        extra: expect.objectContaining({
          binding: "kaspa-exact-v2",
          profile: "additive",
        }),
      }),
    );

    stubAdditiveHeadFetches("current");
    await expect(requestJson(env, "/exact")).resolves.toMatchObject({
      status: 503,
      body: { error: "exact_unavailable" },
    });
    const reconciled = await handleGatewayRequest(
      workerRequest("https://demo.kaspa-x402.org/admin/exact-heads/reconcile", {
        method: "POST",
        headers: { authorization: "Bearer admin-token" },
        body: JSON.stringify({ headId: "90".repeat(32) }),
      }), env, fakeContext(),
    );
    expect(reconciled.status).toBe(200);
    await expect(requestJson(env, "/exact")).resolves.toMatchObject({
      status: 402,
    });
  }, 10_000);

  it("returns an additive corrective offer for foreign payment schemes", async () => {
    const storage = new FakeStorage();
    const env: GatewayEnv = {
      ...BASE_ENV,
      GATEWAY_STATE: fakeNamespace(storage),
      KASPA_X402_EXACT_PROFILE: "additive",
      KASPA_X402_PAY_TO: KIP10_ADDRESS,
      KASPA_X402_HOSTED_EXACT_SETTLEMENT_ENABLED: "true",
      KASPA_X402_CHAIN_BROADCAST_MODE: "pnn",
      KASPA_X402_PNN_ENDPOINTS:
        "wss://vector-10.kaspa.green/kaspa/testnet-10/wrpc/json",
    };
    await new GatewayLedger(storage).registerExactHead(exactHead());
    stubAdditiveHeadFetches("current");
    const foreignPayment = btoa(
      JSON.stringify({
        x402Version: 2,
        accepted: { scheme: "evm", network: "eip155:1" },
        payload: {},
      }),
    );

    const response = await handleGatewayRequest(
      workerRequest("https://demo.kaspa-x402.org/exact", {
        headers: { [PAYMENT_SIGNATURE_HEADER]: foreignPayment },
      }),
      env,
      fakeContext(),
    );

    expect(response.status).toBe(402);
    await expect(response.clone().json()).resolves.toEqual({
      error: "unsupported_scheme",
    });
    const paymentRequired = decodePaymentRequiredHeader(
      response.headers.get(PAYMENT_REQUIRED_HEADER)!,
    );
    expect(paymentRequired.error).toBe("unsupported_scheme");
    expect(paymentRequired.accepts).toMatchObject([
      {
        scheme: "exact",
        extra: {
          profile: "additive",
          challengeId: expect.any(String),
        },
      },
    ]);
  });

  it("fails additive offers closed on a missing head and recovers only from proven lineage", async () => {
    const storage = new FakeStorage();
    const env: GatewayEnv = {
      ...BASE_ENV,
      GATEWAY_STATE: fakeNamespace(storage),
      KASPA_X402_EXACT_PROFILE: "additive",
      KASPA_X402_PAY_TO: KIP10_ADDRESS,
      KASPA_X402_HOSTED_EXACT_SETTLEMENT_ENABLED: "true",
      KASPA_X402_CHAIN_BROADCAST_MODE: "pnn",
      KASPA_X402_PNN_ENDPOINTS:
        "wss://vector-10.kaspa.green/kaspa/testnet-10/wrpc/json",
      KASPA_X402_ADMIN_TOKEN: "admin-token",
    };
    await new GatewayLedger(storage).registerExactHead(exactHead());

    stubAdditiveHeadFetches("missing");
    await expect(requestJson(env, "/exact")).resolves.toMatchObject({
      status: 503,
      body: { ok: false, error: "exact_unavailable" },
    });
    await expect(
      new GatewayLedger(storage).listExactHeads(),
    ).resolves.toMatchObject([{ status: "available" }]);
    const missing = await handleGatewayRequest(
      workerRequest("https://demo.kaspa-x402.org/admin/exact-heads/reconcile", {
        method: "POST",
        headers: { authorization: "Bearer admin-token" },
        body: JSON.stringify({ headId: "90".repeat(32) }),
      }), env, fakeContext(),
    );
    expect(missing.status).toBe(200);
    await expect(
      new GatewayLedger(storage).listExactHeads(),
    ).resolves.toMatchObject([{ status: "unavailable" }]);

    stubAdditiveHeadFetches("advanced");
    const recovered = await handleGatewayRequest(
      workerRequest("https://demo.kaspa-x402.org/admin/exact-heads/reconcile", {
        method: "POST",
        headers: { authorization: "Bearer admin-token" },
        body: JSON.stringify({
          headId: "90".repeat(32),
          candidateTransactionIds: ["11".repeat(32)],
        }),
      }),
      env,
      fakeContext(),
    );
    expect(recovered.status).toBe(200);
    await expect(recovered.json()).resolves.toMatchObject({
      ok: true,
      head: {
        status: "available",
        version: "1",
        currentOutpoint: { txid: "11".repeat(32), index: 0 },
        currentAmount: "120000000",
      },
    });
    await expect(requestJson(env, "/exact")).resolves.toMatchObject({
      status: 402,
    });
  });
});

describe("gateway request transport budget", () => {
  it("accepts the byte maximum and rejects maximum plus one while streaming", async () => {
    await expect(
      readRequestJsonWithLimit(
        workerRequest("https://demo.kaspa-x402.org/admin", {
          method: "POST",
          body: '{"x":""}',
        }),
        8,
        "test",
      ),
    ).resolves.toEqual({ x: "" });

    await expect(
      readRequestJsonWithLimit(
        workerRequest("https://demo.kaspa-x402.org/admin", {
          method: "POST",
          body: '{"x":"a"}',
        }),
        8,
        "test",
      ),
    ).rejects.toThrow("request body too large");
  });
});

async function requestJson(
  env: GatewayEnv,
  path: string,
): Promise<{ status: number; body: unknown }> {
  const response = await handleGatewayRequest(
    workerRequest(`https://demo.kaspa-x402.org${path}`),
    env,
    fakeContext(),
  );
  return { status: response.status, body: await response.json() };
}

function stubCanaryFetches(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url === "https://api-tn10.kaspa.org/info/blockdag") {
      return Response.json({
        networkName: "kaspa-testnet-10",
        virtualDaaScore: "507000000",
      });
    }
    if (url === "https://kaspa-x402.org/schemas/payment-required.schema.json") {
      return Response.json({
        $id: "https://kaspa-x402.org/schemas/payment-required.schema.json",
      });
    }
    if (url.startsWith("https://kaspa-x402.org/release.json?")) {
      return Response.json({ version: "1.0.0-rc.2" });
    }
    if (url === "https://kaspa-x402.org/docs/") {
      return new Response("<!doctype html><h1>Docs</h1>", {
        headers: { "content-type": "text/html" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

function stubAdditiveHeadFetches(
  state: "current" | "missing" | "advanced",
): void {
  vi.spyOn(PnnChainEvidence.prototype, "getUtxosForAddress").mockResolvedValue(state === "missing" ? [] : [{
    outpoint: { txid: state === "advanced" ? "11".repeat(32) : FUNDING_TX, index: 0 },
    amount: state === "advanced" ? "120000000" : "100000000", scriptPublicKey: KIP10_SCRIPT_PUBLIC_KEY,
  }]);
  vi.spyOn(PnnChainEvidence.prototype, "getTransaction").mockResolvedValue(state === "advanced" ? {
    transaction_id: "11".repeat(32), is_accepted: true,
    inputs: [{ previous_outpoint_hash: FUNDING_TX, previous_outpoint_index: 0 }],
    outputs: [{ index: 0, amount: "120000000", script_public_key: KIP10_SCRIPT_PUBLIC_KEY.slice(4) }],
  } : null);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url,
    );
    if (url.pathname === "/info/blockdag") {
      return Response.json({
        networkName: "kaspa-testnet-10",
        virtualDaaScore: "507000000",
      });
    }
    if (
      url.pathname === `/addresses/${encodeURIComponent(KIP10_ADDRESS)}/utxos`
    ) {
      if (state === "missing") return Response.json([]);
      const advanced = state === "advanced";
      return Response.json([
        {
          outpoint: {
            transactionId: advanced ? "11".repeat(32) : FUNDING_TX,
            index: 0,
          },
          utxoEntry: {
            amount: advanced ? "120000000" : "100000000",
            scriptPublicKey: {
              scriptPublicKey: KIP10_SCRIPT_PUBLIC_KEY.slice(4),
            },
          },
        },
      ]);
    }
    if (
      state === "advanced" &&
      url.pathname === `/transactions/${"11".repeat(32)}`
    ) {
      return Response.json({
        transaction_id: "11".repeat(32),
        is_accepted: true,
        inputs: [
          {
            previous_outpoint_hash: FUNDING_TX,
            previous_outpoint_index: 0,
          },
        ],
        outputs: [
          {
            index: 0,
            amount: "120000000",
            script_public_key: KIP10_SCRIPT_PUBLIC_KEY.slice(4),
          },
        ],
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

function fakeContext(): Pick<ExecutionContext, "waitUntil"> {
  return {
    waitUntil() {},
  };
}

function fakeNamespace(
  storage: GatewayStorage,
  options: {
    admissionError?: Error;
    renewalError?: Error;
    renewalRejected?: boolean;
    renewalHangs?: boolean;
    hashChainRequest?: (request: Request) => Promise<Response>;
    stateRequest?: (method: string, signal?: AbortSignal) => Promise<Response> | undefined;
  } = {},
): GatewayEnv["GATEWAY_STATE"] {
  const ledger = new GatewayLedger(storage);
  return {
    idFromName(name: string) {
      return { name } as unknown as DurableObjectId;
    },
    get() {
      return {
        acquirePublicAdmission(
          token: string,
          callerKey: string,
          nowMs: number,
          globalLimit: number,
          callerLimit: number,
          ttlMs: number,
        ) {
          if (options.admissionError) throw options.admissionError;
          return ledger.acquirePublicAdmission(token, callerKey, nowMs, globalLimit, callerLimit, ttlMs);
        },
        renewPublicAdmission(token: string, callerKey: string, nowMs: number, ttlMs: number) {
          if (options.renewalError) throw options.renewalError;
          if (options.renewalRejected) return Promise.resolve(false);
          if (options.renewalHangs) return new Promise<boolean>(() => undefined);
          return ledger.renewPublicAdmission(token, callerKey, nowMs, ttlMs);
        },
        releasePublicAdmission(token: string) {
          return ledger.releasePublicAdmission(token);
        },
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          if (new URL(input instanceof Request ? input.url : String(input)).pathname.startsWith("/hash-chain/")) {
            if (!options.hashChainRequest) throw new Error("hash-chain request is not configured");
            return options.hashChainRequest(input instanceof Request ? input : new Request(input, init));
          }
          const request = JSON.parse(
            String(init?.body ?? "{}"),
          ) as GatewayStateRequest;
          const intercepted = options.stateRequest?.(request.method, init?.signal ?? undefined);
          if (intercepted) return intercepted;
          const value = await dispatchGatewayState(ledger, request);
          return Response.json({ ok: true, value });
        },
      };
    },
  } as unknown as GatewayEnv["GATEWAY_STATE"];
}

class FakeStorage implements GatewayStorage {
  #values = new Map<string, unknown>();

  constructor() {
    // A scheduled chain observation is available before unsigned quote delivery.
    this.#values.set("pnn-quote-observation", {
      daaScore: "507000000",
      observedAt: Date.now(),
    });
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return cloneOrUndefined(this.#values.get(key) as T | undefined);
  }

  async put<T = unknown>(key: string, value: T): Promise<void> {
    this.#values.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.#values.delete(key);
  }

  async list<T = unknown>(options: {
    prefix?: string;
    start?: string;
    end?: string;
    limit?: number;
  }): Promise<Map<string, T>> {
    const result = new Map<string, T>();
    const entries = Array.from(this.#values.entries()).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    for (const [key, value] of entries) {
      if (options.prefix && !key.startsWith(options.prefix)) continue;
      if (options.start && key < options.start) continue;
      if (options.end && key >= options.end) continue;
      result.set(key, structuredClone(value) as T);
      if (options.limit !== undefined && result.size >= options.limit) break;
    }
    return result;
  }

  async transaction<T>(
    closure: (txn: GatewayStorage) => Promise<T>,
  ): Promise<T> {
    const snapshot = structuredClone(Array.from(this.#values.entries()));
    try {
      return await closure(this);
    } catch (error) {
      this.#values = new Map(snapshot);
      throw error;
    }
  }
}

function cloneOrUndefined<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}

function exactHead(): ExactHeadRecord {
  return {
    headId: "90".repeat(32),
    network: "kaspa:testnet-10",
    payTo: KIP10_ADDRESS,
    templateId: "kaspa-x402-kip10-additive-v1",
    transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
    currentOutpoint: { txid: FUNDING_TX, index: 0 },
    currentAmount: "100000000",
    scriptPublicKey: KIP10_SCRIPT_PUBLIC_KEY,
    redeemScript: KIP10_REDEEM_SCRIPT,
    additiveThresholdSompi: "10000000",
    version: "0",
    status: "available",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
  };
}
