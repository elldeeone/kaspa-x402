// Copied into a fresh consumer; imports must resolve only installed archives.
import assert from "node:assert/strict";
import * as core from "@kaspa-x402/core";
import * as covenant from "@kaspa-x402/covenant";
import * as client from "@kaspa-x402/client";
import * as clientNode from "@kaspa-x402/client/node";
import * as server from "@kaspa-x402/server";
import * as grants from "@kaspa-x402/server/hash-chain-grants";
import * as issuer from "@kaspa-x402/server/hash-chain-issuer";
import { schnorr } from "@noble/curves/secp256k1.js";

for (const entry of [core, covenant, client, clientNode, server, grants, issuer]) assert.ok(Object.keys(entry).length);
assert.equal(core.stableStringify({ b: 2, a: 1 }), '{"a":1,"b":2}');
const owner = "56b328b30c8bf5839e24058747879408bdb36241dc9c2e7c619faa12b2920967";
const chain = covenant.generateHashChainBorrowGrants(2);
assert.equal(covenant.hashChainBorrowGuard(chain.grants[0].revealedGuard, chain.grants[0].oneTimePublicKey), chain.initialGuard);
const options = { databasePath: "consumer.sqlite", encryptionKey: Buffer.alloc(32, 19),
  admissionPolicy: { maxGrantsPerClaimant: 10, windowSeconds: 60,
    resolveFundingOutpoint: async claim => ({ txid: claim.grantId, index: 0 }) } };
let store = await grants.HashChainGrantIssuer.open(options);
try {
  const headId = "ab".repeat(32);
  store.installHead({ headId, network: "kaspa:testnet-10", ownerPublicKey: owner,
    head: { outpoint: { txid: "11".repeat(32), index: 0 }, amount: "100000000", guard: chain.initialGuard,
      covenantId: "de".repeat(32), scriptPublicKey: covenant.hashChainHeadScriptPublicKey({ ownerPublicKey: owner, guard: chain.initialGuard }) }, grants: chain.grants });
  const c = store.issueAdmittedChallenge(headId, "cd".repeat(32), 60, "20000000", "ef".repeat(32));
  const secret = Buffer.alloc(32, 7);
  const unsigned = { grantId: c.grantId, challengeId: c.challengeId, requestHash: c.requestHash,
    payerPublicKey: Buffer.from(schnorr.getPublicKey(secret)).toString("hex"), expiresAt: c.expiresAt };
  const claim = { ...unsigned, signature: Buffer.from(schnorr.sign(grants.hashChainGrantClaimDigest("kaspa:testnet-10", unsigned), secret)).toString("hex") };
  const observed = { observe: async current => ({ outpoint: current.head.outpoint, amount: current.head.amount,
    scriptPublicKey: current.head.scriptPublicKey, covenantId: current.head.covenantId }) };
  const delivered = await store.claimGrantAfterCurrentHeadObservation(headId, claim, observed);
  store.close(); store = await grants.HashChainGrantIssuer.open(options);
  assert.deepEqual(await store.claimGrantAfterCurrentHeadObservation(headId, claim, observed), delivered);
  console.log(JSON.stringify({ exports: 7, canonicalEncoding: true, covenantLink: true, durableGrantRetry: true }));
} finally { store.close(); }
