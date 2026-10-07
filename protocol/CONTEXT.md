# Kaspa x402 domain language

Names used by the protocol and its reference implementation. See the
[capability map](docs/native-profile-boundary.md) for bindings and specifications.

## Language

**Exact payment**: A payment of the advertised amount for one request whose
price is known before protected work begins. Its profiles are standard-native,
additive and hash-chain-additive.

**Standard-native exact**: An ordinary native-KAS transaction with one merchant
output for the advertised amount and optional payer change; it has no merchant head.

**Additive exact**: A KIP-10 payment measured by the exact increase from a
merchant head to its same-script successor, with no second merchant payment output.

**Hash-chain-additive exact**: A KIP-20 payment measured by the exact increase
from a merchant head to a successor with the next hash guard, authorized by a
privately assigned one-time signing grant.

**Head**: The current unspent merchant output in an additive payment lineage.
A KIP-10 successor keeps its script; a hash-chain successor changes its guard and script.

**Head pool**: Independent KIP-10 heads available for concurrent payment attempts.

**Challenge**: Server-issued terms for a paid retry. Reading a KIP-10 head does
not reserve it; a hash-chain challenge requires scarce-grant admission.

**Grant**: The private one-time signing key and revealed guard assigned to one
hash-chain payer and challenge. Expiry does not revoke an already disclosed key.

**Settlement evidence**: A signed transaction artifact with independently
established input, script, signature, fee and selected-chain acceptance facts.
Client-provided transaction IDs or UTXO metadata alone are not evidence.

**Batch settlement**: Repeated fixed-price requests backed by one funded
covenant, buyer-signed cumulative ceilings, partial merchant claims and a timed refund.

**Covenant identity**: The stable KIP-20 `covenantId` of a lineage, distinct from
its changing current outpoint; the ID is not a live-UTXO lookup mechanism.

**Batch channel state**: The live covenant head and lifetime accounting:
A committed charges, S gross claimed, T signed ceiling, V current value and
R required reserve.

**Transaction signature scope**: The consensus-supported sighash type encoded
in each transaction signature; it selects the fields covered by that signature.
Independent covenant guards still apply.
