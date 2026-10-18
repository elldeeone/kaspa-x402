# 1.0.1 release

Status: candidate. The four packages will be published together on npm with the
`latest` tag after validation: `@kaspa-x402/core`, `@kaspa-x402/covenant`,
`@kaspa-x402/client` and `@kaspa-x402/server`, all at `1.0.1` with exact internal
dependencies.

## Changes since 1.0.0

- Fix transaction vector fees so the canonical examples meet the pinned Kaspa
  node's default relay policy as well as consensus rules. Regenerate linked
  transaction bytes, signatures, IDs and HTTP/interoperability examples.
- Add the real default relay-policy check to CI and release validation, including
  a signed low-fee negative control that passes consensus but fails relay policy.
- Retry a complete PNN snapshot when selected-chain observation moves, with a
  bounded attempt count and deadline. Invalid evidence still fails immediately.
- Check required live batch vectors before spending Testnet funds, and check the
  existing hosted head before starting a public browser payment proof.

The public SDK runtime APIs, signed formats, escrow-v5 and hash-chain-head-v2
covenants are unchanged. The private adapters and demo include the PNN retry fix.
The four public packages advance together under the [versioning policy](versioning-policy.md).

## Supported profiles

Standard-native exact, additive exact, hash-chain-additive exact and batch
settlement remain supported. Testnet-10 is the default and funded validation
target. Mainnet requires explicit opt-in and application-provided trusted chain
evidence, durable stores, shared locks, signers and authenticated request context.
See the [integration guide](integration.md) and [production operating requirements](mainnet-readiness.md).

## Release validation

The patch candidate is being checked with the complete release gate, independently
reproduced compiler artifacts, the pinned consensus/default-relay oracle, and
fresh funded Testnet transactions using the exact installed release archives.
Published release evidence will identify the source revision and archive hashes.

These checks do not establish mainnet acceptance, independent chain authority,
production performance or an independent security audit. The
[1.0.0 security review](security-review-1.0.0.md) remains a historical record.

## Demo compatibility

The last recorded public demo is 1.0.0 on Testnet-10. Its
[funded deployment proof](https://github.com/elldeeone/kaspa-x402/blob/main/verification/release-1.0.0-hosted.json)
is historical evidence. The 1.0.1 Worker deployment will preserve existing
Durable Object payment state and the same covenant templates; no state reset or
channel migration is needed for this patch. The website records the separately
verified demo version and date in `release.json`.

The adapters, facilitator and CLI remain private workspaces. This release does
not claim upstream x402 adoption or certify an application's production topology.
