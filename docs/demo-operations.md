# Demo Gateway Operations

Status: operations runbook for the deployed RC2 `kaspa:testnet-10` gateway.
This runbook describes the public demo service at:

```text
https://demo.kaspa-x402.org
```

RC2 was published and deployed on 2026-10-01. The hosted gateway uses
PNN/WSS evidence for native exact, batch, and hash-chain payments. Release
validation covered all 18 funded flows, hosted native/batch payments, three
browser hash-chain payments across rotation, and retries after redeployment.
The [RC2 release reference](rc2-release.md) and
[gateway deployment record](testnet-gateway.md#recorded-rc2-deployment-evidence)
link to the published evidence and identify the release source.

The gateway is an integration target, not a wallet, custodian, faucet,
facilitator, mainnet service, or availability commitment.

## Operator Controls

The Worker configuration lives in `packages/demo-gateway/wrangler.jsonc`.

Important non-secret variables:

| Variable                                     | Purpose                                                                                                                                                        |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KASPA_X402_GATEWAY_ENABLED`                 | Set to `false` to stop protected exact and batch endpoints with HTTP `503`. `/health`, `/canary`, `/metrics`, and `/supported` remain visible.                 |
| `KASPA_X402_PAY_TO`                          | Testnet address receiving exact payments.                                                                                                                      |
| `KASPA_X402_SERVER_PUBLIC_KEY`               | Testnet server public key advertised in batch escrow terms.                                                                                                    |
| `KASPA_X402_EXACT_AMOUNT`                    | Exact-payment price in sompi. Must be at least `10000000`.                                                                                                     |
| `KASPA_X402_EXACT_PROFILE`                   | Exact profile: `standard-native` (default) or optional `additive`.                                                                                             |
| `KASPA_X402_BATCH_AMOUNT`                    | Fixed per-request v1 RC2 batch charge in sompi.                                                                                                                |
| `KASPA_X402_MIN_DEPOSIT_SOMPI`               | Batch escrow deposit floor. Must be at least `10000000`.                                                                                                       |
| `KASPA_X402_CLAIM_RESERVE_SOMPI`             | Advertised v1 RC2 minimum successor reserve R. Must be at least `10000000`; the advertised deposit floor must cover the request ceiling plus this reserve.     |
| `KASPA_X402_REFUND_TIMEOUT_DAA_DELTA`        | Maximum DAA horizon for the persisted absolute batch timeout. The Worker rolls the timeout only at the minimum-lead boundary.                                  |
| `KASPA_X402_MINIMUM_REFUND_LEAD_DAA`         | Minimum remaining DAA lead required before accepting a batch payment.                                                                                          |
| `KASPA_X402_GLOBAL_CONCURRENCY`              | Deployment-wide cap for in-flight protected requests. Enforced by renewable leases in the gateway Durable Object; default `64`, maximum `256`.                 |
| `KASPA_X402_SITE_BASE_URL`                   | Standards site base URL used by canary checks.                                                                                                                 |
| `KASPA_X402_RELEASE_VERSION`                 | Current release version checked against the standards site's `/release.json`.                                                                                   |
| `KASPA_X402_GATEWAY_BASE_URL`                | Gateway base URL used by canary checks.                                                                                                                        |
| `KASPA_X402_HOSTED_EXACT_SETTLEMENT_ENABLED` | Set to `true` only when the hosted exact verifier, PNN broadcast path, and finality observation are deployed. Additive also requires a durable available head. |
| `KASPA_X402_CHAIN_BROADCAST_MODE`            | `pnn` for all hosted chain reads, transaction submission, and selected-chain recovery. REST mode is rejected.                      |
| `KASPA_X402_PNN_ENDPOINTS`                   | Comma-separated public TN10 WSS endpoints used for exact submission and `GetVirtualChainFromBlockV2` batch lineage recovery.                                   |
| `KASPA_X402_HASH_CHAIN_ENABLED`             | Enable hash-chain exact in the existing gateway Durable Object after registering a funded Testnet head. Default: `false`. |

The Worker must not receive a mainnet, operator wallet, head owner, or faucet
key. Hash-chain registration supplies only its limited one-time grant keys.
Merchant claim broadcasting is disabled in the hosted gateway package.

Secret variables:

| Variable                 | Purpose                                                                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `KASPA_X402_ADMIN_TOKEN` | Bearer token for additive exact-head registration, reconciliation, and stats endpoints. Set with `wrangler secret put`; do not commit it. |

## v1 RC2 State

The Worker resolves `GATEWAY_STATE` with the logical object name
`demo-gateway-v1.0.0-rc.2`. It uses a clean RC state model and must not import
pre-RC channel or replay state.

## Deploy

Do not deploy the v1 RC2 Worker until the v1 RC2 static site is live.
The Worker canary reads `KASPA_X402_RELEASE_VERSION`, so Worker-first deployment
would fail its current-release check.

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

## Batch Collection And Refunds

A successful voucher response records an authorized cumulative charge, not an
on-chain merchant payout. Batch receipt `transaction` fields identify commitments;
claims and refunds have separate on-chain transaction ids. The demo Worker's
scheduled canary does not collect vouchers or hold a merchant signing key.

A merchant integration must persist vouchers and current channel lineage, run
`previewClaim`, and configure a `claimBuilder` for `executeClaim` to build and
sign the collection transaction. The
claim must exceed its estimated fee and satisfy transaction/output policies.
With the demo's 500-sompi price and 10,000-sompi configured claim fee, two calls
(1,000 sompi) are not economical to claim. That configured fee is not a guarantee
of the actual network fee; estimate against the actual transaction.

Schedule collection with enough time for confirmation and recovery before the
absolute refund DAA. The server's minimum refund lead limits new payments; it
does not schedule collection. After timeout, the buyer must submit and confirm
a refund. The merchant claim branch has no matching expiry, so claim and refund
can compete until a spend is accepted. An accepted refund returns the remaining
escrow less its fee, including charges the merchant has not collected.

Batch v3 charges a fixed price per accepted call, not a later measured token
count. Payment does not prove useful delivery; handlers with non-repeatable side
effects need their own durable idempotency/outbox handling. Top-ups require both
buyer and provider authorization.

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

The Worker uses the configured Testnet-10 PNN/WSS nodes for all funding,
UTXO, DAA, transaction, and selected-chain evidence. It does not depend on the
public REST transaction index. The reference batch policy still requires 30
confirmations proven by selected-chain traversal; blue-score difference alone
is insufficient. `/health` shows configuration; `/canary` probes the node.

1. If node evidence is unavailable, disable the gateway.
2. Switch only to reviewed `kaspa:testnet-10` PNN endpoints; never to mainnet.
3. Unknown, removed-chain, or incomplete evidence fails closed. Never discard a
   stored pre-broadcast checkpoint to manufacture a successful retry.
4. Re-enable after a fresh `/canary`, batch deposit and replay rejection, and
   exact payment checks pass.

The gateway persists PNN funding snapshots before exact submission and stores
accepted transaction receipts for recovery. Offers also preserve a bounded
ring of 128 node checkpoints, with one per 300 DAA scores, so a new batch
deposit can be located from a checkpoint before its creation. Without a stored
checkpoint, historical transactions use a bounded selected-parent traversal
(at most 1,024 blocks, subject to the node timeout). A missing
or pruned origin is unavailable evidence, not permission to weaken admission.
Existing channels retain their verified genesis evidence and lineage cursor.
Each batch lineage read stops at a fixed selected-chain checkpoint, including
the recent chain data so its cursor cannot skip an unconfirmed transition.
Covenant transitions still need the configured 30-block depth; a recent
transition keeps the lane pending until that evidence is available.
PNN receipts have separate limits of 4,096 records, 64 MiB total, and 64 KiB per
record. Capacity exhaustion fails closed and requires operator maintenance;
uncertain or active evidence is not automatically discarded.

On restart, resume every batch observer from its stored checkpoint. Process
removed blocks before additions. If history is pruned, branching, or otherwise
incomplete, keep the lane unavailable; do not reset its checkpoint, scan from a
new arbitrary block, or trust peer channel metadata. A removed refund restores
refund-only state and requires authoritative reconciliation before retry.

## Scheduled Canary

The Worker runs a non-spending scheduled canary every 15 minutes.

The canary checks:

- `kaspa:testnet-10` PNN health and virtual DAA evidence;
- the public `payment-required` schema URL;
- the current release metadata with a cache-busted request;
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

Also confirm that unsupported legacy `exact-transfer` evidence is rejected and
does not return protected content.

## Hash-chain Demo

The RC2 hash-chain demo runs in the existing `GatewayState` Durable
Object. Grant tables use its SQLite storage; payment responses use the existing
gateway ledger. Pages, the Worker, its binding, and the standard exact and batch
routes remain the same. One funded head and manual resets are sufficient for
this Testnet demo. No Container or separate server is required.

The hash-chain route uses the configured Testnet-10 PNNs for fresh UTXOs and
selected-chain V2 transaction evidence. It snapshots the payer's accepted
funding outputs before delivering a signing grant because spent outputs can
disappear from the public REST index. Paid retries recheck selected-chain
acceptance. The public REST API is not the hash-chain verification source.

### Cloudflare Hosting

1. Build and check the Worker and browser client:

   ```sh
   npm run build
   npm run site:build
   npm run check:hash-chain-worker
   npm run check:browser-demo
   ```

2. Use a private local operator config. Set `dataDir` to a new private directory,
   `sdkModule` to the pinned Node WASM SDK, `rpcUrl` to a synced Testnet-10 node,
   and `walletFile` to the funded Testnet operator wallet. Also set
   `publicBaseUrl` to `https://demo.kaspa-x402.org` and `adminTokenFile` to the
   private file containing the existing gateway admin token. Run:

   ```sh
   node scripts/hash-chain-demo.mjs init --config <private-config> --live
   ```

   This funds a 1 KAS head and creates 32 fresh one-use grants. It saves
   `cloudflare-head.json` with mode `0600` alongside the local owner key and
   grant database. Keep these files outside the published site.

3. Deploy the Worker with `KASPA_X402_GATEWAY_ENABLED=true`, preserving the
   live gateway variables and existing admin secret. Leave
   `KASPA_X402_HASH_CHAIN_ORIGIN` empty. Publish the fresh head:

   ```sh
   node scripts/hash-chain-demo.mjs publish --config <private-config>
   ```

   Publication uses the authenticated HTTPS admin route and returns only public
   head metadata. The operator wallet and owner keys stay local. Use this head
   only in the Cloudflare demo; the local Node service must not issue its grants.

4. Set `KASPA_X402_HASH_CHAIN_ENABLED=true`, deploy the Worker, and deploy the
   static site to the existing Pages project. Check `/hash-chain/status` and
   `/supported`, then make a funded browser payment and retry that same payment.
   Check the existing exact and batch demos too.

If a grant is abandoned or the chain is exhausted, create a new private data
directory, initialize a fresh funded head, and publish it. Registration waits
for an assigned grant to expire before replacing it. Old quotes and unfinished
demo payments can become unavailable after a reset. Automatic rotation and
recovery are outside this demo's scope.

### Caller Admission

The Worker derives an opaque caller identity from
[Cloudflare's ingress IP](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-connecting-ip) and
sets `X-KASPA-X402-DEMO-CALLER` on its private Durable Object call. The service
returns that identity with the quote so the browser binds payment to the same
caller. The four-live-quote limit applies per public IP; users sharing an IP
share that limit. Use the same public IP for quotes, payments, and retries.
Resource requests without trusted caller metadata are unavailable. Local
Worker checks must supply `CF-Connecting-IP`; direct Node service checks also need
the proxy bearer token and a 64-character lowercase hex caller header.

### Optional Node Hosting

For a separate Node host, the Worker can proxy the same resource and grant
routes under the public origin. Use this option instead of Cloudflare hosting.
This optional Node adapter still uses a REST index for selected-chain reads;
it is not the PNN-only configuration deployed by the RC2 public gateway.

Build the workspaces first (`npm run build`). Use Node 22.13 or newer and the
pinned Rusty-Kaspa 2.0.0 Node WASM SDK, including its `websocket` dependency.
Create a private config file, outside the published site, with:

```json
{
  "dataDir": "./.kaspa-x402-live/hash-chain-demo",
  "sdkModule": "./.kaspa-x402-live/runtime/sdk-v2.0.0/kaspa.js",
  "rpcUrl": "wss://your-testnet-10-node/kaspa/testnet-10/wrpc/borsh",
  "apiBase": "https://api-tn10.kaspa.org",
  "publicBaseUrl": "https://demo.kaspa-x402.org",
  "walletFile": "./.kaspa-x402-live/operator-wallet.json",
  "proxyTokenFile": "./.kaspa-x402-live/hash-chain-proxy-token",
  "port": 8788
}
```

The operator wallet file contains a funded Testnet private key as plain hex or
JSON with a `private_key` field. Wallet and token files must have mode `0600`.
Generate a random proxy token of at least 32 characters and save it privately.
The service listens on loopback by default; expose it through an HTTPS reverse
proxy or tunnel. Keep its data directory on persistent disk.

1. Create the demo head with explicit Testnet broadcast permission:

   ```sh
   node scripts/hash-chain-demo.mjs init --config <private-config> --live
   ```

   This funds a 1 KAS merchant head and installs 32 one-use grants. It waits for
   30 genesis confirmations. The private directory holds the encrypted issuer
   database, its encryption key, and the owner key.

2. Start the Node process:

   ```sh
   node scripts/hash-chain-demo.mjs serve --config <private-config>
   ```

   The same private directory holds `payments.sqlite`, which saves exact
   settlement attempts, handler results, and paid responses. Restarting the
   process preserves identical paid retries, including after quote expiry.
   Keep both databases together on persistent disk and run one service process.

3. Configure the Worker with `KASPA_X402_HASH_CHAIN_ORIGIN` set to the service's
   HTTPS origin. Set `KASPA_X402_HASH_CHAIN_PROXY_TOKEN` as a Wrangler secret
   containing the same token. Deploy this separately from the static website.
   An empty origin leaves the existing demo working and hash-chain unavailable.

4. Check `/hash-chain/status`, `/supported`, and an unpaid
   `/hash-chain/report` quote. Then run one funded payment in the browser.
   The default price is 0.2 KAS. The target fee is 0.01 KAS; small change may
   raise it to at most 0.1 KAS, as shown before payment and in the result.

For an abandoned grant or an exhausted chain, stop the Node process, wait for
any assigned grant to expire, and run:

```sh
node scripts/hash-chain-demo.mjs status --config <private-config>
node scripts/hash-chain-demo.mjs rotate --config <private-config> --live
node scripts/hash-chain-demo.mjs serve --config <private-config>
```

Rotation uses the owner key and a separate funding input for its fee, preserves
the merchant value and covenant ID, and installs a fresh set of grants. It
does not reuse an abandoned key. If setup or rotation was interrupted after
submission, `recover --config <private-config>` checks the saved transaction
and records its accepted result without broadcasting again. Resolve a pending
setup before another init/rotation. Keep the pending setup file private.

The service uses selected-chain PNN evidence and fresh PNN UTXO reads for the
current head. If the configured Testnet nodes fail, it stays
unavailable/pending. Local simulation checks do not establish live payment
acceptance. Enable the public flow only after the deployed paid browser check.

## Durable State Policy

The hosted gateway uses one SQLite-backed Durable Object. It stores exact
replay records, payment identifiers, batch channels, settlement commitments,
locks, rate counters, metrics, and the latest canary report.

Each v1 RC2 batch row also owns its immutable covenant launch manifest,
append-only accepted/removed lineage journal, durable selected-chain checkpoint,
and atomically derived current head. Those fields must be committed together.

Policy for the public release candidate:

- durable state is operational evidence, not a user account database;
- no private keys or wallet seeds are stored;
- no unauthenticated backup, export, or admin read route is exposed;
- additive exact-head admin routes require `KASPA_X402_ADMIN_TOKEN`;
- state may be reset during Testnet incidents after the gateway is disabled and
  the reset is disclosed in operator notes;
- production operators should design their own backup and state-partitioning
  policy before using this code outside the hosted demo.

For v1 RC2, `demo-gateway-v1.0.0-rc.2` is the authoritative Testnet state.
Re-register only independently verified, still-unspent additive heads after a
deliberate reset, and require batch clients to create new v1 RC lanes.

## Rotate Addresses And Keys

Use this when a testnet address is too noisy, a test key is suspected exposed,
or a clean public demo history is needed.

1. Disable the gateway.
2. Generate a new `kaspatest:` pay-to address using an isolated testnet wallet.
3. Generate a new server public key for batch terms. Keep any private signing
   material outside the Worker.
4. Update `KASPA_X402_PAY_TO` and `KASPA_X402_SERVER_PUBLIC_KEY`.
5. Keep the current release's logical Durable Object name unless an incident
   explicitly requires another disclosed fresh-state cutover.
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
