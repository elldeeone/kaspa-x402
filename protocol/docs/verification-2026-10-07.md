# Protocol verification — 2026-10-07

Source base: `6d0690f6a957cda1179f74db9e22a921ef08cee8` with the verification changes in this working tree. Protocol SDK runtime source, contracts, schemas and signed vectors are unchanged from that commit. Proof scripts now accept explicit external SDK and bounded fee inputs; this is not a tagged release.

The funded-run source snapshot digest (sorted relative source paths and SHA-256 values) is `fcc8b4058a8ac9de991bf0f9e56446689927dde17264dc1ca6fd4e211edc2f7c`. The complete private source/runtime manifest and reports are retained under `.kaspa-x402-live/protocol-verification-20261007T122111Z/` at the repository root. Signing and recovery keys stay there.

After these runs, review fixes capped the exact/batch proof fee at 40,000,000 sompi and separated client/server test helpers. The recorded 40,000,000-sompi run remains within that cap. The source digest and proof-script fingerprints below identify the files used for the funded runs, before those fixes; they are not hashes of the final working tree. No funded run was repeated for the review fixes.

## Local checks

- All seven package source/test type checks and the reference test suites passed.
- Standalone `protocol/` installation and `verify` passed under Node 22.16.0 and Node 24.15.0, including HTTP interoperability vectors, fixtures, upstream compatibility tests and package dry runs.
- Independent website and gateway install/build/test checks passed.
- [CI consensus report for the unchanged base](https://github.com/elldeeone/kaspa-x402/actions/runs/37619089003) passed against clean Rusty-Kaspa `01b532e8b553523216471682649693af92f0fd16` (2.1.0). It includes all six signature scopes and independent covenant guards; this is reused baseline evidence, not a new consensus run for these test/tooling changes.

After the review fixes, standalone installation and `verify` passed again under Node 24.15.0. The isolation check now runs the client-only test command before building other packages: all 134 client tests and its type check passed without server declarations. Fee regression checks accepted the exact/batch default and 40,000,000-sompi cap, and rejected larger values before SDK or wallet access. The earlier Node 22, website and gateway checks above were not repeated for these fixes.

## Funded Testnet-10 checks

Both runners use the current escrow-v5/head-v2 code, reference ALL signatures, Node 24.15.0 and one configured synced PNN running 2.1.0 with a UTXO index. This is single-source selected-chain evidence. It does not establish independent-node agreement, hosted deployment, upstream SDK settlement or mainnet readiness.

### Hash-chain paid requests and recovery

Completed: `2026-10-07T12:24:33.146Z`. Two loopback HTTP resources returned 200 with successful payment responses. After a third grant was abandoned, an accepted owner rotation restored the issuer to ready at head version 3.

| Step | Transaction ID | Evidence |
| --- | --- | --- |
| Genesis | `e9f04ef49a7cdab75cc796eb6609cb2fa02b981fb6b11735e4a7db37652fa895` | Accepted; 30 confirmations |
| Payment 1 | `f70bb37bdc6363ea9a91b36d5e05f1a4f870d20292aa2416e18f30a81f697b24` | HTTP 200; selected-chain acceptance; 1 confirmation(s) |
| Payment 2 | `8187baf1257fbe011d15dcb9bd1ebac09a448a608aef155a97023c25e0096715` | HTTP 200; selected-chain acceptance; 1 confirmation(s) |
| Owner rotation | `c2dca409164ad41f6099066c78481cbeb19629e6098c68fd159a522bd2fff48e` | Accepted; 1 confirmation(s) |

Covenant ID: `e082724fbc99b19a1b1af20cdf0bdf0b5283f3f95a6f33414d18d26643c19edd`. Head value progressed from 100,000,000 to 120,000,000 to 140,000,000 sompi; rotation retained the final amount. Fees were 60,000,000 sompi per owner/funding transaction and 10,000,000 per payer transaction. The public payer fee cap was unchanged.

### Exact and batch lifecycle

Completed: `2026-10-07T12:32:27+00:00` (report write time). All 18 required flows passed the live runner's result validator. Standard-native tiny/normal payments, additive head changes, concurrent conflicts, rejected authorizations, replay prevention and exact restart reconciliation passed. Batch genesis, vouchers, two claims, top-up, stale-head rejection, persisted recovery and terminal refund passed.

| Accepted step | Transaction ID | Finality |
| --- | --- | --- |
| Standard-native tiny | `d01f69e34234db55f29a63821a3a5d0cb302ee883db21746e7dde840bd156d25` | accepted |
| Standard-native normal | `9de7760a5798ce4e8804baf33c76cc5cb537639aba44be043346e1dc733ca843` | accepted |
| Additive payment | `91a3928a5223199a8d72267afe3e2af2019ebc646a6075ce7eb15df0ff16d713` | accepted |
| Concurrent additive winner | `3c777131f31886877eb237582a3c7d7aff71dfd50270c37bd7e78198b70f342e` | Accepted; one handler execution |
| Exact restart recovery | `5a300fbf0482997f9cbd878c6a95aec86edb217bf46f0c643aa73f560356e286` | accepted |
| External head advancement | `2e2821b3a6c0e2f012ecf960632db8c3acc5400a8a4ac7f7b2a17b81bda9b904` | accepted |
| Batch genesis/deposit | `a729883cace9c87aaf3cadb5fb5f859ce4b2e392288311bf82b3389d030b1577` | accepted |
| First claim | `535d40aa9624d627f66e9af3b151c5fdac0e2ce1f86bd5a1aea2f937aa5cba04` | confirmed |
| Second claim | `43beb875a2babc891e6525ca1592ddcb1e791c1c32c2c73b2987ddc5b6e02da3` | confirmed |
| Top-up | `88a10baf6c50dcee93a49a898b8e0d2194678ef303d3510c936d54e2380e1a7b` | accepted |
| Terminal refund | `9bbc7ed3a776f62d2d0f8be44a7f8d918c852ef8b8df49c0dc2934eedf6bdad0` | confirmed |

Batch covenant ID: `09f5136c6949626fcd49ae48b0cb6ac59d1320336f7ff11c9a72005309e1306b`. All values below are sompi; reserve R was `40000000`. The runner checked `0 <= S <= A <= T` and `(T - S) + R <= V` before refund.

| Step | A | S | T | V |
| --- | ---: | ---: | ---: | ---: |
| Deposit payment | 100000000 | 0 | 100000000 | 400000000 |
| Voucher-only payment | 200000000 | 0 | 200000000 | 400000000 |
| First claim | 200000000 | 100000000 | 200000000 | 300000000 |
| Second claim | 200000000 | 150000000 | 200000000 | 250000000 |
| Top-up | 200000000 | 150000000 | 200000000 | 650000000 |

The final refund left no covenant successor and both client/server records were refunded. Reloaded recovery retained the exact signed refund and transaction ID, applied it once and did not automatically rebroadcast. Each normal proof transaction used the explicit 40,000,000-sompi reference fee. The normal 100,000,000-sompi exact payment reconciled to 100,000,000 merchant gain and 140,000,000 payer cost.

Raw report SHA-256:

- Exact/batch: `add6bdcfe2a5fd437122c7623c6f3fcd4806e077d5b3c5bb7b195699c5ce92da`.
- Hash-chain: `ccea904e790ee24b82a944809426ff423c8ffe29ca3e1d942d919ba75a100df0`.

## Reproduce

From `protocol/`, build and run the [exact/batch proof](live-testnet-proof.md) with a new private data/recovery directory, `KASPA_X402_TIMEOUT_DAA=6000` and `KASPA_X402_PROOF_FEE_SOMPI=40000000`. Run the [hash-chain proof](hash-chain-live-proof.md) with a separate funded wallet and output directory, `KASPA_X402_PROOF_FEE_SOMPI=60000000` and `KASPA_X402_HASH_CHAIN_PAYER_FEE_SOMPI=10000000`. Both require `KASPA_X402_KASPA_WASM_MODULE`; neither uses a private modified adapter copy.

The live fee settings are explicit congestion settings for these proofs, not new SDK defaults. Live commands consume Testnet funds; offline `verify` never invokes them.

## Runtime fingerprints

These SHA-256 fingerprints identify the actual artifacts loaded by the funded runners. The SDK files were supplied externally, not built by `npm ci`.

| Artifact | SHA-256 |
| --- | --- |
| `packages/adapters/dist/chunk-WIFJIV5J.js` | `3e21cad96f3773c90e185b32778952f062ddb4bd0a0b36197605ee9f6eed1170` |
| `packages/adapters/dist/index.js` | `893a366c2f3ad0f8daad918899e2415f0d9461cb44719e8057059d64a7ba4863` |
| `packages/adapters/dist/kaspa-native.js` | `7932fa30a9059fe6520398a7563dff9cbc462bf3e251302c11de9ad8020cdb38` |
| `packages/cli/dist/index.js` | `0a891ce370e93ffeaf91cc8cdb562c23aa18bfa2e73a2f13d18432483d85c876` |
| `packages/client/dist/index.js` | `56315729f61e7cbbd5460d3a728651191882e7833db0f59c00779edc967f6ba5` |
| `packages/core/dist/index.js` | `fa1eadeb77b5b217cca0f3e80edb8907ec516852ea10322a5f37d96c34d412a5` |
| `packages/covenant/dist/index.js` | `cbfc836064477d5ee6f5a64fb5e597942a9d9e93af997064d3e643804efc844f` |
| `packages/facilitator/dist/index.js` | `7925b528e5926d30c64504b699995d8f5a3c1698d772be4fc839ec7c5796187d` |
| `packages/server/dist/chunk-TSGTJDMN.js` | `aa15f150a3778f5af2221bbc98115a6bb9b48dfde5486fd1617925578155e1c6` |
| `packages/server/dist/hash-chain-grants.js` | `5cb53742d53eb838dee19fc82828122514ef2163e5525a713dbd6c2ace91ed1f` |
| `packages/server/dist/hash-chain-issuer.js` | `99baf57bfb7535a8f3a596854bbf986945f7df63c4c002ad8c74ad07d4549c5a` |
| `packages/server/dist/index.js` | `05634c853f0efc03cfd78afd3d1f12248712806ae3bcb2856ad37a289bc176a5` |
| `scripts/live-adapter-reference.mjs` | `4e9ccec9d300420c2306d93948d97e2e7c9e6f6421ad30b08972c5e49d6332a8` |
| `scripts/proof-hash-chain-testnet.mjs` | `ef370a0e16f37a9d2cbe153a98dcc595e248cca81860794e0130e7842435d506` |
| `scripts/live-proof-fees.mjs` | `2e46b8e3cfe3a0c6fa62b5045c8d67302077879b28d2efa3abc46d9b7ccfc069` |
| `scripts/proof-live-testnet.mjs` | `bf0bbfcc4e2395a62e0239c94acc23bf2832eda59ff41533a097a7977c2034f5` |
| External SDK `kaspa.js` | `5bc3610b7b3e56dec4aff70c71302edf4fc1d21ebfd8b231c53a31fe165c157a` |
| External SDK `kaspa_bg.wasm` | `46df926c983540dcc7e65dd7da046abd5f8302d35467dd13ffb89c7b8d7d4239` |
| External SDK `package.json` | `4258a88d79827c53853d351295d8a83bbb41e781b7c55ba9802dc0cfa82f1499` |
