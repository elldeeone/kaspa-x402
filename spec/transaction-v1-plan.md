# Transaction V1 Plan

This plan defines the transaction-builder requirements for Kaspa x402 `upto`
and `batch-settlement` support. It is intentionally executable as a checklist:
no mainnet builder should ship until each row has a vector with serialized
transaction body, transaction id, hash, sighash input, compute budget, and fee
accounting.

## Batch Settlement Claim

- Input: the active escrow outpoint, using `kaspa-x402-escrow-v1` script public key.
- Signature script: `serverSig(65) || voucherSig(64) || amount_le64 || selector(0) || redeemScript`.
- Outputs: exactly two outputs.
- Output 0: server claim output. Its value must be less than or equal to the voucher amount, and its serialized script public key must hash to the payout hash embedded in the escrow script.
- Output 1: continuation escrow output. Its script public key must equal the spent escrow script public key.
- Remainder rule: output 1 must be at least `inputAmount - voucherAmount`.
- Fee rule: claim transaction fees come out of the server output, never the continuation output.
- Compute budget: `3`, covering the server signature operation, voucher signature-from-stack operation, and hashing/introspection overhead.

## Batch Settlement Refund

- Input: any refundable escrow outpoint for the channel.
- Signature script: `clientSig(65) || selector(1) || redeemScript`.
- Output: exactly one refund output whose serialized script public key hashes to the refund hash embedded in the escrow script.
- Lock rule: transaction lock time must be greater than or equal to the escrow timeout DAA score, and the input sequence must be `0`.
- Fee rule: refund fees come out of the refunded value.
- Compute budget: `1`.

## Upto Settlement

- Input: the authorization outpoint defined by the `kaspa-upto-v1` binding.
- Nonzero outputs: payment to server, and change/refund output when value remains.
- Amount rule: server output is the actual settled amount, bounded by the signed maximum amount.
- Zero-charge rule: the zero-charge path must use the no-transaction settlement response shape already defined in `kaspa-upto-v1`; it must not pretend value moved.
- Fee rule: non-zero settlement fees come from the authorization value after satisfying the bounded server payment.

## Required Vectors

- `upto-settlement-transaction-body`
- `upto-zero-charge-no-transaction-response`
- `batch-claim-transaction-body`
- `batch-refund-transaction-body`
- transaction id for each transaction body
- transaction hash for each transaction body
- sighash preimage and digest for every signed input path
- compute budget for every covenant-backed path
- script-unit estimate for every covenant-backed path
