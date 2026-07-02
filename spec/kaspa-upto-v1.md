# Kaspa x402 Upto Binding v1

Status: draft

This document defines the Kaspa network binding for x402 v2 `upto`.

## Summary

`upto` is for one-shot variable-price purchases. The client authorizes a maximum amount before the request is served. The server executes the request, calculates the actual charge, and settles once for an amount less than or equal to the signed cap.

Use `upto` for:

- variable-cost LLM or agent calls;
- byte, token, compute, or time-metered one-shot work;
- requests where the server needs a cap before execution but cannot know the final price upfront.

Do not use `upto` as a recurring allowance or a repeated micropayment channel. Use [batch-settlement](kaspa-batch-settlement-v1.md) for repeated service calls.

## Scheme and Network Pair

```json
{
  "scheme": "upto",
  "network": "kaspa:<network>",
  "asset": "KAS",
  "extra": {
    "binding": "kaspa-upto-v1"
  }
}
```

Supported networks:

```text
kaspa:mainnet
kaspa:testnet-10
```

## PaymentRequirements

```json
{
  "scheme": "upto",
  "network": "kaspa:testnet-10",
  "amount": "25000000",
  "asset": "KAS",
  "payTo": "kaspatest:...",
  "maxTimeoutSeconds": 300,
  "extra": {
    "binding": "kaspa-upto-v1",
    "authorizationTemplateId": "kaspa-x402-upto-v1",
    "serverPublicKey": "<32-byte x-only hex>",
    "authorizationTimeoutDaa": "123456789",
    "settlementFeeReserveSompi": "2000",
    "finality": "accepted"
  }
}
```

| Field | Required | Rule |
| ----- | -------- | ---- |
| `scheme` | yes | Must equal `"upto"`. |
| `network` | yes | Must be `kaspa:mainnet` or `kaspa:testnet-10`. |
| `amount` | yes | Decimal string in sompi. At verify time this is the maximum authorized charge. At settle time this is the actual charge. |
| `asset` | yes | Must equal `"KAS"`. |
| `payTo` | yes | Recipient Kaspa address for the selected network. |
| `maxTimeoutSeconds` | yes | Maximum time the client may take to provide an authorization. |
| `extra.binding` | yes | Must equal `"kaspa-upto-v1"`. |
| `extra.authorizationTemplateId` | yes | Must equal `"kaspa-x402-upto-v1"` for the v0.1 covenant-backed profile. |
| `extra.serverPublicKey` | yes | Server key allowed to settle the one-shot authorization. |
| `extra.authorizationTimeoutDaa` | yes | Absolute DAA score after which this specific authorization offer must not be settled. |
| `extra.settlementFeeReserveSompi` | yes | Signed maximum fee reserve for nonzero settlement. |
| `extra.finality` | no | One of `"accepted"` or `"confirmed"`. If absent, default is `"accepted"`. |

x402 `upto` has phase-dependent amount semantics:

- during `verify`, `PaymentRequirements.amount` is the maximum amount the client authorizes;
- during `settle`, `PaymentRequirements.amount` is the actual amount to charge, and it must be less than or equal to the signed maximum.

`authorizationTimeoutDaa` is an absolute value on the wire. Server operators
should normally derive it from a relative per-offer policy, such as "current
virtual DAA score plus N", and enforce a maximum window cap when verifying
retries. Clients must copy the offered absolute value into `validBeforeDaa`;
they must not extend it locally.

## Lifecycle

1. Client requests a protected resource without payment.
2. Server returns x402 v2 `PaymentRequired` with an `upto` Kaspa entry in `accepts`.
3. Client constructs or references a one-shot Kaspa authorization UTXO.
4. Client signs an authorization that binds the maximum amount, recipient, server key, timeout, refund address, request fingerprint, and exact authorization outpoint.
5. Client retries with `PaymentPayload.accepted` equal to the chosen requirements and `payload.type = "upto-authorization"`.
6. Server or facilitator verifies the authorization before executing the handler.
7. Handler executes and calculates the actual charge.
8. Server or facilitator settles once for the actual charge, which must be less than or equal to the signed maximum. Nonzero charges wait for transaction finality; zero-charge results store no-transaction authorization consumption.
9. Server returns the protected result and the x402 `SettlementResponse`.

## PaymentPayload

The payload type is `upto-authorization`.

```json
{
  "type": "upto-authorization",
  "payerAddress": "kaspatest:...",
  "clientPublicKey": "<32-byte x-only hex>",
  "authorizationOutpoint": {
    "txid": "<authorization txid>",
    "index": 0
  },
  "authorizationScriptPublicKey": "<serialized script public key hex>",
  "authorizationAmountSompi": "26000000",
  "refundAddress": "kaspatest:...",
  "fundingTransaction": "<optional serialized funding transaction hex>",
  "authorization": {
    "maxAmountSompi": "25000000",
    "payTo": "kaspatest:...",
    "payoutScriptPublicKeyHash": "<32-byte script public key hash hex>",
    "refundScriptPublicKeyHash": "<32-byte script public key hash hex>",
    "validAfterDaa": "123450000",
    "validBeforeDaa": "123456789",
    "settlementFeeReserveSompi": "2000",
    "nonce": "<32-byte hex>",
    "serverPublicKey": "<32-byte x-only hex>",
    "requestHash": "<sha256 request fingerprint hex>",
    "signature": "<64-byte Schnorr signature hex>"
  }
}
```

| Field | Required | Rule |
| ----- | -------- | ---- |
| `type` | yes | Must equal `"upto-authorization"`. |
| `payerAddress` | no | Client payment address, if known. Used for receipts and policy only. |
| `clientPublicKey` | yes | Public key that signs the authorization digest. |
| `authorizationOutpoint` | yes | Exact UTXO backing this one-shot authorization. |
| `authorizationScriptPublicKey` | yes | Script public key for the backing authorization UTXO. |
| `authorizationAmountSompi` | yes | Value locked by the authorization UTXO. Must be at least `authorization.maxAmountSompi + authorization.settlementFeeReserveSompi + 1` so the required refund output can be positive. |
| `refundAddress` | yes | Address that receives uncharged value according to the authorization rules. |
| `fundingTransaction` | no | Serialized transaction that creates `authorizationOutpoint`, when the verifier has not observed it yet. |
| `authorization.maxAmountSompi` | yes | Signed maximum charge. Must equal verify-time `PaymentRequirements.amount`. |
| `authorization.payTo` | yes | Signed recipient. Must equal `PaymentRequirements.payTo`. |
| `authorization.payoutScriptPublicKeyHash` | yes | Signed hash of the payout script public key derived from `payTo`. |
| `authorization.refundScriptPublicKeyHash` | yes | Signed hash of the refund script public key derived from `refundAddress`. |
| `authorization.validAfterDaa` | yes | Earliest DAA score for settlement. |
| `authorization.validBeforeDaa` | yes | Exclusive latest DAA score for settlement and start DAA score for client refund. |
| `authorization.settlementFeeReserveSompi` | yes | Signed maximum fee reserve. Must equal `extra.settlementFeeReserveSompi`. |
| `authorization.nonce` | yes | Single-use nonce. |
| `authorization.serverPublicKey` | yes | Server key allowed to settle. Must match `extra.serverPublicKey`. |
| `authorization.requestHash` | yes | SHA-256 of the normalized request fingerprint. Required for direct-mode request binding. |
| `authorization.signature` | yes | Schnorr signature by `clientPublicKey` over the authorization digest. |

## Authorization Digest

The client signs this digest:

```text
sha256(
  sha256("kaspa:x402:upto-authorization:v2") ||
  sha256(network) ||
  sha256(serialized authorizationScriptPublicKey bytes) ||
  authorizationOutpointTxid32 ||
  authorizationOutpointIndex_le32 ||
  requestHash32 ||
  nonce32
)
```

Digest rules:

- strings are UTF-8 before hashing;
- txids are hex decoded from their canonical display order;
- `authorizationScriptPublicKey` is the serialized Kaspa script public key with uint16 little-endian version prefix, and the version must be `0`;
- integers are unsigned little-endian values of the stated byte width;
- `requestHash` is a required 32-byte request-fingerprint hash;
- implementations must reject values that cannot be represented in the required integer width.

## Covenant Template

`authorizationTemplateId = "kaspa-x402-upto-v1"` identifies a single-use SilverScript authorization template. The template constructor binds:

- client and server public keys;
- network hash;
- payout and refund script public key hashes;
- request hash and nonce;
- maximum charge, settlement lower bound, refund lower bound, and settlement fee reserve.

The settlement branch requires the server signature and the client authorization digest, enforces the constructor cap, requires exactly two outputs, pays output 0 to the payout script hash, returns output 1 to the refund script hash, and caps fees at `settlementFeeReserveSompi`. The redeem script is kept below the 520-byte P2SH element limit.

The refund branch requires the client signature, a sequence-0 input, one refund output, and `tx.time >= validBeforeDaa`.

The current SilverScript compiler profile used for the fixture supports `tx.time` as a lower-bound lock only. Because of that parser limitation, the settlement upper bound `validBeforeDaa` is enforced by verifiers before handler execution, immediately before nonzero settlement construction, immediately before broadcast, and before recovery rebroadcasts. The template enforces settlement `validAfterDaa` and refund `validBeforeDaa` on-chain.

## Verification

Verification must reject with the relevant error code if:

- x402 version is unsupported;
- `scheme`, `network`, `asset`, or `extra.binding` is unsupported;
- `extra.authorizationTemplateId` is unsupported;
- signed maximum does not equal verify-time `PaymentRequirements.amount`;
- signed `payTo` does not equal `PaymentRequirements.payTo`;
- signed `serverPublicKey` does not equal `extra.serverPublicKey`;
- signed fee reserve does not equal `extra.settlementFeeReserveSompi`;
- signed payout or refund script public key hashes do not match `payTo` and `refundAddress`;
- the authorization is not active, is expired, exceeds `extra.authorizationTimeoutDaa`, or exceeds the server's configured maximum authorization window;
- the authorization outpoint or nonce was already consumed;
- the authorization UTXO is missing and no valid funding transaction is provided;
- the authorization UTXO does not pay to the expected script public key;
- the script public key does not match `extra.authorizationTemplateId`;
- the authorization amount is below the maximum plus signed fee reserve plus the required positive refund output;
- the signature is invalid;
- a required `payment-identifier` extension is absent;
- `requestHash` does not match the server's normalized request fingerprint.

## Settlement

The resource server calculates the actual charge after executing the request.

Settlement rules:

- settlement-time `PaymentRequirements.amount` is the actual charge;
- actual charge must be less than or equal to `authorization.maxAmountSompi`;
- the authorization may be settled or consumed at most once;
- if the actual charge is greater than `0`, the settlement transaction must consume `authorizationOutpoint`;
- if the actual charge is greater than `0`, the settlement transaction must pay the actual charge to `payTo`;
- if the actual charge is `0`, no transaction is broadcast and no dust or zero-value payment output is created;
- for nonzero charges, remaining value must return to `refundAddress` after fees;
- for nonzero charges, the refund output must be present and positive;
- for nonzero charges, fee accounting must not exceed `authorization.settlementFeeReserveSompi`;
- for nonzero charges, the settlement transaction must reach `extensions.kaspa.finality` before `SettlementResponse.success = true`;
- after a nonzero settlement transaction is broadcast below the selected finality, the server must preserve the authorization state and return a non-402 pending response instead of issuing another payment challenge;
- for zero-charge success, the server or facilitator must durably store the authorization consumption before `SettlementResponse.success = true`;
- a failed handler must not settle a nonzero charge unless the service terms explicitly make the failed work billable and the signed request fingerprint covers that rule.

If the actual charge is `0`, the server must return the no-transaction success shape below and must not claim that value moved on-chain.

## SettlementResponse

Successful response:

```json
{
  "success": true,
  "transaction": "<kaspa transaction id>",
  "network": "kaspa:testnet-10",
  "payer": "kaspatest:...",
  "amount": "1858000",
  "extensions": {
    "kaspa": {
      "maxAmountSompi": "25000000",
      "authorizationOutpoint": {
        "txid": "<authorization txid>",
        "index": 0
      },
      "refundAddress": "kaspatest:...",
      "finality": "accepted"
    }
  }
}
```

Successful zero-charge response:

```json
{
  "success": true,
  "transaction": "",
  "network": "kaspa:testnet-10",
  "payer": "kaspatest:...",
  "amount": "0",
  "extensions": {
    "kaspa": {
      "chargedAmount": "0",
      "maxAmountSompi": "25000000",
      "authorizationOutpoint": {
        "txid": "<authorization txid>",
        "index": 0
      },
      "refundAddress": "kaspatest:..."
    }
  }
}
```

Pending nonzero response:

```json
{
  "success": false,
  "errorReason": "upto_authorization_pending",
  "transaction": "<kaspa transaction id>",
  "network": "kaspa:testnet-10",
  "payer": "kaspatest:...",
  "amount": "1858000",
  "extensions": {
    "kaspa": {
      "maxAmountSompi": "25000000",
      "authorizationOutpoint": {
        "txid": "<authorization txid>",
        "index": 0
      },
      "refundAddress": "kaspatest:...",
      "finality": "mempool"
    }
  }
}
```

Servers should return this shape with a non-402 HTTP status, such as `202`, while withholding protected content. Clients must not treat it as a new payment challenge.

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
must not synthesize a fallback network. Pending settlement responses are
network-bound and must include `network`.

`amount` is the actual settled amount on success. It may be lower than the verify-time maximum.

## Idempotency

Servers should require the x402 `payment-identifier` extension for `upto`.

The server must bind the payment identifier to the normalized request fingerprint and the authorization outpoint. Same id plus same fingerprint returns the cached result. Same id plus different fingerprint fails. The same authorization outpoint or nonce must not be used for multiple request fingerprints.

## Toccata Notes

The mainnet `upto` profile is covenant-backed:

- transaction v1 must be used for covenant spends;
- v1 inputs use `compute_budget`;
- transaction builders must estimate script units from the generated script path;
- the spend must bind the exact authorization outpoint and nonce;
- the settlement output and refund output must be validated by script;
- SilverScript source and generated byte fixtures must be included in vectors before mainnet use.

## Local Diagnostics

Public wire responses use the mapped reasons in [errors.md](errors.md). Implementations may use common `invalid_kaspa_x402_*` diagnostics plus:

```text
invalid_kaspa_upto_authorization
invalid_kaspa_upto_expired
invalid_kaspa_upto_recipient
invalid_kaspa_upto_max_amount
invalid_kaspa_upto_replay
invalid_kaspa_upto_settlement_amount
invalid_kaspa_upto_authorization_outpoint
invalid_kaspa_upto_template
```
