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

## Demo compatibility

The candidate pairs the browser with the 1.0.0 demo Worker and fresh head-v2 /
escrow-v5 state. Its bounded Node transport relay holds no payment keys or state;
the existing Durable Object remains authoritative. The actual browser payment and
same-transaction retry passed on funded Testnet through a local Worker preview;
see the [demo proof](../../verification/demo-release-RESULTS.md). Preparing this PR does not
deploy the demo; see the [cutover procedure](../../docs/demo-operations.md#100-demo-cutover).

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

Completed candidate qualification: **55/55 external scenario groups**, including
the four documented mock examples; **18/18 funded exact/batch flows** and all
**five hash-chain stages**, with two paid HTTP 200 responses and accepted owner
rotation. The run accepted 20 transactions plus one intentional stale-claim
rejection, spending 6.624786 Testnet KAS in fees.

Funded report SHA-256:
`3b9bdb1a01b93da25a9adc06d144d78373df5d6143d6e279f8d07a9367d75d57`.
Evidence uses one Testnet RPC; stress acceptance facts are controlled. It does
not establish mainnet acceptance or production performance. Qualification binds
the four archive hashes; documentation-only changes preserve that evidence only
when rebuilt archives are byte-identical.

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
