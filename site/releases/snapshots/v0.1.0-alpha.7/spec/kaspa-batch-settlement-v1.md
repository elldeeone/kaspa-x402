# Kaspa x402 Batch Settlement Binding v1

Status: draft

This document defines the Kaspa network binding for x402 v2 `batch-settlement`.

## Summary

`batch-settlement` is for repeated low-value requests where the client provides a cryptographic payment commitment at request time and value moves later. The Kaspa v0.1 binding is capital-backed: the client funds a native KAS escrow/channel UTXO and signs cumulative vouchers against that exact UTXO.

Use `batch-settlement` for:

- repeated API requests against one service;
- high-frequency MCP tool calls;
- metered agent sessions where per-request on-chain settlement would be wasteful.

Use [exact](kaspa-exact-v1.md) for fixed-price one-shot purchases. Use `batch-settlement` for repeated or variable-cost requests where the server can settle from a funded escrow/channel.

## Scheme and Network Pair

```json
{
  "scheme": "batch-settlement",
  "network": "kaspa:<network>",
  "asset": "KAS",
  "extra": {
    "binding": "kaspa-escrow-v1"
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

`extra.binding` is `"kaspa-escrow-v1"` because the initial Kaspa `batch-settlement` binding is a covenant escrow/channel profile. Future batch-settlement bindings may use a different binding label.

## PaymentRequirements

```json
{
  "scheme": "batch-settlement",
  "network": "kaspa:testnet-10",
  "amount": "1000000",
  "asset": "KAS",
  "payTo": "kaspatest:...",
  "maxTimeoutSeconds": 60,
  "extra": {
    "binding": "kaspa-escrow-v1",
    "templateId": "kaspa-x402-escrow-v1",
    "serverPublicKey": "<32-byte x-only hex>",
    "minDepositSompi": "90000000",
    "refundTimeoutDaa": "123456789",
    "claimPolicy": {
      "claimWhenUnclaimedAmountExceeds": "100000000"
    }
  }
}
```

| Field | Required | Rule |
| ----- | -------- | ---- |
| `scheme` | yes | Must equal `"batch-settlement"`. |
| `network` | yes | Must be `kaspa:mainnet` or `kaspa:testnet-10`. |
| `amount` | yes | Decimal string in sompi. This is the maximum per-request charge. |
| `asset` | yes | Must equal `"KAS"`. |
| `payTo` | yes | Non-empty server payout address. This is not the client-specific escrow address. |
| `maxTimeoutSeconds` | yes | Positive maximum time, in seconds, that the client may take to provide a payment commitment. |
| `extra.binding` | yes | Must equal `"kaspa-escrow-v1"`. |
| `extra.templateId` | yes | Must equal `"kaspa-x402-escrow-v1"` for this profile. |
| `extra.serverPublicKey` | yes | Server key allowed to verify vouchers and authorize claim transactions according to the covenant rules. Refunds require the client key. |
| `extra.minDepositSompi` | yes | Minimum initial escrow deposit. |
| `extra.refundTimeoutDaa` | yes | Absolute DAA score after which unilateral refund is available. |
| `extra.claimPolicy` | no | Server policy for when it intends to claim vouchers on-chain. |
| `extra.channelState` | no | Corrective-only server channel snapshot for client resynchronization. |
| `extra.voucherState` | no | Corrective-only latest signed voucher proof for client resynchronization. |

`amount` is a ceiling. The server may charge less after executing the request. The actual charge is returned as top-level `SettlementResponse.amount` and echoed in `SettlementResponse.extensions.kaspa.chargedAmount`.

`extra.refundTimeoutDaa` is always an absolute DAA score. Relative refund policy is out of scope for this binding; servers that want relative timeouts must calculate and advertise the resulting absolute DAA score before the client constructs `ChannelConfig`.

## ChannelConfig

A channel is identified by an immutable configuration.

```json
{
  "network": "kaspa:testnet-10",
  "asset": "KAS",
  "templateId": "kaspa-x402-escrow-v1",
  "clientPublicKey": "<32-byte x-only hex>",
  "serverPublicKey": "<32-byte x-only hex>",
  "payTo": "kaspatest:...",
  "refundAddress": "kaspatest:...",
  "refundTimeoutDaa": "123456789",
  "salt": "<32-byte hex>"
}
```

The channel id is:

```text
sha256(
  sha256("kaspa:x402:channel:v1") ||
  sha256(network) ||
  sha256("KAS") ||
  sha256(templateId) ||
  clientPublicKey32 ||
  serverPublicKey32 ||
  sha256(payTo utf8) ||
  sha256(refundAddress utf8) ||
  refundTimeoutDaa_le64 ||
  salt32
)
```

Digest rules:

- strings are UTF-8 before hashing;
- integers are unsigned little-endian values of the stated byte width;
- public keys and salts are hex decoded to raw bytes;
- implementations must reject values that cannot be represented in the required integer width.

Escrow script construction derives constructor slots from this config:

- `clientPublicKey` and `serverPublicKey` are decoded as 32-byte x-only public keys;
- `networkHash = sha256(network utf8)`;
- `payoutScriptPublicKeyHash = sha256(serialized script public key for payTo)`;
- `refundScriptPublicKeyHash = sha256(serialized script public key for refundAddress)`;
- `timeout = refundTimeoutDaa`.

Address decoding must verify the address network prefix before deriving payout or refund script-public-key hashes. The serialized script public key format is `uint16_be version || script bytes`; this profile requires version `0`. The version-0 pin is why the previous little-endian wording did not change current digests or vectors: `0x0000` has the same bytes in both orders.

## Domain Tags

Implementations must domain-separate every signed digest.

Initial domain tags:

```text
kaspa:x402:channel:v1
kaspa:x402:escrow-voucher:v1
kaspa:x402:batch-commitment:v1
kaspa:x402:claim:v1
kaspa:x402:refund:v1
```

## PaymentPayload

The x402 v2 `PaymentPayload.payload` object is Kaspa-specific and uses a type discriminator.

Supported types:

- `deposit-voucher`
- `voucher`
- `claim`
- `refund`

### Deposit Voucher

`deposit-voucher` opens or tops up a channel and commits to the current request.

```json
{
  "type": "deposit-voucher",
  "channelConfig": {
    "network": "kaspa:testnet-10",
    "asset": "KAS",
    "templateId": "kaspa-x402-escrow-v1",
    "clientPublicKey": "<32-byte x-only hex>",
    "serverPublicKey": "<32-byte x-only hex>",
    "payTo": "kaspatest:...",
    "refundAddress": "kaspatest:...",
    "refundTimeoutDaa": "123456789",
    "salt": "<32-byte hex>"
  },
  "channelId": "<32-byte channel id hex>",
  "escrowAddress": "kaspatest:...",
  "fundingTransaction": "<optional serialized funding transaction hex>",
  "fundingOutpoint": {
    "txid": "<active escrow txid>",
    "index": 0
  },
  "fundingAmountSompi": "90000000",
  "activeScriptPublicKey": "<serialized active input script public key hex>",
  "voucher": {
    "amount": "1000000",
    "signature": "<64-byte Schnorr signature hex>"
  }
}
```

### Voucher

`voucher` commits against an existing active channel UTXO.

```json
{
  "type": "voucher",
  "channelId": "<32-byte channel id hex>",
  "clientPublicKey": "<32-byte x-only hex>",
  "fundingOutpoint": {
    "txid": "<active escrow txid>",
    "index": 0
  },
  "activeScriptPublicKey": "<serialized active input script public key hex>",
  "voucher": {
    "amount": "2000000",
    "signature": "<64-byte Schnorr signature hex>"
  }
}
```

### Claim

`claim` is a server or facilitator operation that redeems the latest voucher on-chain.

```json
{
  "type": "claim",
  "channelId": "<32-byte channel id hex>",
  "fundingOutpoint": {
    "txid": "<active escrow txid>",
    "index": 0
  },
  "activeScriptPublicKey": "<serialized active input script public key hex>",
  "claimAmount": "2500000",
  "voucher": {
    "amount": "2500000",
    "signature": "<64-byte Schnorr signature hex>"
  }
}
```

### Refund

`refund` cooperatively returns unclaimed escrow or initiates the template-defined unilateral refund path.

```json
{
  "type": "refund",
  "channelId": "<32-byte channel id hex>",
  "fundingOutpoint": {
    "txid": "<active escrow txid>",
    "index": 0
  },
  "activeScriptPublicKey": "<serialized active input script public key hex>",
  "refundAddress": "kaspatest:...",
  "refundAmount": "87500000",
  "clientSignature": "<65-byte transaction signature hex>"
}
```

## Voucher Digest

The voucher signs a cumulative claimable ceiling:

```text
sha256(
  sha256("kaspa:x402:escrow-voucher:v1") ||
  sha256(network) ||
  sha256(serialized active input scriptPublicKey) ||
  outpointTxid32 ||
  outpointIndex_le32 ||
  voucherAmount_le64
)
```

Digest rules:

- `voucher.amount` is cumulative, not the current request charge;
- `voucher.amount` is the maximum amount the server can claim from the active escrow UTXO;
- `voucher.signature` is a 64-byte Schnorr signature over the raw 32-byte voucher digest bytes;
- implementations must not sign the digest hex string or a personal-message hash;
- the current Kaspa WASM SDK `signMessage` scheme cannot produce voucher signatures for this profile; raw-digest signing requires a Schnorr signing library or a future SDK raw-hash signing API;
- txids are hex decoded from their canonical display order;
- integers are unsigned little-endian values of the stated byte width;
- the digest binds the exact active escrow outpoint and active input script public key;
- a voucher for one escrow UTXO must not verify for a continuation, top-up, refund, or replacement UTXO.

## Request Processing

The server must serialize request processing per channel. It must not update request charge or request commitment state until the protected handler succeeds. Accepted funding, top-up, claim, refund, and continuation transition state may be recorded independently of handler success when needed to keep channel state aligned with accepted on-chain state.

Per-channel state:

| State Field | Rule |
| ----------- | ---- |
| `channelId` | Canonical channel id derived from `ChannelConfig`. |
| `channelConfig` | Immutable channel configuration. |
| `activeOutpoint` | Current escrow UTXO that future vouchers must bind. |
| `activeScriptPublicKey` | Script public key for `activeOutpoint`. |
| `fundingAmount` | Current spendable escrow value, in sompi. |
| `chargedCumulativeAmount` | Lifetime actual accumulated charges for the channel. |
| `claimedCumulativeAmount` | Lifetime actual charges already claimed on-chain before the current active outpoint. |
| `activeChargedAmount` | `chargedCumulativeAmount - claimedCumulativeAmount`. This is the actual charge accumulated against the current active outpoint. |
| `signedMaxClaimable` | Latest client-signed voucher amount for the current active outpoint. |
| `voucherSignature` | Signature for `signedMaxClaimable` on the current active outpoint. |
| `lastCommitmentId` | Latest stored request commitment id. |

Processing steps for `deposit-voucher` and `voucher`:

1. Verify the payload and signature.
2. Reject state where `claimedCumulativeAmount > chargedCumulativeAmount`.
3. Calculate `activeChargedAmount = chargedCumulativeAmount - claimedCumulativeAmount`.
4. Calculate `requiredVoucherAmount = max(signedMaxClaimable, activeChargedAmount + PaymentRequirements.amount)` for the current active outpoint.
5. Check that `voucher.amount == requiredVoucherAmount`.
6. Check that `voucher.amount` does not exceed available escrow value after required fee or reserve policy.
7. Execute the protected handler.
8. Calculate `actualCharge`, where `actualCharge <= PaymentRequirements.amount`.
9. Derive and durably store the commitment, then update `chargedCumulativeAmount += actualCharge`.
10. Store `signedMaxClaimable = voucher.amount` and `voucherSignature = voucher.signature`.
11. Return `SettlementResponse.amount = actualCharge` and `SettlementResponse.extensions.kaspa.chargedAmount = actualCharge`.

On handler failure:

- `voucher` payload state is unchanged and the client may retry the same voucher;
- `deposit-voucher` payloads must preserve any funding or top-up transition that has already become live on-chain;
- `chargedCumulativeAmount` is not increased;
- no request `commitmentId` is stored for the failed handler;
- protected content is not released.

If a `deposit-voucher` funding or top-up transaction is accepted before the handler succeeds, the server or facilitator must durably record the new `activeOutpoint`, `activeScriptPublicKey`, `fundingAmount`, `claimedCumulativeAmount`, `signedMaxClaimable`, and `voucherSignature` before returning. This preserves the ability to claim prior active charges after the previous active outpoint has been consumed.

This monotonic rule is required because old vouchers remain valid for the same active outpoint. A server must not record a newer `signedMaxClaimable` that is lower than a still-valid prior voucher ceiling.

For refund payloads, the client signature authorizes the refund spend. The protected handler is not invoked.

Claims are full-epoch in v0.1. Before a claim spend:

- reject state where `claimedCumulativeAmount > chargedCumulativeAmount`;
- calculate `activeChargedAmount = chargedCumulativeAmount - claimedCumulativeAmount`;
- require `claimAmount == activeChargedAmount`;
- require `voucher.amount >= claimAmount`;
- reject partial claims where `0 < claimAmount < activeChargedAmount`.

When an accepted claim spend creates a continuation outpoint, the continuation starts a new active-outpoint voucher epoch:

- set `claimedCumulativeAmount = chargedCumulativeAmount`;
- set `signedMaxClaimable = "0"` unless the continuation transaction also carries a freshly signed voucher for the new active outpoint;
- clear `voucherSignature` unless a fresh continuation voucher is present;
- set `activeOutpoint` and `activeScriptPublicKey` to the continuation UTXO.

Old vouchers are invalid for the continuation because voucher signatures bind the prior active outpoint and script public key.

Claim and refund transactions are successful only after they are accepted by the selected Kaspa network according to the server or facilitator finality policy. Broadcast-only or mempool-only claim/refund transactions are pending state; they must not mutate active channel state and must not be reported as successful settlement.

## Deposit and Top-Up Transition

`deposit-voucher` has two modes:

- initial deposit, when no channel state exists for `channelId`;
- top-up, when a channel exists and the client moves value into a new active escrow outpoint.

A funding or top-up transaction is live only after it is accepted by the selected Kaspa network according to the server or facilitator finality policy. Broadcast-only or mempool-only funding is pending state; it must not release protected content and must not replace the active channel outpoint.

For an initial deposit:

- `fundingOutpoint` becomes `activeOutpoint`;
- `activeScriptPublicKey` becomes the script public key for `fundingOutpoint`;
- `fundingAmount` is initialized from `fundingAmountSompi`;
- `chargedCumulativeAmount = "0"`;
- `claimedCumulativeAmount = "0"`;
- `signedMaxClaimable = "0"` before the request voucher is verified.

For a top-up:

- request processing must be serialized for the existing channel;
- the top-up transaction must spend the previous `activeOutpoint` into the new `fundingOutpoint` or otherwise prove, according to the covenant template, that the new `fundingOutpoint` is the successor active outpoint for the same `channelId`;
- the new `activeScriptPublicKey` must match `templateId` and preserve the same `ChannelConfig`;
- `claimedCumulativeAmount` is unchanged;
- `chargedCumulativeAmount` is unchanged before the protected handler executes;
- `fundingAmount` is updated to the new active escrow value;
- `signedMaxClaimable = "0"` for the new active outpoint before the request voucher is verified, because old vouchers do not verify against the new outpoint.

After this transition, the normal request-processing rule applies against the new active outpoint. The required voucher amount is therefore based on `activeChargedAmount = chargedCumulativeAmount - claimedCumulativeAmount` for the new active outpoint, plus the current `PaymentRequirements.amount`.

Protected content must not be released for a `deposit-voucher` top-up until the top-up transaction is accepted, the top-up transition is verified, and the new voucher commitment is durably stored.

If the protected handler fails after the top-up transition is live, the top-up state remains active but the request charge is not committed. The next paid retry must use the new active outpoint and the preserved `signedMaxClaimable` for that outpoint.

## Commitment Identifier

A stored batch commitment records one successful paid request whose value has not necessarily moved on-chain yet.

The `commitmentId` is:

```text
sha256(
  sha256("kaspa:x402:batch-commitment:v1") ||
  channelId32 ||
  sha256(normalized request fingerprint bytes) ||
  paymentRequirementsHash32 ||
  activeOutpointTxid32 ||
  activeOutpointIndex_le32 ||
  voucherAmount_le64 ||
  sha256(voucherSignature64) ||
  actualCharge_le64 ||
  chargedCumulativeBefore_le64 ||
  chargedCumulativeAfter_le64 ||
  claimedCumulativeAmount_le64
)
```

Digest rules:

- `channelId32` is the canonical channel id bytes;
- `normalized request fingerprint bytes` are the same bytes used for payment-identifier idempotency;
- `paymentRequirementsHash32` is the structured hash defined below;
- `voucherSignature64` is the raw 64-byte signature decoded from hex;
- `chargedCumulativeAfter` must equal `chargedCumulativeBefore + actualCharge`;
- `claimedCumulativeAmount` is the lifetime claimed base for the active outpoint when the commitment is stored;
- integers are unsigned little-endian values of the stated byte width.

`paymentRequirementsHash32` is:

```text
sha256(
  sha256("kaspa:x402:batch-payment-requirements:v1") ||
  sha256("batch-settlement") ||
  sha256(network) ||
  sha256("KAS") ||
  amount_le64 ||
  sha256(payTo utf8) ||
  maxTimeoutSeconds_le64 ||
  sha256("kaspa-escrow-v1") ||
  sha256(templateId) ||
  serverPublicKey32 ||
  minDepositSompi_le64 ||
  refundTimeoutDaa_le64
)
```

Unknown `extra` fields are not part of `paymentRequirementsHash32` unless a future binding marks them as critical. A client or server that relies on a critical extension must define that extension's hash contribution before using it in a commitment.

A commitment is stored only when the server or facilitator has durably recorded, keyed by `commitmentId`:

- channel id;
- normalized request fingerprint hash;
- selected `PaymentRequirements` hash;
- active outpoint;
- voucher amount and signature;
- actual charge;
- cumulative charge before and after the request;
- claimed cumulative base for the active outpoint;
- payment identifier, if present;
- response receipt metadata, if the offer/receipt extension is used.

Protected content must not be released until this durable record exists. Retrying the same payment identifier and request fingerprint must return the same `commitmentId` and cached result.

## Trust Model

The Kaspa batch binding is capital-backed. For the current active outpoint, the client's incremental risk is bounded by the latest signed `voucher.amount`, not by the actual charge reported for the last request. Across the full channel lifetime, claimed value is tracked by `claimedCumulativeAmount`.

The server must claim no more than `activeChargedAmount` from the current active outpoint. If the server claims above the actual active charge but within the signed voucher ceiling, that is a trust violation detectable from receipts and channel state, not necessarily a covenant-level rejection.

Clients must stop signing additional vouchers and should refund or withdraw if:

- `SettlementResponse.amount` or `SettlementResponse.extensions.kaspa.chargedAmount` exceeds `PaymentRequirements.amount`;
- `SettlementResponse.extensions.kaspa.channelState.chargedCumulativeAmount` does not equal the previous value plus `chargedAmount`;
- the returned channel state uses an unexpected active outpoint;
- the server cannot produce the latest signed voucher in a corrective response.

## SettlementResponse

Successful voucher-only response:

```json
{
  "success": true,
  "transaction": "<commitment id hex>",
  "network": "kaspa:testnet-10",
  "payer": "kaspatest:...",
  "amount": "700000",
  "extensions": {
    "kaspa": {
      "commitmentId": "<commitment id hex>",
      "chargedAmount": "700000",
      "channelState": {
        "channelId": "<32-byte channel id hex>",
        "activeOutpoint": {
          "txid": "<active escrow txid>",
          "index": 0
        },
        "activeScriptPublicKey": "<serialized active input script public key hex>",
        "fundingAmount": "90000000",
        "chargedCumulativeAmount": "1700000",
        "claimedCumulativeAmount": "0",
        "signedMaxClaimable": "2000000"
      }
    }
  }
}
```

Successful deposit response:

```json
{
  "success": true,
  "transaction": "<commitment id hex>",
  "network": "kaspa:testnet-10",
  "payer": "kaspatest:...",
  "amount": "700000",
  "extensions": {
    "kaspa": {
      "commitmentId": "<commitment id hex>",
      "fundingAmount": "90000000",
      "chargedAmount": "700000",
      "channelState": {
        "channelId": "<32-byte channel id hex>",
        "activeOutpoint": {
          "txid": "<active escrow txid>",
          "index": 0
        },
        "activeScriptPublicKey": "<serialized active input script public key hex>",
        "fundingAmount": "90000000",
        "chargedCumulativeAmount": "700000",
        "claimedCumulativeAmount": "0",
        "signedMaxClaimable": "1000000"
      }
    }
  }
}
```

For `deposit-voucher`, top-level `amount` is the actual request charge. Escrow funding is not the resource price and is reported separately in `extensions.kaspa.fundingAmount`.

Successful claim response:

```json
{
  "success": true,
  "transaction": "<claim transaction id>",
  "network": "kaspa:testnet-10",
  "payer": "kaspatest:...",
  "amount": "1700000",
  "extensions": {
    "kaspa": {
      "claimOutpoint": {
        "txid": "<claim transaction id>",
        "index": 0
      },
      "continuationOutpoint": {
        "txid": "<claim transaction id>",
        "index": 1
      },
      "channelState": {
        "channelId": "<32-byte channel id hex>",
        "activeOutpoint": {
          "txid": "<claim transaction id>",
          "index": 1
        },
        "activeScriptPublicKey": "<serialized continuation script public key hex>",
        "fundingAmount": "88300000",
        "chargedCumulativeAmount": "1700000",
        "claimedCumulativeAmount": "1700000",
        "signedMaxClaimable": "0"
      }
    }
  }
}
```

Successful refund response:

```json
{
  "success": true,
  "transaction": "<refund transaction id>",
  "network": "kaspa:testnet-10",
  "payer": "kaspatest:...",
  "amount": "87500000",
  "extensions": {
    "kaspa": {
      "channelId": "<32-byte channel id hex>",
      "refundAddress": "kaspatest:..."
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

For `batch-settlement`, a successful voucher-only response must include a non-empty `extensions.kaspa.commitmentId`. `transaction` is that commitment id because value has not moved on-chain yet.

## Corrective 402

If a paid retry fails because the client and server disagree about channel state, the server should return a corrective x402 `PaymentRequired` response.

Corrective responses use the normal `accepts` array and include `extra.channelState`. If the server wants the client to adopt a newer cumulative value, it must also include `extra.voucherState` containing the latest signed voucher amount and signature.

The client must verify `extra.voucherState` before adopting server-provided state. If verification fails, the client must not sign a new voucher against that state.

Corrective responses are appropriate for:

- stale active outpoint;
- mismatched cumulative voucher amount;
- missing local channel session;
- channel busy lock;
- insufficient escrow balance;
- server state recovery after restart.

## Recovery

### Stale Outpoint

The client must refresh the active channel state, verify the server-provided latest voucher if present, and sign the next voucher against the exact current active outpoint.

### Channel Busy

The client should retry after the server-provided delay. The server should use a short lock and must not execute two paid handlers concurrently for the same channel.

### Insufficient Balance

The client should send a `deposit-voucher` top-up payload. The new voucher must bind the new active outpoint created by the deposit or continuation transaction.

### Server State Loss

If the server loses local unclaimed voucher state, it may recover from on-chain state and the latest client-provided voucher. Any unclaimed charges not represented by a recoverable voucher are server risk.

## Toccata Requirements

The mainnet profile targets transaction v1 and Toccata covenants:

- v1 inputs use `compute_budget`;
- transaction builders must estimate script units from the generated script path;
- scripts must validate successor outputs, not only inputs;
- covenant IDs should be used for production lineage and indexability once wallet and builder support is ready;
- covenant IDs do not replace script-level transition validation;
- funding, voucher, claim, continuation, and refund flows must preserve exact outpoint identity;
- claim spends must validate the payout and continuation output;
- refund spends must validate timeout and refund address;
- SilverScript source plus generated byte fixtures should be the reviewable covenant source of truth.

The v1 SilverScript shape is a script-level escrow covenant: it binds the active script public key into vouchers, validates the continuation output, and validates payout/refund destinations by script-public-key hash. Stateful Toccata wrappers may add covenant IDs and `validateOutputState(...)` lineage checks later, but those IDs do not replace the v1 script-level payout, refund, continuation, and full-outpoint checks.

## Security Requirements

Implementations must reject:

- unsupported x402 version;
- unsupported scheme, network, asset, or binding;
- network mismatch;
- invalid public keys;
- invalid channel id;
- channel config that does not hash to `channelId`;
- invalid funding outpoint;
- deposit below `minDepositSompi`;
- script public key that does not match `templateId`;
- voucher signed for the wrong network;
- voucher signed for the wrong script public key;
- voucher signed for the wrong txid or output index;
- voucher amount below required cumulative ceiling;
- voucher amount above available escrow balance after required fee or reserve policy;
- `claimedCumulativeAmount` greater than `chargedCumulativeAmount`;
- claim amount above voucher amount;
- claim amount different from `activeChargedAmount`;
- refund before `refundTimeoutDaa` for unilateral refund paths;
- idempotency key reuse with a different request fingerprint.

## Local Diagnostics

Public wire responses use the mapped reasons in [errors.md](errors.md). Implementations may use common `invalid_kaspa_x402_*` diagnostics plus:

```text
invalid_kaspa_batch_template
invalid_kaspa_batch_channel_id
invalid_kaspa_batch_channel_state
invalid_kaspa_batch_corrective_state
invalid_kaspa_batch_funding_outpoint
invalid_kaspa_batch_funding_amount
invalid_kaspa_batch_voucher_signature
invalid_kaspa_batch_voucher_network
invalid_kaspa_batch_voucher_script
invalid_kaspa_batch_voucher_outpoint
invalid_kaspa_batch_cumulative_amount_mismatch
invalid_kaspa_batch_cumulative_below_claimed
invalid_kaspa_batch_insufficient_channel_balance
invalid_kaspa_batch_channel_busy
invalid_kaspa_batch_commitment
invalid_kaspa_batch_handler_failed
invalid_kaspa_batch_refund_not_mature
invalid_kaspa_batch_claim_dust
invalid_kaspa_batch_compute_budget
```
