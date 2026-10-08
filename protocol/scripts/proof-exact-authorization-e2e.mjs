import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { schnorr } from "@noble/curves/secp256k1.js";
import {
  DirectModeClient,
  MemoryChannelStore,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
} from "@kaspa-x402/client";
import {
  EXACT_REQUEST_AUTHORIZATION_VERSION,
  TESTNET_10_CONFIRMATION_THRESHOLD,
  decodePaymentRequiredHeader,
  encodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  exactRequestAuthorizationDigest,
  exactRequestAuthorizationId,
  exactRequestAuthorizationPreimage,
  sha256Hex,
  stableStringify,
} from "@kaspa-x402/core";
import {
  DirectModeServer,
  MemoryServerChannelStore,
} from "@kaspa-x402/server";
import {
  NETWORK,
  PAYOUT_ADDRESS,
  REFUND_ADDRESS,
  createMockDirectModeEnvironment,
  mockHash,
  mockRequestHash,
} from "../examples/lib/mock-direct-mode.mjs";

const privateKey = new Uint8Array(32).fill(7);
const publicKey = schnorr.getPublicKey(privateKey);
const publicKeyHex = Buffer.from(publicKey).toString("hex");

/** Offline HTTP payment flow: real payer Schnorr authorization, synthetic chain settlement. */
export async function runExactAuthorizationE2EProof() {
  const environment = createMockDirectModeEnvironment();
  const { addressCodec, chainProvider, fundingProvider } = environment;
  let providerCalls = 0;
  const payExactTransaction = fundingProvider.payExactTransaction.bind(fundingProvider);
  fundingProvider.payExactTransaction = async (request) => {
    providerCalls += 1;
    const result = await payExactTransaction(request);
    return {
      ...result,
      authorization: {
        ...result.authorization,
        signature: sign(result.authorization.digest),
      },
    };
  };

  let verifierCalls = 0;
  const server = new DirectModeServer({
    confirmationThreshold: TESTNET_10_CONFIRMATION_THRESHOLD,
    network: NETWORK,
    payTo: PAYOUT_ADDRESS,
    amount: "100000",
    store: new MemoryServerChannelStore(),
    chainProvider,
    addressCodec,
    exactProfile: "standard-native",
    exactTransactionVerifier: {
      verifyExactPayment(request) {
        verifierCalls += 1;
        const transactionId = mockHash(`chain-broadcast:${request.transaction}`);
        const digest = exactRequestAuthorizationDigest({
          network: request.network,
          profile: request.profile,
          transactionId,
          paymentOutputIndex: request.paymentOutputIndex,
          amount: request.amount,
          payTo: request.payTo,
          payToScriptPublicKey: request.payToScriptPublicKey,
          paymentRequirementsHash: request.paymentRequirementsHash,
          requestHash: request.requestHash,
          paymentIdentifier: request.paymentIdentifier,
          challengeId: request.head?.challengeId,
          inputIndex: request.authorization.inputIndex,
          expiresAt: request.authorization.expiresAt,
        });
        assert.equal(request.authorization.version, EXACT_REQUEST_AUTHORIZATION_VERSION);
        assert.equal(request.authorization.digest, digest);
        assert.equal(
          schnorr.verify(
            Buffer.from(request.authorization.signature, "hex"),
            Buffer.from(digest, "hex"),
            publicKey,
          ),
          true,
        );
        return {
          transactionId,
          paymentOutput: {
            amount: request.amount,
            scriptPublicKey: request.payToScriptPublicKey,
          },
          payerAddress: REFUND_ADDRESS,
          finality: "accepted",
          requestAuthorization: {
            authorizationId: exactRequestAuthorizationId(request.authorization),
            digest,
            inputIndex: request.authorization.inputIndex,
            publicKey: publicKeyHex,
          },
        };
      },
    },
  });

  const url = "https://api.example.test/exact-authorization-e2e";
  const resource = { url, description: "Exact authorization E2E", mimeType: "application/octet-stream" };
  const amount = "100000";
  const paymentIdentifier = "offline_exact_authorization_e2e_0001";
  const requestHash = mockRequestHash({ proof: "exact-authorization-e2e", url });
  let handlerExecutions = 0;
  const handler = async () => {
    handlerExecutions += 1;
    return { status: 200, body: { ok: true, resource: "exact-authorization-e2e" } };
  };
  const route = { routeAccess: "public", method: "GET", url, body: null,
    resource, paymentAmount: amount, paymentScheme: "exact", requestHash };
  const unpaid = await server.handlePaidRequest(route, handler);
  assert.equal(unpaid.status, 402);
  assert.equal(handlerExecutions, 0);
  const paymentRequired = unpaid.headers[PAYMENT_REQUIRED_HEADER];
  assert.ok(paymentRequired);

  let approvals = 0;
  const makeClient = (store, authorizeExactPayment) => new DirectModeClient({
    addressCodec,
    fundingProvider,
    store,
    confirmationThreshold: TESTNET_10_CONFIRMATION_THRESHOLD,
    fundingPolicy: {
      requiredSource: fundingProvider.sourceKind,
      allowedOrigins: ["https://api.example.test"],
      allowedExactProfiles: ["standard-native"],
      allowedPayTo: [PAYOUT_ADDRESS],
      maximumExactAmountSompi: amount,
    },
    authorizeExactPayment,
  });
  const clientStore = new MemoryChannelStore();
  const client = makeClient(clientStore, ({ intentDigest }) => {
    approvals += 1;
    return { intentDigest };
  });
  const context = { url, paymentIdentifier, requestHash };
  const first = await client.createPayment(paymentRequired, context);
  assert.equal(first.paymentPayload.payload.type, "exact-transaction");
  assert.equal(first.paymentPayload.payload.authorization.version, EXACT_REQUEST_AUTHORIZATION_VERSION);
  assert.equal(approvals, 1);
  assert.equal(providerCalls, 1);

  const authorization = first.paymentPayload.payload.authorization;
  const authorizationPreimage = exactRequestAuthorizationPreimage({
    network: first.accepted.network,
    profile: first.paymentPayload.payload.profile,
    transactionId: first.transactionId,
    paymentOutputIndex: first.paymentPayload.payload.paymentOutputIndex,
    amount: first.accepted.amount,
    payTo: first.accepted.payTo,
    payToScriptPublicKey: first.accepted.extra.payToScriptPublicKey,
    paymentRequirementsHash: sha256Hex(stableStringify(first.accepted)),
    requestHash,
    paymentIdentifier,
    inputIndex: authorization.inputIndex,
    expiresAt: authorization.expiresAt,
  });
  assert.equal(sha256Hex(authorizationPreimage), authorization.digest);
  const legacyPreimage = stableStringify({
    scope: "kaspa-x402-exact-request-authorization-v1",
    network: first.accepted.network,
    profile: first.paymentPayload.payload.profile,
    transactionId: first.transactionId.toLowerCase(),
    paymentOutputIndex: first.paymentPayload.payload.paymentOutputIndex,
    amount: first.accepted.amount,
    payTo: first.accepted.payTo,
    payToScriptPublicKey: first.accepted.extra.payToScriptPublicKey.toLowerCase(),
    paymentRequirementsHash: sha256Hex(stableStringify(first.accepted)),
    requestHash: requestHash.toLowerCase(),
    challengeId: null,
    inputIndex: authorization.inputIndex,
    expiresAt: authorization.expiresAt,
  });
  const legacyDigest = sha256Hex(legacyPreimage);
  const legacySignature = sign(legacyDigest);
  assert.equal(schnorr.verify(Buffer.from(legacySignature, "hex"), Buffer.from(legacyDigest, "hex"), publicKey), true);
  const legacyPayload = structuredClone(first.paymentPayload);
  legacyPayload.payload.authorization = {
    ...authorization,
    version: "kaspa-x402-exact-request-authorization-v1",
    digest: legacyDigest,
    signature: legacySignature,
  };
  const legacyResponse = await server.handlePaidRequest({
    ...route,
    headers: { [PAYMENT_SIGNATURE_HEADER]: Buffer.from(stableStringify(legacyPayload)).toString("base64") },
  }, handler);
  assert.equal(legacyResponse.status, 402);
  assert.equal(handlerExecutions, 0);
  assert.equal(verifierCalls, 0);

  const changedIdentifier = structuredClone(first.paymentPayload);
  changedIdentifier.extensions["payment-identifier"].info.id = "offline_exact_authorization_e2e_0002";
  const changedIdentifierResponse = await server.handlePaidRequest({
    ...route,
    headers: { [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader(changedIdentifier) },
  }, handler);
  assert.notEqual(changedIdentifierResponse.status, 200);
  assert.equal(handlerExecutions, 0);

  const verifierCallsBeforePaid = verifierCalls;
  const paid = await server.handlePaidRequest({
    ...route,
    headers: { [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader(first.paymentPayload) },
  }, handler);
  assert.equal(paid.status, 200);
  assert.equal(handlerExecutions, 1);
  assert.equal(verifierCalls > verifierCallsBeforePaid, true);

  const attempt = await clientStore.loadExactPaymentAttemptByIdentifier(paymentIdentifier);
  assert.ok(attempt);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kaspa-x402-exact-authorization-e2e-"));
  let persistedArtifactSha256;
  let retry;
  let restartedStore;
  try {
    const artifactPath = path.join(directory, "attempt.json");
    fs.writeFileSync(artifactPath, `${JSON.stringify(attempt)}\n`, { mode: 0o600, flag: "wx" });
    persistedArtifactSha256 = sha256Hex(fs.readFileSync(artifactPath));
    restartedStore = new MemoryChannelStore();
    await restartedStore.claimExactPaymentAttempt(JSON.parse(fs.readFileSync(artifactPath, "utf8")));
    const restartedClient = makeClient(restartedStore, () => {
      throw new Error("stored retry requested new payer approval");
    });
    retry = await restartedClient.createPayment(paymentRequired, context);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  assert.deepEqual(retry.paymentPayload, first.paymentPayload);
  assert.equal(approvals, 1);
  assert.equal(providerCalls, 1);

  const changedOffer = decodePaymentRequiredHeader(paymentRequired);
  changedOffer.accepts[0].amount = "99999";
  const changedRequired = encodePaymentRequiredHeader(changedOffer);
  await assert.rejects(
    () => makeClient(restartedStore, () => {
      throw new Error("changed intent requested new payer approval");
    }).createPayment(changedRequired, context),
    { code: "invalid_kaspa_exact_replay" },
  );
  assert.equal(approvals, 1);
  assert.equal(providerCalls, 1);

  const cached = await server.handlePaidRequest({
    ...route,
    headers: { [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader(retry.paymentPayload) },
  }, handler);
  assert.equal(cached.status, 200);
  assert.deepEqual(cached.body, paid.body);
  assert.equal(handlerExecutions, 1);

  return {
    signedDomain: authorization.version,
    payerPublicKey: publicKeyHex,
    authorization: { preimage: authorizationPreimage, digest: authorization.digest,
      signature: authorization.signature },
    oldDomain: { preimage: legacyPreimage, digest: legacyDigest, signature: legacySignature,
      signatureValid: true, status: legacyResponse.status, rejectedBeforeVerifier: true },
    changedIdentifierStatus: changedIdentifierResponse.status,
    paidStatus: paid.status,
    retry: { persistedArtifactSha256, approvalCalls: approvals, providerCalls,
      changedIntentRejected: true,
      cachedStatus: cached.status, handlerExecutions },
    chain: "synthetic offline settlement",
  };
}

function sign(digest) {
  return Buffer.from(schnorr.sign(Buffer.from(digest, "hex"), privateKey)).toString("hex");
}
