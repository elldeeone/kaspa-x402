# MCP Profile

Status: draft

Kaspa x402 treats MCP as a first-class transport for paid tools.

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

