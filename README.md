# Kaspa x402

Kaspa x402 is a proposed x402 v2 network binding for native Kaspa micropayments.

The initial direction is:

```json
{
  "scheme": "batch-settlement",
  "network": "kaspa:<network>",
  "asset": "KAS",
  "extra": {
    "binding": "kaspa-escrow-v1"
  }
}
```

The binding is designed for capital-backed escrow channels on Kaspa:

1. A client funds a Kaspa covenant escrow once.
2. Each paid request carries a cumulative signed voucher.
3. The server verifies the voucher and serves immediately.
4. The server claims later.
5. The client can refund unspent funds after the timeout.

This repository is starting as a standard and reference implementation workspace. It is intentionally independent of any single hosted facilitator or product implementation.

## Current Status

Planning and specification scaffold.

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

Start with [spec/kaspa-batch-settlement-v1.md](spec/kaspa-batch-settlement-v1.md), then read the HTTP, MCP, facilitator, and error profiles in `spec/`.

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
- x402 batch-settlement: https://github.com/x402-foundation/x402/blob/main/specs/schemes/batch-settlement/scheme_batch_settlement.md
- Kaspa Toccata docs: https://github.com/kaspanet/docs/tree/main/content/docs/toccata
