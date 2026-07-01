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

The retry must select exactly one `PaymentRequirements` entry from the server's `accepts` array. Servers must reject a retry when the selected `accepted` object changes network, asset, amount, recipient, binding, or other critical fields.

## Payment Response

Servers return the x402 v2 `SettlementResponse` in:

```text
PAYMENT-RESPONSE: base64(SettlementResponse)
```

The historical `X-PAYMENT` and `X-PAYMENT-RESPONSE` names are not part of this standard.

Protected content must not be returned until the selected scheme has reached its success condition:

- `exact`: the transaction is verified and reaches the server's finality policy;
- `upto`: the authorization is verified; nonzero settlements require the settlement transaction to reach the selected finality policy, while zero-charge settlements require durable no-transaction authorization consumption;
- `batch-settlement`: voucher-only requests require the commitment to be verified and stored; `deposit-voucher` requests require the deposit or top-up transaction to be accepted by the selected Kaspa network and the voucher commitment to be stored; claim/refund operations require the relevant transaction to be accepted by the selected Kaspa network.

For `upto`, once a nonzero settlement transaction has been broadcast but has not reached the selected finality, servers must not return another `402` for the same paid retry. They should return a non-402 pending response, typically `202`, with `PAYMENT-RESPONSE` carrying `success: false`, `errorReason: "upto_authorization_pending"`, the settlement transaction id, and current finality evidence.

Servers should require the x402 `payment-identifier` extension for paid HTTP retries. This prevents duplicate side effects when clients or agents retry after timeouts.

## Scheme Choice

Servers may include multiple Kaspa entries in `PaymentRequired.accepts`. Clients should prefer:

- `exact` for fixed-price one-shot purchases;
- `upto` for one-shot variable-cost requests;
- `batch-settlement` when an existing escrow/channel can pay for repeated requests.

If the server returns a corrective `402` for `batch-settlement`, it should include `accepts[].extra.channelState` and, when asking the client to adopt a newer cumulative value, `accepts[].extra.voucherState`.
