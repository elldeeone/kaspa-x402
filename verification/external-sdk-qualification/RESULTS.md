# External qualification results — 2026-10-16

All four profiles passed. No SDK runtime defect was reproduced. The qualification campaign added
harnesses and this record; it changed no SDK runtime, backend or demo code.
This historical record covers the pre-release-version campaign. Final 1.0.0
archive qualification is recorded separately in the release PR.

## Candidate and installation

- Source: `f83eaad417c23b9e9061fc1a1a369e56bf0e471b`.
- [Source CI passed](https://github.com/elldeeone/kaspa-x402/actions/runs/38819197849).
- Approved bundle manifest SHA-256:
  `103c13e47a17b76015ad1eb91ac0347abf2556632f39c0868e5e57e1bca4f6e5`.
- Four public archives installed outside the repository, without workspace links.
  Their hashes match across the initial campaign, fresh replay and funded run.
- Private adapters/facilitator archives supplied explicit test support. They are
  not additional public packages or a newly implemented backend.

## Controlled HTTP, signature, stress and failure tests

**55/55 scenario groups passed**, including all four documented mock examples.

| Profile | Evidence |
| --- | --- |
| Standard-native exact | 827 HTTP requests; 100 freshly signed transactions under concurrency, genuine funding/request signature verification, duplicate retries and HTTP MCP calls |
| Additive exact | 785 HTTP requests; eight shards, same-head races, signatures, duplicate/stale retries, uncertain settlement, recovery and controlled reorgs |
| Hash-chain additive | 128 signed sequential stress payments using distinct keys; 16 duplicate retries; 240 seeded rejected cases; SQLite reopen and independent-process readback |
| Batch settlement | 701 HTTP requests; 650-request seeded stress, independent charge accounting, real signatures/builders, partial claims, top-up, expiry and recovery |

The fresh external consumer passed the eight baseline runner commands. The added
standard crypto-stress command then passed separately in that same consumer.
The retained runner includes all nine commands for subsequent reproduction.

## Funded Testnet-10

- **18/18 exact/batch flows** and **5/5 hash-chain stages** passed.
- Two hash-chain paid HTTP responses returned 200; abandoned-grant owner rotation
  was accepted. Batch partial claims, top-up and timed terminal refund passed.
- **19 accepted distinct transactions**, including two setup transactions, plus
  one intentional node-rejected stale batch claim. This accounts for 20 unique
  submitted transactions; it is not an RPC call-count trace.
- Aggregate fees: **660,315,400 sompi = 6.603154 Testnet KAS**, within the
  8-KAS fee and 25-transaction caps. No mainnet funds were used.
- The retained rotated head was independently queried after the proof:
  `0733e239721ca8cac72681c9811445f23b059e68f8c3f542192617f80fc119df:0`,
  holding `140000000` sompi. Wallets and private configuration remain outside Git.

## Evidence and reproduction

External evidence root:
`/home/luke/projects/kaspa-x402-qualification/run-20261016T011011Z`.
Fresh consumer:
`/home/luke/projects/kaspa-x402-qualification/replay-20261016T011011Z`.

The aggregate `campaign-report.json` binds each controlled report, public package
hashes, funded report and post-proof head observation. SHA-256:
`9e6d185c34bbcc9a9e738ef8f375c27ea4090dc2102da38ab1ededd1918adc44`.

Funded `funded/proof-report.json` SHA-256:
`01bd482d1cca495e3eb292096036eb241f64623424f2014751e877fef9511bf2`.
Its retained verifier passed with `node funded/verify-report.mjs --check` from the
external evidence root. Initial setup failures and read-only accounting
corrections remain preserved in the evidence directory.

See [README.md](README.md) for fresh-consumer reproduction. Profile inventories,
scripts and reports distinguish real signatures from controlled acceptance facts.

## Limits and release implication

No implementation blocker emerged from this campaign. It does not require new
backend or demo work. Controlled stress uses supplied chain observations; funded
evidence uses one Testnet RPC, so it does not establish independent-source
corroboration, mainnet acceptance, or production throughput/availability.
Memory-store recreation is not operating-system crash durability evidence.

These current-source archives still carry `1.0.0-rc.2` version metadata. They are
not a published final 1.0.0 candidate. Final release archives must be bound to
their own hashes and candidate verification before publication; these results
must not be relabeled as evidence for changed archives.
