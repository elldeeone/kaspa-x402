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

## Boundary Rules

- Public schemas accept only `exact` and `batch-settlement`.
- Payment payloads accept only `exact-transfer`, `deposit-voucher`, `voucher`,
  `claim`, and `refund`.
- Kaspa requirements extras accept only `kaspa-exact-v1` and
  `kaspa-escrow-v1`.
- Covenant helpers expose only the escrow template and batch claim/refund
  transaction builders.
- Client, server, facilitator, and CLI packages must not advertise or accept
  unsupported schemes.
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
