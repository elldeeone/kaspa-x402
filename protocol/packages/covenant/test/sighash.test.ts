import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  kaspaSighashType, transactionV1Sighash, transactionV1SchnorrSignatureEvidence,
  exactV0SchnorrSignatureEvidence, buildTxV1P2pkSignatureScript,
  type TxV1ReferenceTransaction,
} from "../src/index.js";

const oracle = JSON.parse(readFileSync(new URL("../../../vectors/sighash/consensus.json", import.meta.url), "utf8"));
const modes = [1, 2, 4, 129, 130, 132] as const;

describe("Kaspa signature scopes against the independent Rust consensus oracle", () => {
  for (const step of oracle.transactions) {
    it(`matches every digest and verifies signatures for ${step.kind}, mode ${step.hashType}`, () => {
      const type = kaspaSighashType(step.hashType);
      const transaction = step.transaction;
      for (let index = 0; index < transaction.inputs.length; index++) {
        const input = transaction.inputs[index];
        if (transaction.version === 0) {
          const evidence = exactV0SchnorrSignatureEvidence(transaction, index);
          expect(evidence.digest).toBe(step.digests[index]);
          expect(schnorr.verify(Buffer.from(evidence.signature, "hex"), Buffer.from(evidence.digest, "hex"), Buffer.from(evidence.publicKey, "hex"))).toBe(true);
        } else {
          expect(transactionV1Sighash(transaction, index, type).digest).toBe(step.digests[index]);
          if (input.utxo.scriptPublicKey.endsWith("ac") && input.signatureScript.length === 132) {
            const evidence = transactionV1SchnorrSignatureEvidence(transaction, index);
            expect(evidence.hashType).toBe(type);
            expect(evidence.digest).toBe(step.digests[index]);
            expect(schnorr.verify(Buffer.from(evidence.signature, "hex"), Buffer.from(evidence.digest, "hex"), Buffer.from(evidence.publicKey, "hex"))).toBe(true);
          }
        }
      }
    });
  }

  it("commits exactly the inputs and outputs selected by each mode", () => {
    const step = oracle.transactions.find((item: { kind: string; hashType: number }) => item.kind === "top-up" && item.hashType === 1);
    const transaction: TxV1ReferenceTransaction = step.transaction;
    for (const type of modes) {
      const digest = transactionV1Sighash(transaction, 0, type).digest;
      const otherInput = structuredClone(transaction);
      otherInput.inputs[1]!.previousOutpoint.txid = "ee".repeat(32);
      expect(transactionV1Sighash(otherInput, 0, type).digest === digest).toBe((type & 128) !== 0);
      const otherSequence = structuredClone(transaction);
      otherSequence.inputs[1]!.sequence = "123";
      expect(transactionV1Sighash(otherSequence, 0, type).digest === digest).toBe(type !== 1);
      const otherOutput = structuredClone(transaction);
      otherOutput.outputs[1]!.amount = "1";
      expect(transactionV1Sighash(otherOutput, 0, type).digest === digest).toBe((type & 7) !== 1);
      const ownOutput = structuredClone(transaction);
      ownOutput.outputs[0]!.amount = "1";
      expect(transactionV1Sighash(ownOutput, 0, type).digest === digest).toBe((type & 7) === 2);
    }
  });

  it("defaults to ALL and rejects every unsupported byte", () => {
    expect(buildTxV1P2pkSignatureScript("00".repeat(64)).endsWith("01")).toBe(true);
    for (let flag = 0; flag <= 255; flag++) {
      if (!modes.includes(flag as typeof modes[number])) expect(() => kaspaSighashType(flag)).toThrow("invalid Kaspa sighash");
    }
  });
});
