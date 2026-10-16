# Kaspa x402

Kaspa bindings and reference implementations for x402 payments: one-shot
`exact` payments and covenant-backed `batch-settlement`.

**Security and use:** This SDK supports mainnet configuration. It has undergone
extensive AI-assisted security review, and all four payment profiles were tested
on funded Testnet. It has not received an independent third-party security audit.
Undiscovered bugs may result in loss of funds. Provided as is, without warranty.
[Review and testing details](protocol/docs/security-review-1.0.0.md).

**Engineers: start in [protocol/](protocol/README.md).** It contains the
specifications, schemas, SilverScript contracts, SDKs, reusable chain adapters,
examples and verification tools. It installs and verifies independently of the
website and hosted gateway.

The **1.0.0 standard and four-package SDK release** is published on npm.
The SDK supports Testnet-10 and explicitly configured mainnet; funded validation
uses Testnet-10. Read the [release notes](protocol/docs/v1-release.md) and
[deployment requirements](protocol/docs/mainnet-readiness.md). The website and
hosted demo are separate deployments. The public demo now runs the matching
1.0.0 Testnet runtime with escrow-v5/head-v2 and a verified browser payment and
retry. See the [security review record](protocol/docs/security-review-1.0.0.md).

| Folder | Responsibility |
| --- | --- |
| [protocol/](protocol/README.md) | Protocol and local reference implementation; engineer entry point. |
| [packages/demo-gateway/](packages/demo-gateway/README.md) | Cloudflare Worker, durable storage and demo integration. |
| [site/](site/README.md) | Public documentation website and browser demo. |
| `scripts/`, `docs/` | Host integration checks and operations; website build tools live in `site/scripts/`. |

To work on the protocol alone:

```sh
cd protocol
npm ci
npm run verify
```

For the complete repository, run `npm ci`, `npm test`, then
`npm run site:build && npm run site:check` from this directory.
`npm run check:protocol-isolation` verifies a separate copy of `protocol/` with
its own dependencies. Public schema IDs and hosted documentation URLs remain
unchanged by the folder layout.

The website and gateway each have their own build scripts and declared tooling.
`npm run check:host-isolation` installs each host separately in a temporary copy
with the other host removed, then builds and checks it against protocol package exports.

See [CONTRIBUTING.md](CONTRIBUTING.md) for checks and contribution requirements.
