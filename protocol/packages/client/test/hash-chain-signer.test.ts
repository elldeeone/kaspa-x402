import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { schnorr } from "@noble/curves/secp256k1.js";
import { describe, expect, it, vi } from "vitest";
import { hashChainHeadScriptPublicKey, parseHashChainHeadRedeemScript } from "@kaspa-x402/covenant";
import { claimHashChainGrantViaHttp, signHashChainExactTransaction } from "../src/index.js";

const vector = JSON.parse(readFileSync(fileURLToPath(new URL("../../../vectors/hash-chain/consensus-v1.json", import.meta.url)), "utf8")).expected;
const borrow = vector.transactions.borrow1;
const witness = Buffer.from(borrow.transaction.inputs[0].signatureScript, "hex");
const redeemScript = witness.subarray(140).toString("hex");
const owner = parseHashChainHeadRedeemScript(redeemScript).ownerPublicKey;
const nextScript = hashChainHeadScriptPublicKey({ ownerPublicKey: owner, guard: vector.chain.firstRevealedGuard });
const payerPrivateKey = "07".repeat(32);
const payerPublicKey = Buffer.from(schnorr.getPublicKey(Buffer.from(payerPrivateKey, "hex"))).toString("hex");

function request() {
  return {
    attemptId: "a1".repeat(32), intentHash: "a2".repeat(32),
    paymentIdentifier: "hash_chain_signer_0001",
    network: "kaspa:testnet-10" as const, profile: "hash-chain-additive" as const,
    origin: "https://api.example.test", resourceUrl: "https://api.example.test/data",
    amount: borrow.amount, payTo: "kaspatest:pzjuqtpm8h09dy96xqzcrcgw4qrzd8xr8uu7r89gnte875h8r6x4xs5h4ygzq",
    payToScriptPublicKey: nextScript, paymentOutputIndex: 0,
    requestHash: "bb".repeat(32), paymentRequirementsHash: "cc".repeat(32),
    authorizationExpiresAt: "2099-01-01T00:00:00.000Z",
    hashChainHead: {
      headId: "aa".repeat(32), headVersion: "0", covenantId: vector.covenantId,
      expectedHeadOutpoint: borrow.transaction.inputs[0].previousOutpoint,
      headAmount: borrow.transaction.inputs[0].utxo.amount,
      headScriptPublicKey: borrow.transaction.inputs[0].utxo.scriptPublicKey,
      headRedeemScript: redeemScript, currentGuard: vector.chain.initialGuard,
      nextGuard: vector.chain.firstRevealedGuard,
      oneTimePublicKey: vector.chain.firstOneTimePublicKey,
      grantId: "dd".repeat(32), challengeId: "ee".repeat(32),
      grantClaimUrl: "https://api.example.test/hash-chain/grant",
      challengeExpiresAt: "2099-01-01T00:00:00.000Z",
    },
    grant: {
      grantId: "dd".repeat(32), headVersion: 0,
      nextGuard: vector.chain.firstRevealedGuard,
      oneTimePublicKey: vector.chain.firstOneTimePublicKey,
      oneTimePrivateKey: "0c".repeat(32),
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
  };
}

describe("hash-chain payer signing and HTTP grant claim", () => {
  it("reproduces the independently consensus-validated borrow transaction ID", () => {
    const signed = signHashChainExactTransaction({
      request: request(), feeSompi: "300000",
      funding: {
        outpoint: borrow.transaction.inputs[1].previousOutpoint,
        amount: borrow.transaction.inputs[1].utxo.amount,
        scriptPublicKey: borrow.transaction.inputs[1].utxo.scriptPublicKey,
        privateKey: payerPrivateKey, payerAddress: "kaspatest:payer",
      },
    });
    expect(signed.transactionId).toBe(borrow.transactionId);
    const artifact = JSON.parse(signed.transaction);
    expect(artifact.storageMass).toBe(borrow.storageMass);
    expect(artifact.outputs[0]).toMatchObject({
      value: "120000000", covenant: { covenantId: vector.covenantId, authorizingInput: 0 },
    });
    expect(artifact.outputs[1].value).toBe("29700000");
    expect(artifact.inputs[0].signatureScript).toMatch(/^20/);
    expect(artifact.inputs[1].signatureScript).toMatch(/^41/);
  });

  it("absorbs infeasible change within the fee ceiling and rejects it at the ceiling", () => {
    const funding = {
      outpoint: borrow.transaction.inputs[1].previousOutpoint,
      amount: (BigInt(borrow.amount) + 300001n).toString(),
      scriptPublicKey: borrow.transaction.inputs[1].utxo.scriptPublicKey,
      privateKey: payerPrivateKey, payerAddress: "kaspatest:payer",
    };
    const signed = signHashChainExactTransaction({ request: request(), funding, feeSompi: "300000" });
    const artifact = JSON.parse(signed.transaction);
    expect(artifact.outputs).toHaveLength(1);
    expect(BigInt(artifact.storageMass)).toBeLessThan(500000n);
    expect(() => signHashChainExactTransaction({ request: request(),
      funding: { ...funding, amount: (BigInt(borrow.amount) + 10000001n).toString() },
      feeSompi: "10000000",
    })).toThrow("excessive transaction mass");
  });

  it("signs the exact request-bound claim and rejects a cacheable secret response", async () => {
    const head = request().hashChainHead;
    const claim = { network: "kaspa:testnet-10" as const, head,
      resourceUrl: request().resourceUrl, requestHash: "bb".repeat(32), payerPublicKey,
      destinationPolicy: { allowedOrigins: ["https://api.example.test"] } };
    const fetcher = async (_url: unknown, init: RequestInit | undefined) => {
      const body = JSON.parse(String(init?.body));
      expect(body.grantId).toBe(head.grantId);
      expect(body.challengeId).toBe(head.challengeId);
      expect(body.requestHash).toBe(claim.requestHash);
      expect(schnorr.verify(Buffer.from(body.signature, "hex"), Buffer.from(digest!, "hex"), Buffer.from(payerPublicKey, "hex"))).toBe(true);
      return new Response(JSON.stringify(request().grant), { headers: { "cache-control": "no-store" } });
    };
    let digest: string | undefined;
    const delivered = await claimHashChainGrantViaHttp(claim, (value) => {
      digest = value;
      return Buffer.from(schnorr.sign(Buffer.from(value, "hex"), Buffer.from(payerPrivateKey, "hex"))).toString("hex");
    }, fetcher as typeof fetch);
    expect(delivered.grantId).toBe(head.grantId);
    await expect(claimHashChainGrantViaHttp(claim, () => "00".repeat(64),
      async () => new Response("{}", { headers: { "cache-control": "public" } }))).rejects.toThrow("caching");
    let fetches = 0;
    await expect(claimHashChainGrantViaHttp(
      { ...claim, resourceUrl: "https://public.example.test/data" },
      () => "00".repeat(64),
      async () => { fetches++; return new Response("{}"); },
    )).rejects.toThrow("same-origin");
    expect(fetches).toBe(0);

    const mutableHead = { ...head };
    let fetchedUrl = "";
    await claimHashChainGrantViaHttp(
      { ...claim, head: mutableHead },
      (value) => {
        mutableHead.grantClaimUrl = "https://127.0.0.1/private";
        return Buffer.from(schnorr.sign(
          Buffer.from(value, "hex"),
          Buffer.from(payerPrivateKey, "hex"),
        )).toString("hex");
      },
      (async (url) => {
        fetchedUrl = String(url);
        return new Response(JSON.stringify(request().grant), {
          headers: { "cache-control": "no-store" },
        });
      }) as typeof fetch,
    );
    expect(fetchedUrl).toBe(head.grantClaimUrl);
  });

  it("rejects unallowlisted private and DNS destinations before signing or fetch", async () => {
    const base = request();
    let signatures = 0;
    let fetches = 0;
    for (const origin of [
      "http://127.0.0.1:7777",
      "https://10.0.0.1",
      "https://100.64.0.1",
      "https://169.254.1.1",
      "https://192.168.1.1",
      "https://[::1]",
      "https://[fc00::1]",
      "https://rebind.example.test",
    ]) {
      await expect(claimHashChainGrantViaHttp({
        network: "kaspa:testnet-10",
        head: { ...base.hashChainHead, grantClaimUrl: `${origin}/grant` },
        resourceUrl: `${origin}/data`,
        requestHash: "bb".repeat(32),
        payerPublicKey,
        destinationPolicy: { allowedOrigins: ["https://api.example.test"] },
      }, () => {
        signatures++;
        return "00".repeat(64);
      }, async () => {
        fetches++;
        return new Response("{}");
      })).rejects.toThrow("not explicitly allowlisted");
    }
    expect({ signatures, fetches }).toEqual({ signatures: 0, fetches: 0 });

    const loopbackOrigin = "http://127.0.0.1:7777";
    await expect(claimHashChainGrantViaHttp({
      network: "kaspa:testnet-10",
      head: { ...base.hashChainHead, grantClaimUrl: `${loopbackOrigin}/grant` },
      resourceUrl: `${loopbackOrigin}/data`,
      requestHash: "bb".repeat(32),
      payerPublicKey,
      destinationPolicy: { allowedOrigins: [loopbackOrigin] },
    }, () => "00".repeat(64), async () =>
      new Response(JSON.stringify(base.grant), {
        headers: { "cache-control": "no-store" },
      }))).resolves.toMatchObject({ grantId: base.grant.grantId });
  });

  it("bounds declared and streamed grant bodies before parsing", async () => {
    const base = request();
    const claim = { network: "kaspa:testnet-10" as const, head: base.hashChainHead,
      resourceUrl: base.resourceUrl, requestHash: "bb".repeat(32), payerPublicKey,
      destinationPolicy: { allowedOrigins: ["https://api.example.test"] } };
    const sign = () => "00".repeat(64);
    await expect(claimHashChainGrantViaHttp(claim, sign, async () => {
      const response = new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array([123, 125])); controller.close(); } }),
        { headers: { "cache-control": "no-store", "content-length": "1000000" } });
      return response;
    })).rejects.toThrow(/length|large|limit|bytes/i);
    let cancelled = false;
    await expect(claimHashChainGrantViaHttp(claim, sign, async () =>
      new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(100_000)); },
        cancel() { cancelled = true; },
      }), { headers: { "cache-control": "no-store" } }),
    )).rejects.toThrow(/large|limit|bytes/i);
    expect(cancelled).toBe(true);
  });

  it("rejects malformed UTF-8 and incomplete grant schemas", async () => {
    const base = request();
    const claim = { network: "kaspa:testnet-10" as const, head: base.hashChainHead,
      resourceUrl: base.resourceUrl, requestHash: "bb".repeat(32), payerPublicKey,
      destinationPolicy: { allowedOrigins: ["https://api.example.test"] } };
    await expect(claimHashChainGrantViaHttp(claim, () => "00".repeat(64), async () =>
      new Response(new Uint8Array([0xff]), { headers: { "cache-control": "no-store" } }),
    )).rejects.toThrow();
    await expect(claimHashChainGrantViaHttp(claim, () => "00".repeat(64), async () =>
      new Response(JSON.stringify({ ...base.grant, extra: true }),
        { headers: { "cache-control": "no-store" } }),
    )).rejects.toThrow(/grant|schema|invalid/i);
  });

  it("cancels an endless grant at the mandatory deadline and on caller abort", async () => {
    const base = request();
    const controller = new AbortController();
    const claim = { network: "kaspa:testnet-10" as const, head: base.hashChainHead,
      resourceUrl: base.resourceUrl, requestHash: "bb".repeat(32), payerPublicKey,
      destinationPolicy: { allowedOrigins: ["https://api.example.test"] },
      signal: controller.signal };
    let cancelled = 0;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const endless = async () => {
      markStarted();
      return new Response(new ReadableStream({
        cancel() { cancelled += 1; },
      }), { headers: { "cache-control": "no-store" } });
    };
    const pending = claimHashChainGrantViaHttp(claim, () => "00".repeat(64), endless);
    await started;
    controller.abort(new Error("caller stopped"));
    await expect(pending).rejects.toThrow("caller stopped");
    expect(cancelled).toBe(1);

    vi.useFakeTimers();
    try {
      const deadline = claimHashChainGrantViaHttp({ ...claim, signal: undefined },
        () => "00".repeat(64), endless);
      const rejected = expect(deadline).rejects.toThrow("deadline exceeded");
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
      expect(cancelled).toBe(2);
    } finally { vi.useRealTimers(); }
  });

  it("rejects a pre-aborted grant before waiting on a stalled signer", async () => {
    const base = request();
    const controller = new AbortController();
    controller.abort(new Error("caller stopped before claim"));
    let fetches = 0;
    const claim = claimHashChainGrantViaHttp({
      network: "kaspa:testnet-10", head: base.hashChainHead,
      resourceUrl: base.resourceUrl, requestHash: "bb".repeat(32), payerPublicKey,
      destinationPolicy: { allowedOrigins: ["https://api.example.test"] },
      signal: controller.signal,
    }, () => new Promise<string>(() => undefined), async () => {
      fetches++;
      return new Response("{}");
    });
    await expect(Promise.race([
      claim,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("grant did not promptly reject")), 100)),
    ])).rejects.toThrow("caller stopped before claim");
    expect(fetches).toBe(0);
  });

  it("rejects an over-depth grant JSON below the byte cap", async () => {
    const base = request();
    const claim = { network: "kaspa:testnet-10" as const, head: base.hashChainHead,
      resourceUrl: base.resourceUrl, requestHash: "bb".repeat(32), payerPublicKey,
      destinationPolicy: { allowedOrigins: ["https://api.example.test"] } };
    let nested: unknown = base.grant;
    for (let index = 0; index < 40; index += 1) nested = { next: nested };
    await expect(claimHashChainGrantViaHttp(claim, () => "00".repeat(64), async () =>
      new Response(JSON.stringify(nested), { headers: { "cache-control": "no-store" } }),
    )).rejects.toThrow(/depth/i);
  });
});
