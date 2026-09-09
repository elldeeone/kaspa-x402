import { sha256Hex } from "./binary.js";
import { HASH32_PATTERN } from "./constants.js";
import { KaspaX402Error } from "./errors.js";
import { assertJsonResourceBudget } from "./resource-budget.js";
import { stableStringify } from "./stable-json.js";
import type { Hash32Hex, JsonRecord } from "./types.js";

export type TrustedHandlerStateValue = string | number | boolean | null;

/**
 * Normalized, host-derived authorization claims. Values must be opaque claim
 * identifiers, never bearer tokens, cookies, passwords, or raw credentials.
 */
export interface TrustedSecurityContext {
  principal: string;
  tenant?: string;
  authorizationScopes?: readonly string[];
  handlerState?: Readonly<Record<string, TrustedHandlerStateValue>>;
}

const CREDENTIAL_FIELD =
  /(?:^|[-_])(authorization|cookie|credential|password|secret|token)(?:$|[-_])/i;

export function canonicalTrustedSecurityContext(
  context: TrustedSecurityContext,
): JsonRecord {
  assertJsonResourceBudget(context, { label: "trusted security context" });
  if (typeof context.principal !== "string" || context.principal.length === 0) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      "trusted security context principal must be a non-empty opaque identifier",
    );
  }
  if (
    context.tenant !== undefined &&
    (typeof context.tenant !== "string" || context.tenant.length === 0)
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      "trusted security context tenant must be a non-empty opaque identifier",
    );
  }

  const authorizationScopes = context.authorizationScopes
    ? [...new Set(context.authorizationScopes)].sort()
    : [];
  if (
    !authorizationScopes.every(
      (scope) => typeof scope === "string" && scope.length > 0,
    )
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      "trusted security context authorization scopes must be non-empty strings",
    );
  }

  const handlerState: Record<string, TrustedHandlerStateValue> = {};
  if (context.handlerState) {
    for (const key of Object.keys(context.handlerState).sort()) {
      if (CREDENTIAL_FIELD.test(key)) {
        throw new KaspaX402Error(
          "invalid_kaspa_x402_payload",
          `trusted security context must not contain raw credential field ${key}`,
        );
      }
      const value = context.handlerState[key];
      if (
        value !== null &&
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      ) {
        throw new KaspaX402Error(
          "invalid_kaspa_x402_payload",
          "trusted security context handler state must contain only scalar claims",
        );
      }
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new KaspaX402Error(
          "invalid_kaspa_x402_payload",
          "trusted security context handler state contains a non-finite number",
        );
      }
      handlerState[key] = value;
    }
  }

  return {
    version: "kaspa-x402-trusted-security-context-v1",
    principal: context.principal,
    tenant: context.tenant ?? null,
    authorizationScopes,
    handlerState,
  };
}

export function trustedSecurityContextHash(
  context: TrustedSecurityContext,
): Hash32Hex {
  return sha256Hex(stableStringify(canonicalTrustedSecurityContext(context)));
}

/** Preserve explicit request-hash compatibility when no trusted context exists. */
export function bindRequestHashToTrustedContext(
  requestHash: Hash32Hex,
  context?: TrustedSecurityContext,
): Hash32Hex {
  if (!HASH32_PATTERN.test(requestHash)) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      "request hash must be a 32-byte hexadecimal string",
    );
  }
  const normalized = requestHash.toLowerCase();
  if (!context) return normalized;
  return sha256Hex(
    stableStringify({
      scope: "kaspa:x402:trusted-request-context:v1",
      requestHash: normalized,
      securityContextHash: trustedSecurityContextHash(context),
    }),
  );
}
