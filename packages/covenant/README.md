# @kaspa-x402/covenant

Escrow covenant helpers for the Kaspa x402 `batch-settlement` binding.

This package builds deterministic redeem scripts and signature-script argument
blobs for `kaspa-x402-escrow-v1`. The redeem script binds the client key,
server key, network hash, payout script-public-key hash, refund
script-public-key hash, and timeout. It does not sign transactions, broadcast
transactions, or encode wallet addresses. Address text encoding is supplied by
the caller through a Kaspa runtime codec.

The amount unit in this package is sompi.
