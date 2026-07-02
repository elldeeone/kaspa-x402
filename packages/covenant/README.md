# @kaspa-x402/covenant

Covenant helpers for the Kaspa x402 `batch-settlement` and `upto` bindings.

Status: alpha. The current artifacts support testnet review and deterministic
fixture checks; they are not audited for production mainnet funds.

This package builds deterministic redeem scripts, signature-script argument
blobs, fixture checks, and transaction-v1 reference artifacts for
`kaspa-x402-escrow-v1` and `kaspa-x402-upto-v1`. The templates bind the client
key, server key, network hash, payout script-public-key hash, refund
script-public-key hash, and their timeout or authorization terms. They do not
hold private keys, broadcast transactions, or encode wallet addresses. Address
text encoding is supplied by the caller through a Kaspa runtime codec.

The amount unit in this package is sompi.

## Transaction V1 Artifacts

The batch claim and refund builders reproduce the frozen vectors in
`vectors/tx-v1/`. The `upto` helpers expose the deterministic authorization
template, script arguments, digest preimage, output-plan validation, compute
budget, and script-unit estimates. They expose transaction id, full transaction
hash, sighash debug data, fee accounting, continuation metadata, compute
budget, and script-unit estimates for the batch transaction vectors.

`serializedTransaction` in these artifacts is the Rust-style transaction hash
preimage/projection used for deterministic vectors. It is not a submit-ready
RPC transaction payload; native chain adapters must construct and sign the
runtime transaction object from the same fields. The committed `mass` value is
contextual storage mass, while `estimatedSerializedSize` is reported only for
size/mass diagnostics.

The vectors follow current Toccata pricing:

- claim estimate `200544` script units, `computeBudget: 20`;
- escrow refund estimate `100000` script units, `computeBudget: 10`;
- upto settlement estimate `260000` script units, `computeBudget: 26`;
- upto refund estimate `100000` script units, `computeBudget: 10`.

Regenerate transaction vectors after intentional builder changes:

```sh
npm run vectors:tx-v1
```

Check covenant fixture reproducibility:

```sh
npm run check:covenant-fixtures
```
