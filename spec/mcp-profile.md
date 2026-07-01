# MCP Profile

Status: draft

Kaspa x402 treats MCP as a first-class transport for paid tools using `exact`, `upto`, and `batch-settlement`.

MCP tools should advertise the cheapest safe scheme for the tool call. Fixed-price tools can use `exact`; variable token or compute tools should use `upto`; frequently called metered tools should also offer `batch-settlement`.

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
result._meta["x402/payment-response"] = SettleResponse
```

Servers should require the `payment-identifier` extension for idempotent agent retries.
