# Demo Gateway Operations

Status: alpha operations runbook for the hosted `kaspa:testnet-10` gateway.
This runbook describes the public demo service at:

```text
https://demo.kaspa-x402.org
```

Last repository-backed funded deployment evidence: Alpha.10 Worker version
`c57eb755-e169-4a00-ac4a-5e035371cad1`, built from commit `78f2ada`. That
historical evidence does not validate the Alpha.11 source, fresh durable state,
or `kaspa-x402-escrow-v3`. Alpha.11 deployment and funded canary proof are
pending.

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
| `KASPA_X402_EXACT_PROFILE`                   | Exact profile: `standard-native` (default) or optional `additive`.                                                                                             |
| `KASPA_X402_BATCH_AMOUNT`                    | Maximum per-request Alpha.11 batch charge in sompi.                                                                                                            |
| `KASPA_X402_MIN_DEPOSIT_SOMPI`               | Batch escrow deposit floor. Must be at least `10000000`.                                                                                                       |
| `KASPA_X402_CLAIM_RESERVE_SOMPI`             | Advertised Alpha.11 minimum successor reserve R. Must be at least `10000000`; the advertised deposit floor must cover the request ceiling plus this reserve.   |
| `KASPA_X402_REFUND_TIMEOUT_DAA_DELTA`        | Maximum DAA horizon for the persisted absolute batch timeout. The Worker rolls the timeout only at the minimum-lead boundary.                                  |
| `KASPA_X402_MINIMUM_REFUND_LEAD_DAA`         | Minimum remaining DAA lead required before accepting a batch payment.                                                                                          |
| `KASPA_X402_SITE_BASE_URL`                   | Standards site base URL used by canary checks.                                                                                                                 |
| `KASPA_X402_RELEASE_VERSION`                 | Immutable alpha release snapshot checked by the scheduled canary.                                                                                              |
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

## Alpha.11 Cutover

Alpha.11 is a clean-state cutover, not an Alpha.10 Durable Object migration.
The Worker resolves `GATEWAY_STATE` with the logical object name
`demo-gateway-alpha.11`; it MUST NOT read, import, or overwrite the Alpha.10
object.

1. Create the new Alpha.11 release snapshot and content lock, pass the release
   gate from a clean checkout, then deploy the static apex and `www` site first.
   Verify the Alpha.11 release metadata, schemas, vectors, and docs publicly.
2. Disable the Alpha.10 public gateway before replacing its Worker. Keep the
   Alpha.10 deployment and Durable Object untouched for rollback evidence.
3. Confirm the Worker advertises `0.1.0-alpha.11`, `kaspa-escrow-v2`,
   `kaspa-x402-escrow-v3`, and R, and resolves fresh
   `demo-gateway-alpha.11` state.
4. Validate the disabled Alpha.11 Worker, then run funded exact and batch
   canaries through an operator-controlled preview. Re-register any verified,
   still-unspent additive heads; exact replay records, payment identifiers, and
   batch channels are intentionally not copied from Alpha.10.
5. Enable the public Alpha.11 Worker only after its canaries pass. New batch
   clients must open singleton `kaspa-escrow-v2` binding lanes using the
   `kaspa-x402-escrow-v3` template; no older batch lane continues across the
   cutover.

Pending. Do not mark this cutover complete until the Alpha.11 release snapshot,
fresh `demo-gateway-alpha.11` state, and funded exact and batch canaries have
been independently recorded.

## Deploy

Do not deploy the Alpha.11 Worker until the locked Alpha.11 static site is live.
The Worker canary reads `KASPA_X402_RELEASE_VERSION`, so Worker-first deployment
would fail its release-snapshot check.

From the repository root:

```sh
npm --workspace @kaspa-x402/demo-gateway run build
npm --workspace @kaspa-x402/demo-gateway exec -- wrangler deploy --config wrangler.jsonc
```

The checked-in candidate configuration is fail-closed with
`KASPA_X402_GATEWAY_ENABLED=false`. After the disabled deployment and funded
operator canaries pass, the separate public-enable deployment is:

```sh
npm --workspace @kaspa-x402/demo-gateway exec -- wrangler deploy --config wrangler.jsonc --var KASPA_X402_GATEWAY_ENABLED:true
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

Alpha.10 and Alpha.11 use separate logical Durable Objects. A rollback to the
Alpha.10 Worker must continue resolving its Alpha.10 state; never point either
Worker version at the other release's object.

## Emergency Disable

Set:

```text
KASPA_X402_GATEWAY_ENABLED=false
```

Deploy the Worker. Protected endpoints must return:

```json
{ "ok": false, "error": "gateway_disabled" }
```

Health and canary endpoints stay readable. `/health` proves only that the
Worker loaded its configuration; use a fresh `/canary` result and funded proof
to assess chain readiness.

Re-enable by restoring:

```text
KASPA_X402_GATEWAY_ENABLED=true
```

## Chain Evidence Or PNN Outage

The Worker uses REST evidence for accepted UTXOs and DAA health. Hosted exact
also uses public TN10 PNN/WSS for transaction submission. `/health` is shallow
and does not probe either dependency. If the scheduled canary or hosted exact
proof reports chain failure:

1. Confirm whether `https://api-tn10.kaspa.org/info/blockdag` is reachable.
2. If the REST endpoint is down or stale, disable the gateway.
3. Do not point the public gateway at mainnet or an unreviewed private node.
4. If moving to a different `kaspa:testnet-10` REST endpoint, deploy only after
   unpaid offers and a manual paid exact check pass.
5. If PNN submission is failing, disable hosted exact or the full gateway until
   a paid exact proof passes again.
6. Re-enable only after `/health`, a fresh successful `/canary`, batch deposit,
   replay rejection, and exact payment checks pass when hosted exact settlement
   is enabled.

The static browser demo uses PNN/WASM for client-side checks, and hosted exact
uses lightweight PNN/WSS JSON inside the Worker for KIP-10 submission. A PNN
outage can break hosted exact while `/batch` remains usable.

## Scheduled Canary

The Worker runs a non-spending scheduled canary every 15 minutes.

The canary checks:

- `kaspa:testnet-10` REST health and virtual DAA evidence;
- the public `payment-required` schema URL;
- the configured immutable alpha release snapshot with a cache-busted request;
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
instructions are historical only; alpha.8 and later use standard-native by
default and reusable additive heads when explicitly enabled.

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

For Alpha.11, `demo-gateway-alpha.11` starts empty by design. This resets exact
replay and payment-identifier records, additive-head inventory, batch channels,
settlement commitments, counters, metrics, and canary history. Re-register only
independently verified, still-unspent additive heads and require every batch
client to create a new v2 lane. Do not copy Alpha.10 rows or reuse its logical
object name. The immutable [release snapshots](/releases/) and untouched
Alpha.10 object retain the earlier cutover record.

## Rotate Addresses And Keys

Use this when a testnet address is too noisy, a test key is suspected exposed,
or a clean public demo history is needed.

1. Disable the gateway.
2. Generate a new `kaspatest:` pay-to address using an isolated testnet wallet.
3. Generate a new server public key for batch terms. Keep any private signing
   material outside the Worker.
4. Update `KASPA_X402_PAY_TO` and `KASPA_X402_SERVER_PUBLIC_KEY`.
5. Keep the current release's logical Durable Object name unless an incident
   explicitly requires another disclosed fresh-state cutover. Never reuse an
   older alpha's logical object name.
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
