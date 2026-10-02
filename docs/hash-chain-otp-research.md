# Hash-chain borrow authorization research for native-KAS x402

Current policy: development head-v2 accepts consensus-supported sighash
types on borrow, owner rotation, and owner sweep; reference signing defaults
to ALL. The September research and prototype checkpoints below concern the
earlier head-v1 and retain their historical proof limits. See the
[signature policy](versioning-policy.md#sighash-template-transition) and
[current binding](../spec/kaspa-hash-chain-exact-v1.md).

**Target clarified 2026-09-22:** reproduce the useful part of Michael
Sutton's KCC20 suggestion: release a hash-chain link and its one-time signing
key to a sender, who can independently make **one** authorized additive head
transition. The merchant must not have to cosign each payment. The earlier
merchant-held-key workflow is superseded; the existing contract and helper
are only cryptographic starting points. The x402 binding still settles native
KAS; it does not become KCC20 token settlement.

Intended payment sequence:

1. Merchant commits to the current guard in a funded head and privately issues
   only its next `(revealed guard, one-time private key)` grant to one payer.
2. Payer builds and signs a transaction spending the head plus its own KAS
   inputs, recreating the head with the revealed guard and a positive value
   increase. No merchant signature is needed for that borrow spend.
3. The x402 server verifies that this particular transaction increases the
   merchant lineage by **exactly** the quoted amount and binds the payment to
   the selected request, then settles it before delivering the resource.
4. Merchant observes the accepted successor and only then releases the next
   link. An abandoned or misused grant triggers owner rotation/recovery.

Research snapshot: 2026-09-22. Primary upstream trees were read at
[`kaspanet/kccs` `c0bb8f3babbb6a93dbddac900121e5046c1ec388`](https://github.com/kaspanet/kccs/tree/c0bb8f3babbb6a93dbddac900121e5046c1ec388)
and [`kaspanet/kips` `e4ae2332117b5cb68bd6188e065ef885b6d17939`](https://github.com/kaspanet/kips/tree/e4ae2332117b5cb68bd6188e065ef885b6d17939).
The KCC20 file says **Draft**, updated 2026-08-25; KCC1 and KCC2 also say
Draft. KIP-9, KIP-10, KIP-17, and KIP-20 say Active. These are specification
statuses, not evidence that this x402 profile has been built or deployed.
[KCC20 header](https://github.com/kaspanet/kccs/blob/c0bb8f3babbb6a93dbddac900121e5046c1ec388/kcc-0020.md#L1-L20),
[KCC1 header](https://github.com/kaspanet/kccs/blob/c0bb8f3babbb6a93dbddac900121e5046c1ec388/kcc-0001.md#L1-L8),
[KCC2 header](https://github.com/kaspanet/kccs/blob/c0bb8f3babbb6a93dbddac900121e5046c1ec388/kcc-0002.md#L1-L8),
[KIPs index](https://github.com/kaspanet/kips/tree/e4ae2332117b5cb68bd6188e065ef885b6d17939).

## What Michael's scheme actually does

KCC20 is a **fungible-token covenant convention**. Its borrowed receive spends
an existing recipient token UTXO and recreates it with more tokens, while
preserving owner and extended state and never reducing its KAS backing. The
recipient's ordinary owner authorization is not used. The problem it addresses
is both KIP-9's cost for a new small recipient UTXO and unwanted churn of an
existing recipient outpoint. This is the source concept; a native-KAS x402
variant is an adaptation, not a KCC20 token implementation.
[KCC20 §5](https://github.com/kaspanet/kccs/blob/c0bb8f3babbb6a93dbddac900121e5046c1ec388/kcc-0020.md#L208-L222),
[design note](https://github.com/kaspanet/kccs/blob/c0bb8f3babbb6a93dbddac900121e5046c1ec388/kcc-0020/borrowed-receive-authorization.md#L6-L28).

KCC20 fixes four scheme IDs: disabled `0x00`, amount threshold `0x01`, reusable
Schnorr signature `0x02`, and hash chain `0x03`. Hash-chain `borrow_guard` is
the current 32-byte commitment. The **borrow witness is exactly 129 bytes**:
32-byte predecessor guard, 32-byte one-time Schnorr public key, and 65-byte
transaction signature. KCC20's complete transfer witness also has a leading
`0x01` borrowed-receive path byte; that prefix belongs to KCC20's transfer
entrypoint, not automatically to our native-KAS entrypoint.
[KCC20 transfer path](https://github.com/kaspanet/kccs/blob/c0bb8f3babbb6a93dbddac900121e5046c1ec388/kcc-0020.md#L99-L110),
[KCC20 scheme and witness](https://github.com/kaspanet/kccs/blob/c0bb8f3babbb6a93dbddac900121e5046c1ec388/kcc-0020.md#L173-L184),
[KCC20 §5](https://github.com/kaspanet/kccs/blob/c0bb8f3babbb6a93dbddac900121e5046c1ec388/kcc-0020.md#L224-L247).

For `n` uses, the owner chooses random `x_0` and `n` one-time keypairs. Let
`H` be **unkeyed, 32-byte BLAKE3**. It computes
`x_i = H(x_(i-1) || pubkey_i)` in generation order and installs `x_n` as the
first guard. A spend against `x_i` reveals `x_(i-1)` and `pubkey_i`, proves
`H(x_(i-1) || pubkey_i) == x_i`, and verifies a transaction signature by
`pubkey_i`. The successor guard becomes `x_(i-1)`. Releases therefore run in
reverse order, and the chain has no further planned link after `x_0` is
revealed. This construction is inspired by PayWord, with a distinct Schnorr
key bound to each link.
[KCC20 design note](https://github.com/kaspanet/kccs/blob/c0bb8f3babbb6a93dbddac900121e5046c1ec388/kcc-0020/borrowed-receive-authorization.md#L65-L102),
[KCC1 hash definition](https://github.com/kaspanet/kccs/blob/c0bb8f3babbb6a93dbddac900121e5046c1ec388/kcc-0001.md#L103-L122).

The token successor must preserve the owner, owner scheme, borrow scheme and
extension commitment, use the predecessor guard, and increase token amount.
For a hash-chain borrow, **any positive token increase** is valid under KCC20;
the token covenant does not enforce a merchant's advertised x402 price. The
actual output's KAS value must at least preserve the borrowed input's KAS
value. A normal owner-authorized transfer may change the borrow scheme and
guard.
[KCC20 transition rule](https://github.com/kaspanet/kccs/blob/c0bb8f3babbb6a93dbddac900121e5046c1ec388/kcc-0020.md#L245-L289).

### What “OTP-like” means, precisely

The **successful state transition** consumes one link: the old guard disappears
with the spent UTXO and the next guard replaces it. Reusing the same revealed
link against the successor would require a hash fixed point, collision, or
different valid preimage. The one-time property is therefore on-chain
authorization for one *accepted transition*, not a promise that the key can
sign only one candidate transaction or that one broadcast attempt will occur.
If several different candidates are signed while the same guard is current,
they compete for the same UTXO; only one can become the successor. This is an
inference from the hash transition and UTXO spending rules.
[KCC20 transition](https://github.com/kaspanet/kccs/blob/c0bb8f3babbb6a93dbddac900121e5046c1ec388/kcc-0020.md#L245-L271),
[KCC20 design note](https://github.com/kaspanet/kccs/blob/c0bb8f3babbb6a93dbddac900121e5046c1ec388/kcc-0020/borrowed-receive-authorization.md#L86-L102).

The preimage alone is insufficient: the borrower also needs the one-time
private key to sign the **transaction**. Conversely, KCC20's intended owner
can give the `(predecessor guard, private key)` pair to a sender, who can then
sign any transaction that satisfies the covenant's borrow rules while that
guard is current. The link does **not** by itself restrict the sender to a
particular price, x402 request, payer, or time. It is not a login OTP or a
payment receipt. A released but unused link remains live until consumed or
revoked by an owner-authorized transfer; issuing multiple links ahead allows
multiple sequential head changes. The design note explicitly recommends
monitoring the successor and withholding the next link until needed.
[KCC20 design note](https://github.com/kaspanet/kccs/blob/c0bb8f3babbb6a93dbddac900121e5046c1ec388/kcc-0020/borrowed-receive-authorization.md#L96-L115),
[KCC20 rules](https://github.com/kaspanet/kccs/blob/c0bb8f3babbb6a93dbddac900121e5046c1ec388/kcc-0020.md#L268-L289).

The reusable Schnorr scheme binds each signature to the transaction fields
covered by its chosen sighash type,
but a disclosed reusable borrow key could approve many future transactions.
The hash chain limits each disclosed link/key to one accepted guard transition,
then requires the next separate key. **The intended x402 mode gives the sender
one link and its private key**, as in the KCC20 design note. A merchant-held
key would instead make this a merchant cosigning protocol with precommitted
key rotation; that is a distinct optional variant, not the target here.
[KCC20 scheme comparison](https://github.com/kaspanet/kccs/blob/c0bb8f3babbb6a93dbddac900121e5046c1ec388/kcc-0020/borrowed-receive-authorization.md#L38-L69),
[KCC20 delegation](https://github.com/kaspanet/kccs/blob/c0bb8f3babbb6a93dbddac900121e5046c1ec388/kcc-0020/borrowed-receive-authorization.md#L96-L115).

## KIPs and primitives we depend on

| Source | Concrete relevance |
| --- | --- |
| [KIP-9](https://github.com/kaspanet/kips/blob/e4ae2332117b5cb68bd6188e065ef885b6d17939/kip-0009.md#L18-L35) | Storage mass prices UTXO growth and motivates additive/borrowed receive. It does not define the hash chain. |
| [KIP-10](https://github.com/kaspanet/kips/blob/e4ae2332117b5cb68bd6188e065ef885b6d17939/kip-0010.md#L24-L54) | Introspects input/output value and script. Its additive example preserves the *same script public key* and raises output value; a changing encoded guard changes P2SH script hash, so that example alone is insufficient. [Additive example](https://github.com/kaspanet/kips/blob/e4ae2332117b5cb68bd6188e065ef885b6d17939/kip-0010.md#L122-L147). |
| [KIP-17](https://github.com/kaspanet/kips/blob/e4ae2332117b5cb68bd6188e065ef885b6d17939/kip-0017.md#L16-L79) | Adds deeper transaction introspection, `OpCat`, `OpBlake3`, and substring operations needed to verify the chain and reconstruct changed state. [KCC1](https://github.com/kaspanet/kccs/blob/c0bb8f3babbb6a93dbddac900121e5046c1ec388/kcc-0001.md#L149-L156) distinguishes 65-byte transaction `sig` from 64-byte `datasig`; the chain uses the former. |
| [KIP-20](https://github.com/kaspanet/kips/blob/e4ae2332117b5cb68bd6188e065ef885b6d17939/kip-0020.md#L10-L46) | Consensus carries a stable `covenant_id` across changing scripts. Version-1 outputs declare `(authorizing_input, covenant_id)`; continuation requires an input already bearing the same ID. The script must *also* authenticate its successor script and binding. |
| [KIP-13](https://github.com/kaspanet/kips/blob/e4ae2332117b5cb68bd6188e065ef885b6d17939/kip-0013.md#L81-L108) | Transient storage mass counts transaction serialized bytes. The larger witness, program, and binding must be measured in real transaction mass and fees. |
| [KIP-5](https://github.com/kaspanet/kips/blob/e4ae2332117b5cb68bd6188e065ef885b6d17939/kip-0005.md#L15-L36) | Personal-message signatures use a distinct hash domain. They cannot substitute for the chain link's transaction signature. |

KIP-20 has three distinct hashes/commitments that must not be conflated:
the **guard** uses unkeyed BLAKE3 under KCC1; the P2SH script public key uses
the redeem-script BLAKE2b commitment under KCC1; the **covenant ID genesis**
uses domain-separated BLAKE2b-256 over an authorizing outpoint and ordered
initial output indices, amounts and script public keys. KIP-20's output
binding is committed by transaction signatures whose selected scope covers
that output, and is included in the transaction ID. An ID labels lineage; it does not independently prove the amount, program
or state transition.
[KCC1 hash/P2SH](https://github.com/kaspanet/kccs/blob/c0bb8f3babbb6a93dbddac900121e5046c1ec388/kcc-0001.md#L103-L122),
[KCC1 P2SH](https://github.com/kaspanet/kccs/blob/c0bb8f3babbb6a93dbddac900121e5046c1ec388/kcc-0001.md#L420-L442),
[KIP-20 genesis](https://github.com/kaspanet/kips/blob/e4ae2332117b5cb68bd6188e065ef885b6d17939/kip-0020.md#L104-L174),
[KIP-20 accounting](https://github.com/kaspanet/kips/blob/e4ae2332117b5cb68bd6188e065ef885b6d17939/kip-0020.md#L262-L269).

For a singleton head, KIP-20's one-to-one pattern is suitable, but a contract
must check the authorized-output count, index, expected same-ID binding, **and
the complete reconstructed successor script public key**. KCC1 additionally
requires authenticating the template and every encoded state field of each
continuation. A stable ID does not give a reverse lookup of the current outpoint;
the service still has to track the successor. The latter follows from the
KIP-20 data model and the borrowed-receive note's outpoint-churn warning.
[KIP-20 authorized outputs](https://github.com/kaspanet/kips/blob/e4ae2332117b5cb68bd6188e065ef885b6d17939/kip-0020.md#L198-L250),
[KIP-20 singleton pattern](https://github.com/kaspanet/kips/blob/e4ae2332117b5cb68bd6188e065ef885b6d17939/kip-0020.md#L287-L305),
[KCC1 continuation requirements](https://github.com/kaspanet/kccs/blob/c0bb8f3babbb6a93dbddac900121e5046c1ec388/kcc-0001.md#L599-L645),
[KCC20 outpoint churn](https://github.com/kaspanet/kccs/blob/c0bb8f3babbb6a93dbddac900121e5046c1ec388/kcc-0020/borrowed-receive-authorization.md#L21-L28).

## Consequences for this native-KAS branch

1. **Scope and naming.** The existing [exact profile](../spec/kaspa-exact-v2.md)
   transfers native KAS, not KCC20 tokens. The new head's native-KAS value gain
   replaces KCC20's token amount increase. Use a distinct optional profile and
   template ID; existing `additive` clients expect a same-script KIP-10 head.
   This is a compatibility inference from our current spec and KIP-10/KIP-20.
2. **Exact payment is an application rule.** On-chain guard validation and a
   positive head delta prove an allowed contribution, not the quoted x402
   amount. The verifier must bind the *selected requirements*, recipient/head,
   exact `successor.value - current.value`, transaction, request, expiry and
   payer authorization before protected work. A larger delta is an overpayment
   under our exact spec, even though KCC20 permits any positive increase.
   [Current exact rules](../spec/kaspa-exact-v2.md).
3. **A delegated grant is the product goal.** The merchant releases the
   predecessor guard and corresponding one-time private key to the payer,
   privately and only for the current head. The payer signs the head input and
   its own funding inputs, then can broadcast without a merchant cosign. Do
   not put the private key in a publicly reusable `402` offer, logs, or a
   shared facilitator configuration. The public offer may identify the head,
   one-time public key, next guard and expected successor; the private-key
   delivery needs its own authenticated or encrypted handoff and a defined
   client interface. This is an application protocol requirement, not a new
   cryptographic KCC20 rule.

   **Accept the bounded misuse risk explicitly:** because the prototype's
   on-chain rule only requires `value > previous value`, a grant holder can
   consume the link with a small valid top-up and independently broadcast it.
   The x402 server can withhold the resource for an underpayment, but cannot
   undo that valid chain transition. The merchant's existing head value stays
   protected, while that grant and outpoint are consumed. Rate-limit grant
   issuance, release only the current link, monitor the head, and provide an
   owner rotation path to recover availability. A stronger on-chain price or
   request commitment may be explored later, but must be named as a different
   native-KAS scheme from KCC20 `hash-chain/v1`.
   [KCC20 churn motivation](https://github.com/kaspanet/kccs/blob/c0bb8f3babbb6a93dbddac900121e5046c1ec388/kcc-0020/borrowed-receive-authorization.md#L21-L28),
   [KCC20 positive-increase rule](https://github.com/kaspanet/kccs/blob/c0bb8f3babbb6a93dbddac900121e5046c1ec388/kcc-0020.md#L268-L277).
4. **Durable state is necessary.** Persist the current outpoint, guard index,
   unsigned/signed candidate, key-use status, broadcast status, and accepted
   successor atomically enough to recover after a crash or uncertain broadcast.
   Do not release the next link until the current transition is confirmed to the
   policy's finality level. A reorg may restore an earlier guard/outpoint; key
   handling must reconcile that actual chain state rather than blindly advance
   an in-memory counter. These are implementation consequences of the
   [KCC20 wallet-control model](https://github.com/kaspanet/kccs/blob/c0bb8f3babbb6a93dbddac900121e5046c1ec388/kcc-0020/borrowed-receive-authorization.md#L104-L115)
   and KIP-20's UTXO continuation model.
5. **Revocation and exhaustion need explicit paths.** KCC20 permits owner
   rotation via a normal owner transfer. The prototype's `ownerSweep` only
   terminates the head; a replacement head would need new genesis, client offer
   update, and pending-attempt reconciliation. Prefer a separately specified
   owner-authorized rotation transition that keeps the same covenant ID and
   head principal while installing a fresh chain guard; prove that it does not
   let an owner or grant holder bypass the borrow rules. The chain cannot
   advance after its last planned link without a new owner-authorized state.
   If a released grant remains unused, its owner sweep/rotation and the
   grant-holder's borrow are competing spends of the same head; revocation is
   effective only when the owner transition wins. Never represent local key
   deletion as on-chain revocation.

### Prototype check against the upstream rules

The historical [head-v1 contract](https://github.com/elldeeone/kaspa-x402/blob/724c5fff22de500fcf729c43b59d25036fbffa9c/contracts/kaspa-x402-hash-chain-head-v1.sil) uses
`blake3(revealedGuard || oneTimeKey)` and `checkSig`, matching the essential
KCC20 cryptographic check. The prototype required a `0x01` signature-hash flag,
an ALL-only signing
restriction subsequently removed in head-v2. The positive native-KAS head
value gain remains a mandatory payment guard. It uses KIP-20 input/output
cardinality and an owner sweep. The
contract itself checks a signature, not who held the key before signing; its
comments now state the delegated-grant target. The local
[helper](../packages/covenant/src/hash-chain.ts) computes unkeyed BLAKE3 over
32+32 bytes and returns reverse-order releases. These observations are from
the September prototype snapshot, not independent consensus proof.

Before relying on that contract, inspect the **compiled** successor-validation
code for the complete new P2SH script and exact output binding, then validate
two consecutive delegated spends under Rusty-Kaspa consensus. The source
decorator may generate this, but compilation alone has not established it. Also test a
wrong/missing link, wrong key, an ALL signature with altered outputs, stale guard,
second covenant input/output, unauthorized owner path, and exhausted chain.
The server must independently reject underpayment *and overpayment* as well as
reused request/transaction evidence. This is the minimum concrete proof needed
before a new profile is advertised.

## SilverScript and x402 cross-checks

### SilverScript repository check

The local SilverScript checkout is clean at
[`v1.0.0` / `3ed973335b59269293564805cc2c58a14595ec03`](https://github.com/kaspanet/silverscript/tree/3ed973335b59269293564805cc2c58a14595ec03),
and the upstream `master` branch and `v1.0.0` tag both resolved to that commit
on 2026-09-22. Pin the exact commit for reproducible artifacts; the generated
ABI still reports `compiler_version: "0.1.0"`, so that string alone is not an
adequate source revision pin. The current contract compiled with explicit
sample constructor arguments to a 404-byte redeem script, one 32-byte `guard`
state field (`state_span` is 33 encoded bytes), and public `borrow` and
`ownerSweep` ABI entries. Those figures describe one sample instantiation, not
consensus acceptance, funding cost, or a published artifact.
[Compiler CLI and constructor arguments](https://github.com/kaspanet/silverscript/blob/3ed973335b59269293564805cc2c58a14595ec03/README.md#L18-L52),
[portable ABI](https://github.com/kaspanet/silverscript/blob/3ed973335b59269293564805cc2c58a14595ec03/docs/TUTORIAL.md#L88-L109).

The `#[covenant(binding = auth, from = 1, to = 1, mode = transition,
groups = single)]` wrapper reads the prior state from its own input, calls
the policy, requires one authorized continuation, and invokes
`validateOutputState` with the returned state. `groups = single` also equates
the same-ID output count and the authorized output count. The compiler's
`validateOutputState` lowering reconstructs the complete redeem script with
the new state, hashes it into a P2SH script public key, and compares the
chosen output script. This is the exact machinery needed when the guard change
changes the P2SH address. The contract's additional explicit checks bind that
authorized output to index 0, the same covenant ID, and a positive value
increase. SilverScript's `checkSig` accepts a transaction signature with its
sighash byte, and KIP-17 supplies `OpBlake3` for the guard test.
[declaration semantics](https://github.com/kaspanet/silverscript/blob/3ed973335b59269293564805cc2c58a14595ec03/docs/DECL.md#L164-L252),
[generated auth wrapper](https://github.com/kaspanet/silverscript/blob/3ed973335b59269293564805cc2c58a14595ec03/silverscript-lang/src/compiler/covenant_declarations.rs#L599-L682),
[successor script reconstruction](https://github.com/kaspanet/silverscript/blob/3ed973335b59269293564805cc2c58a14595ec03/silverscript-lang/src/compiler/compile/state.rs#L245-L347),
[signature builtin](https://github.com/kaspanet/silverscript/blob/3ed973335b59269293564805cc2c58a14595ec03/docs/TUTORIAL.md#L968-L978).

All 27 tests in SilverScript's `covenant_declaration_security_tests` passed
locally, including seven singleton-transition cases. This supports the
compiler API, but these are **not tests of our hash-chain contract**. Before
shipping, build and verify a pinned deployable ABI artifact, instantiate with
real owner/guard values, construct genesis and two successive spends, and run
both valid and adversarial transactions through the target Rusty-Kaspa
consensus and funded Testnet-10 path. Compute script units, v1 compute budget,
storage mass and fee from the final signed witness. A partial witness may be
cheaper to serialize than the completed one, and only the latter can establish
the actual cost and validity. [KIP-13 mass](https://github.com/kaspanet/kips/blob/e4ae2332117b5cb68bd6188e065ef885b6d17939/kip-0013.md#L81-L108).

### x402 protocol compatibility

Snapshot: [`x402-foundation/x402` `749653343bfbbe82fde9f31fdcbb2349b426a460`](https://github.com/x402-foundation/x402/tree/749653343bfbbe82fde9f31fdcbb2349b426a460),
checked 2026-09-22. x402 v2 permits scheme-specific fields in
`PaymentRequirements.extra` and `PaymentPayload.payload`; the Kaspa network
binding can introduce an optional hash-chain profile while retaining the
standard `exact` envelope. Do not silently reinterpret our existing
`profile: "additive"`: it requires a same-script successor and accepts a
fully signed transaction. Clients that do not support the new profile must
skip its offer; `standard-native` and batch-settlement remain separately
selectable.
[x402 wire schemas](https://github.com/x402-foundation/x402/blob/749653343bfbbe82fde9f31fdcbb2349b426a460/specs/x402-specification-v2.md#L250-L367),
[current Kaspa exact binding](../spec/kaspa-exact-v2.md),
[current profile boundary](../docs/native-profile-boundary.md).

**Payment flow is an RC2 compatibility item even without the new covenant.**
The current x402 v2 spec says that a non-`authorization` flow must advertise
`extra.paymentFlow`. `upfront` is `settle → resource → respond`; `/verify` is
read-only and is not part of that ordering. Our exact server broadcasts and
waits for accepted finality *before* executing the protected handler, but its
offers presently contain no `paymentFlow`. That leaves upstream clients to
infer the default `authorization` flow incorrectly. Specify and advertise
`paymentFlow: "upfront"` for Kaspa exact methods that settle first, teach
offer selection to recognize or skip flows as required, and update vectors,
requirements hashes, and documentation. The hash-chain method should follow
the same upfront ordering: validate and broadcast the payer's fully signed
transaction before the protected handler. This is a finding against the current upstream spec, not
a claim that RC1 transactions failed on Testnet-10.
[x402 flow rules](https://github.com/x402-foundation/x402/blob/749653343bfbbe82fde9f31fdcbb2349b426a460/specs/x402-specification-v2.md#L425-L455),
[x402 exact flow](https://github.com/x402-foundation/x402/blob/749653343bfbbe82fde9f31fdcbb2349b426a460/specs/schemes/exact/scheme_exact.md#L207-L229),
[local lifecycle](../spec/kaspa-exact-v2.md#settlement-lifecycle).

The upstream exact scheme allows a client-signed transaction that a
facilitator later submits, including a self-funded network fee, and makes
network replay plus atomic duplicate-delivery control binding requirements.
The selected [native-KAS binding](../spec/kaspa-hash-chain-exact-v1.md) uses
the upstream client-submitted branch of that family: **the payer signs the
head input with the released one-time key and signs its own funding inputs,
then broadcasts and presents the complete transaction**. No merchant
signature is added at settlement. Our v1 transaction-ID code
excludes signature scripts, compute budgets and mass from the ID preimage,
while the complete transaction hash includes them; nevertheless, the final
signed artifact must be validated under Rusty-Kaspa consensus. Persist the
exact signed artifact and derive fee/mass from it. The upstream Aptos binding
shows a separate optional cosigning pattern, but adopting that as the primary
mode here would lose the delegated OTP-like behavior Michael described.
[x402 exact facilitator-submitted rules](https://github.com/x402-foundation/x402/blob/749653343bfbbe82fde9f31fdcbb2349b426a460/specs/schemes/exact/scheme_exact.md#L214-L229),
[local v1 ID code](../packages/covenant/src/tx-v1.ts).

**`payTo` needs an explicit new binding rule.** The current additive profile
advertises the current head P2SH address; its successor uses the same script,
so the recipient address remains stable. A hash-chain successor has a *new*
P2SH address. Advertising the old head as `payTo` while paying only the new
one would be misleading and might violate exact's requirement for an
identifiable transfer of `amount` to `payTo`. A plausible new rule is to make
`payTo` the **expected successor address**, advertise the current head
outpoint/script separately, and define the identifiable payment as the exact
net value increase within the merchant-owned covenant lineage. This is an
interpretation requiring a normative Kaspa binding and interoperability
review; do not assume every generic x402 wallet already understands a
changing recipient address or net-delta accounting.
[x402 `payTo` meaning](https://github.com/x402-foundation/x402/blob/749653343bfbbe82fde9f31fdcbb2349b426a460/specs/x402-specification-v2.md#L294-L303),
[x402 exact transfer correctness](https://github.com/x402-foundation/x402/blob/749653343bfbbe82fde9f31fdcbb2349b426a460/specs/schemes/exact/scheme_exact.md#L216-L229),
[local additive payTo rule](../spec/kaspa-exact-v2.md#additive-profile).

The binding must define its `assetTransferMethod` family, self-funded fee,
validity window, head/UTXO replay primitive, duplicate-submission behavior,
and the point at which a stale or owner-revoked grant becomes invalid. The
current x402 payment payload can remain a complete signed transaction, but
the client needs a v1 covenant builder and a way to receive the private grant
before signing. Define the grant handoff explicitly: a public `402` may carry
the head and successor commitment but must not leak the one-time private key;
an authenticated or encrypted delivery should bind the issuance record to the
request, payer identity if available, head version, and grant ID. This binding
controls which request may receive service, while the bare KCC20-style grant
remains capable of any positive head transition until spent or owner-revoked.
The server must verify the accepted transaction against the issued historical
head, exact price, request and grant record before claiming replay evidence
and serving the resource. Keep the existing request hash, requirements hash,
`payment-identifier`, finality, replay and ambiguous-broadcast recovery
controls.
[x402 mechanism requirements](https://github.com/x402-foundation/x402/blob/749653343bfbbe82fde9f31fdcbb2349b426a460/specs/schemes/exact/scheme_exact.md#L214-L229),
[local exact payload](../spec/kaspa-exact-v2.md#paymentpayload),
[local verifier](../packages/server/src/types.ts).

## Implementation checkpoint (2026-09-22)

The historical [head-v1 contract](https://github.com/elldeeone/kaspa-x402/blob/724c5fff22de500fcf729c43b59d25036fbffa9c/contracts/kaspa-x402-hash-chain-head-v1.sil)
implements the KCC20-derived BLAKE3 link and one-time Schnorr signature,
same-ID successor, owner guard rotation and owner sweep. Its SilverScript
artifact is reproducibly pinned to compiler commit `3ed9733` by
[`generate-hash-chain-fixture.mjs`](../scripts/generate-hash-chain-fixture.mjs).
The [consensus vector](../vectors/hash-chain/consensus-v1.json) records two
successive delegated spends and negative cases under Rusty-Kaspa
`c338d495`. The [durable issuer](../packages/server/src/hash-chain-grants.ts)
encrypts keys at rest, commits one payer assignment before delivery, and
tracks consumed, abandoned, rotated and reorg-held heads. These are local
implementation and consensus proofs; they are not funded Testnet-10 or
end-to-end x402 service proof. The client wallet and settlement integration
remain later implementation steps.

## Recommended build decision and proof order

1. **Specify a genuine sender grant.** Keep the KCC20
   `H(revealed_guard || one_time_pubkey)` check and release exactly one current
   predecessor guard plus private key to one payer. The payer can construct,
   sign and submit a valid positive head transition without a merchant
   signature. State plainly that the key is a bearer capability for one
   accepted head transition, not a price-, request- or time-bound token.
2. **Write the new exact binding and issuance lifecycle.** Give it a distinct
   profile/template ID, a specific `payTo` and successor-net-gain rule,
   `paymentFlow: "upfront"`, an `assetTransferMethod`, a full v1 signed
   transaction artifact, private grant-delivery mechanism, one-live-grant
   policy, fee/mass limits, and chain exhaustion/revocation/reorg behavior.
   Explain how a client obtains a grant without exposing it in a public
   `402`. Add the same explicit flow metadata to the existing pre-handler
   exact offers as an RC2 compatibility fix.
3. **Prove delegated spending and owner recovery.** Use the pinned compiler
   artifact and Rusty-Kaspa consensus to validate genesis, two consecutive
   *payer-only* correctly signed head transitions, SIGHASH_ALL commitment,
   owner termination and same-ID guard rotation, exact net amount, fees and
   mass. Include an intentionally underpaid yet consensus-valid spend to
   prove that the x402 service rejects it and recovers the new head safely;
   include the other negative cases from the prototype section.
4. **Then integrate the whole x402 path.** Extend schemas, vectors, client
   wallet/builder, grant issuer and durable head/key store, verifier, server,
   facilitator, CLI and offer selection. Preserve old profiles. Prove grant
   theft/abandonment, concurrent requests, stale challenges, ambiguous
   broadcast, owner-revocation races, reorg, duplicate delivery, and old-client
   behavior.
5. **Treat release as a separate gate.** Satisfy the repository's
   [new-profile readiness bar](../docs/native-profile-boundary.md#readiness-expectations),
   run the full release validation and fresh funded Testnet-10 proof on the
   exact candidate commit, inspect package contents, and review audit/mainnet
   gates. This feature can be one RC2 component; the research and local
   prototype do not themselves make the branch or project RC2-ready.

The current head-v2 removes the forced sighash flag while keeping signature
verification and covenant guards. The September implementation and proof
checkpoints above describe head-v1, not fresh evidence for head-v2.
