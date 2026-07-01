# MCP Profile

Status: draft

Kaspa x402 treats MCP as a first-class transport for paid tools using `exact`, `upto`, and `batch-settlement`.

MCP tools should advertise the cheapest safe scheme for the tool call. Fixed-price tools can use `exact`; variable token or compute tools should use `upto`; frequently called metered tools should also offer `batch-settlement`.

MCP servers must treat paid tool execution as a single idempotent operation. A retry with the same payment identifier and same tool-call fingerprint should return the cached paid result, not execute the tool again.

## Payment Required

An unpaid tool call returns a tool result with:

```text
isError = true
structuredContent = PaymentRequired
content[0].text = JSON.stringify(PaymentRequired)
```

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

If settlement fails after tool execution, the server must not include the paid tool result in `content` or `structuredContent`. It should return an error result with the failed `SettlementResponse` in `_meta["x402/payment-response"]`.

For `batch-settlement`, a successful voucher-only tool response may include an empty `transaction`, must omit top-level `amount`, and must include a non-empty `extra.commitmentId`.
