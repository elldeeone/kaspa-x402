# Native-KAS hash-chain Testnet-10 proof

Status: candidate validation, 2026-09-22. This is a funded Testnet-10 run of
the unreleased `hash-chain-additive` x402 profile, not mainnet evidence or a
release designation. The local detailed report is ignored by Git at
`.kaspa-x402-live/hash-chain-proof-20260922-final/report.json`; signing keys and
the encrypted grant database remain in that private directory.
This run predates the subsequent reorg, grant-readback and fee fixes. A fresh
funded run against the final candidate is still required for release evidence.

## Reproduce

Build the workspaces, then run the proof script with a funded Testnet-10
private-key file and a synced Testnet-10 PNN node with a UTXO index:

```sh
npm run build
node scripts/proof-hash-chain-testnet.mjs --live \
  --wallet-file /path/to/private-testnet-wallet.json \
  --rpc-url wss://your-testnet-10-node/kaspa/testnet-10/wrpc/borsh \
  --output-dir .kaspa-x402-live/hash-chain-new-run
```

The script creates a private funding shard if needed, generates a new owner
and hash chain, broadcasts genesis, serves two loopback x402 resources, claims
and broadcasts both payer-signed spends, deliberately abandons a third grant,
and broadcasts an owner rotation. It requires both payment responses to be
HTTP 200 with `PAYMENT-RESPONSE.success = true` and each transaction to be
selected on chain before reporting success. It records the full response and
head lineage locally. It does not reuse an output directory.

## Observed run

The final run started at 09:12:40 UTC and completed at 09:13:28 UTC. Its KIP-20
covenant ID was
`435c3dbe5ae699e42ceb1dfcef4a572f855801bf43d5ce378112cdc11ca32aee`
from genesis through both borrows and owner rotation.

| Step | Accepted transaction | Head amount after step | x402 response |
| --- | --- | ---: | --- |
| Genesis | `edee35cc6cc3b33184f911ad72d3391f9655d44b28f7bd95a95e2f2c9b378f2b` | 99,000,000 sompi | — |
| Payer 1 | `dfeed46db78dacd73532283f66f17a8533eaa4a1363dae8e87ac843c0e243d36` | 119,000,000 sompi | HTTP 200; `success=true`; response header SHA-256 `a9f1f96146e0199aba5f67b4ad7d093ab10c5387225489a804c642dbe1b12f39` |
| Payer 2 | `2e8714524b494e2adc43363ff784cbd2d369c5ff89708a0ef457a10ed6ecd8db` | 139,000,000 sompi | HTTP 200; `success=true`; response header SHA-256 `05c0bc94311b21c47b8fe168d04de8eeb4a60f0e33585b16701ef20a90f67b6f` |
| Owner rotation after abandoned grant | `39dd5b9f0910cc5515bd7ec90f57c59e53c1d8be070f4b834ab95f489cfc6383` | 139,000,000 sompi | Head version 2 → 3; ready with a new guard |

Both payments increased the same head by the quoted 20,000,000 sompi. The
server returned a resource only after its selected-chain verifier accepted the
respective fully payer-signed transaction. The abandoned grant was delivered
for version 2 and never used; its local expiry put issuance into
`needsRotation`. The owner then spent that head into a new guard under the
same covenant ID. The predecessor of each row is the prior row's output 0;
the private report also records the accepting blocks, grant assignments and
full x402 settlement responses.

The private report records SHA-256 fingerprints for the exact built core,
covenant, server, encrypted issuer, client, facilitator and CLI modules and
the proof script. The client bundle fingerprint is
`109a27133dad29d2b6e59b9a641c10aa1e72617ebfe461b7f5a32e53e8e87ed0`;
the server bundle fingerprint is
`cdd85b814479a53022a312a8923546a1ac682c3fc197fc3a210518557da66fe5`.

The genesis was observed with 30 selected-chain confirmations. The payment
and rotation checks used the Testnet-10 REST transaction and selected
accepting-block status (`accepted` finality); they did not establish 30
confirmations for those transactions. One public RPC source and one REST API
were used, without independent node corroboration. The loopback HTTP server
used the candidate SDK and server code; the hosted gateway was not deployed
for this proof.

Earlier exploratory runs left separate Testnet covenant heads after a relay
fee rejection and an overly strict extra RPC confirmation scan. Those runs
are not counted above; their private reports are retained locally for
reconciliation.
