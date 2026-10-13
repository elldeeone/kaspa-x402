/** The only cleartext exception is an explicit development connection to a literal loopback IP. */
export function trustedNodeUrl(
  input: string,
  kind: "rest" | "pnn",
  allowInsecureLoopback = false,
): URL {
  let url: URL;
  try { url = new URL(input); }
  catch { throw new Error(`Kaspa ${kind} endpoint is not a URL`); }
  const secure = kind === "rest" ? "https:" : "wss:";
  const insecure = kind === "rest" ? "http:" : "ws:";
  const hostname = url.hostname.toLowerCase();
  const literalLoopback = hostname === "127.0.0.1" || hostname === "[::1]";
  if (url.protocol !== secure &&
      !(url.protocol === insecure && allowInsecureLoopback && literalLoopback))
    throw new Error(`Kaspa ${kind} endpoint must use ${secure} except explicit literal-loopback development`);
  if (url.username || url.password || url.hash)
    throw new Error(`Kaspa ${kind} endpoint must not contain credentials or fragments`);
  return url;
}
