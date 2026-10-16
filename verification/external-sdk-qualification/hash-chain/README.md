# External hash-chain qualification

Run: `node hash-chain/qualify.mjs` from the campaign root. Dependencies are the archive-installed public SDK packages in the parent directory; no repo source/dist runtime import.

Result: 7/7 scenarios and 240/240 seeded rejection cases passed. Eight sequential signed payments advanced the head from 100000000 to 260000000 sompi with eight distinct one-time keys. Nine protected handler invocations total, including a separate reorg scenario; exact-payment retries did not repeat protected work. Zero broadcasts.

The scenarios cover concurrent distinct payers (one winner), durable identical retry, an independent child-process SQLite reopen, bad claim signatures, authoritative-observer outage, expired disclosed grant abandonment, controlled owner rotation, persistent key non-reuse, exhaustion, unknown/reorged transactions, mainnet opt-in/network identity boundaries, and bounded transaction/claim mutations.

Real evidence: public signer produces Schnorr signatures checked by the real public verifier; private loopback grant HTTP runs the exported handler with no-store responses; the issuer uses its real SQLite backend, including independent process readback.

Controlled evidence: origin/UTXO and selected-chain observations are supplied by explicit harness callbacks. Owner rotation is a trusted transition supplied through the public issuer API. These do not demonstrate consensus acceptance, real network independence, funded spending, production storage/backends, or power-loss durability. No live network calls/funds/broadcasts occur.

The initial harness debugging artifact records integration errors (identifier shorter than schema minimum and missing shared-store lock). These were corrected in the external harness; no SDK defect was established or SDK code changed. An exploratory constructor expectation was corrected: testnet identity may be omitted by the API, while opt-in mainnet requires an explicitly matching chain identity.

`report.json`, `run.log`, `qualify.mjs`, `inventory.md`, and `SHA256SUMS` are retained with encrypted SQLite state directories. Each run creates fresh state and overwrites the current report/log only when redirected by the command. The fixed seed selects bounded stress mutations; cryptographic chain generation remains fresh per run.
