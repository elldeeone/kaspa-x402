# Domain language

This glossary names the protocol concepts used by the active Kaspa x402 source.
Historical release snapshots retain the language of the release they record.

## Exact payment

A payment for one request whose price is known before protected work begins. An
exact payment transfers precisely the advertised native-KAS amount to the
merchant. The active alpha supports two exact profiles.

## Standard-native exact

The default exact profile. The payer signs a standard native-KAS transaction
that contains one merchant output for the advertised amount and, optionally,
one payer change output. It has no merchant input and no covenant head.

## Additive exact

The optional exact profile built with the additive P2SH pattern enabled by
KIP-10 transaction introspection. The payment is the exact increase from the
current merchant head to its same-script successor. It has no separate merchant
payment output.

## Head

The current unspent output in one merchant additive chain. A head is replaced
by a same-index, same-script successor whose value increases by the exact
payment. A head is reusable across challenges until one valid transaction wins
the atomic transition to its successor.

## Head pool

A set of independent additive heads used for concurrency and operational risk
isolation. The head-pool module owns selection, atomic transitions, settlement
stages, reconciliation, rotation, and unavailable state.

## Challenge

Server-issued exact terms for a paid retry. Reading an additive head to issue a
challenge does not reserve, consume, or retire that head. A challenge expires,
but an unspent head does not expire with it.

## Settlement evidence

The signed transaction artifact plus independently established UTXO, script,
signature, mass, fee, broadcast, and finality facts. Client-supplied UTXO
metadata or transaction identifiers are not authoritative evidence.

## Batch settlement

The capital-backed `kaspa-escrow-v2` mechanism for repeated small or
variable-cost requests. The buyer signs lifetime cumulative voucher ceilings;
the provider may settle those ceilings through partial claims. Top-ups add
capacity without resetting the settled lifetime total, and the buyer retains a
timed refund path. It remains separate from both exact profiles and is supported
on `kaspa:testnet-10` only.

## Batch covenant identity

The KIP-20 `covenantId` that identifies one `kaspa-x402-escrow-v3` channel and
enforces its successor lineage. The ID is stable across claims and top-ups, but
it does not locate the live UTXO; the runtime must persist and reconcile the
current outpoint separately.

## Batch channel state

The current outpoint, remaining funding, actual-charge lifetime total, settled
lifetime total, and latest buyer-signed lifetime ceiling for one batch covenant
identity. Alpha.11 replaces the earlier active batch state outright; runtimes do
not import or interpret older-alpha channel state. Historical tagged releases
remain unchanged.

The accounting shorthand is A for lifetime actual charges, S for lifetime gross
claimed, T for the latest buyer-signed lifetime ceiling, V for current covenant
value, and R for the advertised minimum successor reserve. Durable runtimes
reload the current head and unresolved transition attempts after restart.
