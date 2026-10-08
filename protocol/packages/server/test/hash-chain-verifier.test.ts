import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { exactRequestAuthorizationDigest, sha256Hex, stableStringify } from "@kaspa-x402/core";
import {
  hashChainHeadScriptPublicKey,
  parseHashChainHeadRedeemScript,
} from "@kaspa-x402/covenant";
import { HashChainExactTransactionVerifier } from "../src/hash-chain-verifier.js";
import type { ExactTransactionVerificationRequest } from "../src/types.js";

const root = fileURLToPath(new URL("../../../vectors/hash-chain/consensus-v1.json", import.meta.url));
const vector = JSON.parse(readFileSync(root, "utf8")).expected;

function fixture(selectedMode: "valid" | "missing" | "wrong-successor" = "valid", step = vector.transactions.borrow1): {
  request: ExactTransactionVerificationRequest;
  verifier: HashChainExactTransactionVerifier;
  originReads: () => number;
} {
  const tx = structuredClone(step.transaction);
  tx.id = step.transactionId;
  const first = tx.inputs[0];
  const witness = Buffer.from(first.signatureScript, "hex");
  const redeemScript = witness.subarray(140).toString("hex");
  const parsed = parseHashChainHeadRedeemScript(redeemScript);
  const successorScript = hashChainHeadScriptPublicKey({
    ownerPublicKey: parsed.ownerPublicKey, guard: vector.chain.firstRevealedGuard,
  });
  const head = {
    headId: "aa".repeat(32), headVersion: "0", covenantId: vector.covenantId,
    expectedHeadOutpoint: first.previousOutpoint,
    headAmount: first.utxo.amount,
    headScriptPublicKey: first.utxo.scriptPublicKey,
    headRedeemScript: redeemScript,
    currentGuard: vector.chain.initialGuard,
    nextGuard: vector.chain.firstRevealedGuard,
    oneTimePublicKey: vector.chain.firstOneTimePublicKey,
    grantId: "bb".repeat(32), challengeId: "cc".repeat(32),
    challengeIssuedAt: new Date(Date.now() - 1000).toISOString(),
    challengeExpiresAt: new Date(Date.now() + 120000).toISOString(),
  };
  const requestHash = "dd".repeat(32);
  const paymentRequirementsHash = sha256Hex(stableStringify({ head, amount: step.amount }));
  const expiresAt = new Date(Date.now() + 60000).toISOString();
  const digest = exactRequestAuthorizationDigest({
    network: "kaspa:testnet-10", profile: "hash-chain-additive",
    transactionId: tx.id, paymentOutputIndex: 0, amount: step.amount,
    payTo: "kaspatest:successor", payToScriptPublicKey: successorScript,
    paymentRequirementsHash, requestHash, paymentIdentifier: "hash_chain_verifier_0001", challengeId: head.challengeId,
    inputIndex: 1, expiresAt,
  });
  const payerKey = Buffer.alloc(32, 7);
  const request: ExactTransactionVerificationRequest = {
    network: "kaspa:testnet-10", profile: "hash-chain-additive",
    transaction: JSON.stringify(tx), transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
    paymentOutputIndex: 0, amount: step.amount, payTo: "kaspatest:successor",
    payToScriptPublicKey: successorScript, requiredFinality: "accepted",
    requestHash, paymentRequirementsHash, paymentIdentifier: "hash_chain_verifier_0001",
    authorization: {
      version: "kaspa-x402-exact-request-authorization-v2", inputIndex: 1,
      expiresAt, digest,
      signature: Buffer.from(schnorr.sign(Buffer.from(digest, "hex"), payerKey)).toString("hex"),
    },
    hashChainHead: head,
  };
  let reads = 0;
  const verifier = new HashChainExactTransactionVerifier({
    async getAcceptedOrigins(outpoints) {
      reads++;
      return outpoints.map((outpoint) => {
        const input = tx.inputs.find((item: any) =>
          item.previousOutpoint.txid === outpoint.txid &&
          item.previousOutpoint.index === outpoint.index);
        return input ? {
          amount: input.utxo.amount, scriptPublicKey: input.utxo.scriptPublicKey,
          covenantId: input === first ? vector.covenantId : null,
        } : null;
      });
    },
    async getSelectedTransaction(id) {
      return id === tx.id && selectedMode !== "missing" ? {
        transactionId: id, finality: "accepted" as const,
        spentHead: first.previousOutpoint,
        successor: {
          amount: selectedMode === "wrong-successor" ? "1" : tx.outputs[0].amount,
          scriptPublicKey: tx.outputs[0].scriptPublicKey,
          covenantId: vector.covenantId, authorizingInput: 0 as const,
        },
      } : null;
    },
  });
  return { request, verifier, originReads: () => reads };
}

describe("hash-chain exact selected-chain verifier", () => {
  it.each<{ headSighashType: number; fundingSighashType: number }>(vector.sighashModes)("accepts independently consensus-validated head=$headSighashType, funding=$fundingSighashType", async (step) => {
    const { request, verifier } = fixture("valid", step);
    await expect(verifier.verifyExactPayment(request)).resolves.toMatchObject({ finality: "accepted" });
  });

  it("rejects invalid flags and changed flags without matching signatures before chain reads", async () => {
    for (const flag of [0, 2, 128, 255]) {
      const { request, verifier, originReads } = fixture();
      const artifact = JSON.parse(request.transaction);
      const witness = Buffer.from(artifact.inputs[0].signatureScript, "hex");
      witness[131] = flag;
      artifact.inputs[0].signatureScript = witness.toString("hex");
      await expect(verifier.verifyExactPayment({ ...request, transaction: JSON.stringify(artifact) })).rejects.toThrow();
      expect(originReads()).toBe(0);
    }
  });

  it("accepts the fully signed Rusty-Kaspa consensus borrow and exact successor", async () => {
    const { request, verifier, originReads } = fixture();
    await expect(verifier.verifyExactPayment(request)).resolves.toMatchObject({
      transactionId: vector.transactions.borrow1.transactionId,
      finality: "accepted",
      paymentOutput: { amount: "20000000" },
      continuation: { amount: "120000000" },
    });
    expect(originReads()).toBe(1);
  });

  it("rejects noncanonical and unauthorized proofs before accepted-origin reads", async () => {
    const noncanonical = fixture();
    const artifact = JSON.parse(noncanonical.request.transaction);
    artifact.id = "00".repeat(32);
    await expect(noncanonical.verifier.verifyExactPayment({
      ...noncanonical.request,
      transaction: JSON.stringify(artifact),
    })).rejects.toThrow("transaction ID is not canonical");
    expect(noncanonical.originReads()).toBe(0);

    const unauthorized = fixture();
    await expect(unauthorized.verifier.verifyExactPayment({
      ...unauthorized.request,
      authorization: { ...unauthorized.request.authorization, signature: "00".repeat(64) },
    })).rejects.toThrow("authorization signature");
    expect(unauthorized.originReads()).toBe(0);
  });

  it("rejects underpayment, overpayment, a stolen grant, and an invalid payer authorization", async () => {
    const { request, verifier } = fixture();
    for (const amount of ["1", "20000001"]) {
      await expect(verifier.verifyExactPayment({ ...request, amount })).rejects.toThrow("exact quoted");
    }
    await expect(verifier.verifyExactPayment({
      ...request, hashChainHead: { ...request.hashChainHead!, oneTimePublicKey: "11".repeat(32) },
    })).rejects.toThrow();
    await expect(verifier.verifyExactPayment({
      ...request, authorization: { ...request.authorization, signature: "00".repeat(64) },
    })).rejects.toThrow("authorization signature");
  });

  it("withholds finality for an ambiguous broadcast and rejects a conflicting selected successor", async () => {
    const missing = fixture("missing");
    await expect(missing.verifier.verifyExactPayment(missing.request)).resolves.not.toHaveProperty("finality");
    const wrong = fixture("wrong-successor");
    await expect(wrong.verifier.verifyExactPayment(wrong.request)).rejects.toThrow("selected-chain hash-chain successor");
  });

  it("can recheck an accepted payment after its authorization expired", async () => {
    const { request, verifier } = fixture();
    const expired = "2026-01-01T00:00:00.000Z";
    const digest = exactRequestAuthorizationDigest({
      network: request.network, profile: request.profile,
      transactionId: vector.transactions.borrow1.transactionId,
      paymentOutputIndex: 0, amount: request.amount, payTo: request.payTo,
      payToScriptPublicKey: request.payToScriptPublicKey,
      paymentRequirementsHash: request.paymentRequirementsHash,
      requestHash: request.requestHash, paymentIdentifier: request.paymentIdentifier, challengeId: request.hashChainHead!.challengeId,
      inputIndex: 1, expiresAt: expired,
    });
    await expect(verifier.verifyExactPayment({ ...request, authorization: {
      ...request.authorization, expiresAt: expired, digest,
      signature: Buffer.from(schnorr.sign(Buffer.from(digest, "hex"), Buffer.alloc(32, 7))).toString("hex"),
    } })).resolves.toHaveProperty("finality", "accepted");
  });

  it("rejects over-budget artifacts before any chain read", async () => {
    const oversized = fixture();
    const artifact = JSON.parse(oversized.request.transaction);
    artifact.inputs = Array.from({ length: 9 }, (_, index) => ({
      ...structuredClone(artifact.inputs[index % artifact.inputs.length]),
      previousOutpoint: {
        txid: index.toString(16).padStart(64, "0"),
        index: 0,
      },
    }));
    await expect(oversized.verifier.verifyExactPayment({
      ...oversized.request,
      transaction: JSON.stringify(artifact),
    })).rejects.toThrow("input budget");
    expect(oversized.originReads()).toBe(0);
  });

  it("propagates cancellation and rejects incomplete origin batches", async () => {
    const cancelled = fixture();
    const controller = new AbortController();
    controller.abort(new Error("caller left"));
    await expect(cancelled.verifier.verifyExactPayment({
      ...cancelled.request,
      signal: controller.signal,
    })).rejects.toThrow("caller left");
    expect(cancelled.originReads()).toBe(0);

    const incomplete = fixture();
    const verifier = new HashChainExactTransactionVerifier({
      async getAcceptedOrigins() { return [null]; },
      async getSelectedTransaction() { return null; },
    });
    await expect(verifier.verifyExactPayment(incomplete.request))
      .rejects.toThrow("incomplete batch");
  });
});
