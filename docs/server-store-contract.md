# Server Store Contract

The reference `MemoryServerChannelStore` is for tests and examples. Production
servers need a durable implementation of `ServerStateStore` with the semantics
below.

Alpha.11 supports `kaspa-escrow-v3` / `kaspa-x402-escrow-v4` as the active
batch profile. Older alpha stores are not migrated or read by the Alpha.11
runtime; immutable release snapshots remain historical records only.

## Required Guarantees

- Writes are durable before the method resolves.
- Failed writes leave no partial replay, idempotency, channel, or transition
  attempt state.
- Compare-and-set checks and uniqueness checks happen in the same transaction as
  the write they protect.
- `registerChannel` only installs immutable genesis state. It atomically binds
  each stable `covenantId` to exactly one channel id for its lifetime. A
  different salted channel id must never register the same covenant lineage,
  including after retirement.
- Every channel carries a monotonic `version`. Later state is installed only by
  a specialized operation that compares the complete prior record in the same
  transaction; generic channel replacement is forbidden.
- One durable channel-operation lease namespace covers payment, deposit,
  top-up, claim, refund, recovery, and retirement. A lease owns the complete
  channel snapshot until commit or trusted pre-effect abandonment.
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

Before protected work, a durable payment-identifier reservation binds the id,
request fingerprint, payload hash, payment scope, payment kind, payer, owner
attempt, and transaction/output or channel. Its legal states are `reserved`,
`pending`, `recovery-required`, `completed`, and `safely-released`. Identical
retries recover the same owner; conflicting ownership fails atomically.

Only trusted proof that no protected effect or accepted transaction occurred
may move a reservation to `safely-released`. Pending, accepted, or uncertain
ownership survives restart and is never evicted. Safely released identifier
records remain quota-accounted until bounded expiry or atomic reuse; their
retention indexes must be deleted with the record.

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
- current derived escrow address, outpoint, script public key, and value V;
- lifetime actual charges A and lifetime on-chain gross settlement S;
- latest buyer-signed lifetime ceiling T and its signature;
- refund terms, status, and the evidence needed to reconcile the next
  transition.

KIP-20 supplies stable lineage identity, not discovery. Standard RPC does not
provide reverse lookup from `covenantId` to its current UTXO, so the current
outpoint must be advanced durably from verified transaction evidence.

## Chain Truth And Covenant Lineage

Adapters report objective evidence; they do not declare policy finality. An
accepted record contains the transaction id, accepting-block hash and blue
score, numeric confirmation count, and a durable selected-chain checkpoint.
The runtime derives `confirmed` by applying its configured threshold. The
Alpha.11 Testnet-10 deployment profile uses 30 confirmations. `absent` requires
a confirmed conflicting spend or a stable consensus-rejection proof. Anything
else is `unknown` and keeps the owning attempt reserved.

Every channel stores an immutable launch manifest containing network, checked
compiler commit and command, source path and SHA-256, template and compiled-base
identity, ABI, selectors, and verified genesis derivation, transaction,
outpoint, value, accepting block, and checkpoint.

After genesis, the store maintains an append-only lineage journal. Each
accepted transition records its kind, consumed outpoint, transaction,
successor or terminal output, covenant state, value, binding, accepting block,
numeric confirmation evidence, and checkpoint. Selected-chain removal events
are appended before replacement additions. The live outpoint, script, value,
and settled state are an atomically derived index, never an adapter-supplied
field.

Lineage reads resume only from the durable checkpoint. Pruned or incomplete
continuity is `unknown` and fails closed. A reorganization atomically rolls back
every derived channel state affected by removed events before applying a unique
verified successor. Missing predecessors, multiple spends or successors,
wrong covenant/template bindings, and inconsistent state or value transitions
are rejected. A removed terminal refund restores only a refund-capable or
suspicious lane; it must never reactivate charging.

## Batch Accounting And Commit

At voucher acceptance, one transaction must verify and persist
`0 <= S <= A <= T` and `(T - S) + R <= V`, where R is the configured claim
reserve and fee floor. `A - S` is outstanding actual charge; `T - S` is
authorization headroom. T is monotonic for the stable lineage and does not reset
after a claim or top-up.

`commitSettlement` must atomically write the batch commitment, complete the
optional payment-identifier reservation, update A and T, increment `version`,
install the next channel record, and release its operation lease. The complete
current record must equal the attempt's expected snapshot. Funding, A, S, T,
commitment lineage, version, and outpoint state must never move backward.

Genesis and verified top-up state is registered in the same transaction that
reserves the batch attempt and operation lease. A crash cannot leave an
unowned channel transition.

## On-Chain Transition Attempts

Claim, top-up, and refund builders must reserve a durable attempt against the
complete current channel record before broadcast. Only one unresolved attempt
may own a lane head. O(1) indexes by channel, operation lease, transaction, and
payment identifier must resolve the owner without scanning. An attempt record
must retain enough unsigned and signed transaction evidence to distinguish:

- not broadcast;
- broadcast outcome unknown;
- accepted with the expected successor or terminal refund;
- rejected or conclusively absent and safe to rebuild.

Applying a claim must verify one same-ID successor, derive its escrow address
from the verified successor script, atomically advance the address, outpoint,
and script, advance S by the gross claim D, reduce V by D, and preserve A and T.
Because a top-up preserves S, applying one must verify and preserve the current
address and script, atomically advance the outpoint, increase V, and preserve A,
S, and T. Applying a refund must verify that no same-ID successor exists and
close the lane. Each application is a compare-and-set on the attempt's expected
outpoint and accounting snapshot.

A timeout, process crash, RPC error, accepted-but-under-threshold result, or
unknown lineage after submission must leave the attempt
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

Terminal attempts remove signed transaction and handler-result copies after
commit while retaining the payment or commitment response needed for identical
retries. After the configured response-retention horizon, large cached results
may be replaced with a compact conflict response, but the transaction,
identifier, and channel replay tombstones remain. Security ownership is never
evicted to make quota space.

Stores must enforce configured aggregate record, aggregate byte, and
per-authenticated-payer limits before admitting a new attempt. Admission
reserves room for both terminal cached-response copies: the payment or
commitment record and the optional payment-identifier record. Exact payer
limits use the verifier-authenticated signer public key, never a per-request
authorization id or optional address label. Hitting a limit rejects new work;
it must not evict pending, recovery-required, or compact replay ownership.

There is still an unavoidable window when a process crashes after a
non-repeatable handler side effect but before it stages the result. Such handlers
must require `payment-identifier` and keep an application-owned idempotency or
transactional outbox table keyed by `paymentIdentifier` and
`requestFingerprint`. The handler returns that cached result on recovery while
the server store completes payment settlement.
