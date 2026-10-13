import { bytesToHex, type SupportedKind } from "@kaspa-x402/core";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { GatewayConfig } from "./config.js";

export const HASH_CHAIN_CALLER_HEADER = "X-KASPA-X402-DEMO-CALLER";

export const HASH_CHAIN_ROUTES = new Set([
  "/hash-chain", "/hash-chain/report", "/hash-chain/grant", "/hash-chain/status",
]);

/** The Node issuer stays on one host; the Worker preserves the public origin. */
export async function proxyHashChainRequest(request: Request, config: GatewayConfig): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (!config.enabled || !config.hashChainOrigin || !config.hashChainProxyToken)
    return failure("hash_chain_unavailable", 503);
  if (request.method !== (path === "/hash-chain/grant" ? "POST" : "GET"))
    return failure("method_not_allowed", 405);
  if (path !== "/hash-chain/status" && !request.headers.get("cf-connecting-ip")?.trim())
    return failure("hash_chain_unavailable", 503);
  try {
    const response = await upstream(request, config);
    const headers = new Headers({ "cache-control": "private, no-store, max-age=0", "content-type": "application/json" });
    for (const name of ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "retry-after", HASH_CHAIN_CALLER_HEADER]) {
      const value = response.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(await boundedBytes(response), { status: response.status, headers });
  } catch {
    return failure("hash_chain_unavailable", 503);
  }
}

export async function hashChainSupportedKinds(config: GatewayConfig, signal?: AbortSignal): Promise<SupportedKind[]> {
  if (!config.enabled || !config.hashChainOrigin || !config.hashChainProxyToken) return [];
  try {
    const response = await upstream(new Request("https://demo.invalid/hash-chain/supported", { signal }), config, 5_000);
    if (!response.ok) return [];
    const body = JSON.parse(new TextDecoder().decode(await boundedBytes(response))) as { kinds?: SupportedKind[] };
    return (Array.isArray(body.kinds) ? body.kinds : []).filter((kind) =>
      kind.x402Version === 2 && kind.scheme === "exact" && kind.network === "kaspa:testnet-10" &&
      kind.extra?.profile === "hash-chain-additive" && kind.extra?.binding === "kaspa-hash-chain-exact-v1");
  } catch { return []; }
}

async function upstream(request: Request, config: GatewayConfig, timeoutMs = 45_000): Promise<Response> {
  const source = new URL(request.url);
  const headers = new Headers({ authorization: `Bearer ${config.hashChainProxyToken}` });
  const ip = request.headers.get("cf-connecting-ip")?.trim();
  if (ip) {
    // Cloudflare supplies the ingress IP. Never forward a caller-supplied identity.
    const encoder = new TextEncoder();
    headers.set(HASH_CHAIN_CALLER_HEADER, bytesToHex(hmac(sha256,
      encoder.encode(config.hashChainProxyToken!), encoder.encode(`hash-chain-demo-caller:v1:${ip}`))));
  }
  for (const name of ["PAYMENT-SIGNATURE", "content-type", "content-length"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const response = await fetch(new URL(source.pathname + source.search, config.hashChainOrigin), {
    method: request.method, headers, body: request.body, redirect: "manual",
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]),
  });
  if (response.status >= 300 && response.status < 400) throw new Error("Issuer redirects are not allowed");
  return response;
}

async function boundedBytes(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 128 * 1024) throw new Error("Demo response is too large");
      parts.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

function failure(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), { status, headers: {
    "content-type": "application/json", "cache-control": "no-store",
  } });
}
