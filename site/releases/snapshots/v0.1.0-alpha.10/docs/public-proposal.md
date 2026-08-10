# Public Proposal Draft

Status: draft for community review. External submission status is tracked in
the repository issue tracker.

Kaspa x402 proposes native Kaspa bindings for x402 v2 payment flows. The
current native alpha surface defines two scheme/network profiles:

- `exact` for fixed-price one-shot transfers;
- `batch-settlement` for repeated or variable-cost micropayments backed by
  escrow/channel state.

The network strings are `kaspa:testnet-10` for alpha validation and
`kaspa:mainnet` as a reserved profile name. They are draft binding identifiers,
not proof of CAIP or x402 registry acceptance. The current implementation and
live evidence are testnet-only. Mainnet use is blocked by the gates in
`docs/mainnet-readiness.md`.

## Why These Profiles

Kaspa payments do not all have the same settlement shape.

`exact` is the simplest fit when the resource has a fixed price and the client
can pay directly with a native transaction.

`batch-settlement` fits repeated small requests and bounded variable-cost
requests. A client creates one singleton KIP-20 escrow genesis and signs
lifetime cumulative vouchers against its stable covenant ID. The server can
make repeated partial claims, the client can top up the same lineage without
resetting its accounting, and a timed refund terminates the lane.

The lane tracks A (lifetime actual charge), S (lifetime gross claimed), T
(latest buyer-signed lifetime ceiling), V (current covenant value), and R
(advertised minimum successor reserve). Runtimes persist the rotating current
outpoint and recover unresolved transitions after restart; the stable covenant
ID identifies and constrains lineage but is not a live-UTXO lookup.

Keeping these profiles separate avoids overloading one x402 scheme with
different settlement semantics.

## Kaspa Binding

The Kaspa binding is UTXO-native:

- amounts are decimal strings in sompi;
- payment identity is tied to outpoints, transaction ids, output indexes, and
  script-public-key material;
- covenant-backed profiles validate successor output state rather than assuming
  an account-style global contract;
- transaction-v1 singleton-genesis, repeated-claim, top-up, and refund artifacts
  include compute-budget and hash-context evidence.

The public wire format uses x402 v2 transport primitives. HTTP uses
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
- transaction-v1 singleton-genesis, repeated partial-claim, top-up, and refund
  reference vectors for the escrow profile;
- a review closure ledger in `docs/review-closure-ledger.md`;
- mock HTTP, MCP, facilitator, and recovery examples in `examples/`;
- a live `kaspa:testnet-10` report in `docs/live-testnet-report.md`;
- a threat model in `docs/security-threat-model.md`;
- a mainnet readiness profile in `docs/mainnet-readiness.md`.

The live proof definition additionally requires stable-ID lineage,
A/S/T/V/R reconciliation, and restart recovery. A release is not presented as
freshly proven until its corresponding Testnet-10 run is recorded.

## Proposed Community Path

1. Share this proposal with the x402 and Kaspa communities.
2. Open a focused x402 discussion or issue for `kaspa:*` network binding names,
   CAIP namespace alignment, and the native KAS asset convention.
3. Keep the first external discussion grounded in spec text, vectors, and live
   testnet evidence rather than production claims.
4. Iterate on naming, schema shape, and compatibility with existing x402
   conventions before tagging a stable spec.
