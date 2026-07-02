# Live Testnet Report

Status: complete for the current alpha proof surface.

Generated: `2026-07-02T11:16:51.204Z`

Network: `kaspa:testnet-10`

Node: `10.0.3.26`, synced with UTXO index enabled.

The live proof runner validated only the shipped exact and batch-settlement
profiles.

## Exact

- Transaction id: `d0c019efc0f02617672e798d68879be3c3bf85908a40d7813b88f2d59286296e`
- Transaction version: `0`
- Version evidence source: `sdk-generated-transaction`
- Output index: `0`
- Amount: `100000000` sompi
- Finality: `accepted`
- Replay rejection: HTTP `409`, `invalid_transaction_state`

## Batch Deposit-Voucher

- Funding transaction id: `18ff4a967735e1fd8862bd140fffbb89d8351853ec8b1ce2180a9ff27ffcedda`
- Transaction version: `0`
- Version evidence source: `sdk-generated-transaction`
- Escrow output: index `0`
- Deposit outpoint: `18ff4a967735e1fd8862bd140fffbb89d8351853ec8b1ce2180a9ff27ffcedda:0`
- Escrow address: `kaspatest:pqszeq20nrkddzjms0300m8m2dye85qmfmy78at6fssn2qcrmpfmxtgzu3535`
- Funding amount: `400000000` sompi
- Channel id: `1eadc0f5befb97046fed510f6d4605158f504e3e11539bf3db851716511d54a6`
- Settlement commitment: `7605507ca4cac67d537c64eea60714a50cd6580ce5f2a5f45c1dbb892da66e41`
- Finality: `accepted`
- Charged amount: `100000000` sompi
- Top-level settlement amount: `100000000` sompi
- Extension charged amount: `100000000` sompi
- Cumulative charge: `0` to `100000000` sompi

## Batch Voucher-Only

- Reused existing channel: yes
- Channel id: `1eadc0f5befb97046fed510f6d4605158f504e3e11539bf3db851716511d54a6`
- Active outpoint: `18ff4a967735e1fd8862bd140fffbb89d8351853ec8b1ce2180a9ff27ffcedda:0`
- Settlement commitment: `ac5440ffb8f2bcfddca6cb33130e258aa796bd43c620ac057269abded3b941e5`
- Charged amount: `100000000` sompi
- Top-level settlement amount: `100000000` sompi
- Extension charged amount: `100000000` sompi
- Cumulative charge: `100000000` to `200000000` sompi
- Signed maximum claimable: `200000000` sompi

## Batch Claim

- Claim transaction id: `ba5d6b8cdd78b6623c8d57ee51e54cca81d4dfd36d4b7adeaaa32dfbe6c414e4`
- Transaction version: `1`
- Version evidence source: `adapter-submitted-transaction-shape`
- Finality: `accepted`
- Original outpoint: `18ff4a967735e1fd8862bd140fffbb89d8351853ec8b1ce2180a9ff27ffcedda:0`
- Continuation outpoint: `ba5d6b8cdd78b6623c8d57ee51e54cca81d4dfd36d4b7adeaaa32dfbe6c414e4:1`
- Input amount: `400000000` sompi
- Claimed cumulative amount before claim: `0` sompi
- Active charged amount: `200000000` sompi
- Claim amount: `200000000` sompi
- Server output amount: `198000000` sompi
- Claim fee: `2000000` sompi
- Continuation amount: `200000000` sompi

## Batch Replay Rejection

- Old outpoint: `18ff4a967735e1fd8862bd140fffbb89d8351853ec8b1ce2180a9ff27ffcedda:0`
- Old script public key: `0000aa20202c814f98ecd68a5b83e2f7ecfb534993d01b4ec9e3f57a4c21350303d853b387`
- Attempted input outpoint: `ba5d6b8cdd78b6623c8d57ee51e54cca81d4dfd36d4b7adeaaa32dfbe6c414e4:1`
- Attempted transaction version: `1`
- Version evidence source: `adapter-submitted-transaction-shape`
- Finality: `rejected`
- Rejected: yes
- Rejection class: signature-script verification failure
- Rejection reason: `failed to verify the signature script: script ran, but verificat`
- Attempted server output: `98000000` sompi
- Attempted continuation output: `100000000` sompi

## Batch Refund

- Refund transaction id: `0e69abdba642e7f57457e11adb85c9d8f57897126a075615cdfa33534229c9dd`
- Transaction version: `1`
- Version evidence source: `adapter-submitted-transaction-shape`
- Finality: `accepted`
- Refund address: `kaspatest:qq2n2shqkghczyel57af242ffs50x5uj07w7ezg7kwm8frwt5xhljqa3d68et`
- Input amount: `200000000` sompi
- Refund amount: `198000000` sompi
- Refund fee: `2000000` sompi
- Output index: `0`

## Required Flow Status

- exact payment and replay rejection: passed
- batch deposit-voucher settlement: passed
- batch voucher-only settlement: passed
- batch claim transaction construction and broadcast: passed
- replay rejection across exact and batch-settlement: passed
- batch refund transaction construction and broadcast after timeout: passed

## Mainnet Status

This report is not a mainnet readiness claim. Mainnet remains blocked by the
audit, operational, and release gates in `docs/mainnet-readiness.md`.
