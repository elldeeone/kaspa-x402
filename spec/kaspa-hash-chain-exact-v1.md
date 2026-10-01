# Kaspa x402 Hash-Chain Exact Binding v1

Status: **published in `1.0.0-rc.2` as an optional Testnet-10 profile**.
It is included in the public packages and hosted browser demo. The binding
remains an interoperability candidate; mainnet and stable-release gates still
apply. See the [RC2 release reference](../docs/rc2-release.md).

This document specifies a native-KAS x402 v2 `exact` mechanism derived from
KCC20's `hash-chain/v1` borrowed-receive authorization. It is a separate,
optional binding. It does not change the active
[`kaspa-exact-v2`](kaspa-exact-v2.md) `standard-native` or `additive` profiles,
and it is not a KCC20 token transfer.

Normative sources for this binding:
[KCC20 borrowed-receive design](https://github.com/kaspanet/kccs/blob/c0bb8f3babbb6a93dbddac900121e5046c1ec388/kcc-0020/borrowed-receive-authorization.md),
[KCC20 §5](https://github.com/kaspanet/kccs/blob/c0bb8f3babbb6a93dbddac900121e5046c1ec388/kcc-0020.md#L314-L365),
[KIP-20 covenant IDs](https://github.com/kaspanet/kips/blob/e4ae2332117b5cb68bd6188e065ef885b6d17939/kip-0020.md),
[x402 v2](https://github.com/x402-foundation/x402/blob/749653343bfbbe82fde9f31fdcbb2349b426a460/specs/x402-specification-v2.md), and
[x402 `exact`](https://github.com/x402-foundation/x402/blob/749653343bfbbe82fde9f31fdcbb2349b426a460/specs/schemes/exact/scheme_exact.md).

## Purpose and trust model

The merchant keeps a native-KAS covenant head. It precomputes a finite hash
chain and gives one current predecessor guard plus its one-time Schnorr private
key to one payer. The payer can spend the head and fund its positive KAS
increase **without a merchant signature**. The covenant accepts one successful
transition for that released link, then changes its guard. This is Michael
Sutton's suggested one-use *borrow authorization* applied to native KAS.

The link is a bearer capability for **one accepted head transition**. It does
not by itself bind a price, payer, request or wall-clock expiry. A holder may
sign several conflicting transactions before one is accepted. The x402 layer
requires an exact price and request-bound payer signature before providing a
resource. A consensus-valid smaller top-up may still consume the grant and
move the head without buying the resource. That outcome must be reconciled,
not described as a failed on-chain payment.

## Identifiers and payment flow

| Field | Value in this binding |
| --- | --- |
| `scheme` | `exact` |
| `network` | `kaspa:testnet-10` for validation; `kaspa:mainnet` is reserved |
| `asset` | `KAS` (sompi, 8 decimals) |
| `extra.binding` | `kaspa-hash-chain-exact-v1` |
| `extra.profile` | `hash-chain-additive` |
| `extra.templateId` | `kaspa-x402-hash-chain-head-v1` |
| `extra.assetTransferMethod` | `kaspa-v1-hash-chain-proof` |
| `extra.paymentFlow` | `upfront` |

This binding has one asset transfer method. It belongs to x402 `exact`'s
**client-submitted payment-proof** family: the payer signs and broadcasts the
native-KAS transaction, then presents the complete transaction as proof. The
server's `/settle` checks trusted chain evidence, atomically claims the proof
for the request, and only then invokes protected work. `/verify` may exist for
diagnostics but is not in the `upfront` resource flow and must not consume the
payment. The payer funds all network fees. No facilitator or merchant key is
required to sign the borrow spend. Clients that do not understand this method
or `upfront` must skip the offer.

The canonical network payment identifier is
`kaspa:testnet-10:<lowercase canonical transaction id>` (or the matching
network identifier on a future enabled network). Atomic proof claiming is
scoped across every process that can serve the same merchant head. A
transaction's double-spend protection does not prevent delivery of multiple
resources for one payment.

## Head and hash-chain rule

The merchant creates random `x_0` and one-time Schnorr keypairs
`(private_key_i, pubkey_i)` and computes
`x_i = BLAKE3_unkeyed_32(x_(i-1) || pubkey_i)`. The initial head guard is
`x_n`. For a current guard `x_i`, a borrower supplies
`revealedGuard = x_(i-1)`, the 32-byte x-only `pubkey_i`, and a 65-byte Schnorr
transaction signature made with `private_key_i`. The borrow branch MUST check
the exact 64-byte concatenation hash, the transaction signature with
`SIGHASH_ALL`, and a positive native-KAS increase. Its successor state guard
MUST equal `revealedGuard`. Links are released in reverse generation order.

The initial head is a version-1 KIP-20 covenant output with a stable
`covenantId`. Each borrow spends exactly the advertised current head at input
0 and creates exactly one same-ID authorized successor at output 0. The
successor script MUST be the same pinned contract template and owner with the
new guard, independently reconstructed and compared with output 0. The head
principal MUST remain in that successor. KIP-20 identity does not locate the
live outpoint; the merchant must persist and reconcile it.

The pinned [SilverScript contract](../contracts/kaspa-x402-hash-chain-head-v1.sil)
has two separate owner paths, both covered by the
[local consensus vector](../vectors/hash-chain/consensus-v1.json):

- `ownerRotate`: owner SIGHASH_ALL authorization, one same-ID successor with a
  newly committed guard and head value at least the old head value. The owner
  funds any fee separately. Rotation replaces an abandoned or exhausted chain.
- `ownerSweep`: owner SIGHASH_ALL authorization with no same-ID successor;
  this terminates the head. A new head requires new genesis and a new offer.

An owner rotation and a released borrow are competing spends of the same
outpoint. Local expiry or key deletion does not revoke a grant. Revocation is
effective only when an owner transition is accepted ahead of the borrower.

## `PaymentRequirements`

This illustrative offer uses placeholders, not a conformance vector:

```json
{
  "scheme": "exact",
  "network": "kaspa:testnet-10",
  "amount": "20000000",
  "asset": "KAS",
  "payTo": "kaspatest:<expected-successor-p2sh-address>",
  "maxTimeoutSeconds": 300,
  "extra": {
    "binding": "kaspa-hash-chain-exact-v1",
    "profile": "hash-chain-additive",
    "assetTransferMethod": "kaspa-v1-hash-chain-proof",
    "paymentFlow": "upfront",
    "templateId": "kaspa-x402-hash-chain-head-v1",
    "finality": "accepted",
    "transactionEncoding": "kaspa-sdk-safe-json-v2.0.0",
    "payToScriptPublicKey": "<successor serialized script public key>",
    "headId": "<32-byte server-scoped id>",
    "headVersion": "7",
    "covenantId": "<32-byte KIP-20 id>",
    "expectedHeadOutpoint": { "txid": "<current tx id>", "index": 0 },
    "headAmount": "100000000",
    "headScriptPublicKey": "<current serialized script public key>",
    "headRedeemScript": "<current pinned redeem script>",
    "currentGuard": "<32-byte current guard>",
    "nextGuard": "<32-byte predecessor guard>",
    "oneTimePublicKey": "<32-byte x-only public key>",
    "grantId": "<32-byte grant id>",
    "grantClaimUrl": "https://api.example.com/.well-known/kaspa-x402/grants",
    "challengeId": "<32-byte request challenge id>",
    "challengeIssuedAt": "2026-09-22T12:00:00.000Z",
    "challengeExpiresAt": "2026-09-22T12:05:00.000Z"
  }
}
```

`amount` MUST be a canonical positive uint64 sompi string, and
`headAmount + amount` MUST fit in uint64. `finality` MUST be `accepted` or
`confirmed`; mempool presence is insufficient to deliver the resource.
The challenge MUST bind one normalized resource request at issuance, and
`challengeExpiresAt` MUST be after `challengeIssuedAt` and no later than
`challengeIssuedAt + maxTimeoutSeconds`. The issuer MUST persist both times
and the request hash with the offered requirements.
For this profile, `requestHash` is SHA-256 of canonical
`{method, url, body}` after binding the host-trusted security context. It
excludes `PaymentRequirements`: those requirements contain the challenge that
cannot exist until the request hash has been calculated. The separate payer
authorization binds the complete `PaymentRequirements` hash.
Challenge issuance MUST require a host-authenticated admission context before
it consumes durable issuer state. The issuer MUST deduplicate an identical
live `(admission key, requestHash, amount, head version, grant)` offer without
extending its expiry, enforce a durable per-admission-key live challenge cap,
and retain the global head cap. If authenticated admission is unavailable or a
cap is reached, a server offering batch settlement SHOULD return that usable
fallback without allocating a hash-chain challenge.
`headId` is the merchant's stable application identifier, while `covenantId`
is the independently verified KIP-20 identity. `headVersion` increases for
every accepted borrow or owner rotation. The outpoint, amount, script,
redeem script, guard and covenant ID MUST agree with trusted current-head
evidence when the offer is made. At settlement, the verifier MUST authenticate
that historical predecessor and the accepted successor; the offered outpoint
will no longer be unspent after a successful payment.

The published template ID MUST resolve to one pinned SilverScript source,
compiler commit, deployable ABI artifact, and template hash. A server MUST
derive `currentGuard`, owner, and template from `headRedeemScript` and reject
any disagreement. It MUST verify
`BLAKE3_unkeyed_32(nextGuard || oneTimePublicKey) == currentGuard` before
advertising. It MUST derive the expected successor redeem script by changing
only the guard, then derive `payToScriptPublicKey` and `payTo` for the selected
network. The current head address and successor `payTo` are normally different.

`payTo` is the expected **successor** P2SH address. This binding identifies
the exact merchant transfer as
`output[0].value - trusted_previous_head.value == amount`, with the old
merchant principal carried across the same owner, template and covenant ID.
There is no second merchant payment output. This net-gain interpretation of
x402 `exact` is explicit here and requires interoperability review against
the upstream requirement for one identifiable transfer of `amount` to
`payTo` before this profile is advertised beyond its own implementation.

`nextGuard` and `oneTimePublicKey` are public commitment data and do not
authorize a spend without the private key. The private key MUST NOT appear in
`PaymentRequired`, `PaymentPayload`, public headers, logs, URLs, vectors or
settlement responses. `grantClaimUrl` MUST be same-origin HTTPS with the
client's actual protected request URL, not merely an advertised `resource.url`,
except for a loopback development server when the actual request is loopback.
Before signing or posting a claim, an automated client MUST require that exact
canonical origin in a dedicated outbound allowlist. This allowlist is separate
from funding policy and explicitly trusts all public or private addresses to
which the origin can resolve; a client that cannot pin DNS and transport to a
prevalidated peer MUST NOT represent a pre-resolution check as rebinding
protection. Redirects, credentials and fragments are forbidden. Plain HTTP is
limited to an explicitly listed loopback origin.
`grantId` MUST
be a fresh unpredictable 32-byte value for the current head; `challengeId`
MUST be fresh for its request. A server may
offer multiple public challenges for one current head, but only one payer may
claim its live grant. Other claimants must receive an unavailable result and
obtain a fresh offer after the head changes or owner rotation completes.

## Private grant claim

The client claims the advertised grant through `POST grantClaimUrl` before
building its transaction. The claim body contains the selected `grantId`,
`challengeId`, the normalized `requestHash`, a 32-byte x-only
`payerPublicKey`, a UTC `expiresAt`, and a 64-byte Schnorr `signature`. The
signature signs SHA-256 of the UTF-8 bytes of the following object after the
same recursive canonical JSON serialization used by
[`kaspa-exact-v2`](kaspa-exact-v2.md#payment-requirements-hash):

```json
{
  "scope": "kaspa-x402-hash-chain-grant-claim-v1",
  "network": "kaspa:testnet-10",
  "binding": "kaspa-hash-chain-exact-v1",
  "grantId": "<lowercase id>",
  "challengeId": "<lowercase id>",
  "requestHash": "<lowercase hash>",
  "payerPublicKey": "<lowercase x-only key>",
  "expiresAt": "2026-09-22T12:05:00.000Z"
}
```

The resource server MUST independently compute `requestHash`, compare every
claim field to its still-live, stored offer and request, verify the payer
signature, and reject a
claim expiry later than `challengeExpiresAt` or the server's policy window.
Before reading or parsing a claim body, the claim endpoint MUST acquire a
bounded global or host-authenticated request permit. After parsing only the
bounded claim fields, it MUST charge the same stored authenticated admission
bucket used for its challenge before signature, eligibility, database mutation
or chain work. It MUST enforce request-body, concurrency and timeout limits and
propagate caller cancellation through current-head observation.
The server MUST first authorize the claim without assigning the key, read the
exact advertised head outpoint from an authoritative complete and untruncated
current-UTXO source, and only then atomically revalidate the head version,
outpoint, amount, script, covenant and claim tuple while committing the
assignment. A transient observer failure, timeout or cancellation MUST leave
the grant unassigned.
The issuer MUST NOT expose an unchecked assignment helper: every public claim
operation must require the authoritative exact-outpoint observation before its
atomic commit.
The grant issuer MUST atomically assign the current grant to one
`(payerPublicKey, requestHash, challengeId)` tuple and persist the assignment
before delivering the key. An identical authenticated retry receives the
same assignment; a different tuple cannot receive that key. A crash after
assignment must not make the key silently available to a second payer. A
signature proves control of `payerPublicKey`, not entitlement to a scarce
grant: the issuer MUST enforce its configured client eligibility and rate
limits before assignment.

The confidential response returns `grantId`, `nextGuard`, `oneTimePublicKey`,
the matching one-time private key, and the effective claim expiry. The client
MUST verify the private key corresponds to `oneTimePublicKey` and the public
guard equation before using it. The response MUST set `Cache-Control:
no-store`; the server and intermediaries MUST NOT log or cache its body.
Keys at rest need the same confidentiality and recovery policy as other
transaction-signing material. The grant may be delivered through an
equivalent authenticated confidential channel for a non-HTTP x402 transport,
but its fields and allocation rules remain the same.

Claim expiry is **off-chain service policy**. An issued key remains a valid
on-chain borrower authorization until the head advances or an owner rotation
wins. On abandonment, the issuer stops offering the old head, attempts owner
rotation, and waits for trusted accepted-chain evidence before issuing a new
grant. On a small but valid unsolicited top-up, the issuer observes and adopts
the authentic successor; it does not serve a resource for an unmatched or
underpaid transaction. A reorg that restores a previously issued guard puts
the head into reconciliation hold; the issuer must not release another grant
until the actual chain state and key exposure are resolved.

The reference issuer persists the quoted amount with each delivered grant. If
head readback puts an assigned grant on hold after an unmatched borrow, an
operator supplies that transaction ID to `recoverSelectedUnmatchedBorrow`
with a trusted selected-chain view. The issuer checks the spent outpoint,
same-ID successor, revealed guard and positive increase against the durable
quote before advancing. A spend with the exact quoted increase stays on the
normal x402 settlement path; it cannot be reclassified as an unmatched borrow
to bypass payment delivery. Quote-free assignments from older local stores
remain unavailable for this automatic recovery and require investigation.

## Canonical payment transaction

The payer signs and broadcasts a version-1 native Kaspa transaction:

```text
input[0]  = exact current merchant hash-chain head
input[1+] = standard Schnorr P2PK payer funding inputs

output[0] = same-ID successor head at payTo,
            amount = headAmount + PaymentRequirements.amount,
            state.guard = nextGuard
output[1] = optional payer-controlled change
```

The complete signed transaction MUST spend `expectedHeadOutpoint` at input
0, use the borrow entrypoint with the advertised `nextGuard` and
`oneTimePublicKey`, verify the one-time SIGHASH_ALL signature, and produce
exactly one KIP-20 same-ID authorized output at index 0. It MUST match the
trusted current head value, script, covenant ID and pinned template. Output
0 MUST match the independently reconstructed successor script, covenant
binding, `payToScriptPublicKey`, and `headAmount + amount`. It MUST preserve
the owner and all non-guard template fields. The covenant itself enforces a
positive increase; **the x402 verifier** enforces this exact equality.

There MUST be at least one payer input after input 0, at most one payer change
output, no separate merchant output, and no extra covenant input or output.
Each payer input MUST be a verified standard Schnorr P2PK input; optional
change MUST return to a script controlled by a verified payer input. The
network fee comes entirely from payer inputs:
`sum(payer inputs) = amount + fee + payer change`. The transaction MUST use
the native subnetwork, zero gas and lock time, empty payload, final signed
witnesses, sufficient v1 compute budgets, correct contextual storage mass,
and configured amount, fee, size and script-unit bounds. Validation MUST
include current Rusty-Kaspa isolation, populated-transaction, mass and script
rules; supplied UTXO hints are not authority.

The payer may broadcast through its chosen Kaspa node. That independent
broadcast ability is part of the delegated-grant design. A signed transaction
is not an x402 receipt until the server observes it at the required finality,
validates its exact terms, and atomically claims it for one request.

## `PaymentPayload` and request binding

The paid request carries a full signed transaction as proof:

```json
{
  "x402Version": 2,
  "accepted": { "...": "the complete selected requirements above" },
  "payload": {
    "type": "exact-transaction",
    "profile": "hash-chain-additive",
    "transaction": "<complete signed safe transaction JSON>",
    "transactionEncoding": "kaspa-sdk-safe-json-v2.0.0",
    "paymentOutputIndex": 0,
    "grantId": "<32-byte grant id>",
    "challengeId": "<32-byte challenge id>",
    "requestHash": "<normalized request hash>",
    "authorization": {
      "version": "kaspa-x402-exact-request-authorization-v1",
      "digest": "<32-byte digest>",
      "inputIndex": 1,
      "expiresAt": "2026-09-22T12:05:00.000Z",
      "signature": "<64-byte payer Schnorr signature>"
    }
  }
}
```

`accepted` MUST be canonically identical to the selected server-issued
requirements; the server MUST reject altered or unissued offers. It
independently computes `requestHash`; it MUST NOT trust only
`payload.requestHash`. The payer's
separate request-authorization signature uses the existing
[`kaspa-x402-exact-request-authorization-v1`](kaspa-exact-v2.md#canonical-request-authorization)
digest with `profile = "hash-chain-additive"`, output index 0, this
binding's successor `payTo`, the complete requirements hash, the grant's
`challengeId`, the recomputed transaction ID, payer funding input index,
and expiry. The requirements hash includes the grant ID, head and next-guard
terms. The signature's public key MUST equal the key that claimed the grant
and be proven by its authoritative P2PK funding input at an index of at
least 1. The one-time borrow key cannot serve as payer request authorization.

The transaction ID MUST be recomputed from the canonical transaction;
client-supplied IDs, UTXO values, finality or fee claims are not authority.
`authorization.expiresAt` and `challengeExpiresAt` MUST be live for a new
proof claim, and the former MUST be no later than the latter and the
`maxTimeoutSeconds` window. A previously accepted immutable attempt may be
recovered after expiry only under the existing exact replay rules; expiry
never authorizes a new handler run. A client MUST recheck both expiries
immediately before every broadcast and MUST NOT broadcast an expired attempt;
it may only reconcile that exact transaction through trusted chain evidence.
Clients should allow time for network
acceptance before expiry. A payment that becomes final only after its
presentation window closes has no automatic resource entitlement or refund
under this binding; that consequence must be exposed before wallet approval.

## Settlement, replay, and finality

1. The merchant advertises the current public head/link terms. A payer
   authenticates and claims the one live private grant.
2. The payer builds, signs and broadcasts the complete transaction, then
   presents the transaction artifact and request authorization in x402.
3. `/settle` checks size limits, schema, signed request identity, grant
   assignment, current or durably observed head lineage, trusted transaction
   and historical UTXO data, exact net increase, and requested finality.
   It independently recomputes the transaction ID and validates every
   signature, witness, covenant binding, fee and mass under current consensus.
   The server itself, before invoking any custom verifier adapter, MUST locally
   authenticate and durably bind the first transaction ID to the assigned head
   version, grant, challenge, request and payer. An alternate candidate MUST
   fail before external reads. A matching candidate already recorded as the
   accepted payment for that durable delivery MUST remain an idempotent retry
   after issuer head advancement.
   Input count MUST be bounded. Historical origins SHOULD be fetched in one
   cancellable batch, and accepting-block reads MAY be deduplicated only within
   that verification; all node reads MUST share the caller's deadline.
4. If finality is not yet met but can still be reached, settlement reports
   the unmet condition and releases any transient proof claim. It does not
   run protected work. A retry may present the same immutable proof.
5. Once finality is met, an atomic store consumes the canonical network
   transaction ID, grant ID, expected head/version, challenge and
   `payment-identifier` for the one normalized request. The accepted head
   successor is recorded durably before protected work.
6. The handler runs once. Its result and the payment/response commit are
   durable so an identical retry resumes the result. A different request
   presenting the same transaction or grant fails.

Clients MUST canonicalize the actual request URL before deriving new payment
identifiers and intent records. Recovery MAY recognize equivalent historical
spellings, including an explicit default port, only when the canonical method,
URL, body, origin and request hash still match. If two aliases identify
different attempts, recovery MUST fail closed.

The proof is presentable only while its claim and request-authorization
window is live, apart from recovery of an already accepted identical
attempt. The maximum age for a new proof claim is the advertised interval
from `challengeIssuedAt` to `challengeExpiresAt`, capped by
`maxTimeoutSeconds`; no old transaction can be attached to a new challenge.
Replay records therefore must be retained at least through that
window, any unresolved reorg/broadcast state, and the server's durable
idempotency period. The head outpoint is itself single-use on-chain, but
that does not replace cross-process x402 delivery deduplication. If an
already observed transaction spent the advertised head with too small or
too large an increase, it is never a successful payment for this quote; the
merchant must reconcile the genuine new head or owner transition.

An underpayment or overpayment is rejected for resource delivery even if its
borrow spend is accepted on-chain. If a transaction is conclusively never
accepted, no KAS transfer occurred. If KAS moved but the quote, expiry, or
finality policy fails, the head transition cannot be reversed by x402 and
this binding provides no automatic refund or return path. A merchant may
arrange a separate owner-authorized refund; clients MUST NOT assume one.

The minimum hosted finality is `accepted`, defined as trusted node evidence
that the transaction is in accepted chain state, not merely the mempool.
`confirmed` may be offered only with a documented stronger policy. On node
disagreement, absent historical input evidence, uncertain acceptance or a
reorg, settlement and grant issuance fail closed and retain recovery state.
The hosted RC2 gateway offers `accepted` only, using configured PNN/WSS
selected-chain evidence and durable pre-spend snapshots. It does not advertise
the stronger `confirmed` policy or depend on a public REST transaction index.
The issuer checks the current head in the virtual UTXO set before advertising a challenge
and again before delivering the private grant.

Successful x402 response uses the standard transaction ID, network, payer
and exact `amount`; `extensions.kaspa` adds this binding/profile, grant ID,
head ID/version, covenant ID, previous and successor outpoints, output index
0, transaction encoding and observed finality. No secret grant material is
returned.

## Compatibility and release gates

The active `standard-native`, KIP-10 `additive`, and batch-settlement wire
profiles retain their separate bindings. Old clients skip this new binding;
new clients must opt in to its grant claim and `upfront` proof flow. An
implementation MUST retain the existing x402 `payment-identifier` extension:
the server advertises it, the payer echoes it, and settlement binds it to
the normalized request and selected profile. An
implementation MUST NOT advertise this profile until schemas, positive and
negative vectors, client/server/facilitator/CLI coverage, transaction-v1
consensus vectors, durable grant recovery and funded Testnet-10 evidence
meet the [native-profile readiness bar](../docs/native-profile-boundary.md#readiness-expectations).

RC2 also advertises `paymentFlow: "upfront"` on existing Kaspa exact offers
that settle before the handler. The successor `payTo` net-gain interpretation
requires upstream exact interoperability review before general advertising.
Mainnet and stable release remain under their own readiness gates.

No cryptographic property here implies on-chain price or time enforcement.
No private grant should be represented as revoked until a conflicting owner
transition is accepted. The actual contract and network evidence must prove
the specified behavior before the binding is promoted beyond its RC2
Testnet-10 interoperability candidate status.
