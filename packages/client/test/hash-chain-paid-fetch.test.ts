import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { schnorr } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";
import { DirectModeClient, MemoryChannelStore, PendingExactPaymentError,
  signHashChainExactTransaction, type DirectModeClientOptions } from "../src/index.js";

const vector = JSON.parse(readFileSync(fileURLToPath(new URL("../../../vectors/x402-http/hash-chain-exact.json", import.meta.url)), "utf8"));
const consensus = JSON.parse(readFileSync(fileURLToPath(new URL("../../../vectors/hash-chain/consensus-v1.json", import.meta.url)), "utf8")).expected;
const payerKey = "07".repeat(32);

describe("hash-chain paidFetch", () => {
  it("retries an ambiguous broadcast with the same delivered grant and signed transaction", async () => {
    let grants = 0;
    let signed = 0;
    let broadcasts = 0;
    let paidRequests = 0;
    const provider = {
      networkId: "kaspa:testnet-10", sourceKind: "hot-wallet",
      async getPublicIdentity() {
        return { address: vector.paymentPayload.payload.payerAddress,
          publicKey: Buffer.from(schnorr.getPublicKey(Buffer.from(payerKey, "hex"))).toString("hex") };
      },
      async claimHashChainGrant() {
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
      fundingProvider: provider, store: new MemoryChannelStore(),
      signer: {} as DirectModeClientOptions["signer"],
      addressCodec: {
        scriptPublicKeyForAddress: () => vector.paymentPayload.accepted.extra.payToScriptPublicKey,
        encodeScriptAddress: () => vector.paymentPayload.accepted.payTo,
      },
      confirmationThreshold: 30,
      fundingPolicy: { allowedExactProfiles: ["hash-chain-additive"], allowedOrigins: ["https://api.example.test"] },
      fetch: async (url, init) => {
        const headers = init?.headers as Record<string, string> | undefined;
        const paid = headers && Object.keys(headers).some((key) => key.toLowerCase() === "payment-signature");
        if (!paid) return {
          status: 402, url, redirected: false,
          headers: { get: (key: string) => key.toLowerCase() === "payment-required" ? vector.headers.paymentRequired : null },
        };
        paidRequests++;
        if (paidRequests === 1) throw new Error("merchant response lost");
        return {
          status: 200, url, redirected: false,
          headers: { get: (key: string) => key.toLowerCase() === "payment-response" ? vector.headers.paymentResponse : null },
        };
      },
    });
    const init = { paymentIdentifier: "hash_chain_vector_0001" };
    await expect(client.paidFetch(vector.paymentRequired.resource.url, init)).rejects.toBeInstanceOf(PendingExactPaymentError);
    const retried = await client.paidFetch(vector.paymentRequired.resource.url, init);
    expect(retried.response.status).toBe(200);
    expect(retried.payment?.transactionId).toBe(consensus.transactions.borrow1.transactionId);
    expect({ grants, signed, broadcasts, paidRequests }).toEqual({ grants: 1, signed: 1, broadcasts: 2, paidRequests: 2 });
  });
});
