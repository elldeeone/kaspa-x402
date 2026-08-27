# Versioning Policy

Status: alpha policy. This file describes how breaking changes should be labeled
before a stable release exists.

## Spec Versions

The umbrella Kaspa x402 proposal remains `v1`, while individual bindings and
covenant templates are versioned independently. Until the first stable tag,
these identifiers describe compatibility families rather than
production-stable contracts.

Breaking wire changes before stability should update vectors, schemas, package
minor/pre-release versions, and the affected docs in the same change.

Current alpha wire notes:

- `0.1.0-alpha.11` cleanly replaces the active covenant with
  `kaspa-x402-escrow-v3`, compiled by SilverScript commit
  `28a16f0ee194dcb288a5aaf371abd0f4b77f462e`. It uses explicit DAA lock
  semantics and four-byte KCC-01 dispatch tags; Alpha.10 channel state and
  signature scripts are not accepted or migrated.
- `0.1.0-alpha.10` introduced the `kaspa-escrow-v2` binding and
  `kaspa-x402-escrow-v2` KIP-20 covenant. Buyer vouchers authorize a
  lifetime cumulative ceiling, partial claims advance the settled lifetime
  total, top-ups retain it, and refund closes the channel. The stable
  `covenantId` proves identity and successor lineage; runtimes still persist the
  current outpoint because the ID is not a reverse lookup for the live UTXO.
- `0.1.0-alpha.9` makes the exact and batch-settlement bindings independently
  implementable from their language-neutral specifications and conformance
  vectors. It also closes exact authorization expiry ordering before protected
  work begins and centralizes canonical batch commitment construction.
- `0.1.0-alpha.8` introduces `kaspa-exact-v2`, with default
  `standard-native` and optional reusable KIP-10 `additive` head profiles. The
  additive successor delta is the sole exact payment; unanswered offers do not
  reserve or retire heads.
- `0.1.0-alpha.7` hardens KIP-10 reservation validation and continuation
  recycling, enforces the Kaspa DAA lock-time boundary and rolling refund
  safety window, and makes claim-continuation accounting explicit.
- `0.1.0-alpha.5` made `exact-transfer` observe-only by requiring
  `transactionId` plus `paymentOutputIndex`.
- `0.1.0-alpha.6` replaces observe-only exact with KIP-10
  `exact-transaction` payloads carrying a signed transaction artifact,
  `transactionEncoding`, and server-advertised buildable reservation terms
  including borrow redeem script and additive threshold.

Alpha.11 is a clean active replacement. The current runtime, schemas, examples,
and hosted test surface do not accept or migrate older batch bindings or channel
state. Published alpha releases remain immutable historical snapshots; they are
not compatibility targets for the active alpha.

## Package Versions

Alpha packages use semver prereleases:

```text
0.1.0-alpha.N
```

Rules:

- increment `N` for each alpha publish;
- keep internal package dependency versions exact;
- publish alpha packages with the `alpha` dist-tag;
- do not intentionally promote or advertise tagless/`latest` installs until the
  public spec and API are stable enough for normal semver expectations.

## Template IDs

Template IDs identify covenant families. The current template ids are:

```text
kaspa-x402-escrow-v3
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
kaspa:x402:escrow-voucher:v2
kaspa:x402:channel:v1
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
