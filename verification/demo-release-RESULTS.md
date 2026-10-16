# 1.0.0 demo qualification

The built browser paid successfully through the actual Worker/SQLite Durable
Object and authenticated bounded Node relay on funded Testnet-10. This was a
local HTTPS preview of the candidate, not a deployment.

Execution revision: `61ae121a7962b76fc7e4ea171c18beb13280b2c6`.
[Machine-readable evidence](demo-release-1.0.0.json).

- Quote 402 → grant 200 → accepted Testnet transaction → protected report 200.
- An initial paid 503 recovered automatically with the same payment.
- Browser retry returned 200 with the same transaction; the head advanced once,
  from 100,000,000 to 120,000,000 sompi. A separate reconnected node observer
  confirmed the successor UTXO.
- Three accepted transactions: head setup, payer funding and browser payment.
  Total fees: 3,000,000 sompi (0.03 Testnet KAS).
- 87 adapter regressions, 146 gateway regressions, the three-group built-Worker
  relay proof, moving-tip acceptance-window E2E proof and website checks passed.
- The four canonical public SDK archives remain byte-identical to the original
  1.0.0 qualification. Its funded report verifier still passes. The private PNN
  adapter change is covered by the new regressions and funded demo proof here.

Funded report SHA-256:
`a68fea2dda6698abc3b99b42839ec10edb307fae0a4320657613e3e5bf13c745`.
Payment transaction:
`e8ac3fb2a29c97e7cbe654c43ce015a5a70e30e31eacaf6a38fdc35793888a1d`.

Failed/interrupted attempts remain private with recovery keys and their original
reports. One repeat exposed the accepted-payment reconciliation failure: V2 Low
also includes transaction bodies. The adapter now counts compact V1 selected-chain
hash/ID positions, requests a smaller rich-data window at the node, and rechecks
its checkpoints. The message limits and selected-parent depth requirements were
not increased or replaced with blue-score distance.

## Repeat

From a clean candidate checkout, build the Worker and site, then run:

```sh
node verification/proof-demo-release-e2e.mjs --out /private/demo-controlled.json
node verification/proof-pnn-acceptance-window-e2e.mjs --out /private/pnn-window.json
node scripts/proof-browser-demo-testnet.mjs --live \
  --config /private/browser-proof.json --out /private/fresh-browser-run
```

The funded config and complete output directory contain private recovery material;
keep them out of Git. See the [operator procedure](../docs/demo-operations.md#100-demo-cutover).

Evidence uses one configured Testnet node. It does not establish an independent
mainnet quorum, a deployed-host smoke, or production throughput. Deployment,
merge and publication remain separate actions requiring authorization.
