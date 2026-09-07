# Independent review, reorg and persistence validation — 7 September 2026

The preceding adversarial work was committed and pushed as `19c29058827072612f410e8248751306cef0c737`; remote HEAD matched and the working tree was clean before this validation began.

| Area | Result |
| --- | --- |
| Independent exact review | PASS within source/local-test scope; no high/medium issue established |
| Independent batch review | One medium client-state rollback found, fixed and independently rechecked |
| Controlled canonical consensus reorg | PASS: accepted spend replaced, UTXOs reversed, selected-chain removal/addition observed |
| Containing-block DAA finality | PASS: equality rejected, lock time plus one accepted |
| Existing reference persistence helpers | Process-loss and contention checks completed; unsafe multi-writer snapshot overwrite reproduced |
| Production client persistence | BLOCKED: no durable transactional client store exists in this repository |
| Mainnet readiness | BLOCKED; no mainnet configuration or deployment was enabled |

## Independent review

Fresh-context reviewers examined exact and batch paths separately, without first reading prior findings. Their baseline was `3075e524d0614817bd4f730a2cbb0682d010e802...19c29058827072612f410e8248751306cef0c737`, with the surrounding runtime and current protocol/store contracts. These were independent AI code reviews within this engineering workflow, not an external audit certificate.

The exact review traced signatures, envelope limits, transaction identity, replay/identifier ownership, finality, accepted retry recovery, gateway verification/admission and exact client attempt lifetime. Its focused server/gateway and separate core/client checks passed 475 tests. No high/medium issue was established within that scope.

The batch review traced singleton genesis, stable covenant lineage, signed-int64 accounting, vouchers, claim/top-up/refund attempts, MCP charging, funding authorisation and facilitator capabilities. It found one reproducible medium issue:

**M1 — a delayed batch receipt could overwrite a newer client channel.** `applySettlement` validated against the payment's captured channel, then saved unconditionally. Replaying a receipt after a completed top-up reverted the current head, funding amount and voucher ceiling; the next request could retire that old head and fund a replacement channel. Separate reproductions showed rollback after claim recovery and after a higher same-head voucher. The terminal refund guard already blocked that case.

The fix adds required `ChannelStore.compareAndSaveChannel(expected, updated)`. It atomically compares the complete snapshot, rejects stale writes, preserves matching applied retries, and enforces open funding/refund and terminal-refund guards even for no-op updates. All SDK off-chain update paths now use it: settlement success/error, voucher publication, corrective head adoption and retirement following an asynchronous UTXO observation. Error marking cannot replace newer state with an old suspicious snapshot.

Independent follow-up review closed M1. It also tested a refund reserved during voucher signing; publication correctly failed while the refund remained pending. The new store contract is documented in `packages/client/README.md`. Custom stores must implement the comparison and mutation in one transaction; a separate load/save sequence is insufficient.

## Real controlled consensus reorg

Run:

```sh
node scripts/validate-reorg-consensus.mjs /path/to/canonical/rusty-kaspa > reorg-report.json
```

The launcher requires a clean canonical checkout at `c338d495bec29e4dc8b5149f99e8db6fa916ed4a` (2.0.1), uses the existing oracle's locked dependency versions and runs the real `TestConsensus` block/virtual-state pipeline.

The first branch accepted a tx-v1 spend. A longer competing branch accepted a conflicting spend of the same input. The test observed two selected-chain blocks removed and seven added, removal of the original output, creation of the replacement output, and replacement transaction acceptance in the added chain. The original funding outpoint remained spent.

A separate containing-header test rejected the same non-final transaction at DAA 19 when lock time was 19 (`NotFinalized`), then accepted it at containing DAA 20. This tests header-context finality rather than only the script's lock-time check.

This was isolated simnet consensus with skipped PoW, deterministic block hashes, maturity reduced to two, and generic `OP_TRUE` spends. It does not exercise x402 covenant scripts in a reorg, application settlement rollback, RPC transport, public node synchronisation or real reorg probability/depth. Existing signed x402 covenant checks and funded TN10 proofs remain separate evidence. In particular, an observed `accepted` transaction can be displaced; the current TN10 gateway's acceptance policy is not evidence of mainnet finality.

## Actual persistence tests

Run after building:

```sh
node scripts/check-client-persistence.mjs --report persistence-report.json
```

The script uses real child processes on an ext-family filesystem, killing only children it created. It calls the existing reference helpers; it does not substitute a new persistence implementation.

- Exact journal: SIGKILL after write, file fsync, hardlink publication and directory fsync. Fresh processes recovered only published records, with unchanged artifact/transaction ID and reserved input.
- Provider contention: a second writer was rejected. A killed owner left a stale lock that failed closed; explicit recovery after verified child exit restored operation.
- Batch/refund snapshot: kills before/after rename preserved a complete old/new record. Reloading the reserved refund into the actual memory store blocked conflicting reuse, mismatched evidence and stale application; accepted application was idempotent.
- Two snapshot writers: both read the same initial file; the stale second writer overwrote the first writer's update without rejection. This deliberately demonstrates a failed production requirement, not a successful durability guarantee.

Only `MemoryChannelStore` implements the checked-in client-store contract. Batch recovery snapshots use write/rename without fsync or a transactional compare-and-set; they are reference-harness snapshots. The SDK CAS fix protects in-memory application updates, but does not turn these snapshot files into a durable multi-process store. Process-kill survival also does not prove power-loss durability.

The gateway's real local SQLite and abrupt-process-loss tests from the earlier matrix remain valid for their tested paths. They do not fill the missing production client implementation. A production client/store target is required before that gate can be validated and closed.

## Final verification

- Full suite: 666 package tests and 25 tooling tests passed, including seven new client regressions.
- All workspace builds, gateway typecheck/Worker dry-run, schemas, site build/check, public package dry runs and diff checks passed.
- The final persistence harness and canonical reorg/header-finality harness passed their stated assertions. The persistence report still records the intentionally reproduced snapshot lost update.
- No new public network spending or deployment was performed in this follow-up. Frozen release snapshots were preserved.

## Evidence and remaining work

Original reviewer reports, the independent closure report, final reorg JSON and persistence JSON are retained privately under `.kaspa-x402-live/readiness-evidence-20260907/`. The earlier funded evidence is indexed in [the scenario matrix](testnet-scenario-matrix-20260907.md).

Remaining gates: implement/select and validate the production durable client store, define and test application-level finality/reorg recovery for the intended deployment, and complete any required external audit and operational soak. The tests above do not close those gates. Legacy alpha channel migration remains outside the clean Alpha.11 cutover.
