import { describe, expect, it } from "vitest";
import { handleHashChainGrantClaimHttp } from "../src/hash-chain-grant-http.js";
import { HashChainRestView } from "../src/hash-chain-rest-view.js";
import type { DirectModeServer } from "../src/direct-server.js";

describe("hash-chain HTTP trust boundaries", () => {
  it("rejects an oversized streaming grant claim before assigning a key", async () => {
    let claims = 0;
    const server = { claimHashChainGrant() { claims++; throw new Error("should not run"); } } as unknown as DirectModeServer;
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

  it("does not trust an accepted REST transaction whose accepting block left the selected chain", async () => {
    const txid = "11".repeat(32);
    const blockHash = "22".repeat(32);
    let selected = false;
    const view = new HashChainRestView("https://chain.example", async (input) => {
      const url = String(input);
      return Response.json(url.includes("/transactions/") ? {
        transaction_id: txid, is_accepted: true, accepting_block_hash: blockHash,
        outputs: [{ index: 0, amount: "100", script_public_key: "20" }], inputs: [],
      } : { verboseData: { hash: blockHash, isChainBlock: selected } });
    });
    const outpoint = { txid, index: 0 };
    expect(await view.getAcceptedOrigin(outpoint)).toBeNull();
    selected = true;
    expect(await view.getAcceptedOrigin(outpoint)).toMatchObject({ amount: "100", covenantId: null });
  });

  it("requires the exact current covenant UTXO before grant delivery", async () => {
    const head = { outpoint: { txid: "11".repeat(32), index: 0 as const }, amount: "100",
      guard: "33".repeat(32), scriptPublicKey: "000020" + "44".repeat(32) + "ac",
      covenantId: "55".repeat(32) };
    let utxos: unknown[] = [];
    const view = new HashChainRestView("https://chain.example", async () => Response.json(utxos));
    expect(await view.isUnspentHead(head, "kaspatest:head")).toBe(false);
    utxos = [{ outpoint: { transactionId: head.outpoint.txid, index: 0 },
      utxoEntry: { amount: head.amount, scriptPublicKey: { scriptPublicKey: head.scriptPublicKey },
        covenantId: head.covenantId } }];
    expect(await view.isUnspentHead(head, "kaspatest:head")).toBe(true);
    utxos = [{ ...utxos[0] as object, utxoEntry: { amount: "101",
      scriptPublicKey: { scriptPublicKey: head.scriptPublicKey }, covenantId: head.covenantId } }];
    expect(await view.isUnspentHead(head, "kaspatest:head")).toBe(false);
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
