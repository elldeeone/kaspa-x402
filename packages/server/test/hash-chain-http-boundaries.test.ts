import { describe, expect, it } from "vitest";
import { handleHashChainGrantClaimHttp } from "../src/hash-chain-grant-http.js";
import { HashChainRestView } from "../src/hash-chain-rest-view.js";
import type { DirectModeServer } from "../src/direct-server.js";
import { PublicBoundaryError } from "../src/public-boundary.js";

describe("hash-chain HTTP trust boundaries", () => {
  it("rejects an oversized streaming grant claim before assigning a key", async () => {
    let claims = 0;
    const server = {
      async runPublicAdapter(
        _adapter: string,
        _context: unknown,
        _channel: unknown,
        operation: (signal: AbortSignal) => Promise<unknown>,
      ) {
        return operation(new AbortController().signal);
      },
      claimHashChainGrant() { claims++; throw new Error("should not run"); },
    } as unknown as DirectModeServer;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(3000));
        controller.enqueue(new Uint8Array(2000));
        controller.close();
      },
    });
    const request = new Request("https://merchant.example/grant", {
      method: "POST", headers: { "content-type": "application/json" }, body, duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await handleHashChainGrantClaimHttp(server, request);
    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(claims).toBe(0);
  });

  it("propagates HTTP cancellation into grant work", async () => {
    const controller = new AbortController();
    let observed: AbortSignal | undefined;
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const server = {
      async runPublicAdapter(
        _adapter: string,
        _context: unknown,
        _channel: unknown,
        operation: (signal: AbortSignal) => Promise<unknown>,
      ) {
        return operation(controller.signal);
      },
      claimHashChainGrant(_claim: unknown, signal?: AbortSignal) {
        observed = signal;
        markEntered();
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    } as unknown as DirectModeServer;
    const request = new Request("https://merchant.example/grant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: controller.signal,
    });
    const pending = handleHashChainGrantClaimHttp(server, request);
    await entered;
    controller.abort(new Error("caller left"));
    const response = await pending;
    expect(response.status).toBe(499);
    expect(observed?.aborted).toBe(true);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("enters the shared request boundary before reading a claim body", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
    }, { highWaterMark: 0 });
    const server = {
      runPublicAdapter() {
        throw new PublicBoundaryError(
          "caller_quota_exceeded",
          "pre-parse caller quota is exhausted",
        );
      },
      claimHashChainGrant() {
        throw new Error("claim work must not run");
      },
    } as unknown as DirectModeServer;
    const request = new Request("https://merchant.example/grant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await handleHashChainGrantClaimHttp(server, request);
    expect(response.status).toBe(429);
    expect(pulls).toBe(0);
  });

  it("does not trust an accepted REST transaction whose accepting block left the selected chain", async () => {
    const txid = "11".repeat(32);
    const blockHash = "22".repeat(32);
    let selected = false;
    const view = new HashChainRestView("https://chain.example", async (input) => {
      const url = String(input);
      return Response.json(url.includes("/transactions/search") ? [{
        transaction_id: txid, is_accepted: true, accepting_block_hash: blockHash,
        outputs: [{ index: 0, amount: "100", script_public_key: "20" }], inputs: [],
      }] : { verboseData: { hash: blockHash, isChainBlock: selected } });
    });
    const outpoint = { txid, index: 0 };
    expect(await view.getAcceptedOrigin(outpoint)).toBeNull();
    selected = true;
    expect(await view.getAcceptedOrigin(outpoint)).toMatchObject({ amount: "100", covenantId: null });
  });

  it("batches origins and reuses one accepting-block read", async () => {
    const txid = "11".repeat(32);
    const blockHash = "22".repeat(32);
    let searches = 0;
    let blockReads = 0;
    const view = new HashChainRestView("https://chain.example", async (input, init) => {
      const url = String(input);
      if (url.includes("/transactions/search")) {
        searches++;
        expect(JSON.parse(String(init?.body))).toEqual({ transactionIds: [txid] });
        return Response.json([{
          transaction_id: txid,
          is_accepted: true,
          accepting_block_hash: blockHash,
          outputs: [
            { index: 0, amount: "100", script_public_key: "20" },
            { index: 1, amount: "200", script_public_key: "21" },
          ],
        }]);
      }
      blockReads++;
      return Response.json({
        verboseData: { hash: blockHash, isChainBlock: true },
      });
    });
    await expect(view.getAcceptedOrigins([
      { txid, index: 0 },
      { txid, index: 1 },
    ])).resolves.toEqual([
      { amount: "100", scriptPublicKey: "000020", covenantId: null },
      { amount: "200", scriptPublicKey: "000021", covenantId: null },
    ]);
    expect({ searches, blockReads }).toEqual({ searches: 1, blockReads: 1 });
  });

  it("propagates caller abort to the REST fetch", async () => {
    const controller = new AbortController();
    let observed: AbortSignal | undefined;
    const view = new HashChainRestView("https://chain.example", async (_input, init) => {
      observed = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        observed!.addEventListener("abort", () => reject(observed!.reason), {
          once: true,
        });
      });
    });
    const pending = view.getAcceptedOrigin(
      { txid: "11".repeat(32), index: 0 },
      { signal: controller.signal },
    );
    await Promise.resolve();
    controller.abort(new Error("caller left"));
    await expect(pending).rejects.toThrow("caller left");
    expect(observed?.aborted).toBe(true);
  });

  it("stops reading a REST response once it exceeds 512 KiB", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(300000));
        controller.enqueue(new Uint8Array(300000));
      },
      cancel() { cancelled = true; },
    });
    const view = new HashChainRestView("https://chain.example", async () => new Response(body));
    await expect(view.getAcceptedOrigin({ txid: "11".repeat(32), index: 0 })).rejects.toThrow("too large");
    expect(cancelled).toBe(true);
  });
});
