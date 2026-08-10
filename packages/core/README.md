# @kaspa-x402/core

Transport-neutral types, codecs, canonical encoders, scheme selection, channel IDs, voucher digest helpers, MCP transport primitives, and facilitator wire types.

Status: alpha. This package is part of a testnet-oriented reference
implementation and does not imply mainnet readiness.

This package contains deterministic Kaspa x402 protocol primitives only. It does not talk to wallets, RPC nodes, facilitators, HTTP servers, MCP servers, or the filesystem.

Implemented:

- exported TypeScript types for the public wire objects;
- canonical sompi, network, hex, LE32, LE64, and SHA-256 helpers;
- x402 HTTP header encoding and decoding for `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, and `PAYMENT-RESPONSE`;
- MCP `_meta` key constants, payment-required result helpers, payment metadata
  readers, and deterministic tool-call fingerprints bound to a canonical
  server audience;
- x402 v2 facilitator request, response, and supported-kind TypeScript types,
  including mandatory independent `requestHash` binding for exact requests;
- stable-covenant-ID voucher preimage and digest helpers;
- channel ID preimage and digest helpers;
- signed-int64 A/S/T/V/R accounting and partial-claim transition helpers;
- schema validation via pregenerated standalone validators (Ajv at build time only, safe for runtimes that forbid dynamic code generation);
- semantic retry validation for accepted-offer matching and `payment-identifier`;
- vector-driven tests against the repository conformance fixtures.

## Development

From the repo root:

```sh
npm install
npm test
npm run build
```

The package tests consume `vectors/` directly. Any implementation change that changes header bytes, voucher digests, channel IDs, settlement response validity, or stable error identifiers should update the vectors and spec in the same change.

## Boundary

`@kaspa-x402/core` should stay pure. Covenant builders, transaction signing, RPC submission, HTTP middleware, MCP SDK integration, and facilitator endpoint implementations belong in other packages.
