# Live Testnet Report

Generated from a successful `kaspa:testnet-10` run on 2026-07-02 at 07:25:56 UTC.

The live run used an explicit testnet RPC endpoint, an operator-provided testnet funding wallet, and a local adapter module. Private keys, recovery material, and the full machine-local report remain in `.kaspa-x402-live/`, which is ignored by git.

## Summary

- Status: complete
- Network: `kaspa:testnet-10`
- Node network id: `testnet-10`
- Finality target: `accepted`
- Refund timeout: `506189090` DAA

## Exact

- Amount: `100000000` sompi
- Transaction: `e717d43ad6d3c1b06fab2dcf2ac4e55d432b20fb46f0d1c64a813622f30d1043`
- Transaction version: `0` (source: sdk-generated-transaction)
- Payment output index: `0`
- Finality: `accepted`
- Replay result: `409 invalid_transaction_state`
- Validation scope: application-store replay rejection plus exact output/finality verification.

## Upto

- Zero-charge authorization outpoint: `28202613b2486195c2640d7c12c05b87881d8986af8436e4d65d5288b904435d:0`
- Zero-charge authorization transaction version: `0` (source: sdk-generated-transaction)
- Zero-charge maximum: `100000000` sompi
- Zero-charge settlement transaction: empty, as expected
- Zero-charge settlement transaction version: none (no transaction)
- Nonzero authorization outpoint: `865215d9ab6cbb03a5b6ed28925dbea33d1754d41eede12eae3c79151f0e92f8:0`
- Nonzero authorization transaction version: `0` (source: sdk-generated-transaction)
- Nonzero maximum: `100000000` sompi
- Nonzero charged amount: `50000000` sompi
- Nonzero settlement transaction: `db4df3ceb7c1af6966c3dd9dc26321d0306ce1b71d33e8690b24e14a588cc933`
- Nonzero settlement transaction version: `1` (source: adapter-submitted-transaction-shape)
- Payment output index: `0`
- Replay result: `409 invalid_transaction_state`
- Validation scope: adapter-submitted transaction-v1 shape for the nonzero settlement, node acceptance of that submitted transaction, output/refund accounting verification, and application-store replay rejection. The zero-charge path intentionally has no transaction.

## Batch Settlement

- Escrow address: `kaspatest:pz69jle2zkhpaqj6uxg8n8ye0z2ltqs48wcwwx3fpagqep6rrjdlydz7kt4l4`
- Channel id: `50681f06a1383e9a25a0ae6ac83dd8901ce847873837a29154c16dfc791685cc`
- Deposit transaction: `81109d56f2ae5f1210a4d8a27bd0aaa5d866773b0f968b7f51988c18361f6c94`
- Deposit transaction version: `0` (source: sdk-generated-transaction)
- Deposit outpoint: `81109d56f2ae5f1210a4d8a27bd0aaa5d866773b0f968b7f51988c18361f6c94:0`
- Deposit amount: `400000000` sompi
- First settlement commitment: `979d4797d4b469da1623b07d51ad06a6fc75c9f62725330d725350b991e7940d`
- Latest settlement commitment: `2908bf22028205be8f2888ae251fb694d37b83432263afebdfb74d7e77a9b847`
- Voucher-only request opened a second channel: `false`
- Charged cumulative amount after voucher-only request: `200000000` sompi
- Claim transaction: `96903251646ac55b5b2a9ddd587f762afbadf2599dcf0763d249e906d8bf373b`
- Claim transaction version: `1` (source: adapter-submitted-transaction-shape)
- Continuation outpoint: `96903251646ac55b5b2a9ddd587f762afbadf2599dcf0763d249e906d8bf373b:1`
- Continuation amount: `200000000` sompi
- Replay result: rejected by node script verification
- Replay attempted transaction version: `1` (source: adapter-submitted-transaction-shape)
- Replay validation: the attempted replay spent `96903251646ac55b5b2a9ddd587f762afbadf2599dcf0763d249e906d8bf373b:1` with `98000000` sompi to the server and `100000000` sompi to the continuation; the node rejection reason included `failed to verify the signature script`
- Refund transaction: `7dad095da86176f0c26b2d9bfe9491266a728b571b3164ccb22ae8e4b467d7a6`
- Refund transaction version: `1` (source: adapter-submitted-transaction-shape)
- Refund amount: `198000000` sompi
- Validation scope: script-level covenant validation for claim, replay rejection, and refund; adapter-submitted transaction-v1 shapes plus node acceptance/rejection for claim/replay attempt/refund; application-store validation for channel state and voucher replay handling.

## Caveats

- This is testnet evidence only.
- The live adapter is intentionally external to the public package boundary for this run.
- Failed exploratory runs before this final report may have produced additional testnet transactions not listed here.
