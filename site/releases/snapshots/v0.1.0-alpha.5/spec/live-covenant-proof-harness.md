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

1. exact payment and replay rejection;
2. exact alpha.5 `transactionId` plus `paymentOutputIndex` evidence and legacy
   serialized-transaction payload rejection;
3. batch deposit-voucher settlement;
4. batch voucher-only settlement;
5. batch claim construction and broadcast;
6. replay rejection across exact and batch-settlement;
7. batch refund construction and broadcast after timeout.

The live result must state transaction ids, transaction versions, version
evidence source, finality for every broadcast transaction, final rejection for
the replay attempt, outpoints, charged amounts, top-level settlement amounts,
Kaspa extension charged amounts, cumulative charge before/after values, replay
outcomes, and refund/claim evidence where applicable. Claim evidence must
reconcile the funding input, previous claimed cumulative amount, active charged
amount, claim amount, server output, fee, and continuation amount. Refund
evidence must reconcile the continuation input, refund amount, and fee. Batch
voucher-only evidence must prove it continues the same channel and active
outpoint opened by the deposit-voucher flow.

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
- active outpoint;
- active script public key;
- funding amount in sompi;
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
- Refuse to claim more than the latest voucher amount.
- Refuse to claim when the continuation output would be below `inputAmount - voucherAmount`.
- Refuse to accept a claim or refund report whose input/output/fee accounting
  does not reconcile with the active charged amount and continuation amount.
- Refuse to publish if the script public key differs from the fixture-derived value.
- Adapter implementations should refuse to run if their own recovery journal
  exists and the operator has not chosen resume or reset.
