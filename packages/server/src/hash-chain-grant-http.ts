import type { DirectModeServer } from "./direct-server.js";
import type { HashChainGrantClaim } from "./hash-chain-grants.js";

const NO_STORE = { "cache-control": "no-store", "content-type": "application/json" };

/** Route the advertised claim URL to this handler with the same trusted server instance. */
export async function handleHashChainGrantClaimHttp(server: DirectModeServer, request: Request): Promise<Response> {
  if (request.method !== "POST") return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: NO_STORE });
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
    return new Response(JSON.stringify({ error: "unsupported_media_type" }), { status: 415, headers: NO_STORE });
  }
  if (Number(request.headers.get("content-length")) > 4096) {
    return new Response(JSON.stringify({ error: "claim_too_large" }), { status: 413, headers: NO_STORE });
  }
  try {
    const reader = request.body?.getReader();
    if (!reader) return new Response(JSON.stringify({ error: "grant_claim_rejected" }), { status: 409, headers: NO_STORE });
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) {
        await reader.cancel();
        return new Response(JSON.stringify({ error: "claim_too_large" }), { status: 413, headers: NO_STORE });
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const claim = JSON.parse(body) as HashChainGrantClaim;
    const grant = await server.claimHashChainGrant(claim);
    return new Response(JSON.stringify(grant), { status: 200, headers: NO_STORE });
  } catch {
    // Never echo a claim, signature, grant key, or admission detail.
    return new Response(JSON.stringify({ error: "grant_claim_rejected" }), { status: 409, headers: NO_STORE });
  }
}
