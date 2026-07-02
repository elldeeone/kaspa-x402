# Kaspa x402

Kaspa x402 is a proposed set of x402 v2 network bindings for native Kaspa payments.

Status: alpha reference implementation. The current public surface targets
`kaspa:testnet-10` testnet iteration and review. It is not mainnet-ready and
must not be used for production funds.

The current native alpha surface targets two first-class x402 schemes:

```json
{
  "scheme": "exact",
  "network": "kaspa:<network>",
  "asset": "KAS",
  "amount": "<sompi>"
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

Use `exact` for fixed-price one-shot purchases and `batch-settlement` for
repeated micropayments backed by escrow/channel state. The experimental capped
authorization work that maps to x402 `upto` is archived until the expiry upper
bound can be enforced natively in the script path.

This repository is an alpha standard and reference implementation workspace. It is intentionally independent of any single hosted facilitator or product implementation.

## Current Status

The repository now contains the alpha reference implementation. The current
native target surface is:

- protocol profiles for `exact` and `batch-settlement`;
- JSON schemas and conformance vectors for payment requirements, payloads, settlement responses, channel IDs, and vouchers;
- TypeScript core helpers for canonical headers, validation, IDs, voucher digests, and amounts;
- covenant helpers, escrow fixtures, transaction-v1 reference vectors, and fixture reproducibility checks for `batch-settlement`;
- client and server direct-mode packages for `exact` and channel-backed batch payments over HTTP and MCP helper surfaces;
- an optional self-hosted facilitator package exposing framework-neutral `/supported`, `/verify`, and `/settle` handlers over the direct-mode verifier;
- a `kaspa-x402` CLI for conformance vector verification and offline payment/channel inspection workflows;
- runnable mock examples for paid HTTP, paid MCP tools, self-hosted facilitator settlement, and recovery scenarios.

Archived capped authorization artifacts still exist in the repository until the
implementation cleanup removes them from shipped schemas, package APIs,
examples, CLI commands, and release artifacts.

The current remaining implementation focus is production-grade native adapters,
release hardening, and independent review. Capped authorization remains
archived research; see [docs/native-profile-boundary.md](docs/native-profile-boundary.md).

Do not treat package names, schemas, or field names as frozen until the first tagged spec release.

See [docs/public-proposal.md](docs/public-proposal.md) for the ecosystem-facing
proposal draft, [docs/alpha-publish.md](docs/alpha-publish.md) for the npm
alpha checklist, and [docs/versioning-policy.md](docs/versioning-policy.md) for
the compatibility rules.

## Layout

```text
spec/       Protocol profiles and Kaspa network binding
schemas/    JSON schemas for wire objects
vectors/    Conformance vectors
packages/   TypeScript reference packages
examples/   Runnable examples
docs/       Architecture notes and roadmap
```

Start with [spec/kaspa-x402-v1.md](spec/kaspa-x402-v1.md), then read the scheme bindings and transport profiles in `spec/`.

## Quick Checks

```sh
npm run build
npm run validate:schemas
node packages/cli/dist/index.js vectors verify
npm run proof:offline
npm --workspace @kaspa-x402/cli test
```

The example scripts run in mock mode and do not require wallet secrets or node credentials:

```sh
node examples/paid-http-api/index.mjs
node examples/paid-mcp-tool/index.mjs
node examples/self-hosted-facilitator/index.mjs
node examples/recovery/index.mjs
```

The offline proof harness exercises exact replay rejection, batch settlement,
idempotency, corrective stale-voucher handling, and tx-v1 claim/refund artifact
construction against mock adapters:

```sh
npm run build
npm run proof:offline
```

Live testnet proof is fail-closed and adapter-driven. Start with:

```sh
npm run proof:live:check -- --config-file live-proof.env.example --write-report
```

See [docs/live-testnet-proof.md](docs/live-testnet-proof.md) for the required live configuration and artifact paths.

Security posture, review closure, and mainnet caveats are documented in
[docs/security-threat-model.md](docs/security-threat-model.md),
[docs/review-closure-ledger.md](docs/review-closure-ledger.md), and
[docs/mainnet-readiness.md](docs/mainnet-readiness.md). Mainnet is not implied
ready by the draft specs, package names, vectors, or live testnet proof, and
reference runtimes require explicit `allowMainnet` opt-in.

## Package Scope

The intended npm scope is:

```text
@kaspa-x402/*
```

Reference package workspace:

```text
@kaspa-x402/core
@kaspa-x402/covenant
@kaspa-x402/client
@kaspa-x402/server
@kaspa-x402/facilitator
@kaspa-x402/cli
```

## Reference Specs

- x402 v2: https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md
- x402 HTTP v2: https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md
- x402 MCP v2: https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/mcp.md
- x402 exact: https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact.md
- x402 upto, deferred for the current native surface: https://github.com/x402-foundation/x402/blob/main/specs/schemes/upto/scheme_upto.md
- x402 batch-settlement: https://github.com/x402-foundation/x402/blob/main/specs/schemes/batch-settlement/scheme_batch_settlement.md
- Kaspa Toccata docs: https://github.com/kaspanet/docs/tree/main/content/docs/toccata
