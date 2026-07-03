# Testnet Gateway

Status: alpha, testnet-only reference gateway for `exact` and
`batch-settlement` payments on `kaspa:testnet-10`.

The hosted gateway is a public integration target for implementers who want to
exercise the Kaspa x402 wire flow against a real server. It is not a wallet,
custodian, facilitator, mainnet service, or availability commitment.

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
- exact payments must include a transaction id and the selected output must be
  present at the advertised pay-to address;
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

## Testnet Funding

Testers need their own `kaspa:testnet-10` wallet or SDK flow and can use the
public testnet faucet:

```text
https://faucet-tn10.kaspanet.io/
```

## Exact Payment Evidence

Run evidence from 2026-07-03:

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

Run evidence from 2026-07-03:

- Worker version: `1c43423f-d4fe-4df7-8797-c2466d308622`;
- deposit amount: `20000000` sompi;
- per-request voucher charge: `500` sompi;
- deposit transaction id:
  `0d5f9a9ba94d9be227f115e059b600167be34eda0fbc63f372b9a1351f18991d`;
- deposit output index: `0`;
- channel id:
  `25d6a5257f056f94ce6e76ed5c4314418aa5337108ae8b1cf57f30465e4c41ac`;
- deposit-voucher paid retry: HTTP `200` with
  `PAYMENT-RESPONSE.success: true`, commitment
  `95b482fd26e09cf1f91acf9291b517f025cb3c46e61b6ce61184b3e0d6a67de0`,
  charged amount `500`, and channel state showing signed max claimable `500`;
- identical deposit-voucher retry before a later voucher: HTTP `200` from the
  durable commitment record with the same commitment id;
- voucher-only paid retry on the same channel: HTTP `200` with
  `PAYMENT-RESPONSE.success: true`, commitment
  `5239494fc08ab80dfa8e8396626caedcb2c32d5dfe89a609fc7e5164ed54c86c`,
  charged amount `500`, and channel state showing signed max claimable `1000`;
- stale replay of the earlier deposit-voucher after the later voucher: HTTP
  `402`, preserving corrective stale-voucher behavior;
- `/health` metrics after the run showed `paid_batch: 5`.
