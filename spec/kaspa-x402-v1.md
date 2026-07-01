# Kaspa x402 Binding v1

Status: draft

This document defines the common rules for x402 v2 payments on Kaspa. Scheme-specific behavior is defined in sibling documents:

- [Kaspa x402 Exact Binding v1](kaspa-exact-v1.md)
- [Kaspa x402 Upto Binding v1](kaspa-upto-v1.md)
- [Kaspa x402 Batch Settlement Binding v1](kaspa-batch-settlement-v1.md)

## x402 Relationship

x402 separates the logical payment scheme from the network-specific implementation. Kaspa x402 defines the following `(scheme, network)` pairs:

```text
exact              + kaspa:mainnet
exact              + kaspa:testnet-10
upto              + kaspa:mainnet
upto              + kaspa:testnet-10
batch-settlement  + kaspa:mainnet
batch-settlement  + kaspa:testnet-10
```

Servers may advertise more than one option in `PaymentRequired.accepts`. Clients choose the entry they can satisfy.

## Scheme Selection

| Scheme | Use when | Settlement |
| ------ | -------- | ---------- |
| `exact` | The price is known before the request. Example: buy a file or one fixed-price API result. | One immediate native KAS transfer for the exact amount. |
| `upto` | The request has a maximum budget but the actual cost is known after execution. Example: LLM generation or metered bandwidth. | One single-use settlement for an amount less than or equal to the signed cap. |
| `batch-settlement` | The client expects repeated small requests against the same service. Example: API metering or MCP tool usage. | Per-request commitments accumulate and value is redeemed later. |

The three schemes are intentionally separate. `batch-settlement` can represent one request, but it does not have the same x402 contract as `exact` or `upto`. A general-purpose agent needs all three choices.

## Networks

Initial network identifiers:

```text
kaspa:mainnet
kaspa:testnet-10
```

The `kaspa:` namespace is CAIP-style. Formal registry work is deferred until the binding is stable enough to submit upstream.

Implementations must reject non-colon network aliases such as `mainnet`, `testnet-10`, or `tn10`.

## Asset and Amounts

`asset` is `"KAS"` for native Kaspa.

All x402 `amount` fields are decimal strings in atomic sompi units:

```json
{
  "asset": "KAS",
  "amount": "1000000"
}
```

Display layers may show KAS or tKAS. Wire fields must not use floating point KAS values.

The optional metadata fields below may be included in `extra` for clarity, but clients must not require them to understand native KAS:

```json
{
  "assetKind": "native",
  "assetDecimals": 8
}
```

## Common PaymentRequirements Rules

Every Kaspa x402 `PaymentRequirements` object must use:

```json
{
  "network": "kaspa:testnet-10",
  "asset": "KAS",
  "amount": "<decimal sompi string>",
  "payTo": "<kaspa address>",
  "maxTimeoutSeconds": 60
}
```

`extra.binding` identifies the concrete Kaspa binding:

| Scheme | `extra.binding` |
| ------ | --------------- |
| `exact` | `kaspa-exact-v1` |
| `upto` | `kaspa-upto-v1` |
| `batch-settlement` | `kaspa-escrow-v1` |

Unknown `extra` fields may be preserved by transports, but verifiers must ignore unknown fields unless the selected binding explicitly marks them as critical.

## Example Accepts Array

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/report.pdf",
    "description": "Research report",
    "mimeType": "application/pdf"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "kaspa:testnet-10",
      "amount": "25000000",
      "asset": "KAS",
      "payTo": "kaspatest:...",
      "maxTimeoutSeconds": 60,
      "extra": {
        "binding": "kaspa-exact-v1"
      }
    },
    {
      "scheme": "upto",
      "network": "kaspa:testnet-10",
      "amount": "25000000",
      "asset": "KAS",
      "payTo": "kaspatest:...",
      "maxTimeoutSeconds": 300,
      "extra": {
        "binding": "kaspa-upto-v1"
      }
    },
    {
      "scheme": "batch-settlement",
      "network": "kaspa:testnet-10",
      "amount": "25000000",
      "asset": "KAS",
      "payTo": "kaspatest:...",
      "maxTimeoutSeconds": 60,
      "extra": {
        "binding": "kaspa-escrow-v1",
        "templateId": "kaspa-x402-escrow-v1",
        "serverPublicKey": "<32-byte x-only hex>",
        "minDepositSompi": "100000000",
        "refundTimeoutDaa": "123456789"
      }
    }
  ]
}
```

## Toccata Alignment

Kaspa x402 must be designed as a UTXO-native protocol, not as an account-contract API.

For covenant-backed bindings:

- production/mainnet transactions target transaction v1;
- v1 covenant inputs use `compute_budget`, not v0 `sig_op_count`;
- transaction builders must estimate script units and set compute budgets from the generated script path;
- successor outputs must be validated by script, not merely tagged with a covenant ID;
- covenant IDs provide lineage and indexability, but the script still enforces the state transition;
- exact channel or authorization outpoints must be preserved end to end;
- SilverScript is the intended covenant source surface, with generated byte fixtures and vectors required before mainnet use.

The initial architecture should prefer L1 covenant lanes for escrow, one-shot authorization, and channel state because these states naturally split by payer/service/session. A based-app model is out of scope for v0.1 unless future shared-state requirements dominate.

## Registry Status

The binding is not yet registered with x402 or CAIP registries. This is not a P0 blocker. Before a tagged `v1.0.0`, the project should submit or align with the upstream registry process for:

- network identifiers;
- scheme/network support declarations;
- native KAS asset convention if upstream formalizes one.

## References

- x402 v2: https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md
- x402 exact: https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact.md
- x402 upto: https://github.com/x402-foundation/x402/blob/main/specs/schemes/upto/scheme_upto.md
- x402 batch-settlement: https://github.com/x402-foundation/x402/blob/main/specs/schemes/batch-settlement/scheme_batch_settlement.md
- Kaspa Toccata docs: https://github.com/kaspanet/docs/tree/main/content/docs/toccata
