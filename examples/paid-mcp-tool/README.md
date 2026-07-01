# Paid MCP Tool

This example shows the framework-neutral flow for protecting an MCP tool with Kaspa x402.

```sh
npm run build
node examples/paid-mcp-tool/index.mjs
```

Server-side tool wrapper:

```ts
import { handlePaidMcpToolCall } from "@kaspa-x402/server";

function quoteArgs(value: unknown): { symbol: string } {
  if (value && typeof value === "object" && "symbol" in value && typeof value.symbol === "string") {
    return { symbol: value.symbol };
  }
  throw new Error("symbol is required");
}

const result = await handlePaidMcpToolCall(
  directModeServer,
  {
    name: "quote",
    resource: { url: "mcp://tool/quote", description: "Paid quote tool", mimeType: "application/json" },
    amount: "100000",
    scheme: "upto",
  },
  params,
  async ({ params }) => {
    const args = quoteArgs(params.arguments);
    return {
      chargedAmount: "75000",
      result: {
        structuredContent: { quote: `quote for ${args.symbol}` },
        content: [{ type: "text", text: "paid quote ready" }],
      },
    };
  },
);
```

Client-side retry helper:

```ts
import { paidMcpToolCall } from "@kaspa-x402/client";

const paid = await paidMcpToolCall(
  directModeClient,
  (nextParams) => mcpClient.callTool(nextParams),
  { name: "quote", arguments: { symbol: "KAS" } },
  { paymentIdentifier: "pay_example_0001" },
);

console.log(paid.result._meta?.["x402/payment-response"]);
```

The server returns `structuredContent` plus text fallback for unpaid calls. The client retries with `_meta["x402/payment"]`. Successful paid results carry `_meta["x402/payment-response"]`.

The runnable script uses the same helper flow in mock mode with an `upto` quote tool. It prints the charged amount and confirms that payment response metadata is present.
