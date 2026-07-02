# Examples

Current examples:

- `paid-http-api`
- `paid-mcp-tool`
- `self-hosted-facilitator`
- `recovery`

All examples run in mock mode. They do not require wallet secrets, RPC credentials, or a live node.

Build the packages first:

```sh
npm run build
```

Run the examples:

```sh
node examples/paid-http-api/index.mjs
node examples/paid-mcp-tool/index.mjs
node examples/self-hosted-facilitator/index.mjs
node examples/recovery/index.mjs
```

`paid-http-api` demonstrates exact and batch-settlement HTTP retries. `paid-mcp-tool` demonstrates an agent-native paid MCP tool call. `self-hosted-facilitator` demonstrates optional facilitator discovery, verification, and settlement. `recovery` demonstrates the failure and recovery cases operators need to understand before live deployments.

For a broader offline proof that also checks exact replay rejection, batch corrective 402 state, idempotency, and tx-v1 claim/refund construction, run:

```sh
npm run build
npm run proof:offline
```
