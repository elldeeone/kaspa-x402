# Testnet-10 scenario matrix — 7 September 2026

Status: expanded checks passed. The matrix now includes funded MCP, both live claim/refund race outcomes, signed consensus mutations, network faults, storage saturation and abrupt process termination.

Tested baseline: `0baf52bea7c2ac86bfec67b8007eaa2cbbfa08bf`, plus the validation fix and harness/test changes described below. All channels and gateway state used for the final proofs were fresh Alpha.11 state.

## Runtime and evidence

- Network: `kaspa:testnet-10`; synced node `2.0.1` with UTXO index.
- SDK: official NodeJS SDK `v2.0.0`; archive SHA-256 `eeb201e27feba98fe069f09ffefdd0032ed4f69a3f299793e64b9db9dda7df7f`.
- Covenant: current `kaspa-x402-escrow-v3`; no compiler or covenant-byte changes.
- Main funded proof: ignored private directory `.kaspa-x402-live/alpha11-20260907-matrix7/`.
- Fresh local Worker proof: private operator state directory `gateway-live-20260907-NSO24z`, containing `report.json` and `restart-report.json`.
- Earlier interrupted runs and signing/recovery files remain private. No keys are included in this report.

## Funded reference-harness results

Final run started `2026-09-07T21:22:28.408Z` at DAA `564573511`. The live proof runner validated every required flow and reported zero findings:

1. Tiny and normal standard-native exact settlement — passed.
2. KIP-10 additive-head exact-delta settlement and replay rejection — passed.
3. Multiple additive head shards — passed.
4. Concurrent additive conflict and loser refresh — passed.
5. Duplicate exact settlement idempotency — passed.
6. Invalid exact signature rejected before protected work — passed.
7. Expired exact authorization rejected before protected work — passed.
8. Post-broadcast exact restart and trusted settlement reconciliation — passed.
9. External additive head advancement and trusted reconciliation — passed.
10. Verified singleton KIP-20 batch genesis and deposit-voucher settlement — passed.
11. Batch voucher-only settlement — passed.
12. Partial batch claim preserving voucher ceiling and lineage — passed.
13. Second accepted partial batch claim using the same voucher — passed.
14. Bounded batch channel, artifact, and pre-broadcast attempt restart reload — passed.
15. Batch client-authorized top-up preserving KIP-20 lineage and lifetime voucher state — passed.
16. Batch stale-head rejection after a same-voucher partial claim — passed.
17. Replay rejection across exact and batch-settlement — passed.
18. Terminal batch refund after timeout — passed.

The two extra probes used the live funded batch channel. Invalid voucher signatures returned HTTP 402 `invalid_payload`; a correctly signed voucher exceeding total funding by one sompi returned HTTP 402 `invalid_payment_requirements`. Both also failed direct internal verification, ran zero handlers, broadcast nothing and left channel state unchanged.

The concurrent additive winner returned HTTP 200 and the loser HTTP 402. After trusted conflicting-spend reconciliation, the loser retried successfully. There were exactly two handler executions for the two eventually paid requests. Injected post-broadcast exact failure recovered with exactly one handler execution.

| Batch operation | Amount/result | Accepted transaction |
| --- | --- | --- |
| Genesis | 4 TN KAS deposited | `01cc71d57fccb448da4c241959cdf094b55b833d2dfaedf9e6a7cd6aa7bf9c62` |
| First partial claim | 1 TN KAS gross | `3b3d4acc8d2b9b00a5d065f2173ed0cc53a1c2f8861601c17e9a3ced9affc3ee` |
| Second claim, same voucher | 0.5 TN KAS gross | `16cc05df5207d62227d6478db9b59c537f538e4c49ae9cd0f374e6aae85b4f6d` |
| Top-up | 4.02 TN KAS added; 6.52 TN KAS head | `e5ad68db3716a45de6d1f308887fa6b2e23971d5130d58a04db818a09805016e` |
| Timed terminal refund | 6.50 TN KAS returned; 0.02 TN KAS fee | `788e6b4c47f5b732ce756975d0b9bc82635bce697b93aa33d6d3c7869f89a621` |

All batch transitions retained covenant ID `58597d8c306609b815d515954861f957e0e56f0fd7d4aebf9ae5a80b500c1c60`. The final client state is `refunded`, server state `retired`, with no successor covenant output. Refund lock time was DAA `564575312` and observed DAA was `564575359`.

Exact payment transactions:

- Tiny standard-native (0.1 TN KAS): `9522b11138b51a492eb8a0ca63c917a19b7b79cd0faf94439674fedec69fe89c`.
- Normal standard-native (1 TN KAS): `e2354d9d195aa53c40273a5b8f50798e33e47ceb94ee3566c5ba5141136d2d52`.
- Additive exact (1 TN KAS): `2c495d34529a704a4f50d69d1545eb44667e450f960217151cd9b1639046e1fb`.

## Fresh Worker with a real TN10 payment

The existing `scripts/proof-hosted-exact.mjs` ran against a new loopback Worker backed by persistent SQLite and the live TN10 adapters.

| Check | Result |
| --- | --- |
| Standard-native exact payment, 2 TN KAS | HTTP 200; accepted output independently observed through live RPC |
| Identical paid request repeated | HTTP 200; same settlement transaction |
| Cross-resource replay | HTTP 409, `invalid_transaction_state` |
| Full Wrangler/workerd shutdown and restart, then identical paid request | HTTP 200; same settlement transaction |

Payment transaction: `32b1010200a0f01774988d11cc38faa10f69ecf58361ea5ef2bc16e8dacb0dc7`.

Old funding origins visible through RPC returned REST 404 and were correctly refused by the Worker. Fresh accepted funding resolved this without relaxing verification. The Worker was stopped and its loopback port confirmed closed after testing.

## Fresh Worker admission and operator recovery

`node scripts/check-gateway-durable-recovery.mjs` passed against a fresh Worker build, using real local workerd and SQLite with synthetic settlement records:

- 65 concurrent claims: 64 admitted, one rejected at capacity.
- Two full runtime restarts; all 64 admitted records remained idempotent and overflow remained blocked.
- Missing/wrong operator authority or missing final-rejection confirmation could not release capacity.
- Confirmed operator rejection released one slot.
- A started handler survived restart and could not be started again. Operator completion applied its confirmed result and released one slot.
- 61 concurrent rate-limited requests: 60 HTTP 200, one HTTP 429.
- Zero outbound requests during this synthetic matrix.

## MCP and client guards

Local tests verify returned MCP tool errors charge zero for batch payments, including an explicit attempted charge override, and retries return the same result without rerunning the handler. A thrown MCP handler remains pending with no receipt or charge; repeated retries require recovery and do not execute the handler again. Exact tool errors retain exact-payment charging semantics.

Client tests verify refund-horizon and funding-policy checks before spending, exact approved genesis amounts, tampered authorisations, and that unknown settlement status cannot release an exact attempt. Refreshed additive terms become usable only after trusted evidence that the old artifact cannot be accepted.

The original MCP/client checks use local mock funding and chain providers. The expanded run below also exercises MCP against a real TN10-funded channel.

## Fixes found while executing

One package behaviour defect was fixed: optional payment identifiers carried the required standard schema, but validation rejected that schema when the server had not advertised the extension. Validation now accepts only the already trusted standard schema in that case; arbitrary unadvertised schemas still fail. Core and client regression tests cover both outcomes.

The old funded harness also needed updates to exercise the hardened contract:

- Distinct conflict contenders now have distinct request hashes.
- The losing additive attempt is reconciled only after the accepted winner is shown to spend the same head and a live UTXO read confirms that head is gone.
- Singleton genesis first prepares an input of exactly the approved deposit plus fee, instead of locking the whole selected wallet UTXO.
- Batch negative probes check both internal verification codes and their mapped x402 HTTP errors.
- The exact-broadcast error path now receives its redaction context explicitly.

## Local verification

- Full `npm test`: 659 package tests and 25 tooling tests passed (136 additional package tests in the expanded pass). After the live REST zero-budget fix, all 139 gateway tests and its typecheck passed again.
- Core, covenant, client and Worker builds passed.
- `npm run validate:schemas`: passed.
- `npm run proof:offline`: 23 checks passed.
- Fresh Worker durable-recovery script and diff checks passed.

## Expanded adversarial pass

All 18 funded flows and the two funded-channel negative probes passed again in `.kaspa-x402-live/alpha11-20260907-extended/report.json`, with zero runner findings. Fresh channels were used.

| Additional checks | Result and evidence boundary |
| --- | --- |
| 1,094 deterministic protocol cases, seed `0x4022026` | Amount extrema, malformed/oversized/deep JSON, canonicalisation, real Schnorr binding mutations, expiry and changed terms passed; local core APIs |
| 42 signed consensus scenarios | 37 rejected mutations, five accepted controls; legitimate keys re-sign mutations to avoid masking failures behind bad signatures |
| 74 server state/fault cases | 51 exact and 23 batch cases; write failures, seeded races, zero/full charges, merchant term changes and stale snapshots |
| 50 gateway network fault cases | 44 real localhost HTTP tests, six injected PNN tests; stalled/truncated/oversized/malformed replies, acceptance evidence, outages and failover |
| Five-minute storage/load run | 24,576 checks at concurrency 16, SQLite actually reached 537,665,536 bytes, four restarts, recovery above ceiling, zero outbound calls |
| Abrupt process death | `--crash` SIGKILLed only the verified workerd child, reopened the same SQLite, preserved committed claims/capacity/started-handler state, blocked repeat execution and completed operator recovery |

The storage run observed p50 88.4 ms, p95 108.2 ms and max 184.1 ms latency; peak driver-plus-workerd RSS was 802,480,128 bytes. This is a local synthetic admission/recovery workload, not paid throughput. Stress and process-kill checks are separate runs. SIGKILL does not simulate physical power loss or failed hardware.

The consensus oracle is pinned to Rusty Kaspa `c338d495bec29e4dc8b5149f99e8db6fa916ed4a` (2.0.1). It executes isolation and populated-UTXO validation with full scripts. It excludes header-context finality, mempool policy and DAG/reorg behaviour. Refund boundary cases vary transaction lock time; they do not prove containing-block DAA boundaries.

Four additional package defects were fixed:

- MCP payment payload/response readers now apply the existing representation budget before schema validation. Twelve regressions cover the boundary.
- Exact commit stores canonicalise transaction IDs before comparison, preventing valid uppercase IDs from producing recovery errors.
- REST evidence now requires boolean acceptance and validates transaction IDs, DAA/UTXO values, output scripts and unique output indexes. Previously `is_accepted: "false"` was truthy and could be treated as accepted.
- Live REST encodes a zero input compute budget as explicit `null`. Accepted additive transactions previously failed recovery on that representation. The narrow fix normalises explicit null to zero; missing v1 budgets and null in place of nonzero budgets still fail.

## Funded MCP and live competing spends

The MCP channel deposited 4 TN KAS in `cdb98ed9be5efd4486eacfab06e3a581429787b14709c793b8b69895546a7e49`:

- Returned tool error: one handler execution, zero charge, identical cached retry.
- Thrown tool error: one handler execution, two pending retries, zero charge; explicit operator recovery confirmed zero, then the cached retry succeeded.
- Successful tool result: one handler execution, 1 TN KAS accounting charge, identical cached retry.

No merchant claim was broadcast for this MCP channel. The test proves funded-channel verification and accounting, not collection of the accounting charge. Its 3.98 TN KAS refund was accepted in `ef048a2e34b1fb107c3f532ab21ec030832141b13110c231d5c4a9fe875b82f8`; client became refunded and server retired.

Two separate 0.5 TN KAS channels exercised concurrent claim/refund submissions after timeout:

| Outcome | Accepted terminal refund | Result |
| --- | --- | --- |
| Claim won | `1e46f1882ad68d56d61997308a1e3c9ff5010d02a023341f4736d7f9710dcbe9` | Competing refund definitively rejected; claim successor refunded; 0.08 merchant + 0.38 refund + 0.04 covenant fees |
| Refund won | `aa2420ad8ab11a69aa1c75c6ed065657b1283f94bf361947f47f52bb81920e67` | Competing claim definitively rejected; 0.48 refund + 0.02 covenant fee |

Both conserved escrow and left no live channel head. Total wallet fees across both proofs, including funding preparation, were 0.106308 TN KAS. Evidence is in the private `claim-refund-race-20260907` and `claim-refund-race-20260907-refund-first` directories. These are node consensus races, not durable client race reconciliation tests.

## Hosted canary

An isolated temporary Cloudflare Worker used fresh Durable Object state and dedicated rate-limit namespaces. The normal demo was not changed. Tiny (0.1 TN KAS) and normal (0.2 TN KAS) standard-native exact payments returned 200, identical retries returned the same settlement, and cross-resource retries returned 409.

Tiny transaction: `93945ce8435cf6f4157df187deb42795a88e9e0413fb82e327c407421f7bae90`.
Normal transaction: `8724372c284d97f6ed50ebbf1ea11b4f954ef5da7ad3dde119b3f7578f8ea687`.

Real traffic from Sydney and Frankfurt exercised the deployed native bindings. A 200-request Sydney burst returned 145 HTTP 200 and 55 HTTP 429. Frankfurt admitted all 200 requests in each of a burst and a five-second paced run. Thirty sequential unauthorised Sydney admin requests returned 21 HTTP 401 and nine HTTP 429. These observations do not establish a strict 60-request or global cap. Cloudflare documents these counters as local and eventually consistent; payment correctness must not depend on exact rate counts. See [Cloudflare rate limiting bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

A test-only version suffix was rejected by configuration validation. An additive attempt also refused to offer a head while the configured payout address still identified the standard-native recipient. The canary configuration was corrected to the registered additive head address; no validation was relaxed. Earlier funded head outputs remain recoverable by the retained funding key.

The hosted proof builder also retained compute budget 10 for the borrower head, while the gateway canonical profile requires 0. Both proof builders now use head budget 0. The original extended reference run above used a consensus-valid head budget 10; the hosted payment tests the stricter profile.

Transaction `3bd900accd8dca832013a3ea17813e4b5f8f24a86d30886cbf63703798e3277c` was accepted on TN10 before the REST zero-budget fix and remained pending locally. After deployment of the fix, authenticated reconciliation marked the same attempt accepted; the original paid request returned HTTP 200 despite elapsed authorisation, with the same transaction. Identical replay returned 200, cross-resource replay 409. Another full hosted redeployment preserved those results. No replacement transaction was created for recovery.

A second, fresh additive payment then completed without operator recovery: `3bf8b7d258143a88a40e9817a0d89d016743da42f710fff03b0ef88afebb2d39`, 0.2 TN KAS, HTTP 200. Identical replay returned 200 and cross-resource replay 409. The hosted harness reused the already registered head through a temporary local adapter; it did not refund/recreate the head or bypass gateway verification. Private reports are in `hosted-canary-20260907-f9e002` (`tiny`, `normal`, `additive-final`, `additive-clean`). Protocol/consensus/test/stress output is retained in the ignored `.kaspa-x402-live/expanded-evidence-20260907/` directory.

The temporary Worker was deleted after the proofs. Cloudflare API returned worker-not-found (10007), and the public endpoint returned HTTP 404. Its keys, signed attempts and reports remain private for TN10 fund recovery; no normal-demo configuration was changed.

## Reproduce and remaining limits

Run the ordinary suite with `npm test`. After building, run `node scripts/check-adversarial-inputs.mjs`, `node scripts/check-gateway-durable-recovery.mjs --stress`, and `node scripts/check-gateway-durable-recovery.mjs --crash`. Signed consensus cases run through `npm run validate:tx-v1-consensus` with the pinned consensus checkout. Live scripts require private TN10 wallet/SDK/RPC configuration; `scripts/proof-claim-refund-race.mjs` requires explicit `--live`, with `--refund-first` selecting reverse submission order.

This is a finite matrix, not proof that all possible scenarios are exhausted or that mainnet is ready. Remaining evidence gaps are production client persistence/integration under real crashes, independent security review, controlled network partition/reorg and header-finality testing, and longer operational soak under the intended deployment workload. Legacy channel migration is deliberately outside the fresh Alpha.11 cutover. Mainnet remains untouched.
