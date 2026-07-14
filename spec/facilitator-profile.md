# Facilitator Profile

Status: draft

Kaspa x402 supports facilitators for `exact` and `batch-settlement`, but must not require a third-party hosted facilitator.

## Modes

### Direct Mode

The resource server verifies payment payloads and settles itself.

For `exact`, this means selecting the advertised `kaspa-exact-v2` profile,
verifying its `exact-transaction` artifact with trusted UTXO and consensus
facts, broadcasting it if needed, and observing it at the required finality.

For `batch-settlement`, this means verifying vouchers, tracking channel state, and building claim/refund transactions.

### Self-Hosted Facilitator Mode

The resource server or service operator exposes:

```text
GET  /supported
POST /verify
POST /settle
```

`GET /supported` returns the x402 v2 supported response. Kaspa-specific binding, asset, and mode metadata belongs in each kind's `extra` object:

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "kaspa:testnet-10",
      "extra": {
        "asset": "KAS",
        "binding": "kaspa-exact-v2",
        "defaultProfile": "standard-native",
        "profiles": ["standard-native", "additive"],
        "modes": ["verify", "settle"]
      }
    },
    {
      "x402Version": 2,
      "scheme": "batch-settlement",
      "network": "kaspa:testnet-10",
      "extra": {
        "asset": "KAS",
        "binding": "kaspa-escrow-v1",
        "modes": ["verify", "settle", "claim"]
      }
    }
  ],
  "extensions": [],
  "signers": {}
}
```

The `extra.modes` and exact `extra.profiles` lists are authoritative for that
facilitator instance. `standard-native` is the default exact profile. A
facilitator MUST omit `additive` unless its canonical KIP-10 verifier, durable
head pool, and reconciliation implementation are configured and healthy. Valid
mode values are `verify`, `settle`, `claim`, and `refund`. A facilitator must
not execute a mode for a `(scheme, network)` pair unless the matching kind
advertises it. Facilitators should omit kinds or modes when the local verifier,
settlement builder, signer, or state backend required for that action is not
configured.

`POST /verify` validates a payment payload without releasing the protected resource. The request follows the x402 v2 facilitator shape:

```json
{
  "x402Version": 2,
  "paymentPayload": {},
  "paymentRequirements": {}
}
```

Kaspa facilitators may also accept `resource` and `requestHash` fields.
`requestHash` binds verification and settlement to the resource server's
operation fingerprint. It is mandatory for `exact`, must match the mandatory
signed request authorization in the payment payload, and cannot be inferred or
removed. For batch vouchers a facilitator may still derive a deterministic
local fingerprint when an explicit hash is absent. Servers that need portable
idempotency across direct and facilitator mode should send `requestHash`
explicitly for every scheme.

Successful `/verify` returns x402 v2 `VerifyResponse`:

```json
{
  "isValid": true,
  "payer": "kaspatest:..."
}
```

Invalid verification returns:

```json
{
  "isValid": false,
  "invalidReason": "invalid_payload"
}
```

`POST /settle` applies the scheme-specific success step:

- `exact`: verify the signed transaction artifact for the selected profile,
  consume its replay evidence before protected work, broadcast it if needed,
  observe the resulting transaction at the required finality, and return the
  independently recomputed transaction id. For `additive`, verification also
  atomically claims the expected head and settlement advances the durable head
  state through its recoverable stages;
- `batch-settlement`: for voucher-only requests, store the voucher commitment using settlement-time `paymentRequirements.amount` as the actual charge while the signed voucher ceiling remains bound to `paymentPayload.accepted.amount`; for `deposit-voucher`, broadcast if needed, wait until the deposit or top-up transaction is accepted by the selected Kaspa network, and store the voucher commitment before returning success; for claim operations, broadcast if needed and wait until the relevant transaction is accepted by the selected Kaspa network before returning success or mutating active channel state.

For `batch-settlement`, `/verify` responses should include `extra.channelState` and `/settle` responses should include `extensions.kaspa.channelState` whenever the facilitator reads or changes channel state.

Refund transaction construction is implementation-specific in v0.1. A facilitator must not advertise refund support in `/supported` unless it has an explicit refund settler and verifies client refund authorization before broadcasting or reporting success.

### Third-Party Facilitator Mode

A third-party facilitator may verify payment state, relay transactions, index channels, or expose discovery. Any delegated authority must be explicit in `PaymentRequirements.extra` and discoverable through `/supported`.

Hardcoded facilitator keys, URLs, or service identities are out of scope for the standard.

Third-party facilitators must authenticate resource servers before performing server-owned operations such as settlement, claim, refund relay, or receipt signing. A facilitator can relay and index state, but voucher correctness must remain independently verifiable from channel config, active outpoint, voucher digest, and settlement responses.
