# Server Runtime Lock Contract

`ChannelLockManager` serializes work that can otherwise execute protected
handlers or settlement transitions concurrently. The in-memory implementation is
for a single server process. Production deployments that run more than one
server process for the same trust domain need a shared lock manager.

## Required Guarantees

- `runExclusive(key, fn)` must run only one `fn` at a time for the same key.
- A failed `fn` must release the key.
- Different keys may run concurrently.
- Lock acquisition and release must be visible to every process that can accept
  the same payment, channel, or payment identifier.

## Required Scopes

The direct-mode server uses the lock manager for:

- payment identifiers, keyed by the payment identifier extension id;
- batch channels, keyed by channel id;
- upto authorizations, keyed by network and client public key before settlement
  scopes are known;
- exact payments before verification, keyed by the payload's transaction hint or
  transaction bytes;
- exact payments after verification, keyed by the verifier-derived transaction
  id.

The post-verification exact lock is the handler-safety lock. Durable stores still
need unique transaction-id replay records because locks can expire, fail, or be
lost during process shutdown.
