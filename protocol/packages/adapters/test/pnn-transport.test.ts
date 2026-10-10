import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { createNodeBoundedPnnWebSocket } from "../src/pnn-node-websocket.js";
import { JsonPnnRpc } from "../src/adapters.js";
import { KaspaPnnClient } from "../src/index.js";

const servers: WebSocketServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) =>
    server.close(() => resolve()))));
});

async function server(): Promise<{ peer: WebSocketServer; url: string }> {
  const peer = new WebSocketServer({ port: 0, perMessageDeflate: true });
  servers.push(peer);
  await new Promise<void>((resolve) => peer.once("listening", resolve));
  const address = peer.address();
  if (!address || typeof address === "string") throw new Error("missing local port");
  return { peer, url: `ws://127.0.0.1:${address.port}` };
}

describe("bounded Node PNN transport", () => {
  it("rejects an RPC factory without bounded transport authority", () => {
    expect(() => new KaspaPnnClient({ endpoints: ["wss://pnn.example.test/wrpc/json"],
      rpcFactory: () => { throw new Error("must not dial"); },
    })).toThrow(/authority|bounded/i);
  });
  it.each(["single", "fragmented"])("rejects an oversized %s message before delivery", async (kind) => {
    const { peer, url } = await server();
    let delivered = 0;
    const socket = createNodeBoundedPnnWebSocket(url, 1024);
    socket.addEventListener("message", () => { delivered += 1; });
    socket.addEventListener("error", () => undefined);
    const closed = new Promise<void>((resolve) => socket.addEventListener("close", () => resolve(), { once: true }));
    peer.on("connection", (remote) => {
      if (kind === "single") remote.send("x".repeat(1025));
      else {
        remote.send("x".repeat(600), { fin: false });
        remote.send("x".repeat(425), { fin: true });
      }
    });
    await closed;
    expect(delivered).toBe(0);
  });

  it("delivers an in-budget message", async () => {
    const { peer, url } = await server();
    const socket = createNodeBoundedPnnWebSocket(url, 1024);
    const delivered = new Promise<string>((resolve) =>
      socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true }));
    peer.on("connection", (remote) => remote.send("{\"id\":1}"));
    expect(await delivered).toBe('{"id":1}');
    socket.close();
  });

  it("completes a bounded PNN health request over the Node transport", async () => {
    const { peer, url } = await server();
    peer.on("connection", (remote) => remote.on("message", (raw) => {
      const request = JSON.parse(String(raw));
      remote.send(JSON.stringify({ id: request.id, params: {
        networkId: "testnet-10", isSynced: true, virtualDaaScore: "1000",
      } }));
    }));
    const client = new KaspaPnnClient({ endpoints: [url],
      allowInsecureLoopback: true,
      boundedWebSocketFactory: createNodeBoundedPnnWebSocket,
    });
    await expect(client.health()).resolves.toMatchObject({
      networkId: "testnet-10", virtualDaaScore: "1000",
    });
  });

  it("reads a selected hash-chain payment and confirms it over a bounded socket", async () => {
    const { peer, url } = await server();
    const sink = "ee".repeat(32);
    const from = "11".repeat(32);
    const accepting = "aa".repeat(32);
    const parent = "dd".repeat(32);
    const txid = "bb".repeat(32);
    const covenantId = "cc".repeat(32);
    const transaction = { transactionId: txid,
      inputs: [{ previousOutpoint: { transactionId: from, index: 0 } }],
      outputs: [{ value: "120000000", scriptPublicKey: { version: 0,
        script: `20${"44".repeat(32)}` },
        covenant: { covenantId, authorizingInput: 0 } }],
    };
    peer.on("connection", (remote) => remote.on("message", (raw) => {
      const request = JSON.parse(String(raw));
      const params = request.params as { hash?: string };
      const response = request.method === "getServerInfo"
        ? { networkId: "testnet-10", isSynced: true }
        : request.method === "getBlockDagInfo" ? { sink }
        : request.method === "getUtxosByAddresses" ? { entries: [] }
        : request.method === "getBlock" ? { block: {
            header: { hash: params.hash, blueScore: params.hash === accepting ? "970" : "1000",
              daaScore: params.hash === accepting ? "970" : "1000" },
            verboseData: { hash: params.hash, isChainBlock: true, selectedParentHash: parent },
          } }
        : request.method === "getVirtualChainFromBlock" ? {
            removedChainBlockHashes: [], addedChainBlockHashes: [accepting],
            acceptedTransactionIds: [{ acceptingBlockHash: accepting, acceptedTransactionIds: [txid] }],
          }
        : request.method === "getVirtualChainFromBlockV2" ? {
            removedChainBlockHashes: [], addedChainBlockHashes: [accepting],
            chainBlockAcceptedTransactions: [{ chainBlockHeader: {
              hash: accepting, blueScore: "970", daaScore: "970",
            }, acceptedTransactions: [transaction] }],
          }
        : undefined;
      remote.send(JSON.stringify({ id: request.id, params: response }));
    }));
    const client = new KaspaPnnClient({ endpoints: [url],
      allowInsecureLoopback: true,
      boundedWebSocketFactory: createNodeBoundedPnnWebSocket,
    });
    const snapshot = await client.snapshotHashChainUtxos([]);
    expect(snapshot.checkpoint.blockHash).toBe(sink);
    const payment = await client.findHashChainPayment(txid, {
      blockHash: from, blueScore: "900", daaScore: "900",
    });
    expect(payment?.transaction).toMatchObject({ transactionId: txid,
      successor: { amount: "120000000", covenantId } });
    const confirmed = await client.confirmAcceptedTransaction(payment!.evidence, 1);
    expect(confirmed).toMatchObject({ status: "accepted", transactionId: txid,
      confirmationCount: 1, checkpoint: { blockHash: sink } });
  });

  it("closes a connection flooded with unsolicited RPC messages", async () => {
    const { peer, url } = await server();
    let closed = false;
    peer.on("connection", (remote) => {
      remote.on("close", () => { closed = true; });
      remote.on("message", () => {
        for (let id = 100; id < 105; id += 1)
          remote.send(JSON.stringify({ id, params: {} }));
      });
    });
    const client = new KaspaPnnClient({ endpoints: [url], timeoutMs: 500,
      allowInsecureLoopback: true,
      boundedWebSocketFactory: createNodeBoundedPnnWebSocket,
    });
    await expect(client.health()).rejects.toThrow(/unsolicited|failed/i);
    await vi.waitFor(() => expect(closed).toBe(true));
  });

  it("closes a real connection after the cumulative message budget is spent", async () => {
    const { peer, url } = await server();
    let closed = false;
    peer.on("connection", (remote) => {
      remote.on("close", () => { closed = true; });
      remote.on("message", (raw) => {
        const request = JSON.parse(String(raw));
        remote.send(JSON.stringify({ id: request.id, params: {
          networkId: "testnet-10", isSynced: true,
        } }));
      });
    });
    const rpc = new JsonPnnRpc(url, 1_000, createNodeBoundedPnnWebSocket);
    await rpc.connect();
    try {
      for (let index = 0; index < 256; index++)
        await expect(rpc.getServerInfo()).resolves.toMatchObject({ networkId: "testnet-10" });
      await expect(rpc.getServerInfo()).rejects.toThrow(/connection limit/i);
      await vi.waitFor(() => expect(closed).toBe(true));
    } finally {
      await rpc.disconnect();
    }
  });
});
