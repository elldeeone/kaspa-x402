# Facilitator Profile

Status: draft

Kaspa x402 supports facilitators for `exact`, `upto`, and `batch-settlement`, but must not require a third-party hosted facilitator.

## Modes

### Direct Mode

The resource server verifies payment payloads and settles itself.

For `exact`, this means verifying and broadcasting or observing the exact payment transaction.

For `upto`, this means verifying the single-use capped authorization and settling the actual amount once.

For `batch-settlement`, this means verifying vouchers, tracking channel state, and building claim/refund transactions.

### Self-Hosted Facilitator Mode

The resource server or service operator exposes:

```text
GET  /supported
POST /verify
POST /settle
```

### Third-Party Facilitator Mode

A third-party facilitator may verify payment state, relay transactions, index channels, or expose discovery. Any delegated authority must be explicit in `PaymentRequirements.extra` and discoverable through `/supported`.

Hardcoded facilitator keys, URLs, or service identities are out of scope for the standard.
