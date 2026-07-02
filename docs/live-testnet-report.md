# Live Testnet Report

Generated from a successful `kaspa:testnet-10` run on 2026-07-02 at 01:20:01 UTC.

The live run used an explicit testnet RPC endpoint, an operator-provided testnet funding wallet, and a local adapter module. Private keys, recovery material, and the full machine-local report remain in `.kaspa-x402-live/`, which is ignored by git.

## Summary

- Status: complete
- Network: `kaspa:testnet-10`
- Node network id: `testnet-10`
- Finality target: `accepted`
- Refund timeout: `505970085` DAA

## Exact

- Amount: `100000000` sompi
- Transaction: `24f7877ed3ea1b567e41eb6c1dcdd978fd1fc3a71fb928d41064294ff85d12f6`
- Payment output index: `0`
- Finality: `accepted`
- Replay result: `409 exact_payment_replay`

## Upto

- Zero-charge authorization outpoint: `21d4f3b03f395ef09a99cb706a19ede5f6f00f351ddf044e7a69a65885cc7101:0`
- Zero-charge maximum: `100000000` sompi
- Zero-charge settlement transaction: empty, as expected
- Nonzero authorization outpoint: `61c89b538a28f8551776cb86aa8a6d1f57d5dc72a093cf37bc8b883d0d010b16:0`
- Nonzero maximum: `100000000` sompi
- Nonzero charged amount: `50000000` sompi
- Nonzero settlement transaction: `da0204bf2eaf446c2e3d8e0811b55e6e84b5b27e46f76037f2fb5c273ed3e66c`
- Payment output index: `0`
- Replay result: `409 upto_authorization_replay`

## Batch Settlement

- Escrow address: `kaspatest:pqhsn5c885ey2kk7vf4edxp75upwg7j9dz6wgq2zw5vugd2ayghnjqmqtwxpc`
- Channel id: `624cb527461ff3e5589045da488438612ef88917d05bb17c56bcf5e96a038cde`
- Deposit outpoint: `3ed0f55358a3a34e44fc2d2fa209bd62854c4326b8c28af37f9438333395ffb2:0`
- Deposit amount: `400000000` sompi
- First voucher digest for `100000000` sompi is `9791b7281426d56b2810e55fcb58ada04feaa99b0c38fa44a85049ff2b11a0b8`
- Latest voucher digest for `200000000` sompi is `e12c9c747b214ba3fdc144e0a8563ba5f6be938bd0a0c3d4f539566e9f13a2fe`
- Voucher-only request opened a second channel: `false`
- Charged cumulative amount after voucher-only request: `200000000` sompi
- Claim transaction: `fc93d9f1e346a1baa4eec5ce55bbe4efa7d7e1db21dd92759ea194e6ad6acf4c`
- Continuation outpoint: `fc93d9f1e346a1baa4eec5ce55bbe4efa7d7e1db21dd92759ea194e6ad6acf4c:1`
- Continuation amount: `200000000` sompi
- Replay result: rejected by node script verification
- Replay validation: the attempted replay spent `fc93d9f1e346a1baa4eec5ce55bbe4efa7d7e1db21dd92759ea194e6ad6acf4c:1` with `98000000` sompi to the server and `100000000` sompi to the continuation; the node rejection reason included `failed to verify the signature script`
- Refund transaction: `65ff739129e341b1657bc3f555e75a1cc3dd8514a6100dd6ade87a9c3d088b1d`
- Refund amount: `198000000` sompi

## Caveats

- This is testnet evidence only.
- The live adapter is intentionally external to the public package boundary for this run.
- Failed exploratory runs before this final report may have produced additional testnet transactions not listed here.
