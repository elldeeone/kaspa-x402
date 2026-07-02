# Adoption Examples

Status: alpha examples for local and testnet-oriented review.

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

## Protect A Variable-Cost HTTP Route

Use `upto` when the server knows the final cost only after doing bounded work.
The client signs the maximum it is willing to pay; the server returns the actual
charge in the settlement response.

The same HTTP example includes a zero-charge and nonzero-charge `upto` flow.

## Protect Repeated Requests

Use `batch-settlement` when repeated small requests should share one escrow
channel. The client opens a channel and signs cumulative vouchers as requests
are served.

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
server verification and settlement path. This package is not part of the initial
alpha publish set.

## Inspect Recovery Behavior

Run:

```sh
npm run build
node examples/recovery/index.mjs
```

The recovery example covers client/server state loss, exact replay, upto replay,
corrective `402`, and refund preview behavior.
