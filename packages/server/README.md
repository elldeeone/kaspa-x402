# @kaspa-x402/server

Server SDK for direct-mode Kaspa x402 payments.

The current implementation covers framework-neutral HTTP gating for `exact` one-shot transfers, `upto` capped one-shot authorizations, and `batch-settlement` escrow channels:

- builds x402 v2 `PAYMENT-REQUIRED` offers;
- extracts and validates `PAYMENT-SIGNATURE` retries;
- verifies exact transaction output amount, pay-to script, transaction id, and finality through an injected verifier;
- verifies `upto` authorization digests, DAA validity windows, authorization scripts, backing UTXOs, signatures, replay scopes, and nonzero settlement transaction evidence through injected adapters;
- verifies funding outpoints, escrow scripts, and cumulative vouchers through injected adapters;
- serializes per-transaction or per-channel verification, handler execution, and state commit;
- stores exact transaction replay records before returning protected content;
- stores `upto` authorization consumption before returning protected content, including zero-charge no-transaction responses and recoverable accepted broadcasts;
- stores per-request settlement commitments before advancing channel charge state;
- supports payment identifier idempotency for exact, upto, and batch payment-payload retries;
- returns corrective `402` responses with channel state where possible;
- validates custom per-request amounts when `PaidRequest.paymentAmount` is supplied;
- exposes claim preview and claim execution hooks with pending-claim tracking and explicit abandon-after-reconciliation support.

Node, indexer, address-codec, signature-verifier, transaction-builder, settlement-transaction-verifier, and state-store behavior is injected through typed adapters. Production deployments should back the state store with durable transactional storage. Amounts on the wire remain decimal sompi strings.
