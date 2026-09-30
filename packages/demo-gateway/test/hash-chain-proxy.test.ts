import { afterEach, describe, expect, it, vi } from "vitest";
import { hashChainSupportedKinds, proxyHashChainRequest } from "../src/hash-chain-proxy.js";
import { readGatewayConfig, type GatewayEnv } from "../src/config.js";

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
  it("forwards only payment headers and keeps the public request path", async () => {
    const fetcher = vi.fn(async (_url, init: RequestInit) => {
      const headers = new Headers(init.headers);
      expect(headers.get("authorization")).toBe("Bearer proxy-test-value");
      expect(headers.get("PAYMENT-SIGNATURE")).toBe("signed-proof");
      expect(headers.has("cookie")).toBe(false);
      return new Response('{"access":"granted"}', { headers: {
        "PAYMENT-RESPONSE": "receipt", "set-cookie": "private", "x-private": "hidden",
      } });
    });
    vi.stubGlobal("fetch", fetcher);
    const response = await proxyHashChainRequest(new Request("https://demo.kaspa-x402.org/hash-chain/report?demo-payment=one", {
      headers: { "PAYMENT-SIGNATURE": "signed-proof", cookie: "private" },
    }), readGatewayConfig(env));
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://issuer.example.test/hash-chain/report?demo-payment=one");
    expect(response.status).toBe(200);
    expect(response.headers.get("PAYMENT-RESPONSE")).toBe("receipt");
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(response.headers.has("x-private")).toBe(false);
    expect(response.headers.get("cache-control")).toBe("no-store");
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
    const response = await proxyHashChainRequest(new Request("https://demo.kaspa-x402.org/hash-chain/report"), readGatewayConfig(env));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "hash_chain_unavailable" });
  });
});
