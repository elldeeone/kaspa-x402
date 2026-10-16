# Demo gateway

Cloudflare Worker host for the Testnet-10 reference demo. This package owns
HTTP routing, configuration, Durable Object storage, admission controls and
hash-chain demo orchestration.

Reusable transaction verification, node clients, address handling and PNN
chain evidence live in [protocol/packages/adapters](../../protocol/packages/adapters/README.md).
The gateway imports `@kaspa-x402/adapters`; it implements the adapter's evidence
store with `GatewayLedger`. It also consumes the core, covenant and server SDKs.

The 1.0.0 demo uses an authenticated bounded PNN relay configured with
`KASPA_X402_PNN_RPC_ORIGIN` and the `KASPA_X402_PNN_RPC_TOKEN` secret.
The relay runs [scripts/demo-pnn-relay.mjs](../../scripts/demo-pnn-relay.mjs)
on Node and enforces WebSocket frame/reassembled-message limits before delivery.
The Worker bounds the HTTP response before parsing it. Payment state and grants
stay in the existing SQLite Durable Object; the relay holds no signing keys.

Without a bounded transport, paid offers remain unavailable. Native Worker
WebSockets must never be marked as bounded. See the
[1.0.0 demo cutover](../../docs/demo-operations.md#100-demo-cutover) for setup,
fresh covenant state and the funded browser proof. Build/tests do not deploy.

Run from the repository root:

```sh
npm ci
npm --workspace @kaspa-x402/demo-gateway run build
npm --workspace @kaspa-x402/demo-gateway run test:self
npm run check:demo-gateway
```

The build compiles its protocol dependencies and this Worker without the site,
client, facilitator or CLI. Wrangler, TypeScript and test tooling are declared
here. `npm run check:host-isolation` at the root repeats the build and tests
without the website and with only the gateway dependency graph installed.

Build performs a Worker dry run and does not deploy. Tests cover gateway routing,
shared store contracts, persistence/recovery, resource limits and demo integration.
See [operations](../../docs/demo-operations.md) and
[configuration](../../docs/testnet-gateway.md) for deployment and funded checks.
To work on the protocol alone, start at [protocol/README.md](../../protocol/README.md).
