import { sha256Hex, stableStringify } from "@kaspa-x402/core";
import type { HashChainGrantClaimRequest, HashChainGrantDelivery } from "./types.js";

/** Signs and claims exactly the advertised, request-bound grant. The caller retains the key. */
export async function claimHashChainGrantViaHttp(
  request: HashChainGrantClaimRequest,
  signDigest: (digest: string) => Promise<string> | string,
  fetcher: typeof fetch = fetch,
): Promise<HashChainGrantDelivery> {
  const { head, network, requestHash, payerPublicKey } = request;
  const url = new URL(head.grantClaimUrl);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.username || url.password || url.hash ||
    (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))) {
    throw new Error("grant claim URL must use HTTPS or loopback HTTP");
  }
  const claim = {
    grantId: head.grantId,
    challengeId: head.challengeId,
    requestHash,
    payerPublicKey: payerPublicKey.toLowerCase(),
    expiresAt: head.challengeExpiresAt,
  };
  const digest = sha256Hex(stableStringify({
    scope: "kaspa-x402-hash-chain-grant-claim-v1",
    network,
    binding: "kaspa-hash-chain-exact-v1",
    ...claim,
  }));
  const signature = await signDigest(digest);
  if (!/^[0-9a-fA-F]{128}$/.test(signature)) throw new Error("grant payer signature must be 64-byte Schnorr hex");
  const response = await fetcher(head.grantClaimUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify({ ...claim, signature: signature.toLowerCase() }),
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
  });
  if (!response.ok) throw new Error(`grant claim failed with HTTP ${response.status}`);
  if (!/\bno-store\b/i.test(response.headers.get("cache-control") ?? "")) {
    throw new Error("grant response does not prohibit caching");
  }
  const delivered: unknown = await response.json();
  if (!delivered || typeof delivered !== "object" || Array.isArray(delivered)) throw new Error("grant response is invalid");
  return delivered as HashChainGrantDelivery;
}
