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
| Exact evidence must match x402 and Kaspa-native transaction reality | Fixed in alpha.7 source and TN10 live proof | `exact-transaction` carries a signed KIP-10 transaction artifact plus transaction encoding and buildable reservation terms. Direct mode derives exact continuation evidence from verified transaction data, locks retries by transaction-artifact hash and committed transaction id, and enforces bounded transaction envelopes and fee policy. The 2026-07-14 TN10 run proved KIP-10 exact settlement and replay rejection with the `10000000` sompi additive-threshold policy. |
| Hosted exact must not advertise before Worker settlement exists | Fixed in alpha.7 source; fresh hosted evidence pending | Source gates `exact` on hosted settlement enablement, PNN broadcast mode, and funded inventory. The last recorded hosted paid proof remains the historical 2026-07-09 alpha.6 Worker run. A 2026-07-14 read-only check found exact inventory empty, so `/supported` advertised only `batch-settlement` and `/exact` returned `503 exact_unavailable`. The Worker has not been redeployed or paid-canary proven for alpha.7. |
| Live proof harness must be reproducible from committed code | Fixed for alpha.7 source | `scripts/live-adapter-reference.mjs` contains the reviewable TN10 RPC, funding, exact, batch, claim, replay, and refund wiring. Operator-specific RPC URLs, wallet material, SDK paths, generated keys, reports, and recovery files remain outside source control via environment and `.kaspa-x402-live/`. The 2026-07-14 live run passed KIP-10 exact settlement, batch deposit/voucher, claim, stale-voucher rejection, and strict post-timeout refund requirements recorded in `docs/live-testnet-report.md`. |
| HTTP and MCP transports must not release protected results before settlement succeeds | Fixed for current direct-mode tests | Server tests cover handler failure, failed persistence, and protected-content withholding on settlement failure. |
| Facilitator support must not widen server capability | Fixed for current facilitator tests | Facilitator tests assert supported-kind intersection and explicit claim/refund settler requirements. |
| Mainnet readiness must not be implied by testnet success | Open gate | Mainnet remains blocked by `docs/mainnet-readiness.md`; `kaspa:mainnet` is a reserved profile name only. |

## Remaining Gates

- independent audit of exact, batch covenant, state-store, and adapter behavior;
- production durable store implementation and operational recovery playbooks;
- fresh live `kaspa:testnet-10` evidence after each release-candidate change;
- hosted gateway redeploy and paid TN10 canary evidence after each hosted exact
  Worker change;
- upstream/community discussion before any stable registry or mainnet claims.
