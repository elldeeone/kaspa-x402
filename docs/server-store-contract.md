# Server Store Contract

The reference `MemoryServerChannelStore` is for tests and examples. Production
servers need a durable implementation of `ServerStateStore` with the semantics
below.

Alpha.10 supports `kaspa-escrow-v2` / `kaspa-x402-escrow-v2` as the active
batch profile. Older alpha stores are not migrated or read by the Alpha.10
runtime; immutable release snapshots remain historical records only.

## Required Guarantees

- Writes are durable before the method resolves.
- Failed writes leave no partial replay, idempotency, channel, or transition
  attempt state.
- Compare-and-set checks and uniqueness checks happen in the same transaction as
  the write they protect.
- Records survive process restart and are reloaded before retry recovery.
- Every arithmetic value used by the batch covenant is between zero and signed
  int64 maximum (`9223372036854775807`).

Runtime serialization is a separate adapter contract. Deployments with multiple
server processes must also provide a shared `ChannelLockManager` as described in
[server-runtime-lock-contract.md](server-runtime-lock-contract.md).

## Replay And Idempotency

`commitExactPayment` consumes a transaction id once per server or facilitator
trust domain. `paymentOutputIndex` remains receipt evidence, but a second output
from the same transaction is a replay conflict. A cached exact retry is the same
verifier-derived transaction id, same output index, and same request
fingerprint; payload byte equality is not required because the accepted
transaction id and output index are the replay evidence.

`PaymentIdentifierRecord.id` must be globally unique inside the same trust
domain. Reusing an id with a different request fingerprint, payload hash, or
payment scope must fail atomically.

## Additive Exact Heads

`registerExactHead` must enforce unique head ids and unique current outpoints.
`selectExactHead` is read-only: issuing a 402 must not reserve, retire, or
otherwise mutate a head. `claimExactSettlement` must atomically compare the
advertised head id, version, and current outpoint before marking one settlement
attempt as the claimant. `acceptExactSettlement` must atomically replace that
outpoint and amount with the verifier-derived same-script successor, increment
the version, and commit replay/idempotency state. A losing concurrent claimant
must fail and refresh from the current head. Crash recovery must preserve
broadcast uncertainty rather than reopening the old outpoint for protected work.

## Batch Genesis And Head State

Before accepting the first voucher, the store must retain verified genesis
evidence proving that the funding transaction had exactly one output, the
expected covenant genesis with the advertised script, value, initial state
`S = 0`, and derived `covenantId`. This evidence must be captured before pruning or
history-provider retention can make the genesis transaction unavailable.

Each active lane record must contain:

- stable `covenantId` and channel id;
- current outpoint, script public key, and value V;
- lifetime actual charges A and lifetime on-chain gross settlement S;
- latest buyer-signed lifetime ceiling T and its signature;
- refund terms, status, and the evidence needed to reconcile the next
  transition.

KIP-20 supplies stable lineage identity, not discovery. Standard RPC does not
provide reverse lookup from `covenantId` to its current UTXO, so the current
outpoint must be advanced durably from verified transaction evidence.

## Batch Accounting And Commit

At voucher acceptance, one transaction must verify and persist
`0 <= S <= A <= T` and `(T - S) + R <= V`, where R is the configured claim
reserve and fee floor. `A - S` is outstanding actual charge; `T - S` is
authorization headroom. T is monotonic for the stable lineage and does not reset
after a claim or top-up.

`commitSettlement` must atomically write the batch commitment, optional payment
identifier, updated A and T, and next channel state only when the current
channel still matches the expected `covenantId`, outpoint, A, S, T, and V
snapshot.

## On-Chain Transition Attempts

Claim, top-up, and refund builders must reserve a durable attempt against the
exact current outpoint before broadcast. Only one unresolved attempt may own a
lane head. An attempt record must retain enough unsigned and signed transaction
evidence to distinguish:

- not broadcast;
- broadcast outcome unknown;
- accepted with the expected successor or terminal refund;
- rejected or conclusively absent and safe to rebuild.

Applying a claim must verify one same-ID successor, advance S by the gross claim
D, reduce V by D, and preserve A and T. Applying a top-up must verify one
same-ID successor, increase V, and preserve A, S, and T. Applying a refund must
verify that no same-ID successor exists and close the lane. Each application is
a compare-and-set on the attempt's expected outpoint and accounting snapshot.

A timeout, process crash, or RPC error after submission must leave the attempt
unresolved. It must never make the old outpoint available for another claim,
top-up, refund, or protected request until trusted chain evidence reconciles the
winner.

## Handler Side Effects

Payment verification happens before the protected handler. Before invoking it,
the store must durably reserve a batch work attempt keyed by channel, payment
identifier when present, and request fingerprint. After handler success, the
store must durably stage the result and actual charge before attempting the
final payment commit. The final transaction commits A, T, voucher and commitment
evidence, then marks the work attempt applied.

If the final commit fails, a retry must return the staged application result and
retry the payment commit without invoking the handler again. A conflicting
fingerprint must fail atomically.

There is still an unavoidable window when a process crashes after a
non-repeatable handler side effect but before it stages the result. Such handlers
must require `payment-identifier` and keep an application-owned idempotency or
transactional outbox table keyed by `paymentIdentifier` and
`requestFingerprint`. The handler returns that cached result on recovery while
the server store completes payment settlement.
