# @kaspa-x402/client

Client SDK for direct-mode Kaspa x402 payments.

Status: alpha. This package targets testnet iteration and mock/local examples;
it is not a production wallet, custody, or mainnet funding system.

The current implementation covers HTTP paid fetch and MCP paid tool calls for `exact` one-shot transfers and `batch-settlement` escrow channels:

- parses x402 v2 `PAYMENT-REQUIRED` headers;
- selects supported `exact` and `batch-settlement` Kaspa offers;
- creates reservation-backed `exact-transaction` retries through an injected funding adapter;
- opens deposit-voucher channels through an injected funding provider;
- reuses channels with outpoint-bound cumulative vouchers;
- verifies `PAYMENT-RESPONSE` transaction, amount, output index, finality, and channel state before advancing local charged amounts;
- detects MCP payment-required tool results, retries with `_meta["x402/payment"]`, and applies `_meta["x402/payment-response"]`;
- exposes refund eligibility and adapter-driven refund broadcast hooks.

Mainnet funding fails closed unless `allowMainnet: true` is set. The default
offer selector accepts only `kaspa:testnet-10`; operators that opt into mainnet
must provide explicit funding, signer, node, custody, and review controls.

Wallet, node, address-codec, and transaction-builder behavior is injected through typed adapters. Amounts on the wire remain decimal sompi strings.
