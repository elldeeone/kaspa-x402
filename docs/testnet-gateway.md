# Testnet Gateway

Status: v1 RC1 is live on `kaspa:testnet-10` as the current recommended Testnet
release, with funded deployment and fresh-state release evidence recorded.

The hosted gateway is a public integration target for implementers exercising
the Kaspa x402 wire flow against a real server. It is not a wallet, custodian,
mainnet service, or availability commitment.

The deployed v1 RC1 gateway uses `kaspa-exact-v2` with the default
`standard-native` profile and also supports `batch-settlement`. The optional
`additive` exact profile is implemented but is advertised only when a current
KIP-10 head is available.

## Base URL

```text
https://demo.kaspa-x402.org
```

## Endpoints

| Method | Path                      | Purpose                                                                       |
| ------ | ------------------------- | ----------------------------------------------------------------------------- |
| `GET`  | `/`                       | JSON endpoint index.                                                          |
| `GET`  | `/health`                 | Shallow configuration and process health; no upstream calls or endpoint URLs. |
| `GET`  | `/canary`                 | Enabled state and latest scheduled canary report.                             |
| `GET`  | `/supported`              | Supported x402 schemes and profiles.                                          |
| `GET`  | `/exact`, `/exact/report` | Protected exact-payment resources.                                            |
| `GET`  | `/batch`, `/batch/report` | Protected batch-settlement resources.                                         |
| `GET`  | `/metrics`                | Coarse operational counters.                                                  |

`HEAD` follows the same payment behavior as `GET` without a response body.
`OPTIONS` returns the CORS preflight response.

Additive-head administration is operator-only:

| Method | Path                           | Purpose                                                        |
| ------ | ------------------------------ | -------------------------------------------------------------- |
| `GET`  | `/admin/exact-heads`           | Return head statistics and records.                            |
| `POST` | `/admin/exact-heads/register`  | Register funded KIP-10 head terms.                             |
| `POST` | `/admin/exact-heads/reconcile` | Prove accepted successor lineage and restore the current head. |

These routes require a bearer token stored as a Worker secret.

## Local Worker

From the repository root, start an unpaid local integration target:

```sh
npx wrangler dev --local --config packages/demo-gateway/wrangler.jsonc \
  --ip 127.0.0.1 --port 8433 --local-upstream 127.0.0.1:8433 \
  --var KASPA_X402_GATEWAY_BASE_URL:http://127.0.0.1:8433 \
  --var KASPA_X402_GATEWAY_ENABLED:true
```

Both `/exact` and `/batch` must advertise resources under
`http://127.0.0.1:8433`. Wrangler otherwise inherits the production route host;
setting `KASPA_X402_GATEWAY_BASE_URL` alone does not change the request origin.
`npm run check:demo-gateway` checks both resource URLs. Keep the funded client's
origin and resource pins strict and point them at this same local origin.
Funded tests still require the isolated wallet and environment described in
[Live Testnet Proof](live-testnet-proof.md).

## Current Deployment Evidence

The current gateway deployment is Worker version
`f9ef62e0-17b4-45c4-8765-e3c1789efb99`, built from tagged commit
`040b1ec8335abadbb3c69cf1ea720ae45816b0f7` with fresh
`demo-gateway-v1.0.0-rc.1` durable state.

- `/health` reports enabled v1 RC1 `standard-native` exact settlement with PNN
  broadcasting;
- the scheduled canary passes the TN10 REST, current release metadata, schema, docs,
  exact-offer, batch-offer, and unsupported-scheme checks;
- funded exact transaction
  `a502fc42046dd18b8ac7712e9b13ebe90f70c9d5094a86a73c4300e625943575`
  settled at accepted finality;
- its identical retry returned the stored HTTP `200` settlement, while
  cross-resource reuse returned HTTP `409`.

### Exact Tagged-Source Funded Run

An operator launched a separate fresh-state funded run from a clean checkout of
the exact tagged commit `040b1ec8335abadbb3c69cf1ea720ae45816b0f7` with the
reference live adapter. The sanitized report was generated at
`2026-09-13T14:27:25.308Z`; it recorded status `complete`, no findings, and all
18 required exact and batch flow statuses as passed.

The run's gateway integration exercised a local Worker built from that exact
checkout at `http://localhost:8788`, not the public gateway deployment:

- the initial batch deposit returned HTTP `200`, opened channel
  `d963aa4eed7dab963977ba363d99f99ccef3548824d369944780ae1a88bbe0f8`,
  charged `500` sompi, and settled transaction
  `81af41d91b376230a056bdab9995d67707c08e43f8eb224a8701e3d921e500a0`;
- the lifetime-voucher request returned HTTP `200`, kept the channel open,
  raised the cumulative charge to `1000` sompi, and settled transaction
  `df48f0991b819b21acbdc14cf2a7bea1f9bbb10c0fcb8a2274a751f019ee93ef`;
  and
- replaying the initial payment returned HTTP `200` with the original deposit
  transaction id, confirming the tagged Worker's hosted-batch idempotency.

The operator command was
`npm run proof:live:check -- --live --write-report`, using
`scripts/live-adapter-reference.mjs` and a new recovery directory. Reproduction
requires an isolated funded Testnet wallet and the live-run environment
described in [Live Testnet Proof](live-testnet-proof.md).

The final raw report and signing material remain in the operator's ignored
local evidence directory; the record above is the sanitized public evidence
for the exact tagged-source run.

This is bounded Testnet evidence, not a production or mainnet-readiness claim.

## Current Payment Terms

The gateway uses:

- `network: "kaspa:testnet-10"`;
- `asset: "KAS"`;
- accepted finality;
- 30-confirmation covenant transition and lineage policy;
- exact price `20000000` sompi;
- batch voucher charge `500` sompi;
- batch minimum deposit `20000000` sompi;
- batch claim reserve `10000000` sompi;
- batch refund horizon of current virtual DAA plus at most `36000`;
- minimum server refund safety lead of `1000` DAA score.

Kaspa has no universal `10000000` sompi consensus dust floor. KIP-9 storage
mass depends on the complete transaction shape. The reference Worker uses
`10000000` sompi as a conservative application policy for on-chain outputs,
including the advertised batch successor reserve.

The v1 RC1 Worker emits batch offers with binding `kaspa-escrow-v3`, template
`kaspa-x402-escrow-v4`, and a `10000000` sompi claim reserve. Its exact offers
carry binding `kaspa-exact-v2` and an explicit profile:

- `standard-native` needs no merchant head inventory;
- `additive` spends the advertised KIP-10 head and recreates a same-script
  successor increased by exactly the advertised amount.

An unpaid additive offer reads the current head but does not reserve, retire,
or consume it. A successful settlement atomically claims the advertised
outpoint and advances the durable lineage. Stale competing clients receive a
fresh 402 for the current head.

## Additive Head Operations

Register head records with:

```sh
KASPA_X402_DEMO_ADMIN_TOKEN=<token> \
  npm run demo:exact-heads -- register --file heads.json
```

Check availability with:

```sh
KASPA_X402_DEMO_ADMIN_TOKEN=<token> npm run demo:exact-heads -- stats
```

If a known external transaction advanced a head, reconcile it with the
complete ordered accepted lineage:

```sh
KASPA_X402_DEMO_ADMIN_TOKEN=<token> \
  npm run demo:exact-heads -- reconcile \
  --head-id <head-id> \
  --transactions <first-txid>,<next-txid>
```

Each transaction must spend the preceding outpoint, preserve the same script
and output index, satisfy the KIP-10 threshold, and end at the current unspent
head. A same-address output without that lineage is never adopted.

## Verification And Chain Evidence

The Worker uses `https://api-tn10.kaspa.org` for read-side evidence:

- `/info/blockdag` for network and virtual DAA health;
- `/addresses/{address}/utxos` for accepted UTXO evidence;
- `/transactions/{transaction_id}` and `/transactions/acceptance` for accepted
  finality;
- derived escrow-address UTXOs for batch funding.

Exact transaction artifacts are submitted through configured public TN10
PNN/WSS endpoints. The REST submit fallback must not be cited as KIP-10
broadcast evidence because it does not preserve the v1 compute-budget field.
The same PNN connection supplies complete `GetVirtualChainFromBlockV2` deltas
for batch lineage recovery. REST UTXO presence does not prove removed-chain
continuity or authorize a recovered batch head.

The gateway fails closed when it cannot establish chain health, transaction
validity, accepted finality, or required durable state. Protected content is
not produced for unsupported schemes or unverifiable payments.

### Accepted Single-Source Limitation

The reference gateway and live harness currently trust one configured source
for exact acceptance, batch genesis/current-UTXO state, and PNN selected-chain
evidence. These N03-N05 findings are accepted only for Testnet-10 testing with
one source. A faulty source could provide consistently false evidence.

This design must not be enabled for mainnet. Mainnet requires independently
corroborated chain evidence or another audited Byzantine-resilient design;
unknown or disagreeing evidence must fail closed.

## Durable State

Gateway state is held in a SQLite-backed Cloudflare Durable Object. It records:

- exact transaction replay claims;
- reusable additive heads and atomic successor advancement;
- payment-identifier response cache entries;
- batch channel state and settlement commitments;
- immutable batch launch manifests, append-only lineage journals, selected-chain
  checkpoints, and atomically derived current heads;
- request locks, rate counters, metrics, and the latest canary report.

No private keys or wallet seeds are stored. This is a demo deployment pattern,
not a production sharding or custody recommendation.

## Browser And CORS Use

The public deployment allows browser calls from `https://kaspa-x402.org` and
exposes `PAYMENT-REQUIRED` and `PAYMENT-RESPONSE`. Paid retries may send
`PAYMENT-SIGNATURE`.

`PAYMENT-SIGNATURE` is bearer settlement evidence for this trust domain. Send
it only over TLS to the intended gateway and do not publish or log unused
payment headers or transaction material.

## Testnet Funding

Testers need their own `kaspa:testnet-10` wallet or SDK flow. The public faucet
is:

```text
https://faucet-tn10.kaspanet.io/
```

Deployment, rollback, disable, canary, and incident procedures are in the
[demo operations runbook](/docs/demo-operations/). Full transaction evidence is
in the [live testnet report](/docs/live-testnet-report/).
