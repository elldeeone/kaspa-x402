# Versioning Policy

Status: release-candidate policy. This file describes how changes are labeled
before the stable `1.0.0` release.

## Spec Versions

The umbrella Kaspa x402 proposal is `v1`; bindings, signed domains, and
covenant templates are versioned independently. Breaking changes must update
the affected identifiers, schemas, vectors, packages, and docs together.

The current `1.0.0-rc.2` surface uses `kaspa-exact-v2`,
`kaspa-escrow-v3`, and `kaspa-x402-escrow-v4`. RC2 also includes
`kaspa-hash-chain-exact-v1` and `kaspa-x402-hash-chain-head-v1`. The covenant was
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
kaspa-x402-escrow-v4
kaspa-x402-kip10-additive-v1
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
```

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
