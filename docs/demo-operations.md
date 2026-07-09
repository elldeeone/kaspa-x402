# Demo Gateway Operations

Status: alpha operations runbook for the hosted `kaspa:testnet-10` gateway.
This runbook describes the public demo service at:

```text
https://demo.kaspa-x402.org
```

The gateway is an integration target, not a wallet, custodian, faucet,
facilitator, mainnet service, or availability commitment.

## Operator Controls

The Worker configuration lives in `packages/demo-gateway/wrangler.jsonc`.

Important non-secret variables:

| Variable | Purpose |
| -------- | ------- |
| `KASPA_X402_GATEWAY_ENABLED` | Set to `false` to stop protected exact and batch endpoints with HTTP `503`. `/health`, `/canary`, `/metrics`, and `/supported` remain visible. |
| `KASPA_X402_CHAIN_API_BASE` | REST chain evidence source. Current value: `https://api-tn10.kaspa.org`. |
| `KASPA_X402_PAY_TO` | Testnet address receiving exact payments. |
| `KASPA_X402_SERVER_PUBLIC_KEY` | Testnet server public key advertised in batch escrow terms. |
| `KASPA_X402_EXACT_AMOUNT` | Exact-payment price in sompi. Must be at least `10000000`. |
| `KASPA_X402_MIN_DEPOSIT_SOMPI` | Batch escrow deposit floor. Must be at least `10000000`. |
| `KASPA_X402_SITE_BASE_URL` | Standards site base URL used by canary checks. |
| `KASPA_X402_GATEWAY_BASE_URL` | Gateway base URL used by canary checks. |
| `KASPA_X402_HOSTED_EXACT_SETTLEMENT_ENABLED` | Set to `true` only when the hosted exact verifier, PNN broadcast path, finality observation, and inventory consumption path are deployed. |
| `KASPA_X402_CHAIN_BROADCAST_MODE` | `pnn` for hosted KIP-10 exact settlement. REST is read-side evidence only for hosted exact. |
| `KASPA_X402_PNN_ENDPOINTS` | Comma-separated public TN10 WSS endpoints used by the Worker to submit exact transaction artifacts. |

The Worker must not receive a mainnet key, a spending key, or a faucet key.
Claim broadcasting is disabled in the hosted gateway package.

Secret variables:

| Variable | Purpose |
| -------- | ------- |
| `KASPA_X402_ADMIN_TOKEN` | Bearer token for exact inventory registration and stats endpoints. Set with `wrangler secret put`; do not commit it. |

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

## Exact Inventory

Hosted exact is enabled only when both conditions are true: the Worker
configuration has `KASPA_X402_HOSTED_EXACT_SETTLEMENT_ENABLED=true`, and funded
KIP-10 borrow UTXO inventory is available. The Worker does not hold the
merchant wallet key and does not create borrow outputs from public requests.

1. Create one or more merchant-owned KIP-10 additive borrow UTXOs from an
   isolated TN10 wallet.
2. Record the borrow outpoint, serialized script public key, redeem script,
   borrow amount, additive threshold, and payment output index.
3. Register those terms with the Worker:

```sh
KASPA_X402_DEMO_ADMIN_TOKEN=<token> \
  npm run demo:exact-inventory -- register --file inventory.json
```

4. Confirm inventory availability:

```sh
KASPA_X402_DEMO_ADMIN_TOKEN=<token> npm run demo:exact-inventory -- stats
curl -fsS https://demo.kaspa-x402.org/supported
```

When inventory is available, `/supported` advertises `exact` and an unpaid
`/exact` request leases one inventory item until the advertised reservation
expires. A paid exact settlement consumes the inventory item. Expired
reservations are retired for operator reconciliation rather than automatically
reused.

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
- exact support advertisement only when hosted exact settlement is enabled and
  inventory is available, without consuming a reservation;
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
2. If exact is deployed, request `GET /exact`, confirm HTTP `402`, build a
   signed KIP-10 `exact-transaction` artifact from the advertised reservation
   terms, retry with `PAYMENT-SIGNATURE`, and confirm the Worker broadcasts the
   artifact through PNN, observes accepted finality, and returns HTTP `200`.
3. Retry the identical paid exact request and confirm idempotent HTTP `200`.
4. Present the same exact transaction to a different resource and confirm
   conflict rejection.
5. Open a batch channel with a deposit-voucher payment and confirm HTTP `200`.
6. Reuse the channel with a voucher-only payment and confirm HTTP `200`.
7. Replay an earlier stale batch voucher after the later voucher and confirm
   corrective HTTP `402`.

Record transaction ids, output indexes, Worker version, response status, and
`PAYMENT-RESPONSE` summaries in the operator notes.

The committed hosted exact proof seeds funded inventory, registers it through
the admin API, pays `/exact` with a signed exact transaction artifact, confirms
the Worker-broadcast transaction is accepted, retries the same payment for
idempotency, and leaves at least one inventory item available by default:

```sh
KASPA_X402_RPC_URL=<tn10-rpc-url> \
KASPA_X402_FUNDING_WALLET=wallet-key:/path/to/testnet-key \
KASPA_X402_KASPA_WASM_MODULE=/path/to/kaspa.js \
KASPA_X402_DEMO_ADMIN_TOKEN=<token> \
KASPA_X402_LIVE_CONFIRM=I_UNDERSTAND_THIS_USES_TESTNET_FUNDS \
  npm run proof:hosted-exact
```

For alpha.6 and later, also confirm that observe-only `exact-transfer` evidence
is rejected and does not return protected content.

For alpha.6 KIP-10 exact deployments, advertise `exact` only after the gateway
can reserve a borrow outpoint, return the reservation fields in
`PaymentRequired.extra`, verify the signed transaction artifact, submit it
through the configured TN10 PNN/WSS endpoints, observe accepted finality, and
consume the reservation. If the gateway does not have that settlement path,
exact must remain unavailable and hosted canaries should cover
`batch-settlement` only.

## Durable State Policy

The hosted gateway uses one SQLite-backed Durable Object. It stores exact
replay records, payment identifiers, batch channels, settlement commitments,
locks, rate counters, metrics, and the latest canary report.

Policy for the public alpha:

- durable state is operational evidence, not a user account database;
- no private keys or wallet seeds are stored;
- no unauthenticated backup, export, or admin read route is exposed;
- exact inventory admin routes require `KASPA_X402_ADMIN_TOKEN`;
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
