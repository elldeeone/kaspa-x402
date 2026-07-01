# HTTP Profile

Status: draft

Kaspa x402 uses the x402 v2 HTTP transport for `exact`, `upto`, and `batch-settlement`.

## Payment Required

Servers return HTTP `402 Payment Required` and place the x402 v2 `PaymentRequired` object in the canonical header:

```text
PAYMENT-REQUIRED: base64(PaymentRequired)
```

## Payment Retry

Clients retry with:

```text
PAYMENT-SIGNATURE: base64(PaymentPayload)
```

## Payment Response

Servers return the x402 v2 `SettleResponse` in:

```text
PAYMENT-RESPONSE: base64(SettleResponse)
```

The historical `X-PAYMENT` and `X-PAYMENT-RESPONSE` names are not part of this standard.

## Scheme Choice

Servers may include multiple Kaspa entries in `PaymentRequired.accepts`. Clients should prefer:

- `exact` for fixed-price one-shot purchases;
- `upto` for one-shot variable-cost requests;
- `batch-settlement` when an existing escrow/channel can pay for repeated requests.
