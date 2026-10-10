import { assertJsonResourceBudget, KASPA_X402_RESOURCE_BUDGET, sha256Hex, stableStringify } from "@kaspa-x402/core";
import { assertHashChainGrantDestination } from "./hash-chain-grant-url.js";
import { readBoundedJsonResponse } from "./bounded-json-response.js";
import type {
  HashChainGrantClaimRequest,
  HashChainGrantDelivery,
} from "./types.js";

/** Signs and claims exactly the advertised, request-bound grant. The caller retains the key. */
export async function claimHashChainGrantViaHttp(
  request: HashChainGrantClaimRequest,
  signDigest: (digest: string) => Promise<string> | string,
  fetcher: typeof fetch = fetch,
): Promise<HashChainGrantDelivery> {
  const { head, network, requestHash, payerPublicKey, resourceUrl } = request;
  const controller = new AbortController();
  const onAbort = () => controller.abort(request.signal?.reason ?? new Error("grant claim aborted"));
  request.signal?.addEventListener("abort", onAbort, { once: true });
  if (request.signal?.aborted) onAbort();
  const deadline = setTimeout(() => controller.abort(new Error("grant response deadline exceeded")), 10_000);
  let readerResponse: Response | undefined;
  try {
  controller.signal.throwIfAborted();
  const claimUrl = head.grantClaimUrl;
  assertHashChainGrantDestination(
    claimUrl,
    resourceUrl,
    request.destinationPolicy,
  );
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
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
  });
  const signature = await Promise.race([Promise.resolve(signDigest(digest)), aborted]);
  if (!/^[0-9a-fA-F]{128}$/.test(signature)) throw new Error("grant payer signature must be 64-byte Schnorr hex");
  controller.signal.throwIfAborted();
  const response = await Promise.race([fetcher(claimUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify({ ...claim, signature: signature.toLowerCase() }),
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    signal: controller.signal,
  }), aborted]);
  readerResponse = response;
  if (!response.ok) throw new Error(`grant claim failed with HTTP ${response.status}`);
  if (!/\bno-store\b/i.test(response.headers.get("cache-control") ?? "")) {
    throw new Error("grant response does not prohibit caching");
  }
  const delivered = await readBoundedJsonResponse(response,
    KASPA_X402_RESOURCE_BUDGET.maxCanonicalBytes, controller.signal);
  assertJsonResourceBudget(delivered, { label: "grant response" });
  if (!isGrantDelivery(delivered)) throw new Error("grant response schema is invalid");
  return delivered;
  } catch (error) {
    controller.abort(error);
    void readerResponse?.body?.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(deadline);
    request.signal?.removeEventListener("abort", onAbort);
  }
}

function isGrantDelivery(value: unknown): value is HashChainGrantDelivery {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = ["grantId", "headVersion", "nextGuard", "oneTimePublicKey", "oneTimePrivateKey", "expiresAt"];
  const serverKeys = [...keys, "cacheControl", "deliveryCommittedAt"];
  const actual = Object.keys(record);
  const complete = actual.length === keys.length
    ? keys.every((key) => Object.hasOwn(record, key))
    : actual.length === serverKeys.length && serverKeys.every((key) => Object.hasOwn(record, key)) &&
      record.cacheControl === "no-store" && typeof record.deliveryCommittedAt === "string" &&
      !Number.isNaN(Date.parse(record.deliveryCommittedAt));
  return complete &&
    typeof record.grantId === "string" && /^[0-9a-fA-F]{64}$/.test(record.grantId) &&
    Number.isSafeInteger(record.headVersion) && Number(record.headVersion) >= 0 &&
    typeof record.nextGuard === "string" && /^[0-9a-fA-F]{64}$/.test(record.nextGuard) &&
    typeof record.oneTimePublicKey === "string" && /^[0-9a-fA-F]{64}$/.test(record.oneTimePublicKey) &&
    typeof record.oneTimePrivateKey === "string" && /^[0-9a-fA-F]{64}$/.test(record.oneTimePrivateKey) &&
    typeof record.expiresAt === "string" && !Number.isNaN(Date.parse(record.expiresAt));
}
