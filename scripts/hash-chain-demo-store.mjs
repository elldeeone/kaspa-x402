import { closeSync, openSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { MemoryServerChannelStore } from '@kaspa-x402/server';

const MUTATIONS = new Set([
  'claimExactSettlement', 'recordExactSettlementBroadcast', 'acceptExactSettlement',
  'beginExactHandler', 'recordExactHandlerResult', 'markExactHandlerRecoveryRequired',
  'abandonExactSettlement', 'commitExactPayment',
]);

/** Single-process demo adapter: journal exact-payment transitions using the
 * existing store's validation, reservations, handler guards, and replay rules. */
export async function openHashChainDemoStore(databasePath) {
  try { closeSync(openSync(databasePath, 'wx', 0o600)); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (process.platform !== 'win32' && (statSync(databasePath).mode & 0o077)) {
    throw new Error('Demo payment database must have private file permissions');
  }
  const db = new DatabaseSync(databasePath);
  let replayTime;
  const memory = new MemoryServerChannelStore([], { now: () => replayTime ?? Date.now() });
  try {
    // The exclusive connection enforces the demo's one-process policy. FULL
    // commits finish before a transition can authorize protected work.
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    db.exec('CREATE TABLE IF NOT EXISTS exact_payment_journal (id INTEGER PRIMARY KEY, observed_at INTEGER NOT NULL, operation TEXT NOT NULL, args TEXT NOT NULL)');
    for (const row of db.prepare('SELECT observed_at, operation, args FROM exact_payment_journal ORDER BY id').iterate()) {
      if (!MUTATIONS.has(row.operation)) throw new Error('Unknown demo payment journal operation');
      replayTime = Number(row.observed_at);
      await memory[row.operation](...JSON.parse(row.args));
    }
    replayTime = undefined;
  } catch (error) { db.close(); throw error; }
  const insert = db.prepare('INSERT INTO exact_payment_journal(observed_at, operation, args) VALUES (?, ?, ?)');
  let tail = Promise.resolve();
  let failed;
  let closed = false;
  const store = new Proxy(memory, {
    get(target, name) {
      const method = Reflect.get(target, name);
      if (typeof method !== 'function') return method;
      return (...input) => {
        const args = structuredClone(input);
        const operation = tail.then(async () => {
          if (closed || failed) throw new Error('Demo payment store is unavailable', { cause: failed });
          const result = await method.apply(target, args);
          const changed = !(name === 'claimExactSettlement' && !result.created) &&
            !(name === 'beginExactHandler' && !result);
          if (MUTATIONS.has(name) && changed) {
            try { insert.run(Date.now(), name, JSON.stringify(args)); }
            catch (error) {
              // Memory cannot safely authorize further work after a failed
              // durable write. Restart reconstructs the last committed state.
              failed = error;
              throw error;
            }
          }
          return result;
        });
        tail = operation.catch(() => undefined);
        return operation;
      };
    },
  });
  return { store, async close() { closed = true; await tail; db.close(); } };
}
