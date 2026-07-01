# @kaspa-x402/covenant

Escrow covenant helpers for the Kaspa x402 `batch-settlement` binding.

This package builds deterministic redeem scripts, signature-script argument
blobs, and transaction-v1 reference artifacts for `kaspa-x402-escrow-v1`. The
redeem script binds the client key, server key, network hash, payout
script-public-key hash, refund script-public-key hash, and timeout. It does
not hold private keys, broadcast transactions, or encode wallet addresses.
Address text encoding is supplied by the caller through a Kaspa runtime codec.

The amount unit in this package is sompi.

## Transaction V1 Artifacts

The batch claim and refund builders reproduce the frozen vectors in
`vectors/tx-v1/`. They expose transaction id, full transaction hash, sighash
debug data, fee accounting, continuation metadata, compute budget, and
script-unit estimates.

`serializedTransaction` in these artifacts is the Rust-style transaction hash
preimage/projection used for deterministic vectors. It is not a submit-ready
RPC transaction payload; native chain adapters must construct and sign the
runtime transaction object from the same fields. The committed `mass` value is
contextual storage mass, while `estimatedSerializedSize` is reported only for
size/mass diagnostics.

The vectors follow current Toccata pricing:

- claim estimate `200544` script units, `computeBudget: 20`;
- refund estimate `100000` script units, `computeBudget: 10`.

Regenerate transaction vectors after intentional builder changes:

```sh
npm run vectors:tx-v1
```

Check covenant fixture reproducibility:

```sh
npm run check:covenant-fixtures
```
