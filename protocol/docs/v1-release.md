# 1.0.0 release

Status: published on npm as `1.0.0` with the `latest` tag.
[GitHub release](https://github.com/elldeeone/kaspa-x402/releases/tag/v1.0.0).

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

The public website and demo Worker run 1.0.0 with fresh head-v2 / escrow-v5
state. The bounded Node transport runs in a Cloudflare Container and holds no
payment keys or payment state. The existing Durable Object remains authoritative.
A funded payment and same-transaction retry passed through the public HTTPS
browser flow; see the [deployment proof](https://github.com/elldeeone/kaspa-x402/blob/main/verification/release-1.0.0-hosted.json).
The earlier [local browser proof](../../verification/demo-release-RESULTS.md)
remains a separate record. See the [cutover procedure](../../docs/demo-operations.md#100-demo-cutover).

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

## Release validation

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

Release source: `e5f5b0ed34657dc4e8c67c9153818e0ba07b1828`.
[Main CI](https://github.com/elldeeone/kaspa-x402/actions/runs/38848724921) passed.
The four registry archives match the qualified package hashes exactly. The
compiler/consensus evidence, archive approval and funded reports are retained.
See the [security review and merged fixes](security-review-1.0.0.md). The earlier
[qualification campaign](../../verification/external-sdk-qualification/RESULTS.md)
is supporting evidence, not a substitute for checking the final 1.0.0 archives.

This release does not publish adapters, facilitator or CLI workspaces, provide a
hosted production payment service, claim upstream x402 adoption, or deploy the
website/demo automatically. The separately authorized Testnet demo cutover is
recorded above. Testnet evidence does not establish mainnet acceptance or certify
an application's production topology.
