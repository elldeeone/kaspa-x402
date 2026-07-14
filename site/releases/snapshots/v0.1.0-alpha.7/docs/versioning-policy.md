# Versioning Policy

Status: alpha policy. This file describes how breaking changes should be labeled
before a stable release exists.

## Spec Versions

The current spec family is `v1` in filenames and binding identifiers. Until the
first stable tag, `v1` means the first proposal family, not a production-stable
contract.

Breaking wire changes before stability should update vectors, schemas, package
minor/pre-release versions, and the affected docs in the same change.

Current alpha wire notes:

- `0.1.0-alpha.7` hardens KIP-10 reservation validation and continuation
  recycling, enforces the Kaspa DAA lock-time boundary and rolling refund
  safety window, and makes claim-continuation accounting explicit.
- `0.1.0-alpha.5` made `exact-transfer` observe-only by requiring
  `transactionId` plus `paymentOutputIndex`.
- `0.1.0-alpha.6` replaces observe-only exact with KIP-10
  `exact-transaction` payloads carrying a signed transaction artifact,
  `transactionEncoding`, and server-advertised buildable reservation terms
  including borrow redeem script and additive threshold.

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
kaspa-x402-escrow-v1
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
kaspa:x402:escrow-voucher:v1
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
