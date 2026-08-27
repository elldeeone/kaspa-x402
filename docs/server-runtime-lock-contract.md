# Server Runtime Lock Contract

`ChannelLockManager` serializes work that can otherwise execute protected
handlers or competing settlement transitions concurrently. The in-memory
implementation is for a single server process. Production deployments that run
more than one server process for the same trust domain need a shared lock
manager.

## Required Guarantees

- `runExclusive(key, fn)` runs only one `fn` at a time for the same key.
- A failed `fn` releases the key.
- Different keys may run concurrently.
- Lock acquisition and release are visible to every process that can accept the
  same payment, covenant lineage, or payment identifier.

## Required Scopes

The direct-mode server uses the lock manager for:

- payment identifiers, keyed by the payment identifier extension id;
- batch setup, keyed by channel id until singleton genesis is registered;
- active batch work and claim, top-up, or refund transitions, keyed by stable
  `covenantId` once known;
- exact payments before verification, keyed by the payload's transaction-id
  evidence;
- exact payments after verification, keyed by the verifier-derived transaction
  id.

All access paths that can mutate one Alpha.11 batch lane must resolve to the same
stable lineage key. The rotating current outpoint is persisted and compared,
but must not be used as the only lock key because claim and top-up transactions
replace it.

## Durable State Still Decides

The post-verification exact lock is the handler-safety lock. Durable stores still
need unique transaction-id replay records because locks can expire, fail, or be
lost during process shutdown.

The same rule applies to batch lanes. A lock does not prove which transaction
won an outpoint race and does not recover a KIP-20 head. Claim, top-up, and refund
must reserve durable crash-safe attempts, compare the expected current outpoint
and A/S/T/V snapshot atomically, and reconcile uncertain broadcasts before the
lane is unlocked for more work. Standard RPC has no covenant-id-to-current-UTXO
reverse lookup, so recovery follows persisted transaction lineage.
