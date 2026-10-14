import { closeSync, constants, existsSync, fsyncSync, lstatSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  HashChainGrantIssuer as StorageGrantIssuer,
  HashChainStorageCapacityError,
  type HashChainGrantStorageOptions,
  type HashChainSqlDatabase,
} from "./hash-chain-issuer.js";

export * from "./hash-chain-issuer.js";

export interface HashChainGrantIssuerOptions extends Omit<HashChainGrantStorageOptions, "database" | "transactionSync"> {
  databasePath: string;
}

/** Node adapter: private files, full synchronous commits and existing schema. */
export class HashChainGrantIssuer extends StorageGrantIssuer {
  static async open(options: HashChainGrantIssuerOptions): Promise<HashChainGrantIssuer> {
    if (options.encryptionKey.length !== 32) throw new Error("grant encryption key must be 32 bytes");
    if (!options.databasePath || options.databasePath === ":memory:") throw new Error("grant database must be a durable file");
    if (!options.admissionPolicy) throw new Error("durable grant-admission policy is required");
    const limit = options.maxLiveChallengesPerAdmissionKey ?? 4;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8) throw new Error("live challenges per admission key must be 1 to 8");
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
    try {
      checkPrivateFile(options.databasePath);
      db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;");
      const database: HashChainSqlDatabase = {
        exec: (query) => db.exec(query),
        prepare: (query) => db.prepare(query),
        getSchemaVersion: () => (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
        setSchemaVersion: (version) => db.exec(`PRAGMA user_version = ${version}`),
        close: () => db.close(),
        configureStorageCapacity: (maxBytes) => {
          const pageSize = (db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
          // Payload/index charge is logical; leave four times that envelope for
          // B-trees, page fragmentation and reserved recovery, plus schema pages.
          const pages = Math.floor((4 * maxBytes + 1024 * 1024) / pageSize);
          const configured = db.prepare(`PRAGMA max_page_count = ${pages}`).get() as { max_page_count: number };
          if (configured.max_page_count > pages) throw new HashChainStorageCapacityError("physical");
        },
        compact: () => db.exec("VACUUM"),
      };
      return this.fromStorage({ ...options, database, transactionSync: (callback) => {
        db.exec("BEGIN IMMEDIATE");
        try { const result = callback(); db.exec("COMMIT"); return result; }
        catch (error) {
          // SQLite can automatically roll back a transaction on SQLITE_FULL.
          if (db.isTransaction !== false) {
            try { db.exec("ROLLBACK"); }
            catch { db.close(); }
          }
          if (error instanceof Error && "errcode" in error && error.errcode === 13)
            throw new HashChainStorageCapacityError("physical");
          throw error;
        }
      } });
    } catch (error) { db.close(); throw error; }
  }
}

function checkPrivateFile(file: string): void {
  if (!existsSync(file)) return;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("grant database path must be a regular file");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("grant database file must be private (0600)");
}
