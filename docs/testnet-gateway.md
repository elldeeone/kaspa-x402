# Testnet Gateway

Status: the public URL is a paid-canary-proven alpha.8 `kaspa:testnet-10`
deployment using the default `standard-native` exact profile.

The hosted gateway is a public integration target for implementers who want to
exercise the Kaspa x402 wire flow against a real server. It is not a wallet,
custodian, facilitator, mainnet service, or availability commitment.

Alpha.8 introduces `kaspa-exact-v2`: default
`standard-native` exact settlement and an optional reusable KIP-10 `additive`
head profile whose successor delta is the sole payment. Batch settlement,
absolute DAA handling, and claim recovery remain intact.

Hosted status: Worker version `d9bac848-bc14-4326-9945-7a5a5722d63a`, built
from commit `37a4704`, is live. The funded alpha.8 run settled a
`standard-native` exact transaction through TN10 PNN, confirmed idempotent
replay and cross-resource rejection, and observed the merchant output at
accepted finality. The default profile needs no exact inventory; only optional
`additive` is head-availability gated. Historical alpha.7 evidence remains
below for comparison.

## Base URL

The gateway deployment is reachable at:

```text
https://demo.kaspa-x402.org
```

## Endpoints

| Method | Path                         | Purpose                                                                                                                                                     |
| ------ | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/`                          | Returns a JSON endpoint index.                                                                                                                              |
| `GET`  | `/health`                    | Returns configuration health and current `kaspa:testnet-10` chain evidence.                                                                                 |
| `GET`  | `/canary`                    | Returns the enabled state and latest scheduled canary report.                                                                                               |
| `GET`  | `/supported`                 | Returns the direct-mode supported-kind list.                                                                                                                |
| `GET`  | `/exact` and `/exact/report` | Protected exact-payment JSON resource. Alpha.8 `standard-native` returns `402` while exact is enabled; optional `additive` also requires an available head. |
| `GET`  | `/batch` and `/batch/report` | Protected batch-settlement JSON resource. Unpaid requests return `402` with `PAYMENT-REQUIRED`.                                                             |
| `GET`  | `/metrics`                   | Returns coarse gateway counters for smoke testing and operations.                                                                                           |

The alpha.8 Worker source exposes admin-only additive-head endpoints:

| Method | Path                           | Purpose                                                                                                                                    |
| ------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`  | `/admin/exact-heads`           | Requires `Authorization: Bearer <token>`; returns head stats and records.                                                                  |
| `POST` | `/admin/exact-heads/register`  | Requires `Authorization: Bearer <token>`; registers funded reusable KIP-10 head terms.                                                     |
| `POST` | `/admin/exact-heads/reconcile` | Requires `Authorization: Bearer <token>`; proves an ordered accepted successor lineage and atomically restores the resulting current head. |

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
"kaspa-escrow-v1"`. Alpha.8 exact uses `extra.binding: "kaspa-exact-v2"` and
an explicit profile. `standard-native` needs no inventory. `additive` is
advertised only when hosted exact settlement is enabled and a matching durable
head is available.

Unsupported schemes are rejected before protected content is produced or
gateway state is written.

Current deployed alpha.8 terms:

- exact price if enabled: `20000000` sompi;
- batch voucher charge: `500` sompi;
- batch minimum deposit: `20000000` sompi;
- batch refund horizon: current virtual DAA plus at most `36000`;
- minimum server refund safety lead: `1000` DAA score.

The exact price and batch deposit are on-chain outputs. Because KIP-9 storage
mass depends on the complete input/output composition, Kaspa has no universal
`10000000` sompi consensus dust floor. The reference Worker nevertheless uses
`10000000` sompi as a conservative on-chain output policy and fails closed at
startup below it.
Alpha.8 additive uses merchant-owned reusable heads and advertises a positive
`additiveThresholdSompi`; application verification additionally requires the
successor delta to equal the advertised amount exactly.

`KASPA_X402_REFUND_TIMEOUT_DAA_DELTA` defines the maximum duration from a
freshly read virtual DAA score. The Durable Object persists one absolute offer
timeout so repeated requests can reuse the same covenant channel, then rolls
that timeout forward only when it reaches the minimum-lead boundary.
`KASPA_X402_MINIMUM_REFUND_LEAD_DAA` makes the gateway fail closed before the
escrow reaches that boundary. Kaspa lock-time finality is strict: a refund with
lock time `T` is eligible only once the contextual DAA score is greater than
`T`. All DAA-mode timeouts must remain below the `500000000000` consensus
timestamp boundary.

Exact head records are public transaction terms, not wallet secrets. An
alpha.8 registration record has this shape:

```json
{
  "headId": "<deterministic-lineage-id>",
  "network": "kaspa:testnet-10",
  "payTo": "kaspatest:<p2sh-head-address>",
  "templateId": "kaspa-x402-kip10-additive-v1",
  "transactionEncoding": "kaspa-sdk-safe-json-v2.0.0",
  "currentOutpoint": { "txid": "<funded-head-txid>", "index": 0 },
  "currentAmount": "100000000",
  "scriptPublicKey": "0000...",
  "redeemScript": "...",
  "additiveThresholdSompi": "10000000",
  "version": "0",
  "status": "available",
  "createdAt": "<ISO-8601>",
  "updatedAt": "<ISO-8601>"
}
```

Register heads with:

```sh
KASPA_X402_DEMO_ADMIN_TOKEN=<token> \
  npm run demo:exact-heads -- register --file heads.json
```

The admin helper accepts the bearer token only through
`KASPA_X402_DEMO_ADMIN_TOKEN`; command-line token arguments are rejected because
process arguments may be visible to other users. It also refuses non-loopback
plain HTTP so the bearer token is never sent over an unencrypted remote link.

Check availability with:

```sh
KASPA_X402_DEMO_ADMIN_TOKEN=<token> npm run demo:exact-heads -- stats
```

The Worker checks only a bounded selected additive head against the accepted
address UTXO set before issuing a challenge. Anonymous request work does not
scan the full inventory. A missing or conflicting selected outpoint is marked
unavailable only if the durable version/outpoint/amount/status still match the
checked snapshot. If an external transaction legitimately advanced that head,
restore it only with the complete ordered lineage:

```sh
KASPA_X402_DEMO_ADMIN_TOKEN=<token> \
  npm run demo:exact-heads -- reconcile \
  --head-id <head-id> \
  --transactions <first-txid>,<next-txid>
```

Each accepted transaction must spend the preceding outpoint, recreate the same
script at the same output index with at least the fixed KIP-10 increase, and
end at the current unspent UTXO. A same-address output without that lineage is
never adopted. Calling `reconcile` without `--transactions` performs a
current-head check and fails closed if the durable outpoint is missing.

Registration enables additive offers only when hosted exact settlement is also
enabled. Unpaid offers only read a head. An accepted settlement atomically
claims the expected outpoint and advances the lineage to its verifier-derived
same-script successor. Expired unanswered challenges do not retire the head;
stale clients refresh against the current version.

Operational details, rollback steps, the gateway disable switch, and manual
paid canary procedure are covered in the
[demo operations runbook](/docs/demo-operations/).

## Chain Adapter

The Worker uses the public `kaspa:testnet-10` REST explorer endpoint
`https://api-tn10.kaspa.org` as its read-side chain evidence source. The adapter
checks:

- `/info/blockdag` for network and virtual DAA health;
- `/addresses/{address}/utxos` for accepted pay-to UTXO evidence;
- `/transactions/{transaction_id}` and `/transactions/acceptance` for accepted
  finality evidence;
- derived escrow-address UTXOs for batch channel funding.

For hosted exact, the Worker submits KIP-10 transaction artifacts through the
configured public TN10 PNN/WSS endpoints. The REST submit fallback remains in
code for non-KIP-10 paths, but current public REST submit does not carry
`transaction.inputs[].computeBudget` into Kaspa RPC and must not be cited as
KIP-10 broadcast evidence.

Failure modes are fail-closed:

- if REST chain health fails, paid endpoints do not settle payments;
- exact payments are unavailable unless the gateway can verify an
  `exact-transaction` artifact, broadcast it if needed, and observe finality;
  optional additive settlement also requires a current durable head and atomic
  lineage advancement;
- batch deposits and vouchers must reference an accepted active escrow UTXO;
- claim broadcasting is disabled on the hosted gateway.

## Durable State

Gateway state is held in a SQLite-backed Cloudflare Durable Object. The ledger
records:

- exact transaction replay claims;
- reusable KIP-10 additive heads, atomic settlement claims, and verified
  continuation advancement;
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

The alpha.8 `exact-transaction` path requires an explicit profile plus a signed
SDK-safe JSON transaction artifact. `standard-native` binds the exact output.
`additive` also binds a complete head challenge and requires the successor
delta to be the sole exact payment. The gateway rejects the superseded alpha.7
reservation envelope and observe-only `exact-transfer` evidence.

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

## Alpha.8 Evidence Status

Status: complete for the 2026-07-15 hosted alpha.8 deployment.

- current Worker version: `d9bac848-bc14-4326-9945-7a5a5722d63a`, built from
  commit `37a4704`;
- configured exact profile: `standard-native` under `kaspa-exact-v2`;
- `/supported` advertised exact and batch settlement, and unpaid `/exact`
  returned a valid `20000000` sompi standard-native offer without inventory;
- operator-node virtual DAA score at run start: `517655976`;
- exact transaction id:
  `198191204a1b1cc5ab79e56d83621f8cf880358ef970adf545379e0b9e3584f9`;
- transaction artifact SHA-256:
  `0fa45cc0ca612ddcd7d7c41a723f20ab235e297ce90546b65f178a27687fdfa4`;
- request result: HTTP `200`, payment output index `0`, charged amount
  `20000000` sompi, finality `accepted`;
- identical retry: HTTP `200` with the same settlement transaction;
- same transaction against `/exact/report`: HTTP `409`,
  `invalid_transaction_state`;
- the accepted merchant outpoint was observed at transaction index `0` through
  the operator-controlled TN10 node.

The first cutover canary exposed two live-adapter compatibility gaps before a
payment was accepted: the proof did not commit contextual KIP-9 storage mass,
and the Worker rejected the current Rusty Kaspa SDK's explicit zero v0 compute
budget. Commit `37a4704` fixes both boundaries and adds regression coverage.
The successful transaction above is from the corrected deployment.

## Alpha.7 Evidence Status

Status: complete for the 2026-07-14 hosted alpha.7 redeploy.

The paid canary first caught a rolling-DAA integration defect: recomputing a
different absolute timeout for every offer could make a client open a second
deposit instead of reusing its covenant channel. The deployed fix persists one
safe absolute timeout in the Durable Object and rolls it forward only at the
configured minimum-lead boundary. Unit tests and the repeated hosted batch run
cover the corrected behavior.

Deployment and DAA evidence:

- current Worker version: `38f3d622-4638-4821-a7d4-23b5ae3e97b2`, built from
  commit `4d53d02`;
- funded-canary Worker version: `d4716742-d771-454d-92d4-83ea5b0d36e9`; the
  final source-parity deploy adds only a fail-closed check before persisting a
  timeout that would cross the consensus timestamp boundary;
- three consecutive unpaid batch offers advertised the same absolute
  `refundTimeoutDaa: "516611736"`;
- gateway chain DAA after the final deploy: `516582525`, leaving `29211` DAA
  of lead;
- the timeout was below the `500000000000` consensus timestamp boundary;
- `/health`, `/supported`, exact inventory, and three unpaid batch checks
  passed after the final source-parity deployment. The scheduled canary passed
  after the funded-canary deployment at `2026-07-14T08:15:58.974Z`.

Hosted exact proof:

- client RPC evidence source: operator-controlled synced `kaspa:testnet-10`
  node with UTXO index;
- Worker broadcast path: public TN10 PNN/WSS JSON endpoints;
- virtual DAA score at run start: `516576106`;
- registered borrow outpoints:
  `ddfed142fdf97785e65667fbf9b535ed2e7bd16f49863000e63b8d2891d3775a:0`
  and
  `611650aec4ea3d16d7067a24723e087b3bbb7721d3bd1b8e1a24883de41d0470:0`;
- borrow amount per item: `100000000` sompi;
- additive threshold: `10000000` sompi;
- reservation id:
  `369ff97aa33d97c7118e1d7165bd4d7ff97b956d206f64f7e921d863794661bb`;
- transaction artifact SHA-256:
  `eee877a69e9cbfd3e89961fea7d934c5b4ce7641141318c85bd9bf2b0f737b5b`;
- exact transaction id:
  `e6c9238970d9e6b76279674fea611a517158f766b6f372b34501b2529bef89c5`;
- request result: HTTP `200`, payment output index `1`, charged amount
  `20000000` sompi, finality `accepted`;
- identical retry: HTTP `200` with the same settlement transaction;
- same transaction against `/exact/report`: HTTP `409`,
  `invalid_transaction_state`;
- inventory after settlement: `2` available, `5` consumed, `14` retired. The
  accepted transaction's verifier-derived continuation was registered
  atomically.

Hosted batch proof:

- virtual DAA score at run start: `516575867`;
- channel id:
  `d50c638480087fb096224b6094bcba5f13c82b5b19f21637c97ea516efbf4cec`;
- funding outpoint:
  `e553adf26c97f580e7fe5670e0bcfa0a2a8291f7599902c477ad053ccc1fe859:0`;
- funding amount: `20000000` sompi;
- deposit-voucher: HTTP `200`, opened channel `true`, settlement commitment
  `ff11f9d6ea7563d90537b08704f35907d9740a2ffa58f6bf840dd7ff318a4e08`;
- voucher-only reuse: HTTP `200`, opened channel `false`, settlement commitment
  `88f9933573f28f948fa7d3fc5e378b002435378fe2cc180d6e43396b2d5cd16d`;
- cumulative charged and signed maximum after reuse: `1000` sompi;
- stale deposit-voucher replay: corrective HTTP `402`,
  `invalid_payment_requirements`, with the current channel state.

## Alpha.6 Evidence Status

Status: historical source live evidence and hosted gateway exact proof complete.

Alpha.6 source introduces KIP-10 exact transaction artifacts and removes
observe-only exact from the current supported exact path. The private TN10 live
harness passed on 2026-07-09 and is summarized in
`docs/live-testnet-report.md`. The public hosted gateway proof was then run on
2026-07-09 after deploying the Worker path, registering funded inventory, and
confirming `/supported` advertises `exact`.

Hosted exact proof:

- Worker version:
  `47862b0f-2ecf-49d0-b793-81e89caa4dfa`;
- client RPC evidence source: operator-controlled synced `kaspa:testnet-10`
  node with UTXO index;
- Worker broadcast path: public TN10 PNN/WSS JSON endpoints;
- virtual DAA score at run start: `512119428`;
- registered borrow inventory count: `3`;
- registered borrow outpoints:
  `6d523b56724fc6cd298a18724eaf798e29cac9a95fb7b1f53189ab13433f8191:0`,
  `e8fa2c24be8d0c426e5ca647e35cc21064f1b70696ec256d8a0f040e53488897:0`,
  and
  `837523c22cec7ba9cd7e4080db594e7c5ca8581145f36a557081ccb29fdc00c0:0`;
- borrow amount per inventory item: `100000000` sompi;
- additive threshold: `10000000` sompi;
- reservation id:
  `1eab6dc69af1a7570443952d874df16cb7313bb839e2588f9540b2cd0dedee3c`;
- transaction artifact SHA-256:
  `12fbe2b88521c44e4509024b078d1c39fbdb55a2594f72aca2f733680da66e82`;
- exact request result: HTTP `200`;
- exact transaction id:
  `632dadcf96ac9ce4c56c781d95aac31ed52365a0fb86eb4b0cbbcd1f3eb2f55c`;
- payment output index: `1`;
- charged amount: `20000000` sompi;
- finality: `accepted`;
- identical paid retry result: HTTP `200` with the same settlement
  transaction;
- inventory after payment: `5` available, `2` consumed, `1` reserved. The
  reserved item was an unrelated unpaid live probe still inside its lease
  window at the read time.

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
