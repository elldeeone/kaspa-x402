# MCP Profile

Status: draft

Kaspa x402 treats MCP as a first-class transport for paid tools using `exact` and `batch-settlement`.

MCP tools should advertise the cheapest safe scheme for the tool call. Fixed-price tools can use `exact`; variable token, compute, or frequently called metered tools should use `batch-settlement`.

MCP servers must treat paid tool execution as a single idempotent operation. A retry with the same payment identifier and same tool-call fingerprint should return the cached paid result, not execute the tool again.

Every MCP integration MUST configure a canonical server audience, such as the
authenticated MCP server origin or service URI. The server supplies this value
from trusted configuration; it MUST NOT accept an audience chosen by tool-call
arguments or untrusted payment metadata. Clients MUST pin the same audience for
the server they are calling.

## Payment Required

An unpaid tool call returns a tool result with:

```text
isError = true
structuredContent = PaymentRequired
content[0].text = JSON.stringify(PaymentRequired)
```

Clients must treat the challenge as an x402 v2 envelope and select a supported Kaspa entry from `accepts`, skipping entries for other schemes, networks, or assets instead of rejecting the whole challenge. Kaspa MCP servers must emit only `exact` and `batch-settlement` entries defined by this binding.

## Payment Retry

The client retries the tool call with:

```text
params._meta["x402/payment"] = PaymentPayload
```

## Payment Response

Successful paid tool calls return:

```text
result._meta["x402/payment-response"] = SettlementResponse
```

Servers should require the `payment-identifier` extension for idempotent agent retries.

If settlement fails after tool execution, the server must not include the paid tool result in `content` or `structuredContent`. It must return an error result using the upstream payment-required shape plus a Kaspa settlement extension:

```text
isError = true
structuredContent = PaymentRequired
content[0].text = JSON.stringify(PaymentRequired)
_meta["x402/payment-response"] = SettlementResponse
```

The `PaymentRequired` value should include the settlement failure reason in `error` when available. The `_meta["x402/payment-response"]` value preserves the machine-readable settlement `success`, `errorReason`, network, amount, and Kaspa extension fields. Clients must process `_meta["x402/payment-response"]` first when it is present; a failed settlement response is terminal even when `structuredContent` also contains a `PaymentRequired` challenge. If `_meta["x402/payment-response"]` is absent, clients may treat `PaymentRequired` in `structuredContent` or `content[0].text` as an unpaid or corrective challenge.

## Tool-Call Fingerprint

MCP helpers should derive the payment request fingerprint from:

- the canonical MCP server audience;
- tool name;
- canonical tool arguments;
- selected `PaymentRequirements`.

The audience prevents one server from accepting an exact authorization created
for an otherwise identical tool and payment offer on another server. Changing
the audience MUST change the fingerprint and invalidate the request
authorization. The current fingerprint domain is
`kaspa:x402:mcp-tool-call:v2`; v1 fingerprints without an audience are not
accepted by this profile.

Scheme-specific payment identity is enforced by the normal payment payload hash and settlement scope:

- `exact`: transaction id and payment output index;
- `batch-settlement`: channel id and voucher amount.

This avoids circular dependencies where a transaction id is not known until after the client creates the payment.

For `batch-settlement`, a successful voucher-only tool response uses the non-empty commitment id as `transaction`, includes the actual charge as top-level `amount`, and carries commitment and channel metadata in `extensions.kaspa`.
