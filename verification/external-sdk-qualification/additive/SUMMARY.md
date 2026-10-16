# KIP-10 additive exact SDK qualification

10/10 scenarios passed; 785 real HTTP requests. Stress subset: 640 requests, maximum concurrency 8, fixed seed `0x1973a14`. No SDK defect proved; no SDK changes requested.

216 transactions were accepted by the controlled evidence fixture; 215 protected handler invocations were independently recorded. One accepted transaction deliberately represented external advancement without invoking protected work. Head changes matched the independent winner/handler ledger and exact successor deltas across all eight added shards.

Checks: repeated successor deltas; same-head conflicting payments and stale offers; real Schnorr intent rejection; tampered artifact rejection; cached duplicate receipts across server recreation; eight simultaneous identical retries; unknown broadcast held until accepted evidence; side-effect uncertainty held for explicit recovery; 100 unpaid offers preserve state; selected external lineage adoption and reorg quarantine; eight-shard concurrency/stress.

Reproduce from campaign root: `node additive/run.mjs > additive/run.log 2>&1`. It regenerates report.json, requests.json and ledger.json. Request paths are seeded; ordering and individual race winners can vary with scheduling. Fingerprints describe this completed run.

Proof limits: chain acceptance/UTXO evidence is controlled, with no funded node, live broadcast or consensus execution. Real public covenant transaction digest/builders and real payer Schnorr signatures execute through the installed private adapters verifier. The copied SDK-native address helper is an explicit fixture. Only installed package imports are used; no repository runtime imports. Server recreation reuses both the same MemoryServerChannelStore and MemoryChannelLockManager as the documented coordination contract requires. This tests in-process ownership/recovery, with no process-crash or production-store durability claim. Counts are test traffic, not a production throughput measurement.
