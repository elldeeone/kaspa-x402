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

export function previewHostFromArgs(args) {
  const index = args.indexOf("--host");
  if (index === -1) return "127.0.0.1";
  const host = args[index + 1];
  if (!host || host.startsWith("-") || /[\s/]/.test(host))
    throw new Error("--host requires an explicit hostname or IP address");
  return host;
}
