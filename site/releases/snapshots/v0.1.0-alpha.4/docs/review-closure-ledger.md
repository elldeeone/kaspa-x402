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
| HTTP and MCP transports must not release protected results before settlement succeeds | Fixed for current direct-mode tests | Server tests cover handler failure, failed persistence, and protected-content withholding on settlement failure. |
| Facilitator support must not widen server capability | Fixed for current facilitator tests | Facilitator tests assert supported-kind intersection and explicit claim/refund settler requirements. |
| Mainnet readiness must not be implied by testnet success | Open gate | Mainnet remains blocked by `docs/mainnet-readiness.md`; `kaspa:mainnet` is a reserved profile name only. |

## Remaining Gates

- independent audit of exact, batch covenant, state-store, and adapter behavior;
- production durable store implementation and operational recovery playbooks;
- fresh live `kaspa:testnet-10` evidence after each release-candidate change;
- upstream/community discussion before any stable registry or mainnet claims.
