# Demo Interoperability Checklist

Status: external-style readiness checklist for the public alpha demo surface.
Reviewed on 2026-07-14.

This checklist is written from the perspective of an implementer arriving at
the site without repository context.

## Findings

| Question | Result |
| -------- | ------ |
| Can a reader find the canonical schemas? | Yes. `/schemas/` lists every schema with a purpose note and hash. |
| Can a reader find the supported schemes and networks? | Yes. The homepage, specs, and gateway docs state `exact`, `batch-settlement`, `kaspa:testnet-10`, and `KAS`. |
| Can a reader run fixture validation? | Yes. `/vectors/` groups fixtures by directory and `npm run validate:schemas` validates committed fixtures locally. |
| Can a reader hit a real endpoint? | Read-only only. `https://demo.kaspa-x402.org` exposes `/health`, `/canary`, `/supported`, `/exact`, and `/batch`, but it has not been redeployed or paid-canary proven for alpha.7. |
| Does the endpoint advertise current payable terms? | No. On 2026-07-14 exact inventory was empty and the historical batch deployment advertised `refundTimeoutDaa: "3600"`, not the freshly computed absolute DAA required by alpha.7. Do not fund the offer. |
| Does the endpoint publish operational status? | Yes. `/health` exposes chain evidence, metrics, enabled state, and latest canary when present; `/canary` exposes enabled state and the stored canary report after the scheduled job has run, including a release-snapshot freshness check. |
| Does the public material imply mainnet readiness? | No. The site and gateway docs frame the deployment as alpha and `kaspa:testnet-10` only. |
| Does the site publish internal planning or review drafts? | No. The site checker blocks ignored planning files, review files, and private announcement drafts. |

## Manual Checks

Recommended external manual checks:

1. Fetch `/schemas/payment-required.schema.json` and verify the `$id`.
2. Fetch `/vectors/index.json` and spot-check fixture hashes.
3. Call `GET https://demo.kaspa-x402.org/supported`.
4. Call `GET https://demo.kaspa-x402.org/exact` and decode
   `PAYMENT-REQUIRED`.
5. Call `GET https://demo.kaspa-x402.org/batch` and decode
   `PAYMENT-REQUIRED`.
6. Submit a foreign-scheme retry and confirm `unsupported_scheme`.
7. Do not submit funds until the gateway reference records an alpha.7 redeploy,
   a valid absolute refund DAA, and funded exact and batch canaries.

## Current Limitations

- The scheduled canary is non-spending. Paid canaries are manual because the
  Worker does not hold spending keys.
- The Worker uses REST accepted-UTXO evidence; the static browser demo uses
  PNN/WASM for client-side connectivity checks.
- Claim broadcasting is disabled in the hosted gateway.
- Durable state is alpha operational state and may be reset after an incident
  with disclosure.
- Mainnet remains blocked by the documented gates.

## Acceptance Verdict

The static schemas, vectors, and unpaid endpoint shapes are suitable for alpha
interoperability inspection on `kaspa:testnet-10`. The hosted deployment is not
suitable for funded testing until it is redeployed and paid-canary proven from
alpha.7 source. It is not suitable for mainnet funds, production use, or
unreviewed third-party custody patterns.
