import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { schnorr } from "@noble/curves/secp256k1.js";
import { generateHashChainBorrowGrants, hashChainBorrowGuard, hashChainHeadScriptPublicKey } from "@kaspa-x402/covenant";
import { describe, expect, it } from "vitest";
import {
  HashChainGrantIssuer,
  hashChainGrantClaimDigest,
  type HashChainAcceptedTransition,
  type HashChainGrantClaim,
  type HashChainObservedHead,
} from "../src/hash-chain-grants.js";

const OWNER = "56b328b30c8bf5839e24058747879408bdb36241dc9c2e7c619faa12b2920967";
const PAYER_SECRET = Buffer.alloc(32, 7);
const OTHER_SECRET = Buffer.alloc(32, 8);
const HEAD_ID = "ab".repeat(32);
const REQUEST = "cd".repeat(32);
const COVENANT_ID = "de".repeat(32);

function observed(txid: string, guard: string, amount = "100000000"): HashChainObservedHead {
  return {
    outpoint: { txid, index: 0 }, amount, guard, covenantId: COVENANT_ID,
    scriptPublicKey: hashChainHeadScriptPublicKey({ ownerPublicKey: OWNER, guard }),
  };
}

function signedClaim(
  challenge: { grantId: string; challengeId: string; requestHash: string; expiresAt: string },
  secret = PAYER_SECRET,
): HashChainGrantClaim {
  const unsigned = {
    grantId: challenge.grantId, challengeId: challenge.challengeId,
    requestHash: challenge.requestHash,
    payerPublicKey: Buffer.from(schnorr.getPublicKey(secret)).toString("hex"),
    expiresAt: challenge.expiresAt,
  };
  return {
    ...unsigned,
    signature: Buffer.from(schnorr.sign(hashChainGrantClaimDigest("kaspa:testnet-10", unsigned), secret)).toString("hex"),
  };
}

function accepted(before: HashChainObservedHead, after: HashChainObservedHead): HashChainAcceptedTransition {
  return { finality: "accepted", predecessor: before.outpoint, successor: after };
}

describe("durable hash-chain grants", () => {
  it("commits encrypted single-payer delivery before return and recovers identical retries", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), "kaspa-hash-chain-grants-"));
    const file = path.join(folder, "grants.sqlite");
    const key = randomBytes(32);
    let now = new Date("2026-09-22T12:00:00.000Z");
    let eligible = true;
    const options = { databasePath: file, encryptionKey: key, canClaim: () => eligible, now: () => now };
    const chain = generateHashChainBorrowGrants(2);
    const head = observed("11".repeat(32), chain.initialGuard);
    const issuer = await HashChainGrantIssuer.open(options);
    issuer.installHead({ headId: HEAD_ID, network: "kaspa:testnet-10", ownerPublicKey: OWNER, head, grants: chain.grants });
    const challenge = issuer.issueChallenge(HEAD_ID, REQUEST, 60);
    const claim = signedClaim(challenge);
    const delivered = issuer.claimGrant(HEAD_ID, claim);
    expect(delivered.cacheControl).toBe("no-store");
    expect(delivered.oneTimePrivateKey).toBe(chain.grants[0]!.oneTimePrivateKey);
    expect(issuer.getDeliveryRecord(HEAD_ID, delivered.grantId)).toMatchObject({
      headVersion: 0, headOutpoint: head.outpoint, payerPublicKey: claim.payerPublicKey,
      requestHash: REQUEST, deliveryCommittedAt: delivered.deliveryCommittedAt,
    });
    expect(issuer.getCurrent(HEAD_ID)).not.toHaveProperty("oneTimePrivateKey");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o077).toBe(0);
    expect(readFileSync(file).includes(Buffer.from(delivered.oneTimePrivateKey))).toBe(false);
    issuer.close();
    await expect(HashChainGrantIssuer.open({ ...options, encryptionKey: randomBytes(32) }))
      .rejects.toThrow("encryption key is wrong");

    const recovered = await HashChainGrantIssuer.open(options);
    const otherProcess = await HashChainGrantIssuer.open(options);
    try {
      eligible = false;
      expect(recovered.claimGrant(HEAD_ID, claim)).toEqual(delivered);
      recovered.holdForReorg(HEAD_ID);
      expect(recovered.reconcileObservedHead(HEAD_ID, head).phase).toBe("assigned");
      expect(recovered.claimGrant(HEAD_ID, claim)).toEqual(delivered);
      expect(recovered.getDeliveryRecord(HEAD_ID, delivered.grantId)).not.toHaveProperty("oneTimePrivateKey");
      const other = signedClaim({ ...challenge }, OTHER_SECRET);
      expect(() => otherProcess.claimGrant(HEAD_ID, other)).toThrow("assigned to another payer");
      expect(() => otherProcess.issueChallenge(HEAD_ID, REQUEST, 60)).toThrow("unavailable");
      now = new Date("2026-09-22T12:01:01.000Z");
      expect(() => recovered.claimGrant(HEAD_ID, claim)).toThrow("live challenge");
      expect(recovered.markAbandoned(HEAD_ID).phase).toBe("needsRotation");
      expect(() => otherProcess.issueChallenge(HEAD_ID, REQUEST, 60)).toThrow("unavailable");
    } finally {
      recovered.close(); otherProcess.close(); rmSync(folder, { recursive: true, force: true });
    }
  });

  it("adopts a small accepted spend, blocks stale links, and unlocks only after accepted rotation", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), "kaspa-hash-chain-grants-"));
    const file = path.join(folder, "grants.sqlite");
    let now = new Date("2026-09-22T12:00:00.000Z");
    const issuer = await HashChainGrantIssuer.open({ databasePath: file, encryptionKey: randomBytes(32), canClaim: () => true, now: () => now });
    try {
      const chain = generateHashChainBorrowGrants(2);
      const first = observed("11".repeat(32), chain.initialGuard);
      issuer.installHead({ headId: HEAD_ID, network: "kaspa:testnet-10", ownerPublicKey: OWNER, head: first, grants: chain.grants });
      const challenge = issuer.issueChallenge(HEAD_ID, REQUEST, 60);
      issuer.claimGrant(HEAD_ID, signedClaim(challenge));

      const small = observed("22".repeat(32), chain.grants[0]!.revealedGuard, "100000001");
      expect(issuer.recordAcceptedBorrow(HEAD_ID, accepted(first, small))).toMatchObject({ headVersion: 1, phase: "ready", head: small });
      expect(issuer.getDeliveryRecord(HEAD_ID, challenge.grantId)).toMatchObject({
        headVersion: 0, headOutpoint: first.outpoint, requestHash: REQUEST,
      });
      expect(() => issuer.recordAcceptedBorrow(HEAD_ID, accepted(first, small))).toThrow("current head");
      const secondChallenge = issuer.issueChallenge(HEAD_ID, REQUEST, 60);
      issuer.claimGrant(HEAD_ID, signedClaim(secondChallenge));
      now = new Date("2026-09-22T12:01:01.000Z");
      issuer.markAbandoned(HEAD_ID);
      const replacement = generateHashChainBorrowGrants(1);
      const rotated = observed("33".repeat(32), replacement.initialGuard, small.amount);
      expect(() => issuer.recordAcceptedRotation(HEAD_ID, accepted(first, rotated), replacement.grants)).toThrow("current head");
      expect(issuer.recordAcceptedRotation(HEAD_ID, accepted(small, rotated), replacement.grants)).toMatchObject({
        headVersion: 2, phase: "ready", head: rotated,
      });
      expect(() => issuer.recordAcceptedBorrow(HEAD_ID, accepted(small, observed("44".repeat(32), chain.grants[1]!.revealedGuard)))).toThrow("current head");
      expect(issuer.issueChallenge(HEAD_ID, REQUEST, 60).headVersion).toBe(2);
      issuer.holdForReorg(HEAD_ID);
      expect(issuer.reconcileObservedHead(HEAD_ID, small).phase).toBe("needsRotation");
      const borrowerWins = observed("44".repeat(32), chain.grants[1]!.revealedGuard, "100000002");
      expect(issuer.recordAcceptedBorrow(HEAD_ID, accepted(small, borrowerWins))).toMatchObject({
        headVersion: 3, phase: "exhausted", head: borrowerWins,
      });
      expect(issuer.recordAcceptedSweep(HEAD_ID, {
        finality: "accepted", predecessor: borrowerWins.outpoint,
        transactionId: "55".repeat(32), sameIdOutputCount: 0,
      }).phase).toBe("retired");
      expect(() => issuer.issueChallenge(HEAD_ID, REQUEST, 60)).toThrow("unavailable");
      issuer.holdForReorg(HEAD_ID);
      expect(issuer.reconcileObservedHead(HEAD_ID, borrowerWins).phase).toBe("needsRotation");
    } finally {
      issuer.close(); rmSync(folder, { recursive: true, force: true });
    }
  });

  it("holds issuance across a reorg and requires rotation if an exposed predecessor returns", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), "kaspa-hash-chain-grants-"));
    const issuer = await HashChainGrantIssuer.open({ databasePath: path.join(folder, "grants.sqlite"), encryptionKey: randomBytes(32), canClaim: () => true });
    try {
      const chain = generateHashChainBorrowGrants(2);
      const first = observed("11".repeat(32), chain.initialGuard);
      issuer.installHead({ headId: HEAD_ID, network: "kaspa:testnet-10", ownerPublicKey: OWNER, head: first, grants: chain.grants });
      const challenge = issuer.issueChallenge(HEAD_ID, REQUEST, 60);
      issuer.claimGrant(HEAD_ID, signedClaim(challenge));
      const second = observed("22".repeat(32), chain.grants[0]!.revealedGuard, "100000001");
      issuer.recordAcceptedBorrow(HEAD_ID, accepted(first, second));
      issuer.holdForReorg(HEAD_ID);
      expect(() => issuer.issueChallenge(HEAD_ID, REQUEST, 60)).toThrow("unavailable");
      expect(() => issuer.reconcileObservedHead(HEAD_ID, observed("99".repeat(32), first.guard))).toThrow("outside known lineage");
      expect(issuer.reconcileObservedHead(HEAD_ID, first).phase).toBe("needsRotation");
      expect(() => issuer.issueChallenge(HEAD_ID, REQUEST, 60)).toThrow("unavailable");
      issuer.holdForReorg(HEAD_ID);
      expect(issuer.reconcileObservedHead(HEAD_ID, first).phase).toBe("needsRotation");
      expect(() => issuer.issueChallenge(HEAD_ID, REQUEST, 60)).toThrow("unavailable");
    } finally {
      issuer.close(); rmSync(folder, { recursive: true, force: true });
    }
  });

  it("rejects invalid chain material and untrusted claim terms", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), "kaspa-hash-chain-grants-"));
    const issuer = await HashChainGrantIssuer.open({ databasePath: path.join(folder, "grants.sqlite"), encryptionKey: randomBytes(32), canClaim: (claim) => claim.payerPublicKey !== Buffer.from(schnorr.getPublicKey(OTHER_SECRET)).toString("hex") });
    try {
      const chain = generateHashChainBorrowGrants(1);
      const head = observed("11".repeat(32), chain.initialGuard);
      expect(() => issuer.installHead({ headId: HEAD_ID, network: "kaspa:mainnet", ownerPublicKey: OWNER, head, grants: chain.grants })).toThrow("unsupported grant network");
      expect(() => issuer.installHead({ headId: HEAD_ID, network: "kaspa:testnet-10", ownerPublicKey: OWNER, head, grants: [{ ...chain.grants[0]!, oneTimePrivateKey: "11".repeat(32) }] })).toThrow("does not match public key");
      const repeatedKey = generateHashChainBorrowGrants(1).grants[0]!;
      const seed = "fe".repeat(32);
      const firstGuard = hashChainBorrowGuard(seed, repeatedKey.oneTimePublicKey);
      const repeatedHead = observed("10".repeat(32), hashChainBorrowGuard(firstGuard, repeatedKey.oneTimePublicKey));
      expect(() => issuer.installHead({
        headId: HEAD_ID, network: "kaspa:testnet-10", ownerPublicKey: OWNER, head: repeatedHead,
        grants: [
          { ...repeatedKey, revealedGuard: firstGuard },
          { ...repeatedKey, revealedGuard: seed },
        ],
      })).toThrow("one-time key has already been used");
      issuer.installHead({ headId: HEAD_ID, network: "kaspa:testnet-10", ownerPublicKey: OWNER, head, grants: chain.grants });
      expect(() => issuer.installHead({
        headId: "ac".repeat(32), network: "kaspa:testnet-10", ownerPublicKey: OWNER,
        head: observed("12".repeat(32), chain.initialGuard), grants: chain.grants,
      })).toThrow("one-time key has already been used");
      const challenge = issuer.issueChallenge(HEAD_ID, REQUEST, 60);
      expect(() => issuer.claimGrant(HEAD_ID, { ...signedClaim(challenge), signature: "00".repeat(64) })).toThrow("invalid grant payer signature");
      expect(() => issuer.claimGrant(HEAD_ID, signedClaim(challenge, OTHER_SECRET))).toThrow("ineligible");
      expect(issuer.getCurrent(HEAD_ID).phase).toBe("ready");
      expect(() => issuer.recordAcceptedBorrow(HEAD_ID, accepted(head, observed("22".repeat(32), chain.grants[0]!.revealedGuard, head.amount)))).toThrow("positive head transition");
    } finally {
      issuer.close(); rmSync(folder, { recursive: true, force: true });
    }
  });

  it("quarantines an accepted rotation that reuses a prior one-time key", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), "kaspa-hash-chain-grants-"));
    const file = path.join(folder, "grants.sqlite");
    const key = randomBytes(32);
    let issuer = await HashChainGrantIssuer.open({ databasePath: file, encryptionKey: key, canClaim: () => true });
    try {
      const chain = generateHashChainBorrowGrants(2);
      const first = observed("11".repeat(32), chain.initialGuard);
      issuer.installHead({ headId: HEAD_ID, network: "kaspa:testnet-10", ownerPublicKey: OWNER, head: first, grants: chain.grants });
      const challenge = issuer.issueChallenge(HEAD_ID, REQUEST, 60);
      issuer.claimGrant(HEAD_ID, signedClaim(challenge));
      const second = observed("22".repeat(32), chain.grants[0]!.revealedGuard, "100000001");
      issuer.recordAcceptedBorrow(HEAD_ID, accepted(first, second));
      const reused = observed("33".repeat(32), chain.initialGuard, second.amount);
      expect(issuer.recordAcceptedRotation(HEAD_ID, accepted(second, reused), [chain.grants[0]!])).toMatchObject({
        headVersion: 2, phase: "needsRotation", head: reused,
      });
      expect(() => issuer.issueChallenge(HEAD_ID, REQUEST, 60)).toThrow("unavailable");
      issuer.close();
      issuer = await HashChainGrantIssuer.open({ databasePath: file, encryptionKey: key, canClaim: () => true });
      expect(issuer.getCurrent(HEAD_ID).phase).toBe("needsRotation");
      const unprovisioned = observed("44".repeat(32), "aa".repeat(32), reused.amount);
      expect(issuer.recordAcceptedRotation(HEAD_ID, accepted(reused, unprovisioned), []).phase).toBe("needsRotation");
      const repeatedKey = generateHashChainBorrowGrants(1).grants[0]!;
      const seed = "fe".repeat(32);
      const firstGuard = hashChainBorrowGuard(seed, repeatedKey.oneTimePublicKey);
      const duplicateRoot = hashChainBorrowGuard(firstGuard, repeatedKey.oneTimePublicKey);
      const repeatedHead = observed("55".repeat(32), duplicateRoot, unprovisioned.amount);
      expect(issuer.recordAcceptedRotation(HEAD_ID, accepted(unprovisioned, repeatedHead), [
        { ...repeatedKey, revealedGuard: firstGuard },
        { ...repeatedKey, revealedGuard: seed },
      ]).phase).toBe("needsRotation");
      const consumed = observed("66".repeat(32), firstGuard, "100000002");
      expect(issuer.recordAcceptedBorrow(HEAD_ID, accepted(repeatedHead, consumed)).phase).toBe("needsRotation");
      expect(() => issuer.issueChallenge(HEAD_ID, REQUEST, 60)).toThrow("unavailable");
      const fresh = generateHashChainBorrowGrants(1);
      const recovered = observed("77".repeat(32), fresh.initialGuard, consumed.amount);
      expect(issuer.recordAcceptedRotation(HEAD_ID, accepted(consumed, recovered), fresh.grants).phase).toBe("ready");
    } finally {
      issuer.close(); rmSync(folder, { recursive: true, force: true });
    }
  });

  it("quarantines an earlier local database and backfills its one-time keys", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), "kaspa-hash-chain-grants-"));
    const file = path.join(folder, "grants.sqlite");
    const key = randomBytes(32);
    let issuer = await HashChainGrantIssuer.open({ databasePath: file, encryptionKey: key, canClaim: () => true });
    try {
      const chain = generateHashChainBorrowGrants(1);
      const head = observed("11".repeat(32), chain.initialGuard);
      issuer.installHead({ headId: HEAD_ID, network: "kaspa:testnet-10", ownerPublicKey: OWNER, head, grants: chain.grants });
      issuer.close();
      const legacy = new DatabaseSync(file);
      legacy.exec("DROP TABLE hash_chain_seen_keys; PRAGMA user_version = 0");
      legacy.close();
      issuer = await HashChainGrantIssuer.open({ databasePath: file, encryptionKey: key, canClaim: () => true });
      expect(issuer.getCurrent(HEAD_ID).phase).toBe("needsRotation");
      expect(() => issuer.issueChallenge(HEAD_ID, REQUEST, 60)).toThrow("unavailable");
      const revealedGuard = "ef".repeat(32);
      const rotated = observed("22".repeat(32), hashChainBorrowGuard(revealedGuard, chain.grants[0]!.oneTimePublicKey));
      expect(issuer.recordAcceptedRotation(HEAD_ID, accepted(head, rotated), [
        { ...chain.grants[0]!, revealedGuard },
      ]).phase).toBe("needsRotation");
    } finally {
      issuer.close(); rmSync(folder, { recursive: true, force: true });
    }
  });
});
