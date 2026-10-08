# Versioning Policy

Status: development policy after the published RC2 release. This file describes how changes
are labeled before the stable `1.0.0` release.

## Spec Versions

The umbrella Kaspa x402 proposal is `v1`; bindings, signed domains, and
covenant templates are versioned independently. Breaking changes must update
the affected identifiers, schemas, vectors, packages, and docs together.

The development surface uses `kaspa-exact-v2`,
`kaspa-escrow-v3`, and `kaspa-x402-escrow-v5`, plus
`kaspa-hash-chain-exact-v1` and `kaspa-x402-hash-chain-head-v2`. These templates
are unpublished development changes after RC2. The escrow covenant was
compiled with
SilverScript v1.0.0 commit `3ed973335b59269293564805cc2c58a14595ec03`
(the portable artifact reports compiler version `0.1.0`). It uses explicit DAA
lock semantics and four-byte KCC-01 dispatch tags.

This is a clean RC state model. Current runtimes do not accept or migrate
pre-RC batch bindings or channel state.

## Package Versions

The current packages use a SemVer release candidate for the intended stable
`1.0.0` release:

```text
1.0.0-rc.N
```

Rules:

- increment `N` for each release-candidate publish;
- keep internal package dependency versions exact;
- publish release-candidate packages with the `rc` dist-tag;
- do not move `latest` until the stable `1.0.0` release is approved;
- never overwrite a version already published to npm or GitHub.

## Template IDs

Template IDs identify covenant families. The current template ids are:

```text
kaspa-x402-escrow-v5
kaspa-x402-kip10-additive-v1
kaspa-x402-hash-chain-head-v2
```

Change the template id when the script source, argument layout, successor-output
rules, hash commitments, or claim/refund semantics change in a way that makes
old and new channel states incompatible.

## Domain Tags

Domain tags version signed preimages and hash scopes. Changing a preimage layout
or signed meaning requires a new domain tag.

Current examples include:

```text
kaspa:x402:escrow-voucher:v3
kaspa:x402:channel:v2
kaspa-x402-exact-request-authorization-v2
```

Exact request authorization uses the v2 domain because its signed preimage
includes the payment identifier. Current validators accept v2 only; v1
authorizations must be recreated under the current format.

## Vector Sets

Vectors are part of the compatibility surface. Any change to canonical JSON,
header bytes, digest preimages, transaction ids, sighashes, transaction hashes,
compute-budget assumptions, or stable error identifiers must update the related
vectors in the same change.

## Network Strings

The supported network strings are:

```text
kaspa:testnet-10
kaspa:mainnet
```

`kaspa:mainnet` is a reserved profile name in the draft spec. It is not a
readiness claim.

## Sighash template transition

Published RC2 uses escrow-v4 and hash-chain-head-v1. The new escrow-v5 and
hash-chain-head-v2 templates accept every consensus-supported transaction
sighash type. Reference wallets and signers continue to default to
`SIGHASH_ALL`; choosing another scope is a signer decision. The covenant
validates signatures and independently enforces its spend-path guards.
Verifiers use the sighash byte encoded in each signature and reject invalid
flags, rather than assuming ALL or applying an ALL-only covenant policy.

The supported flags are:

| Scope | Flag | Output commitment |
| --- | --- | --- |
| `ALL` | `0x01` | All outputs. |
| `NONE` | `0x02` | No outputs. |
| `SINGLE` | `0x04` | The output at the signed input's index, if present. |
| `ALL + ANYONECANPAY` | `0x81` | All outputs. |
| `NONE + ANYONECANPAY` | `0x82` | No outputs. |
| `SINGLE + ANYONECANPAY` | `0x84` | The output at the signed input's index, if present. |

`ANYONECANPAY` omits the commitment to other input outpoints. Exact input,
sequence, and transaction-field commitments follow Kaspa consensus rules;
ALL does not mean every serialized field is signed. In particular, the
transaction-v1 sighash does not commit to mass or compute budgets. A signature
may remain valid after changes outside its chosen scope. Signers must consider
which constraints are supplied by other signatures and covenant guards before
choosing a weaker scope. Validity alone does not establish that the choice is
appropriate for a wallet workflow.

This policy applies to transaction signatures on borrow, owner rotation,
owner sweep, claim, top-up, and refund paths. Off-chain voucher, presentation,
and request-authorization signatures have no transaction sighash byte. The
sighash template transition does not change those message domains; the exact
request-authorization domain has the separate v2 cutover described above.
Exact-payment checks, payout destinations,
voucher ceilings, singleton lineage, successor state, and refund guards remain
mandatory regardless of the transaction signature scope.

Existing heads and channels retain their original scripts and
cannot switch templates in a state transition. Sweep and recreate hash-chain
heads; settle/refund existing batch channels and open new channels. Retain an
RC2 runtime for outstanding RC2 channels during operator cutover. The sighash
template transition leaves bindings and off-chain signed domains unchanged;
template IDs identify the changed on-chain programs. These source changes are
not a new published release or a
deployed migration. Local consensus coverage is documented in the
[conformance vectors](../vectors/README.md); published RC2 funded and hosted
proof does not establish live validation of these replacement templates.
