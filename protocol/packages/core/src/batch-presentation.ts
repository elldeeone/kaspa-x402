import {
  BATCH_PRESENTATION_SCOPE,
  BATCH_PRESENTATION_VERSION,
} from "./constants.js";
import { hexToBytes, sha256Hex } from "./binary.js";
import { KaspaX402Error } from "./errors.js";
import { stableStringify } from "./stable-json.js";
import type {
  BatchPresentationAuthorization,
  Hash32Hex,
} from "./types.js";

export interface BatchPresentationDigestInput {
  requestFingerprint: Hash32Hex;
  acceptedRequirementsHash: Hash32Hex;
  securityContextHash: Hash32Hex;
  channelId: Hash32Hex;
  covenantId: Hash32Hex;
  voucherDigest: Hash32Hex;
  paymentIdentifier: string | null;
  nonce: Hash32Hex;
  expiresAt: string;
}

export type BatchPresentationExpiryError =
  | "invalid_max_timeout"
  | "invalid_presentation_expiry"
  | "expired_presentation"
  | "presentation_exceeds_max_timeout";

export function batchPresentationPreimage(
  input: BatchPresentationDigestInput,
): string {
  const requestFingerprint = hash32(input.requestFingerprint, "requestFingerprint");
  const acceptedRequirementsHash = hash32(
    input.acceptedRequirementsHash,
    "acceptedRequirementsHash",
  );
  const securityContextHash = hash32(
    input.securityContextHash,
    "securityContextHash",
  );
  const channelId = hash32(input.channelId, "channelId");
  const covenantId = nonZeroHash32(input.covenantId, "covenantId");
  const voucherDigest = hash32(input.voucherDigest, "voucherDigest");
  const nonce = hash32(input.nonce, "nonce");
  if (
    input.paymentIdentifier !== null &&
    (typeof input.paymentIdentifier !== "string" ||
      input.paymentIdentifier.length === 0)
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      "paymentIdentifier must be a non-empty string or null",
    );
  }
  if (!validTimestamp(input.expiresAt)) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      "presentation expiresAt must be an ISO-8601 timestamp",
    );
  }

  return stableStringify({
    scope: BATCH_PRESENTATION_SCOPE,
    requestFingerprint,
    acceptedRequirementsHash,
    securityContextHash,
    channelId,
    covenantId,
    voucherDigest,
    paymentIdentifier: input.paymentIdentifier,
    nonce,
    expiresAt: input.expiresAt,
  });
}

export function batchPresentationDigest(
  input: BatchPresentationDigestInput,
): Hash32Hex {
  return sha256Hex(batchPresentationPreimage(input));
}

export function batchPresentationExpiryError(input: {
  maxTimeoutSeconds: number;
  expiresAt: string;
  nowMs?: number;
}): BatchPresentationExpiryError | undefined {
  if (
    !Number.isInteger(input.maxTimeoutSeconds) ||
    input.maxTimeoutSeconds <= 0
  ) {
    return "invalid_max_timeout";
  }
  const expiresAt = Date.parse(input.expiresAt);
  if (!Number.isFinite(expiresAt)) return "invalid_presentation_expiry";
  const nowMs = input.nowMs ?? Date.now();
  if (expiresAt <= nowMs) return "expired_presentation";
  if (expiresAt > nowMs + input.maxTimeoutSeconds * 1_000) {
    return "presentation_exceeds_max_timeout";
  }
  return undefined;
}

export function batchPresentationId(
  authorization: BatchPresentationAuthorization,
): Hash32Hex {
  if (authorization.version !== BATCH_PRESENTATION_VERSION) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      "unsupported batch presentation version",
    );
  }
  hash32(authorization.digest, "presentation digest");
  hexToBytes(authorization.signature, {
    expectedLength: 64,
    label: "presentation signature",
  });
  return sha256Hex(
    stableStringify({
      scope: "kaspa:x402:batch-presentation-id:v1",
      version: authorization.version,
      digest: authorization.digest.toLowerCase(),
      signature: authorization.signature.toLowerCase(),
    }),
  );
}

export function batchPresentationDigestInput(
  authorization: BatchPresentationAuthorization,
): BatchPresentationDigestInput {
  return {
    requestFingerprint: authorization.requestFingerprint,
    acceptedRequirementsHash: authorization.acceptedRequirementsHash,
    securityContextHash: authorization.securityContextHash,
    channelId: authorization.channelId,
    covenantId: authorization.covenantId,
    voucherDigest: authorization.voucherDigest,
    paymentIdentifier: authorization.paymentIdentifier,
    nonce: authorization.nonce,
    expiresAt: authorization.expiresAt,
  };
}

function hash32(value: string, label: string): string {
  hexToBytes(value, { expectedLength: 32, label });
  return value.toLowerCase();
}

function nonZeroHash32(value: string, label: string): string {
  const bytes = hexToBytes(value, { expectedLength: 32, label });
  if (bytes.every((byte) => byte === 0)) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_binding",
      `${label} must not be zero`,
    );
  }
  return value.toLowerCase();
}

function validTimestamp(value: string): boolean {
  return (
    typeof value === "string" &&
    /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/.test(
      value,
    ) &&
    Number.isFinite(Date.parse(value))
  );
}
