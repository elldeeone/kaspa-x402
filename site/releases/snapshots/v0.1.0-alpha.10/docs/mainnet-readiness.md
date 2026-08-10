# Mainnet Readiness

Status: mainnet is blocked. `kaspa:mainnet` is a reserved draft profile name,
not a production readiness claim.

The active Alpha.10 native profiles are:

- `exact` with `kaspa-exact-v2` (`standard-native` by default, optional KIP-10
  `additive` head profile); and
- `batch-settlement` with `kaspa-escrow-v2` and
  `kaspa-x402-escrow-v2`.

`kaspa:testnet-10` is the only validation target. Older alpha releases remain
available as immutable historical snapshots, but Alpha.10 does not provide
runtime compatibility or state migration for them. Mainnet must remain opt-in
and disabled by default until every gate below is closed.

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
  adapter recovery, and operator key handling.

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

### Durable State

Production deployments must use durable transactional server and client stores.
The server store must satisfy `docs/server-store-contract.md`, and servers must
use a shared lock manager satisfying `docs/server-runtime-lock-contract.md`.
In-memory stores are not acceptable for mainnet.

The store must preserve stable `covenantId`, current outpoint, A/S/T/V state,
voucher evidence, and unresolved transition attempts across process loss. KIP-20
does not provide covenant-id reverse lookup, so genesis and every accepted
successor must be recorded from verified transaction evidence.

The client `ChannelStore` must durably reserve the exact signed refund and its
deterministic transaction id before broadcast. A send exception or
broadcast-only result must block another refund until a trusted
`RefundReconciler` proves that exact transaction accepted or confirmed.
Accepted application must atomically compare the captured head and mark both
the channel refunded and the attempt applied; unknown, mismatched, or stale
evidence fails closed without rebroadcast.

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
multiple heads, conflict/retry, exact replay and invalid-signature rejection,
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
