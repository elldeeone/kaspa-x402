# @kaspa-x402/server

Server SDK for direct-mode Kaspa x402 payments.

Status: alpha. This package targets testnet iteration and reference server
flows; production deployments need independent review, durable storage, key
management, and the mainnet gates in the repository docs.

The current implementation covers framework-neutral HTTP gating and MCP paid tool wrappers for `exact` one-shot transfers and `batch-settlement` escrow channels:

- builds x402 v2 `PAYMENT-REQUIRED` offers;
- extracts and validates `PAYMENT-SIGNATURE` retries;
- verifies exact transaction output amount, pay-to script, transaction id, and finality through an injected verifier;
- defaults exact offers to `standard-native` and can optionally select, claim,
  and atomically advance reusable KIP-10 additive heads;
- verifies funding outpoints, escrow scripts, and cumulative vouchers through injected adapters;
- serializes per-transaction or per-channel verification, handler execution, and state commit;
- stores exact transaction replay records before returning protected content;
- stores per-request settlement commitments before advancing channel charge state;
- supports payment identifier idempotency for exact and batch payment-payload retries;
- returns corrective `402` responses with channel state where possible;
- returns MCP payment-required tool results, requires a trusted configured MCP
  server `audience` in the tool-call fingerprint, reads
  `_meta["x402/payment"]`, and attaches `_meta["x402/payment-response"]`
  without exposing protected content on settlement failure;
- exposes direct verifier and settlement helpers used by optional self-hosted facilitator endpoints;
- validates custom per-request amounts when `PaidRequest.paymentAmount` is supplied;
- exposes claim preview and claim execution hooks with pending-claim tracking and explicit abandon-after-reconciliation support.

Mainnet runtime use fails closed unless `allowMainnet: true` is set.

Node, indexer, address-codec, signature-verifier, transaction-builder, settlement-transaction-verifier, and state-store behavior is injected through typed adapters. Production deployments should back the state store with durable transactional storage that follows [the server store contract](../../docs/server-store-contract.md). Amounts on the wire remain decimal sompi strings.

Protected handlers run after payment verification and before the durable payment
commit. Handlers with non-repeatable side effects should require the
`payment-identifier` extension and keep their own idempotency or outbox record
keyed by payment identifier and request fingerprint.
