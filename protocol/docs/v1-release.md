# 1.0.1 release

Status: published on npm as `1.0.1` with the `latest` tag.
[GitHub release](https://github.com/elldeeone/kaspa-x402/releases/tag/v1.0.1).

The release includes `@kaspa-x402/core`, `@kaspa-x402/covenant`,
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

The clean candidate passed the complete release gate: **1,021 SDK/gateway tests**,
fresh pinned covenant reproduction, **124 default relay-policy paths** with a
signed low-fee negative control, six bounded snapshot cases and three
pre-funding checks. The exact installed 1.0.1 archives passed **55 external
scenario groups**, **18 funded exact/batch flows** with terminal refund, all
**five hash-chain stages**, **eight live fee-boundary cases**, and a funded
browser payment plus identical retry.

Release source: `56221913531bcb8367a900d28ed24c62d50591a1`. The final main CI archives are
byte-identical to the funded candidate. The
[qualification receipt](https://github.com/elldeeone/kaspa-x402/blob/main/verification/release-1.0.1.json)
and attached GitHub release manifest record source revisions and archive hashes.
The registry archives were downloaded and checked against those exact hashes.

These checks do not establish mainnet acceptance, independent chain authority,
production performance or an independent security audit. The
[1.0.0 security review](security-review-1.0.0.md) remains a historical record.

## Demo compatibility

The public website and demo Worker run 1.0.1 on Testnet-10 with the same
escrow-v5/head-v2 templates. Actual deployed modules, configuration, secret
bindings, Durable Object namespace and the existing funded head were verified.
A user-operated public browser payment on a separate network advanced that head
from 1.4 to 1.6 Testnet KAS; the user confirmed retry, and the agent independently
verified selected-chain acceptance and the successor UTXO. The automated local
browser payment/retry also passed. See the
[deployment proof](https://github.com/elldeeone/kaspa-x402/blob/main/verification/release-1.0.1-hosted.json).

The original test caller was correctly blocked by the existing rolling 24-hour
grant quota. Bounded logging confirmed that category; the approved Worker was
restored and its module hashes rechecked. No quota, payment state or channel was
reset or migrated. `release.json` records the verified demo version and date
independently from npm publication.

The adapters, facilitator and CLI remain private workspaces. This release does
not claim upstream x402 adoption or certify an application's production topology.
