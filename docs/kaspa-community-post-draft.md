# Kaspa Community Post Draft

Status: draft only. Do not post externally without explicit operator
approval. Venue: Discourse-powered Kaspa community forum.

Posting instructions:

- The title goes in Discourse's title field as plain text (no markdown).
- The body is everything between the BEGIN/END markers, pasted verbatim into
  the composer. Its lines are intentionally long and unwrapped: Discourse
  renders every newline as a hard line break, so wrapped source would paste
  as choppy short lines. Do not re-wrap it.
- The objection deadline is filled in as 24 July 2026 (three weeks from the
  2026-07-03 draft date) in all three places (TL;DR, Step 1, ask item 1).
  If posting later than early July, push the date out accordingly.
- Link-limit trap: new Discourse accounts (trust level 0) are usually capped
  at 2 links per post, and this post has many. If your forum account is new,
  either browse until promoted to trust level 1, or ask a moderator to bump
  the account before posting. Do not strip the links to fit the cap.
- Package names like `@kaspa-x402/core` must stay inside backticks, because
  Discourse otherwise parses `@word` as a user mention.
- Pick the forum's protocol/standards category if one exists. After posting,
  link the thread from the CASA PR as community-review evidence.
- Expect the storage-mass floor and the missing upper-bound timelock to be
  the two most-discussed technical points; both have published write-ups to
  link in replies instead of re-arguing in-thread.

## Title (plain text, for the title field)

Kaspa x402: pay-per-request KAS payments for APIs and AI agents, live on testnet-10. Feedback wanted before standards submissions

## Post body

BEGIN POST BODY (paste everything between these markers)

## TL;DR

[x402](https://www.x402.org) is an open standard that lets websites, APIs, and AI agents charge and pay for individual HTTP requests. I have built a complete alpha implementation of native Kaspa support for it: specs, JSON schemas, test vectors, TypeScript packages, and a live testnet gateway that has settled real `kaspa:testnet-10` payments. Everything is public at https://kaspa-x402.org.

Before I take this to the two standards bodies involved (CASA, which registers cross-chain network identifiers, and then the x402 Foundation), I want the community's eyes on it. One decision in particular, the network-identifier convention, is hard to change later. Objections and feedback are welcome until **24 July 2026**; after that I will proceed as described below.

## What x402 is and why Kaspa fits

When a server wants payment for a request, it replies with HTTP status `402 Payment Required` plus a machine-readable price offer. The client pays, retries the request with proof of payment attached, and the server verifies the payment and serves the response. That is the whole protocol. It was started by Coinbase, is now governed by a Linux Foundation project (the x402 Foundation, founded by Coinbase and Cloudflare), and is becoming the default way AI agents pay for APIs and tools.

Kaspa is unusually well-shaped for this. Paying per request only works when payment confirmation is not the slow path, and Kaspa's block cadence makes one-shot native payments practical at request time: my live gateway verifies accepted payments roughly a second after broadcast. Every blockchain currently in x402 (Solana, TON, Algorand, Stellar, Aptos, Hedera, and the EVM chains) is account-based. Kaspa would be the first UTXO chain, and this implementation is UTXO-native throughout: a payment is identified by its transaction id and outputs, not by account allowances.

## What exists today (all public, all testnet-only)

- **Standards site**: https://kaspa-x402.org has the specs, JSON schemas, test vectors, and immutable release snapshots.
- **Reference implementation**: https://github.com/elldeeone/kaspa-x402 with `@kaspa-x402/core`, `client`, `server`, and `covenant` packages on npm, plus a CLI and runnable examples.
- **Live gateway**: https://demo.kaspa-x402.org is a public testnet-10 server for batch-settlement integration. Hosted exact must stay unavailable unless the Worker is deployed with KIP-10 reservations and a funded exact canary passes. The Worker runs an automated public health check and holds no spending keys.
- **Recorded live evidence**: funded end-to-end payment runs on testnet-10, covering KIP-10 exact-transaction source evidence, safe handling of replayed and reused transactions, and escrow deposit/voucher settlement. Hosted gateway transaction ids are in the gateway docs; the full alpha.6 live harness evidence is tracked separately.
- **Browser test client**: https://kaspa-x402.org/demo/ for connectivity checks and payment-header rehearsal (keys stay in browser memory).
- Threat model, mainnet-readiness gates, versioning policy, and implementer guide, all published on the site.

To be explicit about limits: this is alpha, `kaspa:testnet-10` only. The wire format is not frozen, and mainnet use is blocked by published gates (independent audit among them). Nothing here claims production readiness.

## The two payment schemes I ship, and the two I deliberately do not

x402 defines four payment schemes. This implementation ships two:

- **`exact`**: a fixed-price one-shot native KAS transfer. Alpha.6 uses the KIP-10 path: the server advertises buildable reservation terms and the client returns a signed `exact-transaction` artifact for server/facilitator verification, broadcast if needed, and observation. One caveat for implementers: KIP-9's storage-mass rules put a floor on standard output size (roughly 0.1 KAS), so `exact` prices cannot go below that.
- **`batch-settlement`**: the micropayment path, for prices below that floor. A client locks funds in an escrow once, then signs a small voucher for each paid request; the chain is only touched again at claim or refund time. The demo gateway charges 500 sompi per request this way. The escrow covenant is written in SilverScript and validated against Rusty Kaspa consensus.

The other two schemes (`upto` and `auth-capture`) are missing for a technical reason, not oversight. Both need a payment authorisation that expires at a deadline, enforced on-chain. Kaspa's on-chain script (the layer SilverScript compiles down to) only supports lower-bound time locks, because a once-valid transaction must never become invalid. So an expiry can only be approximated by a refund race, and shipping that under upstream's stricter definition would overstate the guarantee. I built and consensus-validated a capped-authorisation covenant anyway (archived on the [`archive/capped-authorization-experiment`](https://github.com/elldeeone/kaspa-x402/tree/archive/capped-authorization-experiment) branch) and shelved it until upstream clarifies whether a refund-race expiry qualifies. The full write-up is the native-profile-boundary doc on the site.

## What happens next, and where you can object

**Step 1: register the `kaspa` network identifier (CASA).** Cross-chain standards, x402 included, need one agreed way to write "which network is this?". The convention is CAIP-2 identifiers: Ethereum mainnet is `eip155:1`, Stellar is `stellar:pubnet`. Kaspa has never registered one. I intend to open a PR at `ChainAgnostic/namespaces` registering:

- `kaspa:mainnet`
- `kaspa:testnet-10` (and future numbered testnets)

These are the names rusty-kaspa, explorers, and wallets already use. Some chains register a genesis-block hash instead; I chose names because that is how Kaspa already talks, and hash aliases can be added later if needed. The registration also sets how account addresses are written: the address without its `kaspa:`/`kaspatest:` prefix, since the identifier already names the network.

**This is an objection check.** The identifier convention is the one decision that is hard to change later, so before I lodge the registration: if `kaspa:mainnet`-style identifiers would break or fight anything you know of (wallet integrations, WalletConnect, tooling that expects something else), say so in this thread before **24 July 2026**. If nothing blocking comes up, I will open the PR.

**Step 2: propose the Kaspa bindings to the x402 Foundation.** Once the identifier registration is in review, I will open a feature request at `x402-foundation/x402` proposing Kaspa support for the `exact` and `batch-settlement` schemes, following the same path Stellar, Aptos, and Hedera took. The wire format has already been checked line by line against the current upstream v2 spec.

**Step 3: external implementers.** After that, I am looking for a few people to test their own clients against the live gateway and report what breaks. There is an implementer guide, a public faucet for testnet funds, and issue templates in the repo.

## What I am asking of this community

1. **Objections to the `kaspa:` identifier convention** (the time-sensitive one, open until **24 July 2026**).
2. Technical review of the specs, especially from anyone who has built on rusty-kaspa consensus or the WASM SDK.
3. Anyone interested in being an early external implementer.
4. Corrections: if anything published overstates what Kaspa or this implementation can do, I want to know first.

Links: site https://kaspa-x402.org · gateway https://demo.kaspa-x402.org · repo https://github.com/elldeeone/kaspa-x402

END POST BODY

---

## Reply draft: response to carlssonk (2026-07-04, historical alpha.4 draft)

Status: superseded by the alpha.6 exact-transaction work. Do not post this
without updating it against current release docs. Unwrapped lines, backticked
package names.

BEGIN REPLY BODY

Thanks, great review. All three findings verified. Fixes shipped yesterday as `v0.1.0-alpha.4` (npm, spec, redeployed gateway).

**Prefix mapping**: yes, that is the intention. `mainnet` maps to `kaspa:`, `testnet-<n>` to `kaspatest:`. The registration PR will state it explicitly.

**Endianness**: confirmed, spec now reads `uint16_be`. One wrinkle: consensus hash preimages encode the version little-endian (`hashing/tx.rs`, `sighash.rs`), so the transaction builder keeps LE in that layer only.

**Voucher signing**: confirmed, and it ran deeper: the covenant verifies the raw sha256 digest on-chain, but my gateway was verifying personal-message signatures. My bug, fixed in alpha.4: raw digest is now the documented rule, the gateway matches the covenant, old channels were reset, and fresh funded evidence is in the gateway docs. I could not take your plain-text suggestion because the covenant cannot rebuild a text message in script without losing the outpoint binding. Which means the gap you found is real and stays open: a wallet with only the WASM SDK cannot sign vouchers today, and implementations need a Schnorr library instead (the reference adapters use one). I am not thrilled with that answer. If you think a raw-hash signing API belongs in the SDK, that request would carry more weight coming from the SDK side than from me.

**Transaction evidence**: this changed again after further KIP-10 review. Dropping transaction artifacts entirely was too broad. Alpha.6 makes exact reservation-backed: when the server advertises KIP-10 reservation terms, the client returns a signed SDK-safe JSON transaction artifact for server or facilitator broadcast/observation. The public hosted gateway still needs a reservation-enabled deploy and funded canary before I describe exact as hosted evidence.

You are exactly the early implementer I am looking for, if you are keen: implementer guide on the site, with hosted batch evidence and alpha.6 exact source/live-harness evidence split in the docs.

END REPLY BODY
