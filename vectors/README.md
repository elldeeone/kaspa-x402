# Conformance Vectors

This directory will hold implementation-independent vectors for:

- x402 v2 `PaymentRequired`, `PaymentPayload`, and `SettleResponse` objects;
- `exact` native KAS transaction validation cases;
- `upto` single-use capped authorization cases;
- Kaspa channel IDs;
- voucher digest preimages and hashes;
- same-txid/different-vout replay rejection;
- wrong-network and wrong-script rejection;
- transaction v1 claim/refund hashes and compute-budget sizing.

Vectors should be consumable without importing the TypeScript SDK.
