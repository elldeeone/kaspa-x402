# Kaspa x402 Binding v1

Status: draft

This document defines common rules for x402 v2 payments on Kaspa. Active
scheme-specific behavior is defined in sibling documents:

- [Kaspa x402 Exact Binding v1](kaspa-exact-v1.md)
- [Kaspa x402 Batch Settlement Binding v1](kaspa-batch-settlement-v1.md)

## x402 Relationship

x402 separates the logical payment scheme from the network-specific
implementation. Kaspa x402 recognizes the following draft `(scheme, network)`
identifier pairs:

```text
exact              + kaspa:mainnet
exact              + kaspa:testnet-10
batch-settlement   + kaspa:mainnet
batch-settlement   + kaspa:testnet-10
```

Servers may advertise more than one option in `PaymentRequired.accepts`. Clients
choose the entry they can satisfy. A `PaymentRequired.accepts` array from an
upstream x402 server may also contain entries for schemes, networks, or assets
outside this binding. Kaspa clients must not reject the envelope because such
entries are present: they must skip entries that do not validate as Kaspa
requirements during offer selection and fail with `invalid_kaspa_x402_accepted`
only when no supported Kaspa entry remains. Kaspa servers, in contrast, must
emit only entries defined by this binding. In the current alpha,
`kaspa:testnet-10` is the testnet validation target and `kaspa:mainnet` is a
reserved profile name that requires explicit runtime opt-in plus the mainnet
gates in `docs/mainnet-readiness.md`.

## Scheme Selection

| Scheme | Use when | Settlement |
| ------ | -------- | ---------- |
| `exact` | The price is known before the request. Example: buy a file or one fixed-price API result. | One immediate native KAS transfer for the exact amount. |
| `batch-settlement` | The client expects repeated or variable-cost requests against the same service. Example: API metering or MCP tool usage. | Per-request commitments accumulate and value is redeemed later. |

The active schemes are separate. `batch-settlement` can represent
one request, but it does not have the same x402 contract as `exact`.

## x402 Version

Kaspa x402 v1 targets x402 v2 request envelopes.

Every `PaymentRequired` and `PaymentPayload` must use:

```json
{
  "x402Version": 2
}
```

Implementations must reject unsupported x402 versions on request envelopes. `SettlementResponse` follows the upstream x402 v2 response schema and does not carry `x402Version`.

## Networks

Initial network identifiers:

```text
kaspa:mainnet
kaspa:testnet-10
```

The `kaspa:` namespace is CAIP-style but not yet a formal registry claim.

Implementations must reject non-colon network aliases such as `mainnet`, `testnet-10`, `tn10`, and any other non-listed network value.

## Asset and Amounts

`asset` is `"KAS"` for native Kaspa in this draft. This is a proposed native
asset convention, not a final registry decision.

All x402 amount fields are decimal strings in atomic sompi units:

```json
{
  "asset": "KAS",
  "amount": "1000000"
}
```

This includes top-level `amount`, voucher amounts, funding amounts, charged amounts, claim amounts, and refund amounts unless a field explicitly says otherwise.

Amount and DAA-height strings are canonical unsigned 64-bit decimal strings. They must be `"0"` or a non-zero digit followed by digits, with no leading zeroes, and their numeric value must not exceed `18446744073709551615`.

Display layers may show KAS or tKAS. Wire fields must not use floating point KAS values.

The optional metadata fields below may be included in `extra` for clarity, but clients must not require them to understand native KAS:

```json
{
  "assetKind": "native",
  "assetDecimals": 8
}
```

## Common Wire Encoding

Unless a scheme document overrides a rule:

- hex fields should be emitted lowercase and accepted case-insensitively;
- fixed-width byte fields must reject odd-length or wrong-length hex;
- txids are hex decoded from their canonical display order;
- strings in signed digests are UTF-8 before hashing;
- `sha256(value)` means SHA-256 over raw bytes, not over a hex string unless the field says it is UTF-8 text;
- unsigned integers in signed digests are little-endian with the byte width stated by the field name, such as `_le32` or `_le64`;
- implementations must reject integer values that cannot fit in the stated byte width.

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

`payTo` must be a non-empty string. `maxTimeoutSeconds` must be a positive
uint32 integer.

Amounts that become on-chain outputs (exact payments and escrow deposits) are
subject to KIP-9 storage mass, which depends on the complete transaction shape.
Kaspa does not define a universal `10000000` sompi consensus dust floor. The
reference runtime uses `10000000` sompi as a conservative application policy
for its on-chain outputs, but other implementations must evaluate their full
transactions under current consensus rules. `batch-settlement` vouchers can
price individual requests below an implementation's on-chain output policy
because each voucher does not create a new on-chain output.

`extra.binding` identifies the concrete Kaspa binding:

| Scheme | `extra.binding` |
| ------ | --------------- |
| `exact` | `kaspa-exact-v1` |
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
        "binding": "kaspa-exact-v1",
        "finality": "accepted"
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

## Idempotency

Kaspa x402 implementations should support the x402 `payment-identifier` extension.

For paid retries, the server should bind the payment identifier to a normalized request fingerprint:

- same id plus same fingerprint returns the cached result;
- same id plus different fingerprint fails with a conflict;
- the fingerprint should include method or tool name, URL or MCP tool id, request body or params, selected scheme, network, asset, amount, and recipient;
- the fingerprint must not include volatile transport headers that change across retries.

When a challenge advertises the `payment-identifier` extension, the retry
payload must echo the advertised extension schema and preserve every advertised
`info` field. The client may add the retry `id` and other schema-allowed fields,
but it must not strip server-provided metadata such as tenant, route, or policy
fields.

Scheme-specific replay protection still applies even when `payment-identifier` is absent.

## Offer and Receipt Extension

The x402 offer and receipt extension is optional in v0.1 and recommended for mainnet-facing services.

For non-EVM Kaspa services, JWS is the preferred signing format for service offers and receipts. The receipt should be included at:

```text
SettlementResponse.extensions["offer-receipt"].info.receipt
```

Receipts should bind:

- selected `PaymentRequirements`;
- payment identifier, if present;
- normalized request fingerprint;
- settled transaction id or batch commitment id;
- charged amount;
- server identity;
- issue time and expiry time.

## SettlementResponse Conventions

For `exact`, a successful `SettlementResponse.transaction` is the Kaspa
transaction id that moved value for the request.

For `batch-settlement`, a voucher-only success may have:

```json
{
  "transaction": "<commitment id hex>",
  "amount": "<actual charge>",
  "extensions": {
    "kaspa": {
      "commitmentId": "<commitment id hex>",
      "chargedAmount": "<actual charge>"
    }
  }
}
```

For batch voucher-only settlement, `transaction` is the non-empty commitment id,
top-level `amount` is the actual request charge, and extension metadata is
carried in `extensions.kaspa`.

For `deposit-voucher`, top-level `amount` is the actual resource charge. Escrow funding is not reported as top-level `amount`; it is reported in `extensions.kaspa.fundingAmount`.

## Toccata Alignment

Kaspa x402 must be designed as a UTXO-native protocol, not as an account-contract API.

For covenant-backed bindings:

- production/mainnet transactions target transaction v1;
- v1 covenant inputs use `compute_budget`, not v0 `sig_op_count`;
- transaction builders must estimate script units and set compute budgets from the generated script path;
- successor outputs must be validated by script, not merely tagged with a covenant ID;
- covenant IDs provide lineage and indexability, but the script still enforces the state transition;
- exact channel outpoints must be preserved end to end;
- SilverScript is the intended covenant source surface, with generated byte fixtures and vectors required before mainnet use.

The initial architecture should prefer L1 covenant lanes for escrow and channel
state because these states naturally split by payer, service, and session.

## Common Security Requirements

Implementations must:

- verify the selected `accepted` requirements exactly match a server-offered `accepts` entry;
- reject mismatched network, asset, amount, recipient, and binding fields;
- derive transaction ids, output scripts, channel ids, and digests locally instead of trusting payload hints;
- consume payment transactions and voucher commitments at most once per trust domain;
- avoid releasing protected results before the selected scheme's settlement or commitment rule succeeds;
- preserve exact outpoint identity through funding, voucher, claim, continuation, and refund flows.

## Registry Status

The binding is not yet registered with x402 or CAIP registries. This is not a v0.1 blocker. Before a tagged `v1.0.0`, the project should submit or align with the upstream registry process for:

- network identifiers;
- scheme/network support declarations;
- native KAS asset convention if upstream formalizes one.

## References

- x402 v2: https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md
- x402 exact: https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact.md
- x402 batch-settlement: https://github.com/x402-foundation/x402/blob/main/specs/schemes/batch-settlement/scheme_batch_settlement.md
- x402 payment identifier: https://github.com/x402-foundation/x402/blob/main/specs/extensions/payment_identifier.md
- x402 offer and receipt: https://github.com/x402-foundation/x402/blob/main/specs/extensions/extension-offer-and-receipt.md
- Kaspa Toccata docs: https://github.com/kaspanet/docs/tree/main/content/docs/toccata
