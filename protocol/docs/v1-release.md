# 1.0.0 release

Status: candidate under review. Not merged or published by this PR.

The release covers the Kaspa x402 standard and four public packages:
`@kaspa-x402/core`, `@kaspa-x402/covenant`, `@kaspa-x402/client` and
`@kaspa-x402/server`, all at `1.0.0` with exact internal dependencies.

## Supported profiles

- Standard-native exact: one native-KAS payment for one priced request.
- Additive exact: payment measured by the exact increase in a KIP-10 head.
- Hash-chain-additive exact: KIP-20 head advancement with private one-time grants.
- Batch settlement: cumulative vouchers, partial claims, top-up and timed refund.

Both network identities are supported. Mainnet requires explicit opt-in;
Testnet-10 remains the default and funded validation target. Applications supply
trusted chain evidence, durable transactional stores, shared locks, signers and
their authenticated request context. See the [integration guide](integration.md)
and [production operating requirements](mainnet-readiness.md).

## Changes since RC2

- Escrow-v5 and hash-chain-head-v2 support consensus transaction signature scopes;
  reference signers default to ALL. These replace incompatible RC2 templates.
- Compiler inputs are authenticated and both covenants independently reproduced.
- Settlement evidence, network binding, transport limits, replay/recovery and
  durable state contracts include the completed security remediation.
- Hash-chain issuer storage is bounded without discarding recovery evidence.
- Releases bind reviewed source, compiler receipts and the exact package bytes.
- External qualification covers all four profiles, documented mock examples,
  real signatures, concurrency, retries and controlled failure/recovery cases.

Existing RC2 scripts cannot be upgraded in place. Complete or recover their
channels/heads under the original runtime and open new state under 1.0.0. See
the [template transition](versioning-policy.md#sighash-template-transition).

## Candidate validation

Before publication, retain the clean candidate commit, independent compiler and
pinned consensus results, approved archive manifest, external installed-package
qualification and fresh funded Testnet-10 report. The release PR records the
exact revision, hashes and outcomes. The earlier
[qualification campaign](../../verification/external-sdk-qualification/RESULTS.md)
is supporting evidence, not a substitute for checking the final 1.0.0 archives.

This release does not publish adapters, facilitator or CLI workspaces, provide a
hosted production payment service, claim upstream x402 adoption, or deploy the
website/demo. Testnet evidence does not establish mainnet acceptance or certify
an application's production topology.
