# Demo PNN relay hosting

Hosts the existing bounded Node transport in one Cloudflare Container, in the
demo account. No wallet keys, grants or payment state enter the container.
All sessions use the same named instance; idle containers stop after ten minutes.

From the repository root, after building the protocol packages:

```sh
node infra/demo-pnn-relay/build.mjs
npm ci --prefix infra/demo-pnn-relay --ignore-scripts --workspaces=false
npm --prefix infra/demo-pnn-relay run deploy -- --dry-run
npm --prefix infra/demo-pnn-relay run deploy
infra/demo-pnn-relay/node_modules/.bin/wrangler secret put RELAY_TOKEN --config infra/demo-pnn-relay/wrangler.jsonc < /private/relay-token
```

This requires Workers Paid and Docker. The image context includes only the
bundled relay and Dockerfile; the transport token is injected at runtime.
The host pins its own Wrangler for container hosting; SDK dependencies
and the existing gateway's toolchain are unchanged.
Configure the gateway with the returned HTTPS origin and the same transport token.
Requests without that token fail before starting a container.

```sh
node verification/proof-demo-relay-container-e2e.mjs --out /private/local.json
node verification/proof-demo-relay-container-e2e.mjs \
  --origin https://kaspa-x402-demo-pnn-relay.dunshea-luke.workers.dev \
  --token-file /private/relay-token --out /private/hosted.json
```

The proof uses read-only Testnet RPCs and submits no payments. Public browser
payment and retry verification follows the demo cutover runbook separately.
