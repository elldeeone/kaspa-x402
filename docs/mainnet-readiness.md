# Mainnet Readiness

Status: mainnet is blocked. `kaspa:mainnet` is a reserved draft profile name,
not a production readiness claim.

The current shipped native profiles are:

- `exact` with `kaspa-exact-v1`;
- `batch-settlement` with `kaspa-escrow-v1`.

`kaspa:testnet-10` is the active validation target. Mainnet must remain opt-in
and disabled by default until every gate below is closed.

## Required Gates

### Independent Audit

Audit scope must include:

- exact transaction verification, replay protection, and finality policy;
- batch escrow script, fixture reproducibility, claim path, refund path, and
  transaction-v1 builders;
- payment-identifier and channel state-store durability;
- client funding-source policy enforcement;
- facilitator capability intersection and action authorization;
- live adapter recovery behavior and operator key handling.

Audit output must include explicit pass/fail status for exact and
batch-settlement. A testnet-only pass is not sufficient for mainnet.

### Consensus Cross-Validation

The transaction-v1 vectors for batch claim and batch refund must be
cross-validated against the configured Kaspa consensus checkout:

```sh
KASPA_X402_KASPA_CONSENSUS_ROOT=<rusty-kaspa-checkout> npm run validate:tx-v1-consensus
```

The recorded validation level must be refreshed whenever consensus code,
transaction serialization assumptions, fixture scripts, fee policy, or compute
budget assumptions change.

### Durable State

Production deployments must use a durable transactional store that satisfies
`docs/server-store-contract.md`. In-memory stores are not acceptable for
mainnet because they cannot preserve replay, payment-identifier, and channel
state across process loss.

### Operational Recovery

Operators need documented recovery procedures for:

- exact transaction reservation conflicts;
- batch deposit broadcast and finality waits;
- voucher commitment persistence;
- claim/refund transaction broadcast and finality waits;
- node/indexer outage handling;
- adapter crash recovery without double execution.

### Live Evidence

Before any mainnet release candidate, a fresh funded `kaspa:testnet-10` run
must pass:

```sh
npm run proof:live:check -- --live --write-report
```

The sanitized report in `docs/live-testnet-report.md` must show exact replay
rejection, batch deposit-voucher settlement, voucher-only settlement, claim,
replay rejection, and refund evidence.

### Release Controls

Mainnet enablement must require explicit configuration. Packages, examples, and
docs must continue to describe mainnet as reserved until audits, durable store
requirements, live evidence, and operator runbooks are complete.
