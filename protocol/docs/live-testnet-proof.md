# Live Testnet Proof

Paths and command examples on this page are relative to `protocol/`.
Use explicit paths for existing recovery files when changing working directories.

Development runs of the current source exercise escrow-v5/head-v2, whose
transaction signatures permit signer-chosen scopes while reference signers
default to ALL. The RC2 proof linked below exercised escrow-v4/head-v1. Run
a fresh funded proof for the replacement templates; do not attribute RC2
transactions to them. See the
[signature policy and template transition](versioning-policy.md#sighash-template-transition).

Status: proof definition used for the published RC2 `kaspa:testnet-10` release.
The completed 18-flow run and additional hosted hash-chain/browser checks
are recorded in the [RC2 release evidence](rc2-release.md#release-validation).

The live proof runner is `scripts/proof-live-testnet.mjs`. It validates a live
adapter result and writes ignored operational artifacts under
`.kaspa-x402-live/`. The committed reference adapter is
`scripts/live-adapter-reference.mjs`. It contains the Kaspa RPC, funding,
claim, top-up, replay, refund, and restart-recovery wiring needed to reproduce
the prerelease proof, but it does not contain wallet secrets, node URLs, or local
machine paths.

Use `live-proof.env.example` as the starting config. Real runs must provide:

- `KASPA_X402_RPC_URL`;
- `KASPA_X402_FUNDING_WALLET`;
- `KASPA_X402_KASPA_WASM_MODULE`;
- `KASPA_X402_LIVE_CONFIRM=I_UNDERSTAND_THIS_USES_TESTNET_FUNDS`.

The reference adapter writes generated channel keys, payout keys, recovery
state, and reports under `KASPA_X402_DATA_DIR`. Keep that directory ignored.

## Required Flows

The current proof requires:

- tiny and normal standard-native exact settlement;
- additive exact settlement proving exact KIP-10 head delta and replay
  rejection;
- two independent additive head shards;
- concurrent additive conflict with one winner and the unresolved loser held
  pending without a replacement signature;
- duplicate exact idempotency;
- invalid exact authorization rejection before protected work or broadcast;
- post-broadcast runtime re-instantiation and trusted settlement recovery;
- trusted external additive head advancement and reconciliation;
- singleton KIP-20 batch genesis verification and deposit-voucher settlement;
- batch voucher-only settlement bound to the stable covenant ID;
- two partial batch claims against the same lifetime cumulative voucher;
- a same-covenant-ID top-up after those claims;
- batch state reload after runtime restart, including accepted genesis/top-up
  evidence and any unresolved transition attempt;
- replay rejection across exact and batch-settlement;
- batch refund transaction construction after timeout, durable reservation of
  its exact signed bytes and deterministic transaction id before broadcast, and
  broadcast through the reserved artifact;
- restart reconciliation of an uncertain refund through trusted transaction
  evidence, without building or broadcasting a second refund.

Broadcast transaction evidence must include transaction ids, transaction
versions, version evidence source, and accepted-or-confirmed finality. Both
exact profiles must include transaction encoding, output index,
transaction-artifact hash, server broadcast result, and settlement id.
Additive evidence must identify the durable head and consumed outpoint and
prove that the successor increase equals the advertised payment exactly. Every
exact profile must reconcile merchant gain, payer cost, fee, and mass. Batch
evidence must retain one covenant ID from singleton genesis through repeated
claims and top-up, while advancing only the current outpoint. For every batch
step, report A (lifetime committed fixed charges), S (lifetime gross claimed),
T (latest buyer-signed lifetime ceiling), V (current covenant value), and R
(advertised minimum successor reserve), and prove `0 <= S <= A <= T` plus
`(T - S) + R <= V`. Claim, top-up, and refund evidence must reconcile inputs,
outputs, fees, successor state, and restart recovery without rerunning protected
work or rebroadcasting an unresolved or already accepted transition. Refund
evidence must also show that the builder transaction id, persisted transaction
id, and broadcast transaction id are identical, and that accepted application
atomically marks the channel refunded and the attempt applied.

Claim evidence must show that advancing `S` rotates the stateful script and its
derived P2SH address. Top-up evidence must show that preserving `S` preserves
both while the outpoint and `V` advance.

The sanitized committed report must identify the chain-evidence source class
and number of independently operated sources used for acceptance, confirmation,
UTXO, and selected-chain lineage decisions. Endpoint failover is not independent
corroboration. The v1 RC2 funded run may use one configured Testnet-10 source,
but the public report must state that boundary and must not present it as
mainnet or Byzantine-resilient evidence.

## Safety Gates

The runner must fail closed when:

- the configured network is not `kaspa:testnet-10`;
- the operator has not explicitly confirmed live testnet execution;
- required RPC, funding, or adapter configuration is missing;
- required flow evidence is absent;
- transaction version evidence is missing or inconsistent;
- accepted-or-confirmed finality is missing for a broadcast transaction;
- singleton genesis or stable covenant lineage cannot be independently
  verified;
- repeated-claim, top-up, refund, or A/S/T/V/R accounting does not reconcile;
- restart recovery loses accepted chain evidence, repeats protected work, or
  treats an unresolved transition as safely retryable;
- refund reconciliation changes the persisted transaction, accepts a mismatched
  transaction id or stale head, or rebroadcasts after an unknown result.

## Reporting

Successful or blocked live runs should write `.kaspa-x402-live/report.json`.
The sanitized committed summary belongs in `docs/live-testnet-report.md`.
