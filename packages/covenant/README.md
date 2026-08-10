# @kaspa-x402/covenant

Covenant helpers for the Kaspa x402 `batch-settlement` binding.

Status: alpha. The current artifacts support testnet review and deterministic
fixture checks; they are not audited for production mainnet funds.

This package builds deterministic redeem scripts, signature-script argument
blobs, fixture checks, and transaction-v1 reference artifacts for
`kaspa-x402-escrow-v2`. The stateful KIP-20 template binds the client key,
server key, network hash, payout script-public-key hash, refund
script-public-key hash, timeout, and lifetime settled total. It does not
hold private keys, broadcast transactions, or encode wallet addresses. Address
text encoding is supplied by the caller through a Kaspa runtime codec.

The amount unit in this package is sompi.

## Transaction V1 Artifacts

The batch genesis, partial-claim, top-up, and refund builders reproduce the
vectors in `vectors/tx-v1/`. They expose transaction id, full transaction hash,
sighash debug data, covenant identity and successor metadata, fee accounting,
compute budget, and script-unit evidence.

`serializedTransaction` in these artifacts is the Rust-style transaction hash
preimage/projection used for deterministic vectors. It is not a submit-ready
RPC transaction payload; native chain adapters must construct and sign the
runtime transaction object from the same fields. The committed `mass` value is
contextual storage mass, while `estimatedSerializedSize` is reported only for
size/mass diagnostics.

Compute budgets are explicit builder inputs and are pinned only from the
current Rusty Kaspa full-consensus validation harness; earlier estimates are
not reused.

Regenerate transaction vectors after intentional builder changes:

```sh
npm run vectors:tx-v1
```

Check covenant fixture reproducibility:

```sh
npm run check:covenant-fixtures
```
