import fs from "node:fs";

import { schnorr } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";

import {
  calculateKaspaStorageMass,
  exactV0SchnorrSignatureEvidence,
  exactV0TransactionId,
  hexToBytes,
  transactionV1Id,
  transactionV1SchnorrSignatureEvidence,
  type ExactV0ReferenceTransaction,
  type TxV1ReferenceTransaction,
} from "../src/index.js";

describe("standard-native exact v0 consensus hashes", () => {
  it("matches the Rusty Kaspa full-consensus vector and verifies its signature", () => {
    const vector = JSON.parse(
      fs.readFileSync(new URL("../../../vectors/exact/consensus-profiles.json", import.meta.url), "utf8"),
    ) as {
      expected: {
        standardNative: {
          transactionId: string;
          transaction: ExactV0ReferenceTransaction;
        };
      };
    };
    const expected = vector.expected.standardNative;

    expect(exactV0TransactionId(expected.transaction)).toBe(expected.transactionId);
    const evidence = exactV0SchnorrSignatureEvidence(expected.transaction, 0);
    expect(
      schnorr.verify(hexToBytes(evidence.signature), hexToBytes(evidence.digest), hexToBytes(evidence.publicKey)),
    ).toBe(true);
  });

  it("matches the corrected additive version-1 transaction id and payer signature", () => {
    const vector = JSON.parse(
      fs.readFileSync(new URL("../../../vectors/exact/consensus-profiles.json", import.meta.url), "utf8"),
    ) as {
      expected: {
        additive: {
          transactionId: string;
          estimatedSerializedSize: number;
          transaction: {
            storageMass: string;
            inputs: Array<{
              previousOutpoint: { txid: string; index: number };
              signatureScript: string;
              sequence: string;
              computeBudget: number;
              utxo: { amount: string; scriptPublicKey: string; blockDaaScore: string; isCoinbase: false };
            }>;
            outputs: TxV1ReferenceTransaction["outputs"];
            lockTime: string;
            subnetworkId: string;
            gas: string;
            payload: string;
          };
        };
      };
    };
    const additive = vector.expected.additive;
    const transaction: TxV1ReferenceTransaction = {
      version: 1,
      inputs: additive.transaction.inputs,
      outputs: additive.transaction.outputs,
      lockTime: additive.transaction.lockTime,
      subnetworkId: additive.transaction.subnetworkId,
      gas: additive.transaction.gas,
      payload: additive.transaction.payload,
      mass: additive.transaction.storageMass,
      estimatedSerializedSize: additive.estimatedSerializedSize,
    };

    expect(transactionV1Id(transaction)).toBe(additive.transactionId);
    const evidence = transactionV1SchnorrSignatureEvidence(transaction, 1);
    expect(schnorr.verify(hexToBytes(evidence.signature), hexToBytes(evidence.digest), hexToBytes(evidence.publicKey))).toBe(true);
    expect(() => transactionV1SchnorrSignatureEvidence(transaction, 0)).toThrow("canonical 65-byte Schnorr");
  });

  it("matches Rusty Kaspa contextual storage mass for both exact profiles", () => {
    const vector = JSON.parse(
      fs.readFileSync(new URL("../../../vectors/exact/consensus-profiles.json", import.meta.url), "utf8"),
    ) as {
      expected: {
        standardNative: { transaction: ExactV0ReferenceTransaction };
        additive: {
          transaction: {
            storageMass: string;
            inputs: Array<{ utxo: { amount: string; scriptPublicKey: string } }>;
            outputs: Array<{ amount: string; scriptPublicKey: string; covenant: null }>;
          };
        };
      };
    };

    for (const profile of [vector.expected.standardNative, vector.expected.additive]) {
      const mass = calculateKaspaStorageMass({
        inputs: profile.transaction.inputs.map((input) => ({ ...input.utxo, hasCovenant: false })),
        outputs: profile.transaction.outputs.map((output) => ({
          amount: output.amount,
          scriptPublicKey: output.scriptPublicKey,
          hasCovenant: output.covenant !== null,
        })),
      });
      expect(mass.toString()).toBe(profile.transaction.storageMass);
    }
  });

  it("rejects non-canonical signatures and funding scripts", () => {
    const vector = JSON.parse(
      fs.readFileSync(new URL("../../../vectors/exact/consensus-profiles.json", import.meta.url), "utf8"),
    ) as { expected: { standardNative: { transaction: ExactV0ReferenceTransaction } } };
    const transaction = structuredClone(vector.expected.standardNative.transaction);

    transaction.inputs[0]!.signatureScript = "00";
    expect(() => exactV0SchnorrSignatureEvidence(transaction, 0)).toThrow("canonical 65-byte Schnorr");

    transaction.inputs[0]!.signatureScript = vector.expected.standardNative.transaction.inputs[0]!.signatureScript;
    transaction.inputs[0]!.utxo.scriptPublicKey = "000051";
    expect(() => exactV0SchnorrSignatureEvidence(transaction, 0)).toThrow("Schnorr P2PK");
  });
});
