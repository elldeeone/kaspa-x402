#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  paymentIdentifierExtension,
  sha256Hex,
  stableStringify,
} from "@kaspa-x402/core";
import { signHashChainExactTransaction } from "@kaspa-x402/client";
import { parseHashChainHeadRedeemScript, hashChainHeadScriptPublicKey } from "@kaspa-x402/covenant";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const oracle = JSON.parse(fs.readFileSync(path.join(root, "vectors/hash-chain/consensus-v1.json"), "utf8")).expected;
const step = oracle.transactions.borrow1;
const headInput = step.transaction.inputs[0];
const fundingInput = step.transaction.inputs[1];
const redeemScript = Buffer.from(headInput.signatureScript, "hex").subarray(140).toString("hex");
const ownerPublicKey = parseHashChainHeadRedeemScript(redeemScript).ownerPublicKey;
const nextScript = hashChainHeadScriptPublicKey({ ownerPublicKey, guard: oracle.chain.firstRevealedGuard });
const payTo = "kaspatest:pzjuqtpm8h09dy96xqzcrcgw4qrzd8xr8uu7r89gnte875h8r6x4xs5h4ygzq";
const payerAddress = "kaspatest:qzvfczmkedtrju0aexl0x8kqds6kpueyn4hwnewc83tky4vkup0k7mkzgqdwu";
const resource = { url: "https://api.example.test/hash-chain/file", description: "One-use hash-chain payment", mimeType: "application/octet-stream" };
const requestHash = sha256Hex(stableStringify({ method: "GET", url: resource.url, body: null }));
const headId = "90".repeat(32);
const grantId = "91".repeat(32);
const challengeId = "92".repeat(32);
const expiresAt = "2099-01-01T00:00:00.000Z";
const extra = {
  binding: "kaspa-hash-chain-exact-v1", profile: "hash-chain-additive",
  assetTransferMethod: "kaspa-v1-hash-chain-proof", paymentFlow: "upfront",
  templateId: "kaspa-x402-hash-chain-head-v2", finality: "accepted",
  transactionEncoding: "kaspa-sdk-safe-json-v2.0.0", payToScriptPublicKey: nextScript,
  headId, headVersion: "0", covenantId: oracle.covenantId,
  expectedHeadOutpoint: headInput.previousOutpoint,
  headAmount: headInput.utxo.amount, headScriptPublicKey: headInput.utxo.scriptPublicKey,
  headRedeemScript: redeemScript, currentGuard: oracle.chain.initialGuard,
  nextGuard: oracle.chain.firstRevealedGuard,
  oneTimePublicKey: oracle.chain.firstOneTimePublicKey,
  grantId, grantClaimUrl: "https://api.example.test/hash-chain/grant",
  challengeId, challengeIssuedAt: "2098-12-31T23:59:00.000Z",
  challengeExpiresAt: expiresAt, paymentOutputIndex: 0,
};
const accepted = {
  scheme: "exact", network: "kaspa:testnet-10", amount: step.amount,
  asset: "KAS", payTo, maxTimeoutSeconds: 60, extra,
};
const paymentIdentifier = "hash_chain_vector_0001";
const paymentRequired = {
  x402Version: 2, resource, accepts: [accepted],
  extensions: { "payment-identifier": paymentIdentifierExtension({ required: true }) },
};
const signed = signHashChainExactTransaction({
  request: {
    attemptId: "93".repeat(32), intentHash: "94".repeat(32),
    network: "kaspa:testnet-10", profile: "hash-chain-additive",
    origin: "https://api.example.test", resourceUrl: resource.url,
    amount: accepted.amount, payTo, payToScriptPublicKey: nextScript,
    paymentOutputIndex: 0, requestHash,
    paymentRequirementsHash: sha256Hex(stableStringify(accepted)),
    authorizationExpiresAt: expiresAt,
    hashChainHead: extra,
    grant: {
      grantId, headVersion: 0, nextGuard: extra.nextGuard,
      oneTimePublicKey: extra.oneTimePublicKey,
      oneTimePrivateKey: "0c".repeat(32), expiresAt,
    },
  },
  funding: {
    outpoint: fundingInput.previousOutpoint,
    amount: fundingInput.utxo.amount,
    scriptPublicKey: fundingInput.utxo.scriptPublicKey,
    privateKey: "07".repeat(32), payerAddress,
  },
  feeSompi: step.fee,
  schnorrAuxRand: new Uint8Array(32),
});
if (signed.transactionId !== step.transactionId) throw new Error("x402 signed proof drifted from Rusty-Kaspa consensus vector");
const paymentPayload = {
  x402Version: 2, accepted,
  payload: {
    type: "exact-transaction", profile: "hash-chain-additive",
    payerAddress, transaction: signed.transaction,
    transactionEncoding: signed.transactionEncoding,
    paymentOutputIndex: 0, grantId, challengeId, requestHash,
    authorization: signed.authorization,
  },
  extensions: { "payment-identifier": paymentIdentifierExtension({ required: true, id: paymentIdentifier }) },
};
const settlementResponse = {
  success: true, transaction: signed.transactionId, network: accepted.network,
  payer: payerAddress, amount: accepted.amount,
  extensions: { kaspa: {
    exactProfile: "hash-chain-additive", paymentOutputIndex: 0, finality: "accepted",
    requestHash, transactionEncoding: signed.transactionEncoding,
    templateId: extra.templateId, headId, headVersion: "0",
    headOutpoint: extra.expectedHeadOutpoint, covenantId: extra.covenantId, grantId,
  } },
};
const encode = (value) => Buffer.from(stableStringify(value)).toString("base64");
const vector = {
  kind: "x402-http",
  description: "Native-KAS hash-chain upfront exact payment over x402 v2, signed against the Rusty-Kaspa consensus borrow vector.",
  paymentRequired, paymentPayload, settlementResponse,
  headers: {
    paymentRequired: encode(paymentRequired), paymentSignature: encode(paymentPayload),
    paymentResponse: encode(settlementResponse),
  },
};
const output = path.join(root, "vectors/x402-http/hash-chain-exact.json");
const rendered = `${JSON.stringify(vector, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (fs.readFileSync(output, "utf8") !== rendered) throw new Error("hash-chain HTTP vector is stale");
  console.log("verified vectors/x402-http/hash-chain-exact.json");
} else {
  fs.writeFileSync(output, rendered);
  console.log("wrote vectors/x402-http/hash-chain-exact.json");
}
