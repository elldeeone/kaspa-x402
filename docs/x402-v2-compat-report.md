# x402 v2 Upstream Compatibility Report

Status: internal pre-submission report. The upstream comparison baseline was
checked 2026-08-31 against `x402-foundation/x402` `main`. Not published on the
site.

Scope: line-level comparison of this repository's wire surface against the
upstream v2 specification (`specs/x402-specification-v2.md`) and transports
(`specs/transports-v2/http.md`, `specs/transports-v2/mcp.md`).

## Verdict

The Kaspa binding remains wire-compatible with upstream x402 v2. Alpha.11
labels both exact profiles with the required non-default
`extra.paymentFlow: "upfront"` and replaces the active batch binding with
`kaspa-escrow-v2` / `kaspa-x402-escrow-v3`. KIP-20 covenant identity, lifetime
voucher accounting, and transaction-v1 evidence remain ecosystem-defined
scheme payload details inside the upstream envelope.

One cosmetic delta remains (`PaymentRequired.error` content convention) plus
one conformant extension (settlement failures also carried in MCP `_meta`). No
blocking divergence was found. Submission can proceed after CASA namespace
filing is in review.

## Verified Matches

| Surface                     | Upstream v2                                                                                                                                                                                  | This repo                                                                   | Result                             |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------- |
| 402 signaling               | HTTP 402 + `PAYMENT-REQUIRED` header, base64 JSON                                                                                                                                            | same                                                                        | match                              |
| Paid retry                  | `PAYMENT-SIGNATURE` header, base64 JSON                                                                                                                                                      | same                                                                        | match                              |
| Settlement                  | `PAYMENT-RESPONSE` header, base64 JSON                                                                                                                                                       | same                                                                        | match                              |
| Header encoding             | standard base64                                                                                                                                                                              | standard base64 (`Buffer.toString("base64")`)                               | match                              |
| `PaymentRequired` fields    | `x402Version` (2), `resource` required, `accepts[]` required, `error` optional, `extensions` optional                                                                                        | same shape                                                                  | match                              |
| `PaymentPayload` fields     | `x402Version`, `accepted` required, `payload` required, `resource` optional, `extensions` optional                                                                                           | same; we omit optional `resource`                                           | match (omission permitted)         |
| `SettlementResponse` fields | `success`, `transaction`, `network` required; `errorReason`, `payer`, `amount`, `extensions` optional                                                                                        | same; Kaspa data under `extensions.kaspa`                                   | match                              |
| Network identifiers         | CAIP-2 `namespace:reference`                                                                                                                                                                 | `kaspa:testnet-10`, `kaspa:mainnet` (CAIP-2 syntax, namespace unregistered) | match pending CASA registration    |
| MCP transport               | `_meta["x402/payment"]`, `_meta["x402/payment-response"]`                                                                                                                                    | same keys                                                                   | match                              |
| Error vocabulary            | `invalid_x402_version`, `invalid_scheme`, `invalid_network`, `invalid_payment_requirements`, `invalid_payload`, `unsupported_scheme`, `invalid_transaction_state`, `unexpected_settle_error` | same set                                                                    | match                              |
| Scheme names                | `exact`, `batch-settlement`, `upto` are upstream scheme families with per-ecosystem bindings                                                                                                 | `exact` and `batch-settlement`; `upto` evaluated and archived               | match (binding-level contribution) |
| Exact payment flow          | Non-authorization flows must advertise `extra.paymentFlow`; `upfront` means settle before resource execution                                                                                 | both Kaspa exact profiles require `upfront` and settle before the handler   | match                              |

## Deltas

### 1. MCP settlement failure (resolved in v0.1.0-alpha.3 — hybrid shipped)

Upstream MCP returns `isError: true` with a fresh `PaymentRequired` in
`structuredContent` on settlement failure and discards the failed
`SettlementResponse` — even though upstream's own HTTP transport delivers that
object in the `PAYMENT-RESPONSE` header on failure. Since v0.1.0-alpha.3 our
binding is upstream-conformant and hybrid: servers emit upstream's failure shape
(`PaymentRequired` in `structuredContent` and `content[0].text`) plus the failed
`SettlementResponse` in `_meta["x402/payment-response"]`, with a spec rule that
a failed settlement response is terminal for clients. Covered by a cross-package
client/server E2E test and a packed-tarball consumer E2E.

Remaining action: the submission draft proposes standardizing failure-time
`_meta["x402/payment-response"]` upstream.

### 2. `PaymentRequired.error` content convention (cosmetic)

Upstream describes `error` as a human-readable message (example:
"PAYMENT-SIGNATURE header is required"). Our corrective 402s put machine reasons
(for example `invalid_transaction_state`) in that field. The field is an
unconstrained string in both, so this is a convention difference, not a schema
violation. Action: mention in the issue; align in a future alpha if upstream
cares.

## Items Confirmed Non-Issues

- `resource` inside `PaymentPayload` is optional upstream; our omission is
  valid.
- Our two extra-sounding error codes (`invalid_transaction_state`,
  `unexpected_settle_error`) exist in the upstream v2 vocabulary.
- Scheme-specific payload content is ecosystem-defined upstream. Kaspa exact
  uses a signed transaction artifact; Alpha.11 batch uses stable KIP-20
  `covenantId`, current-outpoint evidence, and cumulative voucher fields.
- `extra.binding` identifiers (`kaspa-exact-v2`, `kaspa-escrow-v2`) and the
  `kaspa-x402-escrow-v3` template id live in scheme-defined `extra` objects,
  which upstream leaves to bindings.
- Signed-int64 batch limits, singleton covenant transitions, and claim fee
  topology constrain the Kaspa binding without changing upstream envelopes or
  transport behavior.

## Alpha Snapshot Constraint

Alpha.11 is a clean active-profile replacement, not a compatibility layer.
Older immutable release snapshots remain available for historical
reproducibility, but their batch bindings and stores are not accepted by the
Alpha.11 runtime. The Alpha.11 release must create and lock a new snapshot;
deployed snapshots must never be mutated in place.
