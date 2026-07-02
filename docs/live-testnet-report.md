# Live Testnet Report

Generated from a successful `kaspa:testnet-10` run on 2026-07-02 at 04:56:23 UTC.

The live run used an explicit testnet RPC endpoint, an operator-provided testnet funding wallet, and a local adapter module. Private keys, recovery material, and the full machine-local report remain in `.kaspa-x402-live/`, which is ignored by git.

## Summary

- Status: complete
- Network: `kaspa:testnet-10`
- Node network id: `testnet-10`
- Finality target: `accepted`
- Refund timeout: `506098319` DAA

## Exact

- Amount: `100000000` sompi
- Transaction: `29dbc10a6cc4de21a51a639e7e2156ce6ee3d132f125d4e3d1bd3c745d46f75f`
- Payment output index: `0`
- Finality: `accepted`
- Replay result: `409 invalid_transaction_state`

## Upto

- Zero-charge authorization outpoint: `bb06a0d33b5b3119ae129947c1b2534f905864deab4c3b9c8678ae3b23f1b548:0`
- Zero-charge maximum: `100000000` sompi
- Zero-charge settlement transaction: empty, as expected
- Nonzero authorization outpoint: `3710cb09e4e91a68897ac962672d381a5b633bbcb031a565ace0278620a0691a:0`
- Nonzero maximum: `100000000` sompi
- Nonzero charged amount: `50000000` sompi
- Nonzero settlement transaction: `e46b454a14838d44bee1bc33c78647f2f83956ad96d2776918451412acda5947`
- Payment output index: `0`
- Replay result: `409 invalid_transaction_state`

## Batch Settlement

- Escrow address: `kaspatest:pzkjwllhjpk4x2ky0w3yvzycepv5029rfqpdx8atlqmrr4hlv7x7vwh2erpw8`
- Channel id: `1351b7d95cfd8556e1b65c090f59e271e7289605a8bb7f7896296eb67068ba6b`
- Deposit outpoint: `6fd6ecbf7583f9848b6899e4e8b315cae6bedb416820d34d583e534aaf174c3c:0`
- Deposit amount: `400000000` sompi
- First settlement commitment: `ea5c9294115f0f8bdae55ec42e1a2c4e4a21316cf5fc236379d2b26649f47dc7`
- Latest settlement commitment: `4b1c163f4987b5bcdfd45aae547768e6c91e42d76d9b11bb752d315c5943b41f`
- Voucher-only request opened a second channel: `false`
- Charged cumulative amount after voucher-only request: `200000000` sompi
- Claim transaction: `cc1633df26558510013c822e2988b1c74ed7c7f9a05bd9229122957138e490ed`
- Continuation outpoint: `cc1633df26558510013c822e2988b1c74ed7c7f9a05bd9229122957138e490ed:1`
- Continuation amount: `200000000` sompi
- Replay result: rejected by node script verification
- Replay validation: the attempted replay spent `cc1633df26558510013c822e2988b1c74ed7c7f9a05bd9229122957138e490ed:1` with `98000000` sompi to the server and `100000000` sompi to the continuation; the node rejection reason included `failed to verify the signature script`
- Refund transaction: `4dde8a9a7501c460b5dedabbbfe4ee74c23b2e9e8389a13fe9eb2917e4e621f8`
- Refund amount: `198000000` sompi

## Caveats

- This is testnet evidence only.
- The live adapter is intentionally external to the public package boundary for this run.
- Failed exploratory runs before this final report may have produced additional testnet transactions not listed here.
