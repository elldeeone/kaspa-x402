# Standards Site Architecture

Status: alpha deployment plan for `kaspa-x402.org`. This document is internal
and is not published on the site.

`kaspa-x402.org` is the canonical standards reference for the Kaspa x402
binding. It hosts schemas, specs, vectors, selected docs, package links,
release snapshots, and a static testnet-only browser client. It must not host a
custodial wallet, hosted signer, facilitator, payment API, or protected paid
resource on the apex domain.

Hosted gateway experiments belong on a separate subdomain such as
`demo.kaspa-x402.org` or `testnet.kaspa-x402.org`. Those services have a
different trust model because they may connect to nodes, funding adapters, or
hosted payment endpoints. A static client may live at `/demo/` only while
private key material stays in browser memory and the apex site remains static.

## Design Intent

The site is purely utilitarian: single-column text, system fonts, no imagery,
no marketing sections. Every page exists for a reason:

- `/` carries all prose: what the binding is, current status, what x402 and
  Kaspa are, the engineering rationale for a native binding, the payment
  schemes, reader-specific entry points, and the public package inventory with
  npm links.
- `/spec/` is an annotated index of binding and transport documents in
  suggested reading order, each rendered as HTML with its raw markdown served
  alongside.
- `/schemas/` is an annotated index of the canonical JSON Schemas; each
  schema's `$id` resolves to its route on this site.
- `/vectors/` is the conformance fixture index, grouped by fixture directory,
  with `index.json` carrying byte counts and SHA-256 digests.
- `/docs/` is a curated, grouped index (Adoption, Implementation, Testnet
  Deployment, Evidence, Safety, and Policy) of the selected public documents.
- `/demo/` is a static, testnet-only browser client for PNN connectivity checks
  and local x402 transcript rehearsal. It is not a hosted gateway.
- `/releases/` lists the immutable versioned snapshots.
- `demo.kaspa-x402.org` is the separate Worker-backed testnet gateway. It is
  not hosted under the apex static site.

There is no separate packages page; the package table lives on the homepage
and `packages.json` remains the machine-readable route. Active indexes show
one-line purpose annotations; immutable release metadata and conformance
indexes retain content hashes. Prose on the homepage makes only claims that
are specified in this repository or backed by the published testnet evidence,
and always states the alpha/testnet-only status.

## Repository Layout

- `site/src/` contains the stylesheet for the reference site. There are no
  decorative assets.
- `scripts/site-build.mjs` generates `site/dist/` from committed schemas,
  specs, vectors, and selected docs. Page annotations and doc/vector grouping
  live in `scripts/site-config.mjs`.
- `scripts/site-check.mjs` validates the generated output before deployment.
- `wrangler.jsonc` points Cloudflare Pages at `site/dist/`.

`site/dist/` is generated and ignored. Cloudflare Pages should run
`npm run site:deploy:check` and publish `site/dist`.

## Published Content

The apex site publishes:

- schema files under `/schemas/`;
- specs and transport profiles under `/spec/`;
- conformance vectors under `/vectors/`;
- selected public docs under `/docs/`;
- a static testnet browser client under `/demo/`;
- immutable alpha snapshots under `/v0.1.0-alpha.N/`, indexed at `/releases/`;
- package metadata and source links on the homepage and at `/packages.json`.

Release snapshots lock schemas, specs, selected docs, vectors, versioned
package metadata, and release metadata. They do not lock the interactive
browser client, shared CSS/JS assets, or vendored browser SDK files; those are
active-alpha site routes and `site:check` enforces that they are not copied
under versioned release paths.

Ignored operational or planning files must not be published. This includes
private live-run artifacts, local adapter files, review drafts, findings
drafts, announcement drafts, and internal planning files.
`docs/alpha-publish.md` and this document are internal and excluded from
publication.

## Deployment Model

The first deployment target is Cloudflare Pages with a static build only. The
Pages project should use:

- production branch: `main`;
- build command: `npm run site:deploy:check`;
- output directory: `site/dist`;
- Node.js version: repository `.node-version`;
- custom domains: `kaspa-x402.org` and `www.kaspa-x402.org`.

The static output includes `_headers` for schema JSON routes and `_redirects`
for stable compatibility aliases. No npm publish credentials, live proof
secrets, RPC endpoints, or wallet material are required for deployment.

## Gateway Deployment

The Worker-backed testnet gateway is a separate Cloudflare Workers project with
its own `packages/demo-gateway/wrangler.jsonc`. It uses:

- Worker name: `kaspa-x402-demo-gateway`;
- Durable Object class: `GatewayState`;
- network: `kaspa:testnet-10`;
- chain evidence source: `https://api-tn10.kaspa.org`;
- custom domain: `demo.kaspa-x402.org`.

The gateway package is private and is not part of the public npm release
surface. Its Worker build must pass before the custom subdomain is advertised.
The public docs include the gateway reference, operations runbook, and
implementer guide. Release checklists and draft announcements stay out of the
active documentation index.
