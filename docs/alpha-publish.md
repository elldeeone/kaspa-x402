# Alpha Publish Checklist

Status: alpha packages previously published at `0.1.0-alpha.0`; current
package manifests are prepared for `0.1.0-alpha.1`. Publishing requires npm
authorization and must not happen accidentally from CI or an unauthenticated
shell.

Registry note: the first published package versions are visible on npm with
`alpha` and `latest` dist-tags. Attempts to remove `latest` returned npm `400`
responses, so consumers should use explicit `@alpha` installs until a stable
version can own `latest`.

## Package Set

Public alpha package set:

- `@kaspa-x402/core@0.1.0-alpha.1`;
- `@kaspa-x402/covenant@0.1.0-alpha.1`;
- `@kaspa-x402/client@0.1.0-alpha.1`;
- `@kaspa-x402/server@0.1.0-alpha.1`.

`0.1.0-alpha.0` was the initial published alpha. `0.1.0-alpha.1` carries the
next breaking alpha wire update.

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
