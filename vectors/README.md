# Conformance Vectors

This directory holds implementation-independent vectors for:

- x402 v2 `PaymentRequired`, `PaymentPayload`, and `SettlementResponse` objects;
- `exact` native KAS transaction validation cases;
- `upto` single-use capped authorization cases;
- Kaspa channel IDs;
- voucher digest preimages and hashes;
- same-txid/different-vout replay rejection;
- wrong-network and wrong-script rejection;
- transaction v1 claim/refund hashes and compute-budget sizing.

Vectors should be consumable without importing the TypeScript SDK.

## Layout

```text
vectors/
  voucher/              Voucher preimages and digests.
  channel-id/           Channel ID canonical input and digest fixtures.
  x402-http/            HTTP header base64 fixtures.
  settlement-response/  SettlementResponse success, failure, and corrective fixtures.
  negative/             Schema and semantic rejection fixtures.
  tx-v1/                Transaction v1 plan plus batch claim/refund fixtures.
```

## Vector Kinds

Every JSON vector has a `kind` field:

- `voucher-digest`: recompute each voucher preimage and digest.
- `channel-id`: recompute the canonical channel ID preimage and digest.
- `x402-http`: validate decoded objects and recompute the three HTTP headers.
- `settlement-response`: validate settlement responses and corrective 402 payloads.
- `negative`: assert a JSON object fails the referenced schema and carries an `expectedError`.
- `semantic-negative`: assert cross-object protocol failures that JSON Schema cannot express.
- `tx-v1-plan`: enumerate required future transaction v1 fixtures.
- `tx-v1-batch-claim`: reproduce the batch claim transaction-v1 reference artifact.
- `tx-v1-batch-refund`: reproduce the batch refund transaction-v1 reference artifact.

For transaction-v1 vectors, `serializedTransaction` is the deterministic
transaction hash preimage/projection used by the vector. It is not a
submit-ready RPC transaction payload. The committed `mass` value is contextual
storage mass; `estimatedSerializedSize` is diagnostic only.

HTTP vectors use deterministic JSON encoding with object keys sorted lexicographically before base64 encoding. That makes the vectors stable across languages without depending on JavaScript insertion order.

Amounts are decimal strings in sompi. Hex byte strings are even-length lowercase in the fixtures, but validators should accept uppercase hex unless a future profile explicitly narrows this.
