# @kaspa-x402/client

Client SDK for direct-mode Kaspa x402 payments.

The current implementation covers HTTP paid fetch for `exact` one-shot transfers, `upto` capped one-shot authorizations, and `batch-settlement` escrow channels:

- parses x402 v2 `PAYMENT-REQUIRED` headers;
- selects supported `exact`, `upto`, and `batch-settlement` Kaspa offers;
- creates `exact-transfer` retries through an injected funding adapter;
- creates `upto-authorization` retries through injected funding and signing adapters;
- opens deposit-voucher channels through an injected funding provider;
- reuses channels with outpoint-bound cumulative vouchers;
- verifies `PAYMENT-RESPONSE` transaction, amount, output index, finality, no-transaction zero-charge `upto` responses, and channel state before advancing local charged amounts;
- exposes refund eligibility and adapter-driven refund broadcast hooks.

Wallet, node, address-codec, and transaction-builder behavior is injected through typed adapters. Amounts on the wire remain decimal sompi strings.
