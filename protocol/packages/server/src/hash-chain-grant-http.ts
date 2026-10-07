import type { TrustedSecurityContext } from "@kaspa-x402/core";
import type { DirectModeServer } from "./direct-server.js";
import type { HashChainGrantClaim } from "./hash-chain-grants.js";
import { PublicBoundaryError } from "./public-boundary.js";

const NO_STORE = { "cache-control": "no-store", "content-type": "application/json" };
const MAX_CLAIM_BYTES = 4096;
const CLAIM_BODY_TIMEOUT_MS = 10_000;

class ClaimBodyError extends Error {
  constructor(readonly status: 408 | 413 | 499) {
    super("grant claim body rejected");
  }
}

/** Route the advertised claim URL to this handler with the same trusted server instance and host-authenticated caller. */
export async function handleHashChainGrantClaimHttp(
  server: DirectModeServer,
  request: Request,
  trustedSecurityContext: TrustedSecurityContext,
): Promise<Response> {
  if (request.method !== "POST") return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: NO_STORE });
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
    return new Response(JSON.stringify({ error: "unsupported_media_type" }), { status: 415, headers: NO_STORE });
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_CLAIM_BYTES)) {
    return new Response(JSON.stringify({ error: "claim_too_large" }), { status: 413, headers: NO_STORE });
  }
  try {
    const claim = await server.runPublicAdapter(
      "hash-chain-grant-claim-body",
      trustedSecurityContext,
      undefined,
      async (signal) => {
        const bytes = await readClaimBody(request, signal);
        const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return JSON.parse(body) as HashChainGrantClaim;
      },
      request.signal,
    );
    const grant = await server.claimHashChainGrant(
      claim,
      trustedSecurityContext,
      request.signal,
    );
    return new Response(JSON.stringify(grant), { status: 200, headers: NO_STORE });
  } catch (error) {
    const status = error instanceof PublicBoundaryError
      ? error.status
      : error instanceof ClaimBodyError
        ? error.status
        : request.signal.aborted
          ? 499
          : 409;
    // Never echo a claim, signature, grant key, or admission detail.
    return new Response(JSON.stringify({ error: "grant_claim_rejected" }), {
      status,
      headers: {
        ...NO_STORE,
        ...(error instanceof PublicBoundaryError ? { "retry-after": "1" } : {}),
      },
    });
  }
}

async function readClaimBody(
  request: Request,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) throw new ClaimBodyError(413);
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new ClaimBodyError(408)),
      CLAIM_BODY_TIMEOUT_MS,
    );
  });
  const aborted = new Promise<never>((_resolve, reject) => {
    abortHandler = () => reject(new ClaimBodyError(499));
    if (signal.aborted) abortHandler();
    else signal.addEventListener("abort", abortHandler, { once: true });
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([
        reader.read(),
        deadline,
        aborted,
      ]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CLAIM_BYTES) throw new ClaimBodyError(413);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abortHandler) signal.removeEventListener("abort", abortHandler);
    try { reader.releaseLock(); } catch { /* pending cancellation owns the reader */ }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
