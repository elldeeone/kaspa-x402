# kaspa-x402.org Site

This workspace owns the static standards reference site, browser demo and build tools.
The generated output lives in `site/dist/` and is ignored.

The published 1.0.0 artifacts, browser bundle and hosted Testnet gateway use
escrow-v5/head-v2 with signer-chosen sighash types and ALL as the signing default.
Historical RC2 covenant state remains incompatible and must be recovered under
its original runtime;
see the [signature policy and template transition](../protocol/docs/versioning-policy.md#sighash-template-transition).

Install once with `npm ci` at the repository root. Build this host independently:

```sh
cd site
npm run build
npm run check
```

The build consumes protocol package exports plus the explicitly published
specifications, schemas, contracts, vectors and docs listed in
[scripts/site-config.mjs](scripts/site-config.mjs). It does not build the gateway.
The browser Buffer/SHA-256 adapters stay in this host. Root scripts delegate
to this workspace; `npm run check:host-isolation` at the root checks a copy
with the gateway removed and only this host's dependency graph installed.

Preview from the repository root without Cloudflare credentials:

```sh
npm run site:serve
```

The preview server binds to `0.0.0.0`; open `http://<host-lan-ip>:<port>/demo/`
from another device on the LAN if needed. Public HTTPS previews should use one
of the listed `wss://` public node endpoints. To test a local or private-network
node endpoint, open
`/demo/?allow-custom-endpoints=1&endpoint=ENCODED_ENDPOINT` from the local
preview. The endpoint field must match that query value so the preview CSP can
stay scoped to one WebSocket origin.

Regenerate the social preview image (`site/src/assets/og.png`, referenced by
the `og:image` meta tag) after editing its source `site/og-image.html`:

```sh
google-chrome --headless --disable-gpu --window-size=1200,630 \
  --screenshot=site/src/assets/og.png site/og-image.html
```

Check browser SDK connectivity from Node:

```sh
npm run check:pnn-browser
```

Release presentation is controlled by `site/release.json`. While the release
PR is under review, `publicationStatus` remains `candidate`: pages and JSON must
not claim npm publication. After separately authorized SDK publication, change
it to `published` before the coordinated website deployment. SDK version and
npm tag come from the public package manifests. Demo version, network, templates
and last verification date are independent recorded deployment metadata; update
them only after checking the actual service. Do not derive them from SDK versions.

The deployed gateway now matches the 1.0.0 browser and covenant builders. A
funded browser payment and same-transaction retry passed through the public
origins; see `verification/release-1.0.0-hosted.json`. The browser still rejects
incompatible old quotes. Mock and local preview proofs remain separate evidence.

Cloudflare Pages configuration:

- build command: `npm run site:deploy:check`
- output directory: `site/dist`
- production branch: `main`
- Node.js version: pinned by repository `.node-version`
- custom domains: `kaspa-x402.org`, `www.kaspa-x402.org`

The apex site is a standards reference with a static, testnet-only browser
client. The hosted gateway and its paid test resources run on the separate
`demo.kaspa-x402.org` subdomain (`packages/demo-gateway/`).

The hash-chain panel uses a browser bundle built from the existing payment
client, with a small SHA-256/Buffer adapter. The separate Node issuer is run
with `scripts/hash-chain-demo.mjs`; see `docs/demo-operations.md`. The site
does not provision or fund that service.
