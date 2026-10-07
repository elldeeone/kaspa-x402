# Upstream submission readiness

Checked 2026-10-07 against x402 commit
[`10b2d06`](https://github.com/x402-foundation/x402/tree/10b2d06b9472bc467d139b272d01bface38ae2d8).
Its `@x402/core` version is 2.28.0, matching the pinned
[compatibility experiment](../prototypes/x402-exact/README.md).

## Agreed scope and contribution requirements

[Issue #3645](https://github.com/x402-foundation/x402/issues/3645) proposes all
three exact profiles and a separate batch-settlement binding. At the recorded
check it was open with no maintainer reply; announcing the work is not approval.
Submission is on hold pending feedback on that issue. The sequence below is the
proposed scope, subject to that feedback.

The [contribution guide](https://github.com/x402-foundation/x402/blob/10b2d06b9472bc467d139b272d01bface38ae2d8/CONTRIBUTING.md#adding-a-new-chain-family)
requires a specification-only PR for one scheme, then an implementation in one
SDK after spec approval. Therefore the proposed first submission remains one
`specs/schemes/exact/scheme_exact_kaspa.md` covering standard-native, additive and
hash-chain-additive. Submit batch-settlement separately under its scheme folder.
These are mechanism specifications, not just JSON schemas.

Use the [chain implementation template](https://github.com/x402-foundation/x402/blob/10b2d06b9472bc467d139b272d01bface38ae2d8/specs/CONTRIBUTING.md#scheme-implementation-template):
payload construction, verification, settlement and concrete examples, plus
replay prevention, authorization scope and settlement atomicity. Reference
upstream core types instead of redefining them. Link versioned covenant sources,
vectors and [verification evidence](evidence.md) where they support a rule.

Submission requirements include signed commits, the upstream PR template,
concise text, disclosure of significant AI assistance and personal review before
requesting review. Documentation-only PRs do not need SDK changelog fragments.
Do not copy the website, gateway, stores, proof wallets or deployment tooling.

## Open decisions and blockers

| Item | What is demonstrated | What remains |
| --- | --- | --- |
| Exact request binding | All three profiles pass real upstream HTTP/core interfaces, including signed server statements and payer authorizations. | The `kaspaServerBinding` statement is an experimental mechanism field. Specify its trust, canonicalization, key registration/rotation and failure rules for review; it is not an accepted upstream extension. |
| Facilitator interoperability | The prototype uses the standard three-field facilitator envelope without changing payer-signed fields. | The reference facilitator still takes top-level `requestHash`/`resource`. It is not an upstream mechanism implementation. Connect canonical verification and durable settlement/operation stores after spec agreement. |
| Dynamic offers and recovery | Local SDK tests and funded harnesses exercise head/channel lifecycle and recovery. | The upstream prototype uses fixtures and process-local operation guards. Dynamic issuance, replica/restart safety and MCP integration remain implementation work. |
| Network identifiers | `kaspa:testnet-10` is the current binding identifier. | At the recorded check, [namespace PR #193](https://github.com/ChainAgnostic/namespaces/pull/193) was open with one approval. Verify its status before submission and describe identifiers as proposed until merged. This is an external dependency, not a documented prerequisite to proposing a spec. |
| Batch pricing | Local batch accounting commits the full advertised fixed charge and returns a commitment identifier. | State the fixed-price restriction explicitly when mapping to upstream's dynamic-price-capable scheme; do not imply that partial per-request charging is implemented. |

These decisions belong in spec review. Funded Testnet success establishes the
tested local behavior; it does not settle them or establish mainnet readiness.
Maintainer approval is required before the SDK contribution proceeds.

After approval, the TypeScript mechanism must implement `SchemeNetworkClient`,
`SchemeNetworkServer` and `SchemeNetworkFacilitator` without core changes. The
upstream checklist also calls for unit, integration and E2E coverage, network
registration in the shared E2E harness, minimal all-network examples, publishing
workflow, package README and a Changesets fragment for user-facing SDK changes.

The issue's RC2 link still uses the old repository `docs/` path. Its current
target is [protocol/docs/rc2-release.md](rc2-release.md); update that external link
when posting the eventual spec PR. No upstream comment, PR or issue edit was
made as part of this verification.
