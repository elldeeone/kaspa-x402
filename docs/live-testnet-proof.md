# Live Testnet Proof

Status: alpha proof definition for `kaspa:testnet-10`.

The live proof runner is `scripts/proof-live-testnet.mjs`. It validates an
operator-provided adapter result and writes ignored operational artifacts under
`.kaspa-x402-live/`. It does not contain wallet secrets or node-specific
transaction logic.

## Required Flows

The current proof requires:

- exact payment and exact replay rejection;
- batch deposit-voucher settlement;
- batch voucher-only settlement;
- batch claim transaction construction and broadcast;
- replay rejection across exact and batch-settlement;
- batch refund transaction construction and broadcast after timeout.

Broadcast transaction evidence must include transaction ids, transaction
versions, version evidence source, and accepted-or-confirmed finality. Batch
claim and refund evidence must reconcile inputs, outputs, charged amounts,
fees, and continuation or refund value.

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
