# Demo Implementer Guide

Status: alpha, testnet-only guide for the alpha.8 source contract. The hosted
gateway remains the paid-canary-proven alpha.7 deployment until an explicit
post-merge alpha.8 cutover. It is an integration target, not a production or
mainnet service.

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

Install the alpha packages explicitly:

```sh
npm install @kaspa-x402/core@alpha @kaspa-x402/client@alpha
```

Until alpha.8 is actually published, the registry `alpha` tag continues to
resolve to alpha.7. Use the reviewed branch or its locally packed alpha.8
tarballs when testing the alpha.8 source contract before publication.

The public npm release includes core schema/header helpers and client
helpers; the hosted gateway package is not published.

## Validate Schemas And Vectors

Before calling the hosted gateway, an implementation should be able to:

1. Fetch JSON Schemas from `/schemas/`.
2. Validate local copies against the published `$id` routes.
3. Load `/vectors/index.json`.
4. Validate every vector in `x402-http`, `settlement-response`, `voucher`,
   `channel-id`, `tx-v1`, and `negative`.
5. Confirm negative vectors fail for the expected reason.

Amounts are decimal strings in sompi. KIP-9 storage mass depends on the full
transaction shape rather than defining a universal dust amount. The gateway's
on-chain exact output and batch deposit use a conservative `10000000` sompi
reference policy; smaller values require transaction-specific mass analysis.

## Discover Gateway Support

```sh
curl -fsS https://demo.kaspa-x402.org/supported
```

Hosted capability, subject to live availability:

- `network: "kaspa:testnet-10"`;
- `asset: "KAS"`;
- `scheme: "batch-settlement"`;
- `scheme: "exact"` under the configured alpha.8 profile. `standard-native`
  needs no merchant inventory; optional `additive` needs an available reusable
  KIP-10 head;
- accepted finality: `accepted`.

No mainnet profile is advertised. If `exact` is absent from `/supported` or
`/exact` returns `503 exact_unavailable`, exact settlement is disabled or an
additive deployment has no available head; use `batch-settlement` instead.

The 2026-07-14 alpha.7 paid canary proved hosted exact, identical replay,
cross-resource rejection, batch deposit/voucher reuse, stale-voucher rejection,
and a stable absolute refund DAA. The exact transaction ids and channel evidence
are recorded in the gateway reference.

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
`standard-native` is the default: build an ordinary native KAS transaction
whose canonical payment output transfers exactly the advertised amount to
`payTo`. For optional `additive`, the offer contains a complete reusable head
challenge: head id/version, expected outpoint, amount, script public key,
redeem script, covenant threshold, challenge id, and canonical output index
zero. Spend that head and create the same-script successor at index zero with:

```text
successor amount = head amount + advertised exact amount
```

That successor increase is the entire merchant payment; do not create a second
merchant payment output. Build the signed SDK-safe JSON transaction artifact
and retry with an `exact-transaction` payload. The hosted gateway submits that
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

The batch contract is unchanged from alpha.7 and remains the alpha.8 batch
profile. The public gateway still serves the deployed alpha.7 instance until
the explicit alpha.8 cutover.

Request:

```sh
curl -i https://demo.kaspa-x402.org/batch
```

Expected result:

- HTTP `402`;
- `PAYMENT-REQUIRED` header;
- a `batch-settlement` offer with `extra.binding: "kaspa-escrow-v1"`.

Open a channel by funding the advertised escrow terms with at least
`extra.minDepositSompi`, then submit a deposit-voucher payment payload. For a
later request on the same channel, submit a voucher-only payload with a higher
cumulative signed amount.

Successful batch retries return HTTP `200` with `PAYMENT-RESPONSE.success:
true`, a commitment id in the settlement transaction field, and channel state
metadata in `extensions.kaspa`.

Stale vouchers should receive a corrective HTTP `402` that includes current
channel and voucher state.

## Unsupported And Future Profiles

The hosted gateway must not accept foreign or future schemes as Kaspa payment
evidence. A paid retry whose selected payment requirement uses a foreign
scheme should fail before protected content is produced.

Expected public error reason:

```text
unsupported_scheme
```

Clients should parse mixed `accepts` envelopes selectively: validate the
envelope shape, keep compatible Kaspa entries, and skip foreign entries. A
foreign-only challenge should fail locally as unsupported.

## Reporting Interop Issues

When reporting an interoperability issue, include:

- package versions or commit hash;
- gateway URL and UTC timestamp;
- network and scheme;
- decoded `PAYMENT-REQUIRED` summary;
- decoded `PAYMENT-SIGNATURE` summary, with private keys removed;
- HTTP status and public error reason;
- transaction id and output index for paid exact flows;
- channel id, active outpoint, and voucher amount for batch flows.

Do not post private keys, wallet seeds, or reusable unpaid payment headers.
