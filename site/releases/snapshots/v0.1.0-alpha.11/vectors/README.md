# Conformance Vectors

This directory holds implementation-independent vectors for:

- x402 v2 `PaymentRequired`, `PaymentPayload`, and `SettlementResponse` objects;
- `exact` native KAS transaction validation cases;
- Kaspa channel IDs;
- voucher digest preimages and hashes;
- stable KIP-20 covenant-lineage binding and unbound-sentinel rejection;
- current-head synchronization without outpoint-local voucher signatures;
- transaction v1 singleton-genesis, repeated partial-claim, top-up, and refund
  hashes and compute-budget sizing.

Vectors should be consumable without importing the TypeScript SDK.

Alpha.11 also publishes the normative batch covenant source at
`contracts/kaspa-x402-escrow-v3.sil` and its language-neutral constructor and
byte fixture at `contracts/fixtures/kaspa-x402-escrow-v3.json`. Together with
this directory, those artifacts are sufficient to reconstruct and verify the
batch-v2 contract without importing the TypeScript SDK.

## Layout

```text
vectors/
  voucher/              Voucher preimages and digests.
  channel-id/           Channel ID canonical input and digest fixtures.
  batch/                Alpha.11 non-transaction batch interoperability evidence.
  x402-http/            HTTP header base64 fixtures.
  settlement-response/  SettlementResponse success, failure, and corrective fixtures.
  negative/             Schema and semantic rejection fixtures.
  tx-v1/                Full Alpha.11 batch transaction-v1 lifecycle fixtures.
  exact/                Full-consensus standard-native and additive exact fixtures.
```

## Vector Kinds

Every JSON vector has a `kind` field:

- `voucher-digest`: recompute each voucher preimage and digest.
- `channel-id`: recompute the canonical channel ID preimage and digest.
- `batch-interop-v2`: reconstruct the Alpha.11 channel, KIP-20 lineage id,
  voucher, request commitment, lifetime accounting, DAA expiry boundaries,
  and finality ordering. Transaction evidence remains in `tx-v1/`.
- `x402-http`: validate decoded objects and recompute the three HTTP headers. The
  exact-transaction fixture is also verified against the hosted verifier and the
  pinned rusty-kaspa consensus harness so its KIP-10 script and transaction shape
  remain semantic, not merely schema-valid.
- `settlement-response`: validate settlement responses and corrective 402 payloads.
- `negative`: assert a JSON object fails the referenced schema and carries an `expectedError`.
- `semantic-negative`: assert cross-object protocol failures that JSON Schema cannot express.
- `tx-v1-plan`: enumerate implemented transaction v1 fixtures.
- `tx-v1-batch-genesis`: reproduce the singleton KIP-20 genesis transaction.
- `tx-v1-batch-claim`: reproduce the batch claim transaction-v1 reference artifact.
- `tx-v1-batch-top-up`: reproduce the same-covenant-ID top-up reference artifact.
- `tx-v1-batch-refund`: reproduce the batch refund transaction-v1 reference artifact.
- `exact-consensus-profiles`: reproduce deterministic standard-native v0 and
  corrected KIP-10 additive v1 transactions, then validate them and their
  mutations through Rusty Kaspa's isolation and populated-UTXO consensus paths.
- `exact-interop-v1`: reproduce both transaction identifiers from explicit
  consensus-hash preimages, the canonical payment-requirements and request-
  authorization SHA-256 preimages, the payer signature, expiry decisions, and
  finality ordering without depending on TypeScript.

Regenerate the exact consensus vector with `npm run vectors:exact-consensus`.
The generator uses fixed public test keys and deterministic Schnorr signatures;
it contains no wallet or deployment secret.

Regenerate the Alpha.11 channel, voucher, HTTP, and batch core vectors with
`npm run vectors:batch-interop`. The generator derives `covenantId` from its
canonical KIP-20 genesis input and ordered authorized output; it does not treat
that derivation input as accepted transaction evidence.

For transaction-v1 vectors, `serializedTransaction` is the deterministic
transaction hash preimage/projection used by the vector. It is not a
submit-ready RPC transaction payload. The committed `mass` value is contextual
storage mass; `estimatedSerializedSize` is diagnostic only.

HTTP vectors use deterministic JSON encoding with object keys sorted lexicographically before base64 encoding. That makes the vectors stable across languages without depending on JavaScript insertion order.

Amounts are decimal strings in sompi. Hex byte strings are even-length lowercase in the fixtures, but validators should accept uppercase hex unless a future profile explicitly narrows this.
