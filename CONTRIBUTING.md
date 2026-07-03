# Contributing

Kaspa x402 is an alpha standard and reference implementation targeting
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
npm --workspace @kaspa-x402/demo-gateway run build
npm run pack:public:dry-run
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

`.github/workflows/ci.yml` runs on every pull request and push to `main`:
workspace tests, schema/vector validation, site build and publication checks,
the gateway Worker dry-run build, the public-package pack dry-run, and diff
hygiene. A pull request is not mergeable until CI is green. The Node version
is pinned by `.node-version`.

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

Changes to schemas, specs, or vectors alter the published release surface.
Released snapshots are immutable: if locked artifacts change, the alpha
version must be bumped and a new release lock and snapshot added — see
`docs/versioning-policy.md`. Do not edit `site/releases/` locks or snapshots
for an already-published version.

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
  `docs/mainnet-readiness.md`; do not submit changes that enable mainnet
  paths without those gates.
- The apex site is a static standards reference. It must not gain a hosted
  wallet, signer, facilitator, or payment API.
- The hosted gateway Worker holds no spending keys and does not broadcast
  claims; keep it that way.
- Amounts are decimal strings in sompi. Advertised on-chain amounts must stay
  at or above the Kaspa standard-output storage-mass floor, or clients cannot
  construct the payment.
