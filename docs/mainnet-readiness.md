# Mainnet Readiness

Status: mainnet is blocked. `kaspa:mainnet` is a reserved draft profile name,
not a production readiness claim.

The active v1 RC1 native profiles are:

- `exact` with `kaspa-exact-v2` (`standard-native` by default, optional KIP-10
  `additive` head profile); and
- `batch-settlement` with `kaspa-escrow-v3` and
  `kaspa-x402-escrow-v4`.

`kaspa:testnet-10` is the only validation target. v1 RC1 does not provide
compatibility or state migration for pre-RC runtimes. Mainnet must remain
opt-in and disabled by default until every gate below is closed.

## Required Gates

### Independent Audit

Audit scope must include:

- exact transaction verification, replay protection, and finality policy;
- singleton KIP-20 genesis, stable covenant-id derivation, current-outpoint
  tracking, and pruning-safe genesis evidence;
- batch voucher, claim, top-up, and refund paths, including A/S/T/V/R
  invariants, signed-int64 limits, and claim fee topology;
- payment-identifier, channel state, concurrency, and crash-safe transition
  attempts;
- client funding-source policy, facilitator capability intersection, live
  adapter recovery, operator key handling, transport resource budgets, and
  distributed admission controls.

Audit output must include explicit pass/fail status for exact and
batch-settlement. A Testnet-10-only pass is not sufficient for mainnet.

### Consensus Cross-Validation

The transaction-v1 vectors for batch genesis, claim, top-up, and refund must be
cross-validated against the configured Kaspa consensus checkout:

```sh
KASPA_X402_KASPA_CONSENSUS_ROOT=<rusty-kaspa-checkout> npm run validate:tx-v1-consensus
```

Cross-validation must prove the singleton transition shapes:

- genesis creates exactly one transaction output, the expected covenant;
- claim consumes one same-ID input and creates one same-ID successor;
- top-up consumes one same-ID input and creates one same-ID successor; and
- refund consumes one same-ID input and creates no same-ID successor.

The recorded validation level must be refreshed whenever consensus code,
transaction serialization assumptions, covenant state, fixture scripts, fee
policy, or compute-budget assumptions change.

Recorded offline validation (2026-09-30): Rusty-Kaspa `2.1.0` at
`01b532e8b553523216471682649693af92f0fd16`, using a clean checkout and the
committed consensus harness lockfile. The full `TransactionValidator` accepted
all five batch tx-v1 vectors, exact standard-native and additive profiles,
KIP-10 continuation, and the hash-chain genesis, borrow, rotation, recovery,
top-up, and sweep paths. The batch guard matrix rejected ten signed invalid
transitions and accepted its three controls; the existing exact and hash-chain
negative cases also passed. Regenerated batch, exact, and hash-chain vectors
changed only source provenance, preserving transaction bytes, IDs, covenant
IDs, fees, mass, and compute-budget evidence.

Harness JSON reports the actual checkout commit and consensus package version,
plus whether the source has local or hidden changes. The default launcher
requires the exact clean pin; `--allow-different-source` is an explicit
experimental override. Fresh funded Testnet-10 validation and the remaining
mainnet gates are separate requirements.

### Independent Chain Evidence

Mainnet must not trust one node, endpoint, RPC provider, or commonly operated
endpoint set for acceptance, UTXO, permanent-absence, or selected-chain lineage
decisions. The deployment must use independently corroborated evidence or
another audited Byzantine-resilient design, document source independence and
disagreement policy, and fail closed whenever required sources are unavailable
or disagree. Endpoint failover alone does not close this gate.

### Durable State

Production deployments must use durable transactional server and client stores.
The server store must satisfy `docs/server-store-contract.md`, and servers must
use a shared lock manager satisfying `docs/server-runtime-lock-contract.md`.
In-memory stores are not acceptable for mainnet.

The store must preserve stable `covenantId`, current outpoint, A/S/T/V state,
voucher evidence, and unresolved transition attempts across process loss. KIP-20
does not provide covenant-id reverse lookup, so genesis and every accepted
successor must be recorded from verified transaction evidence.

It must also preserve the immutable source/compiler/bytecode/ABI launch
manifest, append-only accepted and removed lineage events, and selected-chain
checkpoint. The current head must be derived atomically from those records.
Recovery must process removals before additions and fail closed across pruning,
missing predecessors, branches, or wrong covenant bindings. The current
Testnet-10 reference threshold is 30 confirmations; choosing and validating a
mainnet threshold remains an explicit independent-audit and operations gate.

The client `ChannelStore` must durably reserve the exact signed refund and its
deterministic transaction id before broadcast. A send exception or
broadcast-only result must block another refund until a trusted
`RefundReconciler` proves that exact transaction accepted or confirmed.
Accepted application must atomically compare the captured head and mark both
the channel refunded and the attempt applied; unknown, mismatched, or stale
evidence fails closed without rebroadcast.

### Distributed Admission And Resource Bounds

Every production topology must enforce active-attempt, byte, and per-payer
limits across all processes and Worker isolates that share a trust domain.
Process-local counters are insufficient. The reference Worker uses renewable
leases from its single named `GatewayState` Durable Object; other hosts need an
equivalent transactional admission service. The chosen topology must be tested
under concurrent cross-instance load before mainnet enablement.

Facilitator bodies and remote chain reads must have whole-operation resource
budgets. These include streamed byte and JSON-structure limits, finite body
deadlines and caller aborts, plus cumulative selected-chain byte, block, page,
and remote-operation bounds. Limit breaches, disagreement, and partial or
non-converging lineage must fail closed.

### Operational Recovery

Operators need tested recovery procedures for:

- standard-native exact conflicts and additive-head advancement conflicts;
- singleton batch genesis verification before pruning or history loss;
- concurrent or uncertain claim, top-up, and refund broadcasts;
- node/indexer outage handling and current-outpoint lineage reconstruction; and
- adapter crash recovery without reopening a spent head or double-executing
  protected work.

### Live Evidence

Before any mainnet release candidate, a fresh funded `kaspa:testnet-10` run must
pass:

```sh
npm run proof:live:check -- --live --write-report
```

The sanitized report in `docs/live-testnet-report.md` must show tiny and normal
standard-native exact settlement, additive exact-delta head advancement,
multiple heads, one-winner conflict with unresolved losers held pending, exact
replay and invalid-signature rejection,
post-broadcast recovery, and trusted external reconciliation.

For batch settlement it must show verified singleton genesis, multiple lifetime
vouchers across at least one outpoint rotation, claim fee accounting, top-up,
concurrent-transition rejection, crash recovery, replay rejection, and terminal
timeout refund. Every successor must preserve the expected stable `covenantId`
and state, while the durable current outpoint advances.

### Release Controls

Mainnet enablement must require explicit configuration. Packages, examples,
hosted services, and docs must continue to reject or describe mainnet as
reserved until audits, durable-store requirements, live evidence, and operator
runbooks are complete.
