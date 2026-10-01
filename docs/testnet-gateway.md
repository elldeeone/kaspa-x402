# Testnet Gateway

RC2 includes an optional native-KAS `hash-chain-additive` demo in the gateway
Durable Object. It is advertised when the operator enables it and registers an
available funded head. Use `/hash-chain/report` for the protected resource,
`/hash-chain/grant` for signed private grant claims, and `/hash-chain/status`
for availability. See the [browser walkthrough](demo-implementer-guide.md#hash-chain-browser-demo)
and [operator setup](demo-operations.md#hash-chain-demo). The RC2 public
gateway has this profile enabled with a registered head; its live status may
change if a grant is abandoned or operator recovery is required.

Status: deployed `1.0.0-rc.2` release for `kaspa:testnet-10`. Release and
hosted validation evidence is attached to the [published prerelease](https://github.com/elldeeone/kaspa-x402/releases/tag/v1.0.0-rc.2).

The hosted gateway is a public integration target for implementers exercising
the Kaspa x402 wire flow against a real server. It is not a wallet, custodian,
mainnet service, or availability commitment.

The RC2 gateway uses `kaspa-exact-v2` with the default
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

## Recorded RC2 Deployment Evidence

The gateway was deployed on 2026-10-01 from release source
`724c5fff22de500fcf729c43b59d25036fbffa9c`, with Worker version
`b9022476-0b04-4a0b-8fe2-309aa54dd0ed` and
`demo-gateway-v1.0.0-rc.2` durable state. This is the release deployment
record; subsequent operator redeployments can have different version IDs.

- `/health` reported enabled RC2 with `chainEvidenceSource: "pnn"`.
- The PNN canary, supported profiles, and public unpaid exact/batch offers passed.
- Hosted native exact returned HTTP `200`, its retry reused the settlement,
  and cross-resource replay returned HTTP `409`.
- Hosted batch deposit, voucher, and duplicate retry returned HTTP `200`.
- Three browser hash-chain payments and their retries passed across an accepted
  owner rotation; wallet and browser-storage cleanup passed.
- Native, batch, and hash-chain retries recovered the same settlements after
  gateway redeployment.
- The exact release candidate passed all 18 fresh funded exact/batch/recovery/
  refund flows, `validate:release`, and Linux/Windows CI.

Transaction IDs, archive checksums, source pins, and full sanitized evidence
are attached to the [RC2 prerelease](https://github.com/elldeeone/kaspa-x402/releases/tag/v1.0.0-rc.2).
See the [RC2 release reference](rc2-release.md) for the current public surface.
These proofs use configured public Testnet-10 nodes, without independent-node
corroboration or mainnet proof. The
[RC1 gateway record](https://github.com/elldeeone/kaspa-x402/blob/v1.0.0-rc.1/docs/testnet-gateway.md)
is historical evidence for an earlier deployment.

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

The v1 RC2 Worker emits batch offers with binding `kaspa-escrow-v3`, template
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

The Worker uses configured public Testnet-10 PNN/WSS nodes for all chain
reads and transaction submission. The public REST index is not required.
Current funding outputs are read from the node UTXO set. Before exact
submission, the gateway persists the verified input snapshot and selected-chain
checkpoint. Accepted transaction receipts are retained for retries and restart
recovery, and rechecked against the selected chain.

Batch admission reads the complete accepted genesis transaction, verifies the
singleton covenant and current UTXO, and obtains 30-confirmation selected-chain
evidence. Top-ups use the same complete transaction checks. Batch lineage
recovery processes `GetVirtualChainFromBlockV2` removals and additions from its
durable cursor. Missing or pruned historical evidence remains unavailable;
it is never replaced with client-supplied UTXO claims.

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
