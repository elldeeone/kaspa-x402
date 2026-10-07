# Verification evidence

Use this index to choose a check and interpret its result. The package version
is still `1.0.0-rc.2`, but current source uses **escrow-v5 / head-v2**. Published
RC2 and its release records use **escrow-v4 / head-v1**. The
[2026-10-07 development verification](verification-2026-10-07.md) separately
records fresh escrow-v5/head-v2 funded runs. Neither is mainnet evidence.

| Evidence | What it establishes | Limits / reproduction |
| --- | --- | --- |
| `npm run verify` from `protocol/` | Local schemas, signed vectors, SDK behavior, persistence contracts, adapters, fixtures and public package contents. | Simulated network results; no funded chain acceptance. See [entry point](../README.md#install-and-verify). |
| Pinned Rust consensus harness | Transaction and covenant acceptance/rejection under the recorded consensus source, including six signature scopes and independent guards. | Offline validation. Pins and commands: [dependencies](../README.md#external-dependencies-and-proof-limits), [recorded scope](mainnet-readiness.md#consensus-cross-validation). |
| SilverScript fixture reproduction | Compiler output agrees with the committed artifact for the pinned compiler. | Does not show a funded transaction. [Version and signature policy](versioning-policy.md#sighash-template-transition). |
| [x402 compatibility experiment](../prototypes/x402-exact/README.md) | HTTP envelopes and trusted request binding against pinned `@x402/core`. | Simulated settlement and experimental attestation; not an upstream SDK integration release. |
| [RC2 release record](rc2-release.md) and [Testnet report](live-testnet-report.md) | Historical funded exact, batch and recovery observations with recorded transaction IDs and source scope. | Preserve the original template versions and prerequisites. [Reproduction guide](live-testnet-proof.md). |
| [Current development proof](verification-2026-10-07.md) | Fresh escrow-v5 18-flow exact/batch proof and head-v2 paid HTTP/owner recovery, with transaction IDs and runtime fingerprints. | Reference ALL signing, one configured Testnet-10 PNN, local harnesses; no hosted deployment or upstream SDK settlement. |
| [Hash-chain live record](hash-chain-live-proof.md) | Historical head-v1 evidence and reproduction commands for the current proof. | Keep template versions distinct; local issuer/reorg tests are separate evidence. |
| `check:address-transaction-compatibility` | Synthetic mainnet-address serialization and signing with an explicitly supplied Kaspa WASM module. | No real UTXOs, broadcast, network acceptance or mainnet readiness. |
| Host checks from repository root | Website package consumption, browser behavior and gateway persistence/Worker integration. | A Worker dry run or simulated browser payment is not deployed or funded proof. |

The [threat model](security-threat-model.md) states trust assumptions; the
[store contract](server-store-contract.md) and [lock contract](server-runtime-lock-contract.md)
state host obligations. [Mainnet readiness](mainnet-readiness.md) owns the open
deployment gates. [Hash-chain research](research/hash-chain-otp.md) is a historical
appendix, not the current integration contract.
The [upstream readiness record](upstream-readiness.md) identifies contribution
requirements and separates unresolved spec decisions from later SDK work.

Distinct failure suites remain separate: schema rejection, cryptographic and
transaction validation, exact replay/recovery, batch accounting/recovery,
client disclosure/funding limits, facilitator transport binding, and gateway
storage failure/rollback. Shared fixture setup is under `test-support/`; it
must not replace those assertions or turn mock signatures into security proof.
