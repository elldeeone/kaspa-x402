import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
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
  type HashChainPublicGrant,
} from "../src/hash-chain-grants.js";

const OWNER = "56b328b30c8bf5839e24058747879408bdb36241dc9c2e7c619faa12b2920967";
const PAYER_SECRET = Buffer.alloc(32, 7);
const OTHER_SECRET = Buffer.alloc(32, 8);
const HEAD_ID = "ab".repeat(32);
const REQUEST = "cd".repeat(32);
const COVENANT_ID = "de".repeat(32);
const ADMISSION = "ef".repeat(32);

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

function currentUtxo(current: HashChainPublicGrant) {
  return {
    outpoint: current.head.outpoint,
    amount: current.head.amount,
    scriptPublicKey: current.head.scriptPublicKey,
    covenantId: current.head.covenantId,
  };
}

function testAdmissionPolicy(eligible: (claim: HashChainGrantClaim) => boolean = () => true) {
  return {
    maxGrantsPerClaimant: 100,
    windowSeconds: 86_400,
    resolveFundingOutpoint: async (claim: HashChainGrantClaim) => {
      if (!eligible(claim)) throw new Error("payer is ineligible for grant");
      return { txid: claim.grantId, index: 0 };
    },
  };
}

async function claimGrant(
  issuer: HashChainGrantIssuer,
  headId: string,
  claim: HashChainGrantClaim,
) {
  return issuer.claimGrantAfterCurrentHeadObservation(headId, claim, {
    observe: async (current) => currentUtxo(current),
  });
}

/** Reproduce the sealed records written by the previous schema-v2 issuer. */
function removeLegacyAdmissionFields(file: string, key: Buffer, headId: string, grantId: string): void {
  const db = new DatabaseSync(file);
  const downgrade = (sealed: Uint8Array, aad: string) => {
    const stored = Buffer.from(sealed);
    const decipher = createDecipheriv("aes-256-gcm", key, stored.subarray(1, 13));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(stored.subarray(13, 29));
    const value = JSON.parse(Buffer.concat([decipher.update(stored.subarray(29)), decipher.final()]).toString()) as
      { assignment?: { claimantId?: string; qualifyingFundingOutpoint?: unknown };
        claimantId?: string; qualifyingFundingOutpoint?: unknown };
    delete value.claimantId;
    delete value.qualifyingFundingOutpoint;
    if (value.assignment) {
      delete value.assignment.claimantId;
      delete value.assignment.qualifyingFundingOutpoint;
    }
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(aad));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), encrypted]);
  };
  try {
    const head = db.prepare("SELECT sealed FROM hash_chain_grants WHERE head_id = ?").get(headId) as { sealed: Uint8Array };
    const delivery = db.prepare("SELECT sealed FROM hash_chain_deliveries WHERE head_id = ? AND grant_id = ?")
      .get(headId, grantId) as { sealed: Uint8Array };
    db.prepare("UPDATE hash_chain_grants SET sealed = ? WHERE head_id = ?")
      .run(downgrade(head.sealed, headId), headId);
    db.prepare("UPDATE hash_chain_deliveries SET sealed = ? WHERE head_id = ? AND grant_id = ?")
      .run(downgrade(delivery.sealed, `${headId}:${grantId}`), headId, grantId);
    db.exec("DROP TABLE IF EXISTS hash_chain_admissions; DROP TABLE IF EXISTS hash_chain_legacy_claimants");
  } finally { db.close(); }
}

describe("durable hash-chain grants", () => {
  it("reopens a pre-admission schema-v2 assignment and recovers its accepted payment", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), "kaspa-hash-chain-upgrade-"));
    const file = path.join(folder, "grants.sqlite");
    const key = randomBytes(32);
    let now = new Date("2026-09-22T12:00:00.000Z");
    let issuer = await HashChainGrantIssuer.open({ databasePath: file, encryptionKey: key,
      admissionPolicy: testAdmissionPolicy(), now: () => now });
    try {
      const chain = generateHashChainBorrowGrants(2);
      const first = observed("11".repeat(32), chain.initialGuard);
      issuer.installHead({ headId: HEAD_ID, network: "kaspa:testnet-10", ownerPublicKey: OWNER,
        head: first, grants: chain.grants });
      const second = generateHashChainBorrowGrants(1);
      const secondHeadId = "bc".repeat(32);
      issuer.installHead({ headId: secondHeadId, network: "kaspa:testnet-10", ownerPublicKey: OWNER,
        head: observed("33".repeat(32), second.initialGuard), grants: second.grants });
      const challenge = issuer.issueAdmittedChallenge(HEAD_ID, REQUEST, 60, "20000000", ADMISSION);
      const claim = signedClaim(challenge);
      const delivered = await claimGrant(issuer, HEAD_ID, claim);
      issuer.close();
      removeLegacyAdmissionFields(file, key, HEAD_ID, challenge.grantId);
      issuer = await HashChainGrantIssuer.open({ databasePath: file, encryptionKey: key,
        admissionPolicy: testAdmissionPolicy(), now: () => now });
      expect(issuer.listHeads().find((head) => head.headId === secondHeadId)?.phase).toBe("ready");
      expect(issuer.getCurrent(HEAD_ID).phase).toBe("assigned");
      expect((await claimGrant(issuer, HEAD_ID, claim)).oneTimePrivateKey).toBe(delivered.oneTimePrivateKey);
      const next = issuer.issueAdmittedChallenge(secondHeadId, "cf".repeat(32), 60, "20000000", "01".repeat(32));
      await expect(claimGrant(issuer, secondHeadId, signedClaim(next)))
        .rejects.toThrow("legacy claimant requires a fresh payer key");
      const successor = observed("22".repeat(32), chain.grants[0]!.revealedGuard, "120000000");
      const payment = { transactionId: successor.outpoint.txid, grantId: challenge.grantId,
        challengeId: challenge.challengeId, requestHash: REQUEST,
        payerPublicKey: claim.payerPublicKey, requirementsHash: "a1".repeat(32),
        paymentIdentifier: "legacy-request", amount: "20000000", finality: "accepted" as const };
      expect(issuer.recordAcceptedPayment(HEAD_ID, accepted(first, successor), payment))
        .toMatchObject({ headVersion: 1, head: successor, phase: "ready" });
      expect(issuer.getAcceptedPayment(successor.outpoint.txid)).toMatchObject(payment);
      issuer.close();
      now = new Date("2026-09-23T12:00:01.000Z");
      issuer = await HashChainGrantIssuer.open({ databasePath: file, encryptionKey: key,
        admissionPolicy: testAdmissionPolicy(), now: () => now });
      const afterWindow = issuer.issueAdmittedChallenge(secondHeadId, "d0".repeat(32), 60,
        "20000000", "02".repeat(32));
      await expect(claimGrant(issuer, secondHeadId, signedClaim(afterWindow)))
        .rejects.toThrow("legacy claimant requires a fresh payer key");
    } finally { issuer.close(); rmSync(folder, { recursive: true, force: true }); }
  });

  it("expires a pre-admission assignment into owner recovery without hiding other heads", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), "kaspa-hash-chain-upgrade-"));
    const file = path.join(folder, "grants.sqlite");
    const key = randomBytes(32);
    let now = new Date("2026-09-22T12:00:00.000Z");
    let issuer = await HashChainGrantIssuer.open({ databasePath: file, encryptionKey: key,
      admissionPolicy: testAdmissionPolicy(), now: () => now });
    try {
      const chain = generateHashChainBorrowGrants(1);
      const first = observed("11".repeat(32), chain.initialGuard);
      issuer.installHead({ headId: HEAD_ID, network: "kaspa:testnet-10", ownerPublicKey: OWNER,
        head: first, grants: chain.grants });
      const challenge = issuer.issueAdmittedChallenge(HEAD_ID, REQUEST, 60, "20000000", ADMISSION);
      const claim = signedClaim(challenge);
      await claimGrant(issuer, HEAD_ID, claim);
      issuer.close();
      removeLegacyAdmissionFields(file, key, HEAD_ID, challenge.grantId);
      now = new Date("2026-09-22T12:01:01.000Z");
      issuer = await HashChainGrantIssuer.open({ databasePath: file, encryptionKey: key,
        admissionPolicy: testAdmissionPolicy(), now: () => now });
      expect(issuer.listHeads()).toMatchObject([{ phase: "needsRotation" }]);
      await expect(claimGrant(issuer, HEAD_ID, claim)).rejects.toThrow("unavailable");
      const replacement = generateHashChainBorrowGrants(1);
      const rotated = observed("44".repeat(32), replacement.initialGuard);
      await expect(issuer.recoverOwnerRotationAfterSelectedObservation(HEAD_ID, rotated.outpoint.txid,
        replacement.grants, { getSelectedTransaction: async () => ({
          transactionId: rotated.outpoint.txid, finality: "accepted", spentHead: first.outpoint,
          successor: { amount: rotated.amount, scriptPublicKey: rotated.scriptPublicKey,
            covenantId: rotated.covenantId, authorizingInput: 0 },
        }) })).resolves.toMatchObject({ phase: "ready", head: rotated });
    } finally { issuer.close(); rmSync(folder, { recursive: true, force: true }); }
  });
  it("enforces the ready-head pool limit in the same durable installation transaction", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), "kaspa-hash-chain-pool-"));
    const issuer = await HashChainGrantIssuer.open({ databasePath: path.join(folder, "grants.sqlite"),
      encryptionKey: randomBytes(32), admissionPolicy: testAdmissionPolicy() });
    try {
      for (const [index, headId] of [HEAD_ID, "bc".repeat(32)].entries()) {
        const chain = generateHashChainBorrowGrants(1);
        issuer.installHead({ headId, network: "kaspa:testnet-10", ownerPublicKey: OWNER,
          head: observed((index + 1).toString(16).padStart(2, "0").repeat(32), chain.initialGuard),
          grants: chain.grants }, 2);
      }
      const third = generateHashChainBorrowGrants(1);
      expect(() => issuer.installHead({ headId: "cd".repeat(32), network: "kaspa:testnet-10",
        ownerPublicKey: OWNER, head: observed("03".repeat(32), third.initialGuard),
        grants: third.grants }, 2)).toThrow("ready-head pool is full");
      expect(issuer.listHeads()).toHaveLength(2);
    } finally { issuer.close(); rmSync(folder, { recursive: true, force: true }); }
  });

  it("tombstones an abandoned funding outpoint across restart and keeps another head available", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), "kaspa-hash-chain-availability-"));
    const file = path.join(folder, "grants.sqlite");
    const key = randomBytes(32);
    const secondHeadId = "bc".repeat(32);
    let now = new Date("2026-09-22T12:00:00.000Z");
    let funding = "11".repeat(32);
    const admissionPolicy = { maxGrantsPerClaimant: 1, windowSeconds: 86_400,
      resolveFundingOutpoint: async () => ({ txid: funding, index: 0 }) };
    let issuer = await HashChainGrantIssuer.open({ databasePath: file, encryptionKey: key,
      admissionPolicy, now: () => now });
    try {
      for (const [headId, txid] of [[HEAD_ID, "21".repeat(32)], [secondHeadId, "22".repeat(32)]]) {
        const chain = generateHashChainBorrowGrants(1);
        issuer.installHead({ headId, network: "kaspa:testnet-10", ownerPublicKey: OWNER,
          head: observed(txid, chain.initialGuard), grants: chain.grants });
      }
      const first = issuer.issueAdmittedChallenge(HEAD_ID, REQUEST, 60, "20000000", ADMISSION);
      await claimGrant(issuer, HEAD_ID, signedClaim(first));
      now = new Date("2026-09-22T12:01:01.000Z");
      expect(issuer.getCurrent(HEAD_ID).phase).toBe("needsRotation");
      expect(issuer.listHeads().find((head) => head.headId === secondHeadId)?.phase).toBe("ready");
      issuer.close();
      issuer = await HashChainGrantIssuer.open({ databasePath: file, encryptionKey: key,
        admissionPolicy, now: () => now });
      expect(issuer.getCurrent(HEAD_ID).phase).toBe("needsRotation");
      funding = "12".repeat(32);
      const sameClaimant = issuer.issueAdmittedChallenge(secondHeadId, "ab".repeat(32), 60, "20000000", "01".repeat(32));
      await expect(claimGrant(issuer, secondHeadId, signedClaim(sameClaimant)))
        .rejects.toThrow("quota exceeded");
      const sameHost = issuer.issueAdmittedChallenge(secondHeadId, "ad".repeat(32), 60, "20000000", ADMISSION);
      await expect(claimGrant(issuer, secondHeadId, signedClaim(sameHost, OTHER_SECRET)))
        .rejects.toThrow("quota exceeded");
      const other = issuer.issueAdmittedChallenge(secondHeadId, "ac".repeat(32), 60, "20000000", "02".repeat(32));
      funding = "11".repeat(32);
      await expect(claimGrant(issuer, secondHeadId, signedClaim(other, OTHER_SECRET)))
        .rejects.toThrow("funding outpoint already qualified");
      funding = "12".repeat(32);
      await expect(claimGrant(issuer, secondHeadId, signedClaim(other, OTHER_SECRET)))
        .resolves.toMatchObject({ grantId: other.grantId });
    } finally { issuer.close(); rmSync(folder, { recursive: true, force: true }); }
  });

  it("restores a quarantined head only after selected owner rotation and keeps the funding tombstone", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), "kaspa-hash-chain-owner-recovery-"));
    let now = new Date("2026-09-22T12:00:00.000Z");
    const issuer = await HashChainGrantIssuer.open({
      databasePath: path.join(folder, "grants.sqlite"), encryptionKey: randomBytes(32),
      admissionPolicy: { maxGrantsPerClaimant: 100, windowSeconds: 86_400,
        resolveFundingOutpoint: async () => ({ txid: "91".repeat(32), index: 0 }) },
      now: () => now,
    });
    try {
      const chain = generateHashChainBorrowGrants(1);
      const first = observed("11".repeat(32), chain.initialGuard);
      issuer.installHead({ headId: HEAD_ID, network: "kaspa:testnet-10", ownerPublicKey: OWNER,
        head: first, grants: chain.grants });
      const challenge = issuer.issueAdmittedChallenge(HEAD_ID, REQUEST, 60, "20000000", ADMISSION);
      await claimGrant(issuer, HEAD_ID, signedClaim(challenge));
      now = new Date("2026-09-22T12:01:01.000Z");
      expect(issuer.getCurrent(HEAD_ID).phase).toBe("needsRotation");
      const replacement = generateHashChainBorrowGrants(1);
      const txid = "31".repeat(32);
      const rotated = observed(txid, replacement.initialGuard);
      await expect(issuer.recoverOwnerRotationAfterSelectedObservation(HEAD_ID, txid,
        replacement.grants, { getSelectedTransaction: async () => null }))
        .rejects.toThrow("not accepted on the selected chain");
      expect(issuer.getCurrent(HEAD_ID).phase).toBe("needsRotation");
      await expect(issuer.recoverOwnerRotationAfterSelectedObservation(HEAD_ID, txid,
        replacement.grants, { getSelectedTransaction: async () => ({
          transactionId: txid, finality: "accepted", spentHead: first.outpoint,
          successor: { amount: rotated.amount, scriptPublicKey: rotated.scriptPublicKey,
            covenantId: COVENANT_ID, authorizingInput: 0 },
        }) })).resolves.toMatchObject({ phase: "ready", head: rotated });
      const next = issuer.issueAdmittedChallenge(HEAD_ID, "dc".repeat(32), 60, "20000000", "01".repeat(32));
      await expect(claimGrant(issuer, HEAD_ID, signedClaim(next, OTHER_SECRET)))
        .rejects.toThrow("funding outpoint already qualified");
    } finally { issuer.close(); rmSync(folder, { recursive: true, force: true }); }
  });

  it("commits only one grant when concurrent issuers race for the same claimant and outpoint", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), "kaspa-hash-chain-race-"));
    const file = path.join(folder, "grants.sqlite");
    const key = randomBytes(32);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const admissionPolicy = { maxGrantsPerClaimant: 1, windowSeconds: 86_400,
      resolveFundingOutpoint: async () => {
        await gate;
        return { txid: "91".repeat(32), index: 0 };
      } };
    const first = await HashChainGrantIssuer.open({ databasePath: file, encryptionKey: key, admissionPolicy });
    const second = await HashChainGrantIssuer.open({ databasePath: file, encryptionKey: key, admissionPolicy });
    try {
      const headIds = [HEAD_ID, "bd".repeat(32)];
      for (const [index, headId] of headIds.entries()) {
        const chain = generateHashChainBorrowGrants(1);
        first.installHead({ headId, network: "kaspa:testnet-10", ownerPublicKey: OWNER,
          head: observed(String(index + 1).padStart(64, "0"), chain.initialGuard), grants: chain.grants });
      }
      const claims = headIds.map((headId, index) => signedClaim(
        first.issueAdmittedChallenge(headId, String(index + 3).padStart(64, "0"),
          60, "20000000", ADMISSION)));
      const pending = headIds.map((headId, index) => claimGrant(index === 0 ? first : second,
        headId, claims[index]!));
      release();
      const settled = await Promise.allSettled(pending);
      expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(second.listHeads().filter((head) => head.phase === "assigned")).toHaveLength(1);
    } finally { release(); first.close(); second.close(); rmSync(folder, { recursive: true, force: true }); }
  });
  it("rejects unrestricted boolean admission before opening durable grant state", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), "kaspa-hash-chain-policy-"));
    try {
      await expect(HashChainGrantIssuer.open({
        databasePath: path.join(folder, "grants.sqlite"),
        encryptionKey: randomBytes(32), canClaim: () => true,
      } as unknown as Parameters<typeof HashChainGrantIssuer.open>[0])).rejects.toThrow("durable grant-admission policy");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
  it("deduplicates challenges and durably caps each authenticated admission key", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), "kaspa-hash-chain-grants-"));
    const file = path.join(folder, "grants.sqlite");
    const key = randomBytes(32);
    let now = new Date("2026-09-22T12:00:00.000Z");
    let issuer = await HashChainGrantIssuer.open({
      databasePath: file,
      encryptionKey: key,
      admissionPolicy: testAdmissionPolicy(),
      now: () => now,
    });
    try {
      const chain = generateHashChainBorrowGrants(1);
      issuer.installHead({
        headId: HEAD_ID,
        network: "kaspa:testnet-10",
        ownerPublicKey: OWNER,
        head: observed("11".repeat(32), chain.initialGuard),
        grants: chain.grants,
      });
      expect("issueChallenge" in issuer).toBe(false);
      const first = issuer.issueAdmittedChallenge(HEAD_ID, "01".repeat(32), 60, "20000000", ADMISSION);
      now = new Date("2026-09-22T12:00:01.000Z");
      expect(issuer.issueAdmittedChallenge(HEAD_ID, "01".repeat(32), 60, "20000000", ADMISSION)).toEqual(first);
      expect(first).not.toHaveProperty("admissionKey");
      expect(issuer.getChallenge(HEAD_ID, first.challengeId)).not.toHaveProperty("admissionKey");
      for (const byte of ["02", "03", "04"]) {
        issuer.issueAdmittedChallenge(HEAD_ID, byte.repeat(32), 60, "20000000", ADMISSION);
      }
      expect(() => issuer.issueAdmittedChallenge(HEAD_ID, "05".repeat(32), 60, "20000000", ADMISSION))
        .toThrow("admission key");
      expect(issuer.issueAdmittedChallenge(HEAD_ID, "05".repeat(32), 60, "20000000", "f0".repeat(32)))
        .toMatchObject({ requestHash: "05".repeat(32) });

      issuer.close();
      issuer = await HashChainGrantIssuer.open({
        databasePath: file,
        encryptionKey: key,
        admissionPolicy: testAdmissionPolicy(),
        now: () => now,
      });
      expect(() => issuer.issueAdmittedChallenge(HEAD_ID, "06".repeat(32), 60, "20000000", ADMISSION))
        .toThrow("admission key");
    } finally {
      issuer.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("durably pins one authenticated payment candidate per assigned grant", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), "kaspa-hash-chain-grants-"));
    const file = path.join(folder, "grants.sqlite");
    const key = randomBytes(32);
    let eligibilityChecks = 0;
    let issuer = await HashChainGrantIssuer.open({
      databasePath: file,
      encryptionKey: key,
      admissionPolicy: testAdmissionPolicy(() => { eligibilityChecks++; return true; }),
    });
    try {
      const chain = generateHashChainBorrowGrants(1);
      issuer.installHead({
        headId: HEAD_ID,
        network: "kaspa:testnet-10",
        ownerPublicKey: OWNER,
        head: observed("11".repeat(32), chain.initialGuard),
        grants: chain.grants,
      });
      const challenge = issuer.issueAdmittedChallenge(
        HEAD_ID,
        REQUEST,
        60,
        "20000000",
        ADMISSION,
      );
      const claim = signedClaim(challenge);
      expect(issuer.grantClaimAdmissionKey(HEAD_ID, claim)).toBe(ADMISSION);
      expect(issuer.grantClaimAdmissionKey(HEAD_ID, {} as HashChainGrantClaim))
        .not.toBe(ADMISSION);
      await claimGrant(issuer, HEAD_ID, claim);
      await claimGrant(issuer, HEAD_ID, claim);
      expect(eligibilityChecks).toBe(1);
      const candidate = {
        headId: HEAD_ID,
        headVersion: challenge.headVersion.toString(),
        grantId: challenge.grantId,
        challengeId: challenge.challengeId,
        requestHash: REQUEST,
        payerPublicKey: claim.payerPublicKey,
        transactionId: "22".repeat(32),
      };
      expect(() => issuer.pinPaymentCandidate(candidate)).not.toThrow();
      expect(() => issuer.pinPaymentCandidate(candidate)).not.toThrow();
      expect(() => issuer.pinPaymentCandidate({
        ...candidate,
        transactionId: "23".repeat(32),
      })).toThrow("another payment candidate");
      expect(() => issuer.pinPaymentCandidate({
        ...candidate,
        payerPublicKey: Buffer.from(schnorr.getPublicKey(OTHER_SECRET)).toString("hex"),
      })).toThrow("does not match the assigned grant");
      expect(() => issuer.pinPaymentCandidate({
        ...candidate,
        headVersion: (challenge.headVersion + 1).toString(),
      })).toThrow("does not match the assigned grant");

      issuer.close();
      issuer = await HashChainGrantIssuer.open({
        databasePath: file,
        encryptionKey: key,
        admissionPolicy: testAdmissionPolicy(),
      });
      expect(() => issuer.pinPaymentCandidate(candidate)).not.toThrow();
      expect(() => issuer.pinPaymentCandidate({
        ...candidate,
        transactionId: "24".repeat(32),
      })).toThrow("another payment candidate");
    } finally {
      issuer.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("recovers an underpaid selected borrow after head readback puts the assigned grant on hold", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), "kaspa-hash-chain-grants-"));
    const file = path.join(folder, "grants.sqlite");
    const key = randomBytes(32);
    let issuer = await HashChainGrantIssuer.open({ databasePath: file, encryptionKey: key, admissionPolicy: testAdmissionPolicy() });
    try {
      const chain = generateHashChainBorrowGrants(2);
      const first = observed("11".repeat(32), chain.initialGuard);
      issuer.installHead({ headId: HEAD_ID, network: "kaspa:testnet-10", ownerPublicKey: OWNER, head: first, grants: chain.grants });
      const challenge = issuer.issueAdmittedChallenge(HEAD_ID, REQUEST, 60, "20000000", ADMISSION);
      await claimGrant(issuer, HEAD_ID, signedClaim(challenge));
      const small = observed("22".repeat(32), chain.grants[0]!.revealedGuard, "100000001");
      issuer.holdForReorg(HEAD_ID);
      expect(issuer.getCurrent(HEAD_ID).phase).toBe("hold");
      expect(() => issuer.reconcileObservedHead(HEAD_ID, small)).toThrow("outside known lineage");
      const selected = {
        transactionId: small.outpoint.txid, finality: "accepted" as const,
        spentHead: first.outpoint,
        successor: { amount: small.amount, scriptPublicKey: small.scriptPublicKey,
          covenantId: small.covenantId, authorizingInput: 0 as const },
      };
      await expect(issuer.recoverSelectedUnmatchedBorrow(HEAD_ID, small.outpoint.txid, {
        getSelectedTransaction: async () => null,
      })).rejects.toThrow("not the selected successor");
      await expect(issuer.recoverSelectedUnmatchedBorrow(HEAD_ID, small.outpoint.txid, {
        getSelectedTransaction: async () => ({ ...selected, spentHead: { txid: "99".repeat(32), index: 0 } }),
      })).rejects.toThrow("not the selected successor");
      expect(() => issuer.recordAcceptedBorrow(HEAD_ID, accepted(first,
        observed("33".repeat(32), chain.grants[0]!.revealedGuard, "120000000"))))
        .toThrow("held head requires a nonconforming assigned borrow");
      expect(() => issuer.recordAcceptedBorrow(HEAD_ID, accepted(first,
        observed("44".repeat(32), "aa".repeat(32), "100000001"))))
        .toThrow("positive head transition");
      issuer.close();
      issuer = await HashChainGrantIssuer.open({ databasePath: file, encryptionKey: key, admissionPolicy: testAdmissionPolicy() });
      expect(await issuer.recoverSelectedUnmatchedBorrow(HEAD_ID, small.outpoint.txid, {
        getSelectedTransaction: async () => selected,
      })).toMatchObject({
        headVersion: 1, phase: "ready", head: small,
      });
      expect(issuer.getAcceptedPayment(small.outpoint.txid)).toBeUndefined();
      expect(issuer.getDeliveryRecord(HEAD_ID, challenge.grantId)?.quotedAmount).toBe("20000000");
      expect(() => issuer.recordAcceptedBorrow(HEAD_ID, accepted(first, small))).toThrow("current head");
      expect(issuer.issueAdmittedChallenge(HEAD_ID, REQUEST, 60, "20000000", ADMISSION).headVersion).toBe(1);
      issuer.holdForReorg(HEAD_ID);
      expect(() => issuer.recordAcceptedBorrow(HEAD_ID, accepted(small,
        observed("55".repeat(32), chain.grants[1]!.revealedGuard, "100000002"))))
        .toThrow("held head requires a nonconforming assigned borrow");
      expect(issuer.reconcileObservedHead(HEAD_ID, small).phase).toBe("ready");
    } finally {
      issuer.close(); rmSync(folder, { recursive: true, force: true });
    }
  });

  it("keeps an abandoned grant quarantined when its underpaid spend wins during a hold", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), "kaspa-hash-chain-grants-"));
    let now = new Date("2026-09-22T12:00:00.000Z");
    const issuer = await HashChainGrantIssuer.open({
      databasePath: path.join(folder, "grants.sqlite"), encryptionKey: randomBytes(32),
      admissionPolicy: testAdmissionPolicy(), now: () => now,
    });
    try {
      const chain = generateHashChainBorrowGrants(2);
      const first = observed("11".repeat(32), chain.initialGuard);
      issuer.installHead({ headId: HEAD_ID, network: "kaspa:testnet-10", ownerPublicKey: OWNER, head: first, grants: chain.grants });
      const challenge = issuer.issueAdmittedChallenge(HEAD_ID, REQUEST, 60, "20000000", ADMISSION);
      await claimGrant(issuer, HEAD_ID, signedClaim(challenge));
      now = new Date("2026-09-22T12:01:01.000Z");
      issuer.markAbandoned(HEAD_ID);
      issuer.holdForReorg(HEAD_ID);
      const small = observed("22".repeat(32), chain.grants[0]!.revealedGuard, "100000001");
      expect(await issuer.recoverSelectedUnmatchedBorrow(HEAD_ID, small.outpoint.txid, {
        getSelectedTransaction: async () => ({
          transactionId: small.outpoint.txid, finality: "accepted", spentHead: first.outpoint,
          successor: { amount: small.amount, scriptPublicKey: small.scriptPublicKey,
            covenantId: small.covenantId, authorizingInput: 0 },
        }),
      })).toMatchObject({ headVersion: 1, phase: "needsRotation", head: small });
      expect(() => issuer.issueAdmittedChallenge(HEAD_ID, REQUEST, 60, "20000000", ADMISSION)).toThrow("unavailable");
    } finally {
      issuer.close(); rmSync(folder, { recursive: true, force: true });
    }
  });

  it("atomically records one exact payment and refuses a competing use of its grant", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), "kaspa-hash-chain-grants-"));
    const file = path.join(folder, "grants.sqlite");
    const key = randomBytes(32);
    let issuer = await HashChainGrantIssuer.open({ databasePath: file, encryptionKey: key, admissionPolicy: testAdmissionPolicy() });
    try {
      const chain = generateHashChainBorrowGrants(2);
      const first = observed("11".repeat(32), chain.initialGuard);
      issuer.installHead({ headId: HEAD_ID, network: "kaspa:testnet-10", ownerPublicKey: OWNER, head: first, grants: chain.grants });
      const challenge = issuer.issueAdmittedChallenge(HEAD_ID, REQUEST, 60, "20000000", ADMISSION);
      const claim = signedClaim(challenge);
      await claimGrant(issuer, HEAD_ID, claim);
      const successor = observed("22".repeat(32), chain.grants[0]!.revealedGuard, "120000000");
      const payment = {
        transactionId: successor.outpoint.txid, grantId: challenge.grantId,
        challengeId: challenge.challengeId, requestHash: REQUEST,
        payerPublicKey: claim.payerPublicKey, requirementsHash: "a1".repeat(32),
        paymentIdentifier: "one-request", amount: "20000000", finality: "accepted" as const,
      };
      expect(() => issuer.recordAcceptedPayment(HEAD_ID, accepted(first, successor), { ...payment, amount: "1" }))
        .toThrow("assigned exact grant");
      const underpaid = observed("33".repeat(32), chain.grants[0]!.revealedGuard, "100000001");
      expect(() => issuer.recordAcceptedPayment(HEAD_ID, accepted(first, underpaid), {
        ...payment, transactionId: underpaid.outpoint.txid, amount: "1",
      })).toThrow("assigned exact grant");
      expect(issuer.getAcceptedPayment(successor.outpoint.txid)).toBeUndefined();
      expect(issuer.getCurrent(HEAD_ID).head).toEqual(first);
      issuer.holdForReorg(HEAD_ID);
      expect(() => issuer.recordAcceptedBorrow(HEAD_ID, accepted(first, successor)))
        .toThrow("held head requires a nonconforming assigned borrow");
      expect(() => issuer.recordAcceptedPayment(HEAD_ID, accepted(first, successor), { ...payment, amount: "1" }))
        .toThrow("assigned exact grant");
      expect(issuer.getCurrent(HEAD_ID).phase).toBe("hold");
      issuer.close();
      issuer = await HashChainGrantIssuer.open({ databasePath: file, encryptionKey: key, admissionPolicy: testAdmissionPolicy() });
      expect(issuer.getCurrent(HEAD_ID).phase).toBe("hold");
      expect(issuer.recordAcceptedPayment(HEAD_ID, accepted(first, successor), payment)).toMatchObject({
        headVersion: 1, head: successor, phase: "ready",
      });
      const acceptedCandidate = {
        headId: HEAD_ID,
        headVersion: challenge.headVersion.toString(),
        grantId: challenge.grantId,
        challengeId: challenge.challengeId,
        requestHash: REQUEST,
        payerPublicKey: claim.payerPublicKey,
        transactionId: successor.outpoint.txid,
      };
      expect(() => issuer.pinPaymentCandidate(acceptedCandidate)).not.toThrow();
      expect(() => issuer.pinPaymentCandidate({
        ...acceptedCandidate,
        transactionId: "44".repeat(32),
      })).toThrow("does not match the assigned grant");
      issuer.close();
      issuer = await HashChainGrantIssuer.open({ databasePath: file, encryptionKey: key, admissionPolicy: testAdmissionPolicy() });
      expect(issuer.getAcceptedPayment(successor.outpoint.txid)).toEqual(payment);
      expect(issuer.recordAcceptedPayment(HEAD_ID, accepted(first, successor), payment).headVersion).toBe(1);
      expect(() => issuer.recordAcceptedPayment(HEAD_ID, accepted(first, successor), {
        ...payment, paymentIdentifier: "competing-request",
      })).toThrow("another payment");
    } finally {
      issuer.close(); rmSync(folder, { recursive: true, force: true });
    }
  });

  it("commits encrypted single-payer delivery before return and recovers identical retries", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), "kaspa-hash-chain-grants-"));
    const file = path.join(folder, "grants.sqlite");
    const key = randomBytes(32);
    let now = new Date("2026-09-22T12:00:00.000Z");
    let eligible = true;
    const options = { databasePath: file, encryptionKey: key, admissionPolicy: testAdmissionPolicy(() => eligible), now: () => now };
    const chain = generateHashChainBorrowGrants(2);
    const head = observed("11".repeat(32), chain.initialGuard);
    const issuer = await HashChainGrantIssuer.open(options);
    issuer.installHead({ headId: HEAD_ID, network: "kaspa:testnet-10", ownerPublicKey: OWNER, head, grants: chain.grants });
    const challenge = issuer.issueAdmittedChallenge(HEAD_ID, REQUEST, 60, "20000000", ADMISSION);
    const claim = signedClaim(challenge);
    expect("claimGrant" in issuer).toBe(false);
    expect("authorizeGrantClaim" in issuer).toBe(false);
    await expect(issuer.claimGrantAfterCurrentHeadObservation(
      HEAD_ID,
      claim,
      { observe: async () => null },
    )).rejects.toThrow("authoritative selected UTXO");
    expect(issuer.getCurrent(HEAD_ID).phase).toBe("hold");
    expect(issuer.getDeliveryRecord(HEAD_ID, challenge.grantId)).toBeUndefined();
    expect(issuer.reconcileObservedHead(HEAD_ID, head).phase).toBe("ready");
    const delivered = await claimGrant(issuer, HEAD_ID, claim);
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
      await expect(claimGrant(recovered, HEAD_ID, claim)).resolves.toEqual(delivered);
      recovered.holdForReorg(HEAD_ID);
      expect(recovered.reconcileObservedHead(HEAD_ID, head).phase).toBe("assigned");
      await expect(claimGrant(recovered, HEAD_ID, claim)).resolves.toEqual(delivered);
      expect(recovered.getDeliveryRecord(HEAD_ID, delivered.grantId)).not.toHaveProperty("oneTimePrivateKey");
      const other = signedClaim({ ...challenge }, OTHER_SECRET);
      await expect(claimGrant(otherProcess, HEAD_ID, other)).rejects.toThrow("assigned to another payer");
      expect(() => otherProcess.issueAdmittedChallenge(HEAD_ID, REQUEST, 60, "20000000", ADMISSION)).toThrow("unavailable");
      now = new Date("2026-09-22T12:01:01.000Z");
      await expect(claimGrant(recovered, HEAD_ID, claim)).rejects.toThrow("live challenge");
      expect(recovered.markAbandoned(HEAD_ID).phase).toBe("needsRotation");
      expect(() => otherProcess.issueAdmittedChallenge(HEAD_ID, REQUEST, 60, "20000000", ADMISSION)).toThrow("unavailable");
    } finally {
      recovered.close(); otherProcess.close(); rmSync(folder, { recursive: true, force: true });
    }
  });

  it("adopts a small accepted spend, blocks stale links, and unlocks only after accepted rotation", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), "kaspa-hash-chain-grants-"));
    const file = path.join(folder, "grants.sqlite");
    let now = new Date("2026-09-22T12:00:00.000Z");
    const issuer = await HashChainGrantIssuer.open({ databasePath: file, encryptionKey: randomBytes(32), admissionPolicy: testAdmissionPolicy(), now: () => now });
    try {
      const chain = generateHashChainBorrowGrants(2);
      const first = observed("11".repeat(32), chain.initialGuard);
      issuer.installHead({ headId: HEAD_ID, network: "kaspa:testnet-10", ownerPublicKey: OWNER, head: first, grants: chain.grants });
      const challenge = issuer.issueAdmittedChallenge(HEAD_ID, REQUEST, 60, "20000000", ADMISSION);
      await claimGrant(issuer, HEAD_ID, signedClaim(challenge));

      const small = observed("22".repeat(32), chain.grants[0]!.revealedGuard, "100000001");
      expect(issuer.recordAcceptedBorrow(HEAD_ID, accepted(first, small))).toMatchObject({ headVersion: 1, phase: "ready", head: small });
      expect(issuer.getDeliveryRecord(HEAD_ID, challenge.grantId)).toMatchObject({
        headVersion: 0, headOutpoint: first.outpoint, requestHash: REQUEST,
      });
      expect(() => issuer.recordAcceptedBorrow(HEAD_ID, accepted(first, small))).toThrow("current head");
      const secondChallenge = issuer.issueAdmittedChallenge(HEAD_ID, REQUEST, 60, "20000000", ADMISSION);
      await claimGrant(issuer, HEAD_ID, signedClaim(secondChallenge));
      now = new Date("2026-09-22T12:01:01.000Z");
      issuer.markAbandoned(HEAD_ID);
      const replacement = generateHashChainBorrowGrants(1);
      const rotated = observed("33".repeat(32), replacement.initialGuard, small.amount);
      expect(() => issuer.recordAcceptedRotation(HEAD_ID, accepted(first, rotated), replacement.grants)).toThrow("current head");
      expect(issuer.recordAcceptedRotation(HEAD_ID, accepted(small, rotated), replacement.grants)).toMatchObject({
        headVersion: 2, phase: "ready", head: rotated,
      });
      expect(() => issuer.recordAcceptedBorrow(HEAD_ID, accepted(small, observed("44".repeat(32), chain.grants[1]!.revealedGuard)))).toThrow("current head");
      expect(issuer.issueAdmittedChallenge(HEAD_ID, REQUEST, 60, "20000000", ADMISSION).headVersion).toBe(2);
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
      expect(() => issuer.issueAdmittedChallenge(HEAD_ID, REQUEST, 60, "20000000", ADMISSION)).toThrow("unavailable");
      issuer.holdForReorg(HEAD_ID);
      expect(issuer.reconcileObservedHead(HEAD_ID, borrowerWins).phase).toBe("needsRotation");
    } finally {
      issuer.close(); rmSync(folder, { recursive: true, force: true });
    }
  });

  it("holds issuance across a reorg and requires rotation if an exposed predecessor returns", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), "kaspa-hash-chain-grants-"));
    const issuer = await HashChainGrantIssuer.open({ databasePath: path.join(folder, "grants.sqlite"), encryptionKey: randomBytes(32), admissionPolicy: testAdmissionPolicy() });
    try {
      const chain = generateHashChainBorrowGrants(2);
      const first = observed("11".repeat(32), chain.initialGuard);
      issuer.installHead({ headId: HEAD_ID, network: "kaspa:testnet-10", ownerPublicKey: OWNER, head: first, grants: chain.grants });
      const challenge = issuer.issueAdmittedChallenge(HEAD_ID, REQUEST, 60, "20000000", ADMISSION);
      await claimGrant(issuer, HEAD_ID, signedClaim(challenge));
      const second = observed("22".repeat(32), chain.grants[0]!.revealedGuard, "100000001");
      issuer.recordAcceptedBorrow(HEAD_ID, accepted(first, second));
      issuer.holdForReorg(HEAD_ID);
      expect(() => issuer.issueAdmittedChallenge(HEAD_ID, REQUEST, 60, "20000000", ADMISSION)).toThrow("unavailable");
      expect(() => issuer.reconcileObservedHead(HEAD_ID, observed("99".repeat(32), first.guard))).toThrow("outside known lineage");
      expect(issuer.reconcileObservedHead(HEAD_ID, first).phase).toBe("needsRotation");
      expect(() => issuer.issueAdmittedChallenge(HEAD_ID, REQUEST, 60, "20000000", ADMISSION)).toThrow("unavailable");
      issuer.holdForReorg(HEAD_ID);
      expect(issuer.reconcileObservedHead(HEAD_ID, first).phase).toBe("needsRotation");
      expect(() => issuer.issueAdmittedChallenge(HEAD_ID, REQUEST, 60, "20000000", ADMISSION)).toThrow("unavailable");
    } finally {
      issuer.close(); rmSync(folder, { recursive: true, force: true });
    }
  });

  it("rejects invalid chain material and untrusted claim terms", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), "kaspa-hash-chain-grants-"));
    const issuer = await HashChainGrantIssuer.open({ databasePath: path.join(folder, "grants.sqlite"), encryptionKey: randomBytes(32), admissionPolicy: testAdmissionPolicy((claim) => claim.payerPublicKey !== Buffer.from(schnorr.getPublicKey(OTHER_SECRET)).toString("hex")) });
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
      const challenge = issuer.issueAdmittedChallenge(HEAD_ID, REQUEST, 60, "20000000", ADMISSION);
      await expect(claimGrant(issuer, HEAD_ID, {
        ...signedClaim(challenge),
        signature: "00".repeat(64),
      })).rejects.toThrow("invalid grant payer signature");
      await expect(claimGrant(
        issuer,
        HEAD_ID,
        signedClaim(challenge, OTHER_SECRET),
      )).rejects.toThrow("ineligible");
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
    let issuer = await HashChainGrantIssuer.open({ databasePath: file, encryptionKey: key, admissionPolicy: testAdmissionPolicy() });
    try {
      const chain = generateHashChainBorrowGrants(2);
      const first = observed("11".repeat(32), chain.initialGuard);
      issuer.installHead({ headId: HEAD_ID, network: "kaspa:testnet-10", ownerPublicKey: OWNER, head: first, grants: chain.grants });
      const challenge = issuer.issueAdmittedChallenge(HEAD_ID, REQUEST, 60, "20000000", ADMISSION);
      await claimGrant(issuer, HEAD_ID, signedClaim(challenge));
      const second = observed("22".repeat(32), chain.grants[0]!.revealedGuard, "100000001");
      issuer.recordAcceptedBorrow(HEAD_ID, accepted(first, second));
      const reused = observed("33".repeat(32), chain.initialGuard, second.amount);
      expect(issuer.recordAcceptedRotation(HEAD_ID, accepted(second, reused), [chain.grants[0]!])).toMatchObject({
        headVersion: 2, phase: "needsRotation", head: reused,
      });
      expect(() => issuer.issueAdmittedChallenge(HEAD_ID, REQUEST, 60, "20000000", ADMISSION)).toThrow("unavailable");
      issuer.close();
      issuer = await HashChainGrantIssuer.open({ databasePath: file, encryptionKey: key, admissionPolicy: testAdmissionPolicy() });
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
      expect(() => issuer.issueAdmittedChallenge(HEAD_ID, REQUEST, 60, "20000000", ADMISSION)).toThrow("unavailable");
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
    let issuer = await HashChainGrantIssuer.open({ databasePath: file, encryptionKey: key, admissionPolicy: testAdmissionPolicy() });
    try {
      const chain = generateHashChainBorrowGrants(1);
      const head = observed("11".repeat(32), chain.initialGuard);
      issuer.installHead({ headId: HEAD_ID, network: "kaspa:testnet-10", ownerPublicKey: OWNER, head, grants: chain.grants });
      issuer.close();
      const legacy = new DatabaseSync(file);
      legacy.exec("DROP TABLE hash_chain_seen_keys; PRAGMA user_version = 0");
      legacy.close();
      issuer = await HashChainGrantIssuer.open({ databasePath: file, encryptionKey: key, admissionPolicy: testAdmissionPolicy() });
      expect(issuer.getCurrent(HEAD_ID).phase).toBe("needsRotation");
      expect(() => issuer.issueAdmittedChallenge(HEAD_ID, REQUEST, 60, "20000000", ADMISSION)).toThrow("unavailable");
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
