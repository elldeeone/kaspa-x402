# Live Testnet Report

Status: current `0.1.0-alpha.9` funded live harness run.

Generated: `2026-07-19T13:29:40.149Z`

Network: `kaspa:testnet-10`

Node: private TN10 node, Rusty Kaspa `2.0.0`, synced with UTXO index enabled.

Virtual DAA score at run start: `521091878`

The proof used the NodeJS SDK built from reviewed `rusty-kaspa` commit
`78257f273a26c4be085bab0f79437dee99ca8835`. It executed both alpha.9 exact
profiles, two additive head shards, conflict/retry, replay, recovery, external
head reconciliation, explicit expired-authorization rejection, and the full
batch lifecycle. The raw report and signing
material remain in an ignored owner-only local directory; this file contains
only sanitized public evidence. Hosted-gateway evidence is tracked separately
in `docs/testnet-gateway.md`.

## Controlled Funding Split

- Transaction id:
  `d6fde51748de5aecdc084ea0b7af79aade7a11f1ec09e5cf8651a08306fefa3d`
- Transaction version: `0` (`sdk-generated-transaction`)
- Requested controlled outputs: `16` at `500000000` sompi each

The split supplied independent funding inputs for conflict and recovery tests.
It did not disclose or copy wallet key material.

## Standard-Native Exact

### Tiny payment

- Transaction id:
  `e366df34ef29fa1538b42e934cfc79c1bb0e92c8930bdcfcd94038bdaccc59ec`
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
  `e69837b86eac42d5eb72790d319df40d7973ee11e401c9c6d362bad42e87ec43`
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

- `a5039d62b7bc3a608eee5552c3a9f9c102374eda47957e61faa58ec1bd836028:0`
- `18b4984ce0406d86deb90cd9d9aa61a935ea382cfe77c1149f36fbe4ee058738:0`

Each started at `100000000` sompi with a `10000000` sompi application
anti-churn threshold.

The primary additive payment proved:

- Transaction id:
  `e518f0465d24c3b2b15e21fa88db3b91c306d6ee780d354a2e021f99139175f2`
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
  `721e38b35d47871464be6b435737f08af06c5a322d4d7ad27a090fa7b306521c`
- Losing candidate:
  `9af250b482978a04b54231d839b2ef4549ff471f551f1b38e65a468a23648844`
- Refreshed retry:
  `9f4c42a81f89a3387cfd6800b75069c821642ef551d6326e6e90aca17a9a56aa`

Exactly one initial request returned `200`; the loser received a fresh `402`
and then settled successfully against refreshed head state. Protected work ran
twice total: once for the winner and once for the retry. Both registered head
chains were used during the complete run.

## Verification And Recovery

- A mutated request-authorization signature returned a corrective `402`
  `invalid_payload`; the protected handler ran zero times and no transaction
  was broadcast.
- A correctly signed request authorization with an expired `expiresAt` returned
  a corrective `402` `invalid_payload`; the protected handler ran zero times
  and no transaction was broadcast.
- Public verify-only calls rejected otherwise valid but unobserved exact
  transactions at the authenticated finality gate before direct settlement.
- Transaction
  `cc20fe70cad230db5cf56da73cd2d8bfd53cc02bfd8799524b9661319a13ecbf`
  was accepted by TN10 and then subjected to an injected post-broadcast runtime
  failure. A new server instance over the preserved state store reconciled the
  accepted output and executed the protected handler exactly once on retry.
- Transaction
  `7071c42a0045212e64a699e11bd160dd8f6ac234f41604c79fd53b0237104651`
  advanced a head outside the server state transition. Explicit trusted
  candidate evidence reconciled the durable head from version `2` to `3`; no
  address-only inference was used.

## Batch Deposit, Claim, Replay, And Refund

- Deposit transaction:
  `d46bfd1b61821dcb3405b58b77c63d513f6aa5dcb7e5907ea6990ee39b794da3`
- Deposit amount: `400000000` sompi
- First charge: `100000000` sompi
- Voucher-only second charge: `100000000` sompi
- Cumulative authorized charge: `200000000` sompi
- Claim transaction:
  `5f55b481ae540b282594b9e6dd59cc900d860a8135c46d94399422c5f3c653bb`
- Claim server output: `198000000` sompi
- Claim fee: `2000000` sompi
- Continuation amount: `200000000` sompi
- Absolute refund DAA: `521093678`
- Refund transaction:
  `b54110d380b63d90771c060b2a55b585d2f5e1b290ba6131bba11813dd1109e7`
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
- expired exact authorization rejected before protected work: passed
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
