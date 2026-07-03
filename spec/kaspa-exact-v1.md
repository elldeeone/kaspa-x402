# Kaspa x402 Exact Binding v1

Status: draft

This document defines the Kaspa network binding for x402 v2 `exact`.

## Summary

`exact` is for fixed-price one-shot purchases. The resource server knows the price before the request is served, and the client pays that exact amount for that request.

Use `exact` for:

- fixed-price file downloads;
- fixed-price API responses;
- fixed-price MCP tool calls.

Do not use `exact` for repeated micropayment sessions or variable-cost requests. Use [batch-settlement](kaspa-batch-settlement-v1.md) for those.

## Scheme and Network Pair

```json
{
  "scheme": "exact",
  "network": "kaspa:<network>",
  "asset": "KAS",
  "extra": {
    "binding": "kaspa-exact-v1"
  }
}
```

Recognized draft network identifiers:

```text
kaspa:mainnet
kaspa:testnet-10
```

`kaspa:testnet-10` is the current alpha validation target. `kaspa:mainnet` is a
reserved profile name, not a readiness claim.

## PaymentRequirements

```json
{
  "scheme": "exact",
  "network": "kaspa:testnet-10",
  "amount": "25000000",
  "asset": "KAS",
  "payTo": "kaspatest:...",
  "maxTimeoutSeconds": 60,
  "extra": {
    "binding": "kaspa-exact-v1",
    "finality": "accepted"
  }
}
```

| Field | Required | Rule |
| ----- | -------- | ---- |
| `scheme` | yes | Must equal `"exact"`. |
| `network` | yes | Must be `kaspa:mainnet` or `kaspa:testnet-10`. |
| `amount` | yes | Decimal string in sompi. This is the exact payment amount. |
| `asset` | yes | Must equal `"KAS"`. |
| `payTo` | yes | Non-empty recipient Kaspa address for the selected network. |
| `maxTimeoutSeconds` | yes | Positive maximum time, in seconds, that the client may take to provide a payment payload. |
| `extra.binding` | yes | Must equal `"kaspa-exact-v1"`. |
| `extra.finality` | no | One of `"mempool"`, `"accepted"`, or `"confirmed"`. If absent, servers choose local policy. |

`extra.finality` is a server policy hint. It does not weaken validation. A server may require stronger finality than advertised, but should not require weaker finality than the value it advertises.

## Lifecycle

1. Client requests a protected resource without payment.
2. Server returns x402 v2 `PaymentRequired` with an `exact` Kaspa entry in `accepts`.
3. Client builds a native Kaspa transaction paying `amount` sompi to `payTo`.
4. Client retries with `PaymentPayload.accepted` equal to the chosen requirements and `payload.type = "exact-transfer"`.
5. Server or facilitator verifies the transaction.
6. Server or facilitator broadcasts or observes the transaction according to finality policy.
7. Protected resource is returned only after settlement policy succeeds.
8. Server returns `SettlementResponse` in the x402 transport response.

## PaymentPayload

The payload type is `exact-transfer`.

```json
{
  "type": "exact-transfer",
  "payerAddress": "kaspatest:...",
  "transaction": "<serialized transaction hex>",
  "transactionId": "<optional transaction id hex>",
  "paymentOutputIndex": 0,
  "requestHash": "<optional sha256 request fingerprint hex>"
}
```

| Field | Required | Rule |
| ----- | -------- | ---- |
| `type` | yes | Must equal `"exact-transfer"`. |
| `payerAddress` | no | Client payment address, if known. Used for receipts and policy only. |
| `transaction` | yes | Serialized Kaspa transaction hex. |
| `transactionId` | no | If present, must match the id derived from `transaction`. |
| `paymentOutputIndex` | yes | Index of the output that satisfies this payment. |
| `requestHash` | no | SHA-256 of the normalized request fingerprint. Required when the server requires request binding. |

The verifier must derive transaction identity and output data from `transaction`. Payload fields are hints until verified.

## Transaction Requirements

The transaction must satisfy all of the following:

- it is valid for the selected Kaspa network;
- output `paymentOutputIndex` exists;
- output `paymentOutputIndex` pays exactly `amount` sompi;
- output `paymentOutputIndex` pays to the script public key for `payTo`;
- no other output pays to `payTo` for the same `amount` unless the server explicitly supports multi-item batching outside this binding;
- the transaction has not already been accepted for another x402 payment by the same server or facilitator;
- the transaction can be broadcast or is already visible at the required finality level.

Change outputs are allowed. Additional unrelated outputs are allowed, but they do not satisfy this x402 payment.

## Verification

Verification must reject with the relevant error code if:

- x402 version is unsupported;
- `scheme`, `network`, `asset`, or `extra.binding` is unsupported;
- `amount` is not a non-negative integer string;
- `payTo` is not valid for the selected network;
- the transaction cannot be decoded;
- `transactionId` is present and does not match the transaction;
- `paymentOutputIndex` is missing or out of range;
- the selected output does not pay exactly `amount` sompi to `payTo`;
- the transaction id was already consumed for a different request;
- a required `payment-identifier` extension is absent;
- a provided `requestHash` does not match the server's normalized request fingerprint.

## SettlementResponse

Successful response:

```json
{
  "success": true,
  "transaction": "<kaspa transaction id>",
  "network": "kaspa:testnet-10",
  "payer": "kaspatest:...",
  "amount": "25000000",
  "extensions": {
    "kaspa": {
      "paymentOutputIndex": 0,
      "finality": "accepted"
    }
  }
}
```

Failure response:

```json
{
  "success": false,
  "errorReason": "invalid_transaction_state",
  "transaction": "",
  "network": "kaspa:testnet-10",
  "payer": "kaspatest:..."
}
```

Failure responses may include `network` only when the implementation can echo a
valid canonical request network. Invalid, malformed, or unknown network failures
must not synthesize a fallback network.

`amount` is the amount settled for this request. For `exact`, it must equal `PaymentRequirements.amount` on success.

## Idempotency

Servers should advertise the x402 `payment-identifier` extension for `exact`. If it is required:

- the client must include the same id on retries;
- the client must echo the advertised extension schema and preserve every
  advertised `info` field while adding the retry id;
- the server must bind the id to the normalized request fingerprint;
- same id plus same fingerprint returns the cached result;
- same id plus different fingerprint fails.

Even when `payment-identifier` is not required, the server must record consumed transaction ids to prevent the same transaction from buying multiple resources.

## Security Notes

- The payment transaction itself is the source of truth.
- The server must not trust `payerAddress`, `transactionId`, or `paymentOutputIndex` until they are derived or checked from the transaction.
- The resource should not be released before the server's finality policy succeeds.
- A transaction id must be consumed at most once per server/facilitator trust domain.

## Toccata Notes

The base `exact` binding does not require a covenant. It may use an ordinary native Kaspa transaction.

If future exact flows use covenant-assisted sponsorship, they must still satisfy the x402 `exact` property: exactly one payment outcome for exactly the required amount to the required recipient.

## Local Diagnostics

Public wire responses use the mapped reasons in [errors.md](errors.md). Implementations may use common `invalid_kaspa_x402_*` diagnostics plus:

```text
invalid_kaspa_exact_transaction
invalid_kaspa_exact_transaction_id
invalid_kaspa_exact_payment_output
invalid_kaspa_exact_replay
invalid_kaspa_exact_finality
```
