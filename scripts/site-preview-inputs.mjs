export function parsePreviewRequestUrl(requestUrl, host) {
  try {
    return new URL(requestUrl || "/", `http://${host || "localhost"}`);
  } catch {
    return undefined;
  }
}

export function decodePreviewPathname(pathname) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
}
