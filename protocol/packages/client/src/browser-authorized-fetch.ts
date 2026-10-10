import type { FetchLike } from "./types.js";
import { BROWSER_FETCH_AUTHORITY } from "./bound-fetch-authority.js";

/** Browser fetch for explicitly approved HTTPS origins and exact response URLs. */
export function createBrowserAuthorizedFetch(options: {
  allowedOrigins: readonly string[];
}): FetchLike {
  const browser = globalThis as typeof globalThis & {
    window?: unknown;
    location?: { href?: string; protocol?: string };
  };
  const pageUrl = browser.location?.href;
  if (browser.window !== globalThis || !pageUrl ||
      browser.location?.protocol !== "https:")
    throw new Error("browser authorized fetch requires an HTTPS browser page");
  const allowed = new Set(options.allowedOrigins.map((origin) => {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.username || url.password || url.hash ||
        url.search || url.pathname !== "/" || origin.replace(/\/$/, "") !== url.origin)
      throw new Error("browser authorized fetch requires canonical HTTPS origins");
    assertPublicHostname(url);
    return url.origin;
  }));
  if (allowed.size === 0 || allowed.size > 64)
    throw new Error("browser authorized fetch requires 1 to 64 approved origins");

  const nativeFetch = browser.fetch.bind(globalThis);
  const authorized: FetchLike = async (input, init = {}) => {
    const url = new URL(input, pageUrl);
    if (!allowed.has(url.origin) || url.protocol !== "https:" ||
        url.username || url.password || url.hash)
      throw new Error("browser fetch destination is not approved");
    assertPublicHostname(url);
    const requestInit = {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: init.signal,
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      mode: "cors",
      referrerPolicy: "no-referrer",
    } as unknown as RequestInit;
    const response = await nativeFetch(url.href, requestInit);
    if (response.redirected || response.url !== url.href)
      throw new Error("browser fetch response URL differs from the approved request");
    return response;
  };
  Object.defineProperty(authorized, BROWSER_FETCH_AUTHORITY, { value: true });
  return authorized;
}

function assertPublicHostname(url: URL): void {
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") || hostname.endsWith(".internal") ||
      hostname.startsWith("[") || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname))
    throw new Error("browser fetch destination must use a public DNS name");
}
