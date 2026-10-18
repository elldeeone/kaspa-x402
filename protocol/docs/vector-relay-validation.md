# Transaction vector relay validation

The v1.0.0 positive transaction vectors passed consensus validation but several
paid less than Kaspa 2.1.0's default relay minimum. Consensus validity alone
does not establish that a normal node will accept a transaction for relay.

The corrected deterministic examples pay 300,000 sompi for standard-native and
additive exact, 500,000 for hash-chain transactions, and 1,000,000 for batch
transactions. Their signatures, IDs, preimages, successor links and HTTP
vectors are regenerated together. These are example fees, not a live fee
estimator; applications must obtain current node fee estimates.

`validate:tx-v1-consensus` now also compiles the pinned node's unmodified
`mining/src/mempool/check_transaction_standard.rs` and its default configuration.
A minimal wrapper supplies the configuration field because the upstream
`Mempool` type is crate-private. The harness does not copy its fee formula.
Mining policy and error sources are covered by the source-integrity checks.

For each positive transaction, the report separately records consensus
validation and default standardness/relay policy. Policy controls vary the
consensus-calculated fee field: minimum minus one must fail specifically for
insufficient fees, and the exact minimum must pass. Those controls are scoped
policy checks, not newly signed transactions or full mempool admission.

Run the release regression from the repository root:

```sh
KASPA_X402_KASPA_CONSENSUS_ROOT=/absolute/path/to/pinned-rusty-kaspa \
  RUSTUP_TOOLCHAIN=1.95.0 npm run proof:vector-relay-policy
```

It validates the complete current vector set, then generates and signs a
low-fee batch genesis through the public builder. The release validator must
reject that transaction specifically at relay policy after consensus succeeds.
The report retains the complete oracle output, the rejected vector and error.
CI and both release-validation commands require this proof.

`proof:live-input-preflight` also checks incomplete consumer bundles through
the reference adapter's entry point. Missing claim, top-up or refund vectors
must fail before SDK or wallet access, so missing test assets cannot strand a
newly funded channel.

This gate does not check live UTXO availability, conflicts, mempool load or
selected-chain acceptance. Funded Testnet proof remains a separate requirement.

The funded browser runner uses the existing hosted head and checks its UTXO
before funding a payer. It compares amount and version against that starting
head. The public demo also limits grant disclosure per caller per day; a ready
head does not guarantee that the caller is eligible for another grant. Use a
fresh local Worker with real Testnet transactions for repeated paid browser
proofs. Keep hosted admission failures as failures; do not relax deployed limits.

Live diagnostics also exposed a PNN snapshot race: the selected tip can leave
the chain while the UTXO read is in flight. The adapter now discards that
snapshot and allows up to three complete attempts per endpoint within the
existing request deadline. Only an explicitly non-selected block with the expected hash permits
that retry. Wrong hashes, missing chain flags, changed metadata and cancellation
still fail. Persistent movement also fails after the bound. Run
`npm run proof:pnn-snapshot` for the six transport E2E cases; CI and release
validation require them.

`--allow-dirty` labels a browser run as `development-worktree` and records its
diff and harness hashes. The default still requires a clean checkout for
release proof. Published v1.0.0 archives and tags remain historical artifacts;
corrected release evidence must identify the new candidate.
