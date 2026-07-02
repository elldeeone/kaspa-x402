# Security Threat Model

Status: design and implementation review notes for the current reference implementation. This is not an external audit.

## Scope

This model covers the draft Kaspa x402 profiles, TypeScript reference packages, deterministic vectors, mock examples, and the live testnet proof harness. It focuses on direct mode first, then the optional facilitator wrapper.

The primary protected assets are:

- protected resource content and tool results;
- client funds in one-shot exact payments, capped upto authorizations, and batch escrow channels;
- server payout funds and settlement state;
- replay, idempotency, and channel stores;
- signing keys for exact payments, upto authorizations, vouchers, claims, and refunds.

Out of scope for this repository:

- wallet UI safety;
- third-party custody controls;
- hosted facilitator authentication policy;
- production monitoring and alerting systems;
- external audit findings not recorded in
  [review-closure-ledger.md](./review-closure-ledger.md).

## Trust Boundaries

Direct mode has three local trust boundaries:

- client funding and signing adapters;
- server chain, transaction, voucher, and settlement adapters;
- persistent stores for replay, idempotency, authorization, claim, and channel state.

Facilitator mode wraps the same direct-mode verifier and settlement paths. A facilitator must not become a separate authority that can bypass direct-mode replay, amount, finality, or channel-state rules.

## Threats And Controls

| Threat | Required invariant | Current mitigation | Residual risk |
| --- | --- | --- | --- |
| Malicious client underpays or points to the wrong output | The verifier derives or verifies transaction identity and selected output data before releasing content. | Exact verification rejects payload hints that do not match verifier output and checks amount, script, and finality. | Correctness depends on the injected transaction verifier in live deployments. |
| Malicious client reuses an exact transaction | One transaction buys one request unless it is the same verified transaction, output, and request fingerprint retry. | Server stores exact replay records keyed by transaction id, takes a verifier-derived transaction lock before handler execution, and returns replay conflicts for different request fingerprints or sibling outputs. | Store durability is required; in-memory stores are test/demo only. |
| Malicious client reuses an upto authorization | An authorization outpoint and nonce are single-use. | Upto verification checks both outpoint scope and nonce scope before handler execution. | Store durability and cross-process locking are required in production. |
| Malicious client submits stale or underpaid batch vouchers | Voucher amount must be the required cumulative ceiling and must leave claim reserve. | Batch verification computes the required cumulative voucher amount, checks funding UTXO, rejects reserve-consuming vouchers, and returns corrective channel state when useful. | Operators must tune fee reserves for live network conditions. |
| Voucher replay against a successor or sibling output | Voucher digest must bind domain, network, active script, txid, vout, and amount; the voucher signature must verify that digest against the channel client key. | `voucherDigest` binds the full outpoint and active script; the server verifies the voucher signature separately; the covenant test requires the same-txid/different-vout digest to change. | Any future digest version must preserve full outpoint and script binding. |
| Malicious server overclaims a batch channel | Server output cannot exceed signed voucher amount; continuation must preserve the remainder. | Transaction-v1 claim builder caps the server output, subtracts fees from the server output, and requires the continuation output to keep the active script. | Live builder adapters must be pinned to the reviewed artifact semantics. |
| Malicious server blocks refund | Refund path must spend the current active outpoint after timeout without server cooperation. | Client refund checks DAA timeout, requires refund signing and builder adapters, and marks the channel refunded only after accepted or confirmed broadcast. | The local client must retain current channel state and refund key material. |
| Handler failure consumes payment state | Payment state is committed only after protected handler success, except explicitly accepted recoverable settlement states. | Exact, upto, and batch commit paths build responses after handler return; tests cover handler failure, failed persistence, pending upto recovery, and batch corrective state. | Product terms must state whether failed but billable work exists; default behavior is no charge. |
| Duplicate retry double-executes protected work | Same id and same fingerprint return cached result; same id with different fingerprint fails. | Payment-identifier records bind fingerprint, payment payload hash, and payment scope; tests cover exact, upto, batch, MCP, and concurrent retries. | Deployments need a durable store with atomic compare-and-set behavior. |
| Stale indexer, unsynced node, or RPC failure | Verification must fail closed or return pending without releasing content. | UTXO and transaction finality checks require accepted or confirmed policy; pending upto settlement returns non-402 pending responses without re-executing the handler. | External node health and finality monitoring are deployment responsibilities. |
| Lost local state | Recovery must avoid accepting stale vouchers or replayed authorizations. | Recovery example documents lost client/server state; server corrective responses carry active channel and voucher state only for active channels. | Production stores need backups, snapshots, and explicit recovery runbooks. |
| Funding source policy bypass | Required funding source cannot silently fall back. | Client checks `fundingPolicy.requiredSource` against the funding provider and returned funding source for exact, upto, and batch. | The provider itself must be audited; hot-wallet mode is not a treasury control. |
| Secrets in logs or reports | Keys and recovery material must remain outside public artifacts. | Live proof writes operational reports to ignored `.kaspa-x402-live/`; the committed report is sanitized. | Operators must review adapter logs and CI artifacts before sharing. |
| Malicious facilitator overclaims or widens capabilities | Facilitator support must be derived from wrapped server capability and explicit action settlers. | Facilitator `supported()` intersects custom kinds with server-supported kinds and only exposes claim/refund when configured. Settlement delegates exact, upto, and batch to direct-mode server paths. | Hosted facilitators still need authentication, rate limits, and tenant isolation. |
| Key compromise | Compromised client, server, or funding keys can sign valid actions until rotated. | Current code separates funding provider, channel signer, server key, and refund signer interfaces. | Rotation, HSM/vault integration, spend caps, revocation, and incident response remain operator requirements. |

## Scheme Review Notes

### Exact

Required safety properties:

- transaction identity is derived by the verifier, not trusted from payload hints;
- selected output pays exactly the offered amount;
- selected output script matches `payTo`;
- request hash binds the payment to protected work when supplied;
- replay state is committed only after handler success;
- finality reaches local and advertised policy before success.

Evidence:

- `packages/server/src/direct-server.ts` verifies output amount, script, payload hint consistency, and finality before returning a verified exact payment.
- `packages/server/test/direct-server.test.ts` covers request-hash mismatch, cached exact retry, different-request replay rejection, same-transaction sibling-output rejection, mixed hinted/non-hinted transaction locking, and output mismatch rejection.
- `scripts/proof-offline.mjs` and `docs/live-testnet-report.md` record exact replay rejection.

Residual risk:

- live deployments must use a transaction verifier that derives transaction id and output data from serialized bytes.

### Upto

Required safety properties:

- digest binds domain, network, active script public key, exact outpoint, nonce, and request hash; the active script binds asset lane, recipient, refund address, server key, client key, max amount, validity window, and fee reserve;
- actual charge cannot exceed signed maximum;
- authorization outpoint and nonce are consumed at most once;
- zero-charge success stores consumption before content release;
- nonzero settlement refunds uncharged value and reaches required finality before success;
- expired and not-yet-valid authorizations fail.

Evidence:

- `packages/core/src/upto.ts` defines the signed digest fields.
- `packages/server/src/direct-server.ts` checks max amount, recipient, server key, validity window, derived script, UTXO, signature, single-use outpoint, single-use nonce, and settlement transaction evidence.
- `packages/server/test/direct-server.test.ts` covers zero-charge consumption, nonzero settlement, invalid signatures, expired authorizations, recipient/server-key/max-amount mismatches, outpoint replay, nonce replay, pending recovery, and output/refund evidence rejection.
- `vectors/tx-v1/upto-settlement.json` records the nonzero transaction-v1 body, txid, tx hash, sighash, storage mass, compute budget, and output plan.
- `docs/live-testnet-report.md` records zero-charge and nonzero testnet runs plus replay rejection.

Residual risk:

- mainnet use still requires independent review of the native builder, verifier, finality, and store durability.

### Batch Vouchers

Required safety properties:

- channel id binds immutable network, asset, template, client key, server key, payout, refund address, timeout, and salt;
- voucher digest binds domain, network, active script, full active outpoint, and cumulative amount;
- voucher signature is checked against the channel client key;
- voucher amount is cumulative, not per-request, and cannot exceed funding or required reserve;
- stale state produces a corrective 402 instead of silent acceptance.

Evidence:

- `packages/core/src/voucher.ts` binds network, active script, txid, vout, and amount.
- `packages/server/src/direct-server.ts` validates channel terms, active outpoint, funding UTXO, amount, reserve, and voucher signature.
- `packages/covenant/test/covenant.test.ts` requires the same-txid/different-vout digest to differ and checks wrong network and wrong script digests.
- `packages/server/test/direct-server.test.ts` covers underpaid vouchers, bad signatures, wrong funding outpoint, corrective channel state, custom amounts, and reserve rejection.

Residual risk:

- servers must keep channel stores durable and serialize per-channel settlement commits.

### Claim

Required safety properties:

- claim amount is capped by signed voucher amount and active input amount;
- fee comes from server output, not from continuation;
- continuation output is positive and preserves the active escrow script;
- payout script matches configured server payout;
- server transaction signature authorizes the claim spend while the voucher signature authorizes the client-signed cumulative ceiling;
- compute budget and script-unit assumptions are explicit;
- open claim attempts block conflicting voucher settlement until resolved.

Evidence:

- `packages/covenant/src/tx-v1.ts` builds claim arguments from both `serverSignature` and `voucherSignature`, then enforces claim output count, payout hash, continuation amount/script, fee source, native subnetwork, zero gas, contextual mass, compute budget, and script units.
- `packages/covenant/test/covenant.test.ts` reproduces the claim vector, verifies claim argument encoding and signature lengths, and rejects malformed output ordering, continuation amount, compute budget, gas, subnetwork, mass, and output covenant plans.
- `packages/server/test/direct-server.test.ts` covers claim preview, dust rejection, claim execution to a continuation outpoint, and atomic claim apply failure.
- `docs/live-testnet-report.md` records a testnet claim and continuation outpoint.

Residual risk:

- the claim builder and live adapter must remain pinned to the reviewed transaction-v1 semantics.

### Refund

Required safety properties:

- refund is available only after the configured DAA timeout;
- refund spends the current active outpoint;
- server cannot block refund after timeout;
- refund output script matches the configured refund address;
- fees are explicit and cannot consume the whole output.

Evidence:

- `packages/client/src/direct-client.ts` checks refund timeout, requires refund signing and transaction builder adapters, broadcasts through the funding provider, and marks refunded only after accepted or confirmed finality.
- `packages/covenant/src/tx-v1.ts` enforces refund lock time, input sequence, output count, refund output script, fee accounting, native subnetwork, zero gas, contextual mass, compute budget, and script units.
- `packages/covenant/test/covenant.test.ts` reproduces the refund vector and rejects early lock time, nonzero sequence, wrong script, missing compute budget, gas, subnetwork, mass, and output covenant plans.
- `docs/live-testnet-report.md` records a testnet refund after timeout.

Residual risk:

- client-side state loss before refund remains operationally risky unless channel state and keys are backed up.

### Idempotency And Ordering

Required safety properties:

- verification failures never execute handlers;
- handler failures do not commit billable state by default;
- duplicate retries return cached content without re-execution;
- same id with different fingerprint or payment payload fails;
- settlement records and idempotency records commit atomically.

Evidence:

- `packages/server/src/direct-server.ts` checks idempotency before handler execution and commits exact, upto, and batch state only through store methods that include payment-identifier records.
- `packages/server/test/direct-server.test.ts` covers handler failure, exact replay, upto replay, batch idempotency, same-id conflicts, concurrent same-id requests, failed atomic settlement persistence, and pending/recovered upto settlement.
- `examples/recovery/index.mjs` demonstrates exact replay, upto replay, corrective state, and refund preview.

Residual risk:

- production stores must provide the same atomicity as the in-memory test store promises.

### Funding And Key Policy

Required safety properties:

- a policy-required source cannot silently fall back to a hot wallet or unrelated adapter;
- provider network must match selected payment network;
- secrets must stay in local adapters, wallets, vaults, or signers, not public reports.

Evidence:

- `packages/client/src/direct-client.ts` checks funding provider network and `fundingPolicy.requiredSource` before exact, upto, and batch payment creation.
- `packages/client/src/types.ts` separates hot-wallet, vault-treasury, and external-wallet-adapter source kinds and separates funding, voucher, upto, and refund signer interfaces.
- `live-proof.env.example` is a template, while live report and recovery files stay under ignored `.kaspa-x402-live/`.

Residual risk:

- treasury adapters, spend caps, signer isolation, and log redaction require deployment-specific review.

### Facilitator Boundary

Required safety properties:

- direct mode works without a facilitator;
- facilitator verify and settle cannot bypass direct-mode replay and settlement rules;
- custom supported kinds cannot advertise capabilities the wrapped server lacks;
- claim/refund actions require explicit settler configuration and payload validation;
- third-party facilitator authentication is explicit and not implied by this reference package.

Evidence:

- `packages/facilitator/src/index.ts` delegates verify and normal settlement to `DirectModeServer`, intersects advertised support with wrapped server support, and only exposes action modes with explicit settlers.
- `packages/facilitator/test/facilitator.test.ts` covers exact, upto, and batch settlement through shared direct-mode paths, unsupported mode rejection, invalid custom modes, prevention of capability expansion, and claim/refund action validation before settler invocation.

Residual risk:

- hosted facilitator authentication, tenant isolation, rate limits, and policy enforcement are still deployment responsibilities.

## Review Verdict

The reference implementation has coherent internal security invariants for draft, testnet-backed development. It is not mainnet-ready until the readiness gates in [mainnet-readiness.md](./mainnet-readiness.md) are complete.
