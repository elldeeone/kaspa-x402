# Transaction V1 Plan

This plan defines the transaction-builder requirements for Kaspa x402 `upto`
and `batch-settlement` support. It is intentionally executable as a checklist:
no mainnet builder should ship until each production path has a vector with a
serialized transaction body/projection, transaction id, hash, sighash input,
compute budget, and fee accounting.

Batch claim/refund now have reference transaction-v1 vectors under
`vectors/tx-v1/`. `upto` authorization and zero-charge settlement fixtures are
covered by `vectors/upto/authorization.json`; the native nonzero `upto`
transaction-v1 body remains future work. Until that vector exists, nonzero
`upto` settlement support is adapter-gated and requires an implementation
provided settlement transaction verifier; it must not be presented as a built-in
mainnet-ready transaction builder.
In those vectors, `serializedTransaction` is the deterministic transaction hash
preimage/projection, not a submit-ready RPC transaction payload. The `mass`
field is contextual storage mass and must not be replaced with serialized-size
estimates.

## Batch Settlement Claim

- Input: the active escrow outpoint, using `kaspa-x402-escrow-v1` script public key.
- Subnetwork/gas: native subnetwork only, with gas `0`.
- Signature script: `push(serverSig(65)) || push(voucherSig(64)) || push(amount_le64) || selector(0) || push(redeemScript)`.
- Outputs: exactly two outputs.
- Output covenant bindings: not used in the current script-level profile. Every output covenant field is absent/null.
- Output 0: server claim output. Its value must be less than or equal to the voucher amount, and its serialized script public key must hash to the payout hash embedded in the escrow script.
- Output 1: continuation escrow output. Its script public key must equal the spent escrow script public key and its value must be positive.
- Remainder rule: output 1 must be at least `inputAmount - voucherAmount`. Reference builders preserve the stronger direct-mode remainder `inputAmount - claimAmount` so an over-authorized voucher ceiling does not consume uncharged value.
- Fee rule: claim transaction fees come out of the server output, never the continuation output.
- Script-unit estimate: `200544`.
- Compute budget: `20`, derived from Toccata's `compute_budget * 10000 + 9999` allowance.

## Batch Settlement Refund

- Input: any refundable escrow outpoint for the channel.
- Subnetwork/gas: native subnetwork only, with gas `0`.
- Signature script: `push(clientSig(65)) || selector(1) || push(redeemScript)`.
- Output: exactly one refund output whose serialized script public key hashes to the refund hash embedded in the escrow script.
- Output covenant bindings: not used in the current script-level profile. Every output covenant field is absent/null.
- Lock rule: transaction lock time must be greater than or equal to the escrow timeout DAA score, and the input sequence must be `0`.
- Fee rule: refund fees come out of the refunded value.
- Script-unit estimate: `100000`.
- Compute budget: `10`, derived from Toccata's `compute_budget * 10000 + 9999` allowance.

## Upto Settlement

- Input: the authorization outpoint defined by the `kaspa-upto-v1` binding.
- Nonzero outputs: exactly two outputs, with output 0 paying the server and output 1 returning a positive refund amount to the client refund script.
- Amount rule: server output is the actual settled amount, bounded by the signed maximum amount, and the authorization input must include enough value for the signed fee reserve plus the required positive refund output.
- Zero-charge rule: the zero-charge path must use the no-transaction settlement response shape already defined in `kaspa-upto-v1`; it must not pretend value moved.
- Fee rule: non-zero settlement fees come from the authorization value after satisfying the bounded server payment.
- Readiness rule: built-in nonzero settlement builders must remain disabled or external-adapter-only until the executable transaction vector covers the serialized body, txid/hash, sighash, compute budget, and script-unit estimate.

## Required Vectors

- `upto-settlement-transaction-body`
- `upto-zero-charge-no-transaction-response` - covered by `vectors/upto/authorization.json`
- `batch-claim-transaction-body` - covered by `vectors/tx-v1/batch-claim.json`
- `batch-refund-transaction-body` - covered by `vectors/tx-v1/batch-refund.json`
- transaction id for each transaction body
- transaction hash for each transaction body
- sighash preimage and digest for every signed input path
- compute budget for every covenant-backed path
- script-unit estimate for every covenant-backed path
