# Live Testnet Report

Status: complete alpha.6 full live harness run.

Generated: `2026-07-07T11:21:44.516Z`

Network: `kaspa:testnet-10`

Node: private `kaspa:testnet-10` node, synced with UTXO index enabled.

Virtual DAA score at run start: `510648301`

The 2026-07-07 live proof runner validated the preferred alpha.6 KIP-10
`exact-transaction` payload shape and the batch-settlement covenant lifecycle.
Hosted-gateway evidence is tracked separately in `docs/testnet-gateway.md`.

## Exact KIP-10 Transaction

- Transaction id: `cb774512b28d9972298577acfed9bd916791f6040628671b0a9d47b2f905d07f`
- Transaction version: `1`
- Version evidence source: `adapter-submitted-transaction-shape`
- Output index: `1`
- Amount: `100000000` sompi
- Finality: `accepted`
- Payload evidence type: `kip10-exact-transaction`
- Transaction encoding: `kaspa-sdk-safe-json-v2.0.0`
- Reservation id: `e81813c76021f1d3e513991b5888f38d9161dcac162f3e611a575f971e0c8842`
- Borrow outpoint:
  `a7dc63cfeb44b87a63a4fdb7942c703d8dd182a9ab25cb55e831ed05f1662825:0`
- Transaction artifact SHA-256:
  `70f010cccda79346b098f0632bc82f5186ebf97613d771300ce03f984e52f27a`
- Payload payment output index: `1`
- Server broadcast transaction id:
  `cb774512b28d9972298577acfed9bd916791f6040628671b0a9d47b2f905d07f`
- Server broadcast finality: `accepted`
- Replay rejection: HTTP `409`, `invalid_transaction_state`

## Batch Deposit-Voucher

- Funding transaction id: `2c90e497f17fa09a589fb4d6bdf4033ed81439550e32820354830214a1d444d6`
- Transaction version: `0`
- Version evidence source: `sdk-generated-transaction`
- Escrow output: index `0`
- Deposit outpoint: `2c90e497f17fa09a589fb4d6bdf4033ed81439550e32820354830214a1d444d6:0`
- Escrow address: `kaspatest:pp0f682knw6aty5ledy4h3htlyyegma6s27jtsl2as0y3fzl8f5tg5fssye5g`
- Funding amount: `400000000` sompi
- Channel id: `cd419c5e771f59d01f2ef48e9b8037fbe3e8edfaf92feb6d52466e6d83fd6d4e`
- Settlement commitment: `d5462e689bca718c294e0b485ff775759201ae0eb9760f9ce3b1fe6490355ef1`
- Finality: `accepted`
- Charged amount: `100000000` sompi
- Top-level settlement amount: `100000000` sompi
- Extension charged amount: `100000000` sompi
- Cumulative charge: `0` to `100000000` sompi

## Batch Voucher-Only

- Reused existing channel: yes
- Channel id: `cd419c5e771f59d01f2ef48e9b8037fbe3e8edfaf92feb6d52466e6d83fd6d4e`
- Active outpoint: `2c90e497f17fa09a589fb4d6bdf4033ed81439550e32820354830214a1d444d6:0`
- Settlement commitment: `b906e159dccbbd5ec308c3117291d9328261919ad4aab19c26153b4590843371`
- Charged amount: `100000000` sompi
- Top-level settlement amount: `100000000` sompi
- Extension charged amount: `100000000` sompi
- Cumulative charge: `100000000` to `200000000` sompi
- Signed maximum claimable: `200000000` sompi

## Batch Claim

- Claim transaction id: `a942dab6640f1c35a4337b37829ef63de882dbe3cabe3d2bb22c6e5c83a30b0e`
- Transaction version: `1`
- Version evidence source: `adapter-submitted-transaction-shape`
- Finality: `accepted`
- Original outpoint: `2c90e497f17fa09a589fb4d6bdf4033ed81439550e32820354830214a1d444d6:0`
- Continuation outpoint: `a942dab6640f1c35a4337b37829ef63de882dbe3cabe3d2bb22c6e5c83a30b0e:1`
- Input amount: `400000000` sompi
- Claimed cumulative amount before claim: `0` sompi
- Active charged amount: `200000000` sompi
- Claim amount: `200000000` sompi
- Server output amount: `198000000` sompi
- Claim fee: `2000000` sompi
- Continuation amount: `200000000` sompi

## Batch Replay Rejection

- Old outpoint: `2c90e497f17fa09a589fb4d6bdf4033ed81439550e32820354830214a1d444d6:0`
- Old script public key: `0000aa205e9d1d569bb5d5929fcb495bc6ebf909946fba82bd25c3eaec1e48a45f3a68b487`
- Attempted input outpoint: `a942dab6640f1c35a4337b37829ef63de882dbe3cabe3d2bb22c6e5c83a30b0e:1`
- Attempted transaction version: `1`
- Version evidence source: `adapter-submitted-transaction-shape`
- Finality: `rejected`
- Rejected: yes
- Rejection class: signature-script verification failure
- Rejection reason: `failed to verify the signature script: script ran, but verificat`
- Attempted server output: `98000000` sompi
- Attempted continuation output: `100000000` sompi

## Batch Refund

- Refund transaction id: `40f00e54ebf03eb25f0a496c12bfea48db290d4e12f2f34eb80fbaa91173831a`
- Transaction version: `1`
- Version evidence source: `adapter-submitted-transaction-shape`
- Finality: `accepted`
- Refund address: `kaspatest:qq2n2shqkghczyel57af242ffs50x5uj07w7ezg7kwm8frwt5xhljqa3d68et`
- Input amount: `200000000` sompi
- Refund amount: `198000000` sompi
- Refund fee: `2000000` sompi
- Output index: `0`

## Required Flow Status

- exact KIP-10 transaction artifact settlement and replay rejection: passed
- batch deposit-voucher settlement: passed
- batch voucher-only settlement: passed
- batch claim transaction construction and broadcast: passed
- replay rejection across exact and batch-settlement: passed
- batch refund transaction construction and broadcast after timeout: passed

## Mainnet Status

This report is not a mainnet readiness claim. Mainnet remains blocked by the
audit, operational, and release gates in `docs/mainnet-readiness.md`.
