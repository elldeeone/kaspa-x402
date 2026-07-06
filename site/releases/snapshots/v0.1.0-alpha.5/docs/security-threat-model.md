# Security Threat Model

Status: alpha threat model for the shipped exact and batch-settlement profiles.

## Assets

- client funds in exact payments and batch escrow channels;
- server revenue outputs and claim authority;
- client refund authority for batch channels;
- signing keys for exact payments, vouchers, claims, and refunds;
- durable payment-identifier, replay, and channel state;
- protected HTTP resources and MCP tool results.

## Trust Boundaries

- client wallet, funding, signing, and address-codec adapters;
- server verification, settlement, and state-store adapters;
- Kaspa RPC/node/indexer finality observations;
- optional self-hosted facilitator endpoints;
- operator live-testnet adapters and recovery journals.

## Core Threats

| Threat | Mitigation | Residual risk |
| ------ | ---------- | ------------- |
| Exact transaction replay | Exact payment identity includes network, transaction id, and output index. State stores reserve the identity before handler execution. | Production stores need atomic compare-and-set behavior across workers. |
| Batch voucher replay or regression | Channel state tracks active outpoint, cumulative amount, and voucher commitments. Older or conflicting vouchers are rejected. | Production operators need durable channel state and recovery journals. |
| Duplicate retry double-executes protected work | Payment identifiers bind request fingerprint, payload hash, and payment scope. Same id plus same fingerprint returns cached state; conflicts fail. | Deployments must make payment-identifier writes transactional. |
| Handler failure consumes payment state | Payment state is committed only after protected handler success unless the flow has an explicit recoverable settlement state. | Product terms still need to define any billable work exceptions. |
| Stale node or RPC failure | Verification fails closed unless required finality evidence is present. | Operators must monitor node health and finality lag. |
| Funding source policy bypass | Client code checks required funding source against adapter-reported funding source. | Wallet and treasury adapters still require independent audit. |
| Malicious facilitator widens capability | Facilitator supported kinds are intersected with direct-mode server capability and explicit action settlers. | Hosted facilitators need authentication, rate limits, and tenant isolation. |
| Covenant template drift | Escrow fixture checks and transaction-v1 vectors pin script-public-key, hash, fee, and output behavior. | Mainnet requires an independent covenant and transaction-builder audit. |

## Exact Profile

The exact profile validates a native Kaspa transaction that pays the advertised
amount to the advertised recipient output. Verifiers derive transaction id,
output script, and output amount from the transaction body rather than trusting
payload hints.

Required checks include:

- accepted requirements match a server offer exactly;
- network, asset, amount, recipient, and binding are unchanged;
- transaction id, when supplied, matches the transaction body;
- selected output index exists and pays exactly the required amount;
- the transaction/output identity has not already been consumed;
- finality satisfies the server policy before protected content is released.

## Batch-Settlement Profile

The batch profile uses a funded escrow/channel UTXO and cumulative signed
vouchers. The server can claim charged value later; the client can refund
remaining value after the timeout.

Required checks include:

- channel id and active outpoint are derived from verified channel material;
- voucher amount is cumulative and never regresses;
- claim amount is bounded by signed voucher amount and active input amount;
- continuation output preserves uncharged channel value;
- refund lock time and sequence satisfy the timeout path;
- claim and refund transaction-v1 artifacts reconcile input, output, and fee
  accounting.

## State Store Requirements

Production stores must provide atomic operations for:

- exact transaction/output reservation;
- payment identifier reservation and conflict detection;
- batch channel creation and active outpoint updates;
- voucher commitment compare-and-set;
- claim/refund state transitions;
- cached paid response lookup for idempotent retries.

In-memory stores are test fixtures only.

## Live Proof Boundary

The live proof runner validates evidence supplied by a live adapter. The
committed reference adapter in `scripts/live-adapter-reference.mjs` is a
reviewable testnet harness, not a production wallet, broadcaster, recovery
journal, or settlement service. It receives RPC, funding, and SDK paths from
operator environment variables and writes generated signing material under the
ignored live data directory.

Live testnet success demonstrates alpha flow execution only; it is not a
mainnet approval or audit substitute.
