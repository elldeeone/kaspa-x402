// Runs only against installed public SDK packages. Chain observations are fixtures.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as core from "@kaspa-x402/core";
import * as covenant from "@kaspa-x402/covenant";
import { signHashChainExactTransaction } from "@kaspa-x402/client";
import { DirectModeServer, HashChainExactTransactionVerifier, MemoryServerChannelStore, MemoryChannelLockManager } from "@kaspa-x402/server";
import { HashChainGrantIssuer, hashChainGrantClaimDigest } from "@kaspa-x402/server/hash-chain-grants";
import { schnorr } from "@noble/curves/secp256k1.js";
import { scriptPublicKeyForAddress } from "./sdk-native-address.mjs";

const result = [];
for (const network of ["kaspa:testnet-10", "kaspa:mainnet"]) {
  const fixture = await import(network === "kaspa:mainnet" ? "./mock-mainnet.mjs" : "./mock-testnet.mjs");
  const { client, server } = fixture.createMockDirectModeEnvironment();
  if (network === "kaspa:mainnet") {
    const env = fixture.createMockDirectModeEnvironment();
    assert.throws(() => new DirectModeServer({ network, payTo: fixture.PAYOUT_ADDRESS, amount: "100000",
      store: new MemoryServerChannelStore(), chainProvider: env.chainProvider, addressCodec: env.addressCodec }), /allowMainnet/);
    const { DirectModeClient } = await import("@kaspa-x402/client");
    assert.throws(() => new DirectModeClient({ fundingProvider: env.fundingProvider, store: env.clientStore, addressCodec: env.addressCodec }), /allowMainnet/);
  }
  let handlers = 0;
  for (const scheme of ["exact", "batch-settlement"]) {
    const url = scheme === "exact" ? "https://api.example.test/exact-download" : "https://api.example.test/metered";
    const route = { routeAccess: "public", url, resource: { url }, paymentScheme: scheme,
      requestHash: fixture.mockRequestHash({ network, scheme }), admissionKey: "12".repeat(32) };
    const required = await server.handlePaidRequest(route, () => { throw Error("unpaid handler ran"); });
    assert.equal(required.status, 402);
    const offer = core.decodePaymentRequiredHeader(required.headers["PAYMENT-REQUIRED"]);
    assert.equal(offer.accepts[0].network, network);
    const payment = await client.createPayment(required.headers["PAYMENT-REQUIRED"], {
      url, requestHash: fixture.mockRequestHash({ network, scheme }), paymentIdentifier: `network_${scheme.replaceAll("-", "_")}_proof`,
    });
    if (scheme === "batch-settlement") {
      assert.ok(payment.paymentPayload.payload.escrowAddress.startsWith(network === "kaspa:mainnet" ? "kaspa:" : "kaspatest:"),
        "batch address must use the selected network");
      assert.equal(scriptPublicKeyForAddress(payment.paymentPayload.payload.escrowAddress, network), payment.channel.activeScriptPublicKey);
      assert.throws(() => scriptPublicKeyForAddress(payment.paymentPayload.payload.escrowAddress,
        network === "kaspa:mainnet" ? "kaspa:testnet-10" : "kaspa:mainnet"), /prefix/);
    }
    const paid = { ...route, headers: { "PAYMENT-SIGNATURE": core.encodePaymentSignatureHeader(payment.paymentPayload) } };
    const before = handlers;
    const first = await server.handlePaidRequest(paid, () => { handlers++; return { body: "paid" }; });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const retry = await server.handlePaidRequest(paid, () => { handlers++; throw Error("retry handler ran"); });
    assert.equal(retry.status, 200); assert.equal(handlers, before + 1);
    result.push({ network, profile: scheme === "exact" ? "standard-native" : "batch-settlement", retry: true });
  }
  // Exercise additive challenge selection, network-bound payer authorization and
  // successor application through the SDK; chain verification is controlled.
  const env = fixture.createMockDirectModeEnvironment();
  const redeem = covenant.buildKip10AdditiveRedeemScript({ ownerPublicKey: "aa".repeat(32), amount: "10000" });
  const script = covenant.serializedScriptPublicKey(covenant.payToScriptHashScript(redeem));
  const book = { scriptPublicKeyForAddress: () => script, encodeScriptAddress: () => fixture.PAYOUT_ADDRESS };
  const store = new MemoryServerChannelStore();
  const additive = new DirectModeServer({ network, allowMainnet: network === "kaspa:mainnet", confirmationThreshold: 30,
    minimumExactAdditiveThresholdSompi: "10000",
    payTo: fixture.PAYOUT_ADDRESS, amount: "20000", store, addressCodec: book, chainProvider: env.chainProvider,
    exactProfile: "additive", exactSettlementReconciler: { reconcileExactSettlement: async a => ({ status: "unknown", transactionId: a.transactionId }) },
    exactTransactionVerifier: { verifyExactPayment: async r => {
      const transactionId = fixture.mockHash(`chain-broadcast:${r.transaction}`);
      return { transactionId, finality: "accepted", payerAddress: fixture.REFUND_ADDRESS,
        paymentOutput: { amount: r.amount, scriptPublicKey: r.payToScriptPublicKey },
        continuation: { outpoint: { txid: transactionId, index: 0 }, amount: (BigInt(r.head.headAmount) + BigInt(r.amount)).toString(), scriptPublicKey: script },
        requestAuthorization: { authorizationId: core.exactRequestAuthorizationId(r.authorization), digest: r.authorization.digest, inputIndex: r.authorization.inputIndex, publicKey: fixture.CLIENT_PUBLIC_KEY } };
    } } });
  const headId = "31".repeat(32), now = new Date().toISOString();
  await store.registerExactHead({ headId, network, payTo: fixture.PAYOUT_ADDRESS, templateId: "kaspa-x402-kip10-additive-v1",
    transactionEncoding: "kaspa-sdk-safe-json-v2.0.0", currentOutpoint: { txid: "32".repeat(32), index: 0 }, currentAmount: "100000",
    scriptPublicKey: script, redeemScript: redeem, additiveThresholdSompi: "10000", version: "0", status: "available", createdAt: now, updatedAt: now });
  const url = "https://api.example.test/exact-download";
  const route = { routeAccess: "public", url, resource: { url }, paymentScheme: "exact",
    requestHash: fixture.mockRequestHash({ network, profile: "additive" }), admissionKey: "34".repeat(32) };
  const offer = await additive.handlePaidRequest(route, () => { throw Error("unpaid additive ran"); });
  assert.equal(offer.status, 402, JSON.stringify(offer.body));
  // This fixture's default payer permits only standard payments; configure the
  // explicit additive authorization policy rather than bypassing client checks.
  const { DirectModeClient } = await import("@kaspa-x402/client");
  const payer = new DirectModeClient({ allowMainnet: network === "kaspa:mainnet", fundingProvider: env.fundingProvider,
    store: env.clientStore, addressCodec: book, confirmationThreshold: 30,
    fundingPolicy: { requiredSource: "hot-wallet", allowedOrigins: ["https://api.example.test"], allowedExactProfiles: ["additive"],
      allowedPayTo: [fixture.PAYOUT_ADDRESS], maximumExactAmountSompi: "20000" } });
  const payment = await payer.createPayment(offer.headers["PAYMENT-REQUIRED"], { url, requestHash: fixture.mockRequestHash({ network, profile: "additive" }), paymentIdentifier: "network_additive_proof" });
  const paid = { ...route, headers: { "PAYMENT-SIGNATURE": core.encodePaymentSignatureHeader(payment.paymentPayload) } };
  const response = await additive.handlePaidRequest(paid, () => ({ body: "paid additive" }));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const advanced = await store.loadExactHead(headId); assert.equal(advanced.currentAmount, "120000");
  result.push({ network, profile: "additive", successorApplied: true });

  await hashChain(network);
  result.push({ network, profile: "hash-chain-additive", signatures: "real", restartRetry: true });
}
console.log(JSON.stringify({ ok: true, profiles: result, evidenceBoundary: "Installed SDK, synthetic chain facts, no broadcast" }));

async function hashChain(network) {
  const secret = Buffer.alloc(32, 7), payerPublic = Buffer.from(schnorr.getPublicKey(secret)).toString("hex"), payerScript = `000020${payerPublic}ac`;
  const owner = "56b328b30c8bf5839e24058747879408bdb36241dc9c2e7c619faa12b2920967";
  const chain = covenant.generateHashChainBorrowGrants(2), headId = "41".repeat(32), covenantId = "42".repeat(32);
  const head = { outpoint: { txid: "43".repeat(32), index: 0 }, amount: "100000000", guard: chain.initialGuard,
    covenantId, scriptPublicKey: covenant.hashChainHeadScriptPublicKey({ ownerPublicKey: owner, guard: chain.initialGuard }) };
  const db = path.resolve(network === "kaspa:mainnet" ? "mainnet-grants.sqlite" : "testnet-grants.sqlite");
  const opts = { databasePath: db, allowMainnet: network === "kaspa:mainnet", encryptionKey: Buffer.alloc(32, 19),
    admissionPolicy: { maxGrantsPerClaimant: 10, windowSeconds: 60, resolveFundingOutpoint: async c => ({ txid: c.grantId, index: 0 }) } };
  let issuer = await HashChainGrantIssuer.open(opts);
  try {
    issuer.installHead({ headId, network, ownerPublicKey: owner, head, grants: chain.grants });
    let selected;
    const view = { network, getAcceptedOrigins: async outpoints => outpoints.map(o => o.txid === head.outpoint.txid
      ? { amount: head.amount, scriptPublicKey: head.scriptPublicKey, covenantId }
      : { amount: "50000000", scriptPublicKey: payerScript, covenantId: null }),
      getSelectedTransaction: async txid => selected?.transactionId === txid ? selected : null };
    const nextScript = covenant.hashChainHeadScriptPublicKey({ ownerPublicKey: owner, guard: chain.grants[0].revealedGuard });
    const prefix = network === "kaspa:mainnet" ? "kaspa" : "kaspatest";
    const resource = { url: "https://api.example.test/hash-chain" }, context = { principal: "network-proof" };
    const requestHash = core.bindRequestHashToTrustedContext(core.sha256Hex(core.stableStringify({ method: "GET", url: resource.url, body: null })), context);
    const config = { network, allowMainnet: network === "kaspa:mainnet", confirmationThreshold: 30, payTo: `${prefix}:merchant`, amount: "20000000",
      store: new MemoryServerChannelStore(), lockManager: new MemoryChannelLockManager(), exactProfile: "hash-chain-additive", addressCodec: {
        scriptPublicKeyForAddress: () => nextScript, encodeScriptAddress: () => `${prefix}:head` },
      exactTransactionVerifier: new HashChainExactTransactionVerifier(view, 10_000_000n, 8, { network, allowMainnet: network === "kaspa:mainnet" }), hashChainIssuer: issuer, hashChainHeadId: headId,
      hashChainGrantClaimUrl: "https://api.example.test/grant", admitHashChainChallenge: async () => true,
      hashChainIsSelected: async txid => (await view.getSelectedTransaction(txid)) !== null,
      hashChainGetCurrentUtxo: async () => issuer.getCurrent(headId).head };
    let runtime = new DirectModeServer(config);
    const mismatch = new DirectModeServer({ ...config, store: new MemoryServerChannelStore(),
      network: network === "kaspa:mainnet" ? "kaspa:testnet-10" : "kaspa:mainnet", allowMainnet: true });
    await assert.rejects(mismatch.claimHashChainGrant({}, context), /network/);
    const route = { routeAccess: "authenticated", url: resource.url, resource, trustedSecurityContext: context,
      paymentScheme: "exact", admissionKey: "45".repeat(32) };
    const unpaid = await runtime.handlePaidRequest(route, () => { throw Error("unpaid hash-chain ran"); });
    assert.equal(unpaid.status, 402, JSON.stringify(unpaid.body));
    const accepted = core.decodePaymentRequiredHeader(unpaid.headers["PAYMENT-REQUIRED"]).accepts[0], e = accepted.extra;
    const unsigned = { grantId: e.grantId, challengeId: e.challengeId, requestHash, payerPublicKey: payerPublic, expiresAt: new Date(Date.now() + 10000).toISOString() };
    const claim = { ...unsigned, signature: Buffer.from(schnorr.sign(hashChainGrantClaimDigest(network, unsigned), secret)).toString("hex") };
    const grant = await runtime.claimHashChainGrant(claim, context);
    issuer.close();
    if (network === "kaspa:mainnet") {
      const disabled = await HashChainGrantIssuer.open({ ...opts, allowMainnet: false });
      try { assert.throws(() => disabled.getCurrent(headId), /allowMainnet/); }
      finally { disabled.close(); }
    }
    issuer = await HashChainGrantIssuer.open(opts);
    runtime = new DirectModeServer({ ...config, hashChainIssuer: issuer });
    assert.deepEqual(await runtime.claimHashChainGrant(claim, context), grant);
    const wrongNetwork = network === "kaspa:mainnet" ? "kaspa:testnet-10" : "kaspa:mainnet";
    const retagged = { ...claim, signature: Buffer.from(schnorr.sign(hashChainGrantClaimDigest(wrongNetwork, unsigned), secret)).toString("hex") };
    await assert.rejects(runtime.claimHashChainGrant(retagged, context), /signature/);
    const signingRequest = {
      network, profile: "hash-chain-additive", amount: accepted.amount, origin: "https://api.example.test", resourceUrl: resource.url,
      payTo: accepted.payTo, payToScriptPublicKey: e.payToScriptPublicKey, paymentOutputIndex: 0, requestHash,
      paymentRequirementsHash: core.sha256Hex(core.stableStringify(accepted)), paymentIdentifier: "network_hash_chain_proof",
      attemptId: "46".repeat(32), intentHash: "47".repeat(32), authorizationExpiresAt: e.challengeExpiresAt,
      hashChainHead: { ...e, grantClaimUrl: e.grantClaimUrl }, grant };
    const signed = signHashChainExactTransaction({ request: signingRequest,
      funding: { outpoint: { txid: "48".repeat(32), index: 0 }, amount: "50000000", scriptPublicKey: payerScript,
        privateKey: secret.toString("hex"), payerAddress: `${prefix}:payer` }, feeSompi: "300000" });
    const artifact = JSON.parse(signed.transaction);
    selected = { transactionId: signed.transactionId, finality: "accepted", spentHead: head.outpoint,
      successor: { amount: artifact.outputs[0].value, scriptPublicKey: nextScript, covenantId, authorizingInput: 0 } };
    if (network === "kaspa:mainnet") {
      await assert.rejects(async () => new HashChainExactTransactionVerifier(view).verifyExactPayment({ ...signingRequest,
        transaction: signed.transaction, transactionEncoding: signed.transactionEncoding, authorization: signed.authorization }), /network|allowMainnet/);
    }
    const payload = { x402Version: 2, accepted, payload: { type: "exact-transaction", profile: "hash-chain-additive",
      transaction: signed.transaction, transactionEncoding: signed.transactionEncoding, paymentOutputIndex: 0,
      authorization: signed.authorization, grantId: e.grantId, challengeId: e.challengeId, requestHash, payerAddress: `${prefix}:payer` },
      extensions: { "payment-identifier": core.paymentIdentifierExtension({ required: true, id: "network_hash_chain_proof" }) } };
    const paid = { ...route, headers: { "PAYMENT-SIGNATURE": core.encodePaymentSignatureHeader(payload) } };
    await runtime.verifyPayment({ routeAccess: "public", paymentPayload: payload,
      paymentRequirements: accepted, resource, requestHash });
    let calls = 0;
    assert.equal((await runtime.handlePaidRequest(paid, () => { calls++; return { body: "paid hash-chain" }; })).status, 200);
    assert.equal((await runtime.handlePaidRequest(paid, () => { calls++; throw Error("hash retry ran"); })).status, 200);
    assert.equal(calls, 1); assert.equal(issuer.getCurrent(headId).headVersion, 1);
  } finally { issuer.close(); fs.rmSync(db, { force: true }); }
}
