import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { createNodeBoundedFetch } from "../src/node-bounded-fetch.js";

describe("Node paid fetch dial boundary", () => {
  it.each(["https://127.0.0.1", "https://[::1]", "https://localhost"])(
    "rejects a literal or local policy origin %s", (origin) => {
      expect(() => createNodeBoundedFetch({ allowedOrigins: [origin] })).toThrow();
    });
  it.each(["127.0.0.1", "169.254.169.254", "192.31.196.1", "::1"])(
    "rejects a DNS answer to %s in the connector before opening a socket", async (resolved) => {
    let connections = 0;
    const server = createServer((socket) => { connections += 1; socket.destroy(); });
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing port");
    const origin = `https://api.example.test:${address.port}`;
    const transport = createNodeBoundedFetch({ allowedOrigins: [origin],
      lookup: async () => [{ address: resolved, family: resolved.includes(":") ? 6 : 4 }] });
    try {
      await expect(transport.fetch(`${origin}/paid`, { redirect: "error" }))
        .rejects.toThrow();
      expect(connections).toBe(0);
    } finally {
      await transport.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
