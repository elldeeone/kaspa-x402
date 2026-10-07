# Conformance Vectors

Commands and repository paths below are relative to the `protocol/` workspace.

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

The development checkout includes the normative batch covenant source at
`contracts/kaspa-x402-escrow-v5.sil` and its language-neutral constructor and
byte fixture at `contracts/fixtures/kaspa-x402-escrow-v5.json`. Together with
this directory, those artifacts are sufficient to reconstruct and verify the
batch-v3 contract without importing the TypeScript SDK.

These artifacts use escrow-v5 and hash-chain-head-v2. Published RC2 used
escrow-v4 and head-v1; its funded proof applies to those original scripts.
See the [signature policy and template transition](../docs/versioning-policy.md#sighash-template-transition).

## Layout

```text
vectors/
  voucher/              Voucher preimages and digests.
  channel-id/           Channel ID canonical input and digest fixtures.
  batch/                Current non-transaction batch interoperability evidence.
  x402-http/            HTTP header base64 fixtures.
  settlement-response/  SettlementResponse success, failure, and corrective fixtures.
  negative/             Schema and semantic rejection fixtures.
  tx-v1/                Current batch transaction-v1 lifecycle fixtures.
  exact/                Full-consensus standard-native and additive exact fixtures.
  hash-chain/           Head-v2 borrow, owner paths, and signature-scope evidence.
  sighash/              Consensus signature-scope and mixed top-up evidence.
```

## Vector Kinds

Every JSON vector has a `kind` field:

- `voucher-digest`: recompute each voucher preimage and digest.
- `channel-id`: recompute the canonical channel ID preimage and digest.
- `batch-interop-v3`: reconstruct the current channel, KIP-20 lineage id,
  v3 voucher, request presentation and commitment, fixed-charge accounting,
  DAA expiry boundaries, and finality ordering. Transaction evidence remains
  in `tx-v1/`.
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
- `kaspa-sighash-consensus-v1`: reproduce all six supported transaction
  sighash types for batch lifecycle and native-v0 transactions, including
  SINGLE without a corresponding output and mixed client/provider top-up
  scopes. Funding signatures in the mixed top-up cases remain ALL.

## Signature-scope consensus evidence

`sighash/consensus.json` records full-consensus acceptance and per-input digests
from the pinned Rusty-Kaspa oracle. `hash-chain/consensus-v1.json` separately
records all head/funding scope combinations, owner rotation and sweep for all
six types, and rejection of invalid flags and changed flags without re-signing.
The covenant tests compare TypeScript digests with the independent oracle and
check which input/output changes preserve or invalidate each scope.

Generate or check the signature-scope vector with:

```sh
npm run vectors:sighash-consensus
npm run check:sighash-consensus-vector
```

These commands require Rust and a clean Rusty-Kaspa checkout at the vector's
`source.commit`; set `KASPA_X402_KASPA_CONSENSUS_ROOT` to that checkout.
This is local consensus evidence, not a fresh funded Testnet-10 run or hosted
deployment proof for the replacement templates.

## Regeneration and encoding

Regenerate the exact consensus vector with `npm run vectors:exact-consensus`.
The generator uses fixed public test keys and deterministic Schnorr signatures;
it contains no wallet or deployment secret.

Regenerate the current channel, voucher, HTTP, and batch core vectors with
`npm run vectors:batch-interop`. The generator derives `covenantId` from its
canonical KIP-20 genesis input and ordered authorized output; it does not treat
that derivation input as accepted transaction evidence.

For transaction-v1 vectors, `serializedTransaction` is the deterministic
transaction hash preimage/projection used by the vector. It is not a
submit-ready RPC transaction payload. The committed `mass` value is contextual
storage mass; `estimatedSerializedSize` is diagnostic only.

HTTP vectors use deterministic JSON encoding with object keys sorted lexicographically before base64 encoding. That makes the vectors stable across languages without depending on JavaScript insertion order.

Amounts are decimal strings in sompi. Hex byte strings are even-length lowercase in the fixtures, but validators should accept uppercase hex unless a future profile explicitly narrows this.
