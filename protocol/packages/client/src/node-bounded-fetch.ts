import { lookup as systemLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import type { FetchLike, HttpResponseLike } from "./types.js";
import { BOUND_FETCH_AUTHORITY } from "./bound-fetch-authority.js";

type Resolver = (hostname: string) => Promise<LookupAddress[]>;

/** Resolve inside Undici's actual connector; every returned address must be public. */
export function createNodeBoundedFetch(options: {
  allowedOrigins: readonly string[];
  lookup?: Resolver;
}): { fetch: FetchLike; close(): Promise<void> } {
  const allowed = new Set(options.allowedOrigins.map((origin) => {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.username || url.password || url.hash ||
        url.search || url.pathname !== "/" || origin.replace(/\/$/, "") !== url.origin)
      throw new Error("bounded fetch requires canonical HTTPS origins");
    assertPublicHostname(url);
    return url.origin;
  }));
  if (allowed.size === 0 || allowed.size > 64)
    throw new Error("bounded fetch requires 1 to 64 approved origins");
  const resolve = options.lookup ?? ((hostname: string) =>
    systemLookup(hostname, { all: true }));
  const lookup: LookupFunction = (hostname, requestOptions, callback) => {
    void resolve(hostname).then((addresses) => {
      if (!addresses.length || addresses.some((entry) => !publicIpv4(entry)))
        throw new Error("bounded fetch DNS answer contains a private or reserved address");
      if (requestOptions.all) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    }).catch((error: unknown) => callback(error as NodeJS.ErrnoException, ""));
  };
  const agent = new Agent({ connect: { lookup, timeout: 10_000 },
    connections: 4, pipelining: 1 });
  const boundedFetch: FetchLike = async (input, init = {}) => {
    const url = new URL(input);
    if (!allowed.has(url.origin) || url.protocol !== "https:" ||
        url.username || url.password || url.hash)
      throw new Error("bounded fetch destination is not approved");
    assertPublicHostname(url);
    const requestInit = { ...init, redirect: "error", cache: "no-store",
      dispatcher: agent } as unknown as Parameters<typeof undiciFetch>[1];
    return undiciFetch(url.href, requestInit) as unknown as Promise<HttpResponseLike>;
  };
  Object.defineProperty(boundedFetch, BOUND_FETCH_AUTHORITY, { value: true });
  return { fetch: boundedFetch, close: () => agent.close() };
}

function assertPublicHostname(url: URL): void {
  const hostname = url.hostname.toLowerCase();
  if (isIP(hostname.replace(/^\[|\]$/g, "")) || hostname === "localhost" ||
      hostname.endsWith(".localhost") || hostname.endsWith(".local") ||
      hostname.endsWith(".internal"))
    throw new Error("bounded fetch destination must use a public DNS name");
}

function publicIpv4(entry: LookupAddress): boolean {
  // Conservative IPv4 special-purpose exclusions: IANA IPv4 Special-Purpose Address Space.
  if (entry.family !== 4) return false; // IPv6 and mapped forms fail closed.
  const parts = entry.address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return false;
  const [a, b, c] = parts as [number, number, number, number];
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168 ||
      (b === 31 && c === 196) || (b === 52 && c === 193) ||
      (b === 88 && c === 99) || (b === 175 && c === 48))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}
