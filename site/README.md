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

Cloudflare Pages configuration:

- build command: `npm run site:deploy:check`
- output directory: `site/dist`
- production branch: `main`
- custom domains: `kaspa-x402.org`, `www.kaspa-x402.org`

The apex site is a standards reference only. Test gateway work belongs on a
separate subdomain.
