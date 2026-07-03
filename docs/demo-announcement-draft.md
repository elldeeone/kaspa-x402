# Demo Announcement Draft

Status: draft only. Do not publish, post, or send externally without explicit
operator approval.

## Short Draft

Kaspa x402 now has a public alpha reference site and hosted testnet gateway for
native KAS payment experiments.

- Site: https://kaspa-x402.org
- Gateway: https://demo.kaspa-x402.org
- Network: `kaspa:testnet-10`
- Schemes: `exact` and `batch-settlement`
- Packages: `@kaspa-x402/core`, `@kaspa-x402/client`,
  `@kaspa-x402/server`, and `@kaspa-x402/covenant` on npm under the alpha tag
- Evidence: live exact and batch paid runs are documented in the gateway docs

This is alpha, testnet-only material. It is for implementer testing and review,
not for mainnet payments or production availability claims.

## Longer Draft

The Kaspa x402 repository now publishes a plain standards site with JSON
Schemas, specs, vectors, release snapshots, package links, and a static
browser demo. A separate Worker-backed gateway on `demo.kaspa-x402.org`
exposes real `kaspa:testnet-10` protected endpoints for `exact` and
`batch-settlement` flows.

The gateway has settled live testnet exact and batch payments, including exact
idempotent replay, exact same-transaction conflict rejection, batch
deposit-voucher settlement, batch voucher-only reuse, and stale voucher
correction. The hosted Worker does not hold spending keys, does not advertise
mainnet, and uses a non-spending scheduled canary for public health evidence.

Known limits:

- testnet only;
- no mainnet readiness claim;
- no hosted facilitator in the public alpha;
- no claim broadcasting in the hosted gateway;
- paid canaries remain manual from isolated testnet wallets;
- covenant source reproducibility (the SilverScript escrow contract source
  behind `batch-settlement`) and mainnet readiness remain documented gates.

Suggested call to action: review the schemas, run the vectors, try the hosted
testnet gateway, and report interoperability issues with decoded headers and
testnet transaction evidence.
