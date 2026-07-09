import { afterEach, describe, expect, it, vi } from "vitest";
import { handleGatewayRequest, runGatewayCanary } from "../src/gateway.js";
import { dispatchGatewayState, GatewayLedger, type GatewayStateRequest, type GatewayStorage } from "../src/state.js";
import type { GatewayEnv } from "../src/config.js";

const FUNDING_TX = "88".repeat(32);
const SCRIPT = "0000" + "99".repeat(34);

const BASE_ENV: Omit<GatewayEnv, "GATEWAY_STATE"> = {
  KASPA_X402_NETWORK: "kaspa:testnet-10",
  KASPA_X402_CHAIN_API_BASE: "https://api-tn10.kaspa.org",
  KASPA_X402_PAY_TO: "kaspatest:qzlws9lm7uyt0tftzffshnyeu2zcqk4kf7hw5ghk6v0zh093vnkljcy2fl0fh",
  KASPA_X402_SERVER_PUBLIC_KEY: "bee817fbf708b7ad2b12530bcc99e285805ab64faeea22f6d31e2bbcb164edf9",
  KASPA_X402_SITE_BASE_URL: "https://kaspa-x402.org",
  KASPA_X402_GATEWAY_BASE_URL: "https://demo.kaspa-x402.org",
};

describe("gateway canary", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs non-spending checks and stores the latest report", async () => {
    const storage = new FakeStorage();
    const env: GatewayEnv = { ...BASE_ENV, GATEWAY_STATE: fakeNamespace(storage) };
    stubCanaryFetches();

    const report = await runGatewayCanary(env, "manual");

    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => `${check.name}:${check.status}`)).toEqual([
      "kaspa-rest:ok",
      "schema-url:ok",
      "release-snapshot:ok",
      "docs-index:ok",
      "exact-offer:skipped",
      "batch-offer:ok",
      "unsupported-scheme-rejection:ok",
      "paid-exact-canary:skipped",
      "replay-rejection-canary:skipped",
    ]);
    await expect(new GatewayLedger(storage).loadCanaryReport()).resolves.toEqual(report);
  });

  it("skips protected-route canaries when the gateway is disabled", async () => {
    const storage = new FakeStorage();
    const env: GatewayEnv = { ...BASE_ENV, GATEWAY_STATE: fakeNamespace(storage), KASPA_X402_GATEWAY_ENABLED: "false" };
    stubCanaryFetches();

    const report = await runGatewayCanary(env, "manual");

    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => `${check.name}:${check.status}`)).toEqual([
      "kaspa-rest:ok",
      "schema-url:ok",
      "release-snapshot:ok",
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
    const env: GatewayEnv = { ...BASE_ENV, GATEWAY_STATE: fakeNamespace(storage), KASPA_X402_GATEWAY_ENABLED: "false" };
    stubCanaryFetches();

    const health = await requestJson(env, "/health");
    const supported = await requestJson(env, "/supported");
    const exact = await requestJson(env, "/exact");
    const batch = await requestJson(env, "/batch");

    expect(health).toMatchObject({ status: 200, body: { ok: true, enabled: false } });
    expect(supported).toMatchObject({ status: 200, body: { ok: true, enabled: false } });
    expect(exact).toMatchObject({ status: 503, body: { ok: false, error: "gateway_disabled" } });
    expect(batch).toMatchObject({ status: 503, body: { ok: false, error: "gateway_disabled" } });
  });

  it("requires operator auth and keeps hosted exact disabled unless settlement is enabled", async () => {
    const storage = new FakeStorage();
    const env: GatewayEnv = { ...BASE_ENV, GATEWAY_STATE: fakeNamespace(storage), KASPA_X402_ADMIN_TOKEN: "admin-token" };

    const unauthorized = await handleGatewayRequest(
      new Request("https://demo.kaspa-x402.org/admin/exact-inventory/register", {
        method: "POST",
        body: JSON.stringify({ record: exactInventory() }),
      }),
      env,
      fakeContext(),
    );
    expect(unauthorized.status).toBe(401);

    const registered = await handleGatewayRequest(
      new Request("https://demo.kaspa-x402.org/admin/exact-inventory/register", {
        method: "POST",
        headers: { authorization: "Bearer admin-token" },
        body: JSON.stringify({ record: exactInventory() }),
      }),
      env,
      fakeContext(),
    );
    expect(registered.status).toBe(200);

    const supported = await requestJson(env, "/supported");
    expect(supported).toMatchObject({ status: 200, body: { ok: true, enabled: true } });
    expect(((supported.body as { kinds: Array<{ scheme: string }> }).kinds ?? []).map((kind) => kind.scheme)).not.toContain("exact");

    const exact = await requestJson(env, "/exact");
    expect(exact).toMatchObject({ status: 503, body: { ok: false, error: "exact_unavailable" } });
    await expect(new GatewayLedger(storage).exactInventoryStats()).resolves.toMatchObject({ available: 1, reserved: 0 });
  });

  it("advertises exact when hosted settlement is enabled and inventory is available", async () => {
    const storage = new FakeStorage();
    const env: GatewayEnv = {
      ...BASE_ENV,
      GATEWAY_STATE: fakeNamespace(storage),
      KASPA_X402_ADMIN_TOKEN: "admin-token",
      KASPA_X402_HOSTED_EXACT_SETTLEMENT_ENABLED: "true",
      KASPA_X402_CHAIN_BROADCAST_MODE: "pnn",
      KASPA_X402_PNN_ENDPOINTS: "wss://vector-10.kaspa.green/kaspa/testnet-10/wrpc/json",
    };

    const registered = await handleGatewayRequest(
      new Request("https://demo.kaspa-x402.org/admin/exact-inventory/register", {
        method: "POST",
        headers: { authorization: "Bearer admin-token" },
        body: JSON.stringify({ record: exactInventory() }),
      }),
      env,
      fakeContext(),
    );
    expect(registered.status).toBe(200);

    const supported = await requestJson(env, "/supported");
    expect(((supported.body as { kinds: Array<{ scheme: string }> }).kinds ?? []).map((kind) => kind.scheme)).toContain("exact");

    const exact = await handleGatewayRequest(new Request("https://demo.kaspa-x402.org/exact"), env, fakeContext());
    expect(exact.status).toBe(402);
    expect(exact.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
    await expect(new GatewayLedger(storage).exactInventoryStats()).resolves.toMatchObject({ available: 0, reserved: 1 });
  });

  it("does not partially register invalid inventory batches", async () => {
    const storage = new FakeStorage();
    const env: GatewayEnv = { ...BASE_ENV, GATEWAY_STATE: fakeNamespace(storage), KASPA_X402_ADMIN_TOKEN: "admin-token" };

    const response = await handleGatewayRequest(
      new Request("https://demo.kaspa-x402.org/admin/exact-inventory/register", {
        method: "POST",
        headers: { authorization: "Bearer admin-token" },
        body: JSON.stringify({
          records: [exactInventory(), exactInventory({ borrowOutpoint: { txid: "66".repeat(32), index: 0 }, additiveThresholdSompi: "1" })],
        }),
      }),
      env,
      fakeContext(),
    );

    expect(response.status).toBe(400);
    await expect(new GatewayLedger(storage).exactInventoryStats()).resolves.toMatchObject({ total: 0, available: 0 });
  });
});

async function requestJson(env: GatewayEnv, path: string): Promise<{ status: number; body: unknown }> {
  const response = await handleGatewayRequest(new Request(`https://demo.kaspa-x402.org${path}`), env, fakeContext());
  return { status: response.status, body: await response.json() };
}

function stubCanaryFetches(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://api-tn10.kaspa.org/info/blockdag") {
      return Response.json({ networkName: "kaspa-testnet-10", virtualDaaScore: "507000000" });
    }
    if (url === "https://kaspa-x402.org/schemas/payment-required.schema.json") {
      return Response.json({ $id: "https://kaspa-x402.org/schemas/payment-required.schema.json" });
    }
    if (url.startsWith("https://kaspa-x402.org/v0.1.0-alpha.1/release.json?")) {
      return Response.json({ version: "0.1.0-alpha.1" });
    }
    if (url === "https://kaspa-x402.org/docs/") {
      return new Response("<!doctype html><h1>Docs</h1>", { headers: { "content-type": "text/html" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

function fakeContext(): Pick<ExecutionContext, "waitUntil"> {
  return {
    waitUntil() {},
  };
}

function fakeNamespace(storage: GatewayStorage): DurableObjectNamespace {
  const ledger = new GatewayLedger(storage);
  return {
    idFromName(name: string) {
      return { name } as unknown as DurableObjectId;
    },
    get() {
      return {
        async fetch(_input: RequestInfo | URL, init?: RequestInit) {
          const request = JSON.parse(String(init?.body ?? "{}")) as GatewayStateRequest;
          const value = await dispatchGatewayState(ledger, request);
          return Response.json({ ok: true, value });
        },
      } as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
}

class FakeStorage implements GatewayStorage {
  #values = new Map<string, unknown>();

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return cloneOrUndefined(this.#values.get(key) as T | undefined);
  }

  async put<T = unknown>(key: string, value: T): Promise<void> {
    this.#values.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.#values.delete(key);
  }

  async list<T = unknown>(options: { prefix: string }): Promise<Map<string, T>> {
    const result = new Map<string, T>();
    for (const [key, value] of this.#values) {
      if (key.startsWith(options.prefix)) result.set(key, structuredClone(value) as T);
    }
    return result;
  }

  async transaction<T>(closure: (txn: GatewayStorage) => Promise<T>): Promise<T> {
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

function exactInventory(overrides: Partial<ReturnType<typeof exactInventoryBase>> = {}) {
  return { ...exactInventoryBase(), ...overrides };
}

function exactInventoryBase() {
  return {
    network: "kaspa:testnet-10",
    templateId: "kaspa-x402-kip10-additive-v1",
    transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
    borrowOutpoint: { txid: FUNDING_TX, index: 0 },
    borrowAmount: "100000000",
    borrowScriptPublicKey: SCRIPT,
    borrowRedeemScript: "51",
    additiveThresholdSompi: "10000000",
    paymentOutputIndex: 0,
  };
}
