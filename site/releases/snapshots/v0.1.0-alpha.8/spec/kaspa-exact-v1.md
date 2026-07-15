# Kaspa x402 Exact Binding v1

Status: superseded for new implementations by
[Kaspa x402 Exact Binding v2](kaspa-exact-v2.md). This file remains the
alpha.7 KIP-10 reservation profile record.

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

This profile settles native KAS only. `payTo` is decoded to a Kaspa script
public key for the selected network; implementations may support standard
script-hash addresses.

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
    "finality": "accepted",
    "templateId": "kaspa-x402-kip10-additive-v1",
    "transactionEncoding": "kaspa-sdk-safe-json-v2.0.0",
    "borrowOutpoint": {
      "txid": "<reserved outpoint txid>",
      "index": 0
    },
    "borrowAmount": "100000000",
    "borrowScriptPublicKey": "<serialized script public key>",
    "borrowRedeemScript": "<redeem script hex>",
    "additiveThresholdSompi": "10000000",
    "paymentOutputIndex": 0,
    "reservationId": "<reservation id>",
    "reservationExpiresAt": "2026-07-08T00:00:00.000Z"
  }
}
```

| Field | Required | Rule |
| ----- | -------- | ---- |
| `scheme` | yes | Must equal `"exact"`. |
| `network` | yes | Must be `kaspa:mainnet` or `kaspa:testnet-10`. |
| `amount` | yes | Decimal string in sompi. This is the exact payment amount. KIP-9 storage mass depends on the complete transaction shape, so implementations must reject offers they cannot construct under current consensus rules and local output policy; there is no universal `10000000` sompi consensus dust floor. |
| `asset` | yes | Must equal `"KAS"`. |
| `payTo` | yes | Non-empty recipient Kaspa address for the selected network. |
| `maxTimeoutSeconds` | yes | Positive maximum time, in seconds, that the client may take to provide a payment payload. |
| `extra.binding` | yes | Must equal `"kaspa-exact-v1"`. |
| `extra.finality` | no | One of `"mempool"`, `"accepted"`, or `"confirmed"`. If absent, servers choose local policy. |
| `extra.templateId` | yes | Must equal `"kaspa-x402-kip10-additive-v1"` for the current exact profile. |
| `extra.transactionEncoding` | yes | Must equal `"kaspa-sdk-safe-json-v2.0.0"`. |
| `extra.borrowOutpoint` | yes | Reserved KIP-10 additive covenant outpoint the client may spend for this exact payment. |
| `extra.borrowAmount` | yes | Amount in sompi held by `borrowOutpoint`. |
| `extra.borrowScriptPublicKey` | yes | Serialized script public key for `borrowOutpoint`. |
| `extra.borrowRedeemScript` | yes | Hex-encoded redeem script for the reserved KIP-10 additive path. |
| `extra.additiveThresholdSompi` | yes | Minimum additional value, in sompi, that the KIP-10 continuation output must carry. This is an application anti-churn policy, not a consensus dust value. The reference runtime requires at least `10000000` sompi; production operators should choose a threshold from their transaction shape and service economics. |
| `extra.paymentOutputIndex` | yes | Output index the server expects to pay `payTo`. |
| `extra.reservationId` | yes | Server-local reservation identifier for the advertised borrow terms. |
| `extra.reservationExpiresAt` | no | Reservation expiry timestamp. |

`extra.finality` is a server policy hint. It does not weaken validation. A server may require stronger finality than advertised, but should not require weaker finality than the value it advertises.

## Reservation Policy

The reserved KIP-10 borrow outpoint is expected to be merchant-controlled
inventory. In other words, the merchant or its chosen operator prepares UTXOs
that are spendable through the advertised additive path, and the reservation
provider leases one outpoint to one x402 challenge at a time.

This creates an inventory-churn risk if the advertised additive threshold is too low:
an attacker could keep touching merchant inventory with economically trivial
top-ups. The reference runtime rejects offers whose
`additiveThresholdSompi` is below `10000000` sompi as a conservative
application policy. It is not a universal consensus floor. Operators may raise
that threshold for higher-value services or choose another policy after
evaluating the complete transaction shape and abuse economics.

Third-party escrowed borrow inventory is possible as a future deployment model,
but it adds a trust and availability dependency and is not part of the reference
alpha profile.

## Lifecycle

Kaspa x402 exact uses one current payload shape: `exact-transaction`. The server
advertises a reserved KIP-10 additive outpoint and the client returns a signed
transaction artifact that the server or facilitator can verify and broadcast.

1. Client requests a protected resource without payment.
2. Server returns x402 v2 `PaymentRequired` with an `exact` Kaspa entry in
   `accepts` and `extra.templateId = "kaspa-x402-kip10-additive-v1"`.
3. Client builds a signed Kaspa transaction artifact from the advertised
   reservation terms. The artifact spends the reserved borrow outpoint, keeps
   the KIP-10 continuation output above `borrowAmount + additiveThresholdSompi`,
   and pays `amount` sompi to `payTo`.
4. Client retries with `PaymentPayload.accepted` equal to the chosen
   requirements and `payload.type = "exact-transaction"`.
5. Server or facilitator verifies the artifact against the accepted
   requirements, reservation, and KIP-10 output constraints.
6. Server or facilitator broadcasts the artifact if needed and observes the
   transaction according to finality policy.
7. Protected resource is returned only after settlement policy succeeds.
8. Server returns `SettlementResponse` in the x402 transport response.

## PaymentPayload

The payload type is `exact-transaction`.

```json
{
  "type": "exact-transaction",
  "payerAddress": "kaspatest:...",
  "transaction": "<signed transaction artifact>",
  "transactionEncoding": "kaspa-sdk-safe-json-v2.0.0",
  "paymentOutputIndex": 0,
  "requestHash": "<optional sha256 request fingerprint hex>"
}
```

| Field | Required | Rule |
| ----- | -------- | ---- |
| `type` | yes | Must equal `"exact-transaction"`. |
| `payerAddress` | no | Client payment address, if known. Used for receipts and policy only. |
| `transaction` | yes | Signed Kaspa transaction artifact encoded according to `transactionEncoding`. |
| `transactionEncoding` | yes | Must equal `"kaspa-sdk-safe-json-v2.0.0"` in this draft. |
| `paymentOutputIndex` | yes | Index of the output that satisfies this payment. |
| `requestHash` | no | SHA-256 of the normalized request fingerprint. Required when the server requires request binding. |

The verifier must derive the transaction id from the transaction artifact. The
payload must not also carry a client-supplied `transactionId`.

## Transaction Requirements

The transaction must satisfy all of the following:

- it is valid for the selected Kaspa network;
- output `paymentOutputIndex` exists;
- output `paymentOutputIndex` pays exactly `amount` sompi;
- output `paymentOutputIndex` pays to the script public key for `payTo`;
- no other output pays to `payTo` for the same `amount` unless the server explicitly supports multi-item batching outside this binding;
- the transaction has not already been accepted for another x402 payment by the same server or facilitator;
- the transaction is visible at the required finality level.

For `exact-transaction`, the transaction must also satisfy the advertised
reservation:

- it spends the advertised `extra.borrowOutpoint`;
- the input script public key and amount match `extra.borrowScriptPublicKey`
  and `extra.borrowAmount`;
- `extra.borrowScriptPublicKey` is the P2SH script public key for
  `extra.borrowRedeemScript`;
- the selected output pays `amount` sompi to `payTo`;
- the additive KIP-10 covenant leaves at least `extra.borrowAmount +
  extra.additiveThresholdSompi` in the reserved output path, and also satisfies
  the native transaction validation rules;
- the reservation has not expired or already been consumed by a different
  transaction.

Change outputs are allowed. Additional unrelated outputs are allowed, but they do not satisfy this x402 payment.

## Verification

Verification must reject with the relevant error code if:

- x402 version is unsupported;
- `scheme`, `network`, `asset`, or `extra.binding` is unsupported;
- `amount` is not a non-negative integer string;
- `payTo` is not valid for the selected network;
- `exact-transaction` is missing `transaction`, uses an unsupported
  `transactionEncoding`, or includes a client-supplied `transactionId`;
- `paymentOutputIndex` is missing or out of range;
- the selected output does not pay exactly `amount` sompi to `payTo`;
- the transaction id was already consumed for a different request;
- the KIP-10 reservation fields are absent, incomplete, expired, or do not
  match the transaction being settled;
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
      "finality": "accepted",
      "transactionEncoding": "kaspa-sdk-safe-json-v2.0.0",
      "templateId": "kaspa-x402-kip10-additive-v1",
      "reservationId": "<reservation id>",
      "borrowOutpoint": {
        "txid": "<reserved outpoint txid>",
        "index": 0
      }
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

- The signed artifact plus accepted chain evidence is the source of truth. The
  transaction id must be derived from the artifact or network, not accepted from
  the payload.
- The server must not trust `payerAddress`, `transactionId`, `transaction`, or
  `paymentOutputIndex` until they are checked against the accepted
  requirements and chain evidence.
- The resource should not be released before the server's finality policy succeeds.
- A transaction id must be consumed at most once per server/facilitator trust domain.
- A KIP-10 reservation must be consumed at most once, except idempotent replay
  of the same settled transaction for the same request.

## Toccata Notes

The current exact path uses a native KIP-10 additive covenant reservation. It
still satisfies the x402 `exact` property: one request settles to exactly the
required amount for the required recipient, and the settlement response reports
the resulting Kaspa transaction id.

## Local Diagnostics

Public wire responses use the mapped reasons in [errors.md](errors.md). Implementations may use common `invalid_kaspa_x402_*` diagnostics plus:

```text
invalid_kaspa_exact_transaction
invalid_kaspa_exact_transaction_id
invalid_kaspa_exact_payment_output
invalid_kaspa_exact_replay
invalid_kaspa_exact_finality
```
