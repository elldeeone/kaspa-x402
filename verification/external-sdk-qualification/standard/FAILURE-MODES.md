# Standard-native external qualification failure modes

Before harness implementation, inspect these public seams:
- DirectModeServer.handlePaidRequest over real loopback HTTP: challenge/retry, retained cached response, concurrent duplicates and independent callback execution counts.
- Public client and MCP bindings: actual URL/method/body/audience/tool arguments/host trusted tenant context must bind the payer authorization.
- ExactTransactionVerifier and chain sendTransaction are explicit trusted adapters. Controlled fixture chain observations are not live chain or consensus proof; no verifier that simply returns success may count as cryptographic validation.
- Invalid/expired authorization, changed network/profile/amount/output/transaction must fail before protected work.
- Settlement rejected/unknown, lost HTTP response, caller cancellation and delayed adapters: never execute unpaid protected work, never turn an uncertain transaction into a fresh payment automatically.
- Public resource admission: oversized headers/body/JSON structure, bounded concurrency/deadlines and aborts should fail closed with no handler invocation.
- Stress: fixed seed, bounded worker count, 500+ total requests, exact independent expected handler totals and repeatable JSON artifacts. This is behavior qualification, not a production throughput claim.

Scope limits: controlled chain facts, process-local memory state, loopback transport. No network broadcast, funding, persistence restart or production availability proof.
