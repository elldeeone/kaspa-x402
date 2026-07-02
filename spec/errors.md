# Error Reasons

Status: draft

Kaspa x402 transports expose upstream x402 error reasons on public `PaymentRequired.error`, corrective response bodies, facilitator `invalidReason`, and settlement `errorReason` fields. Kaspa-specific failures are retained as local diagnostic codes, but they must be mapped before they cross the x402 wire surface.

## Public Wire Reasons

| Reason | Used when |
| ------ | --------- |
| `invalid_x402_version` | The envelope uses an unsupported x402 version. |
| `invalid_scheme` | The selected scheme is unsupported or malformed. |
| `invalid_network` | The selected Kaspa network is unsupported or inconsistent. |
| `invalid_payment_requirements` | The accepted requirements are not satisfiable or do not match the server offer. |
| `invalid_payload` | The payment payload, extension envelope, signature material, or identifier payload is malformed. |
| `invalid_transaction_state` | The payment is structurally valid but cannot settle because of replay, stale state, expired authorization, conflict, or on-chain mismatch. |
| `unsupported_scheme` | The facilitator or server does not support the requested scheme/action. |
| `unexpected_settle_error` | The server cannot classify a settlement failure more precisely. |

`upto_authorization_pending` is a transport state, not a new payment challenge. Servers return it in a non-402 response, typically HTTP `202`, after a nonzero `upto` settlement transaction has been broadcast but has not reached the selected finality.

## Local Diagnostics

Implementations may log, test, or expose internal diagnostics out of band with Kaspa-specific codes such as:

```text
invalid_kaspa_x402_amount
invalid_kaspa_x402_binding
invalid_kaspa_x402_payload
invalid_kaspa_payment_identifier
missing_kaspa_payment_identifier
kaspa_payment_identifier_conflict
invalid_kaspa_exact_replay
invalid_kaspa_upto_authorization
invalid_kaspa_upto_expired
invalid_kaspa_upto_replay
invalid_kaspa_upto_settlement_amount
invalid_kaspa_settlement_response
```

These local codes are not the public x402 compatibility contract. A server that includes one in logs should still emit the mapped public reason on the x402 wire response.
