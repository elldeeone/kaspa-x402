# Kaspa x402

Kaspa x402 is a proposed set of x402 v2 network bindings for native Kaspa payments.

The initial standard targets three first-class x402 schemes:

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
  "scheme": "upto",
  "network": "kaspa:<network>",
  "asset": "KAS",
  "amount": "<max sompi>"
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

Use `exact` for fixed-price one-shot purchases, `upto` for one-shot variable usage with a client-authorized cap, and `batch-settlement` for repeated micropayments backed by escrow/channel state.

This repository is starting as a standard and reference implementation workspace. It is intentionally independent of any single hosted facilitator or product implementation.

## Current Status

The repository now contains the v0 reference scaffold:

- protocol profiles for `exact`, `upto`, and `batch-settlement`;
- JSON schemas and conformance vectors for payment requirements, payloads, settlement responses, channel IDs, and vouchers;
- TypeScript core helpers for canonical headers, validation, IDs, digests, and amounts;
- covenant helpers and escrow fixtures for `batch-settlement`;
- client and server direct-mode packages for channel-backed batch payments.

The current implementation focus is first-class direct-mode `exact`, then `upto`, then transaction-builder adapters and live proof harnesses.

Do not treat package names, schemas, or field names as frozen until the first tagged spec release.

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

## Package Scope

The intended npm scope is:

```text
@kaspa-x402/*
```

Initial package placeholders:

```text
@kaspa-x402/core
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
- x402 upto: https://github.com/x402-foundation/x402/blob/main/specs/schemes/upto/scheme_upto.md
- x402 batch-settlement: https://github.com/x402-foundation/x402/blob/main/specs/schemes/batch-settlement/scheme_batch_settlement.md
- Kaspa Toccata docs: https://github.com/kaspanet/docs/tree/main/content/docs/toccata
