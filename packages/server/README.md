# @kaspa-x402/server

Server SDK for direct-mode Kaspa x402 payments.

Status: release candidate. This package targets testnet iteration and reference server
flows; production deployments need independent review, durable storage, key
management, and the mainnet gates in the repository docs.

The current implementation covers framework-neutral HTTP gating and MCP paid tool wrappers for `exact` one-shot transfers and `batch-settlement` escrow channels:

- builds x402 v2 `PAYMENT-REQUIRED` offers;
- extracts and validates `PAYMENT-SIGNATURE` retries;
- verifies exact transaction output amount, pay-to script, transaction id, and finality through an injected verifier;
- defaults exact offers to `standard-native` and can optionally select, claim,
  and atomically advance reusable KIP-10 additive heads;
- verifies singleton KIP-20 genesis, the stable covenant ID, current outpoint,
  escrow script, immutable launch identity, append-only selected-chain lineage,
  and lifetime cumulative vouchers through injected adapters;
- serializes per-transaction or per-channel verification, handler execution, and state commit;
- stores exact transaction replay records before returning protected content;
- stores per-request settlement commitments before advancing channel charge state;
- supports payment identifier idempotency for exact and batch payment-payload retries;
- reserves payment identifiers and one per-channel operation owner atomically
  before protected work, preserving uncertain ownership across restart;
- returns corrective `402` responses without peer-usable channel metadata;
- returns MCP payment-required tool results, requires a trusted configured MCP
  server `audience` in the tool-call fingerprint, reads
  `_meta["x402/payment"]`, and attaches `_meta["x402/payment-response"]`
  without exposing protected content on settlement failure;
- requires batch MCP tools to configure `mcpErrorChargeSompi` explicitly; the
  value must equal the fixed accepted amount, is bound into payer-approved
  terms, and is the only non-zero charge permitted for an `isError` result;
- exposes direct verifier and settlement helpers used by optional self-hosted facilitator endpoints;
- validates custom per-request amounts when `PaidRequest.paymentAmount` is supplied;
- persists A/S/T/V lane state, enforces advertised reserve R, accepts same-ID
  top-ups, and exposes partial-claim execution and restart-recovery hooks with
  durable pending-attempt reconciliation.
- rejects multi-instance store/lock topologies that do not share one declared
  deployment coordination domain, and bounds durable attempts by aggregate,
  byte, per-payer, and terminal-response retention policies.

Public entry points enforce a configurable caller quota plus global,
per-caller, per-channel, and per-adapter concurrency limits. Inject one shared
`publicBoundaryController` across server instances when those limits must span
one process or isolate; the default controller is instance-local. Multi-isolate
deployments must add host-level distributed admission, as the reference gateway
does with renewable Durable Object leases. Adapter and protected-
handler calls use the configured `adapterTimeoutMs` deadline. Durable store and
lock operations retain admission permits while pending because releasing them
after an ambiguous timeout could violate settlement ordering; hosts should add
native health checks and deadlines to those dependencies.

Mainnet runtime use fails closed unless `allowMainnet: true` is set.

The reference Testnet-10 deployment applies a 30-confirmation policy proven by
authoritative selected-chain traversal. Accepting-block/checkpoint blue scores
bind the observation but do not derive selected-chain depth. Removed blocks are
reconciled before additions, current heads are derived from unique verified
transaction lineage, and incomplete or pruned continuity fails closed.

Node, indexer, address-codec, signature-verifier, transaction-builder, settlement-transaction-verifier, and state-store behavior is injected through typed adapters. Production deployments should back the state store with durable transactional storage that follows [the server store contract](../../docs/server-store-contract.md). Amounts on the wire remain decimal sompi strings.

Protected handlers run after payment verification and before the durable payment
commit. Handlers with non-repeatable side effects should require the
`payment-identifier` extension and keep their own idempotency or outbox record
keyed by payment identifier and request fingerprint.

After cached responses expire, immutable replay tombstones remain authoritative
but no longer consume active-attempt record, byte, or per-payer admission
capacity. Production stores must keep those tombstones in a scalable, monitored
index; replay history must not permanently prevent admission of new payments.

## Native-KAS hash-chain grant issuer (local implementation)

`@kaspa-x402/server/hash-chain-grants` is a separate Node-only entry point
(Node 22.13 or newer, where `node:sqlite` is available without a flag). It is
not exposed by the Worker-compatible package root. Connect it to the candidate
hash-chain x402 profile through `DirectModeServer`, and route the advertised
grant claim URL to `handleHashChainGrantClaimHttp`. Create it with a private
SQLite file, a caller-managed 32-byte encryption key, and a synchronous payer
eligibility/rate-limit callback. Store the encryption key separately from the
database and back it up; losing it loses outstanding grants. See the
[Node SQLite documentation](https://nodejs.org/download/release/v22.13.1/docs/api/sqlite.html)
for runtime support.

The issuer accepts Testnet-10 heads only. It reserves each one-time public key
across the store, including unreleased links, so a key cannot be assigned again
on another head or after rotation. If an accepted rotation names an invalid or
reused replacement chain, the issuer records the new head as `needsRotation`
and does not release that chain.
Opening a database created by an earlier local prototype backfills known keys
and quarantines its live heads until owner rotation.

The issuer checks each one-time private key and reverse hash link before
installation. It commits one payer's signed claim and an encrypted delivery
record before returning the key; identical live retries recover the same key.
The delivery record remains available after the head advances for later
settlement checks. Call `recordAcceptedBorrow` and `recordAcceptedRotation`
only with independently verified selected-chain evidence. A small positive
borrow advances the head, while an abandoned key remains live on-chain until
an owner rotation is accepted. An absent current head pauses issuance; a fresh
selected exact proof for the assigned grant can advance it from hold. A reorg
or unknown restored head otherwise stays on hold for reconciliation. An
accepted owner sweep retires the head and stops further issuance.

The [binding draft](../../spec/kaspa-hash-chain-exact-v1.md) defines the
private grant claim and x402 settlement rules. The candidate includes payer
claim and signing helpers, the grant HTTP handler, a selected-chain REST
adapter, and the transaction verifier. A [fresh funded Testnet-10 run](../../docs/hash-chain-live-proof.md)
against the final candidate remains a release gate.
