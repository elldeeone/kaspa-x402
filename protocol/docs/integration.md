# Configure the reference SDKs

Exact and batch share wire parsing, request binding and replay coordination.
Batch-specific dependencies are enabled by a `batch` configuration object.
Omitting it makes the client/server exact-only. Existing callers must move
batch fields into that object; there is no legacy configuration reader.
Schemas, signatures, settlement rules and stored record formats are unchanged.

## Exact server

```ts
const server = new DirectModeServer({
  network: "kaspa:testnet-10",
  payTo: merchantAddress,
  amount: "20000000",
  confirmationThreshold: 30,
  addressCodec,
  store,                   // ExactServerStateStore
  chainProvider,           // ExactServerChainProvider: sendTransaction
  exactTransactionVerifier,
  exactSettlementReconciler,
});
```

Every paid HTTP or MCP route must declare `routeAccess: "public"` or
`routeAccess: "authenticated"` when it calls the server. An authenticated
route must also pass `trustedSecurityContext` with host-derived claims on
every challenge, verification, settlement and paid request. The server rejects
an authenticated call without this context before it reads payment or replay
state. Use `public` only for a route that intentionally serves all callers
without an authenticated principal. Facilitator verify and settle calls use
the same explicit policy.

The default offer is exact when batch is absent. A batch offer, payment or
administrative operation cannot run without batch configuration. Exact
verification, acceptance before protected work, and durable replay/recovery
requirements remain in force. Choose `exactProfile: "additive"` with a head
store/reconciler, or follow the [hash-chain specification](../spec/kaspa-hash-chain-exact-v1.md)
for issuer, admission and authoritative current-head observers. An exact-only
hash-chain server omits `chainProvider`, because the payer broadcasts.

## Exact client

```ts
const client = new DirectModeClient({
  confirmationThreshold: 30,
  addressCodec,             // scriptPublicKeyForAddress
  fundingProvider,          // ExactFundingProvider
  store,                   // ExactPaymentAttemptStore
  exactPaymentReconciler,
  fundingPolicy: {
    requiredSource: "hot-wallet",
    allowedOrigins: ["https://merchant.example"],
    allowedExactProfiles: ["standard-native"],
    allowedPayTo: [merchantAddress],
    maximumExactAmountSompi: "20000000",
  },
});
```

An exact provider supplies durable artifact preparation/finalization and the
profile's signing/broadcast operations. It needs no escrow builder, voucher
signer, channel discovery or refund machinery. Merchant responses acknowledge
the retry; trusted reconciliation decides whether a disclosed artifact was paid.
The client requires all five policy bounds shown above or an explicit
`authorizeExactPayment` callback before wallet work.
Use `createPayment` for HTTP and `paidMcpToolCall` for MCP. The latter supplies
the host-authenticated audience to the separate MCP payment entry point.

## Enable batch

Add `batch` to the server with `serverPublicKey`, `minDepositSompi`,
`claimReserveSompi`, `refundTimeoutDaa`, `voucherVerifier` and
`batchPresentationVerifier`. Optional refund-window policy, `claimPolicy`,
`claimBuilder`, `claimReconciler`, `topUpVerifier` and template settings also
belong there. The shared store must then implement `ServerStateStore`, and
`chainProvider` must implement the full `ServerChainProvider`.

Add `batch` to the client with `signer`, optional `refundAddress`,
`refundBuilder`, `refundReconciler`, `fundingTransitionReconciler` and
`verifyVoucherSignature`. Supply the full `FundingProvider`, `ChannelStore`
and address codec, plus all payer-owned caps in `fundingPolicy.batchPayment`.
Batch offer selection still requires authoritative lineage discovery and the
payer's explicit authorization callback.

A combined server keeps the existing default batch offer. Select one or both
schemes explicitly per route with `paymentScheme` / `paymentSchemes`. Both use
one store and lock domain: splitting them into independent replay databases
would break cross-scheme payment-identifier ownership. The
[mock examples](../examples/README.md) show combined HTTP/MCP/recovery wiring.

These configuration changes require a package version change before publication;
see [versioning](versioning-policy.md). For dependency setup, verification and
proof limits, return to the [protocol entry point](../README.md).
