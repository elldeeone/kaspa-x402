# Live Testnet Report

Status: current alpha.6 full live harness run.

Generated: `2026-07-09T01:52:34.497Z`

Network: `kaspa:testnet-10`

Node: private `kaspa:testnet-10` node, synced with UTXO index enabled.

Virtual DAA score at run start: `512033363`

The 2026-07-09 live proof runner validated the preferred alpha.6 KIP-10
`exact-transaction` payload shape, the `10000000` sompi additive-threshold
floor, and the batch-settlement covenant lifecycle. Hosted-gateway evidence is
tracked separately in `docs/testnet-gateway.md`.

## Exact KIP-10 Transaction

- Transaction id: `8339c688683f3d472e146b095d3aecc720d78ca01f26ec69436ae6d0655b7738`
- Transaction version: `1`
- Version evidence source: `adapter-submitted-transaction-shape`
- Output index: `1`
- Amount: `100000000` sompi
- Finality: `accepted`
- Payload evidence type: `kip10-exact-transaction`
- Transaction encoding: `kaspa-sdk-safe-json-v2.0.0`
- Reservation id: `90984c654bd8cce0c2c47bb9939bcf5351e98cf2ee68b5bb61404da80193c119`
- Borrow outpoint:
  `739a5a5ff3928b6db8d1a0fc65b75a0ce9a9c343bef3f7cef80d89302517e68f:0`
- Additive threshold: `10000000` sompi
- Transaction artifact SHA-256:
  `d496f11501d203af08a0b8ffd475b1ae1eea64256ebb99483b2e99dc43ea4d0a`
- Payload payment output index: `1`
- Server broadcast transaction id:
  `8339c688683f3d472e146b095d3aecc720d78ca01f26ec69436ae6d0655b7738`
- Server broadcast finality: `accepted`
- Replay rejection: HTTP `409`, `invalid_transaction_state`

## Batch Deposit-Voucher

- Funding transaction id: `6f06e7f40f466959f08ab93d176dd5d463ce1f1f7e270e6a1ee71ca3b3938868`
- Transaction version: `0`
- Version evidence source: `sdk-generated-transaction`
- Escrow output: index `0`
- Deposit outpoint: `6f06e7f40f466959f08ab93d176dd5d463ce1f1f7e270e6a1ee71ca3b3938868:0`
- Escrow address: `kaspatest:pz7prpc3hk3e7y3t8dk7hcjq4xjnsffq03w2e553eh7xh03yaenxukthx0f20`
- Funding amount: `400000000` sompi
- Channel id: `b7394746555fd09d53d4a975354ad3394affb6983412cd14d685f44a7c706ed2`
- Settlement commitment: `b79452478e8a218e7e132bc7e292e12c5ede24abb79db0724488f5da628484fd`
- Finality: `accepted`
- Charged amount: `100000000` sompi
- Top-level settlement amount: `100000000` sompi
- Extension charged amount: `100000000` sompi
- Cumulative charge: `0` to `100000000` sompi

## Batch Voucher-Only

- Reused existing channel: yes
- Channel id: `b7394746555fd09d53d4a975354ad3394affb6983412cd14d685f44a7c706ed2`
- Active outpoint: `6f06e7f40f466959f08ab93d176dd5d463ce1f1f7e270e6a1ee71ca3b3938868:0`
- Settlement commitment: `b068ef7cb9202e9f7551c6fd0a69793458f457f2bcabb118bdd98c7c5a7258dc`
- Charged amount: `100000000` sompi
- Top-level settlement amount: `100000000` sompi
- Extension charged amount: `100000000` sompi
- Cumulative charge: `100000000` to `200000000` sompi
- Signed maximum claimable: `200000000` sompi

## Batch Claim

- Claim transaction id: `d1437aa76b583721e2531d98eecfd8bcc37492d45baf83347ffb1cc66f0f7bf4`
- Transaction version: `1`
- Version evidence source: `adapter-submitted-transaction-shape`
- Finality: `accepted`
- Original outpoint: `6f06e7f40f466959f08ab93d176dd5d463ce1f1f7e270e6a1ee71ca3b3938868:0`
- Continuation outpoint: `d1437aa76b583721e2531d98eecfd8bcc37492d45baf83347ffb1cc66f0f7bf4:1`
- Input amount: `400000000` sompi
- Claimed cumulative amount before claim: `0` sompi
- Active charged amount: `200000000` sompi
- Claim amount: `200000000` sompi
- Server output amount: `198000000` sompi
- Claim fee: `2000000` sompi
- Continuation amount: `200000000` sompi

## Batch Replay Rejection

- Old outpoint: `6f06e7f40f466959f08ab93d176dd5d463ce1f1f7e270e6a1ee71ca3b3938868:0`
- Old script public key: `0000aa20bc118711bda39f122b3b6debe240a9a53825207c5cacd291cdfc6bbe24ee666e87`
- Attempted input outpoint: `d1437aa76b583721e2531d98eecfd8bcc37492d45baf83347ffb1cc66f0f7bf4:1`
- Attempted transaction version: `1`
- Version evidence source: `adapter-submitted-transaction-shape`
- Finality: `rejected`
- Rejected: yes
- Rejection class: signature-script verification failure
- Rejection reason: `failed to verify the signature script: script ran, but verificat`
- Attempted server output: `98000000` sompi
- Attempted continuation output: `100000000` sompi

## Batch Refund

- Refund transaction id: `9688335e6a9b7f3a001beeb0d05925ea412324862c1b61049d46c353ddbf4cda`
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
