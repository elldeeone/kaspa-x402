# Domain language

This glossary names the protocol concepts used by the active Kaspa x402 source.
Historical release snapshots retain the language of the release they record.

## Exact payment

A payment for one request whose price is known before protected work begins. An
exact payment transfers precisely the advertised native-KAS amount to the
merchant. Alpha.8 supports two exact profiles.

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

The existing capital-backed escrow and cumulative-voucher mechanism for
repeated small requests. It remains separate from both exact profiles.
