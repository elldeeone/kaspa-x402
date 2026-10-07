#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { bytesToHex, hexToBytes } from "@kaspa-x402/core";
import {
  buildKip10AdditiveBorrowArgs,
  buildKip10AdditiveRedeemScript,
} from "@kaspa-x402/covenant";

const sdkPath = process.env.KASPA_X402_KASPA_WASM_MODULE;
if (!sdkPath) {
  throw new Error("KASPA_X402_KASPA_WASM_MODULE is required");
}
const absoluteSdkPath = path.resolve(sdkPath);
const sdkRequire = createRequire(
  fs.statSync(absoluteSdkPath).isDirectory()
    ? path.join(absoluteSdkPath, "kaspa.js")
    : absoluteSdkPath,
);
const sdk = sdkRequire(absoluteSdkPath);
const { schnorr } = sdkRequire("@noble/curves/secp256k1.js");
sdk.initConsolePanicHook?.();

const networkId = new sdk.NetworkId("mainnet");
const payerPrivateKeyHex = "11".repeat(32);
const merchantPrivateKeyHex = "22".repeat(32);
const ownerPrivateKeyHex = "33".repeat(32);
const payerPrivateKey = new sdk.PrivateKey(payerPrivateKeyHex);
const payerAddress = payerPrivateKey.toAddress(networkId).toString();
const merchantAddress = new sdk.PrivateKey(merchantPrivateKeyHex)
  .toAddress(networkId)
  .toString();
const payerScript = sdk.payToAddressScript(payerAddress);
const merchantScript = sdk.payToAddressScript(merchantAddress);
const amount = 100_000_000n;
const fee = 2_000_000n;

const standard = standardNativeShape();
const additive = additiveShape();

console.log(
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      mode: "offline-synthetic-no-broadcast",
      network: "mainnet",
      realFundsOrUtxosUsed: false,
      standardNative: evidence(standard, {
        profile: "standard-native",
        merchantGain: BigInt(standard.outputs[0].value),
      }),
      additive: evidence(additive, {
        profile: "additive",
        merchantGain: BigInt(additive.outputs[0].value) - 100_000_000n,
      }),
    },
    null,
    2,
  ),
);

function standardNativeShape() {
  const inputAmount = 300_000_000n;
  const base = legacyP2pkInput("41".repeat(32), inputAmount);
  const shape = {
    version: 0,
    outputs: [
      { value: amount, scriptPublicKey: merchantScript },
      {
        value: inputAmount - amount - fee,
        scriptPublicKey: payerScript,
      },
    ],
    lockTime: 0n,
    subnetworkId: "00".repeat(20),
    gas: 0n,
    payload: "",
  };
  const unsigned = new sdk.Transaction({
    ...shape,
    inputs: [{ ...base, signatureScript: "" }],
  });
  return new sdk.Transaction({
    ...shape,
    inputs: [
      {
        ...base,
        signatureScript: sdk.createInputSignature(
          unsigned,
          0,
          payerPrivateKey,
          sdk.SighashType.All,
        ),
      },
    ],
  });
}

function additiveShape() {
  const headAmount = 100_000_000n;
  const fundingAmount = 300_000_000n;
  const ownerPublicKey = bytesToHex(
    schnorr.getPublicKey(
      hexToBytes(ownerPrivateKeyHex, { expectedLength: 32 }),
    ),
  );
  const redeemScript = buildKip10AdditiveRedeemScript({
    ownerPublicKey,
    amount: "10000000",
  });
  const headScript = sdk.payToScriptHashScript(redeemScript);
  const headInput = computeBudgetInput("51".repeat(32), headAmount, headScript);
  const fundingInput = computeBudgetInput(
    "52".repeat(32),
    fundingAmount,
    payerScript,
  );
  const shape = {
    version: 1,
    outputs: [
      { value: headAmount + amount, scriptPublicKey: headScript },
      {
        value: fundingAmount - amount - fee,
        scriptPublicKey: payerScript,
      },
    ],
    lockTime: 0n,
    subnetworkId: "00".repeat(20),
    gas: 0n,
    payload: "",
  };
  const unsigned = new sdk.Transaction({
    ...shape,
    inputs: [
      { ...headInput, signatureScript: "" },
      { ...fundingInput, signatureScript: "" },
    ],
  });
  return new sdk.Transaction({
    ...shape,
    inputs: [
      {
        ...headInput,
        signatureScript: sdk.payToScriptHashSignatureScript(
          redeemScript,
          buildKip10AdditiveBorrowArgs(),
        ),
      },
      {
        ...fundingInput,
        signatureScript: sdk.createInputSignature(
          unsigned,
          1,
          payerPrivateKey,
          sdk.SighashType.All,
        ),
      },
    ],
  });
}

function legacyP2pkInput(transactionId, inputAmount) {
  return {
    previousOutpoint: { transactionId, index: 0 },
    sequence: 0n,
    sigOpCount: 1,
    utxo: {
      outpoint: { transactionId, index: 0 },
      amount: inputAmount,
      scriptPublicKey: payerScript,
      blockDaaScore: 0n,
      isCoinbase: false,
    },
  };
}

function computeBudgetInput(transactionId, inputAmount, scriptPublicKey) {
  return {
    previousOutpoint: { transactionId, index: 0 },
    sequence: 0n,
    sigOpCount: 0,
    computeBudget: 10,
    utxo: {
      outpoint: { transactionId, index: 0 },
      amount: inputAmount,
      scriptPublicKey,
      blockDaaScore: 0n,
      isCoinbase: false,
    },
  };
}

function evidence(transaction, { profile, merchantGain }) {
  const object = transaction.serializeToObject();
  const inputAmount = object.inputs.reduce(
    (sum, input) => sum + BigInt(input.utxo.amount),
    0n,
  );
  const outputAmount = object.outputs.reduce(
    (sum, output) => sum + BigInt(output.value),
    0n,
  );
  const paidFee = inputAmount - outputAmount;
  if (merchantGain !== amount || paidFee !== fee) {
    throw new Error(`${profile} offline accounting invariant failed`);
  }
  return {
    profile,
    transactionId: transaction.id,
    version: Number(object.version),
    merchantGainSompi: merchantGain.toString(),
    payerCostSompi: (amount + paidFee).toString(),
    feeSompi: paidFee.toString(),
    mass: sdk.calculateTransactionMass(networkId, transaction).toString(),
    minimumFeeSompi: BigInt(
      sdk.calculateTransactionFee(networkId, transaction) ?? 0,
    ).toString(),
    computeBudgets: object.inputs.map((input) =>
      Number(input.computeBudget ?? 0),
    ),
    inputCount: object.inputs.length,
    outputCount: object.outputs.length,
  };
}
