import { paidMcpToolCall } from "@kaspa-x402/client";
import { handlePaidMcpToolCall } from "@kaspa-x402/server";
import { createMockDirectModeEnvironment } from "../lib/mock-direct-mode.mjs";

const { client, server } = createMockDirectModeEnvironment();

async function callTool(params) {
  return handlePaidMcpToolCall(
    server,
    {
      name: "quote",
      resource: {
        url: "mcp://tool/quote",
        description: "Paid quote tool",
        mimeType: "application/json",
      },
      amount: "250000",
      scheme: "upto",
    },
    params,
    async ({ params: paidParams }) => {
      const symbol = typeof paidParams.arguments?.symbol === "string" ? paidParams.arguments.symbol : "KAS";
      return {
        chargedAmount: "175000",
        result: {
          structuredContent: {
            symbol,
            price: "175000",
          },
          content: [{ type: "text", text: `paid quote for ${symbol}` }],
        },
      };
    },
  );
}

const paid = await paidMcpToolCall(
  client,
  callTool,
  {
    name: "quote",
    arguments: {
      symbol: "KAS",
    },
  },
  {
    paymentIdentifier: "mcp_quote_payment_1",
  },
);

console.log(
  JSON.stringify(
    {
      paid: paid.result.isError !== true,
      scheme: paid.payment?.scheme,
      chargedAmount: paid.settlement?.chargedAmount,
      content: paid.result.content,
      metadataPresent: Boolean(paid.result._meta?.["x402/payment-response"]),
    },
    null,
    2,
  ),
);
