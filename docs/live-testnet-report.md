# Live Testnet Report

Status: successful `0.1.0-alpha.11` funded live harness run.

Generated: `2026-08-27T07:29:18.493Z`

Network: `kaspa:testnet-10`

Node: operator-controlled private TN10 node, synced with UTXO index enabled.

Virtual DAA score at run start: `554570596`

The proof used the NodeJS SDK built from reviewed `rusty-kaspa` commit
`c338d495bec29e4dc8b5149f99e8db6fa916ed4a`. It executed all 18 required
Alpha.11 flows against fresh recovery state. The raw report and signing
material remain in an ignored owner-only local directory; this file contains
only sanitized public evidence.
Hosted-gateway evidence is tracked separately in `docs/testnet-gateway.md`.

## Controlled Funding Split

- Transaction id:
  `d913cc457f86c9a1cb860558e9411f199f99c8e644578470db92cc5c53861fc9`
- Transaction version: `0` (`sdk-generated-transaction`)
- Requested controlled outputs: `16` at `500000000` sompi each

The split supplied independent funding inputs for conflict and recovery tests.
It did not disclose or copy wallet key material.

## Standard-Native Exact

### Tiny payment

- Transaction id:
  `4f8f9611f4ca4fd8785ea714de7ed5a8610a43a9cf833a1dc9fbb2637e72bccc`
- Transaction version: `0`
- Advertised amount and merchant gain: `10000000` sompi
- Paid fee: `2000000` sompi
- Payer cost: `12000000` sompi
- Calculated contextual mass: `100049`
- SDK policy fee calculation at the selected network profile: `0`
- Finality: `accepted`
- Duplicate identical request: HTTP `200`, cached response, handler executed
  once total
- Re-authorized cross-request replay: HTTP `409`,
  `invalid_transaction_state`

### Normal payment

- Transaction id:
  `4314a68d74e3ce6ff94e98f4c282ff7f7b859729a45a0a5838690ab1fb432e49`
- Transaction version: `0`
- Advertised amount and merchant gain: `100000000` sompi
- Paid fee: `2000000` sompi
- Payer cost: `102000000` sompi
- Calculated contextual mass: `10512`
- SDK policy fee calculation: `1051200` sompi
- Finality: `accepted`
- Duplicate identical request: HTTP `200`, handler executed once total
- Re-authorized cross-request replay: HTTP `409`,
  `invalid_transaction_state`

In both cases the merchant output equalled the advertised amount exactly. The
tiny run records the accepted TN10 result and SDK policy calculation
separately; it does not claim a universal Kaspa minimum payment or fee.

## KIP-10 Additive Exact

Two independent head UTXOs were funded:

- `c52224f6038b493f365d011072c08fca181865e512b8753ff6da0400c4e09c49:0`
- `7744ae207d2ab85835d888e8e46b59c4b4e1fb55497edb1e0d1cd74b3a245b5f:0`

Each started at `100000000` sompi with a `10000000` sompi application
anti-churn threshold.

The primary additive payment proved:

- Transaction id:
  `85797f3e7d131da222bd65e2a1f66db5c2221a6a395addff6d6555db6a3afd3a`
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
  `319695e8deecbc817bcc0ac611e4a222f7c3f9dac6c4cbe7d552dcf02ad2cef9`
- Losing candidate:
  `95d87155332bf52f103dc1143af9ae2bf535897c69b152cedd212b08bf6ed24f`
- Refreshed retry:
  `df0924b33be60c63e8fd7d78d9f75244c158c015896ec5eef1e710bb8e2e6cd5`

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
  `554895e0b1e28af60c53d73cd3b2c5adecc85f4a89a3e4de6d3142b00a1f4215`
  was accepted by TN10 and then subjected to an injected post-broadcast runtime
  failure. A new server instance over preserved state reconciled it and ran the
  protected handler exactly once on retry.
- Transaction
  `5565a838e98408087253e4b148f03b117020ad04916481813a5c6d94da03854d`
  externally advanced a head. Trusted candidate evidence reconciled the
  durable head from version `2` to `3`; no address-only inference was used.

## KIP-20 Batch Lifecycle

Stable covenant ID:
`91dbe530cc1be2a7e317d5243c4c8767703d02537341de18fe9a8beb64bc0b3e`

### Singleton genesis and vouchers

- Deposit transaction:
  `bce74b4efe3b6d67762cf5d692815e2634d51c9f9a86732236200779b77a1946`
- Transaction version: `1`
- Singleton KIP-20 genesis independently verified: yes
- Funded covenant value after fee: `498000000` sompi
- Initial charge and signed lifetime ceiling: `100000000` sompi
- Voucher-only second charge and new lifetime ceiling: `200000000` sompi
- Finality: `accepted`

### Two partial claims against one voucher

- First claim transaction:
  `f73ae482b42a3d138f81a9e995ef1ebcefbbdac2e012a613a3abcd2160b2cf4d`
- First gross claim: `100000000` sompi
- First server output: `98000000` sompi
- First continuation value: `398000000` sompi
- Second claim transaction:
  `be1713e5ccfa4ccd0765bff3e600716b496861d5c28a0913ebe284a7c6a20b84`
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
  `c7e276ee393d4751fb8b4bd649ea3b2a944694743b5bc8989d69d53874ced15f`
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
- Absolute refund DAA: `554572396`
- Refund lock time: `554572397`
- Observed DAA at submission: `554572421`
- Refund transaction:
  `15b1638dace0f1c90171ab0c0528a3f281c37dc19ee0255c3c2411ab1b647e72`
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
