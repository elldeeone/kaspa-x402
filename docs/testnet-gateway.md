# Testnet Gateway

Status: alpha, testnet-only reference gateway for `exact` and
`batch-settlement` payments on `kaspa:testnet-10`.

The hosted gateway is a public integration target for implementers who want to
exercise the Kaspa x402 wire flow against a real server. It is not a wallet,
custodian, facilitator, mainnet service, or availability commitment.

Deployment status: alpha.6 source uses the KIP-10 `exact-transaction` path for
direct-mode servers that advertise reservations. The hosted Worker can reserve
Durable Object-backed exact inventory, verify a signed SDK-safe JSON
transaction artifact, match an accepted chain transaction back to that artifact,
observe finality, and consume the reservation. The public TN10 REST submit
model does not preserve tx-v1 compute budget, so hosted exact clients must
broadcast the signed artifact through a Kaspa RPC path before retrying the
gateway. The gateway advertises `exact` only while funded borrow-UTXO inventory
is available; when inventory is empty, `/exact` returns `503 exact_unavailable`
and `/batch` remains usable. The separate private TN10 full live harness was
rerun for alpha.6 on 2026-07-09 and is recorded in
`docs/live-testnet-report.md`.

## Base URL

The gateway is deployed at:

```text
https://demo.kaspa-x402.org
```

## Endpoints

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET` | `/` | Returns a JSON endpoint index. |
| `GET` | `/health` | Returns configuration health and current `kaspa:testnet-10` chain evidence. |
| `GET` | `/canary` | Returns the enabled state and latest scheduled canary report. |
| `GET` | `/supported` | Returns the direct-mode supported-kind list. |
| `GET` | `/exact` and `/exact/report` | Protected exact-payment JSON resource. Unpaid requests return `402` with `PAYMENT-REQUIRED` only while hosted KIP-10 inventory is available; otherwise returns `503 exact_unavailable`. |
| `GET` | `/batch` and `/batch/report` | Protected batch-settlement JSON resource. Unpaid requests return `402` with `PAYMENT-REQUIRED`. |
| `GET` | `/metrics` | Returns coarse gateway counters for smoke testing and operations. |

The Worker also exposes admin-only exact inventory endpoints:

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET` | `/admin/exact-inventory` | Requires `Authorization: Bearer <token>`; returns inventory stats and records. |
| `POST` | `/admin/exact-inventory/register` | Requires `Authorization: Bearer <token>`; registers funded KIP-10 borrow UTXO terms. |

The admin token is a Worker secret and is not committed to the repository.

`HEAD` follows the same payment behavior as `GET` without a response body.
`OPTIONS` returns the CORS preflight response.

## Payment Terms

The gateway always uses:

- `network: "kaspa:testnet-10"`;
- `asset: "KAS"`;
- accepted finality of `accepted`;
- a testnet pay-to address configured in the Worker environment.

The hosted gateway always advertises `batch-settlement` with `extra.binding:
"kaspa-escrow-v1"`. It advertises `exact` only when hosted exact settlement is
enabled and at least one funded KIP-10 borrow UTXO is available in inventory.

Unsupported schemes are rejected before protected content is produced or
gateway state is written.

Current hosted terms:

- exact price if enabled: `20000000` sompi;
- batch voucher charge: `500` sompi;
- batch minimum deposit: `20000000` sompi.

The exact price and batch deposit are on-chain outputs, so they must stay at or
above the Kaspa standard-output storage-mass floor of `10000000` sompi. The
Worker fails closed at startup if either configured value is below that floor.
Hosted exact uses merchant-owned borrow UTXO inventory and advertises an
`additiveThresholdSompi` of at least `10000000` sompi.

Exact inventory records are public transaction terms, not wallet secrets. A
registration record has this shape:

```json
{
  "network": "kaspa:testnet-10",
  "templateId": "kaspa-x402-kip10-additive-v1",
  "transactionEncoding": "kaspa-sdk-safe-json-v2.0.0",
  "borrowOutpoint": { "txid": "<funded-borrow-txid>", "index": 0 },
  "borrowAmount": "100000000",
  "borrowScriptPublicKey": "0000...",
  "borrowRedeemScript": "...",
  "additiveThresholdSompi": "10000000",
  "paymentOutputIndex": 1
}
```

Register inventory with:

```sh
KASPA_X402_DEMO_ADMIN_TOKEN=<token> \
  npm run demo:exact-inventory -- register --file inventory.json
```

Check availability with:

```sh
KASPA_X402_DEMO_ADMIN_TOKEN=<token> npm run demo:exact-inventory -- stats
```

Registration enables public exact offers only when the hosted exact settlement
flag is also enabled. Expired reserved inventory is retired for operator
reconciliation rather than automatically reused, because a late or
already-propagating transaction may still consume the borrow outpoint.

Operational details, rollback steps, the gateway disable switch, and manual
paid canary procedure are covered in the
[demo operations runbook](/docs/demo-operations/).

## Chain Adapter

The Worker uses the public `kaspa:testnet-10` REST explorer endpoint
`https://api-tn10.kaspa.org` as its chain evidence source. The adapter checks:

- `/info/blockdag` for network and virtual DAA health;
- `/addresses/{address}/utxos` for accepted pay-to UTXO evidence;
- `/transactions/{transaction_id}` and `/transactions/acceptance` for accepted
  finality evidence;
- derived escrow-address UTXOs for batch channel funding.

The Worker has a REST submit fallback in code, but current public REST submit
does not carry `transaction.inputs[].computeBudget` into Kaspa RPC. It must not
be cited as KIP-10 broadcast evidence until that upstream API supports tx-v1
compute budget or the Worker is configured with another reviewed broadcast
path.

Failure modes are fail-closed:

- if REST chain health fails, paid endpoints do not settle payments;
- exact payments are unavailable unless the gateway can reserve KIP-10 borrow
  terms, verify an `exact-transaction` artifact, broadcast it if needed, observe
  finality, and consume the reservation;
- batch deposits and vouchers must reference an accepted active escrow UTXO;
- claim broadcasting is disabled on the hosted gateway.

## Durable State

Gateway state is held in a SQLite-backed Cloudflare Durable Object. The ledger
records:

- exact transaction replay reservations;
- exact KIP-10 borrow UTXO inventory and active reservation leases;
- payment-identifier response cache entries;
- batch channel state and settlement commitments;
- one open claim attempt per channel, though public claim execution is disabled;
- lease-style request locks used by the direct-mode server;
- per-window rate counters and coarse operational metrics;
- the latest scheduled canary report.

This state layout is a demo deployment pattern, not a production sharding
recommendation. Production operators should pick state boundaries that match
their own trust domains, traffic, and recovery requirements.

## CORS

The public deployment allows browser calls from `https://kaspa-x402.org` and
exposes:

```text
PAYMENT-REQUIRED, PAYMENT-RESPONSE
```

Paid retries may send:

```text
PAYMENT-SIGNATURE
```

The `PAYMENT-SIGNATURE` header is bearer settlement evidence for this trust
domain. Send it only over TLS to the intended gateway, and do not publish or log
unused payment headers or transaction material before the paid retry has been
settled.

The alpha.6 `exact-transaction` path requires server-advertised buildable
reservation terms, including the borrow redeem script and additive threshold,
plus a signed SDK-safe JSON transaction artifact. The hosted gateway rejects
observe-only `exact-transfer` evidence on reserved offers.

## Testnet Funding

Testers need their own `kaspa:testnet-10` wallet or SDK flow and can use the
public testnet faucet:

```text
https://faucet-tn10.kaspanet.io/
```

## Alpha.4 Incident Note

Date: 2026-07-04.

The alpha.4 gateway cutover fixes hosted voucher verification to match the
covenant-enforced raw-digest Schnorr signature scheme. Batch channels opened
before the cutover used the rejected personal-message voucher scheme and are
invalidated as claimability evidence.

Operator actions:

- disabled the gateway before the reset with Worker version
  `883d52dc-8850-4dfe-81a6-a3166d07cd39`;
- reset the hosted Durable Object state under the public alpha state policy
  with temporary reset Worker version
  `da843e69-6837-4311-8430-35710c9b7f79`;
- redeployed the reviewed alpha.4 Worker and re-enabled the gateway at Worker
  version `fadaa70b-38c7-4b69-9001-ad3c5397bf7f`;
- confirmed `/health`, `/canary`, and unpaid exact and batch `402` offers after
  re-enable.

Paid evidence affected: the previous 2026-07-03 batch evidence is superseded
and must not be used as voucher-claimability evidence. The exact-payment
evidence remains unaffected by the voucher-signature issue.

## Alpha.5 Evidence Status

Status: complete for the 2026-07-06 hosted alpha.5 redeploy.

The alpha.5 source tree changes exact evidence from serialized `transaction`
hex to required `transactionId` plus `paymentOutputIndex`. The hosted
deployment checks completed on 2026-07-06:

- static site commit: `27a6c6d52211`;
- release snapshot: `v0.1.0-alpha.5`, content hash
  `d3e06eab6b03ab8d5e45b94dac69a46d8db94d2b7fa0867702fecc64b699fcf8`;
- Worker version:
  `470c7bc1-125b-49df-b046-a309b0257e67`;
- public smoke result: `/health`, `/supported`, unpaid `/exact`, and unpaid
  `/batch` passed;
- legacy exact payload containing `payload.transaction`: HTTP `402`;
- exact payload containing `payload.transactionId` and
  `payload.paymentOutputIndex`: reached verifier path and returned HTTP `402`
  with `invalid_transaction_state` for intentionally fake txid evidence;
- paid hosted TN10 E2E result: exact, deposit-voucher, voucher-only, and stale
  replay checks passed.

## Alpha.6 Evidence Status

Status: source live evidence and hosted gateway exact proof complete.

Alpha.6 source introduces KIP-10 exact transaction artifacts and removes
observe-only exact from the current supported exact path. The private TN10 live
harness passed on 2026-07-09 and is summarized in
`docs/live-testnet-report.md`. The public hosted gateway proof was then run on
2026-07-09 after deploying the Worker path, registering funded inventory, and
confirming `/supported` advertises `exact`.

Hosted exact proof:

- Worker version:
  `6701209a-f008-4e21-880b-88c8dc202210`;
- client RPC evidence source: operator-controlled synced `kaspa:testnet-10`
  node with UTXO index;
- virtual DAA score at run start: `512096118`;
- registered borrow inventory count: `3`;
- registered borrow outpoints:
  `22993e0480d6e5833ee1eabbff6065328449adf55fe9faf63f46a5ac95fee321:0`,
  `0696f587396d961c141fd4928f499b71913f7d771d23798c44b5175e25aecf23:0`,
  and
  `3e6e3e48a0fbe6ff5aeb9d4e183fb8284c380f0c9b8e6949be6eca72e00b59c4:0`;
- borrow amount per inventory item: `100000000` sompi;
- additive threshold: `10000000` sompi;
- exact request result: HTTP `200`;
- exact transaction id:
  `f1ca4fc25b17adf88e5a5c90697b1a4d257a38a24900f6af0f6cfc6108832f01`;
- payment output index: `1`;
- charged amount: `20000000` sompi;
- finality: `accepted`;
- identical paid retry result: HTTP `200` with the same settlement
  transaction;
- inventory after payment: `4` available, `1` consumed, `0` reserved.

## Alpha.5 Hosted Payment Evidence

Run evidence from 2026-07-06:

- Worker version:
  `470c7bc1-125b-49df-b046-a309b0257e67`;
- client RPC evidence source: operator-controlled synced `kaspa:testnet-10`
  node with UTXO index;
- virtual DAA score at run start: `509610876`;
- channel id:
  `cdce2e14f1c3d2f562582d0df6e90951a790b035775f45e78f33d4ebbe2c7d7d`.

Exact request:

- request result: HTTP `200`;
- exact transaction id:
  `f72c6721e22331ac7ada90664d82b02929ac26098239d220cd65a14300664bc7`;
- payment output index: `0`;
- charged amount: `20000000` sompi;
- finality: `accepted`.

Deposit-voucher request:

- request result: HTTP `200`;
- opened channel: `true`;
- settlement transaction:
  `f4d556767dbaa6c32b6c66913c6ee6245a9ea23578bf5890a9c378b53d9e6aa7`.

Voucher-only reuse:

- request result: HTTP `200`;
- opened channel: `false`;
- settlement transaction:
  `d44722c9f3c1abe19f9cf427eb8b199eccd72e0317ceb6bfe6b9654709146efe`.

Stale deposit-voucher replay after the later voucher:

- request result: corrective HTTP `402`;
- error: `invalid_payment_requirements`;
- corrective channel id:
  `cdce2e14f1c3d2f562582d0df6e90951a790b035775f45e78f33d4ebbe2c7d7d`.

## Exact Payment Evidence

Historical run evidence from 2026-07-03:

- Worker version: `0362da19-c131-45bf-974b-50fad57ad6a8`;
- payment amount: `20000000` sompi;
- transaction id:
  `b67aac685e486b922ae6fa6ace7e41c0831086a02e3b73f82c30386a7fce9223`;
- payment output index: `0`;
- paid retry result: HTTP `200` with `PAYMENT-RESPONSE.success: true`,
  matching transaction id, amount, payer, and `finality: "accepted"`;
- identical retry result: HTTP `200` from the durable replay record;
- same transaction against a different resource: HTTP `409`.

## Batch Payment Evidence

Historical run evidence from 2026-07-04, after the alpha.4 Durable Object
reset:

- Worker version: `fadaa70b-38c7-4b69-9001-ad3c5397bf7f`;
- client RPC evidence source: operator-controlled synced `kaspa:testnet-10`
  node with UTXO index;
- virtual DAA score at run start: `508252237`;
- channel id:
  `7e1414f563e5fadbe9682777df4cd687d9fa2d1e3b6c67c29e2ff4440ec99b35`;
- funding transaction id:
  `e7183f919674607ed76eed0f821daa3c20bd0a0ddb58c2bf49cc697e547de23a`;
- funding outpoint index: `0`;
- funding amount: `20000000` sompi.

Deposit-voucher request:

- request result: HTTP `200`;
- opened channel: `true`;
- voucher amount: `500` sompi;
- charged amount: `500` sompi;
- charged cumulative amount: `500` sompi;
- signed max claimable: `500` sompi;
- settlement commitment:
  `a6314079499ad339743d12d2ca92a4d562501a7d56ec19f9ef2b94decafb19e8`.

Voucher-only reuse:

- request result: HTTP `200`;
- opened channel: `false`;
- voucher amount: `1000` sompi;
- charged amount: `500` sompi;
- charged cumulative amount: `1000` sompi;
- signed max claimable: `1000` sompi;
- settlement commitment:
  `21b0f6f221f322825a4a057ab2c5c5bf8b1d477339729be5afbf82557128d121`.

Stale deposit-voucher replay after the later voucher:

- request result: corrective HTTP `402`;
- error: `invalid_payment_requirements`;
- corrective channel id:
  `7e1414f563e5fadbe9682777df4cd687d9fa2d1e3b6c67c29e2ff4440ec99b35`;
- corrective charged cumulative amount: `1000` sompi;
- corrective signed max claimable: `1000` sompi.

Same-cutover exact survival check:

- request result: HTTP `200`;
- exact transaction id:
  `5b77536d07cdd35345ead4856e173de4c8678cc60e9abc6d9ab627056a724752`;
- payment output index: `0`;
- charged amount: `20000000` sompi;
- finality: `accepted`.
