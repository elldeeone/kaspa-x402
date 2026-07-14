# Live Testnet Proof

Status: alpha proof definition for `kaspa:testnet-10`.

The live proof runner is `scripts/proof-live-testnet.mjs`. It validates a live
adapter result and writes ignored operational artifacts under
`.kaspa-x402-live/`. The committed reference adapter is
`scripts/live-adapter-reference.mjs`. It contains the Kaspa RPC, funding,
claim, replay, and refund wiring needed to reproduce the alpha proof, but it
does not contain wallet secrets, node URLs, or local machine paths.

Use `live-proof.env.example` as the starting config. Real runs must provide:

- `KASPA_X402_RPC_URL`;
- `KASPA_X402_FUNDING_WALLET`;
- `KASPA_X402_KASPA_WASM_MODULE`;
- `KASPA_X402_LIVE_CONFIRM=I_UNDERSTAND_THIS_USES_TESTNET_FUNDS`.

The reference adapter writes generated channel keys, payout keys, recovery
state, and reports under `KASPA_X402_DATA_DIR`. Keep that directory ignored.

## Required Flows

The current proof requires:

- standard-native exact settlement and replay rejection;
- additive exact settlement proving exact KIP-10 head delta and replay
  rejection;
- batch deposit-voucher settlement;
- batch voucher-only settlement;
- batch claim transaction construction and broadcast;
- replay rejection across exact and batch-settlement;
- batch refund transaction construction and broadcast after timeout.

Broadcast transaction evidence must include transaction ids, transaction
versions, version evidence source, and accepted-or-confirmed finality. Both
exact profiles must include transaction encoding, output index,
transaction-artifact hash, server broadcast result, and settlement id.
Additive evidence must identify the durable head and consumed outpoint and
prove that the successor increase equals the advertised payment exactly. Batch
claim and refund
evidence must reconcile inputs, outputs, charged amounts, fees, and continuation
or refund value.

## Safety Gates

The runner must fail closed when:

- the configured network is not `kaspa:testnet-10`;
- the operator has not explicitly confirmed live testnet execution;
- required RPC, funding, or adapter configuration is missing;
- required flow evidence is absent;
- transaction version evidence is missing or inconsistent;
- accepted-or-confirmed finality is missing for a broadcast transaction;
- batch claim or refund accounting does not reconcile.

## Reporting

Successful or blocked live runs should write `.kaspa-x402-live/report.json`.
The sanitized committed summary belongs in `docs/live-testnet-report.md`.
