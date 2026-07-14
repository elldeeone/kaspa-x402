# Alpha Publish Checklist

Status: preparing `0.1.0-alpha.7`. `0.1.0-alpha.6` remains the latest recorded
live release snapshot. Publishes require npm authorization and must not happen
accidentally from CI or an unauthenticated shell.

Registry note: the `alpha` dist-tag is the supported prerelease install path.
The `latest` dist-tag is not advertised for alpha releases and may lag until a
stable version can own `latest`.

## Package Set

Public alpha package set:

- `@kaspa-x402/core`;
- `@kaspa-x402/covenant`;
- `@kaspa-x402/client`;
- `@kaspa-x402/server`.

`0.1.0-alpha.0` was the initial published alpha. `0.1.0-alpha.1` carried the
next breaking alpha wire update. `0.1.0-alpha.2` carried the browser test client
and schema tightening. `0.1.0-alpha.3` carried the MCP settlement-failure hybrid
shape. `0.1.0-alpha.4` carries the raw-digest voucher signature cutover and the
script-public-key endianness erratum. `0.1.0-alpha.5` carries the exact-payment
evidence cutover: `exact-transfer` payloads require `transactionId` plus
`paymentOutputIndex`; serialized `transaction` evidence is not part of the
alpha.5 exact wire shape. `0.1.0-alpha.6` replaces the observe-only exact path
with KIP-10 `exact-transaction`: servers advertise a buildable reservation tuple
including the reserved borrow outpoint, redeem script, additive threshold, and
expected payment output index; clients return a signed transaction artifact
encoded as `kaspa-sdk-safe-json-v2.0.0`; and servers verify, broadcast, observe,
and consume the reservation before releasing protected content.
`0.1.0-alpha.7` hardens that path with canonical transaction-envelope and
reservation checks, atomic continuation recycling, rolling DAA refund safety,
full-outpoint voucher binding, and recovery-safe claim accounting.

`@kaspa-x402/facilitator` and `@kaspa-x402/cli` remain private for now. They
are useful in the repository, but they should not be published until the public
surface is clearly worth supporting as a package.

`covenant` is included because `client` and `server` depend on it. Publishing
client/server without covenant would make fresh installs fail.

## Local Verification

Run from the repository root:

```sh
npm install
npm run build
npm test
npm run validate:schemas
npm run site:build
npm run site:check
npm run check:browser-demo
npm run check:pnn-browser
npm run check:vendor-wasm
npm run check:demo-gateway
npm run proof:offline
npm run check:covenant-fixtures
npm run validate:tx-v1-consensus
npm --workspace @kaspa-x402/core pack --dry-run --json
npm --workspace @kaspa-x402/covenant pack --dry-run --json
npm --workspace @kaspa-x402/client pack --dry-run --json
npm --workspace @kaspa-x402/server pack --dry-run --json
```

The dry-run checks package contents but does not create tarballs. For the clean
install test, create real tarballs in a temporary directory:

```sh
PACK_DIR="$(mktemp -d)"
npm --workspace @kaspa-x402/core pack --pack-destination "$PACK_DIR"
npm --workspace @kaspa-x402/covenant pack --pack-destination "$PACK_DIR"
npm --workspace @kaspa-x402/client pack --pack-destination "$PACK_DIR"
npm --workspace @kaspa-x402/server pack --pack-destination "$PACK_DIR"
```

Then install those tarballs in a clean temporary project and import all four
packages. The temporary project should not rely on this repository's workspace
links.

The publishable packages have a `prepack` guard that fails if `dist/index.js`
or `dist/index.d.ts` is missing. This prevents accidental tarballs with broken
entrypoints.

## Alpha.7 Registry And Tarball Recheck

Checked locally for alpha.7 on 2026-07-14:

- all public package manifests and internal public-package dependencies use
  exactly `0.1.0-alpha.7`;
- the full release matrix, consensus harness, browser checks, offline proof,
  schemas, immutable site snapshot, and clean tarball-import smoke pass;
- the funded TN10 exact, deposit-voucher, voucher-only, claim, replay-rejection,
  and refund flows pass using a NodeJS SDK built from reviewed current
  `rusty-kaspa` source;
- the supplied mainnet node reports `mainnet`, synced status, and UTXO indexing
  in a read-only gRPC check; this is not a mainnet readiness claim;
- `npm audit --omit=dev --audit-level=high` reports no production dependency
  vulnerabilities. The full development tree retains transitive
  Wrangler/Miniflare advisories.

No alpha.7 package has been published by this review. Registry and dist-tag
checks remain a release-operator step after publication.

## Alpha.6 Registry And Tarball Recheck

Before publishing alpha.6, check:

- `@kaspa-x402/core`, `@kaspa-x402/covenant`, `@kaspa-x402/client`, and
  `@kaspa-x402/server` package manifests are bumped to `0.1.0-alpha.6`;
- internal workspace dependencies point exactly at `0.1.0-alpha.6`;
- dry-run tarballs for the publishable alpha manifests contain only `LICENSE`,
  `README.md`, `package.json`, `dist/index.js`, and `dist/index.d.ts`;
- ignored local planning, review, and live-run artifacts are not in the
  dry-run package file lists;
- a clean temporary project installs the four local alpha.6 tarballs together
  and imports `@kaspa-x402/core`, `@kaspa-x402/covenant`,
  `@kaspa-x402/client`, and `@kaspa-x402/server` successfully;
- the local alpha.6 tarball set can create and settle the offline KIP-10
  `exact-transaction` flow.

## Alpha.5 Registry And Tarball Recheck

Checked for alpha.5 on 2026-07-06:

- `@kaspa-x402/core`, `@kaspa-x402/covenant`, `@kaspa-x402/client`, and
  `@kaspa-x402/server` are published at `0.1.0-alpha.5`;
- those packages have `alpha` dist-tags pointing to `0.1.0-alpha.5`;
- `latest` remains at `0.1.0-alpha.4` and is not the recommended alpha install
  path;
- `@kaspa-x402/facilitator` and `@kaspa-x402/cli` return npm `404` and remain
  unpublished/private;
- dry-run tarballs for the publishable alpha manifests should contain only
  `LICENSE`, `README.md`, `package.json`, `dist/index.js`, and
  `dist/index.d.ts`;
- ignored local planning, review, and live-run artifacts are not in the dry-run
  package file lists;
- a clean temporary project installed the four npm `@alpha` packages together
  and imported `@kaspa-x402/core`, `@kaspa-x402/covenant`,
  `@kaspa-x402/client`, and `@kaspa-x402/server` successfully;
- a clean temporary project installed the four npm `@alpha` packages and passed
  the MCP hybrid settlement-failure consumer smoke using only registry imports;
- `npm audit --omit=dev --audit-level=low` reported zero production
  vulnerabilities. A full dev-tree audit currently reports transitive
  development-tooling advisories through `wrangler`/`miniflare`.

## Hosted Evidence Gate

For alpha.7, the source release gate is not the same as the public hosted
gateway gate. Alpha.7 source hardens the KIP-10 exact transaction-artifact path for
direct-mode servers that advertise reservations. The hosted
`demo.kaspa-x402.org` gateway may advertise exact evidence only while it is
deployed with working exact reservations, PNN broadcast, finality observation,
and funded TN10 borrow-UTXO inventory.

Before advertising alpha.6 source live evidence, run:

```sh
npm run proof:live:check -- --live --write-report
```

Before advertising hosted exact evidence, run:

```sh
KASPA_X402_LIVE_CONFIRM=I_UNDERSTAND_THIS_USES_TESTNET_FUNDS npm run proof:hosted-exact
```

The expected alpha.7 live proof must include:

- KIP-10 exact reservation terms with `additiveThresholdSompi` at or above
  `10000000` sompi;

- exact KIP-10 transaction artifact settlement and replay rejection;
- batch deposit-voucher settlement;
- batch voucher-only settlement;
- batch claim transaction construction and broadcast;
- replay rejection across exact and batch-settlement;
- batch refund transaction construction and broadcast after timeout.

Checked for alpha.7 on 2026-07-14:

- the funded TN10 live proof completed with status `complete`;
- exact KIP-10 settlement used adapter-submitted transaction-v1 evidence,
  server broadcast finality `accepted`, and a `10000000` sompi additive
  threshold;
- exact replay rejection, batch deposit-voucher, voucher-only, claim,
  continuation replay rejection, and post-timeout refund all passed;
- the sanitized evidence and transaction ids are recorded in
  `docs/live-testnet-report.md`;
- the hosted gateway was not redeployed or represented as fresh alpha.7
  evidence. Its last recorded hosted proof remains the historical alpha.6 run
  in `docs/testnet-gateway.md`.

Checked for alpha.6 on 2026-07-09:

- the funded TN10 live proof completed with status `complete`;
- exact KIP-10 `exact-transaction` settlement used adapter-submitted tx-v1
  evidence, server broadcast finality `accepted`, and a `10000000` sompi
  additive threshold;
- batch deposit-voucher, voucher-only, claim, replay rejection, and refund all
  passed;
- the sanitized summary is recorded in `docs/live-testnet-report.md`.
- the hosted gateway Worker version
  `47862b0f-2ecf-49d0-b793-81e89caa4dfa` settled exact transaction
  `632dadcf96ac9ce4c56c781d95aac31ed52365a0fb86eb4b0cbbcd1f3eb2f55c`
  through the TN10 PNN broadcast path; the hosted summary is recorded in
  `docs/testnet-gateway.md`.

Checked for alpha.5 on 2026-07-06:

1. Deployed the reviewed static site so `/demo/`, schemas, vectors, and the
   alpha.5 release snapshot all expose the `transactionId` plus
   `paymentOutputIndex` exact shape.
2. Deployed the reviewed `demo.kaspa-x402.org` Worker at version
   `470c7bc1-125b-49df-b046-a309b0257e67`.
3. Smoked the public gateway with both exact payload shapes: legacy
   `payload.transaction` was rejected, and `payload.transactionId` plus
   `payload.paymentOutputIndex` reached the exact verifier path.
4. Confirmed the funded TN10 live proof report remains current for the release
   candidate:

```sh
npm run proof:live:check -- --live --write-report
```

The alpha.5 full live harness passed on 2026-07-06 and is summarized in
`docs/live-testnet-report.md`. The reference adapter for rerunning that proof is
`scripts/live-adapter-reference.mjs`; supply RPC, wallet, and Kaspa WASM SDK
paths through environment or `live-proof.env.example`. Hosted alpha.5 evidence
passed on 2026-07-06 and is summarized in `docs/testnet-gateway.md`.

The full release-live gate is:

```sh
npm run validate:release:live
```

If hosted redeploy, live configuration, or testnet funds are unavailable for a
future release candidate, do not present that hosted gateway as freshly proven.
Keep the hosted evidence status pending instead.

## Publish Boundary

Publishing requires an authenticated npm account with access to the
`@kaspa-x402` scope. The unscoped `kaspa-x402` package name does not prove scope
control.

Publish with `--tag alpha`. Do not advertise tagless or `latest` installs for
alpha releases.

```sh
npm publish --workspace @kaspa-x402/core --tag alpha --access public
npm publish --workspace @kaspa-x402/covenant --tag alpha --access public
npm publish --workspace @kaspa-x402/client --tag alpha --access public
npm publish --workspace @kaspa-x402/server --tag alpha --access public
```

After publish, verify from a clean project:

```sh
npm install @kaspa-x402/core@alpha @kaspa-x402/covenant@alpha @kaspa-x402/client@alpha @kaspa-x402/server@alpha
node -e "import('@kaspa-x402/core').then(() => console.log('ok'))"
```

Also verify dist-tags:

```sh
npm view @kaspa-x402/core dist-tags
npm view @kaspa-x402/covenant dist-tags
npm view @kaspa-x402/client dist-tags
npm view @kaspa-x402/server dist-tags
```

If npm keeps `latest` on the first published prerelease and rejects deleting it
because no alternate stable version exists, do not advertise tagless installs.
Use explicit `@alpha` installs until a stable version can own `latest`.

## Release Caveats

Every alpha release note should state:

- testnet-oriented reference implementation;
- no production custody system;
- no mainnet readiness claim;
- package APIs and wire details can change before the first stable spec tag;
- alpha.7 exact supports preferred KIP-10 `exact-transaction` artifacts with
  durable reservation continuation and replay requirements;
- live proof evidence is testnet-only.
