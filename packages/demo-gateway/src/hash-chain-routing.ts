import { bytesToHex, type SupportedKind } from "@kaspa-x402/core";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { GatewayConfig, GatewayEnv } from "./config.js";
import { HASH_CHAIN_CALLER_HEADER, hashChainSupportedKinds, proxyHashChainRequest } from "./hash-chain-proxy.js";
import { GATEWAY_STATE_OBJECT_NAME } from "./remote-state.js";

export function hashChainStub(env: GatewayEnv) {
  return env.GATEWAY_STATE.get(env.GATEWAY_STATE.idFromName(GATEWAY_STATE_OBJECT_NAME));
}

export async function routeHashChainRequest(request: Request, config: GatewayConfig, env: GatewayEnv): Promise<Response> {
  if (config.hashChainOrigin) return proxyHashChainRequest(request, config);
  if (!config.enabled || !config.hashChainEnabled || !config.adminToken) return unavailable();
  const path = new URL(request.url).pathname;
  if (request.method !== (path === "/hash-chain/grant" ? "POST" : "GET"))
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { "cache-control": "no-store" } });
  const ip = request.headers.get("cf-connecting-ip")?.trim();
  if (!ip && path !== "/hash-chain/status" && path !== "/hash-chain/supported") return unavailable();
  const headers = new Headers(request.headers);
  headers.delete(HASH_CHAIN_CALLER_HEADER);
  headers.delete("authorization");
  headers.delete("cookie");
  headers.delete("cf-connecting-ip");
  if (ip) {
    const encoder = new TextEncoder();
    headers.set(HASH_CHAIN_CALLER_HEADER, bytesToHex(hmac(sha256,
      encoder.encode(config.adminToken), encoder.encode(`hash-chain-demo-caller:v1:${ip}`))));
  }
  try { return await hashChainStub(env).handleHashChainRequest(new Request(request, { headers })); }
  catch { return unavailable(); }
}

export async function hostedHashChainSupportedKinds(config: GatewayConfig, env: GatewayEnv): Promise<SupportedKind[]> {
  if (config.hashChainOrigin) return hashChainSupportedKinds(config);
  if (!config.enabled || !config.hashChainEnabled) return [];
  try {
    const response = await routeHashChainRequest(new Request(`${config.gatewayBaseUrl}/hash-chain/supported`), config, env);
    return response.ok ? ((await response.json()) as { kinds: SupportedKind[] }).kinds : [];
  } catch { return []; }
}

function unavailable(): Response {
  return Response.json({ error: "hash_chain_unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
}
