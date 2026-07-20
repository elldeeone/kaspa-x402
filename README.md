# Kaspa x402

Proposed x402 v2 network bindings for native Kaspa payments. HTTP APIs and
MCP tools charge native KAS per request; servers verify and settle directly
against the Kaspa network.

- Canonical reference (specs, schemas, vectors, docs, releases):
  https://kaspa-x402.org
- Live testnet integration gateway (paid-canary-proven alpha.9):
  https://demo.kaspa-x402.org
- Browser test client: https://kaspa-x402.org/demo/

Status: alpha. Everything targets `kaspa:testnet-10`. Mainnet use is blocked
by the gates in [docs/mainnet-readiness.md](docs/mainnet-readiness.md), and
reference runtimes require explicit `allowMainnet` opt-in. Package names,
schemas, and field names may change until the first tagged spec release.

The binding ships two x402 schemes:

```json
{
  "scheme": "exact",
  "network": "kaspa:<network>",
  "asset": "KAS",
  "amount": "<sompi>",
  "extra": {
    "binding": "kaspa-exact-v2",
    "profile": "standard-native"
  }
}
```

```json
{
  "scheme": "batch-settlement",
  "network": "kaspa:<network>",
  "asset": "KAS",
  "amount": "<max per-request sompi>",
  "extra": {
    "binding": "kaspa-escrow-v1"
  }
}
```

`exact` is a fixed-price one-shot native transfer. `standard-native` is the
default ordinary KAS payment. Optional `additive` spends and recreates a
merchant-owned KIP-10 head; the successor increase equals the advertised exact
amount and is the only merchant payment. Unpaid offers do not reserve or retire
heads.
`batch-settlement` funds a covenant-backed escrow once and meters repeated or
variable-cost requests with off-chain vouchers. KIP-9 storage mass makes very
small on-chain outputs uneconomic or non-constructible depending on the full
transaction shape; the reference gateway therefore applies a conservative
`10000000` sompi output policy. This is not a universal consensus dust constant.
Batch-settlement vouchers can price below the on-chain policy.
Server claims preserve the covenant continuation at exactly active funding
minus the voucher-authorized claim; transaction fees reduce the server payout
or come from a separate server input.
Batch refund locks are absolute DAA scores below the consensus timestamp
boundary, and become eligible only after the chain DAA strictly exceeds the
advertised score.

## What's Here

- `spec/` — the Kaspa binding and transport profiles; start with
  [spec/kaspa-x402-v1.md](spec/kaspa-x402-v1.md).
- `schemas/`, `vectors/` — wire-format JSON Schemas and conformance vectors,
  including negative vectors.
- `packages/` — TypeScript reference packages: core helpers, direct-mode
  client and server, covenant helpers, an optional self-hosted facilitator,
  and a CLI.
- `examples/` — runnable mock examples for paid HTTP, paid MCP tools,
  facilitator settlement, and recovery.
- `contracts/` — SilverScript escrow covenant source and fixtures.
- `site/` — the standards site build.
- `packages/demo-gateway/` — the private Cloudflare Worker behind the hosted
  testnet gateway.

## Verify

CI runs the full check suite on every pull request; see
[CONTRIBUTING.md](CONTRIBUTING.md). Locally:

```sh
npm ci
npm test
npm run validate:schemas
npm run site:build && npm run site:check
node packages/cli/dist/index.js vectors verify
```

Mock examples run without wallet secrets or node credentials:

```sh
node examples/paid-http-api/index.mjs
node examples/paid-mcp-tool/index.mjs
node examples/self-hosted-facilitator/index.mjs
node examples/recovery/index.mjs
```

`npm run proof:offline` exercises both exact profiles, exact replay rejection,
KIP-10 exact-delta settlement, batch settlement idempotency, corrective
stale-voucher handling, and tx-v1 claim/refund artifacts against mock
adapters. Live testnet proof is fail-closed and adapter-driven; see
[docs/live-testnet-proof.md](docs/live-testnet-proof.md).

## Packages

Published alpha packages (install with an explicit prerelease tag):

```text
@kaspa-x402/core
@kaspa-x402/covenant
@kaspa-x402/client
@kaspa-x402/server
```

Repository-only private workspaces: `@kaspa-x402/facilitator`,
`@kaspa-x402/cli`, `@kaspa-x402/demo-gateway`.

## Security and Review

See [docs/security-threat-model.md](docs/security-threat-model.md),
[docs/review-closure-ledger.md](docs/review-closure-ledger.md), and
[docs/mainnet-readiness.md](docs/mainnet-readiness.md). Draft specs, package
names, vectors, and live testnet proof do not imply mainnet readiness. The
ecosystem-facing proposal is
[docs/public-proposal.md](docs/public-proposal.md).

## Reference Specs

- x402 v2: https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md
- x402 HTTP v2: https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md
- x402 MCP v2: https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/mcp.md
- x402 exact: https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact.md
- x402 batch-settlement: https://github.com/x402-foundation/x402/blob/main/specs/schemes/batch-settlement/scheme_batch_settlement.md
- Kaspa Toccata docs: https://github.com/kaspanet/docs/tree/main/content/docs/toccata
