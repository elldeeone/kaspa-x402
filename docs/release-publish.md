# Release Procedure

This internal runbook covers the current release candidate and the eventual
stable `1.0.0` release. It is not published on the standards site.

## Release candidate

1. Choose `1.0.0-rc.N`; update every workspace package and exact internal
   dependency together.
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
   From a clean checkout of the candidate commit, run:

   ```sh
   npm ci
   KASPA_X402_KASPA_CONSENSUS_ROOT=/path/to/rusty-kaspa \
   SILVERSCRIPT_DIR=/path/to/silverscript \
   npm run validate:release
   ```

4. Run a fresh funded Testnet-10 proof against that exact commit. Keep secrets
   and raw wallet state outside Git.
   RC2 funded and hosted proof cannot stand in for a run of escrow-v5/head-v2.
5. Pack the four public packages and inspect their contents and hashes.
6. Publish the packages with the `rc` dist-tag. Never overwrite a published
   version.
7. Deploy the static site, then deploy the fresh-state Testnet gateway. Confirm
   `/release.json`, `/health`, `/canary`, and the public exact/batch offers.
8. Create the matching annotated Git tag and GitHub prerelease.

## Stable `1.0.0`

Stable publication remains blocked by `docs/mainnet-readiness.md`. When every
gate is closed, repeat the clean release validation and funded proof on the
exact stable commit, publish `1.0.0`, move npm `latest`, deploy the site and
gateway, then create the GitHub release.

## Rollback

Published npm versions and Git tags are not rewritten. Fix the source, issue a
new version, and roll the hosted site or Worker back to its last known-good
deployment while the replacement is prepared.
