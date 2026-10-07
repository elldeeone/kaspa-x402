# Demo gateway

Cloudflare Worker host for the Testnet-10 reference demo. This package owns
HTTP routing, configuration, Durable Object storage, admission controls and
hash-chain demo orchestration.

Reusable transaction verification, node clients, address handling and PNN
chain evidence live in [protocol/packages/adapters](../../protocol/packages/adapters/README.md).
The gateway imports `@kaspa-x402/adapters`; it implements the adapter's evidence
store with `GatewayLedger`. It also consumes the core, covenant and server SDKs.

Run from the repository root:

```sh
npm ci
npm run build
npm --workspace @kaspa-x402/demo-gateway run test:self
npm run check:demo-gateway
```

Build performs a Worker dry run and does not deploy. Tests cover gateway routing,
shared store contracts, persistence/recovery, resource limits and demo integration.
See [operations](../../docs/demo-operations.md) and
[configuration](../../docs/testnet-gateway.md) for deployment and funded checks.
To work on the protocol alone, start at [protocol/README.md](../../protocol/README.md).
