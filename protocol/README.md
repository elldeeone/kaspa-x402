# Kaspa x402 protocol

Start here to understand, verify or integrate the Kaspa binding. This folder is
an independently installable workspace: it contains the specifications, wire
schemas, contracts, SDKs, reusable chain adapters and their verification evidence.
The website and hosted gateway are consumers outside this folder.

This is a Testnet-10 reference implementation. The public SDK version remains
`1.0.0-rc.2`; current source uses escrow-v5/head-v2. Historical RC2 funded evidence
must not be treated as proof of these newer covenant templates. The
[evidence index](docs/evidence.md) links the completed development Testnet runs
and their limits. See [readiness gates](docs/mainnet-readiness.md) before making
deployment claims.

## Install and verify

Use the Node version in [.node-version](.node-version), npm and the Git CLI
(the source-pin tests create temporary Git repositories). Run from this folder:

```sh
npm ci
npm run verify
```

`verify` builds the seven packages, runs unit and integration tests plus the
upstream x402 compatibility prototype, validates schemas and signed HTTP/interoperability vectors,
checks committed covenant fixtures, runs offline proofs, and checks the four
public npm packages with `npm pack --dry-run`. It needs no website, Cloudflare,
wallet, node connection, sibling checkout or Git history.

For a shorter edit cycle, `npm test` builds, type-checks all seven packages
(sources and tests), and runs tests. `npm run typecheck` repeats only the type
checks after a build. After a build, use
`npm --workspace @kaspa-x402/adapters run test:self` for transaction-verifier work.
That command type-checks the adapter sources and tests before running Vitest.
To check the folder boundary itself, run `npm run check:protocol-isolation` from
the repository root. That copies only this folder to a temporary directory,
installs its own lockfile, runs client tests before other packages are built,
then runs the full `verify` command there.

## Read and integrate

1. Read the [binding](spec/kaspa-x402-v1.md), then the
   [exact](spec/kaspa-exact-v2.md) or
   [batch-settlement](spec/kaspa-batch-settlement-v3.md) scheme.
   The optional [hash-chain exact profile](spec/kaspa-hash-chain-exact-v1.md)
   builds on the exact scheme. Schemas define wire shape; the specifications
   also define signatures, request binding, settlement and replay rules.
2. Choose [exact-only or combined SDK configuration](docs/integration.md), then
   run the [mock HTTP, MCP and recovery examples](docs/adoption-examples.md).
   They show SDK integration without funded transactions.
3. Connect the server interfaces to a trusted chain source, persistent stores
   and the application's actual request/authentication context. Use
   [adapters](packages/adapters/README.md) for node evidence and exact verification;
   implement the [store](docs/server-store-contract.md) and
   [lock](docs/server-runtime-lock-contract.md) contracts for your host.
   The application must prevent settlement retries from repeating protected work.
4. For upstream x402 integration, read the
   [compatibility experiment](prototypes/x402-exact/README.md). It exercises
   `@x402/core` 2.28.0 through real HTTP interfaces with simulated chain settlement.
   Its server attestation is experimental; it is not a production facilitator.
   The [upstream readiness record](docs/upstream-readiness.md) separates spec
   review decisions from later SDK work and records current contribution rules.

See the [capability map](docs/native-profile-boundary.md),
[glossary](CONTEXT.md) and [evidence index](docs/evidence.md) for one place to
check supported profiles, terminology and the limits of each proof.

## Source map

| Path | Purpose |
| --- | --- |
| `spec/`, `schemas/` | Protocol rules and wire validation. Public schema IDs stay unchanged. |
| `contracts/` | SilverScript sources and pinned compiler artifacts. |
| `vectors/` | Valid/invalid envelopes, signed requests, transaction and interoperability vectors. |
| `packages/core/` | Wire types, validation, hashes and protocol calculations. |
| `packages/covenant/` | Script/transaction construction, signature scopes and covenant templates. |
| `packages/client/`, `packages/server/` | Reference payer and resource-server SDKs. |
| `packages/adapters/` | Exact verification, native addresses, REST/PNN clients and chain evidence. |
| `packages/facilitator/`, `packages/cli/` | Local facilitator service and inspection/recovery tooling. |
| `examples/`, `prototypes/` | Mock integration examples and bounded upstream compatibility experiment. |
| `test-support/` | Shared store contracts and deterministic test fixture setup. |
| `scripts/`, `tools/` | Fixture generation, offline/live proofs and pinned Rust consensus harnesses. |
| `docs/` | Integration contracts, threat model, release/evidence limits and reproduction instructions. |

Core, covenant, client and server are the four public packages. Adapters,
facilitator and CLI are private source workspaces; this move does not publish
new packages. Only selected specifications/mechanism work is a candidate for
upstream x402. This folder also contains the local reference implementation and
its evidence, not a proposal to upstream every file.

## External dependencies and proof limits

| Check or use | Dependencies and what it establishes |
| --- | --- |
| Local `verify` | Node/npm, Git and this lockfile. TypeScript, tsup, Vitest, Ajv, Noble cryptography and the pinned upstream x402 package are declared in manifests. Tests include malformed transactions, signatures, replay, stale state, reorg evidence and restart behavior. Mocked network results do not prove live acceptance. |
| SilverScript regeneration | A clean checkout at `3ed973335b59269293564805cc2c58a14595ec03`, Cargo and its compiler dependencies. Set `SILVERSCRIPT_DIR` explicitly. `npm ci` does not install this compiler. |
| Kaspa consensus validation | A canonical Rusty-Kaspa checkout at `01b532e8b553523216471682649693af92f0fd16` (2.1.0), Rust 1.95.0, a C/C++ build toolchain, clang/libclang, CMake and pkg-config. The harness has a committed Cargo lock and verifies the source pin. |
| REST/PNN integration | An operator-selected trusted node/service with the required full transaction, UTXO and selected-chain RPCs; native `fetch`/`WebSocket`. The PNN client currently requires Testnet-10. Persist evidence through the supplied store interface. |
| Funded Testnet proof | A compatible Kaspa WASM module, node RPC, separately supplied funding credentials and explicit live-run confirmation. See [live proof](docs/live-testnet-proof.md) and [hash-chain proof](docs/hash-chain-live-proof.md). The WASM module is supplied externally; the website's vendored copy is not required. |

Examples for the external checks, from this folder:

```sh
SILVERSCRIPT_DIR=/absolute/path/to/silverscript npm run check:hash-chain-fixture
RUSTUP_TOOLCHAIN=1.95.0 npm run validate:tx-v1-consensus -- --kaspa-root /absolute/path/to/rusty-kaspa
```

`npm run check:covenant-fixtures` checks the committed escrow artifact locally;
`npm run generate:covenant-fixture` recompiles it using `SILVERSCRIPT_DIR` and
writes the fixture. Paths recorded inside compiler/vector artifacts are relative
to this protocol folder; their historical bytes and signatures are retained.

Offline proof uses simulated adapters. Adapter restart tests reuse stored
records; host durability is also checked by the gateway's separate storage
suite. On Windows, the file adapter syncs files but skips directory sync, so
Windows test success does not establish equivalent crash durability. Read the
[threat model](docs/security-threat-model.md) and
[versioning policy](docs/versioning-policy.md) before changing these boundaries.

## Repository integration

The parent workspace adds `packages/demo-gateway`, website tooling and deployment
checks. Its workspaces point at these same sources. Keep both lockfiles in sync
when dependencies change: run `npm install --package-lock-only` in this folder
and in the repository root, then run the isolation and host checks. Site routes
are mapped separately from repository paths, preserving `/schemas/`, `/spec/`,
`/contracts/`, `/vectors/` and the existing published documentation URLs.

Consensus paths and live-proof configuration resolve from the command's working
directory. Offline proof `--out` instead resolves from this protocol folder,
even when invoked from the repository root; an absolute output path also works.
CI retains its report at `protocol/proof-artifacts/offline.json`. Keep existing
live recovery directories explicitly configured when switching command roots.

Host release/deployment commands remain in the parent workspace; see the
[release procedure](docs/release-publish.md). No live or deployment check is
performed by `verify`.
