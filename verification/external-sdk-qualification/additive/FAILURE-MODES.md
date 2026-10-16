# KIP-10 additive exact external qualification inventory

Written before harness implementation. Base: f83eaad417c23b9e9061fc1a1a369e56bf0e471b.

Public seams: DirectModeServer.handlePaidRequest/buildPaymentRequired/reconcileExactHead; MemoryServerChannelStore register/load/list/selectExactHead and exact settlement transitions; public covenant KIP-10 script builders; exact authorization digest/signatures and public transaction verifier. Any supplied acceptance authority is controlled evidence, never consensus proof.

Failure modes to exercise:
1. Same head replay or concurrent double spend executes two handlers or increases amount/version twice.
2. Sequential payments charge wrong delta, change scripts or successor index, lose head identity, or fail to advance current outpoint.
3. Shard selection leases on unpaid offers, serializes independent heads incorrectly, or loses charges under bounded concurrent traffic.
4. Stale offer spends obsolete head, duplicate retry rebroadcasts/reexecutes, changed request reuses existing authorization/identifier.
5. Unknown broadcast/acceptance releases head prematurely, executes unpaid work, loses attempt ownership, or duplicates work after reconciliation.
6. External same-script advancement accepts broken ancestry/under-threshold deltas, retains a spent head, or mishandles a controlled reorg/unknown observation.
7. Server restart over the same store loses pending/applied ownership; store durability beyond the documented in-memory lifetime is not assumed.
8. Handler outcome uncertainty silently retries protected side effects; accepted payment cannot be safely abandoned.
9. Invalid signature, altered successor/delta or malformed payment crosses verifier boundary.

Independent assertions: handler invocation ledger keyed by request fingerprint; accepted transaction ledger; head amount/version/outpoint and script; response/payment receipts; duplicate and pending dispositions. Fixed seed, 500-1000 HTTP requests with bounded concurrency; counts describe harness traffic only. No live broadcasts, funding, production throughput or mainnet claims.
