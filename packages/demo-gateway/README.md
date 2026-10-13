# Demo gateway

Cloudflare Worker host for the Testnet-10 reference demo. This package owns
HTTP routing, configuration, Durable Object storage, admission controls and
hash-chain demo orchestration.

Reusable transaction verification, node clients, address handling and PNN
chain evidence live in [protocol/packages/adapters](../../protocol/packages/adapters/README.md).
The gateway imports `@kaspa-x402/adapters`; it implements the adapter's evidence
store with `GatewayLedger`. It also consumes the core, covenant and server SDKs.

The hosted Worker currently has no pre-delivery bounded PNN WebSocket transport.
Until one is supplied, `/supported` omits exact and batch settlement, paid
routes return 503 without a payment offer, and the local hash-chain route is
unavailable. A separately configured hash-chain proxy can still serve its own
bounded upstream route. Node integration tests supply the bounded WebSocket
factory explicitly to exercise the working transport path.

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
