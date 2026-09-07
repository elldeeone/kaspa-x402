# Security remediation, 7 September 2026

Local remediation of the existing 41 finding occurrences, grouped into 29 themes. The machine-readable [finding ledger](./security-remediation-20260907.json) retains every occurrence and its disposition. This is not a new broad scan or evidence of a hosted release.

These amendments apply to the current source. Frozen release snapshots and locks, including the existing Alpha.11 snapshot, retain their original bytes; they do not incorporate this later remediation. A final clean release candidate must intentionally refresh the unpublished candidate snapshot or use a new version before publication.

## Identifier admission and upgrade

Exact identifiers are reserved atomically by `claimExactSettlement`, before
broadcast or protected work. Reservations are shared with batch admission and
owned by scheme and attempt. They survive handler/commit failure and are released
only by successful application or trusted rejection. The identifier is immutable
attempt evidence; failed commits must not write identifier records.

For pending journals written by an earlier Alpha.11 candidate, the gateway blocks
new payment admission until each legacy exact record is recovered using its
original authenticated payload or explicitly reconciled as rejected. Matching the
stored payload hash permits binding the previously omitted identifier without
rerunning the handler. Do not delete ambiguous journals to unblock admission.
`identifierAdmissionVersion: 1` also marks new attempts without an identifier.
Other durable adapters must preserve the same upgrade barrier.

## Application outcome recovery

Returned MCP `isError` results settle batch requests with zero charge. A thrown handler remains ambiguous: it may already have performed external work. `recoverBatchHandler(attemptId, handlerResult?, originalPayment?)` accepts a trusted operator-confirmed result and commits it without a payer retry. Charges cannot exceed the durable maximum, and an already staged result cannot be replaced. Legacy completion requires the original matching payment when its metadata was not stored.

`recoverExactHandler` stages an operator-confirmed outcome for the original retry. `completeExactSettlement(transactionId, handlerResult?)` also commits the accepted payment and cached response without needing that retry. Exact charges must equal the accepted amount. Neither method proves external application effects; the caller is trusted to confirm them. First-seen already accepted transactions are rejected before creating an adoptable attempt. Expired authorizations remain invalid for fresh work; fully matching authenticated accepted/staged durable recovery can complete after expiry.

Exact facilitator `/verify` still requires accepted-chain finality; it is not a pre-broadcast admission operation. A fresh pending artifact is admitted and broadcast by `/settle`. Verification of an already accepted artifact does not authorise a new settlement attempt. The example verifier now models this transition instead of reporting every fresh artifact as already accepted.

## Client and reference-adapter authority

Client `FundingPolicy.maximumBatchRefundHorizonDaa` defaults to `36000`. Every batch deposit, top-up and voucher authorization checks the proposed absolute timeout against the funding provider's current virtual DAA score. The payer callback receives `currentDaaScore`, `refundTimeoutDaa` and `refundHorizonDaa`; the unit is DAA score, not seconds. Prepared genesis deposits must equal the amount the payer approved. Browser relative `paidFetch` URLs resolve once against the page URL before origin-policy checks and retry.

Reference adapters run in one trusted process. Their channel records contain `clientPrivateKey` because voucher, request, top-up and refund signing consume it. Do not pass these records to untrusted adapters. A custom signer can retain custody and omit the optional raw key, but the reference adapter is not an isolated wallet or HSM boundary.

A custom refund builder is also trusted signing authority: the generic signer signs the supplied digest and does not independently decode all transaction economics. The reference builder constructs the bound refund with its fixed fee. An untrusted builder requires transaction-intent verification before signing; the current API does not promise that boundary.

Reference key files must be regular files, owned by the current user, private to that user, and stored in a 0700 directory without symlink components. Creation is exclusive with mode 0600; unsafe existing files fail closed rather than being silently repaired. Run local proof tooling only with operator-selected configuration modules: such modules are executable code by design.

## Disposition

| Disposition | Occurrences | Themes |
| --- | ---: | ---: |
| Fixed and locally verified | 28 | 22 |
| Conditional authority or immutable historical limitation | 12 | 6 |
| Intentional executable operator configuration | 1 | 1 |
| Remaining actionable local fixes | 0 | 0 |

Conditional items are the six variants of REST evidence authority, raw-key reference custody, trusted refund-builder authority, and four historical schema/provenance/install occurrences. They are documented limits, not claims of reduced trust. See [gateway authority and recovery](./demo-operations.md) and the [historical erratum](./historical-release-erratum.md).

One independent boundary investigation preceded each fix package, followed by one scoped bypass/regression review. The identifier review found the legacy-journal admission gap; the hosted review found missing operator completion/rejection paths. Both were corrected and regression-tested. Exact lifecycle, batch/client and tooling reviews found no further scoped issues. This does not expand the original scan's partial coverage.

## Local verification

- All seven workspaces built, including the Worker dry run. The complete test run passed 517 package tests and 25 tooling tests. Two later gateway assertions cover real exact/batch scope keys and additive `/supported` caching; the updated 21-test gateway file and its TypeScript check pass.
- Schema/vector validation, generated-validator drift, 74 covenant-fixture checks and the 23-check offline proof pass. The HTTP, exact interoperability and batch interoperability vectors match.
- The canonical consensus oracle and exact consensus vectors pass against Rusty Kaspa `c338d495bec29e4dc8b5149f99e8db6fa916ed4a`, checked out separately for validation.
- Active site build/check, headless browser flow, local Worker smoke test, generated Worker bindings, admin CLI handling, hosted offer pins, public package dry run and whitespace checks pass. The downloaded SDK archive and all five vendored assets match their pinned hashes.
- The standalone default PNN resolver check timed out after three bounded attempts. The browser and a separate explicit-endpoint PNN RPC check both connected successfully to the configured TN10 endpoint. This is a network-check limitation, not funded payment proof.

The four pre-existing profile-metadata edits remain intact; reverse-application of their saved patch passes. Frozen release directories and locks are unchanged. No publication, deployment, mainnet operation or live funded transaction occurred. The live-proof configuration preflight is intentionally blocked by missing RPC, funded-wallet and adapter configuration. The clean-tree publication gate is not claimed: this working tree contains the reviewable fixes, and the existing frozen candidate predates them. Expiry recovery also retains the existing unavailable/retired additive-head restrictions.
