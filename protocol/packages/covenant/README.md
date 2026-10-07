# @kaspa-x402/covenant

Transaction and covenant helpers for Kaspa x402 `exact` and `batch-settlement`.

Commands and repository paths below are relative to the `protocol/` workspace.

Status: release candidate. The current artifacts support testnet review and deterministic
fixture checks; they are not audited for production mainnet funds.

This package builds deterministic redeem scripts, signature-script argument
blobs, fixture checks, and transaction-v1 reference artifacts for
`kaspa-x402-escrow-v5`. The stateful KIP-20 template binds the client key,
server key, network hash, payout script-public-key hash, refund
script-public-key hash, timeout, and lifetime settled total. It does not
hold private keys, broadcast transactions, or encode wallet addresses. Address
text encoding is supplied by the caller through a Kaspa runtime codec.

Exact helpers cover standard-native transactions, KIP-10 additive heads and
head-v2 hash-chain borrow/owner paths. See the
[profile map](../../docs/native-profile-boundary.md) for their separate bindings.

The amount unit in this package is sompi.

## Transaction signature policy

Development source uses escrow-v5 and hash-chain-head-v2. Their transaction
signature checks accept the six consensus-supported sighash types. Wallets and
reference signers default to `SIGHASH_ALL`; callers choosing another type are
responsible for the fields left unsigned. Helpers derive digests and encode
witnesses using the selected type, and verifiers honor each encoded type.
Covenant payout, state, lineage, and refund guards remain mandatory.

Off-chain voucher and request signatures retain their message-signing domains.
Published RC2 uses the earlier ALL-only templates. See the
[signature policy and template transition](../../docs/versioning-policy.md#sighash-template-transition)
and [consensus vectors](../../vectors/README.md#signature-scope-consensus-evidence).

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
