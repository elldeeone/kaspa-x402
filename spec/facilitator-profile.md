# Facilitator Profile

Status: draft

Kaspa x402 supports facilitators for `exact` and `batch-settlement`, but must not require a third-party hosted facilitator.

## Modes

### Direct Mode

The resource server verifies payment payloads and settles itself.

For `exact`, this means selecting the advertised `kaspa-exact-v2` profile,
verifying its `exact-transaction` artifact with trusted UTXO and consensus
facts, broadcasting it if needed, and observing it at the required finality.

For `batch-settlement`, this means verifying lifetime vouchers, tracking the
stable covenant id plus current outpoint, and building partial claim, top-up,
and refund transactions.

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
        "paymentFlow": "upfront",
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
        "binding": "kaspa-escrow-v2",
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

Kaspa facilitators also accept `resource` and `requestHash` fields.
`requestHash` binds verification and settlement to the resource server's
operation fingerprint. It is mandatory for `exact` and `batch-settlement`,
must match the mandatory signed request authorization in the payment payload,
and cannot be inferred from that payload or removed. Resource servers MUST
send their independently computed `requestHash` explicitly.

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
- `batch-settlement`: for voucher-only requests, store the actual charge and
  lifetime signed ceiling atomically; for `deposit-voucher`, verify singleton
  genesis or top-up lineage, wait for accepted Testnet-10 evidence, and store
  the voucher commitment before returning success; for partial claim, top-up,
  or refund, save a crash-safe attempt before broadcast and wait for accepted
  evidence before advancing the persisted current outpoint and covenant state.

Exact requirements advertise `extra.paymentFlow: "upfront"`; the resource
server MUST receive successful settlement before it executes protected work.

For `batch-settlement`, `/verify` responses should include `extra.channelState` and `/settle` responses should include `extensions.kaspa.channelState` whenever the facilitator reads or changes channel state.

A facilitator MUST NOT advertise refund support unless it has the canonical v2
refund builder and verifies client refund authorization before broadcasting or
reporting success.

### Third-Party Facilitator Mode

A third-party facilitator may verify payment state, relay transactions, index channels, or expose discovery. Any delegated authority must be explicit in `PaymentRequirements.extra` and discoverable through `/supported`.

Hardcoded facilitator keys, URLs, or service identities are out of scope for the standard.

Third-party facilitators must authenticate resource servers before performing server-owned operations such as settlement, claim, refund relay, or receipt signing. A facilitator can relay and index state, but voucher correctness must remain independently verifiable from channel config, covenant id, the persisted current outpoint, voucher digest, and settlement responses.
