# Live Testnet Report

Generated from two successful strict `kaspa:testnet-10` runs on 2026-07-02.
The canonical repeat run completed at 09:15:20 UTC, after an initial strict run
completed at 09:11:54 UTC.

The live runs used the committed proof runner, an explicit testnet RPC endpoint,
an operator-provided testnet funding wallet, and a local adapter module. Private
keys, recovery material, adapter code for these runs, and the full machine-local
reports remain in `.kaspa-x402-live/`, which is ignored by git.

## Summary

- Status: complete under the current strict live proof contract
- Repeat report: `.kaspa-x402-live/report-strict-repeat.json`
- Initial strict report: `.kaspa-x402-live/report-strict-current.json`
- Network: `kaspa:testnet-10`
- Node network id: `testnet-10`
- Finality target: `accepted`
- Refund timeout: `506254793` DAA
- Required flows: all passed

## Exact

- Amount: `100000000` sompi
- Transaction: `49ae6a1c53c73881e406e9851f3dbd9a4f031c8e59e72afea3e03294d5f56525`
- Transaction version: `0` (source: sdk-generated-transaction)
- Payment output index: `0`
- Finality: `accepted`
- Replay result: `409 invalid_transaction_state`
- Validation scope: application-store replay rejection plus exact output/finality verification.

## Upto

- Zero-charge authorization outpoint: `e43a8166bd645eb9e82b9e3102c0ae51e5b74d6f027189345636176732ebafa3:0`
- Zero-charge authorization transaction version: `0` (source: sdk-generated-transaction)
- Zero-charge authorization finality: `accepted`
- Zero-charge maximum: `100000000` sompi
- Zero-charge settlement transaction: empty, as expected
- Zero-charge settlement transaction version: none (no transaction)
- Nonzero authorization outpoint: `9086a497baeba11b6971b337a5e177e093431b599341001a6ed79dd7943b7bb6:0`
- Nonzero authorization transaction version: `0` (source: sdk-generated-transaction)
- Nonzero authorization finality: `accepted`
- Nonzero maximum: `100000000` sompi
- Nonzero charged amount: `50000000` sompi
- Nonzero settlement transaction: `41f1abe1672eb4a92d36c45550ab327aef9d7925a7289f62b751a608a1514b47`
- Nonzero settlement transaction version: `1` (source: adapter-submitted-transaction-shape)
- Nonzero settlement finality: `accepted`
- Payment output index: `0`
- Replay result: `409 invalid_transaction_state`
- Validation scope: adapter-submitted transaction-v1 shape for the nonzero settlement, accepted authorization funding transactions, node acceptance of the submitted settlement transaction, output/refund accounting verification, and application-store replay rejection. The zero-charge path intentionally has no settlement transaction.

## Batch Settlement

- Escrow address: `kaspatest:pzpnhc9v7xmq3027282nz5rd4w290d6mj0qvx2wcvzn8hdnzlmcs2zxu6f26t`
- Channel id: `a7dda2e3f13c802a69bb3456b901ba390c5d6d9c05b46fb7c65b70377b1f9740`
- Deposit transaction: `7ff9fd1b90aed48535305d6c63d3ec151f3df0b23c7c980fbcde762086ff59dd`
- Deposit transaction version: `0` (source: sdk-generated-transaction)
- Deposit finality: `accepted`
- Deposit outpoint: `7ff9fd1b90aed48535305d6c63d3ec151f3df0b23c7c980fbcde762086ff59dd:0`
- Deposit amount: `400000000` sompi
- Deposit actual charge: `100000000` sompi
- Deposit top-level settlement amount: `100000000` sompi
- Deposit extension charged amount: `100000000` sompi
- Deposit cumulative charge: `0` to `100000000` sompi
- First settlement commitment: `9aa455da3f01520bcaf6cd15b1e2cca514334b02c896b5db01fd35aa0d6e1c58`
- Voucher-only request opened a second channel: `false`
- Voucher-only active outpoint: `7ff9fd1b90aed48535305d6c63d3ec151f3df0b23c7c980fbcde762086ff59dd:0`
- Voucher-only actual charge: `100000000` sompi
- Voucher-only top-level settlement amount: `100000000` sompi
- Voucher-only extension charged amount: `100000000` sompi
- Voucher-only cumulative charge: `100000000` to `200000000` sompi
- Voucher-only signed maximum claimable: `200000000` sompi
- Latest settlement commitment: `a3a9ba52888c6cf4614a2844c5ec4eb368ecd626682beacbd95b383ffab2d991`
- Claim transaction: `398d7931218bad19c7557ff7f1e4d2c11e70496ff747759689b60a8a0589f927`
- Claim transaction version: `1` (source: adapter-submitted-transaction-shape)
- Claim finality: `accepted`
- Claim input amount: `400000000` sompi
- Claimed cumulative amount before claim: `0` sompi
- Active charged amount: `200000000` sompi
- Claim amount: `200000000` sompi
- Server output amount: `198000000` sompi
- Claim fee: `2000000` sompi
- Continuation outpoint: `398d7931218bad19c7557ff7f1e4d2c11e70496ff747759689b60a8a0589f927:1`
- Continuation amount: `200000000` sompi
- Replay result: rejected by node script verification
- Replay attempted transaction version: `1` (source: adapter-submitted-transaction-shape)
- Replay finality: `rejected`
- Replay validation: the attempted replay spent the continuation outpoint with `98000000` sompi to the server and `100000000` sompi to the continuation; the node rejection reason included signature-script verification failure.
- Refund transaction: `a8abefca93a5c616fe21336e3488a54328e50cfe5448c8284a7f27336a6c86da`
- Refund transaction version: `1` (source: adapter-submitted-transaction-shape)
- Refund finality: `accepted`
- Refund input amount: `200000000` sompi
- Refund amount: `198000000` sompi
- Refund fee: `2000000` sompi
- Validation scope: strict live proof validation for batch actual-charge fields, same-channel/outpoint continuity, claim input/output/fee reconciliation, replay rejection, refund input/output/fee reconciliation, transaction-version evidence, and accepted finality where applicable.

## Caveats

- This is testnet evidence only.
- The committed runner validates required flows, transaction-version evidence,
  finality evidence, actual-charge evidence, and claim/refund reconciliation, but
  the live adapter is intentionally external to the public package boundary for
  these runs.
- Failed exploratory runs before these final reports may have produced additional testnet transactions not listed here.
