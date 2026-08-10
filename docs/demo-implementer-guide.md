# Demo Implementer Guide

Status: Alpha.10, Testnet-10 only. The hosted gateway is an integration target,
not a production or mainnet service.

This guide describes the published Alpha.10 source and public gateway. The
gateway completed its fresh-state cutover and is an Alpha.10 interoperability
endpoint.

Alpha.10 uses `kaspa-escrow-v2` / `kaspa-x402-escrow-v2` for batch settlement.
The exact profiles are unchanged. Older alpha snapshots are historical artifacts
only; clients must not send their batch payloads to the Alpha.10 runtime.

## Start With The Artifacts

Canonical site:

```text
https://kaspa-x402.org
```

Useful entry points:

- schemas: `https://kaspa-x402.org/schemas/`;
- specs: `https://kaspa-x402.org/spec/`;
- vectors: `https://kaspa-x402.org/vectors/`;
- gateway docs: `https://kaspa-x402.org/docs/testnet-gateway/`;
- gateway base URL: `https://demo.kaspa-x402.org`.

Install the exact prerelease explicitly:

```sh
npm install @kaspa-x402/core@0.1.0-alpha.10 @kaspa-x402/client@0.1.0-alpha.10
```

The registry `latest` and `alpha` tags both resolve to the same Alpha.10 package
set. Alpha.10 remains prerelease software: `latest` identifies the currently
recommended alpha and does not imply a stable API, frozen wire format, or
mainnet readiness. The hosted gateway package is not published.

## Validate Schemas And Vectors

Before calling the hosted gateway, an implementation should be able to:

1. Fetch JSON Schemas from `/schemas/`.
2. Validate local copies against the published `$id` routes.
3. Load `/vectors/index.json`.
4. Validate every listed positive vector, including KIP-20 batch genesis,
   voucher, claim, top-up, and refund artifacts.
5. Confirm negative vectors fail for the expected reason.

Amounts are decimal strings in sompi. Batch arithmetic is additionally capped
at signed-int64 maximum (`9223372036854775807`) because covenant state and
SilverScript arithmetic use signed integers. KIP-9 storage mass depends on the
full transaction shape rather than defining a universal dust amount. The hosted
gateway's funding policy uses conservative values; smaller values require
transaction-specific mass and reserve analysis.

## Discover Gateway Support

```sh
curl -fsS https://demo.kaspa-x402.org/supported
```

Do not submit payment until the response advertises the expected Alpha.10
release and capability:

- `network: "kaspa:testnet-10"`;
- `asset: "KAS"`;
- `scheme: "batch-settlement"`, binding `kaspa-escrow-v2`, and template
  `kaspa-x402-escrow-v2`;
- `scheme: "exact"` under the configured exact profile; and
- accepted finality `accepted`.

`standard-native` needs no merchant inventory. Optional `additive` needs an
available reusable KIP-10 head. No mainnet profile is advertised. If `exact` is
absent from `/supported` or `/exact` returns `503 exact_unavailable`, exact
settlement is disabled or an additive deployment has no available head; use the
advertised batch profile instead.

## Exact Flow

Request the protected resource:

```sh
curl -i https://demo.kaspa-x402.org/exact
```

Hosted result while exact settlement is disabled or an additive head is
unavailable:

- HTTP `503`;
- JSON body with `error: "exact_unavailable"`.

Enabled expected result:

- HTTP `402`;
- `PAYMENT-REQUIRED` response header;
- a JSON body with `error: "payment_required"`.

Decode the `PAYMENT-REQUIRED` header and inspect `extra.profile`.
`standard-native` is the default: build an ordinary native KAS transaction whose
canonical payment output transfers exactly the advertised amount to `payTo`.
For optional `additive`, the offer contains a complete reusable head challenge:
head id/version, expected outpoint, amount, script public key, redeem script,
covenant threshold, challenge id, and canonical output index zero. Spend that
head and create the same-script successor at index zero with:

```text
successor amount = head amount + advertised exact amount
```

That successor increase is the entire merchant payment; do not create a second
merchant payment output. Build the signed SDK-safe JSON transaction artifact and
retry with an `exact-transaction` payload. The hosted gateway submits that
artifact through TN10 PNN/WSS and waits for accepted payment evidence before
serving the response:

```text
PAYMENT-SIGNATURE: <base64 x402 PaymentPayload>
```

Successful retry result:

- HTTP `200`;
- `PAYMENT-RESPONSE` header;
- response JSON identifying the resource, fingerprint, transaction id, output
  index, and accepted finality.

Identical retries with the same request and payment evidence should return the
cached HTTP `200`. Reusing the same exact transaction for a different resource
must be rejected. If an additive gateway has no available head, clients should
use `batch-settlement` or another server.

The hosted gateway uses REST for read-side evidence and public TN10 PNN/WSS for
KIP-10 exact transaction submission. Public REST submit is not used for hosted
KIP-10 broadcast because it does not preserve tx-v1 `computeBudget`.

## Batch Flow

Request:

```sh
curl -i https://demo.kaspa-x402.org/batch
```

The `402` response must contain `batch-settlement` requirements with
`extra.binding: "kaspa-escrow-v2"` and
`extra.templateId: "kaspa-x402-escrow-v2"`.

Open a lane by building and funding the advertised singleton KIP-20 genesis.
Before signing the first voucher, derive and retain its stable `covenantId` and
the genesis outpoint. Submit a `deposit-voucher` payload whose funding evidence
proves the transaction has exactly one output, the expected covenant genesis.
The gateway verifies the genesis transaction, script, value, initial state, and
covenant id before accepting protected work. A newly opened lane starts with
on-chain `S = 0`.

Later requests submit `voucher` payloads with a higher lifetime cumulative
ceiling T. The voucher signature binds Testnet-10, stable `covenantId`, and T; it
does not bind the rotating outpoint. Both client and server still persist the
current outpoint because standard RPC cannot find the current UTXO from a
covenant id.

For one lane define A as lifetime actual charges, S as lifetime gross on-chain
settlement including claim fees, V as current covenant value, and R as the
server-advertised minimum successor reserve `claimReserveSompi`. Voucher
acceptance requires:

```text
0 <= S <= A <= T
(T - S) + R <= V
```

`A - S` is outstanding actual charge and `T - S` is authorization headroom. A
claim spends one same-ID input and creates one same-ID successor. If D is the
gross claim and F is the transaction fee, the provider receives `D - F`, the
successor value is `V - D`, and successor state becomes `S + D`. A top-up also
spends one same-ID input and creates one same-ID successor, increases V, and
preserves A, S, and T. A timeout refund spends one same-ID input and creates no
same-ID successor. The complete lane sequence is singleton genesis, repeated
partial claims, same-ID top-up, then refund; durable implementations must reload
the current head and any unresolved transition attempt after restart.

Successful paid retries return HTTP `200` with
`PAYMENT-RESPONSE.success: true`, a commitment id in the settlement transaction
field, and updated channel state in `extensions.kaspa`. Stale vouchers or stale
outpoints receive a corrective HTTP `402` with current lane state. If a claim,
top-up, or refund broadcast is uncertain, the lane remains unavailable until
trusted transaction evidence reconciles its current outpoint.

## Unsupported Profiles

The hosted gateway must not accept foreign schemes, old alpha batch bindings,
or future profiles as Kaspa payment evidence. A paid retry whose selected
payment requirement is not currently advertised must fail before protected
content is produced. A foreign scheme maps to:

Expected public error reason:

```text
unsupported_scheme
```

A known Kaspa scheme with a mismatched binding or template maps to
`invalid_payment_requirements` at the public wire boundary.

Clients should parse mixed `accepts` envelopes selectively: validate the
envelope shape, keep compatible Kaspa entries, and skip foreign entries. A
foreign-only challenge should fail locally as unsupported.

## Reporting Interop Issues

When reporting an interoperability issue, include:

- package versions or commit hash, gateway URL, and UTC timestamp;
- network, scheme, binding, and template;
- decoded `PAYMENT-REQUIRED` and `PAYMENT-SIGNATURE` summaries, with private
  keys removed;
- HTTP status, public error reason, and exact transaction/output identity when
  relevant;
- batch channel id, stable `covenantId`, current outpoint, and A/S/T/V/R values.

Do not post private keys, wallet seeds, or reusable unpaid payment headers.
