# Native Profile Boundary

Status: active alpha boundary for the shipped package surface.

The current native Kaspa x402 surface ships two profiles:

- `exact` with `kaspa-exact-v1` for fixed-price one-shot transfers;
- `batch-settlement` with `kaspa-escrow-v1` for repeated or variable-cost
  requests backed by a funded escrow/channel.

Both profiles are represented in schemas, vectors, examples, public specs,
runtime packages, and the live proof harness. Other x402 schemes are outside
the shipped compatibility contract until they can be expressed with native
Kaspa validation and covered by the same level of schemas, vectors, tests, and
live evidence.

## Asset Boundary

The shipped profiles settle native KAS only. `kaspa-exact-v1` verifies that a
Kaspa transaction pays the required sompi amount to the required script public
key, and `kaspa-escrow-v1` settles native KAS from a funded escrow/channel.

## Absent Upstream Schemes

Upstream x402 currently defines four schemes: `exact`, `upto`,
`batch-settlement`, and `auth-capture`. This binding ships the first and
third. The other two share one blocking constraint: UTXO-style script supports only
lower-bound time locks, because a once-valid transaction must not become
invalid. A settlement-expiry upper bound therefore cannot be a hard spend-path
invalidation; it can only be expressed as a race in which a refund branch
becomes spendable at the deadline and a late-settling counterparty can be
beaten by the client's refund. Upstream batch-settlement already accepts this
escape-hatch model for its timed withdrawal delay, which is why the shipped
escrow profile is unaffected by the constraint.

### upto

Kaspa covenants can enforce every fund-safety property of a one-shot capped
authorization on-chain: server signature, client authorization digest, charge
cap, single-use outpoint binding, payout and refund output hashes, and a
bounded fee reserve. Only the expiry bound degrades to the refund race
described above. Upstream `upto`, however, currently defines its time-bound
requirement only through hard contract-enforced deadlines. Shipping a
race-based expiry under that scheme name would overstate the guarantee, so the
profile remains archived research until upstream clarifies whether a
client-refundable expiry satisfies `upto`'s time-bound requirement. If it
does, the archived covenant and its consensus-validated artifacts are a viable
basis for reintroduction.

### auth-capture

`auth-capture` maps naturally to Kaspa: the authorization is a funded covenant
output — a real on-chain hold, stronger than an allowance-style hold — and
capture is a bounded claim, with the same expiry-by-refund-race caveat as
`upto`. It is absent for priority rather than feasibility: upstream currently
has a single EVM binding and little adoption pressure, and any new profile
must clear the full readiness bar below before it can ship.

## Boundary Rules

- Public schemas accept only `exact` and `batch-settlement`.
- Payment payloads accept only `exact-transaction`, `deposit-voucher`, `voucher`,
  `claim`, and `refund`.
- Kaspa requirements extras accept only `kaspa-exact-v1` and
  `kaspa-escrow-v1`.
- Covenant helpers expose only the escrow template and batch claim/refund
  transaction builders.
- Client, server, facilitator, and CLI packages must not advertise or accept
  unsupported schemes.
- The boundary is enforced at different points on the two sides of the wire:
  servers emit only strict Kaspa envelopes, while clients parse incoming
  `PaymentRequired` envelopes leniently, skip entries for other schemes,
  networks, or assets during offer selection, and pay only entries that
  validate as Kaspa requirements. A client fails an offer only when no
  supported Kaspa entry remains, so mixed multi-rail envelopes from upstream
  x402 servers stay consumable.
- Documentation and examples must frame `kaspa:mainnet` as a reserved profile
  name, not a readiness claim.

## Readiness Expectations

New native profiles require all of the following before they can be shipped:

- a scheme-specific spec under `spec/`;
- JSON schema coverage for requirements, payloads, and settlement responses;
- positive and negative conformance vectors;
- SDK and server implementation coverage;
- package tests for client, server, facilitator, and CLI behavior;
- transaction-v1 vectors when the profile builds covenant transactions;
- live `kaspa:testnet-10` evidence through `scripts/proof-live-testnet.mjs`;
- explicit mainnet readiness gates and audit scope updates.

Until those conditions are met, unsupported schemes should fail schema
validation or offer selection rather than being represented as partial runtime
features.
