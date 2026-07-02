# Native Profile Boundary

Status: current alpha decision

Kaspa x402 currently treats these profiles as the native public surface:

- `exact`: fixed-price one-shot native KAS payment.
- `batch-settlement`: Toccata escrow channel with cumulative vouchers, claim,
  continuation, replay rejection, and refund paths.

The capped one-shot authorization work that maps to x402 `upto` is archived
research for now. It should not be advertised as a current native Kaspa x402
profile, returned from `/supported`, included in new examples, or used as a
mainnet-readiness signal.

## Why It Is Archived

The experimental capped authorization template can enforce useful constraints:

- server settlement signature;
- client authorization digest;
- exact authorization outpoint binding;
- maximum charge;
- payout and refund script hashes;
- refund output shape;
- fee reserve bound;
- settlement lower bound;
- refund lower bound.

The missing guarantee is the settlement expiry upper bound. The current script
path can enforce "not before this DAA/time" behavior, but it cannot enforce
"not at or after this DAA/time" against current chain time or current acceptance
DAA inside the spend path. The implementation currently relies on
server/facilitator verification to reject late settlement. That policy check is
useful, but it is not an on-chain covenant guarantee.

`tx.locktime` is not a replacement for current chain time. It is a transaction
field that can be inspected by script, and locktime checks are lower-bound
checks. `OpTxInputDaaScore` exposes the creation DAA of an input UTXO, not the
current DAA at spend acceptance.

## Decision

Until native script-visible current DAA or current time is available and
expressible through SilverScript without custom byte pinning, capped one-shot
authorization remains outside the shipped native surface.

Implementation cleanup should remove capped authorization from public schemas,
runtime APIs, examples, CLI commands, package exports, and hosted-demo plans.
The archive branch keeps the experiment available for future upstream work.

## Release Plan

The cleanup release target is `0.1.0-alpha.1` for:

- `@kaspa-x402/core`;
- `@kaspa-x402/covenant`;
- `@kaspa-x402/client`;
- `@kaspa-x402/server`.

It should be published only after explicit operator approval, with the `alpha`
dist-tag. Until a stable release owns `latest`, install guidance should use:

```sh
npm install @kaspa-x402/core@alpha @kaspa-x402/covenant@alpha @kaspa-x402/client@alpha @kaspa-x402/server@alpha
```

The next alpha should:

- publish only `exact` and `batch-settlement` as supported native profiles;
- reject capped authorization inputs with a clear unsupported-profile error;
- explain that capped authorization was experimental and removed from the
  current public surface for covenant-correctness reasons;
- keep npm publishing behind explicit operator approval;
- avoid using `latest` as the alpha install path unless a stable release policy
  explicitly changes.
