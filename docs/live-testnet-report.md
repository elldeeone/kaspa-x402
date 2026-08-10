# Live Testnet Report

Status: current `0.1.0-alpha.10` funded live harness run.

Generated: `2026-08-10T06:40:53.040Z`

Network: `kaspa:testnet-10`

Node: operator-controlled private TN10 node, synced with UTXO index enabled.

Virtual DAA score at run start: `539852105`

The proof used the NodeJS SDK built from reviewed `rusty-kaspa` commit
`78257f273a26c4be085bab0f79437dee99ca8835`. It executed all 18 required
Alpha.10 flows. The raw report and signing material remain in an ignored
owner-only local directory; this file contains only sanitized public evidence.
Hosted-gateway evidence is tracked separately in `docs/testnet-gateway.md`.

## Controlled Funding Split

- Transaction id:
  `6c2cabaa5390c08ada7db41dec9c04bfce2c5953412dee9d31704c1e5b7913b1`
- Transaction version: `0` (`sdk-generated-transaction`)
- Requested controlled outputs: `16` at `500000000` sompi each

The split supplied independent funding inputs for conflict and recovery tests.
It did not disclose or copy wallet key material.

## Standard-Native Exact

### Tiny payment

- Transaction id:
  `3662cfaa56388a5d69c0cb6af9632ec4ed45a6b91d7b1903de28c49dfc917366`
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
  `5628ad52f8489279dbadf94d5f6cce60e8c34c4199210b947f25dcce9025d97e`
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
tiny run records the accepted TN10 result and SDK policy calculation
separately; it does not claim a universal Kaspa minimum payment or fee.

## KIP-10 Additive Exact

Two independent head UTXOs were funded:

- `397be8b71dee6e7622a49460deed265b034bc3a1cf07b33891293131bfba4d63:0`
- `ad5f70975b88da73f90776c763241fbf7967a4b60c56bd63cdbfa7cf1dbd2790:0`

Each started at `100000000` sompi with a `10000000` sompi application
anti-churn threshold.

The primary additive payment proved:

- Transaction id:
  `1a7f19ce3a8063a7dade02026b120a0a2e2d07e0dd508f6acca7d01d3f470ad9`
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
  `5f741e04445522ed4d5ce5c1e3c924213fe9ef375fec0ea5a5fdcde07eeeefad`
- Losing candidate:
  `17bb994eac2c9c0c7d0f85ce8a11ede6acfe71e201a2d99587a9ec838b76edb3`
- Refreshed retry:
  `8de9465702d3629af86a589c930916e08e915e0f1836ae2a77ef2d2c63f132fc`

Exactly one initial request returned `200`; the loser received a fresh `402`
and then settled successfully against refreshed head state. Protected work ran
twice total: once for the winner and once for the retry.

## Verification And Recovery

- Mutated and expired request authorizations each returned a corrective `402`
  `invalid_payload`; protected work ran zero times and no transaction was
  broadcast.
- Public verify-only calls rejected valid but unobserved exact transactions at
  the authenticated finality gate before direct settlement.
- Transaction
  `d3d39c239f87a6fd309fbce3ba9d2c2ac2ae0e104ec8a1bdd59cfb7e086e9e6a`
  was accepted by TN10 and then subjected to an injected post-broadcast runtime
  failure. A new server instance over preserved state reconciled it and ran the
  protected handler exactly once on retry.
- Transaction
  `81a3319e5aa4c422f99066462e5ff908f274238a9fda21d5bfe9a5ea692911af`
  externally advanced a head. Trusted candidate evidence reconciled the
  durable head from version `2` to `3`; no address-only inference was used.

## KIP-20 Batch Lifecycle

Stable covenant ID:
`adf6416e8308ae10b854f4ff1eb04f27139c50aafe98cb20a9e50b28c88eb8db`

### Singleton genesis and vouchers

- Deposit transaction:
  `4faa3fc2f90cc09e07aa03d112e089558c63fb28b2bb7c16d64ab8c52ce45668`
- Transaction version: `1`
- Singleton KIP-20 genesis independently verified: yes
- Funded covenant value after fee: `498000000` sompi
- Initial charge and signed lifetime ceiling: `100000000` sompi
- Voucher-only second charge and new lifetime ceiling: `200000000` sompi
- Finality: `accepted`

### Two partial claims against one voucher

- First claim transaction:
  `7037c2cea156cbe4947c716f6bd29ccf14a892d9214cf728f05ab597244bb317`
- First gross claim: `100000000` sompi
- First server output: `98000000` sompi
- First continuation value: `398000000` sompi
- Second claim transaction:
  `450a67b25e61bc3009e01723fa4a28352f076642eef940038fe35292a58f987e`
- Second gross claim: `50000000` sompi
- Second server output: `48000000` sompi
- Second continuation value: `348000000` sompi
- Lifetime gross claimed after both claims: `150000000` sompi
- Buyer-signed lifetime ceiling used for both claims: `200000000` sompi
- Claim fee per transaction: `2000000` sompi
- Finality: `accepted` for both claims

Both claims preserved the covenant ID while advancing the active outpoint and
state script. The second claim reused the same cumulative voucher without
exceeding its ceiling.

### Same-lineage top-up and restart reload

- Top-up transaction:
  `1c78135a1de56eb8d76304e01f7b22eab6760c737b9d72d2a344155fc460d4c3`
- Added value: `402000000` sompi
- Successor covenant value: `750000000` sompi
- Lifetime actual charge and new signed ceiling: `600000000` sompi
- Lifetime gross claimed remained: `150000000` sompi
- Finality: `accepted`

The top-up retained the same covenant ID and strictly increased the covenant
value. A fresh client/server runtime reloaded the genesis evidence, top-up
evidence, active outpoint, channel state, and the exact pre-broadcast claim
artifact. No open claim attempt survived the accepted top-up.

### Stale-head rejection and terminal refund

- A stale claim transaction against the spent genesis outpoint was submitted
  to TN10 and definitively rejected while the current continuation remained
  present.
- Absolute refund DAA: `539853905`
- Refund lock time: `539853906`
- Observed DAA at submission: `539853936`
- Refund transaction:
  `9557bf79fa621524db03d01bcc0f4f545ec9b4b9857642e2ba707d12cdae484f`
- Refund input: `750000000` sompi
- Refund output: `748000000` sompi
- Refund fee: `2000000` sompi
- Finality: `accepted`

The refund builder, persisted artifact, and broadcast transaction IDs matched.
Restart reconciliation reloaded the exact signed bytes and captured head,
applied the accepted attempt atomically, and did not rebroadcast.

Public TN10 REST independently returned all five batch transactions as accepted
version-1 native-subnetwork transactions with accepting block hashes.

## Required Flow Status

All 18 required flows passed:

- exact settlement, additive-head conflict/retry, idempotency, invalid and
  expired authorization rejection, restart recovery, and external advancement;
- verified singleton KIP-20 genesis, deposit-voucher, and voucher-only reuse;
- two partial claims using one cumulative voucher, same-lineage top-up, and
  durable restart reload;
- stale-head and cross-scheme replay rejection;
- terminal post-timeout refund with deterministic artifact recovery.

## Mainnet Read-Only And Offline Check

The latest separate mainnet read-only check reported a synced Rusty Kaspa
`2.0.1` node with UTXO index enabled beyond the recorded Toccata activation
score. `npm run proof:mainnet:offline` constructs and signs deterministic
synthetic standard-native v0 and additive v1 shapes without real UTXOs, funds,
transaction submission, spend, or broadcast.

This is compatibility evidence, not a mainnet readiness claim. Mainnet remains
blocked by `docs/mainnet-readiness.md`.
