# Batch Transaction V1 Reference

Status: Alpha.10, Testnet-10 only

The normative rules live in
[`kaspa-batch-settlement-v2.md`](kaspa-batch-settlement-v2.md). This document is
a compact map from those rules to the claim, top-up, and refund transaction-v1
vectors.

All vectors use native transaction version 1, contextual storage mass, and
per-input `computeBudget`. Transaction identifiers, hashes, signature hashes,
script units, and covenant state transitions MUST be reproduced with the
configured Rusty Kaspa consensus implementation. JSON projections are not
submit-ready RPC payloads.

Common KIP-20 rules:

- the persisted current outpoint is the only accepted head;
- the active input carries one non-zero stable covenant id `C`;
- same-id successor outputs must be authorized by that input and validate the
  exact output state;
- no unbound payout, change, or refund output may carry `C`;
- `S`, `T`, and `D` are non-negative signed-int64 values.

## Genesis

Genesis uses one or more native funding inputs and exactly one output: the
expected covenant output at index 0 with state `S = 0`. Funding inputs equal
the covenant value plus fee, so canonical genesis has no change output. The
KIP-20 covenant id is derived from input 0's outpoint and the authorized output
group, then persisted with the resulting current outpoint.

## Partial Claim

```text
input[0]  = current head (id C, state S, value V)
output[0] = unbound provider payout P
output[1] = sole same-id successor (state S+D, value V-D)
```

- Signature arguments: provider transaction signature, buyer voucher
  signature, `T_le64`, `D_le64`, claim selector, redeem script.
- Covenant bound: `0 < D <= T-S` with guarded `S+D`.
- Application bound: `D <= A-S`.
- Output 0 script hashes to the constructor payout script hash.
- Claim fee is `D-P` and reduces the provider payout only.
- Exactly one same-id input and one authorized same-id output are allowed.
- The same lifetime voucher remains usable after the accepted successor because
  `S` advances while `T` does not reset.

## Top-Up

```text
input[0]   = current head (id C, state S, value V)
input[1..] = one or more native client funding inputs
output[0]  = sole same-id successor (state S, value V' > V)
output[1]  = optional unbound client change
```

- The covenant input uses the client transaction signature and
  `SIGHASH_ALL`.
- Output 0 is authorized by input 0 and preserves state `S` exactly.
- Optional output 1 hashes to the configured refund script and has no covenant
  binding.
- Exactly one same-id input and one same-id output are allowed.
- Application totals `A`, `S`, and `T` are preserved.

## Refund

```text
input[0]  = current head (id C, state S, value V)
output[0] = one unbound client refund output
```

- Signature arguments: client transaction signature, refund selector, redeem
  script.
- Lock time satisfies the absolute DAA timeout and remains below the timestamp
  interpretation boundary.
- The refund output hashes to the constructor refund script hash.
- No output carries `C`; the lineage terminates.
- Fees reduce the refund output.

## Required Vector Coverage

The transaction-v1 vector set MUST cover:

- partial claim and repeated claim with the same lifetime voucher;
- top-up with and without client change;
- refund at the DAA boundary;
- wrong covenant id, duplicate same-id input/output, wrong authorizing input,
  wrong successor state/value, and bound payout/change/refund rejection;
- signed-int64 overflow, compute-budget underfunding, mutated signatures, and
  full populated-transaction consensus validation.
