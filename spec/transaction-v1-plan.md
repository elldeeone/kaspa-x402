# Batch Transaction V1 Reference

The normative transaction rules now live in
[`kaspa-batch-settlement-v1.md`](kaspa-batch-settlement-v1.md). This document is
retained as a compact map from those rules to the committed claim and refund
transaction-v1 vectors.

Batch claim and batch refund have reference transaction-v1 vectors under
`vectors/tx-v1/`.
The transaction-v1 vectors are cross-validated against `kaspa-consensus-core`
2.0.1 at commit `78257f273a26c4be085bab0f79437dee99ca8835` by
`npm run validate:tx-v1-consensus`.
In those vectors, `serializedTransaction` is the deterministic transaction hash
preimage/projection, not a submit-ready RPC transaction payload. The `mass`
field is contextual storage mass and must not be replaced with serialized-size
estimates.

Canonical transaction-v1 semantics used by the vectors:

- txid `rest_digest` excludes signature scripts, payload, mass, and compute budget;
- transaction hash includes v1 compute budget and the v1 mass field;
- v1 sighash excludes compute budget;
- empty payload txid uses the canonical `PayloadDigest` empty-payload digest, while empty native sighash payload uses the zero hash;
- storage mass and estimated serialized size are calculated by canonical consensus code.
- both escrow branches execute through `kaspa-txscript` with populated UTXO
  entries;
- mutated transaction signatures are rejected;
- each complete populated transaction passes post-Toccata consensus validation.

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

## Implemented Vectors

- `batch-claim-transaction-body` - covered by `vectors/tx-v1/batch-claim.json`
- `batch-refund-transaction-body` - covered by `vectors/tx-v1/batch-refund.json`
- transaction id for each transaction body
- transaction hash for each transaction body
- sighash preimage and digest for every signed input path
- compute budget for every covenant-backed path
- script-unit estimate for every covenant-backed path
