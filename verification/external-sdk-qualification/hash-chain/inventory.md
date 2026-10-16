# Hash-chain external qualification inventory (before implementation)

Public seams: installed @kaspa-x402/server DirectModeServer, HashChainExactTransactionVerifier and grant HTTP handler; @kaspa-x402/server/hash-chain-grants durable SQLite issuer and claim digest; @kaspa-x402/client exported Schnorr transaction signer; @kaspa-x402/core HTTP headers/request binding; @kaspa-x402/covenant chain generation/scripts.

Failure modes to cover:
1. Sequential links lose exact head delta, grant progression, payer binding, or protected-work count.
2. Concurrent distinct payer claims disclose the same key; same claimant retries differ; wrong payer/signature/context claims succeed.
3. Unavailable/missing/current-head observations disclose grants or grant unusable head; selected-chain unknown/reorg executes protected work.
4. Abandoned/expired disclosure returns to ready or reuses keys; owner rotation fails to discard exposed key; exhausted chains issue offers.
5. SQLite reopen loses assignment, delivery retry, accepted payment, head advancement, hold/retired state, or seen-key authority.
6. Invalid/tampered signatures, head script, exact delta, fee or funding metadata pass verifier; duplicate successful retry runs handler twice.
7. Bounded seeded mixed operations produce grant duplication or inconsistent head delta.

Evidence limits: real SDK signatures and real SQLite durability, private loopback HTTP, controlled chain observations. No consensus execution, live network authority, funded transactions or broadcasts. Integrator callbacks remain explicit host responsibilities.
