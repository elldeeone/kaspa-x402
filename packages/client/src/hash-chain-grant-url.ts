import { KaspaX402Error } from "@kaspa-x402/core";
import type { HashChainGrantDestinationPolicy } from "./types.js";

/** Validates the same-origin claim endpoint against a dedicated outbound allowlist. */
export function assertHashChainGrantDestination(
  claimUrl: string,
  resourceUrl: string,
  policy?: HashChainGrantDestinationPolicy,
): void {
  let claim: URL;
  let resource: URL;
  try {
    claim = new URL(claimUrl);
    resource = new URL(resourceUrl);
  } catch {
    throw invalidDestination("hash-chain grant URL or resource URL is invalid");
  }
  if (
    claim.origin !== resource.origin ||
    claim.username ||
    claim.password ||
    claim.hash
  ) {
    throw invalidDestination(
      "hash-chain grant URL must be a credential-free same-origin endpoint",
    );
  }

  const allowedOrigins = policy?.allowedOrigins;
  if (!allowedOrigins || allowedOrigins.length === 0) {
    throw invalidDestination(
      "hash-chain grant destination requires a non-empty explicit origin allowlist",
    );
  }
  if (allowedOrigins.length > 64) {
    throw invalidDestination("hash-chain grant origin allowlist is too large");
  }
  const allowed = allowedOrigins.some(
    (origin) => canonicalAllowlistedOrigin(origin) === claim.origin,
  );
  if (!allowed) {
    throw invalidDestination(
      "hash-chain grant destination is not explicitly allowlisted",
    );
  }
  const loopbackHttp =
    claim.protocol === "http:" && isLoopbackHostname(claim.hostname);
  if (claim.protocol !== "https:" && !loopbackHttp) {
    throw invalidDestination(
      "hash-chain grant URL must use HTTPS except for an explicitly allowlisted loopback origin",
    );
  }
}

function invalidDestination(message: string): KaspaX402Error {
  return new KaspaX402Error("invalid_kaspa_x402_payload", message);
}

function canonicalAllowlistedOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      url.pathname !== "/" ||
      value.replace(/\/$/, "") !== url.origin
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function isLoopbackHostname(value: string): boolean {
  const hostname = stripIpv6Brackets(value).replace(/\.$/, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname === "::1") return true;
  const parts = hostname.split(".").map(Number);
  return parts.length === 4 && parts.every(Number.isInteger) && parts[0] === 127;
}

function stripIpv6Brackets(value: string): string {
  return value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1)
    : value;
}
