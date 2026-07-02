import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  mcpPaymentRequiredResult,
  mcpToolCallFingerprint,
  mcpToolResource,
  readMcpPaymentPayload,
  withMcpPaymentResponse,
  type McpToolCallParams,
  type McpToolResult,
  type PaymentPayload,
  type PaymentRequired,
  type ResourceInfo,
  type SompiString,
} from "@kaspa-x402/core";
import { DirectModeServer } from "./direct-server.js";
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  type HandlerContext,
  type ServerResponse,
} from "./types.js";

export interface PaidMcpToolOptions {
  name: string;
  resource?: ResourceInfo;
  amount?: SompiString;
  scheme?: "exact" | "batch-settlement";
}

export interface PaidMcpToolHandlerContext extends HandlerContext {
  params: McpToolCallParams;
}

export interface PaidMcpToolHandlerResult {
  result: McpToolResult;
  chargedAmount?: SompiString;
}

export type PaidMcpToolHandler = (context: PaidMcpToolHandlerContext) => Promise<PaidMcpToolHandlerResult> | PaidMcpToolHandlerResult;

export async function handlePaidMcpToolCall(
  server: DirectModeServer,
  options: PaidMcpToolOptions,
  params: McpToolCallParams,
  handler: PaidMcpToolHandler,
): Promise<McpToolResult> {
  const resource = options.resource ?? mcpToolResource({ name: options.name });
  if (params.name !== options.name) {
    return mcpErrorResult(`MCP tool name mismatch: expected ${options.name}`);
  }

  const fallbackPaymentRequired = server.buildPaymentRequired({ resource, amount: options.amount, scheme: options.scheme });
  let paymentPayload: PaymentPayload | undefined;
  try {
    paymentPayload = readMcpPaymentPayload(params);
  } catch {
    return mcpPaymentRequiredResult(fallbackPaymentRequired);
  }

  const requestHash = paymentPayload
    ? mcpToolCallFingerprint({
        toolName: options.name,
        arguments: params.arguments,
        accepted: paymentPayload.accepted,
      })
    : undefined;

  const response = await server.handlePaidRequest(
    {
      method: "MCP",
      url: resource.url,
      resource,
      body: {
        toolName: options.name,
        arguments: params.arguments ?? null,
      },
      paymentAmount: options.amount,
      paymentScheme: options.scheme,
      requestHash,
      headers: paymentPayload ? { [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader(paymentPayload) } : undefined,
    },
    async (context) => {
      const result = await handler({
        ...context,
        params,
      });
      return {
        body: result.result,
        chargedAmount: result.chargedAmount,
      };
    },
  );

  return serverResponseToMcpResult(response, fallbackPaymentRequired);
}

function serverResponseToMcpResult(response: ServerResponse, fallbackPaymentRequired?: PaymentRequired): McpToolResult {
  const paymentRequiredHeader = response.headers[PAYMENT_REQUIRED_HEADER];
  if (paymentRequiredHeader) {
    return mcpPaymentRequiredResult(decodePaymentRequiredHeader(paymentRequiredHeader));
  }

  const paymentResponseHeader = response.headers[PAYMENT_RESPONSE_HEADER];
  const settlement = paymentResponseHeader ? decodePaymentResponseHeader(paymentResponseHeader) : undefined;
  if (settlement && !settlement.success) {
    return withMcpPaymentResponse(mcpErrorResult(settlement.errorReason ?? "Settlement failed"), settlement);
  }

  if (response.status >= 400) {
    return settlement ? withMcpPaymentResponse(mcpErrorResult(errorMessageFromBody(response.body)), settlement) : mcpErrorResult(errorMessageFromBody(response.body));
  }

  const result = isMcpToolResult(response.body) ? response.body : mcpTextResult(response.body);
  return settlement ? withMcpPaymentResponse(result, settlement) : result;
}

function mcpTextResult(value: unknown): McpToolResult {
  if (value === undefined) return { content: [] };
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value),
      },
    ],
  };
}

function mcpErrorResult(message: string): McpToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: message,
      },
    ],
  };
}

function errorMessageFromBody(body: unknown): string {
  if (typeof body === "string") return body;
  if (isRecord(body) && typeof body.error === "string") return body.error;
  return "MCP tool payment failed";
}

function isMcpToolResult(value: unknown): value is McpToolResult {
  return isRecord(value) && ("content" in value || "structuredContent" in value || "isError" in value || "_meta" in value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
