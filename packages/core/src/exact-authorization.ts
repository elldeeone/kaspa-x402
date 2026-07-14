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
  return sha256Hex(
    stableStringify({
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
    }),
  );
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
