# Demo Implementer Guide

Status: alpha, testnet-only guide for implementers testing against the hosted
gateway.

Use this guide if you want to build a client, server, or interoperability
tester that speaks the current Kaspa x402 surface without relying on local
mock examples.

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

The public npm release includes core schema/header helpers and client helpers.
The hosted gateway package is private and is not part of the npm surface.

## Validate Schemas And Vectors

Before calling the hosted gateway, an implementation should be able to:

1. Fetch JSON Schemas from `/schemas/`.
2. Validate local copies against the published `$id` routes.
3. Load `/vectors/index.json`.
4. Validate every vector in `x402-http`, `settlement-response`, `voucher`,
   `channel-id`, `tx-v1`, and `negative`.
5. Confirm negative vectors fail for the expected reason.

Amounts are decimal strings in sompi. The gateway's on-chain exact output and
batch deposit values sit above the Kaspa standard-output storage-mass floor
(about 0.1 KAS); outputs below the floor cannot be built as standard
transactions.

## Discover Gateway Support

```sh
curl -fsS https://demo.kaspa-x402.org/supported
```

Expected support:

- `network: "kaspa:testnet-10"`;
- `asset: "KAS"`;
- `scheme: "exact"`;
- `scheme: "batch-settlement"`;
- accepted finality: `accepted`.

No mainnet profile is advertised.

## Exact Flow

Request the protected resource:

```sh
curl -i https://demo.kaspa-x402.org/exact
```

Expected result:

- HTTP `402`;
- `PAYMENT-REQUIRED` response header;
- a JSON body with `error: "payment_required"`.

Decode the `PAYMENT-REQUIRED` header and select the `exact` offer. Build a
native Kaspa testnet transaction that pays exactly the advertised amount to the
advertised `payTo` address. The retry must send:

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
must be rejected.

## Batch Flow

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
The hosted gateway is an alpha testnet target and should not be described as a
mainnet service.
