# Live Testnet Report

Status: historical `0.1.0-alpha.10` funded live harness run. Alpha.11 funded
proof is pending.

Generated: `2026-08-10T07:21:05.896Z`

Network: `kaspa:testnet-10`

Node: operator-controlled private TN10 node, synced with UTXO index enabled.

Virtual DAA score at run start: `539876359`

The proof used the NodeJS SDK built from reviewed `rusty-kaspa` commit
`78257f273a26c4be085bab0f79437dee99ca8835`. It executed all 18 required
Alpha.10 flows. The raw report and signing material remain in an ignored
owner-only local directory; this file contains only sanitized public evidence.
Hosted-gateway evidence is tracked separately in `docs/testnet-gateway.md`.

## Controlled Funding Split

- Transaction id:
  `6840c8f0a5cb4ee578cd8b0ba25a7185d616bbc8135973f1e7156fed9b3a78d4`
- Transaction version: `0` (`sdk-generated-transaction`)
- Requested controlled outputs: `16` at `500000000` sompi each

The split supplied independent funding inputs for conflict and recovery tests.
It did not disclose or copy wallet key material.

## Standard-Native Exact

### Tiny payment

- Transaction id:
  `9de41db6e22752777ffec39ae91bcd490e92612a8f605321ed13b388546426b9`
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
  `11a457bcc56d03cdef0e2e223668d621927ca8066dfb8881b57bdcda36e9b461`
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

- `34ea914b619ebca49e729e0de74d9ea4724d4713013ab7e7e40d8e28e086476a:0`
- `467732e379f1e8f0b55ea155035997551a757b7fa1b1d4711f704ac15eae6307:0`

Each started at `100000000` sompi with a `10000000` sompi application
anti-churn threshold.

The primary additive payment proved:

- Transaction id:
  `f37e8b1eb594ced6f9c8260fb8758fec5a4605357a7deb8eafc46d8dd09e62e4`
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
  `916b26cab599e0b358c9f599a0b7e9f6bd073d235b5bef683d8e68e7317d5692`
- Losing candidate:
  `f1e721fa37487de66dacd778db42857947bad2ad415544be423e562418f8e18b`
- Refreshed retry:
  `2f91763e7f0395aac2022d7a8848386a9eb2bb98cae07a582ede85e90a9eb98a`

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
  `528db7c4e206932c45a4da922835335fd9c5cabd028bc1b29d084b3439539d05`
  was accepted by TN10 and then subjected to an injected post-broadcast runtime
  failure. A new server instance over preserved state reconciled it and ran the
  protected handler exactly once on retry.
- Transaction
  `fa5b8359e3a62562a35af48addb652d796158ed0f5ca906f2c1ec75247bac9f2`
  externally advanced a head. Trusted candidate evidence reconciled the
  durable head from version `2` to `3`; no address-only inference was used.

## KIP-20 Batch Lifecycle

Stable covenant ID:
`dd5abfed8d29acedc3e85b8a1f7da7f481e627927ee1820ac98e5645f9eb6302`

### Singleton genesis and vouchers

- Deposit transaction:
  `507d27fa5b4da6ed270a2a2e3c079e2efb63a6a72dc4f01c780eccdd516fb463`
- Transaction version: `1`
- Singleton KIP-20 genesis independently verified: yes
- Funded covenant value after fee: `498000000` sompi
- Initial charge and signed lifetime ceiling: `100000000` sompi
- Voucher-only second charge and new lifetime ceiling: `200000000` sompi
- Finality: `accepted`

### Two partial claims against one voucher

- First claim transaction:
  `63cf26a0b7f7709612ea05bc1689107a42a8c3e92cbc6c7a315b51d31dab5c33`
- First gross claim: `100000000` sompi
- First server output: `98000000` sompi
- First continuation value: `398000000` sompi
- Second claim transaction:
  `036b654b96c7137b948d0d9d8f6c306edc61d5c28cd1aea647096312b36631f9`
- Second gross claim: `50000000` sompi
- Second server output: `48000000` sompi
- Second continuation value: `348000000` sompi
- Lifetime gross claimed after both claims: `150000000` sompi
- Buyer-signed lifetime ceiling used for both claims: `200000000` sompi
- Claim fee per transaction: `2000000` sompi
- Finality: `accepted` for both claims

Both claims preserved the covenant ID while advancing the active outpoint,
state script, and derived P2SH address. The second claim reused the same
cumulative voucher without exceeding its ceiling.

### Same-lineage top-up and restart reload

- Top-up transaction:
  `90f04eeee0da64af6f555da30e19886bfd81072283827fbe819cdf98bb96ac62`
- Added value: `402000000` sompi
- Successor covenant value: `750000000` sompi
- Lifetime actual charge and new signed ceiling: `600000000` sompi
- Lifetime gross claimed remained: `150000000` sompi
- Finality: `accepted`

The top-up retained the same covenant ID, `S`, state script, and derived P2SH
address while advancing the outpoint and strictly increasing `V`. A fresh
client/server runtime reloaded the genesis evidence, top-up evidence, active
outpoint, channel state, and the exact pre-broadcast claim artifact. No open
claim attempt survived the accepted top-up.

### Stale-head rejection and terminal refund

- A stale claim transaction against the spent genesis outpoint was submitted
  to TN10 and definitively rejected while the current continuation remained
  present.
- Absolute refund DAA: `539878159`
- Refund lock time: `539878160`
- Observed DAA at submission: `539878185`
- Refund transaction:
  `1fc6d66d515942d54ff9652252f0a12addc09a3d63dbe59be80a6619738417c8`
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
