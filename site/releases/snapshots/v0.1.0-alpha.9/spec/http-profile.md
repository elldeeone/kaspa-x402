# HTTP Profile

Status: draft

Kaspa x402 uses the x402 v2 HTTP transport for `exact` and `batch-settlement`.

## Payment Required

Servers return HTTP `402 Payment Required` and place the x402 v2 `PaymentRequired` object in the canonical header:

```text
PAYMENT-REQUIRED: base64(PaymentRequired)
```

Clients must parse this header as an x402 v2 envelope and select a supported Kaspa entry from `accepts`, skipping entries for other schemes, networks, or assets instead of rejecting the whole envelope. Kaspa servers must emit only `exact` and `batch-settlement` entries defined by this binding.

## Payment Retry

Clients retry with:

```text
PAYMENT-SIGNATURE: base64(PaymentPayload)
```

The retry must select exactly one `PaymentRequirements` entry from the server's `accepts` array. Servers must reject a retry when the selected `accepted` object changes network, asset, amount, recipient, binding, or other critical fields.

Paid clients MUST reject HTTP redirects for both the initial challenge request
and the paid retry. They MUST also verify that the response effective URL is
identical to the requested URL before signing or accepting settlement. A signed
`PAYMENT-SIGNATURE` header must never be forwarded to a redirect target.

## Payment Response

Servers return the x402 v2 `SettlementResponse` in:

```text
PAYMENT-RESPONSE: base64(SettlementResponse)
```

The historical `X-PAYMENT` and `X-PAYMENT-RESPONSE` names are not part of this standard.

Protected content must not be returned until the selected scheme has reached its success condition:

- `exact`: the transaction is verified and reaches the server's finality policy;
- `batch-settlement`: voucher-only requests require the commitment to be verified and stored; `deposit-voucher` requests require the deposit or top-up transaction to be accepted by the selected Kaspa network and the voucher commitment to be stored; claim/refund operations require the relevant transaction to be accepted by the selected Kaspa network.

Servers should require the x402 `payment-identifier` extension for paid HTTP retries. This prevents duplicate side effects when clients or agents retry after timeouts.

## Scheme Choice

Servers may include multiple Kaspa entries in `PaymentRequired.accepts`. Clients should prefer:

- `exact` for fixed-price one-shot purchases;
- `batch-settlement` when an existing escrow/channel can pay for repeated or variable-cost requests.

If the server returns a corrective `402` for `batch-settlement`, it should include `accepts[].extra.channelState` and, when asking the client to adopt a newer cumulative value, `accepts[].extra.voucherState`.
