# Facilitator Profile

Status: draft

Kaspa x402 supports facilitators for `exact`, `upto`, and `batch-settlement`, but must not require a third-party hosted facilitator.

## Modes

### Direct Mode

The resource server verifies payment payloads and settles itself.

For `exact`, this means verifying and broadcasting or observing the exact payment transaction.

For `upto`, this means verifying the single-use capped authorization and settling the actual amount once, then waiting for the settlement or zero-charge refund transaction to reach the selected finality policy.

For `batch-settlement`, this means verifying vouchers, tracking channel state, and building claim/refund transactions.

### Self-Hosted Facilitator Mode

The resource server or service operator exposes:

```text
GET  /supported
POST /verify
POST /settle
```

`GET /supported` returns the scheme, network, asset, and binding tuples the facilitator can verify and settle:

```json
{
  "x402Version": 2,
  "supported": [
    {
      "scheme": "exact",
      "network": "kaspa:testnet-10",
      "asset": "KAS",
      "binding": "kaspa-exact-v1",
      "modes": ["verify", "settle"]
    },
    {
      "scheme": "upto",
      "network": "kaspa:testnet-10",
      "asset": "KAS",
      "binding": "kaspa-upto-v1",
      "modes": ["verify", "settle"]
    },
    {
      "scheme": "batch-settlement",
      "network": "kaspa:testnet-10",
      "asset": "KAS",
      "binding": "kaspa-escrow-v1",
      "modes": ["verify", "settle", "claim", "refund"]
    }
  ]
}
```

`POST /verify` validates a payment payload without releasing the protected resource. It must return enough scheme-specific state for the server to decide whether the handler may run.

`POST /settle` applies the scheme-specific success step:

- `exact`: broadcast or observe the exact payment transaction and return the transaction id;
- `upto`: consume the one-shot authorization, settle the actual amount, and wait for the settlement or zero-charge refund transaction to reach the selected finality policy;
- `batch-settlement`: for voucher-only requests, store the voucher commitment; for `deposit-voucher`, broadcast if needed, wait until the deposit or top-up transaction is accepted by the selected Kaspa network, and store the voucher commitment before returning success; for claim/refund operations, broadcast if needed and wait until the relevant transaction is accepted by the selected Kaspa network before returning success or mutating active channel state.

For `batch-settlement`, `/verify` and `/settle` responses should include `extra.channelState` whenever the facilitator reads or changes channel state.

### Third-Party Facilitator Mode

A third-party facilitator may verify payment state, relay transactions, index channels, or expose discovery. Any delegated authority must be explicit in `PaymentRequirements.extra` and discoverable through `/supported`.

Hardcoded facilitator keys, URLs, or service identities are out of scope for the standard.
