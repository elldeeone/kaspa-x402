# Native profile boundary

This is the capability map for the development Testnet-10 implementation.
Definitions live in the [glossary](../CONTEXT.md); verification scope and
historical template versions live in the [evidence index](evidence.md).

| Scheme / profile | Binding | Payment mechanism | Specification |
| --- | --- | --- | --- |
| exact / standard-native | kaspa-exact-v2 | One ordinary merchant output for the advertised amount. | [Exact](../spec/kaspa-exact-v2.md) |
| exact / additive | kaspa-exact-v2 | Exact increase of a reusable KIP-10 head. | [Exact](../spec/kaspa-exact-v2.md#additive-profile) |
| exact / hash-chain-additive | kaspa-hash-chain-exact-v1 | Exact increase and guard transition of a KIP-20 head using a privately assigned one-time signing grant. | [Hash-chain exact](../spec/kaspa-hash-chain-exact-v1.md) |
| batch-settlement | kaspa-escrow-v3 | Funded escrow, cumulative vouchers, partial claims, top-ups and timed refunds. | [Batch](../spec/kaspa-batch-settlement-v3.md) |

All settle native KAS. There is no KCC20 settlement or runtime support for other
x402 schemes. Mainnet is a reserved profile with [unclosed gates](mainnet-readiness.md).

[SDK configuration](integration.md) enables batch explicitly. Exact-only
integrations need no batch funding, voucher or refund dependencies. Client offer
selection still requires a complete payer policy and capable adapters for each
selected scheme. This changes SDK configuration, not wire bindings or schemas.

## Boundary Rules

- Public schemas accept only `exact` and `batch-settlement`.
- Payment payloads accept only `exact-transaction`, `deposit-voucher`, `voucher`,
  `claim`, and `refund`.
- Kaspa requirements extras accept `kaspa-exact-v2`,
  `kaspa-hash-chain-exact-v1`, and `kaspa-escrow-v3`.
- Covenant helpers include escrow deposit/claim/top-up/refund, KIP-10 additive,
  and hash-chain head, borrow, owner-rotation, and owner-sweep support.
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
