# Demo Gateway Operations

Status: alpha operations runbook for the hosted `kaspa:testnet-10` gateway.
This runbook describes the public demo service at:

```text
https://demo.kaspa-x402.org
```

Current deployment: historical alpha.7 Worker version
`38f3d622-4638-4821-a7d4-23b5ae3e97b2`, built from commit `4d53d02`. Funded
exact, idempotent and cross-resource replay, batch deposit/voucher,
stale-voucher, and absolute-DAA checks passed on its immediate predecessor;
the final source-parity deploy adds only a fail-closed pre-persistence check for
the consensus timestamp boundary and passed post-deploy health, capability,
inventory, and stable absolute-DAA checks. This is not yet an alpha.8
deployment; alpha.8 replaces consumable reservation inventory with a default
standard-native profile and optional durable KIP-10 head chains.

The gateway is an integration target, not a wallet, custodian, faucet,
facilitator, mainnet service, or availability commitment.

## Operator Controls

The Worker configuration lives in `packages/demo-gateway/wrangler.jsonc`.

Important non-secret variables:

| Variable                                     | Purpose                                                                                                                                                        |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KASPA_X402_GATEWAY_ENABLED`                 | Set to `false` to stop protected exact and batch endpoints with HTTP `503`. `/health`, `/canary`, `/metrics`, and `/supported` remain visible.                 |
| `KASPA_X402_CHAIN_API_BASE`                  | REST chain evidence source. Current value: `https://api-tn10.kaspa.org`.                                                                                       |
| `KASPA_X402_PAY_TO`                          | Testnet address receiving exact payments.                                                                                                                      |
| `KASPA_X402_SERVER_PUBLIC_KEY`               | Testnet server public key advertised in batch escrow terms.                                                                                                    |
| `KASPA_X402_EXACT_AMOUNT`                    | Exact-payment price in sompi. Must be at least `10000000`.                                                                                                     |
| `KASPA_X402_EXACT_PROFILE`                   | Alpha.8 exact profile: `standard-native` (default) or optional `additive`.                                                                                     |
| `KASPA_X402_MIN_DEPOSIT_SOMPI`               | Batch escrow deposit floor. Must be at least `10000000`.                                                                                                       |
| `KASPA_X402_REFUND_TIMEOUT_DAA_DELTA`        | Maximum DAA horizon for the persisted absolute batch timeout. The Worker rolls the timeout only at the minimum-lead boundary.                                  |
| `KASPA_X402_MINIMUM_REFUND_LEAD_DAA`         | Minimum remaining DAA lead required before accepting a batch payment.                                                                                          |
| `KASPA_X402_SITE_BASE_URL`                   | Standards site base URL used by canary checks.                                                                                                                 |
| `KASPA_X402_GATEWAY_BASE_URL`                | Gateway base URL used by canary checks.                                                                                                                        |
| `KASPA_X402_HOSTED_EXACT_SETTLEMENT_ENABLED` | Set to `true` only when the hosted exact verifier, PNN broadcast path, and finality observation are deployed. Additive also requires a durable available head. |
| `KASPA_X402_CHAIN_BROADCAST_MODE`            | `pnn` for hosted KIP-10 exact settlement. REST is read-side evidence only for hosted exact.                                                                    |
| `KASPA_X402_PNN_ENDPOINTS`                   | Comma-separated public TN10 WSS endpoints used by the Worker to submit exact transaction artifacts.                                                            |

The Worker must not receive a mainnet key, a spending key, or a faucet key.
Claim broadcasting is disabled in the hosted gateway package.

Secret variables:

| Variable                 | Purpose                                                                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `KASPA_X402_ADMIN_TOKEN` | Bearer token for additive exact-head registration, reconciliation, and stats endpoints. Set with `wrangler secret put`; do not commit it. |

## Deploy

From the repository root:

```sh
npm --workspace @kaspa-x402/demo-gateway run build
npm --workspace @kaspa-x402/demo-gateway exec -- wrangler deploy --config wrangler.jsonc
```

After deployment, verify:

```sh
curl -fsS https://demo.kaspa-x402.org/health
curl -fsS https://demo.kaspa-x402.org/canary
npm run check:demo-gateway
```

`check:demo-gateway` starts a local Worker, verifies the unpaid exact and batch
availability gate, verifies the unpaid batch offer, rejects a foreign payment
scheme, and checks the health and canary routes. A deployed paid check still
requires an isolated funded testnet wallet.

## Exact Profiles And Additive Heads

Hosted exact is enabled only when
`KASPA_X402_HOSTED_EXACT_SETTLEMENT_ENABLED=true`. The default
`standard-native` profile requires no merchant inventory. Optional `additive`
also requires at least one durable merchant-owned KIP-10 head. The Worker does
not hold the merchant wallet key and does not create heads from public
requests.

1. Create one or more independent merchant-owned KIP-10 additive heads from an
   isolated TN10 wallet.
2. Record each head id/version, current outpoint and amount, serialized script
   public key, redeem script, additive threshold, status, and timestamps.
3. Register the head records with the Worker:

```sh
KASPA_X402_DEMO_ADMIN_TOKEN=<token> \
  npm run demo:exact-heads -- register --file heads.json
```

4. Confirm head availability:

```sh
KASPA_X402_DEMO_ADMIN_TOKEN=<token> npm run demo:exact-heads -- stats
curl -fsS https://demo.kaspa-x402.org/supported
```

`standard-native` advertises exact without a head. `additive` advertises exact
only while a matching head is available. Issuing an unpaid 402 does not reserve,
retire, or consume a head. Settlement atomically claims the advertised current
outpoint, verifies a same-script successor whose delta equals the exact price,
and advances that same durable lineage. Stale competing clients receive a fresh
402 against the current head.

Before each additive offer, the Worker confirms only the selected durable
current outpoint against the accepted address UTXO set. It makes at most two
bounded candidate attempts, independent of total head inventory. A missing or
conflicting selected head becomes unavailable. Full-pool checks are operator
work, not anonymous request work. If a known external transaction advanced a
head, provide the complete ordered accepted lineage to recover it:

```sh
KASPA_X402_DEMO_ADMIN_TOKEN=<token> \
  npm run demo:exact-heads -- reconcile \
  --head-id <head-id> \
  --transactions <first-txid>,<next-txid>
```

The gateway accepts only a chain in which every transaction spends the prior
outpoint, preserves the same script and output index, satisfies the KIP-10
threshold, and ends at the current unspent head. Never use an arbitrary output
to the same P2SH address as lineage evidence.

## Rollback

Use the Cloudflare Workers deployment list for the project named
`kaspa-x402-demo-gateway`.

Rollback procedure:

1. Identify the last deployment that served valid `/health` and `/canary`.
2. Roll back to that Worker version in Cloudflare.
3. Confirm `https://demo.kaspa-x402.org/health` returns `ok: true`.
4. Run an unpaid batch request and confirm HTTP `402`; confirm `/exact` returns
   `503 exact_unavailable` unless a working hosted exact settlement path is
   deliberately enabled and tested.
5. Record the version, reason, and verification result in the operator notes.

If the bad deployment changed durable state shape, disable the gateway first
with `KASPA_X402_GATEWAY_ENABLED=false`, then inspect state compatibility before
rolling forward again.

## Emergency Disable

Set:

```text
KASPA_X402_GATEWAY_ENABLED=false
```

Deploy the Worker. Protected endpoints must return:

```json
{ "ok": false, "error": "gateway_disabled" }
```

Health and canary endpoints stay readable so operators can distinguish an
intentional disable from a platform or chain outage.

Re-enable by restoring:

```text
KASPA_X402_GATEWAY_ENABLED=true
```

## Chain Evidence Or PNN Outage

The Worker uses REST evidence for accepted UTXOs and DAA health. Hosted exact
also uses public TN10 PNN/WSS for transaction submission. If `/health`, the
scheduled canary, or the hosted exact proof reports chain failure:

1. Confirm whether `https://api-tn10.kaspa.org/info/blockdag` is reachable.
2. If the REST endpoint is down or stale, disable the gateway.
3. Do not point the public gateway at mainnet or an unreviewed private node.
4. If moving to a different `kaspa:testnet-10` REST endpoint, deploy only after
   unpaid offers and a manual paid exact check pass.
5. If PNN submission is failing, disable hosted exact or the full gateway until
   a paid exact proof passes again.
6. Re-enable only after `/health`, `/canary`, batch deposit, replay rejection,
   and exact payment checks pass when hosted exact settlement is enabled.

The static browser demo uses PNN/WASM for client-side checks, and hosted exact
uses lightweight PNN/WSS JSON inside the Worker for KIP-10 submission. A PNN
outage can break hosted exact while `/batch` remains usable.

## Scheduled Canary

The Worker runs a non-spending scheduled canary every 15 minutes.

The canary checks:

- `kaspa:testnet-10` REST health and virtual DAA evidence;
- the public `payment-required` schema URL;
- the immutable `v0.1.0-alpha.1` release snapshot with a cache-busted request;
- the public docs index and expected page marker;
- exact support advertisement only when hosted exact settlement is enabled and,
  for `additive`, a head is available, without claiming that head;
- unpaid batch offer shape and deposit floor;
- unsupported foreign payment scheme rejection.

The scheduled canary skips paid exact and replay checks because the Worker
does not hold spending keys. Those checks must be run manually from
an isolated funded testnet wallet so canary failures cannot spend unbounded
funds.

Read the enabled state and latest canary report:

```sh
curl -fsS https://demo.kaspa-x402.org/canary
```

An operator should check `/canary` after each gateway or site deployment and at
least once per day while the demo is advertised. If `ok` is false, disable
broad public guidance until the failed check is understood and fixed.

## Manual Paid Canary

Use an isolated testnet key. Do not import a key that controls mainnet funds.

Minimum manual paid checks:

1. If exact is not deployed with a working KIP-10 settlement path, request
   `GET /exact` and confirm HTTP `503 exact_unavailable`.
2. If exact is deployed, request `GET /exact` and confirm HTTP `402`. For
   `standard-native`, build an ordinary exact native transfer. For `additive`,
   spend the advertised head and increase its same-script successor by exactly
   the advertised amount, with no separate merchant payment output. Retry with
   `PAYMENT-SIGNATURE`, and confirm the Worker broadcasts the artifact through
   PNN, observes accepted finality, and returns HTTP `200`.
3. Retry the identical paid exact request and confirm idempotent HTTP `200`.
4. Present the same exact transaction to a different resource and confirm
   conflict rejection.
5. Open a batch channel with a deposit-voucher payment and confirm HTTP `200`.
6. Reuse the channel with a voucher-only payment and confirm HTTP `200`.
7. Replay an earlier stale batch voucher after the later voucher and confirm
   corrective HTTP `402`.

Record transaction ids, output indexes, Worker version, response status, and
`PAYMENT-RESPONSE` summaries in the operator notes.

The committed hosted exact proof pays `/exact` with a signed exact transaction
artifact, confirms the Worker-broadcast transaction is accepted, retries the
same payment for idempotency, and rejects the same transaction on a different
resource. In default `standard-native` mode it needs no admin state. In
`additive` mode it funds and registers a reusable head first:

```sh
KASPA_X402_RPC_URL=<tn10-rpc-url> \
KASPA_X402_FUNDING_WALLET=wallet-key:/path/to/testnet-key \
KASPA_X402_KASPA_WASM_MODULE=/path/to/kaspa.js \
KASPA_X402_EXPECTED_GATEWAY_ORIGIN=https://demo.kaspa-x402.org \
KASPA_X402_EXPECTED_EXACT_PROFILE=standard-native \
KASPA_X402_EXPECTED_EXACT_AMOUNT=20000000 \
KASPA_X402_EXPECTED_EXACT_PAY_TO=<expected-merchant-address> \
KASPA_X402_LIVE_CONFIRM=I_UNDERSTAND_THIS_USES_TESTNET_FUNDS \
  npm run proof:hosted-exact
```

Set `KASPA_X402_EXACT_PROFILE=additive` and
`KASPA_X402_EXPECTED_EXACT_PROFILE=additive`, then provide
`KASPA_X402_DEMO_ADMIN_TOKEN=<token>` to exercise the optional head profile.
The additive proof derives and pins the locally created head address when an
explicit expected payTo is absent. The proof refuses to sign if the gateway
origin, resource, profile, amount, recipient, or network differs from the
operator pins.

Also confirm that legacy observe-only `exact-transfer` evidence is rejected and
does not return protected content. Alpha.6/alpha.7 reservation and borrow
instructions are historical only; alpha.8 uses standard-native by default and
reusable additive heads when explicitly enabled.

## Durable State Policy

The hosted gateway uses one SQLite-backed Durable Object. It stores exact
replay records, payment identifiers, batch channels, settlement commitments,
locks, rate counters, metrics, and the latest canary report.

Policy for the public alpha:

- durable state is operational evidence, not a user account database;
- no private keys or wallet seeds are stored;
- no unauthenticated backup, export, or admin read route is exposed;
- additive exact-head admin routes require `KASPA_X402_ADMIN_TOKEN`;
- state may be reset during alpha incidents after the gateway is disabled and
  the reset is disclosed in operator notes;
- production operators should design their own backup and state-partitioning
  policy before using this code outside the hosted demo.

Alpha.4 voucher-signature reset:

- `0.1.0-alpha.4` changes hosted voucher verification to the covenant-enforced
  raw-digest Schnorr signature scheme. Channels opened before that deployment
  used the rejected personal-message scheme and must be treated as invalid.
- Before deploying the alpha.4 gateway, disable the gateway with
  `KASPA_X402_GATEWAY_ENABLED=false`.
- Reset the hosted Durable Object state under the alpha state policy.
- Record an incident note that existing batch channel evidence was invalidated
  by the voucher-signature scheme fix.
- Deploy the alpha.4 gateway, re-enable it, and rerun manual paid exact and
  batch checks before advertising the endpoint.

Alpha.5 exact-evidence cutover:

- `0.1.0-alpha.5` changes exact retry evidence to required
  `transactionId` plus `paymentOutputIndex`.
- Deploy the static site and Worker from the same reviewed source state.
- Do not reset Durable Object state solely for this wire cutover; exact replay
  records are already keyed by transaction id.
- Before advertising alpha.5 hosted evidence, confirm the legacy
  `payload.transaction` shape is rejected, confirm the new evidence shape
  reaches the exact verifier, and run the funded TN10 live proof with
  `npm run proof:live:check -- --live --write-report`.

Alpha.6 KIP-10 exact-transaction cutover:

- `0.1.0-alpha.6` replaces the alpha.5 observe-only exact payload with a signed
  KIP-10 transaction artifact carrying `transactionEncoding:
"kaspa-sdk-safe-json-v2.0.0"`.
- Advertise the alpha.6 exact path from the hosted gateway only while the
  verifier/broadcast/observe path is enabled and exact inventory is available.
- The provider uses merchant-owned borrow UTXO inventory and must advertise an
  `additiveThresholdSompi` of at least `10000000` sompi for the reference alpha.
  Do not advertise hosted exact with zero-threshold borrow terms.
- Do not serve observe-only `exact-transfer` as a current alpha exact fallback.
- Before advertising alpha.6 hosted evidence, run unpaid shape checks, a funded
  TN10 KIP-10 exact canary, replay rejection, and the full live proof runner.

Alpha.7 DAA and continuation cutover:

- Deploy only from the reviewed alpha.7 source after all local release checks
  pass.
- Confirm repeated unpaid batch offers retain one absolute `refundTimeoutDaa`
  so an active covenant channel remains reusable. Confirm the stored timeout is
  no more than the configured delta ahead of current virtual DAA, remains below
  `500000000000`, and has more than the configured minimum lead. It should roll
  forward only when that minimum-lead boundary is reached.
- Confirm the exact inventory store recycles only verifier-derived
  continuations and does so atomically with consumption of the original
  reservation.
- Run funded exact settlement and replay checks, then batch deposit-voucher,
  voucher-only, claim, stale-voucher rejection, and strict post-timeout refund
  checks.
- Record the Worker version, transaction ids, absolute refund DAA, and canary
  results in `docs/testnet-gateway.md`.

Alpha.8 exact-profile cutover:

- Deploy only after standard-native and additive exact proofs pass from the
  reviewed alpha.8 source.
- Default to `KASPA_X402_EXACT_PROFILE=standard-native`; it requires no head
  inventory and pays the merchant once through the exact native output.
- If selecting `additive`, replace all alpha.7 reservation inventory with
  durable head records registered through `/admin/exact-heads`. Do not migrate
  leased or retired alpha.7 records as current heads without reconciling their
  outpoints against TN10.
- Confirm unanswered 402s do not change head state, one conflicting settlement
  advances the head, stale competitors receive a refreshed challenge, and the
  successor delta equals the advertised price exactly.
- Run both exact profiles plus the unchanged batch deposit/voucher/claim/refund
  lifecycle before calling the public deployment alpha.8.

## Rotate Addresses And Keys

Use this when a testnet address is too noisy, a test key is suspected exposed,
or a clean public demo history is needed.

1. Disable the gateway.
2. Generate a new `kaspatest:` pay-to address using an isolated testnet wallet.
3. Generate a new server public key for batch terms. Keep any private signing
   material outside the Worker.
4. Update `KASPA_X402_PAY_TO` and `KASPA_X402_SERVER_PUBLIC_KEY`.
5. Decide whether to preserve or reset the Durable Object namespace. Preserve
   state for replay continuity; reset state for a clean demo history.
6. Deploy and verify `/health`, `/canary`, unpaid offers, paid exact only when
   hosted exact settlement is enabled, batch deposit-voucher, voucher-only
   reuse, and replay rejection.
7. Re-enable the gateway.

## Incident Note Template

```text
Date:
Operator:
Worker version:
Incident:
User-visible impact:
Gateway enabled state:
Chain evidence:
Canary result:
Actions taken:
Paid evidence affected:
Follow-up:
```

Keep incident notes factual and testnet-scoped.
