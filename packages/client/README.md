# @kaspa-x402/client

Client SDK for direct-mode Kaspa x402 payments.

The current implementation covers HTTP paid fetch for `batch-settlement` escrow channels:

- parses x402 v2 `PAYMENT-REQUIRED` headers;
- selects supported `batch-settlement` / `kaspa:*` / `kaspa-escrow-v1` offers;
- opens deposit-voucher channels through an injected funding provider;
- reuses channels with outpoint-bound cumulative vouchers;
- verifies `PAYMENT-RESPONSE` channel state before advancing local charged amounts;
- exposes refund eligibility and adapter-driven refund broadcast hooks.

Wallet, node, address-codec, and transaction-builder behavior is injected through typed adapters. Amounts on the wire remain decimal sompi strings.
