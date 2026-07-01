# Facilitator Profile

Status: draft

Kaspa x402 supports facilitators but must not require a third-party hosted facilitator.

## Modes

### Direct Mode

The resource server verifies vouchers, tracks channel state, and builds claim/refund transactions itself.

### Self-Hosted Facilitator Mode

The resource server or service operator exposes:

```text
GET  /supported
POST /verify
POST /settle
```

### Third-Party Facilitator Mode

A third-party facilitator may verify state, relay claims, index channels, or expose discovery. Any delegated authority must be explicit in `PaymentRequirements.extra` and discoverable through `/supported`.

Hardcoded facilitator keys, URLs, or service identities are out of scope for the standard.

