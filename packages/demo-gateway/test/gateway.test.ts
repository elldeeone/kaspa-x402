import { afterEach, describe, expect, it, vi } from "vitest";
import { decodePaymentRequiredHeader } from "@kaspa-x402/core";
import {
  buildKip10AdditiveRedeemScript,
  payToScriptHashScript,
  serializedScriptPublicKey,
} from "@kaspa-x402/covenant";
import { handleGatewayRequest, runGatewayCanary } from "../src/gateway.js";
import { addressForScriptPublicKey } from "../src/kaspa-native.js";
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
  KASPA_X402_CHAIN_API_BASE: "https://api-tn10.kaspa.org",
  KASPA_X402_PAY_TO:
    "kaspatest:qzlws9lm7uyt0tftzffshnyeu2zcqk4kf7hw5ghk6v0zh093vnkljcy2fl0fh",
  KASPA_X402_SERVER_PUBLIC_KEY:
    "bee817fbf708b7ad2b12530bcc99e285805ab64faeea22f6d31e2bbcb164edf9",
  KASPA_X402_SITE_BASE_URL: "https://kaspa-x402.org",
  KASPA_X402_RELEASE_VERSION: "0.1.0-alpha.11",
  KASPA_X402_GATEWAY_BASE_URL: "https://demo.kaspa-x402.org",
};

describe("gateway canary", () => {
  afterEach(() => {
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
    await expect(
      new GatewayLedger(storage).loadCanaryReport(),
    ).resolves.toEqual(report);
  });

  it("advertises the deterministic batch claim reserve", async () => {
    const storage = new FakeStorage();
    const env: GatewayEnv = {
      ...BASE_ENV,
      GATEWAY_STATE: fakeNamespace(storage),
    };
    stubCanaryFetches();

    const response = await handleGatewayRequest(
      new Request("https://demo.kaspa-x402.org/batch"),
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
      new Request("https://demo.kaspa-x402.org/batch", { method: "POST" }),
      env,
      fakeContext(),
    );
    const firstResponse = await handleGatewayRequest(
      new Request("https://demo.kaspa-x402.org/batch", {
        headers: { "cf-connecting-ip": "203.0.113.10" },
      }),
      env,
      fakeContext(),
    );
    const fetchesAfterAllowedRequest = fetchMock.mock.calls.length;
    const limitedResponse = await handleGatewayRequest(
      new Request("https://demo.kaspa-x402.org/batch", {
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
    expect(fetchesAfterAllowedRequest).toBeGreaterThan(0);
    expect(limited).toMatchObject({
      status: 429,
      body: { ok: false, error: "rate_limited" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(fetchesAfterAllowedRequest);
  });

  it("requires operator auth and keeps hosted exact disabled unless settlement is enabled", async () => {
    const storage = new FakeStorage();
    const env: GatewayEnv = {
      ...BASE_ENV,
      GATEWAY_STATE: fakeNamespace(storage),
      KASPA_X402_ADMIN_TOKEN: "admin-token",
    };

    const unauthorized = await handleGatewayRequest(
      new Request("https://demo.kaspa-x402.org/admin/exact-heads/register", {
        method: "POST",
        body: JSON.stringify({ record: exactHead() }),
      }),
      env,
      fakeContext(),
    );
    expect(unauthorized.status).toBe(401);

    const cleartext = await handleGatewayRequest(
      new Request("http://demo.kaspa-x402.org/admin/exact-heads", {
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
      new Request("https://demo.kaspa-x402.org/admin/exact-heads/register", {
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
      new Request("https://demo.kaspa-x402.org/exact"),
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
    };

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
      new Request("https://demo.kaspa-x402.org/admin/exact-heads/register", {
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
      status: 402,
    });
  });

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
      new Request("https://demo.kaspa-x402.org/exact", {
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
    ).resolves.toMatchObject([{ status: "unavailable" }]);

    stubAdditiveHeadFetches("advanced");
    const recovered = await handleGatewayRequest(
      new Request("https://demo.kaspa-x402.org/admin/exact-heads/reconcile", {
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

async function requestJson(
  env: GatewayEnv,
  path: string,
): Promise<{ status: number; body: unknown }> {
  const response = await handleGatewayRequest(
    new Request(`https://demo.kaspa-x402.org${path}`),
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
    if (url.startsWith("https://kaspa-x402.org/v0.1.0-alpha.11/release.json?")) {
      return Response.json({ version: "0.1.0-alpha.11" });
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

function fakeNamespace(storage: GatewayStorage): GatewayEnv["GATEWAY_STATE"] {
  const ledger = new GatewayLedger(storage);
  return {
    idFromName(name: string) {
      return { name } as unknown as DurableObjectId;
    },
    get() {
      return {
        async fetch(_input: RequestInfo | URL, init?: RequestInit) {
          const request = JSON.parse(
            String(init?.body ?? "{}"),
          ) as GatewayStateRequest;
          const value = await dispatchGatewayState(ledger, request);
          return Response.json({ ok: true, value });
        },
      } as DurableObjectStub;
    },
  } as unknown as GatewayEnv["GATEWAY_STATE"];
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
