# @kaspa-x402/client

Client SDK for direct-mode Kaspa x402 payments.

Status: alpha. This package targets testnet iteration and mock/local examples;
it is not a production wallet, custody, or mainnet funding system.

The current implementation covers HTTP paid fetch and MCP paid tool calls for `exact` one-shot transfers and `batch-settlement` escrow channels:

- parses x402 v2 `PAYMENT-REQUIRED` headers;
- rejects redirects and effective-URL changes before signing or forwarding a
  `PAYMENT-SIGNATURE` header;
- selects supported `exact` and `batch-settlement` Kaspa offers;
- creates `kaspa-exact-v2` transaction retries through an injected funding
  adapter, using default `standard-native` or an advertised reusable
  KIP-10 `additive` head;
- opens singleton KIP-20 deposit-voucher channels through an injected funding
  provider;
- reuses channels with lifetime cumulative vouchers bound to the stable
  covenant ID while persisting the rotating current outpoint;
- applies same-lineage top-ups without resetting A/S/T and exposes the current
  A/S/T/V/R accounting state;
- verifies `PAYMENT-RESPONSE` transaction, amount, output index, finality, and channel state before advancing local charged amounts;
- detects MCP payment-required tool results, binds the tool-call fingerprint to
  a required configured server `audience`, retries with
  `_meta["x402/payment"]`, and applies `_meta["x402/payment-response"]`;
- exposes refund eligibility and a crash-safe, digest-bound refund workflow
  through injected transaction, broadcast, persistence, and reconciliation
  adapters.

Mainnet funding fails closed unless `allowMainnet: true` is set. The default
offer selector accepts only `kaspa:testnet-10`; operators that opt into mainnet
must provide explicit funding, signer, node, custody, and review controls.

Wallet, node, address-codec, and transaction-builder behavior is injected through typed adapters. Amounts on the wire remain decimal sompi strings.

Every batch request crosses the funding provider's mandatory
`authorizeBatchPayment` boundary before the client prepares a deposit or
top-up, broadcasts funding, or signs a voucher. The authorization request
includes the origin, resource, recipient, request identity, resulting voucher
ceiling, and current, additional, and required channel funding. Deployments
SHOULD also configure `maximumBatchAmountSompi` and
`maximumBatchChannelFundingSompi` for automatic funding providers.

## Durable Funding Transitions

Genesis and top-up are prepare-then-broadcast transitions. The funding provider
must implement `prepareEscrowDeposit` and `prepareEscrowTopUp` without sending:
each method returns the exact signed transaction byte hex, its deterministic
transaction id, and the intended singleton covenant successor.

Before `sendTransaction`, the client durably reserves that artifact through
`ChannelStore.claimFundingTransitionAttempt`. A genesis attempt is keyed by its
channel id and retains the complete channel intent; a top-up attempt captures
the exact current channel head and A/S/T/V state. One unresolved transition owns
the lane, blocks vouchers and other channel mutations, and survives restart.

An accepted send is applied only after authoritative UTXO readback, covenant
verification, exact transaction-id matching, and an atomic head compare-and-set.
A transport exception or broadcast-only result stays unresolved and is never
automatically rebuilt or rebroadcast. `reconcileFundingTransition(channelId)`
requires a trusted `FundingTransitionReconciler`: `unknown` keeps the lane
blocked, `accepted` verifies and applies the intended successor, and `absent`
releases the attempt only when the adapter can prove that exact artifact cannot
become accepted.

## Durable Refund Attempts

`refundChannel(channelId)` treats a timeout refund as a durable state transition,
not a retryable wallet call. The refund builder must request exactly one
`signDigest(digest)` after fixing every transaction field, then return the exact
signed transaction byte hex, its deterministic `transactionId`, and the refund
amount. The transaction id returned by the broadcast adapter must match that
persisted id.

Before the first broadcast, the client calls `ChannelStore.claimRefundAttempt`
with the signed transaction, transaction id, stable covenant id, captured head
outpoint and script, funding amount, and channel status. Production stores must
implement the refund methods durably and atomically:

- `loadRefundAttempt` reloads the one captured artifact after restart;
- `claimRefundAttempt` reserves the exact current head before broadcast;
- `saveRefundAttempt` records a broadcast-only result without replacing the
  signed artifact; and
- `applyRefundAttempt` compare-and-sets the captured head and transaction id,
  then marks the channel refunded and the attempt applied in one transaction.

A send exception or `broadcast`-only result leaves the attempt unresolved. It
blocks channel mutation and any second refund; callers must not rebuild or
rebroadcast. `reconcileRefund(channelId)` passes the persisted attempt to a
trusted `RefundReconciler`. An `unknown` result remains unresolved, while an
`accepted` or `confirmed` result atomically applies the refund. A mismatched
transaction id or stale channel head fails closed. Reconciliation of an already
applied attempt is idempotent.

`MemoryChannelStore` demonstrates both transition contracts for tests and
examples. A live deployment needs a durable `ChannelStore` implementation and
trusted funding and refund chain-reconciliation adapters.
