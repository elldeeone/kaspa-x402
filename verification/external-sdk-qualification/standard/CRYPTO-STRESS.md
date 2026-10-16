# Genuine standard-native cryptographic stress

Three scenario groups passed: **100 unique freshly signed native payments**, 220 real loopback HTTP requests, exactly 100 protected-handler executions, and 20 sampled duplicate retries without an additional execution.

```sh
node standard/crypto-stress.mjs
```

The harness creates 100 distinct funding outpoints, computes each native version0 signing digest using public `exactV0SchnorrSignatureEvidence`, signs each funding input with Schnorr, and recomputes transaction IDs using public `exactV0TransactionId`. Each HTTP request receives its own real payer request-authorization signature. The installed private-support `VerifiedExactTransactionVerifier` performs actual funding and authorization signature verification on all 100 payments.

Four concurrent workers send the challenge/payment requests. The workload creates 200 signatures, triggers 100 real verifier calls and 200 controlled chain reads, and executes no broadcasts. A deterministic sample of 20 paid requests is retried with concurrency four. Independent signed-artifact and protected-handler ledgers each contain 100 unique transaction IDs and exactly **2,000,000,000 sompi in merchant output commitments** (100 × 20,000,000). These are controlled signed payment facts, not newly transferred funds.

`crypto-stress-report.json` retains every signed payment payload and transaction artifact, per-transaction callback/payout ledger, workload parameters, scenario results, input hashes and archive manifest. The prior reports are preserved. `CRYPTO-STRESS-FAILURE-MODES.md` records the implementation's initial failure inventory.

Accepted candidate and origin records remain controlled chain observations. This verifies real cryptography under the installed SDK contract; it does not establish live acceptance, new consensus cross-validation, independent sources, funded economic behavior, durable restart or production throughput. The private adapters archive is explicit source-support outside public release dependencies. The installed verifier requires native version0, so the harness uses the supported public version0 helpers.
