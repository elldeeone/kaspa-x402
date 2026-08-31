import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { schnorr } from "@noble/curves/secp256k1.js";
import {
  bytesToHex,
  exactRequestAuthorizationDigest,
  sha256Hex,
  stableStringify,
} from "@kaspa-x402/core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const consensus = JSON.parse(
  fs.readFileSync(
    path.join(root, "vectors/exact/consensus-profiles.json"),
    "utf8",
  ),
);
const additive = consensus.expected.additive;
const [headInput, payerInput] = additive.transaction.inputs;
if (!headInput || !payerInput)
  throw new Error(
    "additive exact consensus vector must contain head and payer inputs",
  );

const headId = "90".repeat(32);
const challengeId = "91".repeat(32);
const requestHash = "99".repeat(32);
const transactionEncoding = "kaspa-sdk-safe-json-v2.0.0";
const headRedeemScript = headInput.signatureScript.slice(4);
const payTo =
  "kaspatest:ppakk4efunamcdw5uqglluwam94r747ftxdcyw423rx8rdyx9w4r78eljka3q";
const payerAddress =
  "kaspatest:qzvfczmkedtrju0aexl0x8kqds6kpueyn4hwnewc83tky4vkup0k7mkzgqdwu";
const artifact = {
  id: additive.transactionId,
  ...additive.transaction,
  inputs: additive.transaction.inputs.map(
    ({ previousOutpoint, utxo, ...input }) => ({
      computeBudget: input.computeBudget,
      sequence: input.sequence,
      previousOutpoint: {
        transactionId: previousOutpoint.txid,
        index: previousOutpoint.index,
      },
      sigOpCount: 0,
      signatureScript: input.signatureScript,
      utxo: {
        amount: utxo.amount,
        scriptPublicKey: utxo.scriptPublicKey,
      },
    }),
  ),
  outputs: additive.transaction.outputs.map(({ amount, ...output }) => ({
    ...output,
    value: amount,
  })),
};
const extra = {
  binding: "kaspa-exact-v2",
  paymentFlow: "upfront",
  profile: "additive",
  finality: "accepted",
  transactionEncoding,
  payToScriptPublicKey: headInput.utxo.scriptPublicKey,
  templateId: "kaspa-x402-kip10-additive-v1",
  headId,
  headVersion: "0",
  expectedHeadOutpoint: headInput.previousOutpoint,
  headAmount: headInput.utxo.amount,
  headScriptPublicKey: headInput.utxo.scriptPublicKey,
  headRedeemScript,
  additiveThresholdSompi: "10000000",
  challengeId,
  challengeExpiresAt: "2099-01-01T00:00:00.000Z",
  paymentOutputIndex: 0,
  assetKind: "native",
  assetDecimals: 8,
};
const accepted = {
  scheme: "exact",
  network: "kaspa:testnet-10",
  amount: additive.amount,
  asset: "KAS",
  payTo,
  maxTimeoutSeconds: 60,
  extra,
};
const paymentRequirementsHash = sha256Hex(stableStringify(accepted));
const authorizationExpiresAt = "2099-01-01T00:00:00.000Z";
const authorizationDigest = exactRequestAuthorizationDigest({
  network: accepted.network,
  profile: "additive",
  transactionId: additive.transactionId,
  paymentOutputIndex: 0,
  amount: accepted.amount,
  payTo: accepted.payTo,
  payToScriptPublicKey: accepted.extra.payToScriptPublicKey,
  paymentRequirementsHash,
  requestHash,
  challengeId,
  inputIndex: 1,
  expiresAt: authorizationExpiresAt,
});
const authorization = {
  version: "kaspa-x402-exact-request-authorization-v1",
  inputIndex: 1,
  expiresAt: authorizationExpiresAt,
  digest: authorizationDigest,
  signature: bytesToHex(
    schnorr.sign(
      Buffer.from(authorizationDigest, "hex"),
      new Uint8Array(32).fill(7),
      new Uint8Array(32),
    ),
  ),
};
const paymentRequired = {
  x402Version: 2,
  resource: {
    url: "https://api.example.test/file",
    description: "Fixed price download",
    mimeType: "application/octet-stream",
  },
  accepts: [accepted],
};
const paymentPayload = {
  x402Version: 2,
  accepted,
  payload: {
    type: "exact-transaction",
    profile: "additive",
    payerAddress,
    transaction: JSON.stringify(artifact),
    transactionEncoding,
    paymentOutputIndex: 0,
    challengeId,
    requestHash,
    authorization,
  },
};
const settlementResponse = {
  success: true,
  transaction: additive.transactionId,
  network: "kaspa:testnet-10",
  payer: payerAddress,
  amount: additive.amount,
  extensions: {
    kaspa: {
      exactProfile: "additive",
      paymentOutputIndex: 0,
      finality: "accepted",
      requestHash,
      transactionEncoding,
      templateId: "kaspa-x402-kip10-additive-v1",
      headId,
      headVersion: "0",
      headOutpoint: headInput.previousOutpoint,
    },
  },
};
const vector = {
  kind: "x402-http",
  description:
    "HTTP header vector for the corrected KIP-10 additive exact profile.",
  paymentRequired,
  paymentPayload,
  settlementResponse,
  headers: {
    paymentRequired: encode(paymentRequired),
    paymentSignature: encode(paymentPayload),
    paymentResponse: encode(settlementResponse),
  },
};

const output = path.join(root, "vectors/x402-http/exact-transaction.json");
const rendered = `${JSON.stringify(vector, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (fs.readFileSync(output, "utf8") !== rendered) {
    throw new Error(
      `${path.relative(root, output)} is stale; run scripts/generate-exact-http-vector.mjs`,
    );
  }
  console.log(`verified ${path.relative(root, output)}`);
} else {
  fs.writeFileSync(output, rendered);
  console.log(`wrote ${path.relative(root, output)}`);
}

function encode(value) {
  return Buffer.from(stableStringify(value), "utf8").toString("base64");
}
