# Genuine standard transaction stress failure inventory

Recorded before harness implementation:
- Distinct request authorizations over one reused transaction would not establish unique payment stress: require 100 distinct funding outpoints and recomputed transaction IDs.
- Changing any signed outpoint must invalidate its old signature: regenerate real Schnorr funding signatures using public v0 digest helpers and verify through installed VerifiedExactTransactionVerifier.
- Chain fixtures can accidentally accept arbitrary input: map every origin and candidate explicitly, reject unknown reads, and document that accepted-chain observations remain controlled.
- Handler counters can agree with verifier counters accidentally: independently sum actual merchant outputs in signed transaction artifacts and callback ledger, require 100 unique transaction IDs and exact aggregate payout.
- Retry concurrency can double execute: replay a deterministic 20-payment sample and assert unchanged callback/payout totals.
- Bounded concurrency and time: use four HTTP workers; always close server and write repeatable report with archive/input hashes and workload ledger.
- Current private verifier enforces standard-native version0; use supported exactV0 public helpers rather than assuming standard version1 support.
