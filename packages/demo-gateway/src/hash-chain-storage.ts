import { randomBytes } from "node:crypto";
import {
  HashChainGrantIssuer,
  type HashChainSqlDatabase,
  type HashChainSqlValue,
} from "@kaspa-x402/server/hash-chain-issuer";

export type HashChainStorage = Pick<DurableObjectStorage, "sql" | "transactionSync">;

/** Grant tables share the existing gateway database; they never touch its KV ledger. */
export function openDurableHashChainIssuer(storage: HashChainStorage): HashChainGrantIssuer {
  const key = storage.transactionSync(() => {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS hash_chain_demo (
      id INTEGER PRIMARY KEY CHECK(id = 1), encryption_key BLOB NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 0, head_id TEXT, pay_to TEXT
    )`);
    const row = storage.sql.exec<{ encryption_key: ArrayBuffer }>(
      "SELECT encryption_key FROM hash_chain_demo WHERE id = 1",
    ).toArray()[0];
    if (row) return new Uint8Array(row.encryption_key);
    const generated = randomBytes(32);
    storage.sql.exec("INSERT INTO hash_chain_demo(id, encryption_key) VALUES(1, ?)",
      Uint8Array.from(generated).buffer);
    return generated;
  });
  const values = (input: HashChainSqlValue[]) => input.map((value) =>
    value instanceof Uint8Array ? Uint8Array.from(value).buffer : value);
  const rows = (query: string, input: HashChainSqlValue[] = []) =>
    storage.sql.exec(query, ...values(input)).toArray().map((row) =>
      Object.fromEntries(Object.entries(row).map(([name, value]) =>
        [name, value instanceof ArrayBuffer ? new Uint8Array(value) : value])));
  const database: HashChainSqlDatabase = {
    exec: (query) => { storage.sql.exec(query); },
    prepare: (query) => ({
      get: (...input) => rows(query, input)[0],
      all: () => rows(query),
      run: (...input) => { storage.sql.exec(query, ...values(input)); },
    }),
    getSchemaVersion: () => storage.sql.exec<{ schema_version: number }>(
      "SELECT schema_version FROM hash_chain_demo WHERE id = 1",
    ).one().schema_version,
    setSchemaVersion: (version) => {
      storage.sql.exec("UPDATE hash_chain_demo SET schema_version = ? WHERE id = 1", version);
    },
    close() {},
  };
  return HashChainGrantIssuer.fromStorage({ database, encryptionKey: key,
    transactionSync: (callback) => storage.transactionSync(callback), canClaim: () => true });
}
