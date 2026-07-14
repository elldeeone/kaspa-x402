# Live Testnet Report

Status: current `0.1.0-alpha.7` full live harness run.

Generated: `2026-07-14T04:23:40.272Z`

Network: `kaspa:testnet-10`

Node: private TN10 node, synced with UTXO index enabled.

Virtual DAA score at run start: `516441994`

The live proof used the NodeJS SDK built from reviewed `rusty-kaspa` commit
`78257f273a26c4be085bab0f79437dee99ca8835`. It validated the preferred KIP-10
`exact-transaction` payload, the `10000000` sompi additive-threshold policy,
reservation replay protection, and the full batch-settlement lifecycle.
Hosted-gateway evidence is tracked separately in `docs/testnet-gateway.md`.

## Exact KIP-10 Transaction

- Transaction id: `28212a4ec66c9283b63079878d62ea4ef50739b3ad018c07a510b39c78f1e22b`
- Transaction version: `1`
- Version evidence source: `adapter-submitted-transaction-shape`
- Output index: `1`
- Amount: `100000000` sompi
- Finality: `accepted`
- Payload evidence type: `kip10-exact-transaction`
- Transaction encoding: `kaspa-sdk-safe-json-v2.0.0`
- Reservation id: `5b4f7a9643df002c21113237773684aa81f1be1cf114699463b20ac64a9e2765`
- Borrow outpoint:
  `22f03bb33c7918fd59c3a00e40fd209416e67c93134ab5f2023592b701d6755e:0`
- Additive threshold: `10000000` sompi
- Transaction artifact SHA-256:
  `75bfb0c48a324e9250c37f42d8fdb4b662f61634cfc9a8b2fbaf7771b4bfb387`
- Server broadcast finality: `accepted`
- Replay rejection: HTTP `409`, `invalid_transaction_state`

## Batch Deposit And Voucher

- Funding transaction id: `53f334006e6f67d86fea92c0ba321d1605462c0b3a962a294233ac0d66487306`
- Transaction version: `0` (`sdk-generated-transaction`)
- Deposit outpoint: `53f334006e6f67d86fea92c0ba321d1605462c0b3a962a294233ac0d66487306:0`
- Funding amount: `400000000` sompi
- Channel id: `1b0b63070762cd78b310d7abe99910444fa4bc582e245e8e2b36da2e71296c53`
- Initial charge: `100000000` sompi
- Voucher-only charge: `100000000` sompi
- Cumulative charge after both requests: `200000000` sompi
- Voucher-only request reused the accepted active outpoint and did not open a
  second channel.

## Batch Claim

- Claim transaction id: `a03177800689ebcaca879b018129904bcb47d90613ef05eb49bce44217c946a3`
- Transaction version: `1`
- Finality: `accepted`
- Original outpoint: `53f334006e6f67d86fea92c0ba321d1605462c0b3a962a294233ac0d66487306:0`
- Continuation outpoint: `a03177800689ebcaca879b018129904bcb47d90613ef05eb49bce44217c946a3:1`
- Input amount: `400000000` sompi
- Authorized claim: `200000000` sompi
- Server output: `198000000` sompi
- Fee: `2000000` sompi
- Continuation amount: `200000000` sompi

The continuation exactly equalled `fundingAmount - authorizedClaimAmount`.
The server fee reduced the payout, not the covenant continuation.

## Replay Rejection

The harness deliberately attempted to apply the old voucher/script state to the
claim continuation. TN10 rejected transaction
`695afc3dde495f6012dd988530514a541c8b86fb64fbab7a67851d37d2bf84b6`
with a signature-script verification failure. The rejection proves that the
voucher is bound to the full active outpoint and script epoch.

## Batch Refund

- Absolute refund DAA score: `516443794`
- Refund transaction id: `d42da50ac72e977448aa8a817055e0a2ceac934f9e8f2b29c3454c5ad2560a95`
- Transaction version: `1`
- Finality: `accepted`
- Input amount: `200000000` sompi
- Refund amount: `198000000` sompi
- Fee: `2000000` sompi

The harness waited until contextual DAA was strictly greater than the absolute
timeout before broadcasting the refund.

## Required Flow Status

- exact KIP-10 transaction artifact settlement and replay rejection: passed
- batch deposit-voucher settlement: passed
- batch voucher-only settlement: passed
- batch claim transaction construction and broadcast: passed
- replay rejection across exact and batch-settlement: passed
- batch refund transaction construction and broadcast after timeout: passed

## Mainnet Read-Only Check

The supplied mainnet node was queried over gRPC without submitting a
transaction. At the check it reported `rusty-kaspa 2.0.1`, network `mainnet`,
synced status, UTXO indexing enabled, and virtual DAA score `485831781`.

This connectivity check is not a mainnet readiness claim. Mainnet remains
subject to the audit, custody, operational, and release gates in
`docs/mainnet-readiness.md`.
