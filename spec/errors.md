# Error Codes

Status: draft

Kaspa x402 errors use the prefix:

```text
invalid_kaspa_x402_*
```

Common initial error set:

```text
invalid_kaspa_x402_scheme
invalid_kaspa_x402_network
invalid_kaspa_x402_asset
invalid_kaspa_x402_amount
invalid_kaspa_x402_pay_to
invalid_kaspa_x402_binding
invalid_kaspa_x402_payload
invalid_kaspa_x402_payment_identifier_conflict
invalid_kaspa_x402_settlement_failed
```

Scheme-specific initial error set:

```text
invalid_kaspa_exact_transaction
invalid_kaspa_exact_transaction_id
invalid_kaspa_exact_payment_output
invalid_kaspa_exact_replay
invalid_kaspa_exact_finality
invalid_kaspa_upto_authorization
invalid_kaspa_upto_expired
invalid_kaspa_upto_recipient
invalid_kaspa_upto_max_amount
invalid_kaspa_upto_replay
invalid_kaspa_upto_settlement_amount
invalid_kaspa_upto_authorization_outpoint
invalid_kaspa_upto_template
invalid_kaspa_batch_template
invalid_kaspa_batch_channel_id
invalid_kaspa_batch_channel_state
invalid_kaspa_batch_corrective_state
invalid_kaspa_batch_funding_outpoint
invalid_kaspa_batch_funding_amount
invalid_kaspa_batch_voucher_signature
invalid_kaspa_batch_voucher_network
invalid_kaspa_batch_voucher_script
invalid_kaspa_batch_voucher_outpoint
invalid_kaspa_batch_cumulative_amount_mismatch
invalid_kaspa_batch_cumulative_below_claimed
invalid_kaspa_batch_insufficient_channel_balance
invalid_kaspa_batch_channel_busy
invalid_kaspa_batch_commitment
invalid_kaspa_batch_handler_failed
invalid_kaspa_batch_refund_not_mature
invalid_kaspa_batch_claim_dust
invalid_kaspa_batch_compute_budget
```

Common error meanings:

| Error | Meaning |
| ----- | ------- |
| `invalid_kaspa_x402_payment_identifier_conflict` | The same payment identifier was reused for a different normalized request fingerprint. |
| `invalid_kaspa_x402_settlement_failed` | Verification passed but the scheme-specific settlement or commitment step failed. |
| `invalid_kaspa_exact_finality` | The exact payment transaction did not reach the required finality policy. |
| `invalid_kaspa_upto_settlement_amount` | The actual charge exceeds the signed maximum or is malformed. |
| `invalid_kaspa_batch_corrective_state` | A corrective 402 included channel or voucher state that does not verify. |
| `invalid_kaspa_batch_commitment` | A batch commitment could not be stored or identified. |
| `invalid_kaspa_batch_handler_failed` | The protected handler failed and no batch charge was committed. |
