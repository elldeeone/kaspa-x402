# Live Testnet Proof Harness

The committed live proof runner is `scripts/proof-live-testnet.mjs`. It is a
separate, opt-in executable for `kaspa:testnet-10` only and never requires a
hosted facilitator.

The runner validates configuration, calls a live adapter module, checks that all
required evidence is present, and writes an ignored operational report. The
committed reference adapter is `scripts/live-adapter-reference.mjs`. It provides
reviewable Kaspa RPC, funding, signing, claim, replay, and refund wiring, while
leaving node URLs, wallet material, SDK paths, generated channel keys, recovery
files, and reports in operator-provided environment/configuration and ignored
runtime directories. The public summary in `docs/live-testnet-report.md` is the
sanitized committed report.

## Current Required Flow

The runner requires live evidence for:

1. standard-native exact settlement and replay rejection;
2. KIP-10 additive-head settlement whose successor delta equals the exact
   advertised amount, plus replay rejection;
3. batch deposit-voucher settlement;
4. batch voucher-only settlement;
5. batch partial claim construction and broadcast, followed by reuse of the
   same lifetime voucher for a second claim;
6. batch top-up with the same KIP-20 covenant id;
7. replay rejection across exact and batch-settlement;
8. batch refund construction and broadcast after timeout.

The live result must state transaction ids, transaction versions, version
evidence source, finality for every broadcast transaction, final rejection for
the replay attempt, outpoints, charged amounts, top-level settlement amounts,
Kaspa extension charged amounts, cumulative charge before/after values, replay
outcomes, and refund/claim evidence where applicable. Both exact profiles must
include the transaction encoding, canonical payment output index,
transaction-artifact hash, server broadcast result, final settlement
transaction id, and transaction-version evidence. Additive evidence must also
identify the durable head/version and consumed outpoint and prove
`successorAmount - headAmount == advertisedAmount`. Claim evidence must
reconcile the funding input, covenant id, previous on-chain lifetime settled
amount, outstanding actual charge, claim amount, provider output, fee, successor
state/value, and new current outpoint. Top-up evidence must preserve the
covenant id and state while increasing value. Refund evidence must reconcile
the current input, terminal same-id count, refund amount, and fee. Batch
voucher-only evidence must prove it continues the same channel and covenant id
while using the persisted current outpoint.

## Report And Recovery Files

With `--write-report`, the runner writes:

- `.kaspa-x402-live/report.json` for successful or blocked check output;
- `.kaspa-x402-live/recovery.json` for blocked or failed runner state.

The reference adapter also writes generated channel and payout keys under
`KASPA_X402_DATA_DIR`. These files are ignored by git because they can contain
operational metadata and signing material. The committed sanitized summary is
`docs/live-testnet-report.md`.

The runner's recovery file is not a resumable transaction journal. A production
or release-candidate live adapter should maintain its own pre-submit recovery
record with:

- network;
- template id;
- client public key;
- server public key;
- refund timeout DAA score;
- escrow address;
- covenant id and verified singleton-genesis evidence;
- active outpoint;
- active script public key;
- funding amount in sompi;
- charged and settled lifetime totals in sompi;
- latest signed cumulative voucher amount in sompi;
- latest voucher signature;
- submitted transaction ids;
- whether the replay attempt was rejected.

## Safety Gates

- Refuse to run any network other than `kaspa:testnet-10`.
- Refuse `--live` unless the operator supplies the required RPC, funding,
  Kaspa WASM SDK module, adapter, network, and confirmation environment
  variables.
- Refuse to accept a live result that omits required flow evidence.
- Refuse to accept missing or inconsistent transaction-version evidence.
- Refuse to accept missing accepted-or-confirmed finality for funding,
  settlement, claim, or refund transactions.
- Refuse any batch arithmetic value above signed-int64 maximum.
- Refuse to claim more than either outstanding actual charges or remaining
  voucher authorization.
- Refuse a claim unless the continuation equals `inputAmount - claimAmount`
  and the fee reduces only the provider output.
- Refuse a top-up that changes covenant id or state, or fails to increase the
  active covenant value.
- Refuse to accept a claim or refund report whose input/output/fee accounting
  does not reconcile with the active charged amount and continuation amount.
- Refuse to publish if the script public key differs from the fixture-derived value.
- Adapter implementations should refuse to run if their own recovery journal
  exists and the operator has not chosen resume or reset.
