# Kaspa x402 Batch Settlement Binding v2

Status: Alpha.11, Testnet-10-only interoperability candidate

This document defines the active Kaspa network binding for x402 v2
`batch-settlement`.

## Summary

`batch-settlement` is for repeated or post-priced requests where the buyer
provides an off-chain payment commitment at request time and the provider moves
value later. The buyer funds one native KAS covenant lane and signs increasing
lifetime cumulative ceilings. The provider may settle all or part of the
outstanding charge while keeping the lane open.

Use `batch-settlement` for repeated API requests, metered agent sessions, and
variable-cost MCP tools. Use [exact](kaspa-exact-v2.md) for a fixed-price
one-shot purchase.

Alpha.11 replaces the earlier alpha batch binding. It does not implement a
compatibility reader, migration path, or dual runtime for older alpha channel
state. Immutable release snapshots remain historical evidence only.

## Scheme And Identifiers

```json
{
  "scheme": "batch-settlement",
  "network": "kaspa:testnet-10",
  "asset": "KAS",
  "extra": {
    "binding": "kaspa-escrow-v2",
    "templateId": "kaspa-x402-escrow-v3"
  }
}
```

The active identifiers are:

```text
scheme       batch-settlement
binding      kaspa-escrow-v2
templateId   kaspa-x402-escrow-v3
```

`kaspa:testnet-10` is the only Alpha.11 validation target. The common binding
reserves `kaspa:mainnet` as a draft network identifier, but this batch profile
MUST NOT be enabled on mainnet.

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
    "binding": "kaspa-escrow-v2",
    "templateId": "kaspa-x402-escrow-v3",
    "serverPublicKey": "<32-byte x-only hex>",
    "minDepositSompi": "90000000",
    "claimReserveSompi": "2000000",
    "refundTimeoutDaa": "123456789",
    "claimPolicy": {
      "claimWhenUnclaimedAmountExceeds": "100000000"
    }
  }
}
```

| Field | Required | Rule |
| --- | --- | --- |
| `scheme` | yes | MUST equal `batch-settlement`. |
| `network` | yes | MUST equal `kaspa:testnet-10` in Alpha.11. |
| `amount` | yes | Maximum per-request charge, as canonical decimal sompi. |
| `asset` | yes | MUST equal `KAS`. |
| `payTo` | yes | Provider payout address; it is not the lane address. |
| `maxTimeoutSeconds` | yes | Positive response timeout in seconds. |
| `extra.binding` | yes | MUST equal `kaspa-escrow-v2`. |
| `extra.templateId` | yes | MUST equal `kaspa-x402-escrow-v3`. |
| `extra.serverPublicKey` | yes | Provider key used by the covenant claim path. |
| `extra.minDepositSompi` | yes | Minimum initial covenant value. |
| `extra.claimReserveSompi` | yes | Minimum successor value retained beyond remaining authorization. |
| `extra.refundTimeoutDaa` | yes | Absolute DAA score for unilateral refund. |
| `extra.claimPolicy` | no | Provider policy for initiating an on-chain claim. |
| `extra.channelState` | no | Corrective-only current lane snapshot. |
| `extra.voucherState` | no | Corrective-only latest signed voucher proof. |

`amount` is a ceiling. The actual resource charge MAY be lower and is returned
as top-level `SettlementResponse.amount` and
`SettlementResponse.extensions.kaspa.chargedAmount`.

All batch monetary and covenant-state values MUST be in the inclusive range
`0..9223372036854775807`. SilverScript uses signed 64-bit arithmetic even
though the common x402 amount grammar can represent unsigned 64-bit values.
Implementations MUST reject a batch value outside the smaller range before
constructing a digest, adding values, or evaluating a transaction.

`minDepositSompi` MUST be at least `amount + claimReserveSompi`, with the sum
also inside the signed 64-bit range.

`refundTimeoutDaa` is an absolute DAA score and MUST remain below
`500000000000`, where Kaspa lock time changes to timestamp interpretation.

## ChannelConfig And Channel Id

```json
{
  "network": "kaspa:testnet-10",
  "asset": "KAS",
  "templateId": "kaspa-x402-escrow-v3",
  "clientPublicKey": "<32-byte x-only hex>",
  "serverPublicKey": "<32-byte x-only hex>",
  "payTo": "kaspatest:...",
  "refundAddress": "kaspatest:...",
  "refundTimeoutDaa": "123456789",
  "salt": "<32-byte hex>"
}
```

The application channel id remains:

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

The channel domain remains v1 because its preimage and meaning did not change.
The v2 template identifier already prevents a v1 channel configuration from
colliding with a v2 configuration.

Strings are UTF-8 before hashing. Integers are unsigned little-endian values
of the stated width. Public keys and salts are decoded from hex to raw bytes.
Address decoding MUST verify the network prefix. A serialized script public
key is `uint16_be version || script bytes`; this profile accepts version `0`
only.

`channelId` identifies application configuration. `covenantId` identifies the
on-chain KIP-20 lineage. They are different values and neither one locates the
current UTXO.

## Domain Tags

```text
kaspa:x402:channel:v1
kaspa:x402:escrow-voucher:v2
kaspa:x402:batch-payment-requirements:v2
kaspa:x402:batch-commitment:v2
```

Claim, top-up, and refund transaction inputs use Kaspa transaction-v1
`SIGHASH_ALL`. They do not introduce separate application transaction-signing
domains.

## Lifetime Accounting

The normative symbols are:

| Symbol | Wire or policy value | Meaning |
| --- | --- | --- |
| `A` | `chargedCumulativeAmount` | Lifetime actual resource charges durably committed after successful work. |
| `S` | `claimedCumulativeAmount` and covenant state | Lifetime gross value settled on-chain, including claim fees. |
| `T` | `signedMaxClaimable` and `voucher.amount` | Latest buyer-signed lifetime cumulative settlement ceiling. |
| `V` | `fundingAmount` | Current value of the active covenant UTXO. |
| `R` | `extra.claimReserveSompi` | Minimum value left in the covenant after fully settling the remaining authorization. |

Every accepted snapshot MUST satisfy:

```text
0 <= S <= A <= T <= 9223372036854775807
(T - S) + R <= V
```

Derived values are:

```text
outstanding actual charge = A - S
remaining authorization  = T - S
```

`R` is committed by the accepted payment requirements, but it is not a signed
entitlement and is not added to `T`. The provider MUST advertise a conservative
value derived from its successor-output policy. The buyer and provider MUST
both reject a voucher that leaves less than `R` beyond its remaining
authorization. Claim fees are deducted from the provider payout; live fee
estimates affect claim readiness and do not silently change `R` for an already
accepted requirement.

`A`, `S`, and `T` are lifetime values. A claim or top-up changes the current
outpoint but does not reset them. The covenant state commits `S`; application
storage commits `A`, `T`, the voucher proof, and the current head.

## Channel State

```json
{
  "channelId": "<32-byte channel id hex>",
  "covenantId": "<32-byte KIP-20 covenant id hex>",
  "activeOutpoint": {
    "txid": "<current covenant txid>",
    "index": 1
  },
  "activeScriptPublicKey": "<serialized script public key hex>",
  "fundingAmount": "88300000",
  "chargedCumulativeAmount": "2500000",
  "claimedCumulativeAmount": "1700000",
  "signedMaxClaimable": "3000000"
}
```

The stable `covenantId` proves identity and authorized successor lineage. It is
not a reverse index. Standard node RPC does not provide a covenant-id-to-UTXO
lookup, so every runtime MUST persist and atomically advance
`activeOutpoint`, `activeScriptPublicKey`, `fundingAmount`, and the covenant
state beside the id. Recovery MAY use an indexer, transaction lineage, or a
known-address UTXO scan, but it MUST re-verify the same-id transition before
adopting a candidate.

## PaymentPayload

The supported payload discriminators remain:

- `deposit-voucher`;
- `voucher`;
- `claim`;
- `refund`.

### Deposit Voucher

`deposit-voucher` opens a lane or presents an accepted top-up successor and
commits to the current request.

```json
{
  "type": "deposit-voucher",
  "channelConfig": {
    "network": "kaspa:testnet-10",
    "asset": "KAS",
    "templateId": "kaspa-x402-escrow-v3",
    "clientPublicKey": "<32-byte x-only hex>",
    "serverPublicKey": "<32-byte x-only hex>",
    "payTo": "kaspatest:...",
    "refundAddress": "kaspatest:...",
    "refundTimeoutDaa": "123456789",
    "salt": "<32-byte hex>"
  },
  "channelId": "<32-byte channel id hex>",
  "escrowAddress": "kaspatest:...",
  "fundingTransaction": "<optional opaque transaction evidence>",
  "fundingOutpoint": {
    "txid": "<current covenant txid>",
    "index": 0
  },
  "fundingAmountSompi": "90000000",
  "activeScriptPublicKey": "<serialized active script public key hex>",
  "voucher": {
    "covenantId": "<32-byte covenant id hex>",
    "amount": "1000000",
    "signature": "<64-byte Schnorr signature hex>"
  }
}
```

### Voucher

```json
{
  "type": "voucher",
  "channelId": "<32-byte channel id hex>",
  "clientPublicKey": "<32-byte x-only hex>",
  "fundingOutpoint": {
    "txid": "<current covenant txid>",
    "index": 1
  },
  "activeScriptPublicKey": "<serialized active script public key hex>",
  "voucher": {
    "covenantId": "<32-byte covenant id hex>",
    "amount": "3000000",
    "signature": "<64-byte Schnorr signature hex>"
  }
}
```

The outpoint and script remain payload evidence for head synchronization. They
are not part of the voucher digest.

### Claim

```json
{
  "type": "claim",
  "channelId": "<32-byte channel id hex>",
  "fundingOutpoint": {
    "txid": "<current covenant txid>",
    "index": 1
  },
  "activeScriptPublicKey": "<serialized active script public key hex>",
  "claimAmount": "800000",
  "voucher": {
    "covenantId": "<32-byte covenant id hex>",
    "amount": "3000000",
    "signature": "<64-byte Schnorr signature hex>"
  }
}
```

### Refund

```json
{
  "type": "refund",
  "channelId": "<32-byte channel id hex>",
  "fundingOutpoint": {
    "txid": "<current covenant txid>",
    "index": 1
  },
  "activeScriptPublicKey": "<serialized active script public key hex>",
  "covenantId": "<32-byte covenant id hex>",
  "refundAddress": "kaspatest:...",
  "refundAmount": "87490000",
  "clientSignature": "<65-byte transaction signature hex>"
}
```

## Voucher Digest

The buyer signs a lifetime cumulative ceiling `T`:

```text
sha256(
  sha256("kaspa:x402:escrow-voucher:v2") ||
  sha256(network utf8) ||
  covenantId32 ||
  T_le64
)
```

Rules:

- `voucher.covenantId` MUST equal the accepted lane's non-zero KIP-20 id;
- `voucher.amount` is lifetime `T`, not the current request charge and not an
  outpoint-local amount;
- `T` MUST be monotonic and MUST NOT reset after claim or top-up;
- `voucher.signature` is a 64-byte Schnorr signature over the raw 32-byte
  digest;
- implementations MUST NOT sign the digest's hex text or a personal-message
  hash;
- network, covenant id, and amount are verified from trusted lane state, not
  copied from untrusted payload claims.

Because the digest binds stable `covenantId` instead of an outpoint, the latest
voucher remains valid across every correctly authorized successor. An output
with the same script or address but a different id is not the same lane.

## Escrow Template

`kaspa-x402-escrow-v3` is the byte-exact stateful KIP-20 contract compiled from
the normative [SilverScript source](../contracts/kaspa-x402-escrow-v3.sil).
The accompanying [byte fixture](../contracts/fixtures/kaspa-x402-escrow-v3.json)
pins the compiler commit, source hash, fixed-width constructor layout, compiled
genesis and successor bytes, script public keys, covenant arguments, and
voucher digest. Constructor material is derived from the channel config:

```text
clientKey                  = hex_decode(clientPublicKey)
serverKey                  = hex_decode(serverPublicKey)
networkHash                = sha256(network utf8)
payoutScriptPublicKeyHash  = sha256(serialized_script_public_key(payTo))
refundScriptPublicKeyHash  = sha256(serialized_script_public_key(refundAddress))
timeoutLe                  = refundTimeoutDaa_le64
initial state S            = 0
```

The contract constructor receives `timeoutLe` as exactly eight bytes and casts
it to an integer only inside the refund path. Implementations MUST NOT use a
variable-width script-number constructor encoding: changing constructor length
would invalidate the compiled successor-script offsets.

An implementation does not need the TypeScript SDK or a SilverScript compiler
at runtime. It MAY compile the normative source with the pinned compiler, or it
MAY reproduce arbitrary redeem scripts from the fixture's
`constructorLayout`: copy `sample.genesis.redeemScript`, replace every listed
fixed-width slot at every listed byte offset, then derive the version-0 P2SH
script public key. Integer slots are signed 64-bit little-endian bytes without
an additional push prefix; `networkHash` is `sha256(utf8(network))`. The fixture
MUST be rejected if its `sourceSha256` does not match the published source.

The escrow output script is the version-0 pay-to-script-hash script derived
from the complete redeem script. Implementations MUST reconstruct the script
and state bytes; a client-provided address, hash, or script is never authority.

`S` is embedded in the redeem script. An accepted claim changes `S`, so it MUST
derive a new successor redeem script, version-0 P2SH script public key, and
corresponding address. Any stored or indexed escrow address MUST advance
atomically with `activeOutpoint`, `activeScriptPublicKey`, `V`, and `S`. A
top-up preserves `S`, so it MUST preserve the redeem script, script public key,
and escrow address while advancing the outpoint and `V`.

## Singleton Genesis

The initial accepted funding transaction establishes the KIP-20 lineage. A
verifier MUST inspect the full accepted transaction and require exactly one
transaction output: the genesis covenant output for the expected template and
channel config. That output MUST have a non-zero covenant id, state `S = 0`,
value `V` at least `minDepositSompi`, and the exact expected script public key.
The funding inputs MUST sum to `V + fee`; canonical genesis has no change
output.

Genesis verification MUST happen before the creating transaction can be pruned.
The verifier MUST durably record the transaction id, output index, covenant id,
script, value, state, and verification result. A later UTXO carrying an id does
not by itself prove that the genesis transaction was singleton or correctly
constructed.

The optional `fundingTransaction` payload field is opaque adapter evidence. The
verifier MUST obtain accepted transaction and UTXO data from a trusted Kaspa
node or chain adapter.

## Canonical Claim

The claim transaction has exactly one input and two outputs:

```text
input[0]  = current covenant head (id C, state S, value V)
output[0] = unbound provider payout, value P
output[1] = sole authorized same-id successor, state S + D, value V - D
```

The covenant arguments are:

```text
push(provider_transaction_signature_65) ||
push(client_voucher_signature_64) ||
push(T_le64) ||
push(D_le64) ||
claim_selector ||
push(redeem_script)
```

The provider transaction signature is a 64-byte Schnorr signature plus
one-byte `SIGHASH_ALL`. The voucher signature is the separate raw 64-byte
signature defined above.

The covenant MUST enforce:

```text
0 < D <= T - S
S + D <= 9223372036854775807
successor state = S + D
successor value = V - D > 0
```

It MUST also require exactly one input with id `C`, exactly one output with id
`C` authorized by that input, the expected successor index, an unbound payout
output, the configured payout script hash, and valid state transition.

Application accounting is stricter than the covenant ceiling:

```text
D <= A - S
```

The provider MAY make a partial claim. `T` and its signature remain usable for
later claims because `S` advances and the covenant checks only the remaining
authorization `T - S`.

Claim fees come from the provider payout:

```text
successor value V' = V - D
payout value    P  = D - fee
0 < P <= D
transaction fee    = D - P
```

The lane therefore records `S' = S + D`; the gross settled amount includes the
provider's payout and its claim fee. Fees MUST NOT reduce the successor below
`V - D` or silently consume uncharged buyer value.

## Canonical Top-Up

A top-up consumes the current head and creates exactly one authorized same-id
successor:

```text
current head  = id C, state S, value V
successor     = id C, state S, value V' where V' > V
```

The active covenant input MUST be input 0 and uses a client `SIGHASH_ALL`
transaction signature. At least one additional native funding input is
required. Output 0 is the sole authorized same-id successor. An optional output
1 MAY return client change only when it is unbound and its script hashes to the
configured refund script hash. The transaction MUST contain exactly one input
with id `C` and exactly one authorized output with id `C`; the change output
MUST NOT carry a covenant binding. The successor state MUST equal the input
state exactly.

Top-up changes `V` and the current outpoint. It does not change or reset `A`,
`S`, `T`, or the latest voucher proof.

## Canonical Refund

The refund transaction terminates the lane after the absolute timeout:

```text
input[0]  = current covenant head (id C, state S, value V)
output[0] = unbound configured client refund, value V - fee
```

It MUST have exactly one input with id `C`, no output with id `C`, one unbound
refund output, the configured refund script hash, a valid client
`SIGHASH_ALL` transaction signature, and a lock time satisfying the DAA refund
path. `lockTimeDaa` MUST be greater than or equal to `refundTimeoutDaa`, and
broadcast readiness requires the authoritative current DAA score to be
strictly greater than `lockTimeDaa`. The refund fee MAY reduce the client
output. A refund creates no successor and permanently closes that covenant
lineage.

## Transaction V1 Verification

Claim, top-up, and refund use native transaction version 1. Implementations
MUST preserve ordered inputs and outputs, compute budgets, output covenant
bindings, lock time, native subnetwork id, gas `0`, empty payload, and storage
mass in their language-neutral transaction projection.

Before broadcast, a builder or facilitator MUST:

1. load the authoritative current UTXO and persisted head;
2. verify its covenant id, script, value, state, and expected outpoint;
3. construct the exact singleton topology for the selected path;
4. recompute transaction id, hash, sighash, storage mass, script units, and
   compute budget under active consensus rules;
5. execute the covenant input against the configured consensus implementation.

Adapter-returned identifiers, fees, scripts, states, masses, and finality are
evidence to verify, not authority.

## Request Processing

The server MUST serialize protected work and state transitions per covenant
lane. For a `deposit-voucher` or `voucher` request it MUST:

1. validate the x402 envelope, v2 binding, channel config, and lane head;
2. recompute `channelId`, reconstruct the template, and match the persisted
   `covenantId` and current outpoint;
3. verify the latest on-chain `S` and current `V` from trusted UTXO data;
4. calculate the required ceiling
   `requiredT = max(previousT, A + PaymentRequirements.amount)`;
5. require `voucher.amount == requiredT`, verify the v2 digest and signature,
   and enforce `0 <= S <= A <= T` plus `(T - S) + R <= V`;
6. durably reserve a work attempt keyed by channel, payment identifier when
   present, and request fingerprint before invoking the protected handler;
7. execute the protected handler only when that attempt has no staged result,
   require `actualCharge <= PaymentRequirements.amount`, and durably stage the
   result plus actual charge;
8. atomically store the commitment, any payment identifier, `A' = A +
   actualCharge`, `T`, and the voucher proof, then mark the attempt applied
   before releasing the result.

If the handler fails, `A` and request commitment state MUST remain unchanged.
An already accepted genesis or top-up transition remains live and MUST remain
recorded. Protected content MUST NOT be released until both application work
and the durable payment commit succeed.

If the final payment commit fails after result staging, a retry MUST reuse the
staged result and MUST NOT invoke the handler again. There remains an
unavoidable application-side-effect window if the process crashes after a
non-repeatable handler effect but before staging its result. Such handlers MUST
provide their own idempotency or transactional outbox keyed by payment
identifier and request fingerprint.

Before a provider claim, the server MUST additionally require `0 < D <= A-S`,
not merely the covenant-level `D <= T-S`. After accepted finality it advances
the current outpoint, `V`, and `S` atomically while preserving `A`, `T`, and
the voucher signature.

## Accepted State Transitions And Crash Safety

Genesis, top-up, claim, and refund become final application state only after
the configured accepted-chain finality check. Broadcast-only or mempool-only
evidence is pending and MUST NOT release protected content or advance the
active head.

Before broadcasting a state transition, the runtime MUST durably save an
attempt containing the lane id, expected outpoint, expected state/value,
candidate transaction id, operation, and intended successor. Only one open
attempt may exist for a lane. After restart, the runtime MUST reconcile that
attempt against trusted chain evidence before retrying or reopening the prior
head. An uncertain broadcast MUST remain uncertain; it MUST NOT be converted
to an unspent assumption.

Applying an accepted attempt MUST use compare-and-set against the exact prior
`(covenantId, activeOutpoint, S, V)` snapshot. A concurrent loser refreshes the
current head and MUST NOT execute protected work using stale state.

## Commitment Identifier

A stored commitment identifies one successful paid request whose value might
not yet have moved on-chain:

```text
sha256(
  sha256("kaspa:x402:batch-commitment:v2") ||
  channelId32 ||
  covenantId32 ||
  requestFingerprint32 ||
  paymentRequirementsHash32 ||
  activeOutpointTxid32 ||
  activeOutpointIndex_le32 ||
  T_le64 ||
  sha256(voucherSignature64) ||
  actualCharge_le64 ||
  chargedCumulativeBefore_le64 ||
  chargedCumulativeAfter_le64 ||
  S_le64
)
```

`chargedCumulativeAfter` MUST equal
`chargedCumulativeBefore + actualCharge` and MUST NOT exceed `T`.

`paymentRequirementsHash32` is:

```text
sha256(
  sha256("kaspa:x402:batch-payment-requirements:v2") ||
  sha256("batch-settlement") ||
  sha256(network) ||
  sha256("KAS") ||
  amount_le64 ||
  sha256(payTo utf8) ||
  maxTimeoutSeconds_le64 ||
  sha256("kaspa-escrow-v2") ||
  sha256("kaspa-x402-escrow-v3") ||
  serverPublicKey32 ||
  minDepositSompi_le64 ||
  claimReserveSompi_le64 ||
  refundTimeoutDaa_le64
)
```

Unknown `extra` fields are excluded unless a future binding marks them
critical and defines their hash contribution.

The durable commitment record MUST include the channel id, covenant id,
request fingerprint, requirements hash, current outpoint, voucher and
signature, actual charge, `A` before and after, `S`, payment identifier when
present, and cached response metadata. An idempotent retry with the same
payment identifier and fingerprint returns the same commitment and result.

## SettlementResponse

Voucher-only success returns the commitment id in `transaction` because the
request has not necessarily caused an on-chain transaction:

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
      "covenantId": "<32-byte covenant id hex>",
      "chargedAmount": "700000",
      "channelState": {
        "channelId": "<32-byte channel id hex>",
        "covenantId": "<32-byte covenant id hex>",
        "activeOutpoint": {
          "txid": "<current covenant txid>",
          "index": 1
        },
        "activeScriptPublicKey": "<serialized script public key hex>",
        "fundingAmount": "88300000",
        "chargedCumulativeAmount": "2500000",
        "claimedCumulativeAmount": "1700000",
        "signedMaxClaimable": "3000000"
      }
    }
  }
}
```

For `deposit-voucher`, top-level `amount` remains the resource charge and
`extensions.kaspa.fundingAmount` reports the escrow funding separately.

An accepted claim returns its on-chain transaction id and the updated current
outpoint. The returned `signedMaxClaimable` remains `T`; it MUST NOT reset to
zero. An accepted refund returns its transaction id and terminal lane status.

## Corrective 402 And Recovery

A corrective `PaymentRequired` response SHOULD include
`extra.channelState`. When it asks the buyer to adopt a higher lifetime ceiling,
it MUST also include `extra.voucherState` containing `covenantId`, `amount`,
and `signature`. The client MUST verify that proof against the trusted network
and lane id before adopting it.

Corrective responses cover stale current outpoints, stale `A`/`S`/`T`, missing
local sessions, channel locks, insufficient `V`, and restart recovery. A client
MUST NOT infer the current outpoint from `covenantId` alone.

If a server loses an unclaimed voucher, it may recover from the covenant state
and a client-provided signed voucher. It cannot reconstruct application charges
or signatures from the chain. Unrecoverable off-chain charges are provider
risk.

## Trust Boundary

The covenant cryptographically enforces the lifetime ceiling `T`, stable
same-id lineage, payout destination, successor state/value, top-up state
preservation, and refund destination/timeout. It does not prove which resource
work occurred or the actual charge `A`.

The provider MUST enforce `D <= A-S`. A malicious provider that settles more
than actual outstanding charges but no more than `T-S` violates application
accounting even though the covenant may accept the transaction. Buyers should
stop signing and refund if returned cumulative charges, current head, covenant
id, or voucher proof cannot be reconciled.

## Security Requirements

Implementations MUST reject:

- unsupported x402 version, scheme, network, asset, binding, or template;
- any batch arithmetic value above signed-int64 maximum;
- invalid channel id, covenant id, key, address, script, or covenant state;
- a genesis transaction that does not contain exactly one output, the verified
  expected covenant genesis;
- a current outpoint that does not match durable state or same-id lineage;
- a voucher for another network or covenant id, a bad signature, a decreasing
  `T`, or a snapshot violating the accounting/reserve invariants;
- a claim with zero `D`, `D > T-S`, `D > A-S`, an invalid payout, fee taken
  from the successor, or a non-singleton same-id transition;
- a top-up that changes `S`, fails to increase `V`, or creates another same-id
  output;
- a refund before timeout or a refund that preserves the covenant id;
- stale or concurrent state changes and idempotency-key reuse with another
  request fingerprint;
- compute budget, storage mass, signature hash, or transaction fields that do
  not reproduce under the configured consensus implementation.

## Interoperability Evidence

Alpha.11 vectors MUST cover channel id, v2 voucher digest, structured
requirements hash, request commitment, singleton genesis, partial claim and
same-voucher reuse, top-up, refund, signed-int64 boundaries, reserve failures,
concurrent attempts, and transaction-v1 full-consensus execution.

The specification, normative SilverScript source, and language-neutral byte
fixture form the portable source of truth. The TypeScript builders and
independent Rust consensus harness are tested implementations and review
evidence; neither is required to implement this profile. Testnet-10 evidence is
alpha validation only; it is not a mainnet readiness claim.

## Local Diagnostics

Public responses use [errors.md](errors.md). Implementations MAY retain local
`invalid_kaspa_batch_*` diagnostics for template, channel, covenant, genesis,
head, voucher, accounting, balance, busy, commitment, claim, top-up, refund,
compute-budget, and crash-recovery failures, but MUST map them to the public
x402 error vocabulary on the wire.
