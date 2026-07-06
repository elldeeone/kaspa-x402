# Testnet Gateway

Status: alpha, testnet-only reference gateway for `exact` and
`batch-settlement` payments on `kaspa:testnet-10`.

The hosted gateway is a public integration target for implementers who want to
exercise the Kaspa x402 wire flow against a real server. It is not a wallet,
custodian, facilitator, mainnet service, or availability commitment.

Deployment status on 2026-07-06: `0.1.0-alpha.5` is deployed on the static
site and the hosted Worker. Exact payload evidence is `transactionId` plus
`paymentOutputIndex`; legacy serialized `transaction` evidence is rejected.
The separate private TN10 full live harness was rerun for alpha.5 on
2026-07-06 and is recorded in `docs/live-testnet-report.md`.

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
| `GET` | `/exact` and `/exact/report` | Protected exact-payment JSON resource. Unpaid requests return `402` with `PAYMENT-REQUIRED`. |
| `GET` | `/batch` and `/batch/report` | Protected batch-settlement JSON resource. Unpaid requests return `402` with `PAYMENT-REQUIRED`. |
| `GET` | `/metrics` | Returns coarse gateway counters for smoke testing and operations. |

`HEAD` follows the same payment behavior as `GET` without a response body.
`OPTIONS` returns the CORS preflight response.

## Payment Terms

The gateway only advertises:

- `network: "kaspa:testnet-10"`;
- `asset: "KAS"`;
- `scheme: "exact"` with `extra.binding: "kaspa-exact-v1"`;
- `scheme: "batch-settlement"` with `extra.binding: "kaspa-escrow-v1"`;
- accepted finality of `accepted`;
- a testnet pay-to address configured in the Worker environment.

Unsupported schemes are rejected before protected content is produced or
gateway state is written.

Current hosted terms:

- exact price: `20000000` sompi;
- batch voucher charge: `500` sompi;
- batch minimum deposit: `20000000` sompi.

The exact price and batch deposit are on-chain outputs, so they must stay at or
above the Kaspa standard-output storage-mass floor of `10000000` sompi. The
Worker fails closed at startup if either configured value is below that floor.

Operational details, rollback steps, the gateway disable switch, and manual
paid canary procedure are covered in the
[demo operations runbook](/docs/demo-operations/).

## Chain Adapter

The Worker uses the public `kaspa:testnet-10` REST explorer endpoint
`https://api-tn10.kaspa.org` as its chain evidence source. The adapter checks:

- `/info/blockdag` for network and virtual DAA health;
- `/addresses/{address}/utxos` for accepted pay-to UTXO evidence;
- derived escrow-address UTXOs for batch channel funding.

Failure modes are fail-closed:

- if REST chain health fails, paid endpoints do not settle payments;
- exact payments must include `payload.transactionId` and
  `payload.paymentOutputIndex`; the selected output must be present at the
  advertised pay-to address;
- batch deposits and vouchers must reference an accepted active escrow UTXO;
- claim broadcasting is disabled on the hosted gateway.

## Durable State

Gateway state is held in a SQLite-backed Cloudflare Durable Object. The ledger
records:

- exact transaction replay reservations;
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

For alpha.5 exact payments, the header payload carries the observed
`transactionId` and selected `paymentOutputIndex`. A serialized `transaction`
field is legacy alpha evidence and must not be accepted as exact-payment
evidence after the alpha.5 gateway deployment.

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
