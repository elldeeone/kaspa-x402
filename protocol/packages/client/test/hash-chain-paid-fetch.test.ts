import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { schnorr } from "@noble/curves/secp256k1.js";
import { encodePaymentRequiredHeader, sha256Hex, stableStringify } from "@kaspa-x402/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DirectModeClient, MemoryChannelStore, PendingExactPaymentError,
  signHashChainExactTransaction, type DirectModeClientOptions } from "../src/index.js";

const vector = JSON.parse(readFileSync(fileURLToPath(new URL("../../../vectors/x402-http/hash-chain-exact.json", import.meta.url)), "utf8"));
const consensus = JSON.parse(readFileSync(fileURLToPath(new URL("../../../vectors/hash-chain/consensus-v1.json", import.meta.url)), "utf8")).expected;
const payerKey = "07".repeat(32);
const grantDestinationPolicy = {
  allowedOrigins: ["https://api.example.test"],
} as const;
const exactFundingPolicy = {
  requiredSource: "hot-wallet",
  allowedExactProfiles: ["hash-chain-additive"],
  allowedOrigins: ["https://api.example.test"],
  allowedPayTo: [vector.paymentPayload.accepted.payTo],
  maximumExactAmountSompi: vector.paymentPayload.accepted.amount,
} as const;

beforeEach(() => vi.stubGlobal("location", { href: "https://api.example.test/" }));
afterEach(() => vi.unstubAllGlobals());

describe("hash-chain paidFetch", () => {
  it("retries an ambiguous broadcast with the same delivered grant and signed transaction", async () => {
    const equivalentRequired = structuredClone(vector.paymentRequired);
    equivalentRequired.resource.url = "https://api.example.test:443/hash-chain/file";
    equivalentRequired.accepts[0].extra.grantClaimUrl = "https://api.example.test:443/hash-chain/grant";
    const equivalentHeader = encodePaymentRequiredHeader(equivalentRequired);
    let grants = 0;
    let signed = 0;
    let broadcasts = 0;
    let paidRequests = 0;
    const caller = new AbortController();
    const provider = {
      networkId: "kaspa:testnet-10", sourceKind: "hot-wallet",
      async getPublicIdentity() {
        return { address: vector.paymentPayload.payload.payerAddress,
          publicKey: Buffer.from(schnorr.getPublicKey(Buffer.from(payerKey, "hex"))).toString("hex") };
      },
      async claimHashChainGrant(request: { signal?: AbortSignal }) {
        expect(request.signal).toBe(caller.signal);
        grants++;
        return {
          grantId: vector.paymentPayload.accepted.extra.grantId, headVersion: 0,
          nextGuard: consensus.chain.firstRevealedGuard,
          oneTimePublicKey: consensus.chain.firstOneTimePublicKey,
          oneTimePrivateKey: "0c".repeat(32),
          expiresAt: vector.paymentPayload.accepted.extra.challengeExpiresAt,
        };
      },
      async payHashChainTransaction(request: Parameters<typeof signHashChainExactTransaction>[0]["request"]) {
        signed++;
        return signHashChainExactTransaction({
          request, feeSompi: consensus.transactions.borrow1.fee,
          funding: {
            outpoint: consensus.transactions.borrow1.transaction.inputs[1].previousOutpoint,
            amount: consensus.transactions.borrow1.transaction.inputs[1].utxo.amount,
            scriptPublicKey: consensus.transactions.borrow1.transaction.inputs[1].utxo.scriptPublicKey,
            privateKey: payerKey, payerAddress: vector.paymentPayload.payload.payerAddress,
          },
        });
      },
      async finalizeExactPaymentAttempt() {},
      async sendTransaction(transaction: string) {
        broadcasts++;
        expect(JSON.parse(transaction).id).toBe(consensus.transactions.borrow1.transactionId);
        if (broadcasts === 1) throw new Error("submission outcome unknown");
        throw new Error("already in consensus");
      },
    } as unknown as DirectModeClientOptions["fundingProvider"];
    const client = new DirectModeClient({
      addressCodec: {
        scriptPublicKeyForAddress: () => vector.paymentPayload.accepted.extra.payToScriptPublicKey,
        encodeScriptAddress: () => vector.paymentPayload.accepted.payTo,
      },
      fundingProvider: provider,
      store: new MemoryChannelStore(),
      confirmationThreshold: 30,
      fundingPolicy: exactFundingPolicy,
      hashChainGrantDestinationPolicy: grantDestinationPolicy,
      fetch: async (url, init) => {
        const headers = init?.headers as Record<string, string> | undefined;
        const paid =
          headers && Object.keys(headers).some((key) => key.toLowerCase() === "payment-signature");
        if (!paid)
          return {
            status: 402,
            url,
            redirected: false,
            headers: {
              get: (key: string) =>
                key.toLowerCase() === "payment-required" ? equivalentHeader : null,
            },
          };
        paidRequests++;
        if (paidRequests === 1) throw new Error("merchant response lost");
        return {
          status: 200,
          url,
          redirected: false,
          headers: {
            get: (key: string) =>
              key.toLowerCase() === "payment-response" ? vector.headers.paymentResponse : null,
          },
        };
      },
    });
    const init = { paymentIdentifier: "hash_chain_vector_0001", signal: caller.signal };
    await expect(client.paidFetch(vector.paymentRequired.resource.url, init)).rejects.toBeInstanceOf(PendingExactPaymentError);
    const retried = await client.paidFetch(vector.paymentRequired.resource.url, init);
    expect(retried.response.status).toBe(200);
    expect(retried.payment?.transactionId).toBe(consensus.transactions.borrow1.transactionId);
    expect({ grants, signed, broadcasts, paidRequests }).toEqual({ grants: 1, signed: 1, broadcasts: 2, paidRequests: 2 });
  });

  it("blocks expired broadcasts while preserving trusted reconciliation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T10:00:00.000Z"));
    try {
      let sends = 0;
      let paidRequests = 0;
      let finalizations = 0;
      let grantClaims = 0;
      let serverRecoveryReady = false;
      let reconciledAmount = "20000000";
      let reconciledScript = vector.paymentPayload.accepted.extra.payToScriptPublicKey;
      const store = new MemoryChannelStore();
      const provider = {
        networkId: "kaspa:testnet-10", sourceKind: "hot-wallet",
        async getPublicIdentity() {
          return { address: vector.paymentPayload.payload.payerAddress,
            publicKey: Buffer.from(schnorr.getPublicKey(Buffer.from(payerKey, "hex"))).toString("hex") };
        },
        async claimHashChainGrant() {
          grantClaims++;
          return {
            grantId: vector.paymentPayload.accepted.extra.grantId, headVersion: 0,
            nextGuard: consensus.chain.firstRevealedGuard,
            oneTimePublicKey: consensus.chain.firstOneTimePublicKey,
            oneTimePrivateKey: "0c".repeat(32),
            expiresAt: vector.paymentPayload.accepted.extra.challengeExpiresAt,
          };
        },
        async payHashChainTransaction(request: Parameters<typeof signHashChainExactTransaction>[0]["request"]) {
          return signHashChainExactTransaction({
            request, feeSompi: consensus.transactions.borrow1.fee,
            funding: {
              outpoint: consensus.transactions.borrow1.transaction.inputs[1].previousOutpoint,
              amount: consensus.transactions.borrow1.transaction.inputs[1].utxo.amount,
              scriptPublicKey: consensus.transactions.borrow1.transaction.inputs[1].utxo.scriptPublicKey,
              privateKey: payerKey, payerAddress: vector.paymentPayload.payload.payerAddress,
            },
          });
        },
        async finalizeExactPaymentAttempt() { finalizations++; },
        async sendTransaction() {
          sends++;
          return { transactionId: consensus.transactions.borrow1.transactionId };
        },
      } as unknown as DirectModeClientOptions["fundingProvider"];
      const client = new DirectModeClient({
        addressCodec: {
          scriptPublicKeyForAddress: () => vector.paymentPayload.accepted.extra.payToScriptPublicKey,
          encodeScriptAddress: () => vector.paymentPayload.accepted.payTo,
        },
        fundingProvider: provider,
        store,
        confirmationThreshold: 30,
        fundingPolicy: exactFundingPolicy,
        hashChainGrantDestinationPolicy: grantDestinationPolicy,
        exactPaymentReconciler: {
          async reconcileExactPayment(attempt) {
            return {
              transactionId: attempt.transactionId,
              evidence: {
                status: "accepted" as const,
                transactionId: attempt.transactionId,
                acceptingBlockHash: "ab".repeat(32),
                acceptingBlockBlueScore: "971",
                confirmationCount: 30,
                checkpoint: { blockHash: "ef".repeat(32), blueScore: "1000", daaScore: "1000" },
              },
              output: {
                transactionId: attempt.transactionId,
                outputIndex: 0,
                amount: reconciledAmount,
                scriptPublicKey: reconciledScript,
              },
            };
          },
        },
        fetch: async (url, init) => {
          paidRequests++;
          const headers = init?.headers as Record<string, string>;
          expect(Object.keys(headers).some((key) => key.toLowerCase() === "payment-signature")).toBe(
            true,
          );
          return {
            status: serverRecoveryReady ? 200 : 402,
            url,
            redirected: false,
            headers: {
              get: (key: string) =>
                key.toLowerCase() === "payment-response" ? vector.headers.paymentResponse : null,
            },
          };
        },
      });
      const payment = await client.createPayment(vector.headers.paymentRequired, {
        url: vector.paymentRequired.resource.url,
        paymentIdentifier: "hash_chain_expiry_0001",
      });
      vi.advanceTimersByTime(61_000);
      await expect(client.broadcastHashChainPayment(payment)).rejects.toThrow("recovery-only");
      expect(sends).toBe(0);
      await expect(store.loadExactPaymentAttempt(payment.exactAttemptId!))
        .resolves.toMatchObject({ status: "pending" });
      await expect(client.reconcileExactPayment(payment.exactAttemptId!))
        .rejects.toThrow("accepted amount and script");
      reconciledAmount = "120000000";
      reconciledScript = vector.paymentPayload.accepted.extra.headScriptPublicKey;
      await expect(client.reconcileExactPayment(payment.exactAttemptId!))
        .rejects.toThrow("accepted amount and script");
      reconciledScript = vector.paymentPayload.accepted.extra.payToScriptPublicKey;
      await expect(client.reconcileExactPayment(payment.exactAttemptId!))
        .resolves.toMatchObject({ accepted: true, finality: "confirmed" });
      expect(finalizations).toBe(1);
      await expect(client.paidFetch(
        vector.paymentRequired.resource.url,
        { paymentIdentifier: "hash_chain_expiry_0001" },
      )).rejects.toBeInstanceOf(PendingExactPaymentError);
      expect({ sends, grantClaims, paidRequests })
        .toEqual({ sends: 0, grantClaims: 1, paidRequests: 1 });
      serverRecoveryReady = true;
      const recovered = await client.paidFetch(
        vector.paymentRequired.resource.url,
        { paymentIdentifier: "hash_chain_expiry_0001" },
      );
      expect(recovered.response.status).toBe(200);
      expect(paidRequests).toBe(2);
      expect(sends).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("canonicalizes direct hash-chain requests before hashing and generates fresh identifiers", async () => {
    vi.stubGlobal("location", { href: "https://api.example.test/base" });
    try {
      const required = structuredClone(vector.paymentRequired);
      required.resource.url = "https://api.example.test/hash-chain/file";
      required.accepts[0].extra.grantClaimUrl =
        "https://api.example.test/hash-chain/grant";
      const header = encodePaymentRequiredHeader(required);
      const canonicalUrl = required.resource.url;
      const expectedRequestHash = sha256Hex(stableStringify({
        method: "GET",
        url: canonicalUrl,
        body: null,
      }));
      const identifiers: string[] = [];
      for (const input of [
        "https://api.example.test:443/hash-chain/file",
        "/hash-chain/file",
      ]) {
        let loadedIdentifier: string | undefined;
        let claimRequestHash: string | undefined;
        class InspectingStore extends MemoryChannelStore {
          override async loadExactPaymentAttemptByIdentifier(identifier: string) {
            loadedIdentifier = identifier;
            return undefined;
          }
        }
        const client = new DirectModeClient({
          addressCodec: {
            scriptPublicKeyForAddress: () => vector.paymentPayload.accepted.extra.payToScriptPublicKey,
            encodeScriptAddress: () => vector.paymentPayload.accepted.payTo,
          },
          fundingProvider: {
            networkId: "kaspa:testnet-10",
            sourceKind: "hot-wallet",
            async getPublicIdentity() {
              return {
                address: vector.paymentPayload.payload.payerAddress,
                publicKey: Buffer.from(schnorr.getPublicKey(Buffer.from(payerKey, "hex"))).toString("hex"),
              };
            },
            async claimHashChainGrant(request: Parameters<NonNullable<DirectModeClientOptions["fundingProvider"]["claimHashChainGrant"]>>[0]) {
              claimRequestHash = request.requestHash;
              throw new Error("inspection complete");
            },
            async payHashChainTransaction() {
              throw new Error("must not sign");
            },
            async finalizeExactPaymentAttempt() {},
          } as unknown as DirectModeClientOptions["fundingProvider"],
          store: new InspectingStore(),
          confirmationThreshold: 30,
          fundingPolicy: exactFundingPolicy,
          hashChainGrantDestinationPolicy: grantDestinationPolicy,
        });
        await expect(client.createPayment(header, { url: input }))
          .rejects.toThrow("inspection complete");
        expect(claimRequestHash).toBe(expectedRequestHash);
        expect(loadedIdentifier).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        identifiers.push(loadedIdentifier!);
      }
      expect(identifiers[0]).not.toBe(identifiers[1]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects attacker-declared loopback resource and grant URLs before wallet work", async () => {
    const malicious = structuredClone(vector.paymentRequired);
    malicious.resource.url = "http://127.0.0.1:7777/private";
    malicious.accepts[0].extra.grantClaimUrl = "http://127.0.0.1:7777/grant";
    let grants = 0;
    let signed = 0;
    let sends = 0;
    const provider = {
      networkId: "kaspa:testnet-10", sourceKind: "hot-wallet",
      async getPublicIdentity() { throw new Error("identity must not run"); },
      async claimHashChainGrant() { grants++; throw new Error("claim must not run"); },
      async payHashChainTransaction() { signed++; throw new Error("signing must not run"); },
      async finalizeExactPaymentAttempt() {},
      async sendTransaction() { sends++; throw new Error("send must not run"); },
    } as unknown as DirectModeClientOptions["fundingProvider"];
    const client = new DirectModeClient({
      addressCodec: {
        scriptPublicKeyForAddress: () => vector.paymentPayload.accepted.extra.payToScriptPublicKey,
        encodeScriptAddress: () => vector.paymentPayload.accepted.payTo,
      },
      fundingProvider: provider,
      store: new MemoryChannelStore(),
      confirmationThreshold: 30,
      fundingPolicy: exactFundingPolicy,
      hashChainGrantDestinationPolicy: grantDestinationPolicy,
      fetch: async (url) => ({
        status: 402,
        url,
        redirected: false,
        headers: {
          get: (key: string) =>
            key.toLowerCase() === "payment-required" ? encodePaymentRequiredHeader(malicious) : null,
        },
      }),
    });
    await expect(client.paidFetch("https://api.example.test/hash-chain/file", {
      paymentIdentifier: "hash_chain_ssrf_0001",
    })).rejects.toThrow("resource URL");
    expect({ grants, signed, sends }).toEqual({ grants: 0, signed: 0, sends: 0 });
  });

  it("does not infer an exact retry identifier from a request URL", async () => {
    let identifierLookups = 0;
    class InspectingStore extends MemoryChannelStore {
      override async loadExactPaymentAttemptByIdentifier() {
        identifierLookups++;
        return undefined;
      }
    }
    const client = new DirectModeClient({
      addressCodec: {} as DirectModeClientOptions["addressCodec"],
      fundingProvider: {
        networkId: "kaspa:testnet-10",
        sourceKind: "hot-wallet",
      } as DirectModeClientOptions["fundingProvider"],
      store: new InspectingStore(),
      confirmationThreshold: 30,
      fundingPolicy: exactFundingPolicy,
      hashChainGrantDestinationPolicy: grantDestinationPolicy,
      fetch: async (url) => ({
        status: 200,
        url,
        redirected: false,
        headers: { get: () => null },
      }),
    });
    const response = await client.paidFetch(vector.paymentRequired.resource.url);
    expect(response.response.status).toBe(200);
    expect(identifierLookups).toBe(0);
  });
});
