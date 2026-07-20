# x402 v2 Upstream Compatibility Report

Status: internal pre-submission report, checked 2026-07-08 against
`x402-foundation/x402` `main`. Not published on the site.

Scope: line-level comparison of this repository's wire surface against the
upstream v2 specification (`specs/x402-specification-v2.md`) and transports
(`specs/transports-v2/http.md`, `specs/transports-v2/mcp.md`).

## Verdict

The Kaspa binding is wire-compatible with upstream x402 v2. Alpha.9 keeps the
Kaspa exact evidence inside the ecosystem-defined `exact` payload as a signed
`exact-transaction` artifact, with explicit `standard-native` and optional
KIP-10 `additive` profiles. One cosmetic delta remains
(`PaymentRequired.error` content convention) plus one conformant extension
(settlement failures also carried in MCP `_meta`). No blocking divergence was
found. Submission can proceed after CASA namespace filing is in review.

## Verified Matches

| Surface | Upstream v2 | This repo | Result |
| ------- | ----------- | --------- | ------ |
| 402 signaling | HTTP 402 + `PAYMENT-REQUIRED` header, base64 JSON | same | match |
| Paid retry | `PAYMENT-SIGNATURE` header, base64 JSON | same | match |
| Settlement | `PAYMENT-RESPONSE` header, base64 JSON | same | match |
| Header encoding | standard base64 | standard base64 (`Buffer.toString("base64")`) | match |
| `PaymentRequired` fields | `x402Version` (2), `resource` required, `accepts[]` required, `error` optional, `extensions` optional | same shape | match |
| `PaymentPayload` fields | `x402Version`, `accepted` required, `payload` required, `resource` optional, `extensions` optional | same; we omit optional `resource` | match (omission permitted) |
| `SettlementResponse` fields | `success`, `transaction`, `network` required; `errorReason`, `payer`, `amount`, `extensions` optional | same; Kaspa data under `extensions.kaspa` | match |
| Network identifiers | CAIP-2 `namespace:reference` | `kaspa:testnet-10`, `kaspa:mainnet` (CAIP-2 syntax, namespace unregistered) | match pending CASA registration |
| MCP transport | `_meta["x402/payment"]`, `_meta["x402/payment-response"]` | same keys | match |
| Error vocabulary | `invalid_x402_version`, `invalid_scheme`, `invalid_network`, `invalid_payment_requirements`, `invalid_payload`, `unsupported_scheme`, `invalid_transaction_state`, `unexpected_settle_error` | same set | match |
| Scheme names | `exact`, `batch-settlement`, `upto` are upstream scheme families with per-ecosystem bindings | `exact` and `batch-settlement` bindings; `upto` evaluated and archived | match (binding-level contribution) |

## Deltas

### 1. MCP settlement failure (resolved in v0.1.0-alpha.3 — hybrid shipped)

Upstream MCP returns `isError: true` with a fresh `PaymentRequired` in
`structuredContent` on settlement failure and discards the failed
`SettlementResponse` — even though upstream's own HTTP transport delivers
that object in the `PAYMENT-RESPONSE` header on failure. As of
v0.1.0-alpha.3 our binding is upstream-conformant and hybrid: servers emit
upstream's failure shape (`PaymentRequired` in `structuredContent` and
`content[0].text`) plus the failed `SettlementResponse` in
`_meta["x402/payment-response"]`, with a spec rule that a failed settlement
response is terminal for clients. Covered by a cross-package client/server
E2E test and a packed-tarball consumer E2E.

Remaining action: the submission draft proposes standardizing failure-time
`_meta["x402/payment-response"]` upstream.

### 2. `PaymentRequired.error` content convention (cosmetic)

Upstream describes `error` as a human-readable message (example:
"PAYMENT-SIGNATURE header is required"). Our corrective 402s put machine
reasons (for example `invalid_transaction_state`) in that field. The field is
an unconstrained string in both, so this is a convention difference, not a
schema violation. Action: mention in the issue; align in a future alpha if
upstream cares.

## Items Confirmed Non-Issues

- `resource` inside `PaymentPayload`: optional upstream; our omission is
  valid.
- Our two extra-sounding error codes (`invalid_transaction_state`,
  `unexpected_settle_error`) exist in the upstream v2 vocabulary.
- Scheme-specific `payload` content is explicitly ecosystem-defined upstream
  (EVM uses EIP-3009 authorization; SVM, Aptos, Hedera differ). Kaspa's
  signed transaction artifact is the same pattern applied to a UTXO chain.
- `extra.binding` identifiers (`kaspa-exact-v2`, `kaspa-escrow-v1`) live in
  the scheme-defined `extra` object, which upstream leaves to bindings.

## Spec-Snapshot Constraint

Any wording changes to `spec/*.md` prompted by upstream feedback require an
alpha version bump with a new release lock and snapshot (locked-release
policy). Queue such edits for the next release; do not mutate deployed release
snapshots in place.
