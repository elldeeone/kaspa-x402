import { sha256Hex } from "./binary.js";
import { stableStringify } from "./stable-json.js";
import type {
  ExactProfile,
  ExactRequestAuthorization,
  Hash32Hex,
  NetworkId,
  SompiString,
} from "./types.js";

export const EXACT_REQUEST_AUTHORIZATION_VERSION =
  "kaspa-x402-exact-request-authorization-v1" as const;

export interface ExactRequestAuthorizationDigestInput {
  network: NetworkId;
  profile: ExactProfile;
  transactionId: Hash32Hex;
  paymentOutputIndex: number;
  amount: SompiString;
  payTo: string;
  payToScriptPublicKey: string;
  paymentRequirementsHash: Hash32Hex;
  requestHash: Hash32Hex;
  challengeId?: Hash32Hex;
  inputIndex: number;
  expiresAt: string;
}

export type ExactAuthorizationExpiryError =
  | "invalid_max_timeout"
  | "invalid_authorization_expiry"
  | "expired_authorization"
  | "authorization_exceeds_max_timeout"
  | "invalid_challenge_expiry"
  | "expired_challenge"
  | "authorization_exceeds_challenge";

export interface ExactAuthorizationExpiryInput {
  maxTimeoutSeconds: number;
  authorizationExpiresAt: string;
  challengeExpiresAt?: string;
  nowMs?: number;
}

/**
 * Canonical payer-authorized intent for one exact Kaspa transaction.
 *
 * The signature is deliberately outside the Kaspa transaction: the on-chain
 * signature authorizes value transfer, while this digest authorizes the x402
 * request audience and accepted terms for that already-signed transaction.
 */
export function exactRequestAuthorizationDigest(
  input: ExactRequestAuthorizationDigestInput,
): Hash32Hex {
  return sha256Hex(exactRequestAuthorizationPreimage(input));
}

/** UTF-8 JSON bytes hashed by {@link exactRequestAuthorizationDigest}. */
export function exactRequestAuthorizationPreimage(
  input: ExactRequestAuthorizationDigestInput,
): string {
  return stableStringify({
    scope: EXACT_REQUEST_AUTHORIZATION_VERSION,
    network: input.network,
    profile: input.profile,
    transactionId: input.transactionId.toLowerCase(),
    paymentOutputIndex: input.paymentOutputIndex,
    amount: input.amount,
    payTo: input.payTo,
    payToScriptPublicKey: input.payToScriptPublicKey.toLowerCase(),
    paymentRequirementsHash: input.paymentRequirementsHash.toLowerCase(),
    requestHash: input.requestHash.toLowerCase(),
    challengeId: input.challengeId?.toLowerCase() ?? null,
    inputIndex: input.inputIndex,
    expiresAt: input.expiresAt,
  });
}

/**
 * Selects the payer authorization deadline. Additive authorization cannot
 * outlive the server-issued head challenge on which it depends.
 */
export function exactAuthorizationExpiresAt(
  maxTimeoutSeconds: number,
  challengeExpiresAt?: string,
  nowMs = Date.now(),
): string {
  if (!Number.isInteger(maxTimeoutSeconds) || maxTimeoutSeconds <= 0) {
    throw new RangeError("maxTimeoutSeconds must be a positive integer");
  }
  const timeoutExpiresAt = nowMs + maxTimeoutSeconds * 1_000;
  if (challengeExpiresAt === undefined) {
    return new Date(timeoutExpiresAt).toISOString();
  }
  const challenge = Date.parse(challengeExpiresAt);
  if (!Number.isFinite(challenge) || challenge <= nowMs) {
    throw new RangeError("challengeExpiresAt must be a future timestamp");
  }
  return new Date(Math.min(timeoutExpiresAt, challenge)).toISOString();
}

/** Pure verifier for the exact authorization and additive challenge ordering. */
export function exactAuthorizationExpiryError(
  input: ExactAuthorizationExpiryInput,
): ExactAuthorizationExpiryError | undefined {
  const nowMs = input.nowMs ?? Date.now();
  if (
    !Number.isInteger(input.maxTimeoutSeconds) ||
    input.maxTimeoutSeconds <= 0
  ) {
    return "invalid_max_timeout";
  }
  const authorization = Date.parse(input.authorizationExpiresAt);
  if (!Number.isFinite(authorization)) return "invalid_authorization_expiry";
  if (authorization <= nowMs) return "expired_authorization";
  if (authorization > nowMs + input.maxTimeoutSeconds * 1_000) {
    return "authorization_exceeds_max_timeout";
  }
  if (input.challengeExpiresAt === undefined) return undefined;
  const challenge = Date.parse(input.challengeExpiresAt);
  if (!Number.isFinite(challenge)) return "invalid_challenge_expiry";
  if (challenge <= nowMs) return "expired_challenge";
  if (authorization > challenge) return "authorization_exceeds_challenge";
  return undefined;
}

export function exactRequestAuthorizationId(
  authorization: ExactRequestAuthorization,
): Hash32Hex {
  return sha256Hex(
    stableStringify({
      scope: "kaspa:x402:exact-request-authorization-id:v1",
      version: authorization.version,
      digest: authorization.digest.toLowerCase(),
      inputIndex: authorization.inputIndex,
      expiresAt: authorization.expiresAt,
      signature: authorization.signature.toLowerCase(),
    }),
  );
}
