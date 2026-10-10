import { bytesToHex, type SupportedKind } from "@kaspa-x402/core";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { GatewayConfig, GatewayEnv } from "./config.js";
import { HASH_CHAIN_CALLER_HEADER, hashChainSupportedKinds, proxyHashChainRequest } from "./hash-chain-proxy.js";
import { GATEWAY_STATE_OBJECT_NAME } from "./remote-state.js";

const HASH_CHAIN_SUPPORTED_CACHE_TTL_MS = 5_000;
let supportedCache: {
  key: string;
  expiresAt: number;
  kinds: SupportedKind[];
} | undefined;
let supportedLookup: {
  key: string;
  promise: Promise<SupportedKind[]>;
  controller: AbortController;
  consumers: number;
  settled: boolean;
} | undefined;

export function hashChainStub(env: GatewayEnv) {
  return env.GATEWAY_STATE.get(env.GATEWAY_STATE.idFromName(GATEWAY_STATE_OBJECT_NAME));
}

export async function routeHashChainRequest(request: Request, config: GatewayConfig, env: GatewayEnv): Promise<Response> {
  if (config.hashChainOrigin) return proxyHashChainRequest(request, config);
  const path = new URL(request.url).pathname;
  if (!config.enabled || !config.hashChainEnabled || !config.adminToken ||
      (!config.boundedPnnWebSocketFactory && path !== "/hash-chain/status")) return unavailable();
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
  try { return await hashChainStub(env).fetch(new Request(request, { headers })); }
  catch { return unavailable(); }
}

export async function hostedHashChainSupportedKinds(config: GatewayConfig, env: GatewayEnv, signal?: AbortSignal): Promise<SupportedKind[]> {
  signal?.throwIfAborted();
  if (!config.enabled || (!config.hashChainOrigin && !config.hashChainEnabled)) return [];
  if (!config.hashChainOrigin && !config.boundedPnnWebSocketFactory) return [];
  const key = config.hashChainOrigin
    ? `proxy:${config.hashChainOrigin}:${config.hashChainProxyToken ?? ""}`
    : `local:${config.gatewayBaseUrl}:${config.adminToken ? "configured" : "unconfigured"}`;
  const now = Date.now();
  if (supportedCache?.key === key && supportedCache.expiresAt > now) {
    return cloneKinds(supportedCache.kinds);
  }
  if (supportedLookup?.key !== key) {
    const controller = new AbortController();
    const promise = (async () => {
      if (config.hashChainOrigin) return hashChainSupportedKinds(config, controller.signal);
      try {
        const response = await routeHashChainRequest(new Request(`${config.gatewayBaseUrl}/hash-chain/supported`, { signal: controller.signal }), config, env);
        return response.ok ? ((await response.json()) as { kinds: SupportedKind[] }).kinds : [];
      } catch { return []; }
    })().then((kinds) => {
      if (!controller.signal.aborted)
        supportedCache = { key, expiresAt: Date.now() + HASH_CHAIN_SUPPORTED_CACHE_TTL_MS, kinds: cloneKinds(kinds) };
      return kinds;
    }).finally(() => {
      if (supportedLookup?.promise === promise) {
        supportedLookup.settled = true;
        supportedLookup = undefined;
      }
    });
    supportedLookup = { key, promise, controller, consumers: 0, settled: false };
  }
  const lookup = supportedLookup;
  lookup.consumers += 1;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal?.reason ?? new Error("supported lookup aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  try {
    const kinds = await (signal ? Promise.race([lookup.promise, aborted]) : lookup.promise);
    signal?.throwIfAborted();
    return cloneKinds(kinds);
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    lookup.consumers -= 1;
    if (lookup.consumers === 0 && !lookup.settled) {
      lookup.controller.abort(new Error("supported lookup has no admitted callers"));
      if (supportedLookup === lookup) supportedLookup = undefined;
    }
  }
}

function cloneKinds(kinds: SupportedKind[]): SupportedKind[] {
  return kinds.map((kind) => structuredClone(kind));
}

function unavailable(): Response {
  return Response.json({ error: "hash_chain_unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
}
