#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { schnorr } from "@noble/curves/secp256k1.js";
import { generateHashChainBorrowGrants, hashChainHeadScriptPublicKey } from "@kaspa-x402/covenant";
import { HashChainGrantIssuer, hashChainGrantClaimDigest } from "@kaspa-x402/server/hash-chain-grants";
import { HashChainGrantIssuer as StorageIssuer } from "@kaspa-x402/server/hash-chain-issuer";
import { DirectModeServer, MemoryServerChannelStore } from "@kaspa-x402/server";
import { decodePaymentRequiredHeader } from "@kaspa-x402/core";

const args = process.argv.slice(2);
if (args[0] === "--crash-worker") {
  const input = JSON.parse(fs.readFileSync(args[1]));
  let armed = false;
  const db = new DatabaseSync(input.file);
  db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL");
  const database = {
    exec: q => db.exec(q),
    prepare: q => {
      const s = db.prepare(q);
      return { get: (...v) => s.get(...v), all: () => s.all(), run: (...v) => {
        const result = s.run(...v);
        if (armed && q.startsWith(input.query)) {
          fs.writeFileSync(input.marker, input.query);
          process.kill(process.pid, "SIGKILL");
        }
        return result;
      } };
    },
    getSchemaVersion: () => db.prepare("PRAGMA user_version").get().user_version,
    setSchemaVersion: v => db.exec(`PRAGMA user_version = ${v}`), close: () => db.close(),
  };
  const issuer = StorageIssuer.fromStorage({ database, encryptionKey: Buffer.alloc(32, 19),
    transactionSync: callback => { db.exec("BEGIN IMMEDIATE"); try { const r = callback(); db.exec("COMMIT"); return r; }
      catch (e) { db.exec("ROLLBACK"); throw e; } },
    admissionPolicy: { maxGrantsPerClaimant: 1000, windowSeconds: 86400,
      resolveFundingOutpoint: async c => ({ txid: c.grantId, index: 0 }) },
  });
  armed = true;
  if (input.claim) await issuer.claimGrantAfterCurrentHeadObservation(input.headId, input.claim, {
    observe: async c => ({ outpoint: c.head.outpoint, amount: c.head.amount, scriptPublicKey: c.head.scriptPublicKey, covenantId: c.head.covenantId }),
  });
  else issuer.compactStorage();
  throw new Error("crash injection did not reach its write boundary");
}
assert.equal(args.length, 2, "usage: proof-hash-chain-issuer-storage-e2e.mjs --out <report.json>");
assert.equal(args[0], "--out");
const output = path.resolve(args[1]);
fs.mkdirSync(path.dirname(output), { recursive: true });
const temporary = fs.mkdtempSync(path.join(path.dirname(output), "issuer-storage-"));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cases = [];
const owner = "56b328b30c8bf5839e24058747879408bdb36241dc9c2e7c619faa12b2920967";
const payer = Buffer.alloc(32, 7);
const id = (n) => n.toString(16).padStart(64, "0");
const observed = (n, guard, amount = "100000000") => ({
  outpoint: { txid: id(n), index: 0 }, amount, guard, covenantId: id(900),
  scriptPublicKey: hashChainHeadScriptPublicKey({ ownerPublicKey: owner, guard }),
});
async function open(name, storageLimits, extra = {}) {
  return HashChainGrantIssuer.open({ databasePath: path.join(temporary, `${name}.sqlite`),
    encryptionKey: Buffer.alloc(32, 19), storageLimits,
    admissionPolicy: { maxGrantsPerClaimant: 1000, windowSeconds: 86400,
      resolveFundingOutpoint: async (claim) => ({ txid: claim.grantId, index: 0 }) }, ...extra });
}
function install(issuer, n, links = 1) {
  const chain = generateHashChainBorrowGrants(links);
  const input = { headId: id(n), network: "kaspa:testnet-10", ownerPublicKey: owner,
    head: observed(n + 1000, chain.initialGuard), grants: chain.grants };
  issuer.installHead(input);
  return { chain, input };
}
function signed(challenge) {
  const unsigned = { grantId: challenge.grantId, challengeId: challenge.challengeId,
    requestHash: challenge.requestHash, payerPublicKey: Buffer.from(schnorr.getPublicKey(payer)).toString("hex"),
    expiresAt: challenge.expiresAt };
  return { ...unsigned, signature: Buffer.from(schnorr.sign(hashChainGrantClaimDigest("kaspa:testnet-10", unsigned), payer)).toString("hex") };
}
const claim = (issuer, headId, signedClaim) => issuer.claimGrantAfterCurrentHeadObservation(headId, signedClaim, {
  observe: async (current) => ({ outpoint: current.head.outpoint, amount: current.head.amount,
    scriptPublicKey: current.head.scriptPublicKey, covenantId: current.head.covenantId }),
});
async function check(name, run) {
  try { cases.push({ name, passed: true, evidence: await run() }); }
  catch (error) { cases.push({ name, passed: false, error: error.stack }); }
}
try {
  await check("aggregate installation fails atomically at the durable record limit", async () => {
    const issuer = await open("records", { maxRecords: 1036, maxBytes: 4 * 1024 * 1024 });
    try {
      let rejected;
      for (let n = 1; n <= 1036; n++) {
        try { install(issuer, n); }
        catch (error) { rejected = error; break; }
      }
      assert.equal(rejected?.code, "HASH_CHAIN_STORAGE_CAPACITY", "valid heads exceeded the configured aggregate limit");
      const usage = issuer.getStorageUsage();
      assert.ok(usage.records + usage.reservedRecords <= 1036);
      return { usage, installedHeads: issuer.listHeads().length };
    } finally { issuer.close(); }
  });
  await check("aggregate byte limit rejects a valid large chain without partial installation", async () => {
    const issuer = await open("bytes", { maxRecords: 10000, maxBytes: 256 * 1024 });
    try {
      assert.throws(() => install(issuer, 20, 1024), { code: "HASH_CHAIN_STORAGE_CAPACITY" });
      assert.equal(issuer.listHeads().length, 0);
      return { usage: issuer.getStorageUsage(), fileBytes: fs.statSync(path.join(temporary, "bytes.sqlite")).size };
    } finally { issuer.close(); }
  });
  await check("legitimate delivered grant and accepted payment survive reopen", async () => {
    let issuer = await open("control", { maxRecords: 10000, maxBytes: 4 * 1024 * 1024 });
    try {
      const { chain, input } = install(issuer, 30, 2);
      const challenge = issuer.issueAdmittedChallenge(id(30), id(31), 60, "20000000", id(32));
      const signedClaim = signed(challenge);
      const delivery = await claim(issuer, id(30), signedClaim);
      issuer.close(); issuer = await open("control");
      assert.deepEqual(await claim(issuer, id(30), signedClaim), delivery);
      const after = observed(4000, chain.grants[0].revealedGuard, "120000000");
      const payment = { transactionId: after.outpoint.txid, grantId: challenge.grantId,
        challengeId: challenge.challengeId, requestHash: challenge.requestHash,
        payerPublicKey: signedClaim.payerPublicKey, requirementsHash: id(33), paymentIdentifier: "control-payment",
        amount: "20000000", finality: "accepted" };
      issuer.recordAcceptedPayment(id(30), { predecessor: input.head.outpoint, successor: after, finality: "accepted" }, payment);
      issuer.close(); issuer = await open("control");
      assert.deepEqual(issuer.getAcceptedPayment(after.outpoint.txid), payment);
      assert.equal(issuer.getCurrent(id(30)).headVersion, 1);
      return { recoveredRetry: true, recoveredPayment: true };
    } finally { issuer.close(); }
  });
  await check("saturated issuer reserves settlement and preserves delivered retries", async () => {
    let issuer = await open("reserve", { maxRecords: 1033, maxBytes: 4 * 1024 * 1024 });
    try {
      const { chain, input } = install(issuer, 40, 3);
      const challenge = issuer.issueAdmittedChallenge(id(40), id(41), 60, "20000000", id(42));
      const signedClaim = signed(challenge);
      const delivered = await claim(issuer, id(40), signedClaim);
      const atLimit = issuer.getStorageUsage();
      assert.equal(atLimit.records + atLimit.reservedRecords, 1033);
      assert.throws(() => install(issuer, 43), { code: "HASH_CHAIN_STORAGE_CAPACITY" });
      assert.deepEqual(issuer.getStorageUsage(), atLimit, "failed allocation changed durable capacity");
      issuer.close(); issuer = await open("reserve");
      assert.deepEqual(await claim(issuer, id(40), signedClaim), delivered);
      const after = observed(4040, chain.grants[0].revealedGuard, "120000000");
      const payment = { transactionId: after.outpoint.txid, grantId: challenge.grantId,
        challengeId: challenge.challengeId, requestHash: challenge.requestHash, payerPublicKey: signedClaim.payerPublicKey,
        requirementsHash: id(44), paymentIdentifier: "reserved-payment", amount: "20000000", finality: "accepted" };
      issuer.recordAcceptedPayment(id(40), { predecessor: input.head.outpoint, successor: after, finality: "accepted" }, payment);
      assert.equal(issuer.getStorageUsage().records, 9);
      assert.throws(() => issuer.issueAdmittedChallenge(id(40), id(45), 60, "20000000", id(46)), { code: "HASH_CHAIN_STORAGE_CAPACITY" });
      issuer.close(); issuer = await open("reserve");
      assert.deepEqual(issuer.getAcceptedPayment(payment.transactionId), payment);
      assert.equal(issuer.getDeliveryRecord(id(40), delivered.grantId).challengeId, challenge.challengeId);
      issuer.recordAcceptedPayment(id(40), { predecessor: input.head.outpoint, successor: after, finality: "accepted" }, payment);
      return { beforeSettlement: atLimit, afterSettlement: issuer.getStorageUsage(), recoveredRetry: true, recoveredPayment: true };
    } finally { issuer.close(); }
  });
  await check("concurrent instances share capacity and explicit policy increases", async () => {
    const first = await open("concurrent", { maxRecords: 2059, maxBytes: 4 * 1024 * 1024 });
    const second = await open("concurrent");
    try {
      install(first, 50); install(second, 51);
      const c1 = signed(first.issueAdmittedChallenge(id(50), id(52), 60, "20000000", id(53)));
      const c2 = signed(second.issueAdmittedChallenge(id(51), id(54), 60, "20000000", id(55)));
      const results = await Promise.allSettled([claim(first, id(50), c1), claim(second, id(51), c2)]);
      assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
      const rejected = results.find(r => r.status === "rejected");
      assert.equal(rejected.reason.code, "HASH_CHAIN_STORAGE_CAPACITY");
      assert.deepEqual(first.getStorageUsage(), second.getStorageUsage());
      await assert.rejects(open("concurrent", { maxRecords: 10000, maxBytes: 4 * 1024 * 1024 }), /persisted policy/);
      assert.throws(() => first.increaseStorageLimits({ maxRecords: 2058, maxBytes: 4 * 1024 * 1024 }), /only increase/);
      first.increaseStorageLimits({ maxRecords: 2061, maxBytes: 4 * 1024 * 1024 });
      const losing = results[0].status === "rejected" ? [first, id(50), c1] : [second, id(51), c2];
      await claim(...losing);
      return { fulfilledBeforeIncrease: 1, usage: second.getStorageUsage() };
    } finally { first.close(); second.close(); }
  });
  await check("retired compaction shrinks physical storage without deleting security authority", async () => {
    let issuer = await open("compact", { maxRecords: 10000, maxBytes: 4 * 1024 * 1024 });
    try {
      const { chain, input } = install(issuer, 60, 256);
      const challenge = issuer.issueAdmittedChallenge(id(60), id(61), 60, "20000000", id(62));
      const signedClaim = signed(challenge);
      const delivered = await claim(issuer, id(60), signedClaim);
      const after = observed(4060, chain.grants[0].revealedGuard, "120000000");
      const payment = { transactionId: after.outpoint.txid, grantId: challenge.grantId,
        challengeId: challenge.challengeId, requestHash: challenge.requestHash, payerPublicKey: signedClaim.payerPublicKey,
        requirementsHash: id(63), paymentIdentifier: "compacted-payment", amount: "20000000", finality: "accepted" };
      issuer.recordAcceptedPayment(id(60), { predecessor: input.head.outpoint, successor: after, finality: "accepted" }, payment);
      issuer.recordAcceptedSweep(id(60), { predecessor: after.outpoint, finality: "accepted", transactionId: id(4061), sameIdOutputCount: 0 });
      const before = issuer.getStorageUsage();
      const file = path.join(temporary, "compact.sqlite");
      const physicalBefore = fs.statSync(file).size;
      issuer.compactStorage();
      const compacted = issuer.getStorageUsage();
      assert.ok(compacted.bytes < before.bytes - 50000);
      assert.equal(compacted.records, before.records);
      assert.ok(fs.statSync(file).size < physicalBefore);
      issuer.close(); issuer = await open("compact");
      assert.equal(issuer.getCurrent(id(60)).phase, "retired");
      assert.deepEqual(issuer.getAcceptedPayment(payment.transactionId), payment);
      assert.equal(issuer.getDeliveryRecord(id(60), delivered.grantId).challengeId, challenge.challengeId);
      assert.throws(() => issuer.installHead(input), /already exists/);
      assert.throws(() => issuer.installHead({ ...input, headId: id(64) }), /already been used/);
      install(issuer, 65);
      const c = signed(issuer.issueAdmittedChallenge(id(65), id(66), 60, "20000000", id(67)));
      issuer.close(); issuer = await open("compact", undefined, {
        admissionPolicy: { maxGrantsPerClaimant: 1000, windowSeconds: 86400,
          resolveFundingOutpoint: async () => ({ txid: delivered.grantId, index: 0 }) },
      });
      await assert.rejects(claim(issuer, id(65), c), /already qualified/);
      return { before, compacted, physicalBefore, physicalAfter: fs.statSync(file).size,
        paymentRetained: true, fundingAndKeyReuseRejected: true };
    } finally { issuer.close(); }
  });
  await check("selected rotation at capacity records the successor without admitting fresh keys", async () => {
    let now = new Date("2026-10-14T12:00:00.000Z");
    const issuer = await open("rotation", { maxRecords: 1033, maxBytes: 4 * 1024 * 1024 }, { now: () => now });
    try {
      const { input } = install(issuer, 70, 3);
      const c = signed(issuer.issueAdmittedChallenge(id(70), id(71), 60, "20000000", id(72)));
      await claim(issuer, id(70), c);
      now = new Date("2026-10-14T12:01:01.000Z");
      assert.equal(issuer.getCurrent(id(70)).phase, "needsRotation");
      const replacement = generateHashChainBorrowGrants(16);
      const successor = observed(4070, replacement.initialGuard);
      const recovered = await issuer.recoverOwnerRotationAfterSelectedObservation(id(70), successor.outpoint.txid, replacement.grants, {
        getSelectedTransaction: async () => ({ transactionId: successor.outpoint.txid, finality: "accepted", spentHead: input.head.outpoint,
          successor: { amount: successor.amount, scriptPublicKey: successor.scriptPublicKey, covenantId: successor.covenantId, authorizingInput: 0 } }),
      });
      assert.deepEqual(recovered.head, successor);
      assert.equal(recovered.phase, "needsRotation");
      assert.equal(recovered.oneTimePublicKey, replacement.grants[0].oneTimePublicKey);
      assert.ok(issuer.getStorageUsage().records <= 1033);
      return { successorRecorded: true, freshKeysUnavailable: true, usage: issuer.getStorageUsage() };
    } finally { issuer.close(); }
  });
  await check("process death during grant commit rolls back admission and delivery", async () => {
    let issuer = await open("crash-grant", { maxRecords: 10000, maxBytes: 4 * 1024 * 1024 });
    try {
      install(issuer, 80);
      const c = signed(issuer.issueAdmittedChallenge(id(80), id(81), 60, "20000000", id(82)));
      const before = issuer.getStorageUsage(); issuer.close();
      const input = path.join(temporary, "crash-grant-input.json");
      fs.writeFileSync(input, JSON.stringify({ file: path.join(temporary, "crash-grant.sqlite"), headId: id(80), claim: c,
        query: "INSERT INTO hash_chain_deliveries", marker: `${input}.marker` }));
      const killed = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--crash-worker", input], { encoding: "utf8", timeout: 30000 });
      assert.equal(fs.readFileSync(`${input}.marker`, "utf8"), "INSERT INTO hash_chain_deliveries");
      assert.ok(killed.signal === "SIGKILL" || (process.platform === "win32" && killed.status !== 0), killed.stderr);
      issuer = await open("crash-grant");
      assert.deepEqual(issuer.getStorageUsage(), before);
      assert.equal(issuer.getCurrent(id(80)).phase, "ready");
      assert.equal(issuer.getDeliveryRecord(id(80), c.grantId), undefined);
      const delivered = await claim(issuer, id(80), c);
      assert.equal(delivered.grantId, c.grantId);
      return { signal: killed.signal, noPartialDisclosure: true, retrySucceeded: true };
    } finally { issuer.close(); }
  });
  await check("process death during retired compaction preserves both heads", async () => {
    let issuer = await open("crash-compact", { maxRecords: 10000, maxBytes: 4 * 1024 * 1024 });
    try {
      for (const n of [90, 91]) {
        const { input } = install(issuer, n, 128);
        issuer.recordAcceptedSweep(id(n), { predecessor: input.head.outpoint, transactionId: id(n + 4000), finality: "accepted", sameIdOutputCount: 0 });
      }
      const before = issuer.getStorageUsage(); issuer.close();
      const input = path.join(temporary, "crash-compact-input.json");
      fs.writeFileSync(input, JSON.stringify({ file: path.join(temporary, "crash-compact.sqlite"), query: "UPDATE hash_chain_grants SET sealed", marker: `${input}.marker` }));
      const killed = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--crash-worker", input], { encoding: "utf8", timeout: 30000 });
      assert.equal(fs.readFileSync(`${input}.marker`, "utf8"), "UPDATE hash_chain_grants SET sealed");
      assert.ok(killed.signal === "SIGKILL" || (process.platform === "win32" && killed.status !== 0), killed.stderr);
      issuer = await open("crash-compact");
      assert.deepEqual(issuer.getStorageUsage(), before);
      assert.equal(issuer.listHeads().filter(h => h.phase === "retired").length, 2);
      issuer.compactStorage();
      assert.ok(issuer.getStorageUsage().bytes < before.bytes - 50000);
      return { signal: killed.signal, atomicRollback: true, maintenanceRetrySucceeded: true };
    } finally { issuer.close(); }
  });
  await check("repeated payments and rotations stop before storage exceeds its envelope", async () => {
    const issuer = await open("growth", { maxRecords: 1084, maxBytes: 4 * 1024 * 1024 });
    try {
      let { chain, input } = install(issuer, 100, 2);
      let before = input.head, payments = 0, rotations = 0, stopped = false;
      for (let n = 0; n < 50; n++) {
        let c;
        try { c = signed(issuer.issueAdmittedChallenge(id(100), id(110 + n), 60, "20000000", id(200 + n))); }
        catch (error) { assert.equal(error.code, "HASH_CHAIN_STORAGE_CAPACITY"); stopped = true; break; }
        let delivery;
        try { delivery = await claim(issuer, id(100), c); }
        catch (error) { assert.equal(error.code, "HASH_CHAIN_STORAGE_CAPACITY"); stopped = true; break; }
        const after = observed(5000 + n * 2, delivery.nextGuard, (BigInt(before.amount) + 20000000n).toString());
        issuer.recordAcceptedPayment(id(100), { predecessor: before.outpoint, successor: after, finality: "accepted" }, {
          transactionId: after.outpoint.txid, grantId: c.grantId, challengeId: c.challengeId,
          requestHash: c.requestHash, payerPublicKey: c.payerPublicKey, requirementsHash: id(300 + n),
          paymentIdentifier: `growth-${n}`, amount: "20000000", finality: "accepted",
        });
        payments++; before = after;
        if (issuer.getCurrent(id(100)).phase === "exhausted") {
          chain = generateHashChainBorrowGrants(2);
          const rotated = observed(5001 + n * 2, chain.initialGuard, before.amount);
          const current = issuer.recordAcceptedRotation(id(100), { predecessor: before.outpoint, successor: rotated, finality: "accepted" }, chain.grants);
          rotations++; before = rotated;
          if (current.phase === "needsRotation") { stopped = true; break; }
        }
      }
      assert.ok(stopped, "sustained payments bypassed aggregate limits");
      assert.ok(payments >= 5 && rotations >= 2, "control workload did not exercise lifecycle growth");
      const usage = issuer.getStorageUsage();
      const fileBytes = fs.statSync(path.join(temporary, "growth.sqlite")).size;
      assert.ok(usage.records <= usage.maxRecords && usage.bytes <= usage.maxBytes);
      assert.ok(fileBytes <= 4 * usage.maxBytes + 1024 * 1024);
      return { payments, rotations, stopped, usage, fileBytes };
    } finally { issuer.close(); }
  });
  await check("portable storage entrypoint enforces the same aggregate limits", async () => {
    const db = new DatabaseSync(path.join(temporary, "portable.sqlite"));
    const issuer = StorageIssuer.fromStorage({ encryptionKey: Buffer.alloc(32, 19),
      storageLimits: { maxRecords: 1036, maxBytes: 4 * 1024 * 1024 },
      database: { exec: q => db.exec(q), prepare: q => db.prepare(q),
        getSchemaVersion: () => db.prepare("PRAGMA user_version").get().user_version,
        setSchemaVersion: v => db.exec(`PRAGMA user_version = ${v}`), close: () => db.close() },
      transactionSync: callback => { db.exec("BEGIN IMMEDIATE"); try { const r = callback(); db.exec("COMMIT"); return r; }
        catch (e) { db.exec("ROLLBACK"); throw e; } },
      admissionPolicy: { maxGrantsPerClaimant: 1000, windowSeconds: 86400,
        resolveFundingOutpoint: async c => ({ txid: c.grantId, index: 0 }) },
    });
    try {
      let stopped = false;
      for (let n = 600; n < 612; n++) {
        try { install(issuer, n); }
        catch (error) { assert.equal(error.code, "HASH_CHAIN_STORAGE_CAPACITY"); stopped = true; break; }
      }
      assert.ok(stopped);
      return { stopped, usage: issuer.getStorageUsage() };
    } finally { issuer.close(); }
  });
  await check("oversized legacy upgrade rejects atomically until capacity is provisioned", async () => {
    let issuer = await open("legacy", { maxRecords: 10000, maxBytes: 8 * 1024 * 1024 });
    for (let n = 700; n < 708; n++) install(issuer, n);
    issuer.close();
    const file = path.join(temporary, "legacy.sqlite");
    const db = new DatabaseSync(file); db.exec("DROP TABLE hash_chain_capacity"); db.close();
    const before = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    await assert.rejects(open("legacy", { maxRecords: 1036, maxBytes: 4 * 1024 * 1024 }), { code: "HASH_CHAIN_STORAGE_CAPACITY" });
    const after = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    assert.equal(after, before, "failed upgrade altered the legacy database");
    issuer = await open("legacy", { maxRecords: 10000, maxBytes: 8 * 1024 * 1024 });
    try {
      assert.equal(issuer.listHeads().length, 8);
      return { rejectedUpgradeUnchanged: true, provisionedUpgradeHeads: 8, usage: issuer.getStorageUsage() };
    } finally { issuer.close(); }
  });
  await check("hybrid SDK route falls back to batch when persistent issuer capacity is full", async () => {
    const issuer = await open("fallback", { maxRecords: 1033, maxBytes: 4 * 1024 * 1024 });
    try {
      const { input } = install(issuer, 800, 3);
      const c = signed(issuer.issueAdmittedChallenge(id(800), id(801), 60, "20000000", id(802)));
      const delivered = await claim(issuer, id(800), c);
      const after = observed(5800, delivered.nextGuard, "120000000");
      issuer.recordAcceptedPayment(id(800), { predecessor: input.head.outpoint, successor: after, finality: "accepted" }, {
        transactionId: after.outpoint.txid, grantId: c.grantId, challengeId: c.challengeId,
        requestHash: c.requestHash, payerPublicKey: c.payerPublicKey, requirementsHash: id(803),
        paymentIdentifier: "fallback-capacity", amount: "20000000", finality: "accepted",
      });
      const server = new DirectModeServer({ network: "kaspa:testnet-10", payTo: "kaspatest:merchant",
        amount: "20000000", confirmationThreshold: 30,
        batch: { serverPublicKey: owner, minDepositSompi: "1000", claimReserveSompi: "10", refundTimeoutDaa: "1000",
          minimumRefundLeadDaa: "0", voucherVerifier: { verifyVoucher: () => true }, batchPresentationVerifier: { verifyPresentation: () => true } },
        store: new MemoryServerChannelStore(), chainProvider: { getVirtualDaaScore: async () => "0" },
        addressCodec: { scriptPublicKeyForAddress: () => "000020" + owner + "ac", encodeScriptAddress: () => "kaspatest:head" },
        exactProfile: "hash-chain-additive", exactTransactionVerifier: { verifyExactPayment: async () => { throw new Error("must not verify an unpaid request"); } },
        hashChainIssuer: issuer, hashChainHeadId: id(800), hashChainGrantClaimUrl: "https://api.example.test/grant",
        admitHashChainChallenge: async () => true, hashChainIsSelected: async () => true,
        hashChainGetCurrentUtxo: async () => ({ outpoint: after.outpoint, amount: after.amount,
          scriptPublicKey: after.scriptPublicKey, covenantId: after.covenantId }),
      });
      const result = await server.handlePaidRequest({ routeAccess: "authenticated", url: "https://api.example.test/resource",
        resource: { url: "https://api.example.test/resource" }, paymentSchemes: ["exact", "batch-settlement"],
        trustedSecurityContext: { principal: "capacity-proof", tenant: "merchant" },
      }, async () => { throw new Error("must not run protected work"); });
      assert.equal(result.status, 402);
      const required = decodePaymentRequiredHeader(result.headers["PAYMENT-REQUIRED"]);
      assert.ok(required.accepts.length > 0);
      assert.ok(required.accepts.every(a => a.scheme === "batch-settlement"));
      return { status: result.status, batchFallback: true, currentHeadVersion: issuer.getCurrent(id(800)).headVersion };
    } finally { issuer.close(); }
  });
  await check("compacted retired heads recover a disclosed borrower spend after a sweep reorg", async () => {
    const evidence = [];
    for (const compact of [false, true]) {
      const issuer = await open(`sweep-reorg-${compact}`, { maxRecords: 10000, maxBytes: 4 * 1024 * 1024 });
      try {
        const { input } = install(issuer, 900, 3);
        const c = signed(issuer.issueAdmittedChallenge(id(900), id(901), 60, "20000000", id(902)));
        const delivered = await claim(issuer, id(900), c);
        issuer.recordAcceptedSweep(id(900), { predecessor: input.head.outpoint, transactionId: id(5900), finality: "accepted", sameIdOutputCount: 0 });
        if (compact) issuer.compactStorage();
        issuer.holdForReorg(id(900));
        issuer.reconcileObservedHead(id(900), input.head);
        const successor = observed(5901, delivered.nextGuard, "110000000");
        const recovered = issuer.recordAcceptedBorrow(id(900), { predecessor: input.head.outpoint, successor, finality: "accepted" });
        assert.deepEqual(recovered.head, successor);
        assert.ok(recovered.phase === "needsRotation" || recovered.phase === "exhausted");
        assert.equal(issuer.getDeliveryRecord(id(900), delivered.grantId).nextGuard, delivered.nextGuard);
        evidence.push({ compact, recovered: true });
      } finally { issuer.close(); }
    }
    return evidence;
  });
  await check("capacity-quarantined rotation keys cannot be reused after provisioned growth", async () => {
    let now = new Date("2026-10-14T12:00:00.000Z");
    const issuer = await open("rotation-keys", { maxRecords: 1033, maxBytes: 4 * 1024 * 1024 }, { now: () => now });
    try {
      const { input } = install(issuer, 950, 3);
      const c = signed(issuer.issueAdmittedChallenge(id(950), id(951), 60, "20000000", id(952)));
      await claim(issuer, id(950), c);
      now = new Date("2026-10-14T12:01:01.000Z");
      issuer.getCurrent(id(950));
      const replacement = generateHashChainBorrowGrants(1024);
      const successor = observed(5950, replacement.initialGuard);
      issuer.recordAcceptedRotation(id(950), { predecessor: input.head.outpoint, successor, finality: "accepted" }, replacement.grants);
      assert.equal(issuer.getCurrent(id(950)).phase, "needsRotation");
      assert.equal(issuer.getStorageUsage().records, 1032);
      issuer.increaseStorageLimits({ maxRecords: 10000, maxBytes: 8 * 1024 * 1024 });
      assert.throws(() => issuer.installHead({ ...input, headId: id(953), head: observed(5951, replacement.initialGuard), grants: replacement.grants }), /already been used/);
      return { successorRecorded: true, quarantinedKeysRemainReserved: true };
    } finally { issuer.close(); }
  });
} finally {
  const files = ["packages/server/src/hash-chain-issuer.ts", "packages/server/src/hash-chain-grants.ts", "packages/server/src/direct-server.ts",
    "scripts/proof-hash-chain-issuer-storage-e2e.mjs"];
  const revision = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
  const report = { schema: "kaspa-x402-issuer-storage-e2e/v1",
    revision: revision.status === 0 ? revision.stdout.trim() : null,
    evidenceBoundary: "Exported SDK, real SQLite and filesystem; controlled selected-chain observations; no funded/live proof.",
    sourceSha256: Object.fromEntries(files.map(file => [file, crypto.createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex")])),
    builtServerSha256: Object.fromEntries(fs.readdirSync(path.join(root, "packages/server/dist")).filter(file => file.endsWith(".js"))
      .map(file => [file, crypto.createHash("sha256").update(fs.readFileSync(path.join(root, "packages/server/dist", file))).digest("hex")])),
    cases, passed: cases.filter(c => c.passed).length, failed: cases.filter(c => !c.passed).length };
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  fs.rmSync(temporary, { recursive: true, force: true });
  console.log(JSON.stringify({ report: output, passed: report.passed, failed: report.failed }));
  if (report.failed) process.exitCode = 1;
}
