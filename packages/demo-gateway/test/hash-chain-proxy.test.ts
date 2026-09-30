import { afterEach, describe, expect, it, vi } from "vitest";
import { hashChainSupportedKinds, proxyHashChainRequest } from "../src/hash-chain-proxy.js";
import { readGatewayConfig, type GatewayEnv } from "../src/config.js";
import { handleGatewayRequest } from "../src/gateway.js";

const env: GatewayEnv = {
  KASPA_X402_GATEWAY_ENABLED: "true",
  KASPA_X402_CHAIN_API_BASE: "https://api-tn10.kaspa.org",
  KASPA_X402_HASH_CHAIN_ORIGIN: "https://issuer.example.test",
  KASPA_X402_HASH_CHAIN_PROXY_TOKEN: "proxy-test-value",
  KASPA_X402_PAY_TO: "kaspatest:merchant",
  KASPA_X402_SERVER_PUBLIC_KEY: "aa".repeat(32),
} as GatewayEnv;

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
    const response = await proxyHashChainRequest(new Request("https://demo.kaspa-x402.org/hash-chain/report?demo-payment=one", {
      headers: { "PAYMENT-SIGNATURE": "signed-proof", cookie: "private",
        "cf-connecting-ip": "203.0.113.1", "x-kaspa-x402-demo-caller": "forged" },
    }), readGatewayConfig(env));
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://issuer.example.test/hash-chain/report?demo-payment=one");
    expect(response.status).toBe(200);
    expect(response.headers.get("PAYMENT-RESPONSE")).toBe("receipt");
    expect(response.headers.get("x-kaspa-x402-demo-caller")).toMatch(/^[0-9a-f]{64}$/);
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(response.headers.has("x-private")).toBe(false);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("keeps caller admission stable across resource and grant requests and separates IPs", async () => {
    const callers: (string | null)[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
      callers.push(new Headers(init.headers).get("x-kaspa-x402-demo-caller"));
      return new Response("{}");
    }));
    for (const [path, ip] of [["/hash-chain/report", "203.0.113.1"],
      ["/hash-chain/grant", "203.0.113.1"], ["/hash-chain/report", "203.0.113.2"]] as const) {
      await proxyHashChainRequest(new Request(`https://demo.kaspa-x402.org${path}`, {
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
    const response = await handleGatewayRequest(new Request("https://demo.kaspa-x402.org/hash-chain/report", {
      headers: { origin: "https://kaspa-x402.org", "cf-connecting-ip": "203.0.113.1" },
    }), env, { waitUntil() {} });
    expect(response.status).toBe(402);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://kaspa-x402.org");
    expect(response.headers.get("access-control-expose-headers")?.toLowerCase()).toContain("x-kaspa-x402-demo-caller");
    expect(response.headers.get("x-kaspa-x402-demo-caller")).toMatch(/^[0-9a-f]{64}$/);
  });
  it("rejects a resource request without trusted caller metadata", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const response = await proxyHashChainRequest(new Request("https://demo.kaspa-x402.org/hash-chain/report", {
      headers: { "x-kaspa-x402-demo-caller": "aa".repeat(32), "x-forwarded-for": "203.0.113.1" },
    }), readGatewayConfig(env));
    expect(response.status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("leaves hash-chain unavailable when unconfigured or disabled", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const response = await proxyHashChainRequest(new Request("https://demo.kaspa-x402.org/hash-chain/report"),
      readGatewayConfig({ ...env, KASPA_X402_HASH_CHAIN_ORIGIN: "" }));
    expect(response.status).toBe(503);
    expect((await proxyHashChainRequest(new Request("https://demo.kaspa-x402.org/hash-chain/report"),
      readGatewayConfig({ ...env, KASPA_X402_HASH_CHAIN_PROXY_TOKEN: undefined }))).status).toBe(503);
    expect(await hashChainSupportedKinds(readGatewayConfig({ ...env, KASPA_X402_GATEWAY_ENABLED: "false" }))).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not advertise unavailable support or follow an upstream failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"kinds":[]}')));
    expect(await hashChainSupportedKinds(readGatewayConfig(env))).toEqual([]);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("issuer offline"); }));
    const response = await proxyHashChainRequest(new Request("https://demo.kaspa-x402.org/hash-chain/report", {
      headers: { "cf-connecting-ip": "203.0.113.1" },
    }), readGatewayConfig(env));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "hash_chain_unavailable" });
  });
});
