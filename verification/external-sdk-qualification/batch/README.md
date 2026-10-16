# External batch SDK qualification

Initial campaign base: `f83eaad417c23b9e9061fc1a1a369e56bf0e471b`. Runtime imports use installed package exports only; archive hashes and package installation provenance are in `../manifest.json`.

Reproduce from this directory:

```sh
node qualify.mjs > run.log 2>&1
node verify.mjs
```

Final run: **17/17 scenario groups**, **701 loopback HTTP requests**, no SDK defects found. Fixed-seed stress sends 650 requests for 221 distinct paid operations, with exactly 221 handler calls. Independent accounting: A=T=22100, S=0, V=1000000, R=10. Duplicate retries execute no additional work. Eleven shared-store/lock server reconstructions occur within stress.

Additional scenarios cover malformed signatures, body/principal/MCP argument binding, stale cumulative voucher/outpoint, concurrent same-ceiling transitions, unknown handler outcomes, explicit operator recovery, interrupted commit recovery, expiry, reserve at ±1, refund lead at ±1, real partial-claim and top-up builders, channel reuse and vector refund boundaries.

Partial claim: A=T=200,S=0,V=1000000 → A=T=200,S=100,V=999900 → next paid request A=T=300,S=100,V=999900. Top-up: A=T=100,S=0,V=1000000 → funded successor plus paid request A=T=200,S=0,V=1001000. Artifacts contain real constructed transactions and signatures. Top-up transition and claim acceptance use controlled adapter evidence; the harness never invokes a network broadcast.

Proof limits: the address codec and selected-chain acceptance are controlled test adapters. The actual public covenant compiler/builders and NativeVoucherVerifier run with real Schnorr voucher, presentation, claim, and top-up signatures. Refund checks are construction/boundary checks, not timed on-chain execution. No live consensus, funding, multi-process durable backend, or full DirectModeClient funding orchestration is qualified here. Fresh MemoryServerChannelStore reconstructs empty state and deliberately loses replay protection; its explicit scenario observes two executions across two fresh stores. Shared-store restart tests use the same atomic memory store and lock.

`setup-failure-011310.*` preserves early fixture failures before happy controls: invalid fake codec byte hashing, JSON-property-order-dependent UTXO map keys, missing shared lock on reconstruction, and anonymous aggregate admission caps. These are harness corrections, not SDK defects or qualifying negative results.
