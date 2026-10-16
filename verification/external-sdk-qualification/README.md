# External SDK qualification

This is test infrastructure for the four existing native payment profiles. It
does not add a production backend, publish a package, deploy the demo, or spend
funds. Profile inventories describe the public interfaces and failure modes
chosen before writing the harnesses.

The consumer lives outside the repository. Public SDK runtime imports resolve
to the four approved package archives. The private adapters and facilitator are
explicitly packed as source-support fixtures: adapters provide the real native
transaction verifier, while the documented mock examples use the facilitator.
They are not represented as public release packages.

## Reproduce the controlled campaign

Use the Node/npm setup required by `protocol/`. Obtain the reviewed SDK bundle,
its full source revision and the independently approved manifest digest from CI.
The source checkout must match that bundle; the preparation command verifies the
source fingerprints and builds the private support packages.

```sh
node verification/external-sdk-qualification/prepare.mjs \
  --bundle /private/approved-sdk-bundle \
  --revision FULL_SOURCE_COMMIT \
  --manifest-sha256 APPROVED_DIGEST \
  --out /private/new-external-consumer
node /private/new-external-consumer/run.mjs
```

Use a fresh output directory. Preparation installs actual archives without
workspace links or dependency lifecycle scripts, copies fixture inputs and test
scripts, and records their hashes. The external runner checks those fingerprints
and retains each command's logs plus `qualification-report.json`. Each profile
also retains its own detailed report and reproduction instructions.

## Evidence boundaries

- The controlled campaign exercises real HTTP, MCP SDK interfaces, Schnorr
  signatures, public transaction builders, concurrent retries, deliberately
  uncertain outcomes and selected-chain changes supplied at adapter boundaries.
- Example chain facts and stress acceptance observations are simulated. Real
  signature verification is reported separately from those observations.
- Memory store/server recreation tests do not establish operating-system crash
  durability. Hash-chain issuer reopening does exercise real SQLite, including
  independent-process readback.
- MCP over HTTP is a narrow JSON-RPC carrier for SDK tool calls, not a complete
  MCP transport interoperability certification.
- This is bounded functional stress. Counts and configured concurrency are
  evidence, not production throughput or availability claims.
- No helper here silently starts a funded run. Funded Testnet proof uses a
  separate private external runner, isolated wallets, preflight, explicit fee
  and transaction caps, and a fingerprinted installed-package runtime.

## Funded campaign handoff

The 2026-10-16 campaign's external funded runner and report are retained in its
private evidence directory. It copies the current proof scripts and vectors,
records each path adaptation, and resolves runtime imports to installed SDK
archives. Local wallet paths and RPC configuration are deliberately excluded
from this repository. Retain every failed attempt and any unspent channel/head
output; never overwrite a failed funded report with a retry.

Only the exact archive hashes and runtime/source fingerprint named by a report
are qualified. A changed SDK archive requires rerunning affected scenarios and
final candidate evidence. A controlled reorg or one-source funded Testnet run
does not establish mainnet acceptance or independent operator corroboration.
