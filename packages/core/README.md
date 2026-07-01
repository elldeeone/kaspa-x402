# @kaspa-x402/core

Transport-neutral types, codecs, canonical encoders, scheme selection, channel IDs, authorization digests, voucher digest helpers, and MCP transport primitives.

Status: alpha.

This package contains deterministic Kaspa x402 protocol primitives only. It does not talk to wallets, RPC nodes, facilitators, HTTP servers, MCP servers, or the filesystem.

Implemented:

- exported TypeScript types for the public wire objects;
- canonical sompi, network, hex, LE32, LE64, and SHA-256 helpers;
- x402 HTTP header encoding and decoding for `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, and `PAYMENT-RESPONSE`;
- MCP `_meta` key constants, payment-required result helpers, payment metadata readers, and deterministic tool-call fingerprints;
- voucher preimage and digest helpers;
- channel ID preimage and digest helpers;
- Ajv-backed schema validation wrappers;
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

`@kaspa-x402/core` should stay pure. Covenant builders, transaction signing, RPC submission, HTTP middleware, MCP SDK integration, and facilitator APIs belong in later packages.
