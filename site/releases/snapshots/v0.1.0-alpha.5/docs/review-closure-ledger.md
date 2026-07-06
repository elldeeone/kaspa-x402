# Review Closure Ledger

Status: current alpha closure notes after narrowing the shipped native surface.

This ledger records the current disposition of previously identified review
themes. It intentionally tracks the package surface that remains shipped:
`exact` and `batch-settlement`.

| Finding theme | Status | Closure evidence |
| ------------- | ------ | ---------------- |
| Public surface must only advertise implemented native profiles | Fixed for current alpha | Schemas, package types, examples, specs, vectors, and runtime offer selection accept only `exact` and `batch-settlement`. |
| Batch covenant authority must be reproducible | Fixed for testnet alpha; mainnet audit still required | Escrow fixture checks, batch claim/refund transaction-v1 vectors, and covenant package tests cover the current template. |
| Transaction-v1 vectors must not be self-referential | Fixed for current vectors | `npm run validate:tx-v1-consensus` cross-checks batch claim/refund artifacts against the configured Kaspa consensus checkout. |
| Exact replay and batch idempotency must prevent duplicate protected execution | Fixed for current direct-mode tests | Server and client tests cover exact replay, batch corrective state, same-id conflicts, and concurrent retries. |
| Exact evidence must match gateway reality without hint-sensitive locks | Fixed for alpha.5 source; hosted redeploy evidence pending | Exact payloads require `transactionId` plus `paymentOutputIndex`, legacy `transaction` evidence is schema-negative, and direct-mode locks key exact retries by transaction id before and after verification. The hosted gateway still needs alpha.5 redeploy and TN10 live proof rerun before it is cited as fresh hosted evidence. |
| Live proof harness must be reproducible from committed code | Fixed for alpha.5 source | `scripts/live-adapter-reference.mjs` contains the reviewable TN10 RPC, funding, exact, batch, claim, replay, and refund wiring. Operator-specific RPC URLs, wallet material, SDK paths, generated keys, reports, and recovery files remain outside source control via environment and `.kaspa-x402-live/`. |
| HTTP and MCP transports must not release protected results before settlement succeeds | Fixed for current direct-mode tests | Server tests cover handler failure, failed persistence, and protected-content withholding on settlement failure. |
| Facilitator support must not widen server capability | Fixed for current facilitator tests | Facilitator tests assert supported-kind intersection and explicit claim/refund settler requirements. |
| Mainnet readiness must not be implied by testnet success | Open gate | Mainnet remains blocked by `docs/mainnet-readiness.md`; `kaspa:mainnet` is a reserved profile name only. |

## Remaining Gates

- independent audit of exact, batch covenant, state-store, and adapter behavior;
- production durable store implementation and operational recovery playbooks;
- fresh live `kaspa:testnet-10` evidence after each release-candidate change;
- upstream/community discussion before any stable registry or mainnet claims.
