import { sha256Hex } from "./binary.js";
import { KaspaX402Error } from "./errors.js";
import { stableStringify } from "./stable-json.js";
import type {
  BatchRequestAuthorization,
  Hash32Hex,
  NetworkId,
  SompiString,
} from "./types.js";

export const BATCH_REQUEST_AUTHORIZATION_VERSION =
  "kaspa-x402-batch-request-authorization-v1" as const;

export interface BatchRequestAuthorizationDigestInput {
  network: NetworkId;
  channelId: Hash32Hex;
  covenantId: Hash32Hex;
  amount: SompiString;
  paymentRequirementsHash: Hash32Hex;
  requestHash: Hash32Hex;
  audience: string;
  expiresAt: string;
  nonce: Hash32Hex;
}

export function batchRequestAuthorizationDigest(
  input: BatchRequestAuthorizationDigestInput,
): Hash32Hex {
  return sha256Hex(batchRequestAuthorizationPreimage(input));
}

export function batchRequestAuthorizationPreimage(
  input: BatchRequestAuthorizationDigestInput,
): string {
  return stableStringify({
    scope: BATCH_REQUEST_AUTHORIZATION_VERSION,
    network: input.network,
    channelId: canonicalHash(input.channelId, "channelId"),
    covenantId: canonicalHash(input.covenantId, "covenantId"),
    amount: input.amount,
    paymentRequirementsHash: canonicalHash(
      input.paymentRequirementsHash,
      "paymentRequirementsHash",
    ),
    requestHash: canonicalHash(input.requestHash, "requestHash"),
    audience: canonicalAudience(input.audience),
    expiresAt: input.expiresAt,
    nonce: canonicalHash(input.nonce, "nonce"),
  });
}

export function batchAuthorizationExpiresAt(
  maxTimeoutSeconds: number,
  nowMs = Date.now(),
): string {
  if (!Number.isInteger(maxTimeoutSeconds) || maxTimeoutSeconds <= 0) {
    throw new RangeError("maxTimeoutSeconds must be a positive integer");
  }
  return new Date(nowMs + maxTimeoutSeconds * 1_000).toISOString();
}

export function assertBatchAuthorizationExpiry(input: {
  expiresAt: string;
  maxTimeoutSeconds: number;
  nowMs?: number;
}): void {
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isInteger(input.maxTimeoutSeconds) || input.maxTimeoutSeconds <= 0)
    throw invalidAuthorization("batch request authorization timeout is invalid");
  const expiresAt = Date.parse(input.expiresAt);
  if (!Number.isFinite(expiresAt))
    throw invalidAuthorization("batch request authorization expiry is invalid");
  if (expiresAt <= nowMs)
    throw invalidAuthorization("batch request authorization has expired");
  if (expiresAt > nowMs + input.maxTimeoutSeconds * 1_000)
    throw invalidAuthorization(
      "batch request authorization exceeds the accepted timeout",
    );
}

export function batchRequestAuthorizationId(
  authorization: BatchRequestAuthorization,
): Hash32Hex {
  return sha256Hex(
    stableStringify({
      scope: "kaspa:x402:batch-request-authorization-id:v1",
      version: authorization.version,
      digest: canonicalHash(authorization.digest, "digest"),
      expiresAt: authorization.expiresAt,
      nonce: canonicalHash(authorization.nonce, "nonce"),
      signature: authorization.signature.toLowerCase(),
    }),
  );
}

function canonicalHash(value: string, label: string): Hash32Hex {
  if (!/^[0-9a-fA-F]{64}$/.test(value))
    throw invalidAuthorization(`${label} must be 32-byte hex`);
  return value.toLowerCase();
}

function canonicalAudience(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    throw invalidAuthorization("batch request authorization audience is invalid");
  }
}

function invalidAuthorization(message: string): KaspaX402Error {
  return new KaspaX402Error("invalid_kaspa_signature", message);
}
