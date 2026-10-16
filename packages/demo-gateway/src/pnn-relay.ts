import type { KaspaPnnClient } from "@kaspa-x402/adapters";

type RpcFactory = NonNullable<ConstructorParameters<typeof KaspaPnnClient>[0]["rpcFactory"]>;
const MAX_BYTES = 4_259_840;

/** The authenticated Node peer enforces WebSocket limits before delivery;
 * this side bounds its HTTP stream before JSON parsing. Never brand native WS. */
export function createRelayPnnRpcFactory(origin: string, token: string, allowLoopback: boolean): RpcFactory {
  const url = new URL(origin);
  if ((url.protocol !== "https:" && !(allowLoopback && url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new Error("PNN RPC relay requires an HTTPS origin (loopback HTTP only for local proof)");
  if (new TextEncoder().encode(token).length < 32) throw new Error("PNN RPC token requires at least 32 bytes");
  const factory: RpcFactory = (endpoint, timeoutMs) => {
    const lifetime = new AbortController();
    const sessionId = crypto.randomUUID();
    let count = 0;
    let total = 0;
    const call = async <T>(method: string, params: unknown): Promise<T> => {
      lifetime.signal.throwIfAborted();
      if (++count > 256) throw new Error("PNN RPC operation budget exceeded");
      const body = JSON.stringify({ endpoint, sessionId, method, params });
      if (new TextEncoder().encode(body).length > MAX_BYTES) throw new Error("PNN request limit exceeded");
      const response = await fetch(new URL("/rpc", url), { method: "POST", body,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        redirect: "manual", signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(timeoutMs)]),
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel(); throw new Error("PNN RPC relay unavailable");
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength; total += value.byteLength;
          if (size > MAX_BYTES || total > 16 * MAX_BYTES) throw new Error("PNN RPC response limit exceeded");
          chunks.push(value);
        }
      } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
      finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)) as T;
    };
    return {
      async connect() { await call("connect", {}); },
      async disconnect() {
        lifetime.abort();
        // A lost teardown request is bounded by the relay's idle expiry.
        try {
          const response = await fetch(new URL("/rpc", url), { method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ endpoint, sessionId, method: "disconnect", params: {} }),
            redirect: "manual", signal: AbortSignal.timeout(1000) });
          await response.body?.cancel();
        } catch { /* The session expires at the relay even if teardown is lost. */ }
      },
      getServerInfo: () => call("getServerInfo", {}),
      submitTransaction: request => call("submitTransaction", request),
      getUtxosByAddresses: addresses => call("getUtxosByAddresses", { addresses }),
      getBlockDagInfo: () => call("getBlockDagInfo", {}),
      getBlock: request => call("getBlock", request),
      getVirtualChainFromBlock: request => call("getVirtualChainFromBlock", request),
      getVirtualChainFromBlockV2: request => call("getVirtualChainFromBlockV2", request),
    };
  };
  Object.defineProperty(factory, Symbol.for("kaspa-x402:bounded-pnn-rpc:v1"), { value: true });
  return factory;
}
