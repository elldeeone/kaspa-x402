# Server Store Contract

The reference `MemoryServerChannelStore` is for tests and examples. Production
servers need a durable implementation of `ServerStateStore` with the semantics
below.

## Required Guarantees

- Writes are durable before the method resolves.
- Failed writes leave no partial replay, idempotency, channel, or claim-attempt
  state.
- Compare-and-set checks and uniqueness checks happen in the same transaction as
  the write they protect.
- Records survive process restart and can be reloaded before retry recovery.

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

## Settlement State

`commitSettlement` must atomically write the batch commitment, optional payment
identifier, and next channel state only when the current channel still matches
the expected snapshot.

`saveClaimAttempt` must allow only one open claim attempt per channel.
`applyClaimAttempt` must update channel state only when the channel still
matches the attempt snapshot.

## Handler Side Effects

Payment verification happens before the protected handler. Durable payment
commit happens after the handler returns, and a commit failure can return `500`
after application work has already run.

Handlers that perform non-repeatable work should require `payment-identifier`
and keep an application-owned idempotency or outbox table keyed by
`paymentIdentifier` and `requestFingerprint`. The handler should return the
cached application result on retry, while the server store retries payment
settlement or replay commit.
