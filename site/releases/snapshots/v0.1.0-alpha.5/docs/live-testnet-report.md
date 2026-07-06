# Live Testnet Report

Status: complete alpha.5 full live harness run.

Generated: `2026-07-06T05:30:55.575Z`

Network: `kaspa:testnet-10`

Node: private `kaspa:testnet-10` node, synced with UTXO index enabled.

Virtual DAA score at run start: `509573351`

The live proof runner validated the shipped exact and batch-settlement profiles,
including the alpha.5 exact-payment evidence shape. Hosted-gateway evidence is
tracked separately in `docs/testnet-gateway.md`. The live proof path is now
reproducible from committed code via `scripts/live-adapter-reference.mjs`, with
operator-specific RPC, wallet, SDK path, generated keys, and reports supplied
outside source control.

## Exact

- Transaction id: `6e70348a0fd09a56a4b80672428627019ab5444789b4ed64a82b5170a178d58e`
- Transaction version: `0`
- Version evidence source: `sdk-generated-transaction`
- Output index: `0`
- Amount: `100000000` sompi
- Finality: `accepted`
- Payload evidence type: `transactionId-output-index`
- Payload transaction id:
  `6e70348a0fd09a56a4b80672428627019ab5444789b4ed64a82b5170a178d58e`
- Payload payment output index: `0`
- Legacy serialized-transaction payload rejection: HTTP `402`
- Replay rejection: HTTP `409`, `invalid_transaction_state`

## Batch Deposit-Voucher

- Funding transaction id: `6ae4df3c2c41c5ede670c5e0bdfdbaf5ea7666e8bc2fe9c69b2d2beef4a48728`
- Transaction version: `0`
- Version evidence source: `sdk-generated-transaction`
- Escrow output: index `0`
- Deposit outpoint: `6ae4df3c2c41c5ede670c5e0bdfdbaf5ea7666e8bc2fe9c69b2d2beef4a48728:0`
- Escrow address: `kaspatest:prxd225xgv0y2luvf3wj5zfr9tc4nc5p2zw7s66024zyz8cnydtysg0vqvwff`
- Funding amount: `400000000` sompi
- Channel id: `753ad765bcfc3a329b95e1c3072a117598927921ab9eec2bba3cb0f0ef2cf664`
- Settlement commitment: `2a6b9791426763aa5faeabe149dd5c94e8b27b0f142880ced81deae2fa9c83ac`
- Finality: `accepted`
- Charged amount: `100000000` sompi
- Top-level settlement amount: `100000000` sompi
- Extension charged amount: `100000000` sompi
- Cumulative charge: `0` to `100000000` sompi

## Batch Voucher-Only

- Reused existing channel: yes
- Channel id: `753ad765bcfc3a329b95e1c3072a117598927921ab9eec2bba3cb0f0ef2cf664`
- Active outpoint: `6ae4df3c2c41c5ede670c5e0bdfdbaf5ea7666e8bc2fe9c69b2d2beef4a48728:0`
- Settlement commitment: `a4ee998d9b942299890206b8ba86f604aa1f13279e8d0718b9d7a1a98d3012d6`
- Charged amount: `100000000` sompi
- Top-level settlement amount: `100000000` sompi
- Extension charged amount: `100000000` sompi
- Cumulative charge: `100000000` to `200000000` sompi
- Signed maximum claimable: `200000000` sompi

## Batch Claim

- Claim transaction id: `b01f8b6426e10a4f1e80d5b3e35f43bfa1da94f6392ba2cdb63cbb0aabb58a01`
- Transaction version: `1`
- Version evidence source: `adapter-submitted-transaction-shape`
- Finality: `accepted`
- Original outpoint: `6ae4df3c2c41c5ede670c5e0bdfdbaf5ea7666e8bc2fe9c69b2d2beef4a48728:0`
- Continuation outpoint: `b01f8b6426e10a4f1e80d5b3e35f43bfa1da94f6392ba2cdb63cbb0aabb58a01:1`
- Input amount: `400000000` sompi
- Claimed cumulative amount before claim: `0` sompi
- Active charged amount: `200000000` sompi
- Claim amount: `200000000` sompi
- Server output amount: `198000000` sompi
- Claim fee: `2000000` sompi
- Continuation amount: `200000000` sompi

## Batch Replay Rejection

- Old outpoint: `6ae4df3c2c41c5ede670c5e0bdfdbaf5ea7666e8bc2fe9c69b2d2beef4a48728:0`
- Old script public key: `0000aa20ccd52a86431e457f8c4c5d2a09232af159e281509de86b4f5544411f1323564887`
- Attempted input outpoint: `b01f8b6426e10a4f1e80d5b3e35f43bfa1da94f6392ba2cdb63cbb0aabb58a01:1`
- Attempted transaction version: `1`
- Version evidence source: `adapter-submitted-transaction-shape`
- Finality: `rejected`
- Rejected: yes
- Rejection class: signature-script verification failure
- Rejection reason: `failed to verify the signature script: script ran, but verificat`
- Attempted server output: `98000000` sompi
- Attempted continuation output: `100000000` sompi

## Batch Refund

- Refund transaction id: `25570abacae2cc248b28b6593dbcb855d5ba2514fe63160e1ab157afddc45b36`
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
- exact alpha.5 transactionId evidence and legacy transaction rejection: passed
- batch deposit-voucher settlement: passed
- batch voucher-only settlement: passed
- batch claim transaction construction and broadcast: passed
- replay rejection across exact and batch-settlement: passed
- batch refund transaction construction and broadcast after timeout: passed

## Mainnet Status

This report is not a mainnet readiness claim. Mainnet remains blocked by the
audit, operational, and release gates in `docs/mainnet-readiness.md`.
