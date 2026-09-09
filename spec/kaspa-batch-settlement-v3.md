# Kaspa x402 Batch Settlement Binding v3

Status: Alpha.11, Testnet-10-only interoperability candidate

This document defines the active Kaspa network binding for x402 v2
`batch-settlement`.

## Summary

`batch-settlement` amortizes on-chain settlement across repeated,
fixed-price invocations. The payer funds one native KAS covenant lane, signs
the exact cumulative value of accepted invocations, and separately signs a
short-lived presentation for each request. The provider may claim part or all
of the signed cumulative value while keeping the lane open.

The v3 binding deliberately has no provider-selected post-service charge. Once
the payer presents an invocation, `accepted.amount` is its non-refundable
fixed charge. A successful HTTP response, an application error, and a
chargeable MCP `isError` result do not silently change that amount.

Alpha.11 is a clean cutover. Binding v2, escrow-v3, v2 vouchers, client-only
top-ups, and batch payloads without a v1 presentation authorization are
invalid. There is no compatibility reader, migration path, or dual runtime.

Use [exact](kaspa-exact-v2.md) for a one-shot on-chain purchase. Batch v3 is
not a post-priced or usage-metered scheme.

## Identifiers

```text
scheme       batch-settlement
binding      kaspa-escrow-v3
templateId   kaspa-x402-escrow-v4
network      kaspa:testnet-10
asset        KAS
```

`kaspa:testnet-10` is the only Alpha.11 validation target. This profile MUST
NOT be enabled on mainnet.

The signature and commitment domains are:

```text
kaspa:x402:channel:v2
kaspa:x402:escrow-voucher:v3
kaspa:x402:batch-payment-requirements:v3
kaspa:x402:batch-payment-intent:v1
kaspa:x402:batch-presentation:v1
kaspa:x402:batch-commitment:v3
```

Claim, top-up, and refund transaction inputs use Kaspa transaction-v1
`SIGHASH_ALL`. They do not introduce an application transaction-signing
domain.

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
    "binding": "kaspa-escrow-v3",
    "templateId": "kaspa-x402-escrow-v4",
    "serverPublicKey": "<32-byte x-only hex>",
    "minDepositSompi": "90000000",
    "claimReserveSompi": "2000000",
    "refundTimeoutDaa": "123456789",
    "securityContextHash": "<32-byte trusted context hash>",
    "mcpErrorChargeSompi": "1000000",
    "claimPolicy": {
      "claimWhenUnclaimedAmountExceeds": "100000000"
    }
  }
}
```

| Field | Required | Rule |
| --- | --- | --- |
| `scheme` | yes | MUST equal `batch-settlement`. |
| `network` | yes | MUST equal `kaspa:testnet-10`. |
| `amount` | yes | Fixed charge for this invocation, as positive canonical decimal sompi. |
| `asset` | yes | MUST equal `KAS`. |
| `payTo` | yes | Provider payout address; it is not the lane address. |
| `maxTimeoutSeconds` | yes | Maximum presentation lifetime in seconds. |
| `extra.binding` | yes | MUST equal `kaspa-escrow-v3`. |
| `extra.templateId` | yes | MUST equal `kaspa-x402-escrow-v4`. |
| `extra.serverPublicKey` | yes | Provider claim and top-up co-authorization key. |
| `extra.minDepositSompi` | yes | Minimum initial covenant value. |
| `extra.claimReserveSompi` | yes | Required value beyond remaining authorization. |
| `extra.refundTimeoutDaa` | yes | Absolute DAA score for unilateral refund. |
| `extra.securityContextHash` | yes | Hash of the host-derived principal, tenant, authorization scope, and other handler-relevant context. |
| `extra.mcpErrorChargeSompi` | MCP only | Required for MCP and MUST equal `amount`. |
| `extra.claimPolicy` | no | Non-authorizing provider claim timing policy. |
| `extra.channelState` | no | Corrective current lane snapshot; it MUST NOT disclose a reusable voucher signature. |

`amount` is not a maximum and cannot be lowered after service. The payer
signs a cumulative value that increases by exactly this amount. A provider
that wants post-priced, discounted, success-only, or zero-on-error semantics
must use a different protocol with a payer-authenticated post-service amount.

For MCP, `mcpErrorChargeSompi` makes the error outcome explicit before the
payer authorizes the invocation. Its only valid v3 value is `amount`; a
missing, zero, or lower value cannot authorize a paid `isError` result.
Implementations MUST reject an MCP batch offer without this equality rather
than silently defaulting the error charge.

All monetary and covenant-state values are in
`0..9223372036854775807`. Values used as charges, funding, reserve, or
authorization MUST be positive where stated. Implementations MUST reject an
out-of-range value before hashing, adding, signing, or building a transaction.

`minDepositSompi` MUST be at least `amount + claimReserveSompi`. The sum
must remain in range. `refundTimeoutDaa` MUST remain below
`500000000000`, where Kaspa lock time changes to timestamp interpretation.

### Accepted requirements hash

`acceptedRequirementsHash` is SHA-256 over the UTF-8 canonical JSON encoding
of:

```json
{
  "scope": "kaspa:x402:batch-payment-requirements:v3",
  "accepted": "<the complete selected PaymentRequirements object>"
}
```

Canonical JSON sorts object keys in ascending UTF-16 code-unit order, retains
array order, uses compact JSON primitives, and rejects undefined, non-finite,
cyclic, or non-JSON values. All fields, including recognized and unknown
extension fields, are included. A parser MUST validate the selected binding
before hashing it.

## Payer-Controlled Batch Authorization

Protocol validity is not payer consent. Every client MUST expose a mandatory
`authorizeBatchPayment` boundary owned by the payer or wallet. It is invoked
for a new channel, every fixed-charge voucher increase, and every top-up
before key generation, preparation, persistence, signing, or broadcast.
Absence, rejection, or ambiguity fails closed.

The authorizer receives this complete immutable intent:

```json
{
  "scope": "kaspa:x402:batch-payment-intent:v1",
  "operation": "open|charge|top-up",
  "origin": "https://api.example",
  "resource": "https://api.example/report",
  "network": "kaspa:testnet-10",
  "asset": "KAS",
  "payTo": "kaspatest:...",
  "serverPublicKey": "<32-byte x-only hex>",
  "clientPublicKey": "<32-byte x-only hex or null before approved key creation>",
  "requestFingerprint": "<32-byte hash>",
  "acceptedRequirementsHash": "<32-byte hash>",
  "securityContextHash": "<32-byte hash>",
  "fixedChargeSompi": "1000000",
  "mcpErrorChargeSompi": "1000000 or null",
  "authorizedCumulativeBefore": "2000000",
  "authorizedCumulativeAfter": "3000000",
  "claimedCumulativeAmount": "1700000",
  "initialDepositSompi": "0",
  "currentFundingSompi": "88300000",
  "topUpSompi": "0",
  "resultingFundingSompi": "88300000",
  "resultingExposureSompi": "90000000",
  "claimReserveSompi": "2000000",
  "refundTimeoutDaa": "123456789",
  "authoritativeCurrentDaa": "123450000",
  "refundDistanceDaa": "6789",
  "fundingSource": "external-wallet-adapter",
  "channelId": "<32-byte hash or null>",
  "covenantId": "<32-byte non-zero hash or null>",
  "paymentIdentifier": "request-123 or null"
}
```

For `open`, `initialDepositSompi` is the new lane value,
`currentFundingSompi` and `topUpSompi` are zero, and the channel/covenant
ids may be null until deterministic key/config construction is explicitly
approved. For an existing lane, `initialDepositSompi` is zero. For
`top-up`, `topUpSompi = resultingFundingSompi - currentFundingSompi`.
`resultingExposureSompi` is
`claimedCumulativeAmount + resultingFundingSompi`; it prevents repeated
top-ups after claims from bypassing a current-balance cap.

Before invoking the authorizer, the payer implementation MUST enforce a
complete payer-owned policy containing:

- `maximumBatchChargeSompi`;
- `maximumInitialDepositSompi`;
- `maximumTopUpSompi`;
- `maximumCumulativeAuthorizationSompi`;
- `maximumTotalExposureSompi`;
- `minimumRefundLeadDaa`;
- `maximumRefundHorizonDaa`;
- allowed origins, resources, payees, server keys, and funding sources.

Every maximum is inclusive except the maximum refund horizon, which is an
exclusive upper bound. All fields are mandatory for unattended operation.
An interactive wallet MAY apply stricter limits but cannot omit the intent.

The client MUST obtain `authoritativeCurrentDaa` from a trusted Kaspa node or
configured chain adapter, not from payment requirements or peer metadata. It
then calculates, without unsigned overflow:

```text
refundDistanceDaa = refundTimeoutDaa - authoritativeCurrentDaa
minimumRefundLeadDaa <= refundDistanceDaa < maximumRefundHorizonDaa
```

If current DAA is unavailable, the timeout is not in the future, or either
bound fails, authorization stops before wallet or signer work. The check is
repeated for every top-up and voucher increase.

The canonical intent digest is SHA-256 over canonical JSON of the complete
object above. Any approval evidence MUST bind that digest. An approval for
one operation, request, funding source, amount, or deadline is invalid after
any field changes.

## Channel Config And Identity

```json
{
  "network": "kaspa:testnet-10",
  "asset": "KAS",
  "templateId": "kaspa-x402-escrow-v4",
  "clientPublicKey": "<32-byte x-only hex>",
  "serverPublicKey": "<32-byte x-only hex>",
  "payTo": "kaspatest:...",
  "refundAddress": "kaspatest:...",
  "refundTimeoutDaa": "123456789",
  "salt": "<32-byte hex>"
}
```

`channelId` is:

```text
sha256(
  sha256("kaspa:x402:channel:v2") ||
  sha256(network utf8) ||
  sha256("KAS") ||
  sha256(templateId utf8) ||
  clientPublicKey32 ||
  serverPublicKey32 ||
  sha256(payTo utf8) ||
  sha256(refundAddress utf8) ||
  refundTimeoutDaa_le64 ||
  salt32
)
```

Strings are UTF-8 before hashing. Integers are unsigned little-endian.
`channelId` identifies application configuration. `covenantId` identifies
the on-chain KIP-20 lineage. They are different values, and neither locates
the current UTXO.

## Lifetime Accounting

The only charge variable is the payer-authenticated cumulative value:

| Symbol | Wire value | Meaning |
| --- | --- | --- |
| `S` | `claimedCumulativeAmount` and covenant state | Lifetime gross value removed on-chain, including claim fees. |
| `T` | `authorizedCumulativeAmount` and voucher value | Exact sum of fixed charges the payer has authorized. |
| `V` | `fundingAmount` | Current active covenant UTXO value. |
| `R` | `claimReserveSompi` | Required value beyond remaining authorization. |

Every accepted snapshot satisfies:

```text
0 <= S <= T <= 9223372036854775807
(T - S) + R <= V
```

For a new non-retry invocation:

```text
T_after = T_before + accepted.amount
```

An identical retry reuses the same presentation, voucher, fixed charge,
commitment, and cached result; it does not add the amount again. Claims and
top-ups do not reset `S` or `T`.

`R` is funding safety margin, not provider entitlement. Claim fees are
deducted from the provider payout and do not change `T`.

## Channel State

```json
{
  "channelId": "<32-byte channel id>",
  "covenantId": "<32-byte KIP-20 covenant id>",
  "activeOutpoint": { "txid": "<current txid>", "index": 1 },
  "activeScriptPublicKey": "<serialized script public key>",
  "fundingAmount": "88300000",
  "authorizedCumulativeAmount": "3000000",
  "claimedCumulativeAmount": "1700000"
}
```

Runtimes MUST persist and atomically advance the active outpoint, script,
value, state, and covenant id. Standard RPC does not provide a
covenant-id-to-UTXO reverse index. Recovery must verify unique same-id
transaction lineage before adopting a successor.

Corrective public responses MAY include this snapshot but MUST NOT include a
reusable voucher signature. Reusable voucher disclosure requires separate
payer authentication outside this wire profile.

## Chain Truth, Confirmation, And Recovery

Peers and adapters do not choose semantic finality. Trusted accepted evidence
contains the transaction id, accepting-block hash and blue score, numeric
confirmation count, and a stable selected-chain checkpoint (sink block hash,
blue score, and DAA score). The confirmation count is the authoritative
selected-parent distance from the selected-chain tip, including the accepting
block. Blue-score difference MUST NOT be used as selected-chain depth.

The runtime applies deployment policy to that count. Alpha.11's reference
`kaspa:testnet-10` deployment requires 30 confirmations for covenant genesis,
claim, top-up, refund, and recovered lineage. This is not a universal Kaspa
consensus-finality constant. Accepted evidence below the threshold remains
reserved and cannot authorize a state transition.

The reference adapter proves the threshold through
`GetVirtualChainFromBlockV2` with `minConfirmationCount`. A stable REST UTXO and
selected-chain accepting block prove only a conservative lower bound of one;
REST evidence alone cannot authorize 30-confirmation batch lineage.

`absent` means the exact transaction is permanently excluded by either a
distinct confirmed spend of its input or stable consensus-rejection evidence.
A missing index entry, UTXO observation, timeout, transport error, or pruned
history is `unknown`; it never permits rebuilding or reusing the captured head.

Each lane begins with an immutable launch manifest containing:

- network, checked compiler commit and command, source path and SHA-256;
- template id, compiled-base SHA-256, ABI, and selectors; and
- genesis derivation, covenant id, authorizing input, transaction, outpoint,
  script, value, state, accepting block, confirmation evidence, and checkpoint.

Every later accepted claim, top-up, or refund is appended to a durable journal
with its consumed outpoint, transaction, unique successor or terminal output,
state, value, covenant binding, accepting block, confirmation evidence, and
checkpoint. The current head is derived atomically from this manifest and
journal; an adapter-supplied head is never authority.

An observer resumes from the durable checkpoint using a complete selected-chain
delta. Removed blocks MUST be processed and journaled before added blocks. All
affected derived state is rolled back first; replacement transactions may then
extend only the restored head. Missing or ambiguous predecessors, multiple
spends or successors, wrong covenant/template bindings, and inconsistent state
or value changes fail closed. If pruning prevents continuity proof, the lane is
unavailable until an authoritative complete history can be supplied.

Clients and servers reconcile this lineage before lane reuse, top-up, claim,
retirement, or refund. A suspicious client lane may become `refundable` after
its unique live head is verified, but it MUST NOT become chargeable again. If a
confirmed terminal refund is removed, its applied attempt and terminal status
roll back atomically to refund-only state before another refund can be built.
An implementation MUST NOT advertise or select `batch-settlement` unless this
authoritative lineage-discovery capability is configured.

## Voucher

```json
{
  "covenantId": "<32-byte non-zero covenant id>",
  "authorizedCumulativeAmount": "3000000",
  "signature": "<64-byte Schnorr signature>"
}
```

The payer signs:

```text
sha256(
  sha256("kaspa:x402:escrow-voucher:v3") ||
  sha256(network utf8) ||
  covenantId32 ||
  T_le64
)
```

The signature is raw 64-byte Schnorr over the raw 32-byte digest. `T` is
lifetime cumulative authorization. It MUST equal the previous authorized
value plus the fixed amount for a new request and MUST NOT decrease or reset.
Network, covenant id, and previous `T` come from trusted lane state.

The voucher is intentionally reusable on-chain across same-id successors. It
does not authorize a request; that is the presentation's job.

## Request Presentation Authorization

Every `deposit-voucher` and `voucher` payment payload includes:

```json
{
  "version": "kaspa-x402-batch-presentation-v1",
  "requestFingerprint": "<32-byte canonical HTTP or MCP fingerprint>",
  "acceptedRequirementsHash": "<32-byte hash>",
  "securityContextHash": "<32-byte trusted context hash>",
  "channelId": "<32-byte channel id>",
  "covenantId": "<32-byte non-zero covenant id>",
  "voucherDigest": "<32-byte v3 voucher digest>",
  "paymentIdentifier": "request-123 or null",
  "nonce": "<32-byte unique nonce>",
  "expiresAt": "2026-09-09T02:00:00.000Z",
  "digest": "<32-byte presentation digest>",
  "signature": "<64-byte Schnorr signature>"
}
```

To compute `digest`, canonical-JSON serialize and SHA-256 this object without
`digest` and `signature`:

```json
{
  "scope": "kaspa:x402:batch-presentation:v1",
  "requestFingerprint": "<lowercase hash>",
  "acceptedRequirementsHash": "<lowercase hash>",
  "securityContextHash": "<lowercase hash>",
  "channelId": "<lowercase hash>",
  "covenantId": "<lowercase non-zero hash>",
  "voucherDigest": "<lowercase hash>",
  "paymentIdentifier": "request-123 or null",
  "nonce": "<lowercase hash>",
  "expiresAt": "2026-09-09T02:00:00.000Z"
}
```

The channel client key signs the raw digest. The verifier independently
computes the request fingerprint, accepted-requirements hash, trusted security
context hash, channel id, covenant id, and voucher digest. Payload copies are
evidence only.

`expiresAt` MUST be strictly after the verification clock and no later than
`now + accepted.maxTimeoutSeconds`. Expiry is rechecked after awaited
verification and immediately before protected work. An expired presentation
may identify an already committed identical retry but cannot create new work
or authorization.

`nonce` is unique per logical request. `paymentIdentifier` is the validated
x402 identifier or explicit `null`; both fields are signed. The server
durably consumes the presentation digest with the request fingerprint.
Changed request, requirements, security context, channel, covenant, voucher,
identifier, nonce, or expiry fails before protected work.

## PaymentPayload

The request-bearing discriminators are `deposit-voucher` and `voucher`.
`claim` and `refund` remain operation payloads.

A deposit or accepted top-up successor uses:

```json
{
  "type": "deposit-voucher",
  "channelConfig": { "...": "v4 config" },
  "channelId": "<32-byte channel id>",
  "escrowAddress": "kaspatest:...",
  "fundingTransaction": "<optional opaque transaction evidence>",
  "fundingOutpoint": { "txid": "<current txid>", "index": 0 },
  "fundingAmountSompi": "90000000",
  "activeScriptPublicKey": "<serialized active script public key>",
  "voucher": {
    "covenantId": "<32-byte covenant id>",
    "authorizedCumulativeAmount": "1000000",
    "signature": "<64-byte signature>"
  },
  "presentation": { "...": "v1 presentation" }
}
```

An existing lane uses:

```json
{
  "type": "voucher",
  "channelId": "<32-byte channel id>",
  "clientPublicKey": "<32-byte x-only key>",
  "fundingOutpoint": { "txid": "<current txid>", "index": 1 },
  "activeScriptPublicKey": "<serialized active script public key>",
  "voucher": {
    "covenantId": "<32-byte covenant id>",
    "authorizedCumulativeAmount": "3000000",
    "signature": "<64-byte signature>"
  },
  "presentation": { "...": "v1 presentation" }
}
```

Outpoints and scripts synchronize the head but are not voucher or
presentation authority. A verifier obtains authoritative UTXO and lineage
facts independently.

## Escrow-v4 Template

`kaspa-x402-escrow-v4` is the byte-exact stateful KIP-20 contract compiled
from the normative SilverScript source and pinned by its language-neutral byte
fixture. Constructor material is:

```text
clientKey                  = hex_decode(clientPublicKey)
serverKey                  = hex_decode(serverPublicKey)
networkHash                = sha256(network utf8)
payoutScriptPublicKeyHash  = sha256(serialized_script_public_key(payTo))
refundScriptPublicKeyHash  = sha256(serialized_script_public_key(refundAddress))
timeoutLe                  = refundTimeoutDaa_le64
initial state S            = 0
```

`timeoutLe` is exactly eight bytes. Implementations reconstruct and verify
the full redeem script and version-0 P2SH script public key. Client-provided
addresses, hashes, scripts, and compiler output are never authority.

An accepted claim advances embedded state `S` and changes the successor
script/address. A top-up preserves state and script but advances outpoint and
value.

### Singleton genesis

The accepted genesis transaction has exactly one output: the expected v4
covenant with non-zero id, state `S = 0`, and value at least
`minDepositSompi`. Inputs equal escrow value plus fee. The complete
transaction must be verified and recorded before it can be pruned.

### Claim

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

The covenant enforces:

```text
0 < D <= T - S
successor state = S + D
successor value = V - D > 0
0 < P <= D
fee = D - P
```

It also enforces one same-id input and successor, the configured payout script
hash, fixed output positions, and provider `SIGHASH_ALL`. Because `T` is
the exact sum of payer-approved fixed charges, a direct provider claim cannot
exceed those charges.

### Provider-co-authorized top-up

```text
input[0]  = current covenant head (id C, state S, value V)
input[1+] = payer funding inputs
output[0] = sole authorized same-id successor, state S, value V' > V
output[1] = optional unbound configured payer change
```

The active covenant input arguments are:

```text
push(client_transaction_signature_65) ||
push(provider_transaction_signature_65) ||
top_up_selector ||
push(redeem_script)
```

Both signatures MUST use `SIGHASH_ALL` and validate against the configured
client and provider keys. Each therefore covers the complete ordered inputs,
UTXO commitments, outputs, covenant bindings, values, scripts, lock time,
subnetwork, gas, payload, mass, and compute commitments defined by Kaspa's
transaction-v1 sighash.

The provider MUST derive the sighash from the fully populated intended
transaction after verifying the authoritative current head, exact singleton
successor, unchanged state/script, increased value, optional configured change,
fee, and funding inputs. It MUST NOT sign a digest or transaction summary
supplied by the client without reproducing it.

A client signature alone cannot satisfy escrow-v4. The provider signature is
not optional, substitutable by a voucher, or reusable after any transaction
field changes.

### Refund

After `refundTimeoutDaa`, one client `SIGHASH_ALL` input terminates the
lineage and pays the configured unbound refund script. No same-id successor is
allowed. Refund readiness uses authoritative current DAA and requires it to be
strictly greater than the transaction lock time.

## Transaction-v1 Verification

Before broadcast, a builder or facilitator:

1. loads the authoritative current UTXO and persisted head;
2. verifies its id, script, value, state, and outpoint;
3. constructs the exact singleton topology;
4. recomputes transaction id, hash, every sighash, storage mass, script units,
   and compute budget under active consensus rules;
5. executes the covenant input against the pinned consensus implementation.

Adapter-returned identifiers, fees, scripts, states, masses, and finality are
evidence to verify, not authority.

## Request Processing

For a new batch invocation, implementations perform:

1. bounded side-effect-free envelope, extension, identifier, binding, and
   accepted-requirements validation;
2. authoritative current DAA lookup and payer policy checks;
3. mandatory approval of the complete payer intent;
4. any approved genesis or provider-co-signed top-up transition;
5. calculation of `T_after = T_before + accepted.amount`;
6. v3 voucher and v1 presentation signing;
7. server verification and durable consumption of the presentation;
8. protected handler execution;
9. atomic persistence of `T_after`, the voucher proof, fixed charge,
   commitment, identifier, and bounded result before release.

An identical retry resumes the same durable attempt and result. A changed
fingerprint, requirements hash, context, payment identifier, or presentation
cannot enter the handler.

The fixed charge is committed when the protected invocation is admitted. The
provider MUST NOT record or return a lower actual charge based on handler
output. An MCP `isError` result is chargeable only under the explicit equal
`mcpErrorChargeSompi` term.

## Commitment

The durable request commitment is:

```text
sha256(
  sha256("kaspa:x402:batch-commitment:v3") ||
  channelId32 ||
  covenantId32 ||
  presentationDigest32 ||
  requestFingerprint32 ||
  acceptedRequirementsHash32 ||
  activeOutpointTxid32 ||
  activeOutpointIndex_le32 ||
  authorizedCumulativeBefore_le64 ||
  authorizedCumulativeAfter_le64 ||
  sha256(voucherSignature64) ||
  fixedCharge_le64 ||
  S_le64
)
```

`authorizedCumulativeAfter` MUST equal
`authorizedCumulativeBefore + fixedCharge` and the voucher must sign that
same after-value. The record includes all preimage fields, voucher and
presentation proofs, payment identifier, and cached response metadata.

## SettlementResponse

Voucher-only success uses the commitment id in `transaction`. Top-level
`amount` and `extensions.kaspa.chargedAmount` both equal
`accepted.amount`:

```json
{
  "success": true,
  "transaction": "<commitment id>",
  "network": "kaspa:testnet-10",
  "amount": "1000000",
  "extensions": {
    "kaspa": {
      "commitmentId": "<commitment id>",
      "covenantId": "<covenant id>",
      "chargedAmount": "1000000",
      "channelState": { "...": "current v3 state" }
    }
  }
}
```

For `deposit-voucher`, `fundingAmount` reports escrow principal separately.
Claims and refunds return their independently recomputed transaction ids.

## Trust Boundary

The covenant enforces the payer-signed cumulative fixed-charge total, payout
destination, singleton same-id lineage, provider-co-signed top-ups, state and
value transitions, and refund destination/timeout. The presentation proves
that the channel key authorized one request context. The payer-controlled
intent gates wallet and funding side effects.

The covenant does not prove that off-chain service was delivered. Like exact
payment, a signed non-refundable fixed charge trusts the provider for delivery.
This profile makes that economic meaning explicit and does not claim a
provider-local lower charge that the covenant cannot enforce.

## Fail-Closed Cutover And Evidence

Implementations MUST reject:

- binding `kaspa-escrow-v2`, template `kaspa-x402-escrow-v3`, the v2
  voucher domain, and the v1 channel domain;
- voucher objects using legacy `amount` instead of
  `authorizedCumulativeAmount`;
- request payloads without a complete valid v1 presentation;
- provider-local lower or zero post-service charge fields;
- an MCP error charge absent from terms, unequal to `amount`, or absent from
  the approved payer intent;
- a payer intent with any absent cap, unapproved source, or stale/unavailable
  authoritative DAA evidence;
- a claim above `T-S`;
- a top-up without both valid full-transaction signatures;
- old ABI selectors, redeem scripts, fixtures, or vectors.

Interop evidence covers the v2 channel id, v3 voucher, payer intent,
presentation, requirements hash, fixed-charge commitment, singleton genesis,
partial/direct claims, provider-co-signed top-up, refund, old-domain rejection,
client-only top-up rejection, and positive/negative execution against the
pinned Rusty-Kaspa consensus checkout.

Testnet-10 or local consensus evidence is alpha validation only. It is not
mainnet or production proof.
