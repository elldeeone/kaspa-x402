# Live Testnet Report

Template scope: the RC2 release and its funded/hosted evidence use escrow-v4
and hash-chain-head-v1. Development escrow-v5/head-v2 allow signer-chosen
sighash types, with ALL as the reference signing default, and require fresh
funded proof before a release claim. See the
[signature policy and template transition](versioning-policy.md#sighash-template-transition).

## RC2 — Current Published Release

`1.0.0-rc.2` was published on 2026-10-01 from
`724c5fff22de500fcf729c43b59d25036fbffa9c`. Its fresh funded proof completed
at `2026-10-01T03:29:38.675Z` with all 18 exact, batch, recovery, and refund
flow statuses passed. Separate public gateway checks passed native exact,
batch deposit/voucher/retry, and three browser hash-chain payments across
owner rotation. Native, batch, and hash-chain retries returned the same
settlements after redeployment. Linux/Windows CI and `validate:release`
passed on the exact source commit.

The hosted RC2 gateway uses configured Testnet-10 PNN/WSS nodes for its chain
evidence. It does not depend on the public REST transaction index. The proofs
use configured public nodes, without independent-node corroboration or mainnet
proof.

See the [RC2 release reference](rc2-release.md) and
[published evidence and checksums](https://github.com/elldeeone/kaspa-x402/releases/tag/v1.0.0-rc.2)
for the current report, source pins, package bytes, and funded transaction IDs.

## Historical RC1 Run — 2026-09-13

The record below describes `1.0.0-rc.1`. Its source, node, compiler, and
transaction IDs belong to that earlier run and are retained as history.

Generated: `2026-09-13T12:32:38.284Z`

Network: `kaspa:testnet-10`

Node: public TN10 websocket node with UTXO and selected-chain access.

Evidence-source boundary: the run trusted one configured public Testnet-10
source for acceptance, confirmation, UTXO, and selected-chain evidence. This is
funded prerelease test evidence, not independently corroborated or
Byzantine-resilient chain evidence, and it does not satisfy the mainnet gate.

Virtual DAA score at run start: `569440535`

Virtual DAA score at batch start: `569441204`

The proof used the NodeJS SDK built from reviewed `rusty-kaspa` commit
`c338d495bec29e4dc8b5149f99e8db6fa916ed4a`. The v1 RC1 covenant fixture was
compiled with official SilverScript v1.0.0 commit
`3ed973335b59269293564805cc2c58a14595ec03`; its compiled bytecode SHA-256
remained `49e6d7da1c59afc51949ba43c2682047aa0c487a586e143bc9addc62e08e3df3`,
and the resulting launch identity is
`863cbb4cb94e0e2458ee96a74a204de0508fa35e318438c85db018bc8f86c083`.
The payment runtime source matched commit
`8284780efd055d22d0685f790df3a26bc2c2e85a`; the live driver included the
release-evidence correction that rebases the refund timeout from authoritative
chain state immediately before the batch flow.
The run executed all 18 required v1 RC1 flows against fresh recovery state.
The raw report and signing material remain in an ignored owner-only local
directory; this file contains only sanitized public evidence.
Hosted-gateway evidence is tracked separately in `docs/testnet-gateway.md`.

### Controlled Funding Split

- Transaction id:
  `77af9219fb9fe5ab70506ac7443c43901436157bff8204c02909a60c0c00a77e`
- Transaction version: `0` (`sdk-generated-transaction`)
- Requested controlled outputs: `16` at `500000000` sompi each

The split supplied independent funding inputs for conflict and recovery tests.
It did not disclose or copy wallet key material.

### Standard-Native Exact

#### Tiny payment

- Transaction id:
  `b46de1e1ffc502c69003043e81f7f3c98e49b402a836eb0012300487b2b77b7c`
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

#### Normal payment

- Transaction id:
  `850a5a61a2fba4d0db75488d0e568c9411a7736adbc53aa60836445c11e51508`
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

### KIP-10 Additive Exact

Two independent head UTXOs were funded:

- `379432e30af200985148a934b7eaa13de5980ef8cadaa6e7fd75b4aa0823bbd4:0`
- `d35efc44a35f20fcc9a74b3ac18faf16e9d8c2e1baa6457c4bdc452dfe0d10e2:0`

Each started at `100000000` sompi with a `10000000` sompi application
anti-churn threshold.

The primary additive payment proved:

- Transaction id:
  `551c439231ae4fbce814fb815f0a2c6ad91a9cfc2904aec303de037c9516ca59`
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

### Concurrent Head Conflict And Retry

Two different signed transactions raced the same version-0 head:

- Winner:
  `58825daa82001098fe5fc31bdf4213c4cf09dbb5ee3b6677a4a21306d1eab9e2`
- Losing candidate:
  `ea223755016746851bac229824b3ac5a82c1f1606ef0da3f5c49fc511a1b1d3b`

Exactly one request returned `200`; the loser received a corrective `402` and
remained durably pending until authoritative reconciliation. No replacement
was admitted and protected work ran once.

### Verification And Recovery

- Mutated and expired request authorizations each returned a corrective `402`
  `invalid_payload`; protected work ran zero times and no transaction was
  broadcast.
- Public verify-only calls rejected valid but unobserved exact transactions at
  the authenticated finality gate before direct settlement.
- Transaction
  `c4e5700e43564ace7db8d60e35daa9219a44ee39cc3a62fc5a38e5c403eea1ad`
  was accepted by TN10 and then subjected to an injected post-broadcast runtime
  failure. A new server instance over preserved state reconciled it and ran the
  protected handler exactly once on retry.
- Transaction
  `d1efef8017f5da9ddd9bdd20aaf9ebf687cb9f7614e1ca24fde754b1369587a1`
  externally advanced a head. Trusted candidate evidence reconciled the
  durable head from version `1` to `2`; no address-only inference was used.

### KIP-20 Batch Lifecycle

Stable covenant ID:
`a3d8472d6e2854190078ab420ecf7e7ca3ef99d79980080d062d5ddfd256065d`

#### Singleton genesis and vouchers

- Deposit transaction:
  `0ea2a1b1ae8344101fe62b9006b3191b9da230c47512a48eddf83167f7cec4b0`
- Transaction version: `1`
- Singleton KIP-20 genesis independently verified: yes
- Funded covenant value after fee: `498000000` sompi
- Initial charge and signed lifetime ceiling: `100000000` sompi
- Voucher-only second charge and new lifetime ceiling: `200000000` sompi
- Finality: `accepted`

#### Two partial claims against one voucher

- First claim transaction:
  `12afb363911621ecb7c1132f207c534927901a8000fc17c5aa84dbf0238eeb11`
- First gross claim: `100000000` sompi
- First server output: `98000000` sompi
- First continuation value: `398000000` sompi
- Second claim transaction:
  `a0ade45bc79cd36fe42f92b70c7c14a576e2138ac6d3dabe78a86cbfb59d195b`
- Second gross claim: `50000000` sompi
- Second server output: `48000000` sompi
- Second continuation value: `348000000` sompi
- Lifetime gross claimed after both claims: `150000000` sompi
- Buyer-signed lifetime ceiling used for both claims: `200000000` sompi
- Claim fee per transaction: `2000000` sompi
- Finality: `confirmed` for both claims

Both claims preserved the covenant ID while advancing the active outpoint,
state script, and derived P2SH address. The second claim reused the same
cumulative voucher without exceeding its ceiling.

#### Same-lineage top-up and restart reload

- Top-up transaction:
  `88def5fa31056610167781874a2a05439f804eed8d48320a01211bf40b357fd9`
- Added value: `400000000` sompi
- Successor covenant value: `748000000` sompi
- Lifetime committed fixed charges and new signed ceiling: `498000000` sompi
- Lifetime gross claimed remained: `150000000` sompi
- Finality: `accepted`

The top-up retained the same covenant ID, `S`, state script, and derived P2SH
address while advancing the outpoint and strictly increasing `V`. A fresh
client/server runtime reloaded the genesis evidence, top-up evidence, active
outpoint, channel state, and the exact pre-broadcast claim artifact. No open
claim attempt survived the accepted top-up.

#### Stale-head rejection and terminal refund

- A stale claim transaction against the spent genesis outpoint was submitted
  to TN10 and definitively rejected while the current continuation remained
  present.
- Rejected stale-claim transaction:
  `9c7c31d0c640ca6bdb877bfd7c73e0cada8495a349c254f23181df5552629eff`
- Absolute refund DAA: `569443004`
- Refund lock time: `569443005`
- Observed DAA at submission: `569443201`
- Refund transaction:
  `7d49b1dcb8dabd31491ea0bd64b41c623c8ee09ee669e970e37a87426cd3ab4e`
- Refund input: `748000000` sompi
- Refund output: `746000000` sompi
- Refund fee: `2000000` sompi
- Finality: `confirmed`

The refund builder, persisted artifact, and broadcast transaction IDs matched.
Restart reconciliation reloaded the exact signed bytes and captured head,
applied the accepted attempt atomically, and did not rebroadcast.

The harness authenticated the version-1 batch transactions against selected
chain evidence and required the configured confirmation threshold before
reporting confirmed finality.

### Required Flow Status

All 18 required flows passed:

- exact settlement, additive-head conflict/retry, idempotency, invalid and
  expired authorization rejection, restart recovery, and external advancement;
- verified singleton KIP-20 genesis, deposit-voucher, and voucher-only reuse;
- two partial claims using one cumulative voucher, same-lineage top-up, and
  durable restart reload;
- stale-head and cross-scheme replay rejection;
- terminal post-timeout refund with deterministic artifact recovery.

The funding wallet retained `58689925100` sompi after the run.

### Mainnet Read-Only And Offline Check

The latest separate mainnet read-only check reported a synced Rusty Kaspa
`2.0.1` node with UTXO index enabled beyond the recorded Toccata activation
score. `npm run proof:mainnet:offline` constructs and signs deterministic
synthetic standard-native v0 and additive v1 shapes without real UTXOs, funds,
transaction submission, spend, or broadcast.

This is compatibility evidence, not a mainnet readiness claim. Mainnet remains
blocked by `docs/mainnet-readiness.md`.
