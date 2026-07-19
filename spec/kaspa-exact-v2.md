# Kaspa x402 Exact Binding v2

Status: post-alpha.8 interoperability draft

This document defines the Kaspa network binding for x402 v2 `exact`. It
supersedes `kaspa-exact-v1` for new implementations while preserving the v1
document and immutable alpha.7 release evidence as historical records.

## Summary

`exact` is for a fixed-price one-shot purchase. The merchant knows the price
before protected work begins, and successful settlement transfers precisely
that advertised amount of native KAS.

This binding defines two profiles:

| Profile           | Status   | Payment                                                                      |
| ----------------- | -------- | ---------------------------------------------------------------------------- |
| `standard-native` | default  | One standard native-KAS merchant output equals the advertised amount.        |
| `additive`        | optional | A merchant KIP-10 head successor increases by exactly the advertised amount. |

Use `batch-settlement` instead for repeated or variable-cost requests where
off-chain cumulative vouchers should amortize on-chain settlement.

## Identifiers

Every v2 exact requirement uses:

```json
{
  "scheme": "exact",
  "network": "kaspa:testnet-10",
  "asset": "KAS",
  "extra": {
    "binding": "kaspa-exact-v2",
    "profile": "standard-native"
  }
}
```

Recognized draft network identifiers are:

```text
kaspa:mainnet
kaspa:testnet-10
```

The `kaspa` CAIP namespace is proposed, not registered. `kaspa:testnet-10` is
the alpha.8 validation target. `kaspa:mainnet` is a reserved profile name and
does not imply mainnet, custody, or production readiness.

The binding settles native KAS only.

## Common PaymentRequirements

Both profiles include:

```json
{
  "scheme": "exact",
  "network": "kaspa:testnet-10",
  "amount": "20000000",
  "asset": "KAS",
  "payTo": "kaspatest:...",
  "maxTimeoutSeconds": 60,
  "extra": {
    "binding": "kaspa-exact-v2",
    "profile": "standard-native",
    "finality": "accepted",
    "transactionEncoding": "kaspa-sdk-safe-json-v2.0.0",
    "payToScriptPublicKey": "0000..."
  }
}
```

| Field                        | Rule                                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| `scheme`                     | MUST equal `exact`.                                                                                |
| `network`                    | MUST be one of the recognized Kaspa network identifiers.                                           |
| `amount`                     | MUST be a canonical positive uint64 sompi string. It is the entire merchant gain for this request. |
| `asset`                      | MUST equal `KAS`.                                                                                  |
| `payTo`                      | MUST be a valid recipient address for `network`.                                                   |
| `maxTimeoutSeconds`          | MUST be a positive uint32. It bounds payment authorization validity as defined under Expiry.       |
| `extra.binding`              | MUST equal `kaspa-exact-v2`.                                                                       |
| `extra.profile`              | MUST equal `standard-native` or `additive`.                                                        |
| `extra.finality`             | MUST equal `accepted` or `confirmed` in the reference alpha. A stricter server policy is allowed.  |
| `extra.transactionEncoding`  | MUST equal `kaspa-sdk-safe-json-v2.0.0` in this draft.                                             |
| `extra.payToScriptPublicKey` | MUST be the canonical serialized script public key derived independently from `payTo`.             |

`mempool` is not sufficient hosted settlement finality for this alpha. It may
remain an internal diagnostic state, but a successful protected request MUST
use `accepted` or stronger finality.

Kaspa storage mass depends on the complete populated transaction. This binding
does not define a universal `10000000` sompi dust or payment floor. A client or
operator MAY enforce a local minimum and MUST label it as application policy.

## Standard-native profile

### Requirements

The common requirements are complete when:

```json
{
  "extra": {
    "binding": "kaspa-exact-v2",
    "profile": "standard-native",
    "finality": "accepted",
    "transactionEncoding": "kaspa-sdk-safe-json-v2.0.0",
    "payToScriptPublicKey": "0000..."
  }
}
```

Additive head or challenge fields MUST be absent.

### Canonical transaction

The reference alpha uses a version-0 native Kaspa transaction:

```text
input[0+] = payer standard Schnorr P2PK funding inputs

output[paymentOutputIndex] = merchant payTo script, value = amount
one other output optional  = payer change
```

The transaction MUST:

- contain at least one payer input;
- spend only standard Schnorr P2PK inputs in this alpha;
- contain exactly one output whose script equals `payToScriptPublicKey`;
- give that merchant output exactly `PaymentRequirements.amount`;
- contain at most one other output;
- return any other output to a script public key controlled by a verified payer
  input;
- have a non-negative fee no greater than client and verifier policy;
- use version 0, the native subnetwork, zero gas, zero lock time, an empty
  payload, and no output covenants;
- use the version-0 input mass field variant and no version-1 compute budget;
- commit the contextual storage mass required by the active consensus rules;
- satisfy current isolation, populated-transaction, mass, and txscript
  validation.

The client pays `amount + fee` and receives any change. The merchant receives
exactly `amount`.

## Additive profile

### Relationship to KIP-10

KIP-10 introduces transaction introspection opcodes. It does not define this
x402 wire profile, recipient binding, exact-price equality, challenge state,
fee limits, replay policy, or reconciliation. This document defines those
application rules.

### Requirements

An additive offer includes:

```json
{
  "scheme": "exact",
  "network": "kaspa:testnet-10",
  "amount": "20000000",
  "asset": "KAS",
  "payTo": "kaspatest:<head-p2sh-address>",
  "maxTimeoutSeconds": 60,
  "extra": {
    "binding": "kaspa-exact-v2",
    "profile": "additive",
    "finality": "accepted",
    "transactionEncoding": "kaspa-sdk-safe-json-v2.0.0",
    "payToScriptPublicKey": "<head serialized P2SH script public key>",
    "templateId": "kaspa-x402-kip10-additive-v1",
    "headId": "<stable merchant head id>",
    "headVersion": "7",
    "expectedHeadOutpoint": {
      "txid": "<current head transaction id>",
      "index": 0
    },
    "headAmount": "100000000",
    "headScriptPublicKey": "<same serialized P2SH script public key>",
    "headRedeemScript": "<canonical KIP-10 additive redeem script>",
    "additiveThresholdSompi": "10000000",
    "challengeId": "<unique 32-byte challenge id>",
    "challengeExpiresAt": "2026-07-14T09:00:00.000Z"
  }
}
```

| Field                          | Rule                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `extra.templateId`             | MUST equal `kaspa-x402-kip10-additive-v1`.                                                                         |
| `extra.headId`                 | MUST be a stable server-scoped 32-byte identifier for one additive chain.                                          |
| `extra.headVersion`            | MUST be a canonical uint64 string that increases for every accepted successor.                                     |
| `extra.expectedHeadOutpoint`   | MUST be the exact current unspent head.                                                                            |
| `extra.headAmount`             | MUST equal the trusted amount of the expected head.                                                                |
| `extra.headScriptPublicKey`    | MUST equal `payToScriptPublicKey` and the P2SH script derived from `headRedeemScript`.                             |
| `extra.headRedeemScript`       | MUST be the canonical additive script for the advertised owner key and threshold.                                  |
| `extra.additiveThresholdSompi` | MUST be a positive canonical uint64 application minimum.                                                           |
| `extra.challengeId`            | MUST identify the server-issued terms and normalized request fingerprint. It is not an exclusive head reservation. |
| `extra.challengeExpiresAt`     | MUST be a valid future ISO-8601 timestamp when the paid retry is verified.                                         |

`amount` MUST be greater than or equal to `additiveThresholdSompi`. The
threshold is an anti-churn minimum, not an additional merchant payment.

`payTo` MUST encode the head P2SH script. This makes the exact successor delta
the value transferred to the advertised merchant recipient.

### Canonical transaction

The reference alpha uses a version-1 native transaction:

```text
input[0]  = expected current merchant KIP-10 head
input[1+] = payer standard Schnorr P2PK funding inputs

output[0] = successor head:
            same script as input[0]
            value = headAmount + amount

output[1] = optional payer change
```

The transaction MUST:

- spend `expectedHeadOutpoint` at input index 0;
- match its trusted UTXO amount and script to `headAmount` and
  `headScriptPublicKey`;
- select the borrower branch of the canonical `headRedeemScript`;
- recreate the same script at output index 0;
- set output 0 to exactly `headAmount + amount`;
- contain no separate merchant payment output;
- contain one or more standard Schnorr P2PK funding inputs after the head input;
- contain at most one other output, which returns payer change to a script
  controlled by a verified payer input;
- have total payer funding equal to `amount + fee + payer change`;
- have a non-negative fee no greater than client and verifier policy;
- use version 1, the native subnetwork, zero gas, zero lock time, an empty
  payload, and no output covenants;
- commit the smallest compute budget that covers measured script units for each
  input, subject to consensus rounding and minimums;
- commit the contextual storage mass required by the active consensus rules;
- satisfy current isolation, populated-transaction, mass, and txscript
  validation.

KIP-10 enforces a lower-bound successor increase. The x402 verifier MUST enforce
the exact equality above. A larger successor delta is an overpayment and MUST
be rejected.

The merchant receives exactly `amount` through the successor increase. The
payer spends exactly `amount + fee`. The previous alpha.7 construction that
combined a threshold top-up with a separate merchant output is not valid under
this binding.

## Transaction interchange and identifiers

### `kaspa-sdk-safe-json-v2.0.0`

`PaymentPayload.payload.transaction` is a UTF-8 JSON string containing this
bounded transaction projection:

```json
{
  "id": "<32-byte transaction id hex>",
  "version": 0,
  "inputs": [
    {
      "previousOutpoint": { "transactionId": "<32-byte hex>", "index": 0 },
      "sequence": "18446744073709551615",
      "sigOpCount": 1,
      "signatureScript": "<hex>",
      "utxo": { "amount": "50000000", "scriptPublicKey": "<serialized hex>" }
    }
  ],
  "outputs": [
    {
      "value": "20000000",
      "scriptPublicKey": "<serialized hex>",
      "covenant": null
    }
  ],
  "lockTime": "0",
  "subnetworkId": "0000000000000000000000000000000000000000",
  "gas": "0",
  "payload": "",
  "storageMass": "63557"
}
```

Version 1 inputs replace the version-0 `sigOpCount` commitment with the
`computeBudget` field required by consensus. The safe projection carries
`sigOpCount: 0` for those inputs because the JSON source type exposes both
fields. Verifiers MUST use `computeBudget` for version 1 and MUST NOT interpret
that zero as a version-0 sigop commitment.

Rules:

- uint64 values are canonical decimal strings;
- `version`, outpoint `index`, `sigOpCount`, and `computeBudget` are JSON
  integers in their consensus ranges;
- byte data and hashes are even-length hex and are normalized to lowercase;
- `scriptPublicKey` is the two-byte big-endian script version followed by the
  script bytes;
- every output includes `covenant`, which MUST be `null` in this binding;
- embedded UTXO data is required for deterministic hashing and signature
  preflight but MUST match trusted chain data before acceptance;
- object-key order and insignificant JSON whitespace do not affect a
  transaction identifier;
- unknown JSON properties do not enter the consensus transaction projection
  and MAY be rejected by an implementation;
- omitted `lockTime`, `subnetworkId`, `gas`, and `payload` normalize to the
  zero or empty values shown above; `storageMass` is mandatory for both exact
  profiles.

The transaction identifier is computed from the normalized consensus fields,
not by hashing the JSON string.

### Integer and byte serialization

The identifier preimages use the Rusty Kaspa consensus encoding:

- integers are unsigned little-endian;
- transaction version and script version are uint16;
- outpoint index is uint32;
- values, sequences, gas, lock time, counts, and byte lengths are uint64;
- a variable byte string is `uint64_length || bytes`;
- an outpoint is the 32 transaction-id bytes followed by its uint32 index;
- an output is uint64 value, uint16 script version, and variable script bytes;
- version 1 outputs additionally append one byte indicating covenant presence,
  followed by its binding only when present.

### Version 0 transaction id

For `standard-native`, construct this preimage:

```text
u16(version)
u64(input count)
for each input:
  outpoint
  varbytes(empty signature script)
  u64(sequence)
u64(output count)
for each output:
  output
u64(lock time)
20-byte subnetwork id
u64(gas)
varbytes(payload)
```

The version-0 transaction id is BLAKE2b-256 keyed by the UTF-8 bytes
`TransactionID` over that preimage. It excludes signature scripts, sigop
counts, and storage mass.

### Version 1 transaction id

For `additive`:

1. `payloadDigest` is keyed BLAKE3-256 with domain `PayloadDigest` over the raw
   payload bytes.
2. `restPreimage` uses the transaction serialization above with signature
   scripts and payload replaced by empty byte strings and with compute budgets
   and storage mass omitted.
3. `restDigest` is keyed BLAKE3-256 with domain `TransactionRest` over
   `restPreimage`.
4. The transaction-id preimage is `payloadDigest || restDigest`.
5. The transaction id is keyed BLAKE3-256 with domain `TransactionV1Id` over
   that 64-byte preimage.

For these BLAKE3 hashes, the 32-byte key is the ASCII domain copied into a
zero-filled 32-byte array. The BLAKE2b domain is the native variable-length
key. `vectors/exact/interop-v1.json` carries the complete preimages and digests
for both profiles. The same transactions are independently constructed and
validated by the pinned Rust consensus harness.

## PaymentPayload

Both profiles use one bounded transaction-artifact envelope:

```json
{
  "x402Version": 2,
  "accepted": { "...": "the selected exact requirements" },
  "payload": {
    "type": "exact-transaction",
    "profile": "standard-native",
    "payerAddress": "kaspatest:...",
    "transaction": "<signed bounded safe transaction JSON>",
    "transactionEncoding": "kaspa-sdk-safe-json-v2.0.0",
    "paymentOutputIndex": 0,
    "requestHash": "<normalized request hash>",
    "authorization": {
      "version": "kaspa-x402-exact-request-authorization-v1",
      "digest": "<32-byte digest>",
      "inputIndex": 0,
      "expiresAt": "2026-07-14T09:00:00.000Z",
      "signature": "<64-byte Schnorr signature>"
    }
  }
}
```

For `additive`, `payload.profile` MUST be `additive`,
`paymentOutputIndex` MUST be 0, and the payload MUST also include the exact
`challengeId` from the accepted requirements. For `standard-native`,
`challengeId` MUST be absent.

`payerAddress` is receipt metadata only. Verified payer attribution comes from
authoritative input UTXOs and valid signatures.

`requestHash` and `authorization` are mandatory for both profiles. The
authorization digest binds the canonical transaction id, selected profile,
payment output index, amount, `payTo`, canonical recipient script, accepted
requirements hash, normalized request hash, additive challenge when present,
authorizing payer input index, and expiry. The signer MUST be the public key
proven by that authoritative standard P2PK funding input. The additive head
input cannot authorize the payer request.

An on-chain transaction signature authorizes the value transfer; it does not by
itself authorize which HTTP resource or MCP operation receives that payment.
The request authorization closes that audience boundary. Removing or changing
the request hash, route, requirements, profile, recipient, amount, transaction,
input index, challenge, or expiry MUST invalidate the payment before protected
work.

The artifact MUST include bounded representations of version, inputs,
outpoints, input mass fields, signature scripts, outputs, output covenants,
lock time, subnetwork, gas, payload, storage mass, and any embedded UTXO hints.
Hints are not trusted chain evidence.

The verifier MUST derive the transaction id from the canonical transaction. A
separate client-authoritative transaction id is forbidden. If the interchange
format includes a convenience `id`, it MUST equal the independently recomputed
identifier.

## Canonical request authorization

### Payment requirements hash

`paymentRequirementsHash` is SHA-256 over the UTF-8 bytes of the complete
selected `PaymentRequirements` object after recursive canonical JSON
serialization:

- object keys are sorted in ascending UTF-16 code-unit order;
- arrays retain their order;
- strings, booleans, integers, and `null` use compact JSON encoding;
- no whitespace is inserted;
- undefined values, non-finite numbers, and non-JSON values are invalid.

All documented field names are ASCII, so their ordering is identical in
ordinary bytewise and Unicode-code-point sorts. Implementations accepting
additional fields MUST still include them in this canonical object and hash.

### Authorization digest

Construct this object, using lowercase hex for every hex field and explicit
`null` for a missing standard-native challenge:

```json
{
  "scope": "kaspa-x402-exact-request-authorization-v1",
  "network": "kaspa:testnet-10",
  "profile": "additive",
  "transactionId": "<lowercase transaction id>",
  "paymentOutputIndex": 0,
  "amount": "20000000",
  "payTo": "kaspatest:...",
  "payToScriptPublicKey": "<lowercase serialized script>",
  "paymentRequirementsHash": "<lowercase hash>",
  "requestHash": "<lowercase hash>",
  "challengeId": "<lowercase hash or null>",
  "inputIndex": 1,
  "expiresAt": "2099-01-01T00:00:00.000Z"
}
```

Apply the same canonical JSON serialization and SHA-256 the UTF-8 result. The
64-byte Schnorr signature in `authorization.signature` signs this 32-byte
digest directly. Its public key MUST be the x-only public key committed by the
authoritative standard P2PK UTXO at `authorization.inputIndex`.

The exact interoperability vector includes the selected requirements, both
canonical JSON preimages, both SHA-256 results, signer public key, and valid
signature. No TypeScript-specific serialization is needed to reproduce it.

## Expiry

Let `now` be the verifier's current time:

- `authorization.expiresAt` MUST parse as a timestamp strictly after `now`;
- it MUST be no later than `now + maxTimeoutSeconds`;
- for additive, `challengeExpiresAt` MUST also be strictly after `now` and
  `authorization.expiresAt` MUST be no later than `challengeExpiresAt`;
- a client SHOULD set standard-native authorization expiry to
  `clientNow + maxTimeoutSeconds`;
- an additive client MUST select the earlier of that value and the advertised
  `challengeExpiresAt`.

The resource server or facilitator checks authorization ordering before
protected work. The additive head/challenge provider checks challenge liveness
and head state. An adapter may repeat these checks but cannot weaken them.

Expiry prevents a new settlement or protected-handler execution. It does not
invalidate an idempotent retry whose transaction and response were already
durably accepted for the same request. An implementation MAY verify enough of
an expired artifact to identify that exact stored result, but MUST NOT execute
the protected handler or create a new settlement when no matching durable
record exists.

The committed interoperability vector fixes a reference clock and supplies
positive and negative expiry cases so results do not depend on the test
runner's wall clock.

## Verification

Before protected work executes, the server or facilitator MUST:

1. Validate x402 version, scheme, network, asset, amount, timeout, binding,
   profile, and every required profile field.
2. Re-derive `payToScriptPublicKey` from `payTo` and reject disagreement.
3. Enforce artifact byte, input, output, script, and metadata size limits before
   expensive parsing or node calls.
4. Canonically deserialize the transaction and recompute its identifier.
5. Resolve every input UTXO from a trusted node or trusted chain adapter.
6. Reject any disagreement with artifact-provided UTXO hints.
7. Verify every payer Schnorr signature and every P2SH witness under the active
   rules.
8. Enforce the selected profile's complete transaction shape and exact merchant
   gain.
9. Recompute input/output conservation, fee, compute mass, storage mass, script
   units, and compute commitments; apply configured bounds.
10. Validate the transaction in isolation and with the populated UTXO context
    using current Rusty Kaspa consensus behavior.
11. Verify the payer request authorization against an authoritative funding
    input, then enforce request binding, transaction replay, and
    payment-identifier policy.
12. For additive, validate the still-live challenge and atomically claim the
    exact expected head/version before protected work.

Facilitator `/verify` and `/settle` requests MUST carry the resource server's
independently computed `requestHash`. A facilitator MUST NOT infer that value
from `PaymentPayload.payload.requestHash`; the embedded value is evidence to
compare, not an independent statement of the requested resource.

No public or adapter-supplied transaction identifier, UTXO value, UTXO script,
mass, fee, or finality assertion is authoritative merely because it is present
in JSON.

## Settlement lifecycle

1. The client requests a protected resource without payment.
2. The server returns one or more supported exact entries. `standard-native`
   SHOULD be first and is the default.
3. An additive offer reads a healthy current head but does not reserve, consume,
   or retire it.
4. The client builds and signs a transaction for one selected profile without
   broadcasting it.
5. The server or facilitator performs full verification using trusted chain
   facts and verifies the payer's request authorization.
6. Transaction replay evidence is durably consumed. For additive, the expected
   head transition is also atomically claimed.
7. The server or facilitator broadcasts the exact verified transaction and
   observes required finality. Ambiguous outcomes remain consumed for trusted
   reconciliation.
8. Only after durable `accepted` state does the x402 resource handler run.
9. The handler result is persisted before the atomic payment/response commit.
   A retry resumes the same result without rerunning protected work.
10. Durable state advances to `applied`; the response reports the independently
    established transaction id and profile evidence.

If broadcast returns an ambiguous error, consumed evidence and a claimed head
MUST remain pending until trusted reconciliation resolves the known transaction.
They MUST NOT be released for another handler execution.

Host frameworks that run protected work between verification and settlement
cannot make arbitrary application side effects atomic with chain broadcast.
Applications with irreversible side effects MUST use an idempotent handler or
an application outbox keyed by the durable payment/request identity.

If a handler starts but its result is uncertain, the SDK MUST fail closed with
an explicit recovery-required state. It MUST NOT rerun the handler blindly. An
operator may supply a known durable result through the recovery API; the
identical authorized retry then completes the commit without repeating the
application effect. The reference store limits the durable result to 256 KiB
and 64 response headers; larger application output belongs in a durable outbox
referenced by the bounded result.

## Retry and signer policy

A corrective 402 is a new offer, not permission for a wallet to sign another
payment automatically. The alpha.8 clients accept `maxPaymentRetries: 0` only.
Every replacement exact transaction requires a fresh explicit caller or wallet
authorization. Funding providers MUST expose an `authorizeExactPayment`
boundary, and deployments SHOULD pin allowed origins, profiles, recipients,
and a maximum amount before signing.

## Additive concurrency and head recovery

- A head MAY be referenced by many unexpired challenges.
- The first fully verified candidate to atomically claim the expected
  `(headId, headVersion, outpoint)` wins.
- A losing candidate receives a new 402 with the current head. It MUST NOT run
  protected work.
- Challenge expiry does not mutate or retire an unspent head.
- Independent head chains SHOULD be sharded for concurrency.
- A public unpaid request MUST reconcile only a fixed number of selected heads;
  work MUST remain bounded independently of total inventory. Full-pool refresh
  belongs in authenticated or scheduled operator work.
- Settlement stages MUST be persisted as `pending`, `broadcast`, `accepted`,
  and `applied` or equivalent recoverable states.
- Reconciliation MUST run at startup, before advertising a potentially stale
  head, after broadcast uncertainty, after relevant UTXO notifications, and
  after reorg detection.
- A known locally verified transaction has a deterministic output-0 successor.
- An external advance may be followed only with trusted transaction-lineage
  evidence proving the expected input and same-index, same-script successor.
- A same-address UTXO alone is not lineage evidence. An arbitrary output sent by
  an attacker MUST NOT be adopted as the current head.
- If lineage cannot be proved, the head MUST become unavailable for operator
  recovery or safe rotation.

Because anyone can satisfy the additive borrower branch, an external party can
advance a head by the threshold. Standard-native remains the default and
fallback. Operators SHOULD combine sensible thresholds, independent shards,
trusted reconciliation, balance monitoring, and sweep/rotation policies.

This is an intentional liveness and wallet-UX tradeoff of a public borrower,
not a merchant-funds-loss path. An external advance makes transactions against
the previous head stale. With `maxPaymentRetries: 0`, each replacement requires
a new explicit wallet authorization. Merely hiding or authenticating the 402
offer does not remove the on-chain public borrower. Restricting the borrower
would require a different, pre-authorized head design and would no longer be
the permissionless additive profile defined here.

## Finality and reorgs

`accepted` means accepted under the configured trusted-node policy.
`confirmed` means the stronger confirmation policy documented by the adapter.

The binding orders finality as `mempool < accepted < confirmed`. The effective
requirement is the stronger of the offer and resource-server policies.
`accepted` is the alpha interoperability baseline and means the trusted node
reports the transaction in accepted chain state, not merely in its mempool.
There is no universal numeric confirmation depth in this alpha. An adapter
offering `confirmed` MUST document and consistently enforce its stronger depth,
time, or virtual-chain policy. Other implementations MUST NOT assume a numeric
depth from the word alone.

A reorg or node disagreement after response delivery is an operationally
ambiguous settlement. The implementation MUST retain consumed evidence, mark
the affected standard transaction or additive head for reconciliation, and
MUST NOT treat the payment as reusable merely because one node stopped
reporting it.

## SettlementResponse

Standard-native success:

```json
{
  "success": true,
  "transaction": "<recomputed transaction id>",
  "network": "kaspa:testnet-10",
  "payer": "kaspatest:...",
  "amount": "20000000",
  "extensions": {
    "kaspa": {
      "binding": "kaspa-exact-v2",
      "profile": "standard-native",
      "paymentOutputIndex": 0,
      "finality": "accepted",
      "transactionEncoding": "kaspa-sdk-safe-json-v2.0.0"
    }
  }
}
```

Additive success additionally includes:

```json
{
  "extensions": {
    "kaspa": {
      "binding": "kaspa-exact-v2",
      "profile": "additive",
      "templateId": "kaspa-x402-kip10-additive-v1",
      "headId": "<head id>",
      "headVersion": "7",
      "challengeId": "<challenge id>",
      "previousHeadOutpoint": { "txid": "<old txid>", "index": 0 },
      "continuationOutpoint": { "txid": "<settlement txid>", "index": 0 },
      "paymentOutputIndex": 0,
      "finality": "accepted",
      "transactionEncoding": "kaspa-sdk-safe-json-v2.0.0"
    }
  }
}
```

On success, `amount` MUST equal the accepted requirement amount and
`transaction` MUST be a non-empty canonical transaction identifier.

## Idempotency and replay

Servers SHOULD require the x402 `payment-identifier` extension.

- The identifier MUST bind to the normalized request fingerprint and selected
  exact profile.
- Same identifier plus same fingerprint returns the cached outcome.
- Same identifier plus a different fingerprint fails.
- A transaction identifier is consumable at most once per server/facilitator
  trust domain except for an idempotent replay of the same request.
- An additive challenge is usable only for its bound request, but issuing or
  expiring it does not consume the head.
- An additive expected head transition has one winner even if candidates have
  different transaction identifiers.

## Resource bounds

Implementations MUST configure and test limits for:

- encoded header and transaction artifact bytes;
- input and output counts;
- signature and redeem-script bytes;
- total node/UTXO lookups and timeouts;
- compute budget and measured script units;
- compute mass, storage mass, and total fee;
- challenge lifetime and pending-reconciliation lifetime;
- retry, replay, and rate-limit state.

Bounds MUST be checked as early as possible and failures MUST be fail-closed.

## Initial alpha.8 exclusions

- fungible tokens or non-native assets;
- arbitrary input scripts;
- multiple merchant outputs;
- multiple payer change outputs;
- KIP-20/native covenant binding;
- an Argent runtime dependency;
- automatic adoption of same-address UTXOs without lineage proof;
- mainnet broadcast or production custody claims.

## Diagnostics

Public errors use the x402-mapped reasons in `errors.md`. Local diagnostics may
include:

```text
unsupported_kaspa_exact_profile
invalid_kaspa_exact_transaction
invalid_kaspa_exact_transaction_id
invalid_kaspa_exact_payment_output
invalid_kaspa_exact_signature
invalid_kaspa_exact_utxo
invalid_kaspa_exact_fee
invalid_kaspa_exact_mass
invalid_kaspa_exact_replay
invalid_kaspa_exact_finality
invalid_kaspa_exact_challenge
stale_kaspa_exact_head
unavailable_kaspa_exact_head
```

## References

- [KIP-9: Extended mass formula](https://github.com/kaspanet/kips/blob/master/kip-0009.md)
- [KIP-10: Transaction introspection opcodes](https://github.com/kaspanet/kips/blob/master/kip-0010.md)
- [Rusty Kaspa](https://github.com/kaspanet/rusty-kaspa)
- [Historical alpha.7 exact binding](/v0.1.0-alpha.7/spec/kaspa-exact-v1.md)
- [Kaspa x402 Batch Settlement Binding v1](kaspa-batch-settlement-v1.md)
