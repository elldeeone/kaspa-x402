# Live Covenant Proof Harness

The live proof harness must be a separate, opt-in executable. It must default to
`kaspa:testnet-10`, write a recovery file before submitting each transaction,
and never require a hosted facilitator.

## Required Flow

1. Generate or load client and server channel keys.
2. Build the `kaspa-x402-escrow-v1` redeem script and escrow address.
3. Fund the escrow address from the configured funding source.
4. Wait for the escrow outpoint and persist it in the recovery file.
5. Serve at least two paid requests and record the cumulative voucher ceiling.
6. Submit a claim using the latest voucher.
7. Wait for the continuation outpoint.
8. Attempt replay with the previous voucher against the continuation outpoint and record consensus rejection.
9. Wait until timeout DAA and submit a refund for any remaining value.
10. Persist transaction ids, outpoints, script public keys, voucher digests, and final balances.

## Recovery File

The recovery file must contain:

- network;
- template id;
- client public key;
- server public key;
- refund timeout DAA score;
- escrow address;
- active outpoint;
- active script public key;
- funding amount in sompi;
- latest signed cumulative voucher amount in sompi;
- latest voucher signature;
- submitted transaction ids;
- whether the replay attempt was rejected.

## Safety Gates

- Refuse to run on mainnet unless an explicit `--mainnet` flag is present.
- Refuse to claim more than the latest voucher amount.
- Refuse to claim when the continuation output would be below `inputAmount - voucherAmount`.
- Refuse to publish if the script public key differs from the fixture-derived value.
- Refuse to run if a recovery file exists and the operator has not chosen resume or reset.
