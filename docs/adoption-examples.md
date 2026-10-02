# Adoption Examples

Status: examples for the development Testnet-10 source after RC2.
Current builds use escrow-v5/head-v2; published RC2 uses escrow-v4/head-v1.
Reference transaction signing defaults to ALL, while the new covenants accept
signer-chosen scopes. See the
[signature policy and template transition](versioning-policy.md#sighash-template-transition).

The repository examples run in mock mode by default. They do not require wallet
secrets, RPC credentials, or a live node.

## Protect A Fixed-Price HTTP Route

Use `exact` when every request has a fixed charge and the client can submit a
direct native payment for that amount.

Run:

```sh
npm run build
node examples/paid-http-api/index.mjs
```

The example exercises the unpaid `402`, paid retry, settlement response, and
replay handling path.

## Protect Repeated Requests

Use `batch-settlement` when repeated requests with a pre-approved fixed charge
should share one escrow channel. The client opens a channel and signs cumulative
vouchers as requests are served.

The HTTP example includes deposit-voucher and voucher-only channel reuse paths.

## Call A Paid API

The client package exposes direct-mode helpers for parsing `PAYMENT-REQUIRED`,
selecting a compatible Kaspa offer, building the payment payload through injected
wallet/signing adapters, and verifying `PAYMENT-RESPONSE` before advancing local
state.

## Protect An MCP Tool

Run:

```sh
npm run build
node examples/paid-mcp-tool/index.mjs
```

The MCP example returns a payment-required tool result, retries with
`_meta["x402/payment"]`, and attaches `_meta["x402/payment-response"]` after
settlement.

## Use A Self-Hosted Facilitator

Run:

```sh
npm run build
node examples/self-hosted-facilitator/index.mjs
```

The facilitator example shows compatibility endpoints over the direct-mode
server verification and settlement path. The facilitator is available from
repository source; the four public RC2 npm packages are core, covenant, client,
and server.

## Inspect Recovery Behavior

Run:

```sh
npm run build
node examples/recovery/index.mjs
```

The recovery example covers client/server state loss, exact replay, corrective
`402`, and refund preview behavior.
