# Release Procedure

This internal runbook covers the current release candidate and the eventual
stable `1.0.0` release. It is not published on the standards site.

## Release candidate

1. Choose `1.0.0-rc.N`; update every workspace package and exact internal
   dependency together. Refresh both root and `protocol/` lockfiles.
2. Update the current specs, schemas, vectors, docs, site, and gateway release
   version. Do not add repository copies of old releases.
   For the sighash-policy change, verify that active artifacts use escrow-v5
   and head-v2, wallets still default to ALL, and all six supported scopes pass
   local consensus checks. Follow the
   [template transition](versioning-policy.md#sighash-template-transition)
   for outstanding RC2 heads/channels; an existing script cannot be upgraded
   in place. Keep published RC2 evidence identified with its original scripts.
3. Prepare clean source checkouts of Rusty-Kaspa at
   `01b532e8b553523216471682649693af92f0fd16` (v2.1.0) and SilverScript at
   `3ed973335b59269293564805cc2c58a14595ec03`. The consensus and
   hash-chain fixture checks use these sources; `npm ci` does not fetch them.
   From the repository root of a clean checkout of the candidate commit, run:

   ```sh
   npm ci
   KASPA_X402_KASPA_CONSENSUS_ROOT=/path/to/rusty-kaspa \
   SILVERSCRIPT_DIR=/path/to/silverscript \
   npm run validate:release
   ```

   For an SDK-only release, run `npm --prefix protocol run validate:release`
   instead. It performs protocol verification, independent covenant reproduction
   and pinned consensus validation without building or deploying demo hosts.

   Covenant reproduction requires Cargo/rustc 1.95.0. The checker authenticates
   the pinned compiler's commit, trees and blobs, exports them into a private
   directory, and builds with the committed lockfile using `--locked`. Mutable
   checkout files, ignored configuration, hidden-index changes, user Cargo
   configuration and inherited build overrides are not used. The build uses a
   fresh Cargo home and target directory; dependency downloads and compilation
   are therefore required on each invocation. Installed Git, Rust and native
   build tools remain trusted host inputs.

   `check:covenant-fixtures` independently compiles both escrow-v5 and head-v2,
   checks constructor/state variants, and compares both fixture JSON/ABI and
   generated runtime modules without writing them. Its JSON output records the
   compiler tree, source/dependency manifest hashes, toolchain, compiler binary
   hash and compilation hashes. Artifact identity metadata retains the historical
   reproduction command; this new receipt identifies the actual isolated build.

   Local `verify` uses explicitly labelled internal consistency checks. It is
   not the independent compiler or release gate. Do not substitute it for
   `validate:release`.

   To retain the adversarial CLI proof and real compiler reproduction:

   ```sh
   SILVERSCRIPT_DIR=/path/to/silverscript \
     npm --prefix protocol run proof:covenant-compiler -- \
       --out /private/proof-directory/compiler-proof.json --real
   ```

   The report distinguishes controlled external-compiler isolation cases from
   the real pinned compiler rebuild. Protect the output directory and retain
   the report with the candidate source fingerprints.

4. Run a fresh funded Testnet-10 proof against that exact commit. Keep secrets
   and raw wallet state outside Git.
   RC2 funded and hosted proof cannot stand in for a run of escrow-v5/head-v2.
5. Prepare and approve the exact SDK archives using the procedure below.
6. Publish those approved archives with the `rc` dist-tag. Never publish from
   workspace directories or overwrite a published version.
7. Deploy the static site, then deploy the fresh-state Testnet gateway. Confirm
   `/release.json`, `/health`, `/canary`, and the public exact/batch offers.
8. Create the matching annotated Git tag and GitHub prerelease.

## Stable `1.0.0`

Stable publication remains blocked by the [mainnet readiness gates](mainnet-readiness.md). When every
gate is closed, repeat the clean release validation and funded proof on the
exact stable commit, publish `1.0.0`, move npm `latest`, deploy the site and
gateway, then create the GitHub release.

## Exact SDK release artifacts

The four public packages are built from authenticated Git blobs for an explicit
full commit in a fresh private workspace. Mutable source, ignored `dist`, local
`node_modules`, npm configuration and inherited Node/npm overrides are excluded.
Dependency installation uses the committed protocol lockfile without lifecycle
scripts. The builder records source/tree/lock/tool fingerprints and inspects
actual archive paths, manifests, versions, file digests and every public export.
It then installs those four archives in a fresh consumer, imports all seven
entrypoints, exercises encoding/covenant/durable-grant behavior and typechecks
the installed declarations without workspace links or publication credentials.

Preparation does not authorize publication. `pack:public:dry-run` remains a local
packaging check and needs no Git history; it is not a release provenance check.
Normal directory publication is rejected by the package lifecycle guard.
Maintainers can bypass lifecycle guards with `--ignore-scripts`, so publication
credentials and the approved artifact process enforce the actual boundary.

From the repository root, after SDK release validation, retain the compiler
checker JSON for the same contract/generated artifact hashes, then prepare:

```sh
SILVERSCRIPT_DIR=/path/to/silverscript \
  node protocol/scripts/check-covenant-fixtures.mjs > /private/compiler-proof.json
node protocol/scripts/prepare-sdk-release.mjs \
  --revision FULL_REVIEWED_COMMIT --out /private/new-sdk-bundle \
  --compiler-proof /private/compiler-proof.json
```

The new output directory contains four `.tgz` files, `manifest.json` and the
compiler receipt. Preparation without `--compiler-proof` is allowed for package
inspection, but the publisher refuses that bundle. Compiler evidence must match
both fixtures/generated modules and all contract source variants. Host tools
and locked registry dependencies remain trusted build inputs; a receipt is a
record of the trusted preparation run, not an independent signature of execution.

CI's `sdk-release-artifacts` job waits for verification and independent compiler
reproduction, prepares from its exact checked-out commit, and retains
`sdk-release-bundle` plus a separate `sdk-release-approval` artifact. Review the
source revision, inspection/consumer results, compiler receipt and manifest
SHA-256 from that trusted run. Keep the expected revision/digest outside the
mutable bundle; never derive an approval from whichever manifest arrives later.
On pull requests the prepared revision can be GitHub's merge commit; after merge,
use the fresh main CI bundle for the actual reviewed release commit.

```sh
node protocol/scripts/inspect-sdk-release.mjs --bundle /private/new-sdk-bundle \
  --revision FULL_REVIEWED_COMMIT --manifest-sha256 APPROVED_MANIFEST_DIGEST
node protocol/scripts/publish-sdk-release.mjs --bundle /private/new-sdk-bundle \
  --revision FULL_REVIEWED_COMMIT --manifest-sha256 APPROVED_MANIFEST_DIGEST --tag rc
```

The publisher validates without uploading by default. An explicit `--publish`
and `NODE_AUTH_TOKEN` enable publication. It captures and validates every archive
before npm runs, publishes private copies with scripts/workspaces disabled, then
checks registry integrity and downloads the registry bytes to compare their
digests. The npm dist-tag must match the approved package configuration. Registry
URLs require HTTPS; HTTP at `127.0.0.1` exists only for the repeatable E2E proof.

The manual `publish-sdk-release` workflow runs the reviewed publisher from main
and downloads an existing bundle by CI run ID; it never rebuilds with credentials.
Before use, configure the `npm-release` environment with required reviewers and
an environment-scoped `NPM_PUBLISH_TOKEN`. Those repository settings are separate
from this workflow file and are not established by naming an environment. The
workflow passes that secret only to the final publisher step and retains the
publication journal. It is not triggered automatically by pushes or PRs.

Keep the bundle directory private and writable by the release operator. The
publisher creates a new `publication.json` before uploading and never overwrites
an earlier journal. Four npm uploads are not atomic: if one fails, preserve the
journal, inspect the registry and recover the partial release explicitly without
overwriting any published version. Disk/network failures can leave uploaded but
unverified packages; a successful upload alone is not a successful release.

Run `npm --prefix protocol run proof:release-artifacts` for the repeatable proof.
Its report is `protocol/.kaspa-x402-live/sdk-release/report.json`. It uses real
Git/npm/build/consumer flows and loopback registry uploads with a controlled
compiler receipt; it does not publish to npm or establish a funded/mainnet proof.

## Rollback

Published npm versions and Git tags are not rewritten. Fix the source, issue a
new version, and roll the hosted site or Worker back to its last known-good
deployment while the replacement is prepared.
