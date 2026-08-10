# x402 Upstream Submission Draft

Status: draft only. Do not post, open, or send externally without explicit
operator approval. Target venue: a single feature-request issue on
`x402-foundation/x402`, following the precedent of the Stellar submission
(coinbase/x402 issue 633).

---

## Proposed issue title

Feature request: Kaspa ecosystem bindings for `exact` and `batch-settlement`
(first UTXO network)

## Proposed issue body

### Summary

I have built and deployed an alpha x402 v2 binding for Kaspa, a
proof-of-work blockDAG L1 with sub-second block cadence and native UTXO
semantics. I would like maintainer guidance on contributing it upstream as
per-ecosystem bindings for the existing `exact` and `batch-settlement`
scheme families. As far as I can tell this would be the first UTXO-based
ecosystem in x402.

Everything below is alpha and `kaspa:testnet-10` only. I make no mainnet or
production claims; mainnet use is explicitly blocked by published readiness
gates.

### What exists today

- Standards reference: https://kaspa-x402.org has the specs, canonical JSON
  Schemas with resolvable `$id` URLs, conformance vectors (including
  negative vectors), and hash-locked immutable release snapshots.
- Wire format built against x402 v2: `PAYMENT-REQUIRED` /
  `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE` headers carrying base64 JSON,
  `x402Version: 2`, CAIP-2-shaped network identifiers, and the upstream
  error-reason vocabulary. MCP transport uses the standard
  `_meta["x402/payment"]` and `_meta["x402/payment-response"]` keys.
- Hosted testnet gateway: https://demo.kaspa-x402.org is a Cloudflare Worker
  with Durable Object state serving public `batch-settlement` and
  `exact-transaction` integration endpoints against live `kaspa:testnet-10`
  chain evidence, with a scheduled public canary at `/canary`. The alpha.9
  source defaults to ordinary `standard-native` exact transfers. Optional
  KIP-10 `additive` uses operator-registered durable head chains. The Worker
  holds no spending keys, and exact transaction artifacts are submitted through
  TN10 PNN/WSS.
- Recorded live paid evidence is split intentionally: gateway docs cover hosted
  batch evidence and the hosted exact proof; the alpha.9 private TN10
  live harness covers replay handling and the batch escrow claim/refund
  lifecycle.
- Reference implementation on npm under prerelease tags:
  `@kaspa-x402/core`, `@kaspa-x402/client`, `@kaspa-x402/server`,
  `@kaspa-x402/covenant`.
- Implementer guide, threat model, review ledger, and interoperability
  checklist published on the reference site.

### How the bindings work (short version)

- `exact` (`extra.binding: "kaspa-exact-v2"`): fixed-price one-shot native KAS
  transfer with an explicit profile. `standard-native` is the default ordinary
  transfer: the merchant receives exactly the advertised amount in the
  canonical payment output. Optional KIP-10 `additive` consumes a reusable
  merchant head and recreates the same script at index zero; its successor
  increase must equal the advertised amount exactly and is the only merchant
  payment. Unpaid 402s do not reserve or retire heads. The client returns a
  signed SDK-safe JSON `exact-transaction` artifact for the server or
  facilitator to verify, broadcast if needed, and observe. Amounts are decimal
  sompi strings. KIP-9 storage mass is transaction-shape-dependent and does not
  define a universal dust constant.
- Deployed Alpha.9 `batch-settlement` (`extra.binding: "kaspa-escrow-v1"`):
  the client funds
  a covenant-backed escrow once, signs a cumulative Schnorr voucher per paid
  request, and the chain is touched again only at claim or refund time. This
  is the same escrow-plus-off-chain-voucher model as the upstream EVM
  batch-settlement binding, implemented with UTXO covenants. Per-request
  prices below that reference on-chain policy are possible here (the demo gateway charges 500
  sompi per request).
- `upto`: I prototyped a capped-authorisation profile and archived it
  because Kaspa cannot natively guarantee an authorisation-expiry bound;
  the rationale is published (native-profile-boundary doc). I would rather
  ship two sound bindings than three approximate ones.

### What I am asking

1. Contribution vehicle: are per-ecosystem binding specs from
   `scheme_template.md` / `scheme_impl_template.md` (as with
   `scheme_exact_evm.md`, `scheme_exact_svm.md`, and the Aptos and Hedera
   additions) the right vehicle for a UTXO ecosystem, or would maintainers
   prefer this land as a v2 Extension package first?
2. CAIP-2 reference convention: the binding currently uses `kaspa:mainnet` and
   `kaspa:testnet-10` (matching rusty-kaspa's canonical network names, in
   the style of `stellar:pubnet`). A `kaspa` namespace registration at
   ChainAgnostic/namespaces is in flight. Do maintainers have a preference
   between named references and genesis-hash references for new namespaces?
3. Native-asset expectations: KAS is a native asset priced in sompi. This alpha
   uses the native-KAS output check in `kaspa-exact-v2`. I am not requesting
   default-asset (dollar-string) registry entries. Is runtime registration the
   expected long-term posture for native-asset ecosystems, or is there a listing
   path I should follow?

### Wire-level notes for maintainer eyes

- MCP settlement-failure information loss: the v2 HTTP transport returns
  the failed `SettlementResponse` in the `PAYMENT-RESPONSE` header, but the
  v2 MCP transport returns only a fresh `PaymentRequired` in
  `structuredContent`, so the machine-readable failure object
  (`errorReason`, `payer`, `transaction`, extensions) is lost on that
  transport. This binding ships upstream's failure shape unchanged and
  additionally delivers the failed `SettlementResponse` in
  `_meta["x402/payment-response"]`, mirroring the HTTP transport; the
  `batch-settlement` corrective flow depends on the channel state carried
  in those settlement extensions. I propose standardising that `_meta`
  key for settlement failures and will adopt whatever shape maintainers
  settle on.
- `PaymentRequired.error` content: the binding returns machine reasons (for example
  `invalid_transaction_state`) where upstream examples show human-readable
  text. I can align if there is a convention.

### Limits, stated plainly

Alpha; `kaspa:testnet-10` only; wire format not frozen until a tagged spec
release; mainnet blocked by published gates (independent audit among them);
the hosted gateway is a test target, not infrastructure; exact-payment
evidence is bearer evidence within a resource scope (documented, with payer
binding queued for the next revision).

### Links

- Reference site: https://kaspa-x402.org
- Core binding spec: https://kaspa-x402.org/spec/kaspa-x402-v1/
- Gateway + live paid evidence: https://kaspa-x402.org/docs/testnet-gateway/
- Implementer guide: https://kaspa-x402.org/docs/demo-implementer-guide/
- Repository: https://github.com/elldeeone/kaspa-x402

---

## Submission notes (not part of the issue)

- Sequencing: the CASA `kaspa` namespace PR goes first. Post this issue when
  that PR reaches Last Call or acceptance, updating the CAIP wording in the
  ask from "in flight" to its actual status. Deadlock-breaker: if the CASA
  PR sits without meaningful review for four weeks, post this issue anyway
  with the registration described as "in review".
- Post from the operator's GitHub account; expect DCO sign-off requirements
  on any follow-up PRs (LF project).
- Track every upstream response as a repository issue with an owner; record
  a "no response as of <date>" outcome after two weeks of silence.
- Follow-up work if the response is positive, in order: CASA namespace PR
  lands; `scheme_exact_kaspa` spec PR from the upstream template;
  `scheme_batch_settlement_kaspa` spec PR; v2 SDK plugin package; ecosystem
  page listing. Each is a separate approval gate.
