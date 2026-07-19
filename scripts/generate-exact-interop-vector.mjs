import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  exactAuthorizationExpiryError,
  exactRequestAuthorizationPreimage,
  sha256Hex,
  stableStringify,
} from "@kaspa-x402/core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const consensus = readJson("vectors/exact/consensus-profiles.json");
const http = readJson("vectors/x402-http/exact-transaction.json");
const standard = consensus.expected.standardNative;
const additive = consensus.expected.additive;
const accepted = http.paymentPayload.accepted;
const payload = http.paymentPayload.payload;
const referenceTime = "2098-12-31T23:59:00.000Z";
const referenceNowMs = Date.parse(referenceTime);

const requirementsPreimage = stableStringify(accepted);
const paymentRequirementsHash = sha256Hex(requirementsPreimage);
const authorizationInput = {
  network: accepted.network,
  profile: accepted.extra.profile,
  transactionId: additive.transactionId,
  paymentOutputIndex: payload.paymentOutputIndex,
  amount: accepted.amount,
  payTo: accepted.payTo,
  payToScriptPublicKey: accepted.extra.payToScriptPublicKey,
  paymentRequirementsHash,
  requestHash: payload.requestHash,
  challengeId: payload.challengeId,
  inputIndex: payload.authorization.inputIndex,
  expiresAt: payload.authorization.expiresAt,
};
const authorizationPreimage =
  exactRequestAuthorizationPreimage(authorizationInput);
const authorizationDigest = sha256Hex(authorizationPreimage);
if (authorizationDigest !== payload.authorization.digest) {
  throw new Error("exact authorization vector digest is inconsistent");
}

const expiryCases = [
  expiryCase("standard-valid", "standard-native", "2099-01-01T00:00:00.000Z"),
  expiryCase("standard-expired", "standard-native", referenceTime),
  expiryCase(
    "standard-beyond-timeout",
    "standard-native",
    "2099-01-01T00:00:00.001Z",
  ),
  expiryCase(
    "additive-valid-at-challenge",
    "additive",
    "2099-01-01T00:00:00.000Z",
    "2099-01-01T00:00:00.000Z",
  ),
  expiryCase(
    "additive-authorization-after-challenge",
    "additive",
    "2098-12-31T23:59:45.000Z",
    "2098-12-31T23:59:30.000Z",
  ),
  expiryCase(
    "additive-expired-challenge",
    "additive",
    "2099-01-01T00:00:00.000Z",
    referenceTime,
  ),
];

const vector = {
  kind: "exact-interop-v1",
  description:
    "Language-independent transaction-id, authorization, expiry, and finality vectors for the Kaspa exact v2 profiles.",
  transactionEncoding: {
    name: "kaspa-sdk-safe-json-v2.0.0",
    note: "The JSON text is an interchange envelope. Transaction identifiers are computed from the normalized consensus fields, not from the JSON bytes or object-key order.",
    profiles: {
      standardNative: {
        artifact: safeArtifact(standard),
        transactionId: standard.transactionId,
        txid: standard.txid,
      },
      additive: {
        artifact: JSON.parse(payload.transaction),
        transactionId: additive.transactionId,
        txid: additive.txid,
      },
    },
  },
  paymentRequirements: {
    value: accepted,
    canonicalJsonUtf8: requirementsPreimage,
    sha256: paymentRequirementsHash,
  },
  requestAuthorization: {
    input: authorizationInput,
    canonicalJsonUtf8: authorizationPreimage,
    sha256: authorizationDigest,
    signerPublicKey: payerPublicKey(
      additive.transaction.inputs[1].utxo.scriptPublicKey,
    ),
    signature: payload.authorization.signature,
    expected: "valid-schnorr-signature",
  },
  expiry: {
    referenceTime,
    maxTimeoutSeconds: accepted.maxTimeoutSeconds,
    rule: "authorization expiry must be future, no later than reference time plus maxTimeoutSeconds, and no later than challenge expiry when a challenge exists",
    cases: expiryCases,
  },
  finality: {
    ordering: ["mempool", "accepted", "confirmed"],
    cases: [
      { actual: "mempool", required: "accepted", expected: false },
      { actual: "accepted", required: "accepted", expected: true },
      { actual: "accepted", required: "confirmed", expected: false },
      { actual: "confirmed", required: "accepted", expected: true },
      { actual: "confirmed", required: "confirmed", expected: true },
    ],
  },
};

const output = path.join(root, "vectors/exact/interop-v1.json");
const rendered = `${JSON.stringify(vector, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (!fs.existsSync(output) || fs.readFileSync(output, "utf8") !== rendered) {
    throw new Error(
      `${path.relative(root, output)} is stale; run scripts/generate-exact-interop-vector.mjs`,
    );
  }
  console.log(`verified ${path.relative(root, output)}`);
} else {
  fs.writeFileSync(output, rendered);
  console.log(`wrote ${path.relative(root, output)}`);
}

function expiryCase(name, profile, authorizationExpiresAt, challengeExpiresAt) {
  const error = exactAuthorizationExpiryError({
    maxTimeoutSeconds: 60,
    authorizationExpiresAt,
    ...(challengeExpiresAt ? { challengeExpiresAt } : {}),
    nowMs: referenceNowMs,
  });
  return {
    name,
    profile,
    authorizationExpiresAt,
    ...(challengeExpiresAt ? { challengeExpiresAt } : {}),
    expected: error ?? "valid",
  };
}

function safeArtifact(profile) {
  return {
    id: profile.transactionId,
    version: profile.transaction.version,
    inputs: profile.transaction.inputs.map((input) => ({
      previousOutpoint: {
        transactionId: input.previousOutpoint.txid,
        index: input.previousOutpoint.index,
      },
      sequence: input.sequence,
      sigOpCount: input.sigOpCount ?? 0,
      ...(typeof input.computeBudget === "number"
        ? { computeBudget: input.computeBudget }
        : {}),
      signatureScript: input.signatureScript,
      utxo: {
        amount: input.utxo.amount,
        scriptPublicKey: input.utxo.scriptPublicKey,
      },
    })),
    outputs: profile.transaction.outputs.map((output) => ({
      value: output.amount,
      scriptPublicKey: output.scriptPublicKey,
      covenant: output.covenant,
    })),
    lockTime: profile.transaction.lockTime,
    subnetworkId: profile.transaction.subnetworkId,
    gas: profile.transaction.gas,
    payload: profile.transaction.payload,
    storageMass: profile.transaction.storageMass,
  };
}

function payerPublicKey(serializedScriptPublicKey) {
  if (!/^000020[0-9a-f]{64}ac$/.test(serializedScriptPublicKey)) {
    throw new Error(
      "exact payer input is not a canonical version-0 P2PK script",
    );
  }
  return serializedScriptPublicKey.slice(6, 70);
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}
