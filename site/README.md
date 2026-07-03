# kaspa-x402.org Site

This directory contains source assets for the static standards reference site.
The generated output lives in `site/dist/` and is ignored.

Build locally:

```sh
npm run site:build
npm run site:check
```

Preview locally without Cloudflare credentials:

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

Check browser SDK connectivity from Node:

```sh
npm run check:pnn-browser
```

Cloudflare Pages configuration:

- build command: `npm run site:deploy:check`
- output directory: `site/dist`
- production branch: `main`
- Node.js version: pinned by repository `.node-version`
- custom domains: `kaspa-x402.org`, `www.kaspa-x402.org`

The apex site is a standards reference with a static, testnet-only browser
client. The hosted gateway and its paid test resources run on the separate
`demo.kaspa-x402.org` subdomain (`packages/demo-gateway/`).
