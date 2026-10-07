# Kaspa x402

Kaspa bindings and reference implementations for x402 payments: one-shot
`exact` payments and covenant-backed `batch-settlement`.

**Engineers: start in [protocol/](protocol/README.md).** It contains the
specifications, schemas, SilverScript contracts, SDKs, reusable chain adapters,
examples and verification tools. It installs and verifies independently of the
website and hosted gateway.

This remains a Testnet-10 release candidate. Current source uses escrow-v5 and
head-v2; historical RC2 evidence does not establish funded proof of these
newer templates. See [readiness gates](protocol/docs/mainnet-readiness.md).

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
