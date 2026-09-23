import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, lstatSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  hashChainBorrowGuard,
  hashChainHeadScriptPublicKey,
  type HashChainBorrowGrant,
} from "@kaspa-x402/covenant";
import { stableStringify } from "@kaspa-x402/core";
import type { HashChainChainView } from "./hash-chain-verifier.js";

export interface HashChainOutpoint { txid: string; index: 0 }
export interface HashChainObservedHead {
  outpoint: HashChainOutpoint;
  amount: string;
  guard: string;
  scriptPublicKey: string;
  covenantId: string;
}
export interface HashChainGrantClaim {
  grantId: string;
  challengeId: string;
  requestHash: string;
  payerPublicKey: string;
  expiresAt: string;
  signature: string;
}
export interface HashChainPublicGrant {
  headId: string;
  headVersion: number;
  network: string;
  ownerPublicKey: string;
  head: HashChainObservedHead;
  grantId: string;
  nextGuard: string;
  oneTimePublicKey: string;
  phase: "ready" | "assigned" | "needsRotation" | "hold" | "exhausted" | "retired";
}
export interface HashChainGrantChallenge {
  headId: string;
  headVersion: number;
  grantId: string;
  challengeId: string;
  requestHash: string;
  quotedAmount: string;
  issuedAt: string;
  expiresAt: string;
}
export interface HashChainGrantDelivery {
  /** A caller exposing this over HTTP must send Cache-Control: no-store. */
  cacheControl: "no-store";
  grantId: string;
  headVersion: number;
  nextGuard: string;
  oneTimePublicKey: string;
  oneTimePrivateKey: string;
  expiresAt: string;
  deliveryCommittedAt: string;
}
export interface HashChainGrantDeliveryRecord {
  headId: string;
  headVersion: number;
  headOutpoint: HashChainOutpoint;
  headAmount: string;
  headGuard: string;
  headScriptPublicKey: string;
  covenantId: string;
  ownerPublicKey: string;
  grantId: string;
  nextGuard: string;
  oneTimePublicKey: string;
  challengeId: string;
  challengeIssuedAt: string;
  challengeExpiresAt: string;
  requestHash: string;
  quotedAmount: string;
  payerPublicKey: string;
  expiresAt: string;
  deliveryCommittedAt: string;
}
export interface HashChainAcceptedPayment {
  transactionId: string;
  grantId: string;
  challengeId: string;
  requestHash: string;
  payerPublicKey: string;
  requirementsHash: string;
  paymentIdentifier: string;
  amount: string;
  finality: "accepted" | "confirmed";
}
export interface HashChainAcceptedTransition {
  /** This must come from a trusted selected-chain observer, never a payer hint. */
  finality: "accepted" | "confirmed";
  predecessor: HashChainOutpoint;
  successor: HashChainObservedHead;
}
export interface HashChainAcceptedSweep {
  /** This must come from a trusted selected-chain observer, never a payer hint. */
  finality: "accepted" | "confirmed";
  predecessor: HashChainOutpoint;
  transactionId: string;
  sameIdOutputCount: 0;
}

interface StoredGrant extends HashChainBorrowGrant { grantId: string }
interface StoredChallenge extends HashChainGrantChallenge {}
interface StoredAssignment {
  grantId: string;
  challengeId: string;
  requestHash: string;
  quotedAmount: string;
  payerPublicKey: string;
  expiresAt: string;
  deliveryCommittedAt: string;
}
interface StoredHead {
  headId: string;
  version: number;
  network: string;
  ownerPublicKey: string;
  head: HashChainObservedHead;
  grants: StoredGrant[];
  nextIndex: number;
  phase: HashChainPublicGrant["phase"];
  challenges: StoredChallenge[];
  assignment?: StoredAssignment;
  phaseBeforeHold?: Exclude<HashChainPublicGrant["phase"], "hold">;
  history: { head: HashChainObservedHead; grant?: StoredGrant; exposed: boolean }[];
}

/** SHA-256 of the exact canonical object in spec/kaspa-hash-chain-exact-v1.md. */
export function hashChainGrantClaimDigest(network: string, claim: Omit<HashChainGrantClaim, "signature">): Uint8Array {
  return createHash("sha256").update(stableStringify({
    scope: "kaspa-x402-hash-chain-grant-claim-v1",
    network,
    binding: "kaspa-hash-chain-exact-v1",
    grantId: claim.grantId,
    challengeId: claim.challengeId,
    requestHash: claim.requestHash,
    payerPublicKey: claim.payerPublicKey,
    expiresAt: claim.expiresAt,
  })).digest();
}

export interface HashChainGrantIssuerOptions {
  databasePath: string;
  /** Caller-managed 32-byte encryption key; loss of this key loses all outstanding grants. */
  encryptionKey: Uint8Array;
  /** Application authentication and rate-limit admission, called before assignment. */
  canClaim: (claim: HashChainGrantClaim, grant: HashChainPublicGrant) => boolean;
  now?: () => Date;
}

/**
 * Durable private capability issuer. All state changes use BEGIN IMMEDIATE and
 * a synchronous FULL SQLite commit before a signing key is returned. This
 * adapter requires an unflagged node:sqlite runtime (Node >=22.13).
 */
export class HashChainGrantIssuer {
  private constructor(
    private readonly db: DatabaseSync,
    private readonly key: Buffer,
    private readonly canClaim: HashChainGrantIssuerOptions["canClaim"],
    private readonly now: () => Date,
  ) {}

  static async open(options: HashChainGrantIssuerOptions): Promise<HashChainGrantIssuer> {
    if (options.encryptionKey.length !== 32) throw new Error("grant encryption key must be 32 bytes");
    if (!options.databasePath || options.databasePath === ":memory:") throw new Error("grant database must be a durable file");
    if (typeof options.canClaim !== "function") throw new Error("grant payer admission callback is required");
    if (!existsSync(options.databasePath)) {
      closeSync(openSync(options.databasePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600));
      if (process.platform !== "win32") {
        const directory = openSync(path.dirname(options.databasePath), constants.O_RDONLY);
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
    }
    checkPrivateFile(options.databasePath);
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(options.databasePath);
    const key = Buffer.from(options.encryptionKey);
    try {
      checkPrivateFile(options.databasePath);
      db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;");
      db.exec("CREATE TABLE IF NOT EXISTS hash_chain_grants (head_id TEXT PRIMARY KEY, sealed BLOB NOT NULL)");
      db.exec("CREATE TABLE IF NOT EXISTS hash_chain_deliveries (head_id TEXT NOT NULL, grant_id TEXT NOT NULL, sealed BLOB NOT NULL, PRIMARY KEY(head_id, grant_id))");
      db.exec("CREATE TABLE IF NOT EXISTS hash_chain_payments (transaction_id TEXT PRIMARY KEY, grant_id TEXT NOT NULL UNIQUE, sealed BLOB NOT NULL)");
      db.exec("CREATE TABLE IF NOT EXISTS hash_chain_seen_keys (key_fingerprint TEXT PRIMARY KEY, head_id TEXT NOT NULL)");
      db.exec("CREATE TABLE IF NOT EXISTS hash_chain_meta (id INTEGER PRIMARY KEY CHECK(id = 1), sealed BLOB NOT NULL)");
      db.exec("BEGIN IMMEDIATE");
      try {
        const schemaVersion = db.prepare("PRAGMA user_version").get() as { user_version: number };
        if (schemaVersion.user_version !== 0 && schemaVersion.user_version !== 1 && schemaVersion.user_version !== 2) {
          throw new Error("unsupported grant database schema version");
        }
        const row = db.prepare("SELECT sealed FROM hash_chain_meta WHERE id = 1").get() as { sealed: Uint8Array } | undefined;
        if (row) {
          let verifier = "";
          try {
            verifier = unseal(key, "hash-chain-store-v1", Buffer.from(row.sealed)).toString("utf8");
          } catch {
            throw new Error("grant database encryption key is wrong");
          }
          if (verifier !== "hash-chain-store-v1") {
            throw new Error("grant database encryption key is wrong");
          }
        } else {
          const existingHeads = db.prepare("SELECT COUNT(*) AS count FROM hash_chain_grants").get() as { count: number };
          const existingDeliveries = db.prepare("SELECT COUNT(*) AS count FROM hash_chain_deliveries").get() as { count: number };
          if (existingHeads.count !== 0 || existingDeliveries.count !== 0) {
            throw new Error("grant database encryption metadata is missing");
          }
          db.prepare("INSERT INTO hash_chain_meta(id, sealed) VALUES(1, ?)")
            .run(seal(key, "hash-chain-store-v1", Buffer.from("hash-chain-store-v1")));
        }
        if (schemaVersion.user_version === 0) migrateLegacyGrantKeys(db, key);
        if (schemaVersion.user_version !== 2) migrateQuotedGrants(db, key);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return new HashChainGrantIssuer(db, key, options.canClaim, options.now ?? (() => new Date()));
    } catch (error) {
      db.close();
      key.fill(0);
      throw error;
    }
  }

  close(): void { this.db.close(); this.key.fill(0); }

  installHead(input: {
    headId: string; network: string; ownerPublicKey: string;
    head: HashChainObservedHead; grants: readonly HashChainBorrowGrant[];
  }): HashChainPublicGrant {
    const headId = hex32(input.headId, "headId");
    const ownerPublicKey = hex32(input.ownerPublicKey, "ownerPublicKey");
    assertSupportedGrantNetwork(input.network);
    const head = normalizeHead(input.head, ownerPublicKey);
    if (!input.grants.length || input.grants.length > 1024) throw new Error("grant chain length is invalid");
    const grants = input.grants.map((grant) => normalizeGrant(grant));
    let expectedGuard = head.guard;
    for (const grant of grants) {
      if (hashChainBorrowGuard(grant.revealedGuard, grant.oneTimePublicKey) !== expectedGuard) {
        throw new Error("grant chain does not match current head guard");
      }
      expectedGuard = grant.revealedGuard;
    }
    const stored: StoredHead = {
      headId, version: 0, network: input.network, ownerPublicKey, head, grants,
      nextIndex: 0, phase: "ready", challenges: [], history: [],
    };
    return this.mutate(headId, (current) => {
      if (current) throw new Error("grant head already exists");
      if (this.rememberGrantKeys(headId, grants)) throw new Error("one-time key has already been used");
      return [stored, publicGrant(stored)];
    });
  }

  getCurrent(headId: string): HashChainPublicGrant {
    return publicGrant(this.read(hex32(headId, "headId")));
  }

  /** Historical, encrypted delivery evidence for later exact settlement. Never exposes a private key. */
  getDeliveryRecord(headId: string, grantId: string): HashChainGrantDeliveryRecord | undefined {
    const id = hex32(headId, "headId");
    const grant = hex32(grantId, "grantId");
    const row = this.db.prepare("SELECT sealed FROM hash_chain_deliveries WHERE head_id = ? AND grant_id = ?")
      .get(id, grant) as { sealed: Uint8Array } | undefined;
    return row ? JSON.parse(unseal(this.key, `${id}:${grant}`, Buffer.from(row.sealed)).toString("utf8")) as HashChainGrantDeliveryRecord : undefined;
  }

  getChallenge(headId: string, challengeId: string): HashChainGrantChallenge | undefined {
    const state = this.read(hex32(headId, "headId"));
    return state.challenges.find((item) => item.challengeId === hex32(challengeId, "challengeId"));
  }

  getAcceptedPayment(transactionId: string): HashChainAcceptedPayment | undefined {
    const txid = hex32(transactionId, "transactionId");
    const row = this.db.prepare("SELECT sealed FROM hash_chain_payments WHERE transaction_id = ?")
      .get(txid) as { sealed: Uint8Array } | undefined;
    return row ? JSON.parse(unseal(this.key, `payment:${txid}`, Buffer.from(row.sealed)).toString("utf8")) as HashChainAcceptedPayment : undefined;
  }

  issueChallenge(headId: string, requestHash: string, lifetimeSeconds: number, quotedAmount: string): HashChainGrantChallenge {
    const id = hex32(headId, "headId");
    const request = hex32(requestHash, "requestHash");
    const amount = canonicalAmount(quotedAmount);
    if (!Number.isSafeInteger(lifetimeSeconds) || lifetimeSeconds < 1 || lifetimeSeconds > 300) {
      throw new Error("challenge lifetime must be 1 to 300 seconds");
    }
    return this.mutate(id, (state) => {
      if (!state || state.phase !== "ready") throw new Error("current grant is unavailable");
      const now = this.now().getTime();
      state.challenges = state.challenges.filter((challenge) => Date.parse(challenge.expiresAt) >= now);
      if (state.challenges.length >= 64) throw new Error("too many live challenges for head");
      const challenge: HashChainGrantChallenge = {
        headId: id, headVersion: state.version, grantId: state.grants[state.nextIndex]!.grantId,
        challengeId: randomBytes(32).toString("hex"), requestHash: request, quotedAmount: amount,
        issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + lifetimeSeconds * 1000).toISOString(),
      };
      state.challenges.push(challenge);
      return [state, challenge];
    });
  }

  claimGrant(headId: string, claim: HashChainGrantClaim): HashChainGrantDelivery {
    const id = hex32(headId, "headId");
    const normalized = normalizeClaim(claim);
    return this.mutate(id, (state) => {
      if (!state || (state.phase !== "ready" && state.phase !== "assigned")) throw new Error("current grant is unavailable");
      const grant = state.grants[state.nextIndex]!;
      const challenge = state.challenges.find((item) => item.challengeId === normalized.challengeId);
      const now = this.now().getTime();
      if (!challenge || challenge.headVersion !== state.version || challenge.grantId !== grant.grantId
        || challenge.requestHash !== normalized.requestHash || normalized.grantId !== grant.grantId
        || (!challenge.quotedAmount && !state.assignment)
        || Date.parse(challenge.expiresAt) < now || Date.parse(normalized.expiresAt) < now
        || Date.parse(normalized.expiresAt) > Date.parse(challenge.expiresAt)) {
        throw new Error("grant claim does not match a live challenge");
      }
      const digest = hashChainGrantClaimDigest(state.network, normalized);
      if (!schnorr.verify(Buffer.from(normalized.signature, "hex"), digest, Buffer.from(normalized.payerPublicKey, "hex"))) {
        throw new Error("invalid grant payer signature");
      }
      const tupleMatches = state.assignment && state.assignment.grantId === normalized.grantId
        && state.assignment.challengeId === normalized.challengeId
        && state.assignment.requestHash === normalized.requestHash
        && state.assignment.payerPublicKey === normalized.payerPublicKey
        && state.assignment.expiresAt === normalized.expiresAt;
      if (state.assignment && !tupleMatches) throw new Error("grant is assigned to another payer or request");
      if (!state.assignment) {
        if (!this.canClaim(normalized, publicGrant(state))) throw new Error("payer is ineligible for grant");
        state.assignment = {
          grantId: normalized.grantId, challengeId: normalized.challengeId,
          requestHash: normalized.requestHash, quotedAmount: challenge.quotedAmount,
          payerPublicKey: normalized.payerPublicKey,
          expiresAt: normalized.expiresAt, deliveryCommittedAt: this.now().toISOString(),
        };
        state.phase = "assigned";
        state.challenges = [challenge];
        const record: HashChainGrantDeliveryRecord = {
          headId: state.headId, headVersion: state.version, headOutpoint: state.head.outpoint,
          headAmount: state.head.amount, headGuard: state.head.guard,
          headScriptPublicKey: state.head.scriptPublicKey, covenantId: state.head.covenantId,
          ownerPublicKey: state.ownerPublicKey,
          grantId: grant.grantId, nextGuard: grant.revealedGuard, oneTimePublicKey: grant.oneTimePublicKey,
          challengeId: normalized.challengeId, challengeIssuedAt: challenge.issuedAt,
          challengeExpiresAt: challenge.expiresAt,
          requestHash: normalized.requestHash, quotedAmount: challenge.quotedAmount,
          payerPublicKey: normalized.payerPublicKey, expiresAt: normalized.expiresAt,
          deliveryCommittedAt: state.assignment.deliveryCommittedAt,
        };
        this.db.prepare("INSERT INTO hash_chain_deliveries(head_id, grant_id, sealed) VALUES(?, ?, ?)")
          .run(id, grant.grantId, seal(this.key, `${id}:${grant.grantId}`, Buffer.from(JSON.stringify(record))));
      }
      const assigned = state.assignment;
      return [state, {
        cacheControl: "no-store" as const,
        grantId: grant.grantId, headVersion: state.version,
        nextGuard: grant.revealedGuard, oneTimePublicKey: grant.oneTimePublicKey,
        oneTimePrivateKey: grant.oneTimePrivateKey,
        expiresAt: assigned.expiresAt, deliveryCommittedAt: assigned.deliveryCommittedAt,
      }];
    });
  }

  markAbandoned(headId: string): HashChainPublicGrant {
    const id = hex32(headId, "headId");
    return this.mutate(id, (state) => {
      if (!state || state.phase !== "assigned" || !state.assignment) throw new Error("no assigned grant to abandon");
      if (Date.parse(state.assignment.expiresAt) >= this.now().getTime()) throw new Error("assigned grant has not expired");
      state.phase = "needsRotation";
      state.challenges = [];
      return [state, publicGrant(state)];
    });
  }

  recordAcceptedBorrow(headId: string, transition: HashChainAcceptedTransition): HashChainPublicGrant {
    return this.advance(headId, transition, "borrow");
  }

  /** Recover a held, unmatched spend only after an authoritative selected-chain readback. */
  async recoverSelectedUnmatchedBorrow(
    headId: string,
    transactionId: string,
    chain: Pick<HashChainChainView, "getSelectedTransaction">,
  ): Promise<HashChainPublicGrant> {
    const id = hex32(headId, "headId");
    const txid = hex32(transactionId, "transactionId");
    const current = this.getCurrent(id);
    if (current.phase !== "hold" || !current.nextGuard) throw new Error("head is not awaiting an assigned borrow readback");
    const selected = await chain.getSelectedTransaction(txid);
    if (!selected || selected.transactionId !== txid ||
      (selected.finality !== "accepted" && selected.finality !== "confirmed") ||
      !sameOutpoint(selected.spentHead, current.head.outpoint) ||
      selected.successor.authorizingInput !== 0 ||
      selected.successor.covenantId !== current.head.covenantId ||
      selected.successor.scriptPublicKey !== hashChainHeadScriptPublicKey({
        ownerPublicKey: current.ownerPublicKey, guard: current.nextGuard,
      })) {
      throw new Error("transaction is not the selected successor of the held head");
    }
    const latest = this.getCurrent(id);
    if (latest.headVersion !== current.headVersion || latest.phase !== "hold" ||
      !sameHead(latest.head, current.head)) {
      throw new Error("held head changed during selected-chain readback");
    }
    return this.recordAcceptedBorrow(id, {
      finality: selected.finality,
      predecessor: current.head.outpoint,
      successor: {
        outpoint: { txid, index: 0 }, amount: selected.successor.amount,
        guard: current.nextGuard, scriptPublicKey: selected.successor.scriptPublicKey,
        covenantId: selected.successor.covenantId,
      },
    });
  }

  /** Atomically consume a delivered link and record one x402 payment before protected work. */
  recordAcceptedPayment(
    headId: string,
    transition: HashChainAcceptedTransition,
    payment: HashChainAcceptedPayment,
  ): HashChainPublicGrant {
    const id = hex32(headId, "headId");
    const normalized: HashChainAcceptedPayment = {
      transactionId: hex32(payment.transactionId, "transactionId"),
      grantId: hex32(payment.grantId, "grantId"),
      challengeId: hex32(payment.challengeId, "challengeId"),
      requestHash: hex32(payment.requestHash, "requestHash"),
      payerPublicKey: hex32(payment.payerPublicKey, "payerPublicKey"),
      requirementsHash: hex32(payment.requirementsHash, "requirementsHash"),
      paymentIdentifier: payment.paymentIdentifier,
      amount: canonicalAmount(payment.amount),
      finality: payment.finality,
    };
    if (!normalized.paymentIdentifier || normalized.paymentIdentifier.length > 256 ||
      (normalized.finality !== "accepted" && normalized.finality !== "confirmed") ||
      normalized.transactionId !== transition.successor.outpoint.txid ||
      normalized.finality !== transition.finality) throw new Error("accepted payment evidence is inconsistent");
    const existing = this.getAcceptedPayment(normalized.transactionId);
    if (existing) {
      if (stableStringify({ ...existing, finality: "accepted" }) !==
        stableStringify({ ...normalized, finality: "accepted" })) {
        throw new Error("transaction already belongs to another payment");
      }
      return this.getCurrent(id);
    }
    return this.advance(id, transition, "borrow", undefined, normalized);
  }

  recordAcceptedRotation(
    headId: string, transition: HashChainAcceptedTransition, grants: readonly HashChainBorrowGrant[],
  ): HashChainPublicGrant {
    return this.advance(headId, transition, "rotate", grants);
  }

  recordAcceptedSweep(headId: string, sweep: HashChainAcceptedSweep): HashChainPublicGrant {
    const id = hex32(headId, "headId");
    if ((sweep.finality !== "accepted" && sweep.finality !== "confirmed") || sweep.sameIdOutputCount !== 0) {
      throw new Error("owner sweep lacks accepted zero-successor evidence");
    }
    const sweepTxid = hex32(sweep.transactionId, "owner sweep transactionId");
    return this.mutate(id, (state) => {
      if (!state || state.phase === "hold" || state.phase === "retired") throw new Error("head cannot be swept in its current phase");
      if (!sameOutpoint(normalizeOutpoint(sweep.predecessor), state.head.outpoint)) {
        throw new Error("owner sweep does not spend the current head");
      }
      if (sweepTxid === state.head.outpoint.txid) throw new Error("owner sweep transaction cannot reuse the head txid");
      state.history.push({ head: state.head, grant: state.grants[state.nextIndex], exposed: !!state.assignment });
      if (state.history.length > 128) state.history.shift();
      state.version++;
      state.phase = "retired";
      state.assignment = undefined;
      state.challenges = [];
      return [state, publicGrant(state)];
    });
  }

  holdForReorg(headId: string): HashChainPublicGrant {
    const id = hex32(headId, "headId");
    return this.mutate(id, (state) => {
      if (!state) throw new Error("grant head is missing");
      if (state.phase !== "hold") state.phaseBeforeHold = state.phase;
      state.phase = "hold";
      return [state, publicGrant(state)];
    });
  }

  reconcileObservedHead(headId: string, observed: HashChainObservedHead): HashChainPublicGrant {
    const id = hex32(headId, "headId");
    return this.mutate(id, (state) => {
      if (!state || state.phase !== "hold") throw new Error("head is not in reconciliation hold");
      const actual = normalizeHead(observed, state.ownerPublicKey);
      if (sameHead(actual, state.head)) {
        const prior = state.phaseBeforeHold ?? "needsRotation";
        state.phase = prior === "retired" ? "needsRotation" : prior;
      } else {
        const previous = state.history.find((item) => sameHead(item.head, actual));
        if (!previous) throw new Error("observed head is outside known lineage; keep hold and investigate");
        state.head = actual;
        state.grants = previous.grant ? [previous.grant] : [];
        state.nextIndex = 0;
        state.assignment = undefined;
        state.challenges = [];
        state.phase = "needsRotation";
      }
      state.phaseBeforeHold = undefined;
      return [state, publicGrant(state)];
    });
  }

  private advance(
    headId: string, transition: HashChainAcceptedTransition, kind: "borrow" | "rotate",
    replacement?: readonly HashChainBorrowGrant[],
    payment?: HashChainAcceptedPayment,
  ): HashChainPublicGrant {
    const id = hex32(headId, "headId");
    if (transition.finality !== "accepted" && transition.finality !== "confirmed") throw new Error("transition lacks trusted accepted finality");
    return this.mutate(id, (state) => {
      // A payer may spend an assigned head before grant readback puts it on hold.
      // A held exact payment needs its signed payment proof; an unmatched borrow
      // needs the durable quote and trusted selected-chain transition below.
      if (!state || state.phase === "retired" ||
        (state.phase === "hold" && (kind !== "borrow" || (payment && state.phaseBeforeHold !== "assigned")))) {
        throw new Error("head must be live and reconciled before advancement");
      }
      const before = state.head;
      const predecessor = normalizeOutpoint(transition.predecessor);
      if (!sameOutpoint(predecessor, before.outpoint)) throw new Error("transition does not spend the current head");
      const after = normalizeHead(transition.successor, state.ownerPublicKey);
      if (after.covenantId !== before.covenantId || sameOutpoint(after.outpoint, before.outpoint)) {
        throw new Error("successor changed covenant identity or reused outpoint");
      }
      const grant = state.grants[state.nextIndex];
      let replacementGrants: StoredGrant[] = [];
      let replacementMatches = false;
      let replacementSafe = false;
      if (kind === "borrow") {
        if (!grant || after.guard !== grant.revealedGuard || BigInt(after.amount) <= BigInt(before.amount)) {
          throw new Error("accepted borrow is not the current positive head transition");
        }
        if (state.phase === "hold" && !payment) {
          const assigned = state.assignment;
          const delivery = assigned && this.getDeliveryRecord(id, assigned.grantId);
          if ((state.phaseBeforeHold !== "assigned" && state.phaseBeforeHold !== "needsRotation") ||
            !assigned?.quotedAmount || !delivery || delivery.quotedAmount !== assigned.quotedAmount ||
            assigned.grantId !== grant.grantId || delivery.headVersion !== state.version ||
            !sameOutpoint(delivery.headOutpoint, before.outpoint) ||
            BigInt(after.amount) - BigInt(before.amount) === BigInt(assigned.quotedAmount)) {
            throw new Error("held head requires a nonconforming assigned borrow");
          }
        }
        if (payment) {
          const assigned = state.assignment;
          const delivery = this.getDeliveryRecord(id, payment.grantId);
          if (!assigned || !delivery || grant.grantId !== payment.grantId ||
            assigned.challengeId !== payment.challengeId || assigned.requestHash !== payment.requestHash ||
            assigned.payerPublicKey !== payment.payerPublicKey || delivery.headVersion !== state.version ||
            !sameOutpoint(delivery.headOutpoint, before.outpoint) ||
            delivery.headAmount !== before.amount || delivery.headGuard !== before.guard ||
            (assigned.quotedAmount && assigned.quotedAmount !== payment.amount) ||
            (delivery.quotedAmount && delivery.quotedAmount !== payment.amount) ||
            BigInt(after.amount) !== BigInt(before.amount) + BigInt(payment.amount)) {
            throw new Error("accepted payment does not consume the assigned exact grant");
          }
          this.db.prepare("INSERT INTO hash_chain_payments(transaction_id, grant_id, sealed) VALUES(?, ?, ?)")
            .run(payment.transactionId, payment.grantId,
              seal(this.key, `payment:${payment.transactionId}`, Buffer.from(JSON.stringify(payment))));
        }
      } else {
        if (after.guard === before.guard || BigInt(after.amount) < BigInt(before.amount)) {
          throw new Error("accepted owner rotation is invalid");
        }
        if (replacement && replacement.length > 0 && replacement.length <= 1024) {
          try {
            replacementGrants = replacement.map((item) => normalizeGrant(item));
            let guard = after.guard;
            replacementMatches = true;
            for (const item of replacementGrants) {
              if (hashChainBorrowGuard(item.revealedGuard, item.oneTimePublicKey) !== guard) {
                replacementMatches = false;
                break;
              }
              guard = item.revealedGuard;
            }
          } catch {
            replacementMatches = false;
          }
        }
        if (replacementMatches) replacementSafe = !this.rememberGrantKeys(id, replacementGrants);
      }
      const wasQuarantined = state.phase === "needsRotation" ||
        (state.phase === "hold" && state.phaseBeforeHold === "needsRotation");
      state.history.push({ head: before, grant, exposed: !!state.assignment });
      if (state.history.length > 128) state.history.shift();
      state.head = after;
      state.version++;
      state.challenges = [];
      state.assignment = undefined;
      state.phaseBeforeHold = undefined;
      if (kind === "borrow") state.nextIndex++;
      else { state.grants = replacementMatches ? replacementGrants : []; state.nextIndex = 0; }
      state.phase = kind === "rotate" && !replacementSafe
        ? "needsRotation" : state.nextIndex >= state.grants.length ? "exhausted"
          : wasQuarantined && kind === "borrow" ? "needsRotation" : "ready";
      return [state, publicGrant(state)];
    });
  }

  /** Reserve every one-time key across this store; duplicates quarantine a rotation. */
  private rememberGrantKeys(headId: string, grants: readonly StoredGrant[]): boolean {
    const find = this.db.prepare("SELECT 1 AS present FROM hash_chain_seen_keys WHERE key_fingerprint = ?");
    const insert = this.db.prepare("INSERT INTO hash_chain_seen_keys(key_fingerprint, head_id) VALUES(?, ?)");
    let reused = false;
    for (const grant of grants) {
      const fingerprint = grantKeyFingerprint(this.key, grant.oneTimePublicKey);
      if (find.get(fingerprint)) reused = true;
      else insert.run(fingerprint, headId);
    }
    return reused;
  }

  private read(headId: string): StoredHead {
    const row = this.db.prepare("SELECT sealed FROM hash_chain_grants WHERE head_id = ?").get(headId) as { sealed: Uint8Array } | undefined;
    if (!row) throw new Error("grant head is missing");
    const state = JSON.parse(unseal(this.key, headId, Buffer.from(row.sealed)).toString("utf8")) as StoredHead;
    assertSupportedGrantNetwork(state.network);
    return state;
  }

  private mutate<T>(headId: string, change: (current: StoredHead | undefined) => [StoredHead, T]): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT sealed FROM hash_chain_grants WHERE head_id = ?").get(headId) as { sealed: Uint8Array } | undefined;
      const current = row ? JSON.parse(unseal(this.key, headId, Buffer.from(row.sealed)).toString("utf8")) as StoredHead : undefined;
      if (current) assertSupportedGrantNetwork(current.network);
      const [next, result] = change(current);
      this.db.prepare("INSERT INTO hash_chain_grants(head_id, sealed) VALUES(?, ?) ON CONFLICT(head_id) DO UPDATE SET sealed = excluded.sealed")
        .run(headId, seal(this.key, headId, Buffer.from(JSON.stringify(next))));
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function publicGrant(state: StoredHead): HashChainPublicGrant {
  const grant = state.grants[state.nextIndex];
  return {
    headId: state.headId, headVersion: state.version, network: state.network,
    ownerPublicKey: state.ownerPublicKey, head: state.head,
    grantId: grant?.grantId ?? "", nextGuard: grant?.revealedGuard ?? "",
    oneTimePublicKey: grant?.oneTimePublicKey ?? "", phase: state.phase,
  };
}

function normalizeGrant(grant: HashChainBorrowGrant): StoredGrant {
  const revealedGuard = hex32(grant.revealedGuard, "revealedGuard");
  const oneTimePublicKey = hex32(grant.oneTimePublicKey, "oneTimePublicKey");
  const oneTimePrivateKey = hex32(grant.oneTimePrivateKey, "oneTimePrivateKey");
  if (Buffer.from(schnorr.getPublicKey(Buffer.from(oneTimePrivateKey, "hex"))).toString("hex") !== oneTimePublicKey) {
    throw new Error("one-time private key does not match public key");
  }
  return { revealedGuard, oneTimePublicKey, oneTimePrivateKey, grantId: randomBytes(32).toString("hex") };
}

function normalizeHead(head: HashChainObservedHead, ownerPublicKey: string): HashChainObservedHead {
  const outpoint = normalizeOutpoint(head.outpoint);
  const amount = canonicalAmount(head.amount);
  const guard = hex32(head.guard, "guard");
  const covenantId = hex32(head.covenantId, "covenantId");
  if (/^0+$/.test(covenantId)) throw new Error("covenantId must be nonzero");
  const scriptPublicKey = hashChainHeadScriptPublicKey({ ownerPublicKey, guard });
  if (head.scriptPublicKey.toLowerCase() !== scriptPublicKey) throw new Error("head script does not match pinned covenant and guard");
  return { outpoint, amount, guard, covenantId, scriptPublicKey };
}

function normalizeOutpoint(outpoint: HashChainOutpoint): HashChainOutpoint {
  if (outpoint?.index !== 0) throw new Error("head outpoint must be output zero");
  return { txid: hex32(outpoint.txid, "head txid"), index: 0 };
}

function normalizeClaim(claim: HashChainGrantClaim): HashChainGrantClaim {
  const expiresAt = new Date(claim.expiresAt);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.toISOString() !== claim.expiresAt) {
    throw new Error("grant claim expiry must be canonical UTC ISO time");
  }
  if (!/^[0-9a-f]{128}$/.test(claim.signature)) throw new Error("grant signature must be lowercase 64-byte hex");
  return {
    grantId: hex32(claim.grantId, "grantId"), challengeId: hex32(claim.challengeId, "challengeId"),
    requestHash: hex32(claim.requestHash, "requestHash"), payerPublicKey: hex32(claim.payerPublicKey, "payerPublicKey"),
    expiresAt: claim.expiresAt, signature: claim.signature,
  };
}

function canonicalAmount(value: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) === 0n || BigInt(value) > 0xffff_ffff_ffff_ffffn) {
    throw new Error("head amount must be a positive canonical uint64 string");
  }
  return value;
}

function assertSupportedGrantNetwork(network: string): void {
  if (network !== "kaspa:testnet-10") throw new Error("unsupported grant network");
}

function hex32(value: string, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be lowercase 32-byte hex`);
  return value;
}

function sameOutpoint(a: { txid: string; index: number }, b: { txid: string; index: number }): boolean {
  return a.txid === b.txid && a.index === b.index;
}
function sameHead(a: HashChainObservedHead, b: HashChainObservedHead): boolean {
  return sameOutpoint(a.outpoint, b.outpoint) && a.amount === b.amount && a.guard === b.guard
    && a.scriptPublicKey === b.scriptPublicKey && a.covenantId === b.covenantId;
}

function checkPrivateFile(file: string): void {
  if (!existsSync(file)) return;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("grant database path must be a regular file");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("grant database file must be private (0600)");
  }
}

/** Earlier local stores lacked the durable key index; quarantine their live heads. */
function migrateLegacyGrantKeys(db: DatabaseSync, key: Buffer): void {
  const insert = db.prepare("INSERT OR IGNORE INTO hash_chain_seen_keys(key_fingerprint, head_id) VALUES(?, ?)");
  const heads = db.prepare("SELECT head_id, sealed FROM hash_chain_grants").all() as { head_id: string; sealed: Uint8Array }[];
  const update = db.prepare("UPDATE hash_chain_grants SET sealed = ? WHERE head_id = ?");
  for (const row of heads) {
    const state = JSON.parse(unseal(key, row.head_id, Buffer.from(row.sealed)).toString("utf8")) as StoredHead;
    for (const grant of state.grants) {
      insert.run(grantKeyFingerprint(key, hex32(grant.oneTimePublicKey, "stored one-time key")), row.head_id);
    }
    for (const entry of state.history) {
      if (entry.grant) insert.run(grantKeyFingerprint(key, hex32(entry.grant.oneTimePublicKey, "historical one-time key")), row.head_id);
    }
    if (state.phase === "hold") state.phaseBeforeHold = "needsRotation";
    else if (state.phase !== "retired") state.phase = "needsRotation";
    state.challenges = [];
    update.run(seal(key, row.head_id, Buffer.from(JSON.stringify(state))), row.head_id);
  }
  const deliveries = db.prepare("SELECT head_id, grant_id, sealed FROM hash_chain_deliveries").all() as
    { head_id: string; grant_id: string; sealed: Uint8Array }[];
  for (const row of deliveries) {
    const record = JSON.parse(unseal(key, `${row.head_id}:${row.grant_id}`, Buffer.from(row.sealed)).toString("utf8")) as HashChainGrantDeliveryRecord;
    insert.run(grantKeyFingerprint(key, hex32(record.oneTimePublicKey, "delivered one-time key")), row.head_id);
  }
  db.exec("PRAGMA user_version = 1");
}

/** Old undelivered challenges have no durable quote; preserve delivered exact-payment recovery. */
function migrateQuotedGrants(db: DatabaseSync, key: Buffer): void {
  const heads = db.prepare("SELECT head_id, sealed FROM hash_chain_grants").all() as { head_id: string; sealed: Uint8Array }[];
  const update = db.prepare("UPDATE hash_chain_grants SET sealed = ? WHERE head_id = ?");
  for (const row of heads) {
    const state = JSON.parse(unseal(key, row.head_id, Buffer.from(row.sealed)).toString("utf8")) as StoredHead;
    if (state.phase === "ready") {
      state.challenges = [];
      update.run(seal(key, row.head_id, Buffer.from(JSON.stringify(state))), row.head_id);
    }
  }
  db.exec("PRAGMA user_version = 2");
}

function grantKeyFingerprint(key: Buffer, publicKey: string): string {
  return createHmac("sha256", key).update(Buffer.from(publicKey, "hex")).digest("hex");
}

function seal(key: Buffer, headId: string, plaintext: Buffer): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(headId));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), encrypted]);
}
function unseal(key: Buffer, headId: string, sealed: Buffer): Buffer {
  if (sealed.length < 29 || sealed[0] !== 1) throw new Error("invalid encrypted grant record");
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(1, 13));
  decipher.setAAD(Buffer.from(headId));
  decipher.setAuthTag(sealed.subarray(13, 29));
  return Buffer.concat([decipher.update(sealed.subarray(29)), decipher.final()]);
}
