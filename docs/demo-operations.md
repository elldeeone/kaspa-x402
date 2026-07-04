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

The Worker must not receive a mainnet key, a spending key, or a faucet key.
Claim broadcasting is disabled in the hosted gateway package.

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
offers, rejects a foreign payment scheme, and checks the health and canary
routes. A deployed paid check still requires an isolated funded testnet wallet.

## Rollback

Use the Cloudflare Workers deployment list for the project named
`kaspa-x402-demo-gateway`.

Rollback procedure:

1. Identify the last deployment that served valid `/health` and `/canary`.
2. Roll back to that Worker version in Cloudflare.
3. Confirm `https://demo.kaspa-x402.org/health` returns `ok: true`.
4. Run an unpaid exact and batch request and confirm each returns HTTP `402`.
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

## Chain Evidence Outage

The Worker uses REST evidence for accepted UTXOs and DAA health. If
`/health` or the scheduled canary reports REST failure:

1. Confirm whether `https://api-tn10.kaspa.org/info/blockdag` is reachable.
2. If the REST endpoint is down or stale, disable the gateway.
3. Do not point the public gateway at mainnet or an unreviewed private node.
4. If moving to a different `kaspa:testnet-10` REST endpoint, deploy only after
   unpaid offers and a manual paid exact check pass.
5. Re-enable only after `/health`, `/canary`, exact payment, batch deposit, and
   replay rejection checks pass.

The static browser demo uses PNN/WASM for client-side checks. A PNN outage can
break wallet-side demos while the Worker gateway still verifies via REST.

## Scheduled Canary

The Worker runs a non-spending scheduled canary every 15 minutes.

The canary checks:

- `kaspa:testnet-10` REST health and virtual DAA evidence;
- the public `payment-required` schema URL;
- the immutable `v0.1.0-alpha.1` release snapshot with a cache-busted request;
- the public docs index and expected page marker;
- unpaid exact offer shape and amount;
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

1. Request `GET /exact` and confirm HTTP `402`.
2. Pay the advertised exact amount to the advertised `payTo` address.
3. Retry with `PAYMENT-SIGNATURE` and confirm HTTP `200`.
4. Retry the identical paid request and confirm idempotent HTTP `200`.
5. Present the same exact transaction to a different resource and confirm
   conflict rejection.
6. Open a batch channel with a deposit-voucher payment and confirm HTTP `200`.
7. Reuse the channel with a voucher-only payment and confirm HTTP `200`.
8. Replay an earlier stale batch voucher after the later voucher and confirm
   corrective HTTP `402`.

Record transaction ids, output indexes, Worker version, response status, and
`PAYMENT-RESPONSE` summaries in the operator notes.

## Durable State Policy

The hosted gateway uses one SQLite-backed Durable Object. It stores exact
replay records, payment identifiers, batch channels, settlement commitments,
locks, rate counters, metrics, and the latest canary report.

Policy for the public alpha:

- durable state is operational evidence, not a user account database;
- no private keys or wallet seeds are stored;
- no public backup, export, or admin read route is exposed;
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
6. Deploy and verify `/health`, `/canary`, unpaid offers, paid exact, batch
   deposit-voucher, voucher-only reuse, and replay rejection.
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
