# Live Testnet Report

Status: current `0.1.0-alpha.8` funded live harness run.

Generated: `2026-07-15T07:59:45.026Z`

Network: `kaspa:testnet-10`

Node: private TN10 node, Rusty Kaspa `2.0.0`, synced with UTXO index enabled.

Virtual DAA score at run start: `517436398`

The proof used the NodeJS SDK built from reviewed `rusty-kaspa` commit
`78257f273a26c4be085bab0f79437dee99ca8835`. It executed both alpha.8 exact
profiles, two additive head shards, conflict/retry, replay, recovery, external
head reconciliation, and the full batch lifecycle. The raw report and signing
material remain in an ignored owner-only local directory; this file contains
only sanitized public evidence. Hosted-gateway evidence is tracked separately
in `docs/testnet-gateway.md`.

## Controlled Funding Split

- Transaction id:
  `62e2ee64940860e8ae4712e6237a2ebd24271e81d80e1ba625e67a42ca5e62d7`
- Transaction version: `0` (`sdk-generated-transaction`)
- Requested controlled outputs: `16` at `500000000` sompi each

The split supplied independent funding inputs for conflict and recovery tests.
It did not disclose or copy wallet key material.

## Standard-Native Exact

### Tiny payment

- Transaction id:
  `e520bb2dbf8b4d349a1101cfe18820424979a2df90604d78bce9a0687f47ef61`
- Transaction version: `0`
- Advertised amount and merchant gain: `10000000` sompi
- Paid fee: `2000000` sompi
- Payer cost: `12000000` sompi
- Calculated contextual mass: `100000`
- SDK policy fee calculation at the selected network profile: `10000000`
- Finality: `accepted`
- Duplicate identical request: HTTP `200`, cached response, handler executed
  once total
- Re-authorized cross-request replay: HTTP `409`,
  `invalid_transaction_state`

### Normal payment

- Transaction id:
  `e7c112402568f0baaab752215c0fdf07fb8fc2f4ee690ae9bfda62fb47282dc8`
- Transaction version: `0`
- Advertised amount and merchant gain: `100000000` sompi
- Paid fee: `2000000` sompi
- Payer cost: `102000000` sompi
- Calculated contextual mass: `10000`
- SDK policy fee calculation: `1000000` sompi
- Finality: `accepted`
- Duplicate identical request: HTTP `200`, handler executed once total
- Re-authorized cross-request replay: HTTP `409`,
  `invalid_transaction_state`

In both cases the merchant output equalled the advertised amount exactly. The
tiny run records the actual accepted TN10 result and the SDK policy calculation
separately; it does not claim a universal Kaspa minimum payment or fee.

## Corrected KIP-10 Additive Exact

Two independent head UTXOs were funded:

- `4c7b5ab205362605d0162d9b91ccabcdf0fffabc8b7cffcd8c0122ef2f390373:0`
- `51d357a7a6da074edc5cc37f9d2da2e66e0de4979a2888c3e953a6be3550f0a5:0`

Each started at `100000000` sompi with a `10000000` sompi application
anti-churn threshold.

The primary additive payment proved:

- Transaction id:
  `ebd5bc67064941ce43fa057f2f18a3fcf07d46ed89fc880cdeb9e144352a5bd0`
- Transaction version: `1`
- Prior head amount: `100000000` sompi
- Successor amount: `200000000` sompi
- Advertised amount and sole merchant gain: `100000000` sompi
- Paid fee: `2000000` sompi
- Payer cost: `102000000` sompi
- Calculated mass: `1286`
- Compute budgets: head input `10`, payer input `10`
- Finality: `accepted`
- Duplicate identical request: cached without rerunning the handler
- Re-authorized cross-request replay: HTTP `409`,
  `invalid_transaction_state`

There was no separate merchant payment output. The KIP-10 successor delta was
the payment.

## Concurrent Head Conflict And Retry

Two different signed transactions raced the same version-0 head:

- Winner:
  `02e0a5975a4f75add885bd3691ba588a859b9cead4a897788f5ae496cb1e059a`
- Losing candidate:
  `55cc209943f591f8fba595590c3e479baeac0b0b73fe9099a29f0bfbe793f81d`
- Refreshed retry:
  `63cf00c9b9e99d138339a91b3d441fdc597f915e61c3edcc86f2ad9253291268`

Exactly one initial request returned `200`; the loser received a fresh `402`
and then settled successfully against refreshed head state. Protected work ran
twice total: once for the winner and once for the retry. Both registered head
chains were used during the complete run.

## Verification And Recovery

- A mutated request-authorization signature returned a corrective `402`
  `invalid_payload`; the protected handler ran zero times and no transaction
  was broadcast.
- Public verify-only calls rejected otherwise valid but unobserved exact
  transactions at the authenticated finality gate before direct settlement.
- Transaction
  `24d00a37199d66a7802f4d2cab36ca33fb1ea91391c66b132df5b982a3e62911`
  was accepted by TN10 and then subjected to an injected post-broadcast runtime
  failure. A new server instance over the preserved state store reconciled the
  accepted output and executed the protected handler exactly once on retry.
- Transaction
  `e09c0e5a929e33da4c7141a111c4c85e44aabb1342581f3c1987753388dc9834`
  advanced a head outside the server state transition. Explicit trusted
  candidate evidence reconciled the durable head from version `2` to `3`; no
  address-only inference was used.

## Batch Deposit, Claim, Replay, And Refund

- Deposit transaction:
  `6f8331ebb87424daa29ec555b86464d790c446dea24f92ef70e2e6392960eacd`
- Deposit amount: `400000000` sompi
- First charge: `100000000` sompi
- Voucher-only second charge: `100000000` sompi
- Cumulative authorized charge: `200000000` sompi
- Claim transaction:
  `c9d15639401bd2c88c1277cfed838e69a1470b6b2bbd003b5eacb4bd5647a16f`
- Claim server output: `198000000` sompi
- Claim fee: `2000000` sompi
- Continuation amount: `200000000` sompi
- Absolute refund DAA: `517438198`
- Refund transaction:
  `e47f3e8f64006d71ecd3f89f97852e9ec05547241fa943cd45b11993cb2d120a`
- Refund amount: `198000000` sompi
- Refund fee: `2000000` sompi

The old voucher/script epoch was rejected by TN10. The claim continuation
equalled deposit funding minus the authorized cumulative claim, and the
server-paid fee reduced the payout rather than the continuation. The harness
waited until contextual DAA was strictly greater than the absolute timeout
before submitting the refund.

## Required Flow Status

- tiny and normal standard-native exact settlement: passed
- corrected KIP-10 additive exact-delta settlement: passed
- multiple additive head shards: passed
- concurrent additive conflict and loser refresh: passed
- duplicate exact settlement idempotency: passed
- invalid exact signature rejected before protected work: passed
- post-broadcast runtime restart and trusted settlement reconciliation: passed
- external additive head advancement and trusted reconciliation: passed
- batch deposit and voucher-only settlement: passed
- batch claim, old-voucher rejection, and post-timeout refund: passed

## Mainnet Read-Only And Offline Check

The supplied mainnet node was queried over gRPC without any transaction method.
At the check it reported:

- network: `mainnet`
- Rusty Kaspa version: `2.0.1`
- synced: `true`
- UTXO index: `true`
- virtual DAA score: `486826858`
- priority and normal fee estimates: `100` sompi/gram

The DAA score is beyond the recorded Toccata activation score `474165565`.

`npm run proof:mainnet:offline` then constructed and signed deterministic
synthetic shapes with no real UTXOs or funds and no broadcast path:

- standard-native v0 synthetic id:
  `b0e2802776efb3a67a278d302321fdcc2c1df853416bfd2ae67b7b9276df234c`,
  mass `11717`, exact merchant gain `100000000`, payer cost `102000000`;
- additive v1 synthetic id:
  `1fde93aa9831030efca60a1e3db4b900b8f0f41f42f40e83f9285dbc4ad1d6c9`,
  mass `1286`, exact successor delta `100000000`, payer cost `102000000`.

No mainnet wallet, real signature authority, UTXO, transaction submission,
spend, or broadcast was used. This is compatibility evidence, not a mainnet
readiness claim. Mainnet remains blocked by `docs/mainnet-readiness.md`.
