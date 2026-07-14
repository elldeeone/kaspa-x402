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
| Exact evidence must match x402 and Kaspa-native transaction reality | Fixed in alpha.6 source and TN10 live proof | `exact-transaction` carries a signed KIP-10 transaction artifact plus transaction encoding and buildable reservation terms. Direct-mode locks exact retries by transaction-artifact hash and committed transaction id, tests cover broadcast-before-handler, broadcast-only rejection, replay, and idempotency, and the 2026-07-09 TN10 run proved KIP-10 exact settlement plus replay rejection with the `10000000` sompi additive threshold. |
| Hosted exact must not advertise before Worker settlement exists | Fixed for current hosted gateway | `demo.kaspa-x402.org` advertises `exact` only when hosted exact settlement is enabled, PNN broadcast mode is configured, and funded inventory is available. Inventory registration is admin-only, exact transaction artifacts are verified, submitted through TN10 PNN/WSS, matched to accepted chain evidence before content is served, expired reservation leases retire instead of becoming reusable, and batch inventory registration is atomic. The 2026-07-09 hosted proof on Worker version `47862b0f-2ecf-49d0-b793-81e89caa4dfa` settled exact transaction `632dadcf96ac9ce4c56c781d95aac31ed52365a0fb86eb4b0cbbcd1f3eb2f55c` through `demo-gateway-pnn`. |
| Live proof harness must be reproducible from committed code | Fixed for alpha.6 source | `scripts/live-adapter-reference.mjs` contains the reviewable TN10 RPC, funding, exact, batch, claim, replay, and refund wiring. Operator-specific RPC URLs, wallet material, SDK paths, generated keys, reports, and recovery files remain outside source control via environment and `.kaspa-x402-live/`. The 2026-07-09 live run passed the KIP-10 exact transaction-artifact, batch deposit/voucher, claim, replay, and refund requirements recorded in `docs/live-testnet-report.md`. |
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
