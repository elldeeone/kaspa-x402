# Contributing

Start at [protocol/README.md](protocol/README.md). Protocol-only changes can use
`cd protocol && npm ci && npm run verify`. Run the host checks below from the
repository root when changing shared dependencies, paths or gateway integration.
Run `npm run check:protocol-isolation` before submitting changes to the boundary.

Kaspa x402 is a release-candidate standard and reference implementation targeting
`kaspa:testnet-10`. Nothing here is mainnet-ready, and package names, schemas,
and field names may change until the first tagged spec release. Contributions
should preserve that framing: no change may claim or imply production or
mainnet readiness.

## Verify Locally Before Opening a PR

```sh
npm ci
npm test
npm run validate:schemas
npm run site:build && npm run site:check
npm run check:diff
```

Network-dependent checks (optional locally, run weekly in CI):

```sh
npm run check:vendor-wasm
npm run check:pnn-browser
```

Browser and live-gateway smoke checks (need Chrome and network access):

```sh
npm run check:browser-demo
npm run check:demo-gateway
```

## CI Contract

`.github/workflows/ci.yml` runs the routine checks on every pull request and
push to `main`: workspace tests, schema validation, site checks, and diff
hygiene. Release-only packaging, Worker, consensus, fixture, and funded proof
checks belong to `npm run validate:release`, not every pull request. The Node
version is pinned by `.node-version`.

`.github/workflows/scheduled-checks.yml` runs the network-dependent integrity
checks weekly: vendored kaspa-wasm hashes against the pinned upstream release
archive, and PNN resolver reachability.

## Pull Request Checklist

Answer these in the PR description:

- What changed in public files (schemas, specs, vectors, docs, site)?
- Does this affect wire compatibility (headers, envelopes, schemas)?
- Does this affect voucher/channel hash compatibility or transaction
  construction?
- Does this affect key handling or funding safety?
- What command verifies the change?
- What vectors or tests changed with it?

Changes to schemas, specs, vectors, or published package behavior require a new
version before publication; see `protocol/docs/versioning-policy.md`.

Development escrow-v5 and hash-chain-head-v2 validate all consensus-supported
transaction sighash types; wallet and reference signing defaults remain ALL.
Changes must preserve per-signature digest verification and independent
covenant guards. Keep documentation, fixtures, and signature-scope vectors in
agreement with the [signature policy](./protocol/docs/versioning-policy.md#sighash-template-transition).
Label older release and live-proof records with their original template scope.

## Reporting Issues

Use the issue templates. For interoperability reports against the hosted
testnet gateway, include the fields listed in the implementer guide
(`docs/demo-implementer-guide.md`): package versions or commit, gateway URL
and UTC timestamp, network and scheme, decoded header summaries, HTTP status
and public error reason, and transaction/channel evidence.

Never post private keys, seed phrases, or reusable unpaid payment headers.
Testnet evidence only.

## Safety Boundaries

- All work targets `kaspa:testnet-10`. Mainnet use is blocked by the gates in
  `protocol/docs/mainnet-readiness.md`; do not submit changes that enable mainnet
  paths without those gates.
- The apex site is a static standards reference. It must not gain a hosted
  wallet, signer, facilitator, or payment API.
- The hosted gateway Worker holds no spending keys and does not broadcast
  claims; keep it that way.
- Amounts are decimal strings in sompi. Advertised on-chain amounts must stay
  at or above the Kaspa standard-output storage-mass floor, or clients cannot
  construct the payment.
