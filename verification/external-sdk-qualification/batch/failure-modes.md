# External batch qualification failure modes (before harness)

1. A/S/T/V/R lifetime drift after repeated fixed-price vouchers, partial claims, top-ups, integer boundaries, reserve exhaustion, or reuse.
2. Duplicate payments, duplicate identifiers, stale heads and simultaneous transitions execute protected work more than once or charge twice.
3. Forged voucher/presentation signatures, changed body/URL/MCP arguments, changed principal, changed accepted terms, or expired presentation bypass binding.
4. Refund admission at/below minimum lead DAA, or an interrupted adapter permits protected work beyond the refund bound.
5. Handler throws, process/store interruption, unknown settlement outcome, or retries across a server restart repeat work without explicit recovery.
6. Shared atomic memory-store restart loses completed receipts or pending work; fresh store restart is explicitly non-durable and cannot promise replay protection.
7. Claim/top-up builder, chain acceptance, or successor scripts violate lifetime accounting or allow stale vouchers after a head transition.

Scope: installed published API archives only. Real loopback HTTP/MCP, genuine Schnorr voucher/presentation signatures and public covenant compilation. Chain acceptance is a controlled test adapter and does not prove consensus acceptance or funded network operation. No broadcasts.
