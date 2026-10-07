# Exact compatibility with upstream x402

Start here for the local request-binding experiment. Run from the repository root:

```sh
npm ci
npm run check:x402-compatibility
```

The test uses the published `@x402/core` **2.28.0**, pinned in the root
`package-lock.json`. It uses upstream's real client, resource server, HTTP
payment flow, HTTP facilitator serializer, and facilitator dispatch. No
upstream files are patched. The HTTP connection and chain backend are test
doubles. `npm test` also runs this check and the existing reference suites.

## Decision tested

An independently computed request hash can travel through upstream's existing
`SchemeNetworkServer.enrichSettlementPayload` hook. It does not need a new
top-level facilitator field or a change to the payer's signed preimage.

1. The request-scoped client receives the intended method, URL, body and
   normalized security context. It computes the existing fingerprint and asks
   the wallet to sign the existing exact authorization. KAS is explicitly
   allowed with an atomic spend cap; it is not treated as a dollar stablecoin.
2. The resource server obtains the actual operation from its host, compares
   its independent fingerprint with the payer's, and aborts on mismatch. An
   ordinary thrown lifecycle-hook error is insufficient: upstream logs it and
   continues. The hook returns `{ abort: true }` instead.
3. Before settlement, the server adds `payload.kaspaServerBinding`, containing
   the raw request hash, normalized security context when present, full
   original payment and requirements hashes, an audience and a short expiry.
   It signs that statement with a separate Ed25519 server key.
4. The facilitator checks a **configured** server public key, audience and
   merchant recipient before passing the original payment, independent hash
   and trusted context to the backend. The backend must still verify the
   payer signature, transaction, expiry, chain evidence and replay ownership.
   It applies the trusted context to the raw hash once, as DirectMode does.
5. After accepted settlement, the host separately guards protected work by
   the returned canonical transaction id and request fingerprint. Repeating
   a successful settlement response must not repeat the operation.

The three-field upstream facilitator request stays unchanged:
`{ x402Version, paymentPayload, paymentRequirements }`. The extra statement is
mechanism data in its existing payload object. Neither `accepted` nor any
payer-signed field is rewritten. Putting the existing fingerprint in
`accepted.extra` would instead make the standard-native/additive preimage
self-referential, because it already includes the full requirements hash.

## What this proves

- All three profiles pass through the upstream interfaces with the existing
  payer authorization format. Server statements and payer Schnorr signatures
  are actually signed and verified.
- Changed method, URL, body or tenant is rejected before facilitator access.
  Changing the claimed fingerprint to match a new request without re-signing
  is rejected by payer-signature verification.
- Missing, forged, tampered or expired server statements fail closed. A payer
  cannot supply its own server statement, even by copying a valid earlier one.
- Concurrent and later retries produce one simulated broadcast and one
  protected operation; changed payment identifiers do not bypass that guard.
  A new authorization cannot reuse a spent transaction for another operation.
- Settlement failure prevents protected work. An uncertain handler outcome
  remains failed on retry instead of silently running again.

## Limits and next integration work

This is a **local candidate adapter**, not a published SDK or accepted
upstream wire extension. `kaspaServerBinding` and its Ed25519 trust setup are
experimental. A production facilitator must register each resource-server
key with its allowed merchant/network scope, manage rotation and authenticate
its HTTP callers. This example pins one merchant on Testnet-10. No signing
keys are checked in; tests generate server keys and use the published payer
vector key only.

`fixtures.ts` uses existing transaction vectors. The test backend verifies
request authorizations but simulates transaction acceptance and settlement
storage; it does not run Kaspa consensus or fund a transaction. The small
`PrototypeHandlerGate` is deliberately process-local and retains failures.
It is not a durable store and must not be deployed. Existing reference-store
contract tests remain the evidence for durable replay, leases and recovery.

Before production integration, connect the existing canonical verifier and
durable settlement/operation stores to these boundaries, with replica and
restart tests. Port dynamic additive/hash-chain offer issuance and recovery.
Provide host adapters that obtain the actual body and authentication context,
and a request-scoped wallet adapter that receives the same normalized intent.
Missing context must fail closed. This HTTP proof does not establish MCP
interoperability, live-network acceptance or mainnet readiness.

The published DirectMode facilitator API still requires its independent
top-level `requestHash`. This experiment does not silently weaken or replace
that API. The production schema change in this branch is requiring
`extra.paymentFlow: "upfront"`; signed vectors already carrying it are intact.

Upstream primary sources checked for this experiment:
[mechanism hooks](https://github.com/x402-foundation/x402/blob/10b2d06b9472bc467d139b272d01bface38ae2d8/typescript/packages/core/src/types/mechanisms.ts),
[resource-server hook behavior](https://github.com/x402-foundation/x402/blob/10b2d06b9472bc467d139b272d01bface38ae2d8/typescript/packages/core/src/server/x402ResourceServer.ts),
[facilitator wire types](https://github.com/x402-foundation/x402/blob/10b2d06b9472bc467d139b272d01bface38ae2d8/typescript/packages/core/src/types/facilitator.ts).
