import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
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
export interface HashChainCurrentUtxoObservation {
  outpoint: { txid: string; index: number };
  amount: string;
  scriptPublicKey: string;
  covenantId: string | null;
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
  /** Absent only on deliveries committed before durable admission qualification. */
  claimantId?: string;
  qualifyingFundingOutpoint?: { txid: string; index: number };
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

interface StoredGrant extends Omit<HashChainBorrowGrant, "oneTimePrivateKey"> {
  grantId: string;
  /** Removed only from retired/quarantined recovery metadata. */
  oneTimePrivateKey?: string;
}
interface StoredChallenge extends HashChainGrantChallenge {
  /** Internal host-authenticated admission bucket; never expose over the wire. */
  admissionKey?: string;
}
interface StoredAssignment {
  grantId: string;
  challengeId: string;
  requestHash: string;
  quotedAmount: string;
  payerPublicKey: string;
  /** Existing schema-v2 assignments predate these admission fields. */
  claimantId?: string;
  qualifyingFundingOutpoint?: { txid: string; index: number };
  expiresAt: string;
  deliveryCommittedAt: string;
  /** First locally authenticated payment artifact; alternate artifacts fail closed. */
  candidateTransactionId?: string;
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

export type HashChainSqlValue = string | number | Uint8Array | null;

/** Small synchronous SQL boundary shared by Node SQLite and Durable Objects. */
export interface HashChainSqlDatabase {
  exec(query: string): void;
  prepare(query: string): {
    get(...values: HashChainSqlValue[]): unknown;
    all(): unknown[];
    run(...values: HashChainSqlValue[]): unknown;
  };
  getSchemaVersion(): number;
  setSchemaVersion(version: number): void;
  close(): void;
  /** Optional physical envelope and maintenance, implemented by the Node adapter. */
  configureStorageCapacity?(maxBytes: number): void;
  compact?(): void;
}

export interface HashChainGrantStorageLimits {
  maxRecords: number;
  /** Sealed payloads, identifiers and a conservative per-record/index charge. */
  maxBytes: number;
}
export interface HashChainGrantStorageUsage extends HashChainGrantStorageLimits {
  records: number;
  bytes: number;
  reservedRecords: number;
  reservedBytes: number;
  admissionAvailable: boolean;
}
export class HashChainStorageCapacityError extends Error {
  readonly code = "HASH_CHAIN_STORAGE_CAPACITY";
  constructor(readonly scope: "records" | "bytes" | "physical") {
    super(`hash-chain persistent ${scope} capacity exhausted`);
    this.name = "HashChainStorageCapacityError";
  }
}
const DEFAULT_STORAGE_LIMITS: HashChainGrantStorageLimits = {
  maxRecords: 100_000, maxBytes: 64 * 1024 * 1024,
};
// One payment row, a maximum 1024-key recovery rotation and bounded lineage
// growth per retained head. Keys placed on a selected head must stay reserved
// even when its replacement chain cannot be admitted for disclosure.
// Retired identities retain their envelope because selected-chain reorgs can
// restore them; expiry/retirement must not make their recovery space reusable.
// Allocation never consumes this envelope; settlement/owner recovery may do so.
const RECOVERY_BYTES_PER_HEAD = 512 * 1024;
const RECOVERY_RECORDS_PER_HEAD = 1025;

export interface HashChainGrantStorageOptions {
  allowMainnet?: boolean;
  database: HashChainSqlDatabase;
  transactionSync: <T>(callback: () => T) => T;
  /** Caller-managed 32-byte encryption key; loss loses outstanding grants. */
  encryptionKey: Uint8Array;
  /** Persisted store-wide policy. Omit on reopen to use the existing policy. */
  storageLimits?: HashChainGrantStorageLimits;
  admissionPolicy: {
    /** Durable deployment-wide limit for one authenticated admission identity. */
    maxGrantsPerClaimant: number;
    windowSeconds: number;
    /** Optional cheap host eligibility check before selected-chain I/O. */
    preflight?: (claim: HashChainGrantClaim, grant: HashChainPublicGrant) => boolean;
    /** Host must observe a current, sufficiently funded payer-controlled outpoint. claimantId is the signed payer public key. */
    resolveFundingOutpoint: (
      claim: HashChainGrantClaim,
      grant: HashChainPublicGrant,
      claimantId: string,
      signal?: AbortSignal,
    ) => Promise<{ txid: string; index: number } | readonly { txid: string; index: number }[]>;
  };
  maxLiveChallengesPerAdmissionKey?: number;
  now?: () => Date;
}

export class HashChainChallengeCapacityError extends Error {
  readonly code = "HASH_CHAIN_CHALLENGE_CAPACITY";

  constructor(readonly scope: "admission" | "head") {
    super(scope === "admission"
      ? "too many live challenges for admission key"
      : "too many live challenges for head");
    this.name = "HashChainChallengeCapacityError";
  }
}

/** Private capability issuer; storage commits every mutation before key delivery. */
export class HashChainGrantIssuer {
  readonly #allowMainnet: boolean;
  protected constructor(
    private readonly db: HashChainSqlDatabase,
    private readonly key: Buffer,
    private readonly admissionPolicy: HashChainGrantStorageOptions["admissionPolicy"],
    private readonly maxLiveChallengesPerAdmissionKey: number,
    private readonly now: () => Date,
    private readonly transactionSync: HashChainGrantStorageOptions["transactionSync"],
    allowMainnet = false,
  ) { this.#allowMainnet = allowMainnet; }

  static fromStorage(options: HashChainGrantStorageOptions): HashChainGrantIssuer {
    if (options.encryptionKey.length !== 32) throw new Error("grant encryption key must be 32 bytes");
    if (!options.admissionPolicy ||
      !Number.isSafeInteger(options.admissionPolicy.maxGrantsPerClaimant) ||
      options.admissionPolicy.maxGrantsPerClaimant < 1 ||
      !Number.isSafeInteger(options.admissionPolicy.windowSeconds) ||
      options.admissionPolicy.windowSeconds < 1 ||
      typeof options.admissionPolicy.resolveFundingOutpoint !== "function") {
      throw new Error("durable grant-admission policy is required");
    }
    const maxLiveChallengesPerAdmissionKey = options.maxLiveChallengesPerAdmissionKey ?? 4;
    if (!Number.isSafeInteger(maxLiveChallengesPerAdmissionKey) ||
      maxLiveChallengesPerAdmissionKey < 1 || maxLiveChallengesPerAdmissionKey > 8) {
      throw new Error("live challenges per admission key must be 1 to 8");
    }
    const db = options.database;
    const key = Buffer.from(options.encryptionKey);
    if (options.storageLimits) validateStorageLimits(options.storageLimits);
    try {
      const issuer = new this(db, key, options.admissionPolicy, maxLiveChallengesPerAdmissionKey,
        options.now ?? (() => new Date()), options.transactionSync, options.allowMainnet === true);
      options.transactionSync(() => {
        const capacityTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hash_chain_capacity'").get();
        const policy = capacityTable
          ? db.prepare("SELECT sealed FROM hash_chain_capacity WHERE id = 1").get()
          : undefined;
        const limits = policy ? issuer.readStorageLimits() : options.storageLimits ?? DEFAULT_STORAGE_LIMITS;
        if (options.storageLimits && stableStringify(limits) !== stableStringify(options.storageLimits)) {
          throw new Error("grant storage limits differ from the persisted policy; use increaseStorageLimits");
        }
        // Migration backfills can grow the file before their final quota check.
        // Install the physical envelope before any schema or data writes.
        db.configureStorageCapacity?.(limits.maxBytes);
        db.exec("CREATE TABLE IF NOT EXISTS hash_chain_grants (head_id TEXT PRIMARY KEY, sealed BLOB NOT NULL)");
        db.exec("CREATE TABLE IF NOT EXISTS hash_chain_deliveries (head_id TEXT NOT NULL, grant_id TEXT NOT NULL, sealed BLOB NOT NULL, PRIMARY KEY(head_id, grant_id))");
        db.exec("CREATE TABLE IF NOT EXISTS hash_chain_payments (transaction_id TEXT PRIMARY KEY, grant_id TEXT NOT NULL UNIQUE, sealed BLOB NOT NULL)");
        db.exec("CREATE TABLE IF NOT EXISTS hash_chain_seen_keys (key_fingerprint TEXT PRIMARY KEY, head_id TEXT NOT NULL)");
        db.exec("CREATE TABLE IF NOT EXISTS hash_chain_admissions (outpoint_fingerprint TEXT PRIMARY KEY, claimant_fingerprint TEXT NOT NULL, admission_fingerprint TEXT NOT NULL, disclosed_at INTEGER NOT NULL)");
        db.exec("CREATE INDEX IF NOT EXISTS hash_chain_admissions_claimant ON hash_chain_admissions(claimant_fingerprint, disclosed_at)");
        db.exec("CREATE INDEX IF NOT EXISTS hash_chain_admissions_host ON hash_chain_admissions(admission_fingerprint, disclosed_at)");
        db.exec("CREATE TABLE IF NOT EXISTS hash_chain_legacy_claimants (claimant_fingerprint TEXT PRIMARY KEY)");
        db.exec("CREATE TABLE IF NOT EXISTS hash_chain_meta (id INTEGER PRIMARY KEY CHECK(id = 1), sealed BLOB NOT NULL)");
        db.exec("CREATE TABLE IF NOT EXISTS hash_chain_capacity (id INTEGER PRIMARY KEY CHECK(id = 1), sealed BLOB NOT NULL)");
        const schemaVersion = db.getSchemaVersion();
        if (![0, 1, 2].includes(schemaVersion)) throw new Error("unsupported grant database schema version");
        const row = db.prepare("SELECT sealed FROM hash_chain_meta WHERE id = 1").get() as { sealed: Uint8Array } | undefined;
        if (row) {
          let verifier = "";
          try { verifier = unseal(key, "hash-chain-store-v1", Buffer.from(row.sealed)).toString("utf8"); }
          catch { throw new Error("grant database encryption key is wrong"); }
          if (verifier !== "hash-chain-store-v1") throw new Error("grant database encryption key is wrong");
        } else {
          const heads = db.prepare("SELECT COUNT(*) AS count FROM hash_chain_grants").get() as { count: number };
          const deliveries = db.prepare("SELECT COUNT(*) AS count FROM hash_chain_deliveries").get() as { count: number };
          if (heads.count !== 0 || deliveries.count !== 0) throw new Error("grant database encryption metadata is missing");
          db.prepare("INSERT INTO hash_chain_meta(id, sealed) VALUES(1, ?)")
            .run(seal(key, "hash-chain-store-v1", Buffer.from("hash-chain-store-v1")));
        }
        if (schemaVersion === 0) migrateLegacyGrantKeys(db, key);
        if (schemaVersion !== 2) migrateQuotedGrants(db, key);
        migrateLegacyGrantAdmissions(db, key);
        if (!policy) issuer.writeStorageLimits(limits);
        // Existing stores may be full for admission, but must remain recoverable.
        assertStorageCapacity(issuer.storageUsage(), !policy);
      });
      return issuer;
    } catch (error) {
      key.fill(0);
      throw error;
    }
  }

  close(): void { this.db.close(); this.key.fill(0); }

  /** Atomic public view, with no private grant or payer identifiers. */
  getStorageUsage(): HashChainGrantStorageUsage {
    return this.transactionSync(() => this.storageUsage());
  }

  /** Administrative operation: provision disk first; never reset security records. */
  increaseStorageLimits(limits: HashChainGrantStorageLimits): HashChainGrantStorageUsage {
    validateStorageLimits(limits);
    return this.transactionSync(() => {
      const current = this.readStorageLimits();
      if (limits.maxBytes < current.maxBytes || limits.maxRecords < current.maxRecords)
        throw new Error("grant storage limits may only increase");
      this.db.configureStorageCapacity?.(limits.maxBytes);
      this.writeStorageLimits(limits);
      const usage = this.storageUsage();
      assertStorageCapacity(usage, false);
      return usage;
    });
  }

  /** Drop retired secret chains atomically, retaining lineage and all safety records. */
  compactStorage(): HashChainGrantStorageUsage {
    this.transactionSync(() => {
      const rows = this.db.prepare("SELECT head_id, sealed FROM hash_chain_grants").all() as { head_id: string; sealed: Uint8Array }[];
      for (const row of rows) {
        const state = JSON.parse(unseal(this.key, row.head_id, Buffer.from(row.sealed)).toString("utf8")) as StoredHead;
        if (state.phase !== "retired") continue;
        const current = state.grants[state.nextIndex];
        state.grants = current ? [publicRecoveryGrant(current)] : [];
        state.nextIndex = 0;
        state.history = state.history.map(({ head, grant, exposed }) => ({ head, exposed,
          ...(grant ? { grant: publicRecoveryGrant(grant) } : {}) }));
        this.db.prepare("UPDATE hash_chain_grants SET sealed = ? WHERE head_id = ?")
          .run(seal(this.key, row.head_id, Buffer.from(JSON.stringify(state))), row.head_id);
      }
      assertStorageCapacity(this.storageUsage(), false);
    });
    // Physical maintenance is idempotent and runs only after the durable commit.
    this.db.compact?.();
    return this.getStorageUsage();
  }

  installHead(input: {
    headId: string; network: string; ownerPublicKey: string;
    head: HashChainObservedHead; grants: readonly HashChainBorrowGrant[];
  }, maxActiveHeads?: number): HashChainPublicGrant {
    if (maxActiveHeads !== undefined &&
      (!Number.isSafeInteger(maxActiveHeads) || maxActiveHeads < 1 || maxActiveHeads > 1024))
      throw new Error("ready-head pool limit is invalid");
    const headId = hex32(input.headId, "headId");
    const ownerPublicKey = hex32(input.ownerPublicKey, "ownerPublicKey");
    assertSupportedGrantNetwork(input.network, this.#allowMainnet);
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
      if (maxActiveHeads !== undefined) {
        const rows = this.db.prepare("SELECT head_id, sealed FROM hash_chain_grants").all() as
          { head_id: string; sealed: Uint8Array }[];
        const occupied = rows.filter((row) => {
          const existing = JSON.parse(unseal(this.key, row.head_id,
            Buffer.from(row.sealed)).toString("utf8")) as StoredHead;
          return existing.phase !== "retired";
        }).length;
        if (occupied >= maxActiveHeads) throw new Error("hash-chain ready-head pool is full");
      }
      if (this.rememberGrantKeys(headId, grants)) throw new Error("one-time key has already been used");
      return [stored, publicGrant(stored)];
    });
  }

  getCurrent(headId: string): HashChainPublicGrant {
    const id = hex32(headId, "headId");
    const current = this.read(id);
    if (current.phase !== "assigned" || !current.assignment ||
      Date.parse(current.assignment.expiresAt) >= this.now().getTime()) {
      return publicGrant(current);
    }
    return this.mutate(id, (state) => {
      if (!state) throw new Error("grant head is missing");
      if (state.phase === "assigned" && state.assignment &&
        Date.parse(state.assignment.expiresAt) < this.now().getTime()) {
        state.phase = "needsRotation";
        state.challenges = [];
      }
      return [state, publicGrant(state)];
    }, "recover");
  }

  /** Public capacity view; private grants and admission records stay sealed. */
  listHeads(): HashChainPublicGrant[] {
    const rows = this.db.prepare("SELECT head_id FROM hash_chain_grants ORDER BY head_id").all() as { head_id: string }[];
    return rows.map((row) => this.getCurrent(row.head_id));
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
    const challenge = state.challenges.find((item) => item.challengeId === hex32(challengeId, "challengeId"));
    return challenge ? publicChallenge(challenge) : undefined;
  }

  /**
   * Resolves the host-authenticated bucket stored with a public challenge
   * before signature, eligibility, or chain-observer work is attempted.
   */
  grantClaimAdmissionKey(headId: string, claim: HashChainGrantClaim): string {
    const id = hex32(headId, "headId");
    let normalized: HashChainGrantClaim;
    try {
      normalized = normalizeClaim(claim);
    } catch {
      return invalidClaimAdmissionKey(id);
    }
    const state = this.read(id);
    const challenge = state.challenges.find((item) =>
      item.grantId === normalized.grantId &&
      item.challengeId === normalized.challengeId &&
      item.requestHash === normalized.requestHash);
    return challenge
      ? challengeAdmissionKey(id, challenge)
      : invalidClaimAdmissionKey(id);
  }

  /** Loads one still-live idempotent challenge without allocating new state. */
  getAdmittedChallenge(
    headId: string,
    requestHash: string,
    quotedAmount: string,
    admissionKey: string,
  ): HashChainGrantChallenge | undefined {
    const state = this.read(hex32(headId, "headId"));
    if (state.phase !== "ready") return undefined;
    const request = hex32(requestHash, "requestHash");
    const amount = canonicalAmount(quotedAmount);
    const admission = hex32(admissionKey, "challenge admission key");
    const now = this.now().getTime();
    const grant = state.grants[state.nextIndex];
    const challenge = state.challenges.find((item) =>
      Date.parse(item.expiresAt) >= now &&
      item.admissionKey === admission &&
      item.requestHash === request &&
      item.quotedAmount === amount &&
      item.headVersion === state.version &&
      item.grantId === grant?.grantId);
    return challenge ? publicChallenge(challenge) : undefined;
  }

  getAcceptedPayment(transactionId: string): HashChainAcceptedPayment | undefined {
    const txid = hex32(transactionId, "transactionId");
    const row = this.db.prepare("SELECT sealed FROM hash_chain_payments WHERE transaction_id = ?")
      .get(txid) as { sealed: Uint8Array } | undefined;
    return row ? JSON.parse(unseal(this.key, `payment:${txid}`, Buffer.from(row.sealed)).toString("utf8")) as HashChainAcceptedPayment : undefined;
  }

  issueAdmittedChallenge(
    headId: string,
    requestHash: string,
    lifetimeSeconds: number,
    quotedAmount: string,
    admissionKey: string,
  ): HashChainGrantChallenge {
    const id = hex32(headId, "headId");
    const request = hex32(requestHash, "requestHash");
    const amount = canonicalAmount(quotedAmount);
    const admission = hex32(admissionKey, "challenge admission key");
    if (!Number.isSafeInteger(lifetimeSeconds) || lifetimeSeconds < 1 || lifetimeSeconds > 300) {
      throw new Error("challenge lifetime must be 1 to 300 seconds");
    }
    return this.mutate(id, (state) => {
      if (!state || state.phase !== "ready") throw new Error("current grant is unavailable");
      const now = this.now().getTime();
      state.challenges = state.challenges.filter((challenge) => Date.parse(challenge.expiresAt) >= now);
      const existing = state.challenges.find((challenge) =>
        challenge.admissionKey === admission &&
        challenge.requestHash === request &&
        challenge.quotedAmount === amount &&
        challenge.headVersion === state.version &&
        challenge.grantId === state.grants[state.nextIndex]!.grantId);
      if (existing) return [state, publicChallenge(existing)];
      const admittedCount = state.challenges.filter((challenge) =>
        challenge.admissionKey === admission).length;
      if (admittedCount >= this.maxLiveChallengesPerAdmissionKey) {
        throw new HashChainChallengeCapacityError("admission");
      }
      if (state.challenges.length >= 64) throw new HashChainChallengeCapacityError("head");
      const challenge: StoredChallenge = {
        headId: id, headVersion: state.version, grantId: state.grants[state.nextIndex]!.grantId,
        challengeId: randomBytes(32).toString("hex"), requestHash: request, quotedAmount: amount,
        issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + lifetimeSeconds * 1000).toISOString(),
        admissionKey: admission,
      };
      state.challenges.push(challenge);
      return [state, publicChallenge(challenge)];
    });
  }

  #authorizeGrantClaim(
    headId: string,
    claim: HashChainGrantClaim,
  ): {
    admissionKey: string;
    payerPublicKey: string;
    current: HashChainPublicGrant;
    needsQualification: boolean;
    commit(fundingOutpoint?: { txid: string; index: number } | readonly { txid: string; index: number }[]): HashChainGrantDelivery;
  } {
    const id = hex32(headId, "headId");
    const normalized = normalizeClaim(claim);
    const state = this.read(id);
    const { challenge } = inspectGrantClaim(state, normalized, this.now().getTime());
    const current = publicGrant(state);
    if (!state.assignment && this.admissionPolicy.preflight?.(normalized, current) === false) {
      throw new Error("payer is ineligible for grant");
    }
    const snapshot = {
      headVersion: state.version,
      head: structuredClone(state.head),
    };
    const admissionKey = challengeAdmissionKey(
      id,
      challenge,
    );
    return {
      admissionKey,
      payerPublicKey: normalized.payerPublicKey,
      current: structuredClone(current),
      needsQualification: !state.assignment,
      commit: (fundingOutpoint) => this.#commitAuthorizedGrantClaim(id, normalized, snapshot, admissionKey, fundingOutpoint),
    };
  }

  /**
   * Atomically pins the first locally authenticated payment artifact for a
   * delivered grant. Matching retries are idempotent; alternate artifacts are rejected.
   */
  pinPaymentCandidate(input: {
    headId: string;
    headVersion: string;
    grantId: string;
    challengeId: string;
    requestHash: string;
    payerPublicKey: string;
    transactionId: string;
  }): void {
    const normalized = {
      headId: hex32(input.headId, "headId"),
      headVersion: canonicalVersion(input.headVersion),
      grantId: hex32(input.grantId, "grantId"),
      challengeId: hex32(input.challengeId, "challengeId"),
      requestHash: hex32(input.requestHash, "requestHash"),
      payerPublicKey: hex32(input.payerPublicKey, "payerPublicKey"),
      transactionId: hex32(input.transactionId, "transactionId"),
    };
    this.mutate(normalized.headId, (state) => {
      if (!state) throw new Error("grant head is missing");
      const accepted = this.getAcceptedPayment(normalized.transactionId);
      if (accepted) {
        const delivery = this.getDeliveryRecord(
          normalized.headId,
          normalized.grantId,
        );
        if (
          accepted.grantId !== normalized.grantId ||
          accepted.challengeId !== normalized.challengeId ||
          accepted.requestHash !== normalized.requestHash ||
          accepted.payerPublicKey !== normalized.payerPublicKey ||
          delivery?.headVersion.toString() !== normalized.headVersion ||
          delivery.challengeId !== normalized.challengeId ||
          delivery.requestHash !== normalized.requestHash ||
          delivery.payerPublicKey !== normalized.payerPublicKey
        ) {
          throw new Error(
            "accepted payment candidate does not match the durable grant delivery",
          );
        }
        return [state, undefined];
      }
      const assigned = state?.assignment;
      if (
        state.version.toString() !== normalized.headVersion ||
        (state.phase !== "assigned" &&
          !(state.phase === "hold" && state.phaseBeforeHold === "assigned")) ||
        !assigned ||
        assigned.grantId !== normalized.grantId ||
        assigned.challengeId !== normalized.challengeId ||
        assigned.requestHash !== normalized.requestHash ||
        assigned.payerPublicKey !== normalized.payerPublicKey
      ) {
        throw new Error("payment candidate does not match the assigned grant");
      }
      if (
        assigned.candidateTransactionId &&
        assigned.candidateTransactionId !== normalized.transactionId
      ) {
        throw new Error("assigned grant already owns another payment candidate");
      }
      assigned.candidateTransactionId = normalized.transactionId;
      return [state, undefined];
    }, "recover");
  }

  /**
   * Delivers a grant only after a caller-supplied authoritative exact-outpoint
   * observation matches the authorized snapshot. There is intentionally no
   * unchecked issuer-level claim helper.
   */
  async claimGrantAfterCurrentHeadObservation(
    headId: string,
    claim: HashChainGrantClaim,
    options: {
      expectedAdmissionKey?: string;
      observe: (
        current: HashChainPublicGrant,
        signal?: AbortSignal,
      ) => Promise<HashChainCurrentUtxoObservation | null>;
      signal?: AbortSignal;
    },
  ): Promise<HashChainGrantDelivery> {
    const id = hex32(headId, "headId");
    if (typeof options.observe !== "function") {
      throw new Error("authoritative current-head observer is required");
    }
    options.signal?.throwIfAborted();
    const authorized = this.#authorizeGrantClaim(id, claim);
    if (
      options.expectedAdmissionKey !== undefined &&
      hex32(options.expectedAdmissionKey, "expected admission key") !==
        authorized.admissionKey
    ) {
      throw new Error("grant claim admission changed during authorization");
    }
    const observed = await options.observe(
      structuredClone(authorized.current),
      options.signal,
    );
    options.signal?.throwIfAborted();
    const latest = this.getCurrent(id);
    if (
      latest.headVersion !== authorized.current.headVersion ||
      !sameHead(latest.head, authorized.current.head)
    ) {
      throw new Error("grant head changed during authoritative observation");
    }
    if (!currentUtxoMatches(observed, authorized.current.head)) {
      this.holdForReorg(id);
      throw new Error(
        "current hash-chain head does not match the authoritative selected UTXO",
      );
    }
    const fundingOutpoint = authorized.needsQualification
      ? await this.admissionPolicy.resolveFundingOutpoint(
          claim, authorized.current, authorized.payerPublicKey, options.signal)
      : undefined;
    options.signal?.throwIfAborted();
    return authorized.commit(fundingOutpoint);
  }

  #commitAuthorizedGrantClaim(
    id: string,
    normalized: HashChainGrantClaim,
    snapshot: { headVersion: number; head: HashChainObservedHead },
    admissionKey: string,
    fundingOutpoint?: { txid: string; index: number } | readonly { txid: string; index: number }[],
  ): HashChainGrantDelivery {
    return this.mutate(id, (state) => {
      if (!state || state.version !== snapshot.headVersion || !sameHead(state.head, snapshot.head)) {
        throw new Error("grant head changed after claim authorization");
      }
      const { grant, challenge } = inspectGrantClaim(
        state,
        normalized,
        this.now().getTime(),
      );
      if (!state.assignment) {
        const candidates = fundingOutpoint === undefined ? [] : Array.isArray(fundingOutpoint)
          ? fundingOutpoint : [fundingOutpoint];
        if (candidates.length === 0) throw new Error("qualifying funding outpoint is required");
        const claimantId = normalized.payerPublicKey;
        const claimantFingerprint = createHmac("sha256", this.key).update(`claimant:${claimantId}`).digest("hex");
        const admissionFingerprint = createHmac("sha256", this.key).update(`admission:${admissionKey}`).digest("hex");
        if (this.db.prepare("SELECT 1 AS present FROM hash_chain_legacy_claimants WHERE claimant_fingerprint = ?")
          .get(claimantFingerprint)) throw new Error("legacy claimant requires a fresh payer key");
        const now = this.now().getTime();
        const windowStart = now - this.admissionPolicy.windowSeconds * 1000;
        const usedByClaimant = this.db.prepare("SELECT COUNT(*) AS count FROM hash_chain_admissions WHERE claimant_fingerprint = ? AND disclosed_at >= ?")
          .get(claimantFingerprint, windowStart) as { count: number };
        const usedByAdmission = this.db.prepare("SELECT COUNT(*) AS count FROM hash_chain_admissions WHERE admission_fingerprint = ? AND disclosed_at >= ?")
          .get(admissionFingerprint, windowStart) as { count: number };
        if (usedByClaimant.count >= this.admissionPolicy.maxGrantsPerClaimant ||
          usedByAdmission.count >= this.admissionPolicy.maxGrantsPerClaimant)
          throw new Error("claimant grant quota exceeded");
        const findOutpoint = this.db.prepare("SELECT 1 AS present FROM hash_chain_admissions WHERE outpoint_fingerprint = ?");
        let selected: { txid: string; index: number; fingerprint: string } | undefined;
        for (const candidate of candidates) {
          if (!Number.isSafeInteger(candidate.index) || candidate.index < 0)
            throw new Error("qualifying funding outpoint is required");
          const txid = hex32(candidate.txid, "funding transaction");
          const fingerprint = createHmac("sha256", this.key)
            .update(`outpoint:${txid}:${candidate.index}`).digest("hex");
          if (!findOutpoint.get(fingerprint)) {
            selected = { txid, index: candidate.index, fingerprint };
            break;
          }
        }
        if (!selected) throw new Error("funding outpoint already qualified a disclosed grant");
        this.db.prepare("INSERT INTO hash_chain_admissions(outpoint_fingerprint, claimant_fingerprint, admission_fingerprint, disclosed_at) VALUES(?, ?, ?, ?)")
          .run(selected.fingerprint, claimantFingerprint, admissionFingerprint, now);
        state.assignment = {
          grantId: normalized.grantId, challengeId: normalized.challengeId,
          requestHash: normalized.requestHash, quotedAmount: challenge.quotedAmount,
          payerPublicKey: normalized.payerPublicKey, claimantId,
          qualifyingFundingOutpoint: { txid: selected.txid, index: selected.index },
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
          payerPublicKey: normalized.payerPublicKey, claimantId,
          qualifyingFundingOutpoint: state.assignment.qualifyingFundingOutpoint,
          expiresAt: normalized.expiresAt,
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
    }, "claim");
  }

  markAbandoned(headId: string): HashChainPublicGrant {
    const id = hex32(headId, "headId");
    return this.mutate(id, (state) => {
      if (state?.phase === "needsRotation") return [state, publicGrant(state)];
      if (!state || state.phase !== "assigned" || !state.assignment) throw new Error("no assigned grant to abandon");
      if (Date.parse(state.assignment.expiresAt) >= this.now().getTime()) throw new Error("assigned grant has not expired");
      state.phase = "needsRotation";
      state.challenges = [];
      return [state, publicGrant(state)];
    }, "recover");
  }

  recordAcceptedBorrow(headId: string, transition: HashChainAcceptedTransition): HashChainPublicGrant {
    return this.advance(headId, transition, "borrow");
  }

  /** Recover a held, unmatched spend only after an authoritative selected-chain readback. */
  async recoverSelectedUnmatchedBorrow(
    headId: string,
    transactionId: string,
    chain: Pick<HashChainChainView, "getSelectedTransaction">,
    signal?: AbortSignal,
  ): Promise<HashChainPublicGrant> {
    const id = hex32(headId, "headId");
    const txid = hex32(transactionId, "transactionId");
    const current = this.getCurrent(id);
    if (current.phase !== "hold" || !current.nextGuard) throw new Error("head is not awaiting an assigned borrow readback");
    signal?.throwIfAborted();
    const selected = await chain.getSelectedTransaction(txid, { signal });
    signal?.throwIfAborted();
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
    try { return this.advance(headId, transition, "rotate", grants); }
    catch (error) {
      if (!(error instanceof HashChainStorageCapacityError)) throw error;
      // The selected owner spend is already a fact. Roll back fresh key
      // allocation, then retain its successor in quarantine using recovery space.
      return this.advance(headId, transition, "rotate", grants, undefined, true);
    }
  }

  /** Host-authenticated recovery after an owner-signed rotation is selected. */
  async recoverOwnerRotationAfterSelectedObservation(
    headId: string,
    transactionId: string,
    grants: readonly HashChainBorrowGrant[],
    chain: Pick<HashChainChainView, "getSelectedTransaction">,
    signal?: AbortSignal,
  ): Promise<HashChainPublicGrant> {
    const id = hex32(headId, "headId");
    const txid = hex32(transactionId, "rotation transaction ID");
    const current = this.getCurrent(id);
    if (current.phase !== "needsRotation") throw new Error("head is not awaiting owner rotation");
    if (!Array.isArray(grants) || grants.length < 1 || grants.length > 1024)
      throw new Error("replacement grant chain length is invalid");
    const first = normalizeGrant(grants[0]!);
    const newGuard = hashChainBorrowGuard(first.revealedGuard, first.oneTimePublicKey);
    signal?.throwIfAborted();
    const selected = await chain.getSelectedTransaction(txid, { signal });
    signal?.throwIfAborted();
    if (!selected || selected.transactionId !== txid ||
      (selected.finality !== "accepted" && selected.finality !== "confirmed") ||
      !sameOutpoint(selected.spentHead, current.head.outpoint) ||
      selected.successor.authorizingInput !== 0 ||
      selected.successor.covenantId !== current.head.covenantId ||
      selected.successor.scriptPublicKey !== hashChainHeadScriptPublicKey({
        ownerPublicKey: current.ownerPublicKey, guard: newGuard,
      })) throw new Error("owner rotation is not accepted on the selected chain");
    const latest = this.getCurrent(id);
    if (latest.headVersion !== current.headVersion || latest.phase !== "needsRotation" ||
      !sameHead(latest.head, current.head)) throw new Error("head changed during owner rotation readback");
    return this.recordAcceptedRotation(id, {
      finality: selected.finality,
      predecessor: current.head.outpoint,
      successor: {
        outpoint: { txid, index: 0 }, amount: selected.successor.amount,
        guard: newGuard, scriptPublicKey: selected.successor.scriptPublicKey,
        covenantId: selected.successor.covenantId,
      },
    }, grants);
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
    }, "recover");
  }

  holdForReorg(headId: string): HashChainPublicGrant {
    const id = hex32(headId, "headId");
    return this.mutate(id, (state) => {
      if (!state) throw new Error("grant head is missing");
      if (state.phase !== "hold") state.phaseBeforeHold = state.phase;
      state.phase = "hold";
      return [state, publicGrant(state)];
    }, "recover");
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
    }, "recover");
  }

  private advance(
    headId: string, transition: HashChainAcceptedTransition, kind: "borrow" | "rotate",
    replacement?: readonly HashChainBorrowGrant[],
    payment?: HashChainAcceptedPayment,
    recoveryRotation = false,
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
      if (recoveryRotation) state.grants = state.grants.slice(0, 1).map(publicRecoveryGrant);
      state.phase = kind === "rotate" && (!replacementSafe || recoveryRotation)
        ? "needsRotation" : state.nextIndex >= state.grants.length ? "exhausted"
          : wasQuarantined && kind === "borrow" ? "needsRotation" : "ready";
      return [state, publicGrant(state)];
    }, kind === "borrow" || recoveryRotation ? "recover" : "allocate");
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
    assertSupportedGrantNetwork(state.network, this.#allowMainnet);
    if (state.assignment &&
      (state.assignment.claimantId === undefined) !==
      (state.assignment.qualifyingFundingOutpoint === undefined)) {
      throw new Error("grant state has incomplete admission qualification");
    }
    return state;
  }

  private readStorageLimits(): HashChainGrantStorageLimits {
    const row = this.db.prepare("SELECT sealed FROM hash_chain_capacity WHERE id = 1").get() as { sealed: Uint8Array };
    let plaintext: string;
    try { plaintext = unseal(this.key, "hash-chain-capacity-v1", Buffer.from(row.sealed)).toString("utf8"); }
    catch { throw new Error("grant database encryption key is wrong"); }
    const limits = JSON.parse(plaintext) as HashChainGrantStorageLimits;
    validateStorageLimits(limits);
    return limits;
  }

  private writeStorageLimits(limits: HashChainGrantStorageLimits): void {
    this.db.prepare("INSERT INTO hash_chain_capacity(id, sealed) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET sealed = excluded.sealed")
      .run(seal(this.key, "hash-chain-capacity-v1", Buffer.from(JSON.stringify(limits))));
  }

  private storageUsage(): HashChainGrantStorageUsage {
    const limits = this.readStorageLimits();
    let records = 0, bytes = 0, heads = 0;
    for (const [table, payload] of [
      ["hash_chain_grants", "length(head_id) + length(sealed)"],
      ["hash_chain_deliveries", "length(head_id) + length(grant_id) + length(sealed)"],
      ["hash_chain_payments", "length(transaction_id) + length(grant_id) + length(sealed)"],
      ["hash_chain_seen_keys", "length(key_fingerprint) + length(head_id)"],
      ["hash_chain_admissions", "length(outpoint_fingerprint) + length(claimant_fingerprint) + length(admission_fingerprint) + 8"],
      ["hash_chain_legacy_claimants", "length(claimant_fingerprint)"],
      ["hash_chain_meta", "length(sealed) + 8"],
      ["hash_chain_capacity", "length(sealed) + 8"],
    ]) {
      const row = this.db.prepare(`SELECT COUNT(*) AS records, COALESCE(SUM(${payload} + 128), 0) AS bytes FROM ${table}`).get() as { records: number; bytes: number };
      records += row.records; bytes += row.bytes;
      if (table === "hash_chain_grants") heads = row.records;
    }
    const reservedRecords = heads * RECOVERY_RECORDS_PER_HEAD, reservedBytes = heads * RECOVERY_BYTES_PER_HEAD;
    return { ...limits, records, bytes, reservedRecords, reservedBytes,
      admissionAvailable: records + reservedRecords < limits.maxRecords && bytes + reservedBytes < limits.maxBytes };
  }

  private mutate<T>(headId: string, change: (current: StoredHead | undefined) => [StoredHead, T],
    mode: "allocate" | "recover" | "claim" = "allocate"): T {
    return this.transactionSync(() => {
      // A second connection must see an administrator's provisioned increase.
      this.db.configureStorageCapacity?.(this.readStorageLimits().maxBytes);
      const row = this.db.prepare("SELECT sealed FROM hash_chain_grants WHERE head_id = ?").get(headId) as { sealed: Uint8Array } | undefined;
      const current = row ? JSON.parse(unseal(this.key, headId, Buffer.from(row.sealed)).toString("utf8")) as StoredHead : undefined;
      if (current) assertSupportedGrantNetwork(current.network, this.#allowMainnet);
      const wasAssigned = !!current?.assignment;
      const [next, result] = change(current);
      this.db.prepare("INSERT INTO hash_chain_grants(head_id, sealed) VALUES(?, ?) ON CONFLICT(head_id) DO UPDATE SET sealed = excluded.sealed")
        .run(headId, seal(this.key, headId, Buffer.from(JSON.stringify(next))));
      assertStorageCapacity(this.storageUsage(), mode === "allocate" || (mode === "claim" && !wasAssigned));
      return result;
    });
  }
}

function validateStorageLimits(limits: HashChainGrantStorageLimits): void {
  if (!Number.isSafeInteger(limits.maxRecords) || limits.maxRecords < 8 || limits.maxRecords > 1_000_000 ||
    !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 256 * 1024 || limits.maxBytes > 4 * 1024 * 1024 * 1024)
    throw new Error("grant storage limits require 8 to 1000000 records and 256 KiB to 4 GiB");
}

function assertStorageCapacity(usage: HashChainGrantStorageUsage, reserve: boolean): void {
  if (usage.records + (reserve ? usage.reservedRecords : 0) > usage.maxRecords)
    throw new HashChainStorageCapacityError("records");
  if (usage.bytes + (reserve ? usage.reservedBytes : 0) > usage.maxBytes)
    throw new HashChainStorageCapacityError("bytes");
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

function publicChallenge(challenge: StoredChallenge): HashChainGrantChallenge {
  return {
    headId: challenge.headId,
    headVersion: challenge.headVersion,
    grantId: challenge.grantId,
    challengeId: challenge.challengeId,
    requestHash: challenge.requestHash,
    quotedAmount: challenge.quotedAmount,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
  };
}

function publicRecoveryGrant(grant: StoredGrant): StoredGrant {
  return { grantId: grant.grantId, revealedGuard: grant.revealedGuard, oneTimePublicKey: grant.oneTimePublicKey };
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

function inspectGrantClaim(
  state: StoredHead,
  claim: HashChainGrantClaim,
  now: number,
): {
  grant: StoredGrant & { oneTimePrivateKey: string };
  challenge: StoredChallenge;
} {
  if (state.phase !== "ready" && state.phase !== "assigned") {
    throw new Error("current grant is unavailable");
  }
  const grant = state.grants[state.nextIndex];
  const challenge = state.challenges.find(
    (item) => item.challengeId === claim.challengeId,
  );
  if (
    !grant || !grant.oneTimePrivateKey ||
    !challenge ||
    challenge.headVersion !== state.version ||
    challenge.grantId !== grant.grantId ||
    challenge.requestHash !== claim.requestHash ||
    claim.grantId !== grant.grantId ||
    (!challenge.quotedAmount && !state.assignment) ||
    Date.parse(challenge.expiresAt) < now ||
    Date.parse(claim.expiresAt) < now ||
    Date.parse(claim.expiresAt) > Date.parse(challenge.expiresAt)
  ) {
    throw new Error("grant claim does not match a live challenge");
  }
  const digest = hashChainGrantClaimDigest(state.network, claim);
  if (
    !schnorr.verify(
      Buffer.from(claim.signature, "hex"),
      digest,
      Buffer.from(claim.payerPublicKey, "hex"),
    )
  ) {
    throw new Error("invalid grant payer signature");
  }
  const tupleMatches =
    state.assignment &&
    state.assignment.grantId === claim.grantId &&
    state.assignment.challengeId === claim.challengeId &&
    state.assignment.requestHash === claim.requestHash &&
    state.assignment.payerPublicKey === claim.payerPublicKey &&
    state.assignment.expiresAt === claim.expiresAt;
  if (state.assignment && !tupleMatches) {
    throw new Error("grant is assigned to another payer or request");
  }
  return { grant: { ...grant, oneTimePrivateKey: grant.oneTimePrivateKey }, challenge };
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

function canonicalVersion(value: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("head version must be a canonical safe-integer string");
  }
  return value;
}

function challengeAdmissionKey(
  headId: string,
  challenge: StoredChallenge,
): string {
  return challenge.admissionKey ?? createHash("sha256")
    .update(stableStringify({
      scope: "kaspa:x402:legacy-hash-chain-claim-caller:v2",
      headId,
      challengeId: challenge.challengeId,
    }))
    .digest("hex");
}

function invalidClaimAdmissionKey(headId: string): string {
  return createHash("sha256")
    .update(stableStringify({
      scope: "kaspa:x402:invalid-hash-chain-claim:v1",
      headId,
    }))
    .digest("hex");
}

function assertSupportedGrantNetwork(network: string, allowMainnet = false): void {
  if (network !== "kaspa:testnet-10" && !(allowMainnet && network === "kaspa:mainnet")) throw new Error("unsupported grant network; mainnet requires allowMainnet");
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
function currentUtxoMatches(
  observed: HashChainCurrentUtxoObservation | null,
  expected: HashChainObservedHead,
): boolean {
  return !!observed &&
    observed.outpoint.txid.toLowerCase() === expected.outpoint.txid &&
    observed.outpoint.index === expected.outpoint.index &&
    observed.amount === expected.amount &&
    observed.scriptPublicKey.toLowerCase() === expected.scriptPublicKey &&
    observed.covenantId?.toLowerCase() === expected.covenantId;
}

/** Earlier local stores lacked the durable key index; quarantine their live heads. */
function migrateLegacyGrantKeys(db: HashChainSqlDatabase, key: Buffer): void {
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
  db.setSchemaVersion(1);
}

/** Old undelivered challenges have no durable quote; preserve delivered exact-payment recovery. */
function migrateQuotedGrants(db: HashChainSqlDatabase, key: Buffer): void {
  const heads = db.prepare("SELECT head_id, sealed FROM hash_chain_grants").all() as { head_id: string; sealed: Uint8Array }[];
  const update = db.prepare("UPDATE hash_chain_grants SET sealed = ? WHERE head_id = ?");
  for (const row of heads) {
    const state = JSON.parse(unseal(key, row.head_id, Buffer.from(row.sealed)).toString("utf8")) as StoredHead;
    if (state.phase === "ready") {
      state.challenges = [];
      update.run(seal(key, row.head_id, Buffer.from(JSON.stringify(state))), row.head_id);
    }
  }
  db.setSchemaVersion(2);
}

/** Old assignments have no known qualifying outpoint: preserve recovery, but never reuse their payer key. */
function migrateLegacyGrantAdmissions(db: HashChainSqlDatabase, key: Buffer): void {
  const heads = db.prepare("SELECT head_id, sealed FROM hash_chain_grants").all() as { head_id: string; sealed: Uint8Array }[];
  const legacy = db.prepare("INSERT OR IGNORE INTO hash_chain_legacy_claimants(claimant_fingerprint) VALUES(?)");
  const reserve = db.prepare("INSERT OR IGNORE INTO hash_chain_admissions(outpoint_fingerprint, claimant_fingerprint, admission_fingerprint, disclosed_at) VALUES(?, ?, ?, ?)");
  const claimantFingerprint = (payerPublicKey: string) => createHmac("sha256", key)
    .update(`claimant:${hex32(payerPublicKey, "legacy payer public key")}`).digest("hex");
  for (const row of heads) {
    const state = JSON.parse(unseal(key, row.head_id, Buffer.from(row.sealed)).toString("utf8")) as StoredHead;
    const assignment = state.assignment;
    if (!assignment || assignment.claimantId !== undefined || assignment.qualifyingFundingOutpoint !== undefined)
      continue;
    const fingerprint = claimantFingerprint(assignment.payerPublicKey);
    legacy.run(fingerprint);
    const challenge = state.challenges.find((item) => item.challengeId === assignment.challengeId);
    if (!challenge) continue;
    const disclosedAt = Date.parse(assignment.deliveryCommittedAt);
    if (!Number.isFinite(disclosedAt)) throw new Error("legacy grant delivery time is invalid");
    const admissionFingerprint = createHmac("sha256", key)
      .update(`admission:${challengeAdmissionKey(row.head_id, challenge)}`).digest("hex");
    const outpointFingerprint = createHmac("sha256", key)
      .update(`legacy:${row.head_id}:${assignment.grantId}`).digest("hex");
    reserve.run(outpointFingerprint, fingerprint, admissionFingerprint, disclosedAt);
  }
  const deliveries = db.prepare("SELECT head_id, grant_id, sealed FROM hash_chain_deliveries").all() as
    { head_id: string; grant_id: string; sealed: Uint8Array }[];
  for (const row of deliveries) {
    const record = JSON.parse(unseal(key, `${row.head_id}:${row.grant_id}`, Buffer.from(row.sealed)).toString("utf8")) as HashChainGrantDeliveryRecord;
    if (record.claimantId === undefined || record.qualifyingFundingOutpoint === undefined)
      legacy.run(claimantFingerprint(record.payerPublicKey));
  }
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
