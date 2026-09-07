import { createServer, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KaspaPnnClient, KaspaRestClient, RestExactSettlementReconciler } from "../src/adapters.js";
import type { ExactSettlementAttemptRecord } from "@kaspa-x402/server";

const txid = "11".repeat(32);
const attempt: ExactSettlementAttemptRecord = {
  transactionId: txid, profile: "standard-native", amount: "100", paymentOutputIndex: 0,
  requestFingerprint: "22".repeat(32), paymentRequirementsHash: "33".repeat(32),
  paymentPayloadHash: "44".repeat(32), requestAuthorizationId: "55".repeat(32),
  payToScriptPublicKey: "000051", transaction: "stored artifact", requiredFinality: "accepted",
  status: "broadcast", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};
const accepted = { transaction_id: txid, is_accepted: true, outputs: [{ index: 0, amount: "100", script_public_key: "51" }] };
let respond: (res: ServerResponse) => void;
let baseUrl: string;
const server = createServer((_req, res) => respond(res));
beforeEach(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing listener");
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
function json(body: unknown) { respond = (res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); }; }
function client() { return new KaspaRestClient(baseUrl, { timeoutMs: 40 }); }

describe("real HTTP REST fault boundary", () => {
  it.each(["false", "true", 1, {}, []])("rejects nonboolean acceptance %j before reconciliation", async (flag) => {
    json({ ...accepted, is_accepted: flag });
    await expect(new RestExactSettlementReconciler(client()).reconcileExactSettlement(attempt)).rejects.toThrow();
  });
  it.each([undefined, -1, "NaN", "18446744073709551616", 9007199254740992])("rejects malformed DAA score %j", async (score) => {
    json({ networkName: "kaspa-testnet-10", virtualDaaScore: score });
    await expect(client().health()).rejects.toThrow();
  });
  it.each(["{", "null", '"hello"', ""]) ("rejects malformed transaction JSON %j", async (body) => {
    respond = (res) => res.end(body);
    await expect(client().getTransaction(txid)).rejects.toThrow();
  });
  it("rejects an unrelated transaction returned for the requested ID", async () => {
    json({ ...accepted, transaction_id: "22".repeat(32) });
    await expect(client().getTransaction(txid)).rejects.toThrow();
  });
  it.each([undefined, -1, "NaN", "18446744073709551616", 9007199254740992])("rejects malformed UTXO amount %j", async (amount) => {
    json([{ outpoint: { transactionId: txid, index: 0 }, utxoEntry: { amount, scriptPublicKey: { scriptPublicKey: "51" } } }]);
    await expect(client().getUtxosForAddress("kaspatest:test")).rejects.toThrow();
  });
  it.each(["garbage", -1, 4294967296, 0.5])("rejects malformed UTXO index %j", async (index) => {
    json([{ outpoint: { transactionId: txid, index }, utxoEntry: { amount: "100", scriptPublicKey: { scriptPublicKey: "51" } } }]);
    await expect(client().getUtxosForAddress("kaspatest:test")).rejects.toThrow();
  });
  it("rejects accepted output evidence missing the output script", async () => {
    json({ ...accepted, outputs: [{ index: 0, amount: "100" }] });
    await expect(client().getTransaction(txid)).rejects.toThrow();
  });
  it.each([
    { outputs: {} },
    { outputs: [null] },
    { outputs: [{ index: 0, amount: "100", script_public_key: "51" }, { index: 0, amount: "100", script_public_key: "51" }] },
    { outputs: [{ index: -1, amount: "100", script_public_key: "51" }] },
    { outputs: [{ index: 0, amount: "NaN", script_public_key: "51" }] },
    { outputs: [{ index: 0, amount: "100", script_public_key: "garbage" }] },
    { is_accepted: undefined },
    { transaction_id: undefined },
  ])("rejects malformed accepted transaction fields %j", async (fields) => {
    json({ ...accepted, ...fields });
    await expect(client().getTransaction(txid)).rejects.toThrow();
  });
  it("enforces the default 512 KiB REST response ceiling at its exact byte boundary", async () => {
    const body = JSON.stringify(accepted);
    respond = (res) => res.end(body + " ".repeat(512 * 1024 - body.length));
    expect((await client().getTransaction(txid))?.is_accepted).toBe(true);
    respond = (res) => res.end(body + " ".repeat(512 * 1024 + 1 - body.length));
    await expect(client().getTransaction(txid)).rejects.toThrow("exceeds 524288 bytes");
  });
  it.each([429, 500, 503])("fails closed on HTTP %i", async (status) => {
    respond = (res) => { res.statusCode = status; res.end('{}'); };
    await expect(client().getTransaction(txid)).rejects.toThrow(`${status}`);
  });
  it("distinguishes a missing transaction from acceptance", async () => {
    respond = (res) => { res.statusCode = 404; res.end(); };
    expect((await new RestExactSettlementReconciler(client()).reconcileExactSettlement(attempt)).status).toBe("unknown");
  });
  it("aborts a server that never sends response headers", async () => {
    respond = () => {};
    await expect(client().health()).rejects.toThrow();
  });
  it("aborts a stalled body after headers arrive", async () => {
    respond = (res) => { res.writeHead(200); res.write('{'); };
    await expect(client().health()).rejects.toThrow();
  });
  it("rejects a truncated Content-Length response", async () => {
    respond = (res) => { res.setHeader("content-length", "100"); res.end("{}"); };
    await expect(client().getTransaction(txid)).rejects.toThrow();
  });
  it("rejects chunked oversize responses without Content-Length", async () => {
    respond = (res) => { res.write(" ".repeat(64)); res.end("{}"); };
    await expect(new KaspaRestClient(baseUrl, { maxResponseBytes: 32 }).getTransaction(txid)).rejects.toThrow("exceeds 32 bytes");
  });
  it("recovers on a subsequent healthy request after an outage", async () => {
    respond = (res) => { res.statusCode = 503; res.end(); };
    const rest = client();
    await expect(rest.health()).rejects.toThrow();
    json({ networkName: "kaspa-testnet-10", virtualDaaScore: "123" });
    expect((await rest.health()).virtualDaaScore).toBe("123");
  });
  it("accepts valid transaction evidence and preserves false as unknown", async () => {
    json(accepted);
    expect((await new RestExactSettlementReconciler(client()).reconcileExactSettlement(attempt)).status).toBe("accepted");
    json({ ...accepted, is_accepted: false });
    expect((await new RestExactSettlementReconciler(client()).reconcileExactSettlement(attempt)).status).toBe("unknown");
  });
});

describe("PNN transport outage and failover", () => {
  it.each([
    { networkId: "mainnet", isSynced: true },
    { networkId: "testnet-11", isSynced: true },
    { isSynced: true },
    { networkId: "testnet-10", isSynced: false },
  ])("rejects wrong-network or unsynced endpoint %j", async (info) => {
    let disconnected = false;
    const pnn = new KaspaPnnClient({ endpoints: ["wss://untrusted.example.test"], timeoutMs: 5,
      rpcFactory: () => ({ connect: async () => {}, disconnect: async () => { disconnected = true; },
        getServerInfo: async () => info, submitTransaction: async () => ({}), getUtxosByAddresses: async () => ({ entries: [] }),
      }),
    });
    await expect(pnn.health()).rejects.toThrow();
    expect(disconnected).toBe(true);
  });
  it.each(["connect", "getServerInfo"])("times out stalled %s and disconnects before healthy failover", async (stalled) => {
    const disconnected: string[] = [];
    const pnn = new KaspaPnnClient({ endpoints: ["wss://stalled.example.test", "wss://healthy.example.test"], timeoutMs: 5,
      rpcFactory: (endpoint) => ({
        connect: () => endpoint.includes("stalled") && stalled === "connect" ? new Promise(() => {}) : Promise.resolve(),
        disconnect: async () => { disconnected.push(endpoint); },
        getServerInfo: () => endpoint.includes("stalled") && stalled === "getServerInfo" ? new Promise(() => {}) : Promise.resolve({ networkId: "testnet-10", isSynced: true, virtualDaaScore: "123" }),
        submitTransaction: async () => ({}), getUtxosByAddresses: async () => ({ entries: [] }),
      }),
    });
    expect((await pnn.health()).endpoint).toContain("healthy.example.test");
    expect(disconnected).toEqual(["wss://stalled.example.test", "wss://healthy.example.test"]);
  });
});
