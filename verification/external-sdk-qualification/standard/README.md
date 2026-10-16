# Standard-native external SDK qualification

10 scenario groups passed: 597 real loopback HTTP requests, 85 HTTP protected-handler executions, and one MCP protected-handler execution. No real broadcasts or funding were performed; two settlement tests invoke controlled throw-only send adapters once each.

Reproduce from the campaign root:

```sh
node standard/proof.mjs
node standard/crypto-mcp.mjs
```

Artifacts: `report.json` and `crypto-mcp-report.json` include scenario results, independent counters, input/source hashes, and the archive manifest. `FAILURE-MODES.md` records the pre-implementation failure inventory. All runtime imports resolve through installed package archives; fixture inputs come from the campaign copy. No repository runtime `src`/`dist` import or symlink is used.

## What passed

- Fixed-seed workload: 80 independent payments, each challenged once and sent six times concurrently (560 HTTP requests, concurrency six). Each payment runs exactly one protected callback and returns one identical cached result to all retries. There are no simulated sends in this workload because the verifier fixture already reports acceptance.
- URL, method, body and host-derived tenant mismatch rejection; expired authorization, invalid digest, wrong network/profile/output rejection; malformed/oversized payment headers and oversized parsed JSON body rejection before callback.
- A real socket is destroyed after SDK completion; retry returns the original paid result with exactly one callback execution.
- Controlled unknown/rejected settlement: repeated requests fail closed (503), with one throw-only send invocation and no callback execution.
- Native signed standard transaction vector passes actual Schnorr funding-signature and payer request-signature validation through the private adapters support archive. Corrupt request/funding signatures and contradictory origin facts fail before callback. This is real cryptographic validation over controlled chain observations.
- Pending verifier hits a 60ms adapter deadline, a parallel request is rejected by configured concurrency admission, and retry can complete with the same signed artifact. Real HTTP caller cancellation propagates into verifier cancellation and leaves the callback unexecuted until retry.
- Public MCP SDK surface validates real signed authorization, rejects changed tool arguments/audience, and retains one callback result on replay.

## Evidence boundaries

The four public packages are core/covenant/client/server. `@kaspa-x402/adapters` is an explicitly installed **private source-support dependency**, not a public release dependency. The mock fixture uses fake signatures and a trusted verifier response; its 584-request transport/state run is **not** cryptographic or chain validation. The supplement performs actual signature verification, but accepted chain state and transaction origins remain controlled fixture observations. The signed vector's historical consensus metadata is input provenance, not a newly executed consensus cross-check.

The host assigns a fixed trusted admission identity for stress. Anonymous requests have an intentional aggregate cap; these results do not measure anonymous-service capacity. SDK body tests exercise parsed JSON resource budgets; inbound byte-stream limits remain the embedding host's responsibility. MCP uses direct public SDK calls rather than a networked MCP transport. Storage is process-local memory. No live acceptance, source independence, restart durability, paid network operation, production throughput, or mainnet readiness is established.

No SDK defect was demonstrated by these cases.
