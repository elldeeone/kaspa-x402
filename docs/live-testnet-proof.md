# Live Testnet Proof

The proof workflow has two paths:

- offline proof, which runs locally against mock adapters and deterministic covenant vectors;
- live testnet proof, which requires an explicit RPC, wallet, and adapter module.

Run the offline proof after building packages:

```sh
npm run build
npm run proof:offline
```

To inspect live readiness without broadcasting transactions:

```sh
npm run proof:live:check -- --config-file live-proof.env.example --write-report
```

With `--write-report`, the live check writes `.kaspa-x402-live/report.json` and, when blocked, `.kaspa-x402-live/recovery.json`. These files are ignored by git because they may contain operational metadata.

The sanitized live testnet result is recorded in [live-testnet-report.md](./live-testnet-report.md).

The empty example config is a template, so this command exits nonzero until the required live values are supplied. Add `--allow-blocked` only when you want to write/read the blocked report without using the command as a readiness gate.

For a real live run, provide a module through `KASPA_X402_LIVE_ADAPTER_MODULE`.
The module must export `runLiveProof(context)` and is responsible for binding
real Kaspa RPC, funding, signing, transaction broadcast, and finality
observation. The runner passes the required live flow list, validates the
returned evidence for every required flow, and writes the result into the
report. The adapter used for the current committed report is not part of the
public package boundary, so the report is testnet evidence rather than an
independently reproducible release artifact.

The live runner refuses `--live` unless all of the following are set:

```sh
KASPA_X402_NETWORK=kaspa:testnet-10
KASPA_X402_RPC_URL=<testnet rpc endpoint>
KASPA_X402_FUNDING_WALLET=<testnet wallet/account reference>
KASPA_X402_LIVE_ADAPTER_MODULE=<adapter module path or package>
KASPA_X402_LIVE_CONFIRM=I_UNDERSTAND_THIS_USES_TESTNET_FUNDS
```

The required live flows are exact payment and replay rejection, upto zero-charge authorization, upto nonzero settlement, batch deposit-voucher settlement, batch voucher-only settlement, batch claim construction and broadcast, replay rejection across all schemes, and batch refund construction and broadcast after timeout.

The live result must state the transaction version, version-evidence source, and
accepted-or-confirmed finality for every broadcast transaction. The nonzero
upto settlement, batch claim, batch replay attempt, and batch refund paths must
be transaction v1; zero-charge upto settlement must explicitly report that no
settlement transaction exists while still reporting finality for the funding
authorization. Batch deposit-voucher and voucher-only evidence must include
actual charge, top-level settlement amount, `extensions.kaspa.chargedAmount`,
and cumulative charge before/after values. Voucher-only evidence must also
prove it is continuing the same channel and active outpoint opened by the
deposit-voucher flow. Batch claim evidence must reconcile funding input,
previously claimed cumulative amount, active charged amount, claimed amount,
server output, fee, and continuation amount. Batch refund evidence must
reconcile the continuation input, refund amount, and fee.
Accepted version-evidence sources are `sdk-generated-transaction` for SDK funding transactions and `adapter-submitted-transaction-shape` for locally assembled covenant transactions.
