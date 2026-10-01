# Security Threat Model

Status: threat model for the published RC2 Testnet-10 exact and batch-settlement
profiles. v1 RC2 uses `kaspa-escrow-v3` and template
`kaspa-x402-escrow-v4`; pre-RC runtime profiles are not supported.

## Assets

- client funds in exact payments and KIP-20 batch covenant lineages;
- server revenue outputs and claim authority;
- client top-up and timeout-refund authority for batch channels;
- signing keys for exact payments, vouchers, claims, top-ups, and refunds;
- confidential hash-chain one-time signing grants and owner recovery authority;
- durable payment-identifier, replay, current-outpoint, and channel accounting
  state;
- protected HTTP resources and MCP tool results.

## Trust Boundaries

- client wallet, funding, signing, and address-codec adapters;
- server verification, settlement, and state-store adapters;
- configured Kaspa Testnet-10 PNN/WSS node evidence for the hosted gateway;
- optional self-hosted facilitator endpoints;
- operator live-testnet adapters and recovery journals.

The v1 RC2 reference gateway trusts one configured Testnet-10 evidence source
at a time. Multiple endpoint URLs are availability failover, not independent
corroboration. This accepted test boundary must not be treated as Byzantine-safe
or used to enable mainnet.

## Core Threats

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| Exact transaction replay | Exact payment identity includes network, transaction id, and output index. The durable store reserves transaction and optional identifier ownership before handler execution and retains a compact replay tombstone after cached-response expiry. | Losing durable state can reopen replay risk; backups and recovery remain operational requirements. |
| Batch voucher replay or regression | A voucher signs the network, stable KIP-20 `covenantId`, and lifetime ceiling T. The store rejects T below the previously accepted ceiling and never resets T when the outpoint changes. | Compromised client signing keys can authorize future settlement within available escrow value. |
| Stale or substituted batch head | The server persists the current outpoint, script, value V, and on-chain settled total S. Every accepted transition must consume that exact outpoint and prove the expected same-ID successor or terminal refund. | KIP-20 does not provide covenant-id reverse lookup; loss of durable head state requires transaction-lineage recovery. |
| Ambiguous covenant genesis | Before accepting work, the server verifies the funding transaction has exactly one output: the expected genesis with the advertised script, value, initial state, and derived covenant id. | Genesis evidence must be captured before transaction history can become unavailable through pruning or provider retention limits. |
| Parallel payment, deposit, top-up, claim, refund, recovery, or retirement | One durable per-channel operation lease plus a shared per-lineage lock and complete-snapshot compare-and-set admit only one transition. Broadcast and protected-effect uncertainty retain the lease until reconciled. | Network uncertainty can temporarily block the lane while the winning operation is reconciled. |
| Client refund broadcast uncertainty | Before broadcast, the client durably reserves the exact signed transaction, deterministic transaction id, stable covenant id, and captured channel head. Unknown results are reconciled through trusted chain evidence without rebuilding or rebroadcasting. | An unavailable or inconclusive reconciler keeps the channel blocked until accepted-or-confirmed evidence is available. |
| Duplicate retry double-executes protected work | A durable work attempt and identifier reservation bind payer, channel or transaction, payload, scope, and request fingerprint before handler execution. Only one handler-start transition succeeds; a staged result is reused if final commit fails. | A crash after a non-repeatable side effect but before result staging still requires handler-owned idempotency or an outbox. |
| Presentation expires while work is being admitted | Expiry is rechecked at the actual handler invocation. An already admitted attempt that expires before the handler starts becomes recovery-required and cannot run protected work; only an exactly matching immutable retry may resume persisted result or commit state. | Operators must supply a known durable result when admission completed but protected work never safely ran. |
| Handler failure consumes payment state | The committed fixed-charge total and request commitment advance only after protected handler success unless the flow has an explicit recoverable on-chain transition. | Accepted genesis or top-up state remains live even when later protected work fails. |
| Stale node or RPC failure | Verification fails closed unless required finality and covenant-transition evidence is present. | Operators must monitor node health, pruning horizon, and finality lag. |
| Single-source chain evidence is faulty | Testnet verification fails closed on unavailable or internally inconsistent evidence, and mainnet stays disabled until independently corroborated evidence or another audited Byzantine-resilient design exists. | One configured Testnet-10 source can still provide consistently false evidence. |
| Selected-chain reorganization or pruned history | The durable observer resumes from a stable checkpoint, journals removals before additions, rolls back derived state, and accepts only one verified successor. Incomplete continuity becomes unavailable. A removed refund restores refund-only state. | Recovery can remain blocked until a complete authoritative selected-chain history is available. |
| Exact attempt is released on unrelated conflict evidence | The signed artifact retains its funding input outpoints. Permanent absence requires trusted confirmation that a different transaction spent one of those exact inputs; unrelated conflicts and missing observations remain unknown. | A pending attempt remains unavailable while evidence is inconclusive. |
| Facilitator or selected-chain resource exhaustion | Facilitator streams have whole-body byte, structure, deadline, and abort limits. Selected-chain traversal has cumulative byte, block, page, and remote-operation bounds and fails closed instead of truncating. | Limits are deployment policy and require monitoring as traffic and chain history grow. |
| Multi-process admission oversubscribes local limits | The core `DirectModeServer` controller is process-local unless its host coordinates admission. The reference Worker acquires renewable deployment-wide leases from its single named `GatewayState` Durable Object. Other multi-instance deployments must supply an equivalent distributed limiter. | The hosted cross-isolate path is not yet production load-tested; every topology must prove its own coordination boundary. |
| Completed attempts permanently consume active quota | After bounded terminal retention, full attempts leave active admission quotas while immutable O(1) replay tombstones remain. | Tombstone storage grows monotonically and requires separate provisioning and monitoring; it cannot be evicted to admit work. |
| Funding source policy bypass | Client code checks required funding source against adapter-reported funding source. | Wallet and treasury adapters still require independent audit. |
| Malicious facilitator widens capability | Facilitator supported kinds are intersected with direct-mode server capability and explicit action settlers. | Hosted facilitators need authentication, rate limits, and tenant isolation. |
| Covenant template drift | Escrow fixture checks and transaction-v1 vectors pin script public key, state, covenant binding, fee, and output behavior. | Mainnet requires an independent covenant and transaction-builder audit. |

## Exact Profiles

The default `standard-native` profile validates a native Kaspa transaction whose
selected output pays the advertised amount exactly to the advertised recipient.
The optional `additive` profile validates a transaction that spends the current
advertised KIP-10 head and recreates a same-script successor whose increase is
exactly the advertised amount. The successor increase is the sole merchant
payment; a separate merchant output is forbidden. Verifiers derive transaction
id, inputs, outputs, scripts, amounts, and continuation evidence from the
transaction body and trusted UTXO lookups rather than payload hints.

Required checks include:

- accepted requirements match a server offer exactly;
- network, asset, amount, recipient, and binding are unchanged;
- transaction id, when supplied, matches the transaction body;
- the selected standard-native output exists and pays exactly the required
  amount, or the additive successor is at the canonical index with the same
  script and exact required delta;
- additive challenges bind the head id, version, current outpoint, current
  amount, script, threshold, and request fingerprint without reserving the head;
- additive settlement advances the expected head version atomically, and stale
  competitors receive fresh terms;
- an available hosted additive head is checked against trusted current UTXO
  evidence before an offer; external advancement is adopted only through an
  ordered accepted transaction lineage that spends each prior outpoint and
  preserves the same script and output index;
- arbitrary same-address outputs are never treated as head successors, and an
  unprovable external spend makes only that optional additive head unavailable
  while default standard-native exact remains usable;
- the transaction/output identity has not already been consumed;
- finality satisfies the server policy before protected content is released.

## Hash-Chain Exact Profile

RC2 includes `hash-chain-additive` with `kaspa-hash-chain-exact-v1`. Its
one-time signing grant authorizes one accepted head spend, while the x402
verifier separately enforces the exact quoted increase and payer/request
binding. A key holder can construct competing transactions or consume the
grant with an underpayment that does not buy a resource.

The issuer encrypts grants at rest, assigns each grant durably to one payer
and request before disclosure, and checks current-head PNN evidence. Private
grant keys must stay out of public offers, headers, logs, and URLs. A disclosed
key remains usable on-chain after off-chain expiry until an accepted head
transition invalidates it. Abandonment requires owner rotation; uncertain
broadcasts and reorgs require durable reconciliation before a new grant can
be issued. See the [hash-chain binding](../spec/kaspa-hash-chain-exact-v1.md).

## Batch-Settlement Profile

The v1 RC2 batch profile uses one singleton KIP-20 covenant lineage and
lifetime cumulative vouchers. Define:

- A: lifetime fixed charges durably committed by the application;
- S: lifetime gross amount settled on-chain, including claim fees;
- T: latest buyer-signed lifetime settlement ceiling;
- V: value of the current covenant UTXO;
- R: advertised minimum covenant value retained beyond remaining authorization.

At voucher acceptance the server must enforce `0 <= S <= A <= T` and
`(T - S) + R <= V`. Here `A - S` is the outstanding committed charge and `T - S`
is authorization headroom. All values are non-negative decimal sompi strings no
greater than signed-int64 maximum (`9223372036854775807`).

Required checks include:

- the deposit transaction has exactly one output, the expected genesis, with
  initial on-chain state `S = 0`; its `covenantId` is derived and verified before
  protected work is released;
- each voucher signature binds the network, stable `covenantId`, and T, rather
  than the rotating outpoint;
- the current outpoint, script, V, S, A, T, and voucher signature are persisted;
  stable identity does not locate the current UTXO;
- a claim consumes exactly one same-ID input and creates exactly one same-ID
  successor; for gross claim D and fee F, the server output receives `D - F`,
  the successor value is `V - D`, and successor state is `S + D`;
- claim D is positive, exceeds F, does not exceed `A - S` or `T - S`, and leaves
  the required reserve;
- a top-up consumes exactly one same-ID input, creates exactly one same-ID
  successor with greater V, and preserves S, A, and T;
- a timeout refund consumes exactly one same-ID input and creates no same-ID
  successor; its lock time, sequence, destination, amount, and fee reconcile;
- payout and refund outputs are unbound, and every claim, top-up, and refund
  transaction-v1 artifact reconciles inputs, outputs, covenant authorization,
  state, and fees.

## State Store Requirements

Production stores must provide atomic operations for:

- exact transaction replay claims and additive-head claim/advance transitions;
- payment identifier reservation and conflict detection;
- singleton batch genesis registration with stable `covenantId` and current
  outpoint;
- voucher and A/S/T/V compare-and-set transitions;
- crash-safe claim, top-up, and refund attempt reservation, broadcast,
  reconciliation, and application;
- client refund-attempt claim, broadcast-only save, and accepted application,
  with the exact signed transaction and deterministic transaction id retained
  across restart;
- crash-safe protected-work reservation, result staging, and applied-state
  recovery without handler re-execution;
- cached paid response lookup for idempotent retries.

In-memory stores are test fixtures only. See
[server-store-contract.md](server-store-contract.md) and
[server-runtime-lock-contract.md](server-runtime-lock-contract.md).

For client refunds, `ChannelStore.applyRefundAttempt` must atomically compare
the captured outpoint, script, covenant id, value, channel status, and
transaction id before marking the channel refunded and the attempt applied. A
send error or unknown reconciliation result must leave the attempt open, block
a second refund, and never trigger automatic rebroadcast.

## Live Proof Boundary

The live proof runner validates evidence supplied by a live adapter. The
committed reference adapter in `scripts/live-adapter-reference.mjs` is a
reviewable Testnet-10 harness, not a production wallet, broadcaster, recovery
journal, or settlement service. It receives RPC, funding, and SDK paths from
operator environment variables and writes generated signing material under the
ignored live data directory.

Live Testnet-10 success demonstrates alpha flow execution only; it is not a
mainnet approval or audit substitute.
