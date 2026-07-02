# Public Proposal Draft

Status: draft for community review. No external issue, pull request, or
standards submission has been opened from this repository yet.

Kaspa x402 proposes native Kaspa bindings for x402 v2 payment flows. The first
draft defines three scheme/network profiles:

- `exact` for fixed-price one-shot transfers;
- `upto` for one-shot variable-cost work with a client-authorized cap;
- `batch-settlement` for repeated micropayments backed by escrow/channel state.

The network strings are `kaspa:testnet-10` for alpha validation and
`kaspa:mainnet` as a reserved profile name. The current implementation and live
evidence are testnet-only. Mainnet use is blocked by the gates in
`docs/mainnet-readiness.md`.

## Why Three Profiles

Kaspa payments do not all have the same settlement shape.

`exact` is the simplest fit when the resource has a fixed price and the client
can pay directly with a native transaction.

`upto` fits variable-cost single requests. The client signs a bounded
authorization, the server charges no more than that cap, and the settlement
response records the actual charge.

`batch-settlement` fits repeated small requests. A client funds an escrow
channel, signs cumulative vouchers per paid request, and the server can claim
later while preserving refund paths for remaining value.

Keeping these profiles separate avoids overloading one x402 scheme with three
different settlement semantics.

## Kaspa Binding

The Kaspa binding is UTXO-native:

- amounts are decimal strings in sompi;
- payment identity is tied to outpoints, transaction ids, output indexes, and
  script-public-key material;
- covenant-backed profiles validate successor output state rather than assuming
  an account-style global contract;
- transaction-v1 claim/refund artifacts include compute-budget and hash context
  evidence.

The public wire format stays aligned with x402 v2 transports. HTTP uses
`PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, and `PAYMENT-RESPONSE`; MCP uses the
standard `_meta` payment fields.

## Facilitator Lock-In

The reference implementation is direct-mode first. Servers can verify and settle
payments without depending on a hosted facilitator. A self-hosted facilitator
package exists for compatibility with x402-style `/supported`, `/verify`, and
`/settle` flows, but it is optional and not part of the initial alpha package
set.

## Evidence

The repository contains:

- specs in `spec/`;
- JSON schemas in `schemas/`;
- conformance vectors in `vectors/`;
- transaction-v1 claim/refund reference vectors for the escrow profile;
- mock HTTP, MCP, facilitator, and recovery examples in `examples/`;
- a live `kaspa:testnet-10` report in `docs/live-testnet-report.md`;
- a threat model in `docs/security-threat-model.md`;
- a mainnet readiness profile in `docs/mainnet-readiness.md`.

The live testnet report is evidence that the reference flows can execute on
testnet. It is not a production approval, audit result, or mainnet safety claim.

## Proposed Community Path

1. Share this proposal with the x402 and Kaspa communities.
2. Open a focused x402 discussion or issue for `kaspa:*` network binding names.
3. Keep the first external discussion grounded in spec text, vectors, and live
   testnet evidence rather than production claims.
4. Iterate on naming, schema shape, and compatibility with existing x402
   conventions before tagging a stable spec.
