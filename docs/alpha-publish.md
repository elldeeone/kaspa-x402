# Alpha Publish Checklist

Status: `0.1.0-alpha.4` publish checklist. Public alpha packages are currently
published at `0.1.0-alpha.3` until the reviewed alpha.4 release is committed
and published. Publishes require npm authorization and must not happen
accidentally from CI or an unauthenticated shell.

Registry note: the first published package versions are visible on npm with
`alpha` and `latest` dist-tags. Attempts to remove `latest` returned npm `400`
responses, so `latest` is kept aligned with the current alpha while docs keep
recommending explicit `@alpha` installs until a stable version can own
`latest`.

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
script-public-key endianness erratum.

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
npm run proof:offline
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

## Pre-Alpha.4 Registry And Tarball Recheck

Checked before alpha.4:

- `@kaspa-x402/core`, `@kaspa-x402/covenant`, `@kaspa-x402/client`, and
  `@kaspa-x402/server` are published at `0.1.0-alpha.3`;
- those packages have both `alpha` and `latest` dist-tags pointing to
  `0.1.0-alpha.3`, after npm returned `400` responses when removing `latest`
  during the previous alpha publish;
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
- live proof evidence is testnet-only.
