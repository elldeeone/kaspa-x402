import { afterEach, describe, expect, it, vi } from "vitest";
import { hashChainSupportedKinds, proxyHashChainRequest } from "../src/hash-chain-proxy.js";
import { readGatewayConfig, type GatewayEnv } from "../src/config.js";
import { handleGatewayRequest } from "../src/gateway.js";

function workerRequest(input: RequestInfo | URL, init?: RequestInit): Request {
  const request = new globalThis.Request(input, init);
  Object.defineProperty(request, "cf", { value: { colo: "SYD" } });
  return request;
}

const env: GatewayEnv = {
  KASPA_X402_GATEWAY_ENABLED: "true",
  KASPA_X402_CHAIN_BROADCAST_MODE: "pnn",
  KASPA_X402_PNN_ENDPOINTS: "wss://pnn.example.test",
  KASPA_X402_HASH_CHAIN_ORIGIN: "https://issuer.example.test",
  KASPA_X402_HASH_CHAIN_PROXY_TOKEN: "proxy-test-value",
  KASPA_X402_ADMISSION_HMAC_KEY: "test-admission-key-with-at-least-32-bytes",
  KASPA_X402_PAY_TO: "kaspatest:merchant",
  KASPA_X402_SERVER_PUBLIC_KEY: "aa".repeat(32),
} as GatewayEnv;

function gatewayEnv(overrides: Partial<GatewayEnv> = {}): GatewayEnv {
  const counts = new Map<string, number>();
  const leases = new Set<string>();
  const namespace = {
    idFromName(name: string) { return { name }; },
    get() {
      return {
        acquirePublicAdmission(token: string, _callerKey: string, _nowMs: number, globalLimit: number) {
          if (!leases.has(token) && leases.size >= globalLimit) {
            return { allowed: false, retryAt: Date.now() + 1_000 };
          }
          leases.add(token);
          return { allowed: true };
        },
        releasePublicAdmission(token: string) {
          leases.delete(token);
        },
        async fetch(_input: RequestInfo | URL, init?: RequestInit) {
          const request = JSON.parse(String(init?.body ?? "{}")) as {
            method: string;
            payload?: { scope?: string; limit?: number; windowMs?: number };
          };
          if (request.method !== "checkRateLimit") {
            return Response.json({ ok: false, error: `unexpected state method ${request.method}` }, { status: 500 });
          }
          const scope = request.payload?.scope ?? "unknown";
          const count = (counts.get(scope) ?? 0) + 1;
          counts.set(scope, count);
          return Response.json({ ok: true, value: {
            allowed: count <= (request.payload?.limit ?? 1),
            count,
            resetAt: Date.now() + (request.payload?.windowMs ?? 60_000),
          } });
        },
      };
    },
  };
  return { ...env, GATEWAY_STATE: namespace, ...overrides } as unknown as GatewayEnv;
}

describe("hash-chain demo proxy", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("forwards payment headers and trusted caller identity while keeping the public path", async () => {
    const fetcher = vi.fn(async (_url, init: RequestInit) => {
      const headers = new Headers(init.headers);
      expect(headers.get("authorization")).toBe("Bearer proxy-test-value");
      expect(headers.get("PAYMENT-SIGNATURE")).toBe("signed-proof");
      expect(headers.get("x-kaspa-x402-demo-caller")).toMatch(/^[0-9a-f]{64}$/);
      expect(headers.get("x-kaspa-x402-demo-caller")).not.toBe("forged");
      expect(headers.has("cf-connecting-ip")).toBe(false);
      expect(headers.has("cookie")).toBe(false);
      return new Response('{"access":"granted"}', { headers: {
        "PAYMENT-RESPONSE": "receipt", "set-cookie": "private", "x-private": "hidden",
        "x-kaspa-x402-demo-caller": headers.get("x-kaspa-x402-demo-caller")!,
      } });
    });
    vi.stubGlobal("fetch", fetcher);
    const response = await proxyHashChainRequest(workerRequest("https://demo.kaspa-x402.org/hash-chain/report?demo-payment=one", {
      headers: { "PAYMENT-SIGNATURE": "signed-proof", cookie: "private",
        "cf-connecting-ip": "203.0.113.1", "x-kaspa-x402-demo-caller": "forged" },
    }), readGatewayConfig(env));
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://issuer.example.test/hash-chain/report?demo-payment=one");
    expect(response.status).toBe(200);
    expect(response.headers.get("PAYMENT-RESPONSE")).toBe("receipt");
    expect(response.headers.get("x-kaspa-x402-demo-caller")).toMatch(/^[0-9a-f]{64}$/);
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(response.headers.has("x-private")).toBe(false);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  });
  it("keeps caller admission stable across resource and grant requests and separates IPs", async () => {
    const callers: (string | null)[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
      callers.push(new Headers(init.headers).get("x-kaspa-x402-demo-caller"));
      return new Response("{}");
    }));
    for (const [path, ip] of [["/hash-chain/report", "203.0.113.1"],
      ["/hash-chain/grant", "203.0.113.1"], ["/hash-chain/report", "203.0.113.2"]] as const) {
      await proxyHashChainRequest(workerRequest(`https://demo.kaspa-x402.org${path}`, {
        method: path.endsWith("/grant") ? "POST" : "GET",
        headers: { "cf-connecting-ip": ip, "x-kaspa-x402-demo-caller": "forged" },
      }), readGatewayConfig(env));
    }
    expect(callers[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(callers[1]).toBe(callers[0]);
    expect(callers[2]).not.toBe(callers[0]);
  });
  it("exposes the quote's caller identity to the cross-origin browser", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => new Response("{}", {
      status: 402, headers: {
        "x-kaspa-x402-demo-caller": new Headers(init.headers).get("x-kaspa-x402-demo-caller")!,
      },
    })));
    const response = await handleGatewayRequest(workerRequest("https://demo.kaspa-x402.org/hash-chain/report", {
      headers: { origin: "https://kaspa-x402.org", "cf-connecting-ip": "203.0.113.1" },
    }), gatewayEnv(), { waitUntil() {} });
    expect(response.status).toBe(402);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://kaspa-x402.org");
    expect(response.headers.get("access-control-expose-headers")?.toLowerCase()).toContain("x-kaspa-x402-demo-caller");
    expect(response.headers.get("x-kaspa-x402-demo-caller")).toMatch(/^[0-9a-f]{64}$/);
  });
  it("rate-limits public hash-chain and supported work before repeated upstream calls", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return url.endsWith("/hash-chain/supported")
        ? Response.json({ kinds: [] })
        : new Response("{}", { status: 402 });
    });
    vi.stubGlobal("fetch", fetcher);
    for (const [index, path] of ["/hash-chain", "/hash-chain/report", "/hash-chain/grant", "/hash-chain/status"].entries()) {
      const admitted = gatewayEnv({
        KASPA_X402_HASH_CHAIN_ORIGIN: `https://rate-limit-${index}.example.test`,
        KASPA_X402_RATE_LIMIT_PER_MINUTE: "1",
      });
      const request = () => handleGatewayRequest(workerRequest(`https://demo.kaspa-x402.org${path}`, {
        method: path.endsWith("/grant") ? "POST" : "GET",
        headers: { "cf-connecting-ip": `203.0.113.${index + 1}` },
      }), admitted, { waitUntil() {} });
      expect((await request()).status).toBe(402);
      const limited = await request();
      expect(limited.status).toBe(429);
      await expect(limited.json()).resolves.toMatchObject({ error: "rate_limited" });
    }
    const supportedEnv = gatewayEnv({
      KASPA_X402_HASH_CHAIN_ORIGIN: "https://rate-limit-supported.example.test",
      KASPA_X402_RATE_LIMIT_PER_MINUTE: "1",
    });
    const supported = () => handleGatewayRequest(workerRequest("https://demo.kaspa-x402.org/supported", {
      headers: { "cf-connecting-ip": "203.0.113.9" },
    }), supportedEnv, { waitUntil() {} });
    expect((await supported()).status).toBe(200);
    const limitedSupported = await supported();
    expect(limitedSupported.status).toBe(429);
    await expect(limitedSupported.json()).resolves.toMatchObject({ error: "rate_limited" });
    expect(fetcher).toHaveBeenCalledTimes(5);
  });
  it("coalesces and briefly caches repeated hash-chain capability lookups", async () => {
    let release!: () => void;
    const mayFinish = new Promise<void>((resolve) => { release = resolve; });
    const fetcher = vi.fn(async () => {
      await mayFinish;
      return Response.json({ kinds: [] });
    });
    vi.stubGlobal("fetch", fetcher);
    const cached = gatewayEnv({
      KASPA_X402_HASH_CHAIN_ORIGIN: "https://capability-cache.example.test",
      KASPA_X402_RATE_LIMIT_PER_MINUTE: "10",
    });
    const request = (ip: string) => handleGatewayRequest(workerRequest("https://demo.kaspa-x402.org/supported", {
      headers: { "cf-connecting-ip": ip },
    }), cached, { waitUntil() {} });

    const first = request("203.0.113.20");
    const second = request("203.0.113.21");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 200 }),
      expect.objectContaining({ status: 200 }),
    ]);
    expect((await request("203.0.113.22")).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("holds the deployment-wide admission lease around hash-chain upstream work", async () => {
    let startFirst!: () => void;
    let finishFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { startFirst = resolve; });
    const firstMayFinish = new Promise<void>((resolve) => { finishFirst = resolve; });
    const fetcher = vi.fn(async () => {
      startFirst();
      await firstMayFinish;
      return new Response("{}");
    });
    vi.stubGlobal("fetch", fetcher);
    const admitted = gatewayEnv({ KASPA_X402_GLOBAL_CONCURRENCY: "1" });
    const request = (ip: string) => handleGatewayRequest(workerRequest("https://demo.kaspa-x402.org/hash-chain/status", {
      headers: { "cf-connecting-ip": ip },
    }), admitted, { waitUntil() {} });

    const first = request("203.0.113.10");
    await firstStarted;
    const rejected = await request("203.0.113.11");
    expect(rejected.status).toBe(503);
    await expect(rejected.json()).resolves.toMatchObject({ error: "global_concurrency_exceeded" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    finishFirst();
    await expect(first).resolves.toMatchObject({ status: 200 });
  });
  it("rejects a resource request without trusted caller metadata", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const response = await proxyHashChainRequest(workerRequest("https://demo.kaspa-x402.org/hash-chain/report", {
      headers: { "x-kaspa-x402-demo-caller": "aa".repeat(32), "x-forwarded-for": "203.0.113.1" },
    }), readGatewayConfig(env));
    expect(response.status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("leaves hash-chain unavailable when unconfigured or disabled", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const response = await proxyHashChainRequest(workerRequest("https://demo.kaspa-x402.org/hash-chain/report"),
      readGatewayConfig({ ...env, KASPA_X402_HASH_CHAIN_ORIGIN: "" }));
    expect(response.status).toBe(503);
    expect((await proxyHashChainRequest(workerRequest("https://demo.kaspa-x402.org/hash-chain/report"),
      readGatewayConfig({ ...env, KASPA_X402_HASH_CHAIN_PROXY_TOKEN: undefined }))).status).toBe(503);
    expect(await hashChainSupportedKinds(readGatewayConfig({ ...env, KASPA_X402_GATEWAY_ENABLED: "false" }))).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not advertise unavailable support or follow an upstream failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"kinds":[]}')));
    expect(await hashChainSupportedKinds(readGatewayConfig(env))).toEqual([]);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("issuer offline"); }));
    const response = await proxyHashChainRequest(workerRequest("https://demo.kaspa-x402.org/hash-chain/report", {
      headers: { "cf-connecting-ip": "203.0.113.1" },
    }), readGatewayConfig(env));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "hash_chain_unavailable" });
  });
  it("rejects an issuer redirect without forwarding it to the browser", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
      expect(init.redirect).toBe("manual");
      return new Response(null, { status: 302, headers: { location: "https://other.example.test" } });
    }));
    const response = await proxyHashChainRequest(workerRequest("https://demo.kaspa-x402.org/hash-chain/report", {
      headers: { "cf-connecting-ip": "203.0.113.1" },
    }), readGatewayConfig(env));
    expect(response.status).toBe(503);
    expect(response.headers.has("location")).toBe(false);
  });
});
