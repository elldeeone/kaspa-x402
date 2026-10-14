# Hash-chain issuer storage proof (#23)

Scope: exported `hash-chain-issuer` and Node `hash-chain-grants` entrypoints.
Exclude demo snapshots, Worker tables and demo journals.

Public seams: install/rotate heads, issue signed challenges, disclose grants,
record accepted payments/sweeps, compact storage, report capacity and reopen.
Use real SQLite transactions and two independent issuer connections; selected
chain observations are controlled offline inputs, not proof of live acceptance.

Failure modes to prove before each implementation slice:

- Aggregate heads/keys exceed record or byte limits even when each head is valid.
- Multiple instances or concurrent claims oversubscribe persistent capacity.
- Quota rejection leaves a partial key, funding, delivery or assignment record.
- Grant disclosure consumes the last space needed for settlement/recovery.
- Matching delivered retries stop working when new admissions are blocked.
- Restart resets capacity or silently changes the shared capacity policy.
- Terminal compaction removes replay, funding, key or head identity authority.
- Crash during compaction leaves partial state or destroys outstanding grants.
- Accepted owner rotation installs an oversized replacement or cannot record
  the selected successor when fresh key allocation is unavailable.
- A capacity-quarantined rotation forgets replacement key fingerprints, allowing
  them to be installed on another head after a capacity increase.
- Retired compaction drops public grant guards needed to recover a borrower
  spend after the accepted sweep reorgs out.
- Startup migration bypasses limits or destroys an oversized legacy store.
- Logical limits leave Node SQLite file growth unbounded.

Retain red and green JSON reports, including revision/source hashes, measured
file size, capacity, delivered retry/payment recovery and non-reuse results.
