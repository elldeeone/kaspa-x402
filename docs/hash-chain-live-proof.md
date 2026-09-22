# Native-KAS hash-chain Testnet-10 proof

Status: candidate validation, 2026-09-22. These are funded Testnet-10 runs of
the unreleased `hash-chain-additive` x402 profile, not mainnet evidence or a
release designation. The latest run used committed runtime code `bd62fee`.
Its detailed report is ignored by Git at
`.kaspa-x402-live/hash-chain-proof-20260922-bd62fee-retry1/report.json`;
signing keys and the encrypted grant database remain in that private directory.

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

## Post-review run on `bd62fee`

The run started at 13:08:11 UTC and completed at 13:08:58 UTC. Its KIP-20
covenant ID was
`d1d1550880711277ec26d8a30fba9d4de2ad61aedcdc298784bf6726d746dec3`
through genesis, both payer borrows and owner rotation.

| Step | Accepted transaction | Head amount after step | x402 response |
| --- | --- | ---: | --- |
| Genesis | `81ea9ed5392ab9b07664e0503f68b56686cc7b4ac360f032b62baad799d687b2` | 99,000,000 sompi | — |
| Payer 1 | `d4678e9cce02726975ce2e32013fd365286994da232e4de585e46c191cd70f37` | 119,000,000 sompi | HTTP 200; `success=true`; response header SHA-256 `60cab1aa7b472d397f2d606e5fdafbbf78ccc4ceb2f0cca29da7654a3610b369` |
| Payer 2 | `f0960f40aef3bf06fa64d9a2aaa0cd7f0e8fa8cc900141b54b9c7fc2caed5b9d` | 139,000,000 sompi | HTTP 200; `success=true`; response header SHA-256 `ce5b8cdd26d91dfa048c2f7cea03d28d138fe1dceb1fbbb4689ca9bd4ed85fc0` |
| Owner rotation after abandoned grant | `f239fcf90c8ad172a06c63371da3e9882d10ce11df46b21ec107cba833aef237` | 139,000,000 sompi | Head version 2 → 3; ready with a new guard |

Both payments increased the same head by the quoted 20,000,000 sompi. The
private report records selected-chain readback, the accepting blocks, both
x402 settlement responses and hashes of seven built modules and the proof
script. Those hashes match the rebuilt files from `bd62fee`. A fresh readback
after the run still found all four transactions selected. Genesis had 30
selected-chain confirmations; the payment and rotation evidence establishes
`accepted` finality, not 30 confirmations. The proof used one public Testnet-10
RPC node and one REST API, with no independent full-node corroboration or
hosted-gateway deployment.

The first attempt against a different RPC endpoint timed out with a funding
shard still unspent. The successful retry used that shard and a new private
output directory. The first attempt is not counted as a payment proof.

## Earlier run (before the grant-readback fix)

The earlier run started at 09:12:40 UTC and completed at 09:13:28 UTC. Its KIP-20
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
