# Controlled canonical consensus reorg check

Run from this repository:

```sh
KASPA_X402_KASPA_CONSENSUS_ROOT=/path/to/canonical/rusty-kaspa npm run validate:reorg-consensus
```

This requires Rust and a clean Rusty Kaspa checkout at
`c338d495bec29e4dc8b5149f99e8db6fa916ed4a` (`2.0.1`). The launcher shares the
existing tx-v1 oracle's pinned dependency versions and build cache. Successful
execution prints a JSON report.

The harness runs the canonical `TestConsensus` block/virtual-state pipeline
against a temporary database. It builds two branches containing conflicting
tx-v1 spends and asserts:

- The initial spend is accepted and its output exists before the reorg.
- The longer competing branch changes the selected sink and reports the
  removed and added blocks.
- The initial output disappears, the conflicting replacement output appears,
  and the funding outpoint remains spent.
- Added-chain acceptance includes the replacement and excludes the initial
  spend.
- A non-final tx-v1 input is rejected when containing DAA equals its lock time
  and succeeds at lock time plus one.

This is bounded local consensus evidence, not a live-network experiment. Proof
of work is skipped, deterministic block hashes are used, and simnet coinbase
maturity is reduced to two. The spends use `OP_TRUE` outputs; this does not
exercise the x402 covenant script, application rollback, RPC transport, node
synchronisation, or production reorg probability/depth.
