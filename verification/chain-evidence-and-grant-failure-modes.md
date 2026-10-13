# Chain evidence and grant availability: failure modes

Base: `6918defe91f5fd830c1a297aa72ce382c3428b94`.

## Grant admission and recovery

1. A signed caller with one unchanged funding outpoint obtains a private grant, withholds payment, waits for expiry, and obtains another head's private grant with the same outpoint.
2. A boolean admission callback allows disclosure without an atomic durable reservation; concurrent issuers can assign across separate ready heads to the same claimant or outpoint.
3. Restart, abandonment, expiry, and owner rotation lose claimant or outpoint qualification history, or an expired disclosed grant returns to ready and leaks its key again.
4. A single occupied head blocks all hash-chain service even when another independent ready head exists. Recovery without authenticated owner action or selected-chain acceptance can install an unaccepted guard.
5. Hash-chain recovery accidentally blocks ordinary exact and batch payments.

## Selected-parent depth

1. Fewer than 30 ordered selected-chain positions but a blue-score increase over 30 accepts a shallow genesis, payment, claim, top-up, or terminal refund.
2. Exactly 30 selected-chain positions with irregular blue scores are rejected, or persisted with a synthetic count of 30 instead of the measured depth.
3. The V2 request omits configured `minConfirmationCount`, or terminal refunds bypass depth through a different path.
4. Pagination, reorganization, checkpoint pinning, topology, covenant identity, and cancellation regress while depth is corrected.

## Chain-evidence trust

1. Protected authorization proceeds without an explicit chain trust choice.
2. Several failover URLs from one operator are miscounted as independent authorities.
3. One fabricated PNN view alone authorizes a payment under a corroboration policy; conflicting normalized origin, UTXO, acceptance, checkpoint, finality, or lineage evidence does not fail closed.
4. Submission cannot be separated from verification, or status/errors reveal endpoint credentials.
5. Explicit single-source Testnet use incorrectly requires a second node.

These are integration failure modes. The regressions exercise durable SQLite and mocked bounded PNN RPC responses through public adapter methods; they are not funded-network proof.

## Review regressions to close before deployment

1. A schema-v2 store contains an assigned grant written before durable admission fields existed and no admissions row. Reopening it must keep other heads readable, preserve authenticated retry and accepted-payment recovery, and quarantine an expired assignment without reissuing its key. Its old claimant must not bypass the new quota or reuse an unknown, still-unspent funding outpoint for another grant.
2. Two honest verification nodes report identical UTXOs or acceptance facts at adjacent selected tips. Corroboration must succeed without treating tip-dependent checkpoints or confirmation counts as a conflict. A wide DAA gap must reject, and the chosen corroborated DAA must never come from the lower tip. A genuine difference in the relevant UTXO, transaction, or accepting block must still reject.
3. With a two-of-three policy, a third successful authority reporting genuinely different authorization facts must still fail closed under the existing conflict policy; fewer than two available authorities must reject.
4. After an abandoned grant and quota expiry, the payer has both an unspent tombstoned UTXO and a fresh eligible UTXO. The later claim must reserve the fresh outpoint atomically, including across restart; a sole tombstoned UTXO must still reject.

## Final trust-boundary regression

1. A host passes a raw PNN client, `undefined`, or a type-cast raw client into a reusable protected authorization constructor. It must reject synchronously before chain I/O, protected work, or storage mutation.
2. Explicit trusted single-source mode must select a distinct verification client and authorize reads with one node.
3. Optional corroboration must require independent agreement for protected reads while routing transaction submission only through the separate submission client.
4. The gateway hash-chain evidence view must reject a raw client before preparing grant evidence storage.
5. Replacing a selected client's method or prototype method or verification target, mutating a captured authority record, or swapping an evidence object's client after construction must not redirect protected reads to a raw or duplicated authority.
