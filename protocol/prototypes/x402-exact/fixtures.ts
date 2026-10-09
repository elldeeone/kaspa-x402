/** Test fixtures only. Chain/UTXO validation remains in the existing verifier. */
import { readFileSync } from "node:fs";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  exactRequestAuthorizationDigest,
  paymentIdentifierExtension,
  sha256Hex,
  stableStringify,
  type ExactPaymentRequirements,
  type ExactTransactionPayload,
  type PaymentPayload,
} from "@kaspa-x402/core";

function read(path: string) {
  return JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"));
}

export const NOW = Date.parse("2098-12-31T23:59:00.000Z");
export const NETWORK = "kaspa:testnet-10";
export const PROFILES = ["standard-native", "additive", "hash-chain-additive"] as const;
const KEY = new Uint8Array(32).fill(7); // Published vector key, never a funded wallet.
export const PAYER_KEY = schnorr.getPublicKey(KEY);

export function fixture(profile: typeof PROFILES[number]): { payment: PaymentPayload; transactionId: string } {
  const vector = read(profile === "hash-chain-additive"
    ? "vectors/x402-http/hash-chain-exact.json"
    : "vectors/x402-http/exact-transaction.json");
  const payment: PaymentPayload = vector.paymentPayload;
  let transactionId: string = vector.settlementResponse.transaction;
  if (profile === "standard-native") {
    const standard = read("vectors/exact/interop-v1.json").transactionEncoding.profiles.standardNative;
    transactionId = standard.transactionId;
    const payload = payment.payload as ExactTransactionPayload;
    const requirements = payment.accepted as ExactPaymentRequirements;
    // Address for the merchant output in the standardNative consensus fixture.
    requirements.payTo = "kaspatest:qruer72y68se2jnlezum7chq678szh6vqamz65z7yrnvg5nq5dnpkw0ggt9lz";
    requirements.extra = {
      binding: "kaspa-exact-v2", profile, paymentFlow: "upfront", finality: "accepted",
      transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
      payToScriptPublicKey: standard.artifact.outputs[0].scriptPublicKey,
    };
    payload.profile = profile;
    payload.transaction = JSON.stringify(standard.artifact);
    payload.authorization.inputIndex = 0;
    delete payload.challengeId;
  }
  payment.extensions = { "payment-identifier": paymentIdentifierExtension({ required: true, id: "prototype_exact_payment_01" }) };
  return { payment, transactionId };
}

export function authorize(payment: PaymentPayload, transactionId: string, hash: string): PaymentPayload {
  const copy = structuredClone(payment);
  const payload = copy.payload as ExactTransactionPayload;
  payload.requestHash = hash;
  payload.authorization.expiresAt = new Date(NOW + 60_000).toISOString();
  const digest = digestFor(copy, transactionId);
  payload.authorization.digest = digest;
  payload.authorization.signature = Buffer.from(schnorr.sign(Buffer.from(digest, "hex"), KEY, new Uint8Array(32))).toString("hex");
  return copy;
}

export function digestFor(payment: PaymentPayload, transactionId: string): string {
  const payload = payment.payload as ExactTransactionPayload;
  const accepted = payment.accepted as ExactPaymentRequirements;
  return exactRequestAuthorizationDigest({
    network: accepted.network,
    profile: accepted.extra.profile,
    transactionId,
    paymentOutputIndex: payload.paymentOutputIndex,
    amount: accepted.amount,
    payTo: accepted.payTo,
    payToScriptPublicKey: accepted.extra.payToScriptPublicKey!,
    paymentRequirementsHash: sha256Hex(stableStringify(accepted)),
    requestHash: payload.requestHash,
    paymentIdentifier: (payment.extensions?.["payment-identifier"] as { info: { id: string } }).info.id,
    challengeId: payload.challengeId,
    inputIndex: payload.authorization.inputIndex,
    expiresAt: payload.authorization.expiresAt,
  });
}
