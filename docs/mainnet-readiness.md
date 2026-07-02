# Mainnet Readiness

Status: not mainnet-ready.

This repository defines draft Kaspa x402 bindings and a reference implementation. It has deterministic vectors, offline proof, and a live testnet proof, but those artifacts do not authorize production mainnet use.

Mainnet support must remain opt-in, explicitly configured, and blocked by the gates below.

## Required Audits

Mainnet use requires independent review of:

- the exact transaction verifier, including transaction id derivation, selected output validation, finality handling, and replay-store durability;
- the upto authorization digest, signer, verifier, nonzero settlement transaction-v1 builder, settlement verifier, refund-output accounting, finality recovery, and authorization-store durability;
- the batch escrow template source, compiled artifact, script arguments, voucher digest, claim/refund transaction-v1 builders, compute-budget assumptions, storage-mass assumptions, and live adapter;
- the server state store, including atomic settlement commits, idempotency records, claim attempts, replay stores, channel state, and cross-process locking;
- the client channel store, including backup, recovery, refund readiness, and stale-state handling;
- the funding provider and signer adapters, including network selection, spend caps, key isolation, secret redaction, and policy-required funding source enforcement;
- the facilitator wrapper, if used, including authentication, tenant isolation, supported-kind policy, rate limits, settlement authority, and incident controls.

Audit outputs must include explicit pass/fail status for exact, upto, and batch-settlement. A testnet-only pass is not sufficient for mainnet.

## Key Management

Do not use hot-wallet mode for unrestricted mainnet funds.

Minimum production requirements:

- separate client funding keys, client channel keys, client refund keys, server voucher/claim keys, and server payout keys where the deployment architecture permits;
- vault, HSM, hardware-wallet, or policy-engine custody for treasury balances;
- per-network and per-resource spend caps;
- explicit funding source policy, with failed closed behavior when the required source is unavailable;
- key rotation plan for client channel keys, server keys, payout addresses, refund addresses, and facilitator credentials;
- encrypted backups for channel state and refund-capable signing material;
- redacted logs, reports, CI output, and support bundles.

Known limitation: the reference types expose hot-wallet and external adapter modes, but they do not implement a production custody system.

## Fee And Compute-Budget Policy

Batch claim, batch refund, and nonzero upto settlement transaction-v1 artifacts currently pin:

- native subnetwork;
- zero gas;
- contextual storage mass;
- reviewed script-unit estimates;
- explicit compute budgets;
- claim fees paid from the server output;
- refund fees paid from the refund output;
- nonzero upto fees paid from the signed settlement reserve.

Before mainnet:

- fee policy must be parameterized for live network conditions;
- claim reserve policy must include a margin above estimated fees;
- dust thresholds must be measured against current node policy;
- transaction-v1 builders must be tested against current node software;
- transaction-v1 vectors must be cross-validated against the exact node release used by operators;
- the live proof harness must be rerun after any transaction-builder, node, or template change.

## Template Hash

The batch escrow template id is `kaspa-x402-escrow-v1`.

Current reproducibility checks cover:

- source hash from `contracts/fixtures/kaspa-x402-escrow-v1.json`;
- domain tag hash;
- deterministic redeem script;
- serialized script public key;
- payout and refund script-public-key hashes;
- claim and refund argument encodings;
- claim, refund, and nonzero upto settlement transaction-v1 vectors.

Before mainnet:

- publish the exact template source hash and fixture hash in release notes;
- pin compiler and node versions used for the reviewed artifact;
- reject deployment when local template hash differs from the reviewed hash;
- rerun fixture reproducibility and transaction-vector checks in CI.

## Package Versions

Current packages are draft reference packages under `@kaspa-x402/*`.

Before mainnet:

- cut a tagged release with immutable package versions;
- publish matching spec, schema, vector, and package artifacts;
- include a migration policy for any field, schema, or binding changes;
- freeze supported network strings and binding labels for that release;
- include the live testnet report generated from the release candidate;
- require consumers to pin exact package versions instead of floating ranges.

## Incident Response

Operators need a runbook before handling mainnet funds.

Refund timing is DAA-based. A batch channel is refund-mature only when the current virtual DAA score is greater than or equal to the channel's advertised `refundTimeoutDaa`; before that point, clients should expect refund builders to fail closed and should not assume funds are recoverable without the server claim path. Longer timeouts reduce premature refunds but increase client capital lockup, and shorter timeouts increase the chance that a server claim races a client refund.

At minimum:

- pause protected routes or facilitator settlement;
- stop opening new batch channels;
- stop accepting new upto authorizations;
- disable claim automation if claim builder or node behavior is suspected;
- broadcast refunds for affected client-controlled channels only after the DAA timeout is mature and the active outpoint is still current;
- rotate compromised server, facilitator, payout, funding, and refund keys;
- preserve replay, idempotency, channel, claim-attempt, authorization, and transaction logs;
- publish affected networks, package versions, template hash, transaction ids, and mitigations;
- provide client recovery instructions for local channel state and refund paths.

## Known Limitations

- Mainnet profile is not audited.
- Deterministic transaction-v1 vectors and live testnet proof are not substitutes for independent audit.
- Live proof evidence is testnet-only.
- The local live adapter is intentionally outside the public package boundary.
- In-memory stores are examples only and are not production durable stores.
- Hot-wallet mode is a development convenience, not a custody recommendation.
- Facilitator authentication and tenant isolation are not provided by the reference package.
- Fee policy, dust policy, and finality policy need operator-specific configuration.
- External node/RPC correctness and availability are deployment risks.
- Key compromise response depends on external custody and monitoring systems.

## Current Verdict

The project is ready for further review and testnet iteration. It is not ready for production mainnet funds until every audit and operational gate above is completed and documented.
