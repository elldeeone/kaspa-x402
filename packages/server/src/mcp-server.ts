import {
  assertMcpPaymentResponseCapacity,
  assertJsonResourceBudget,
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  mcpPaymentRequiredResult,
  mcpSettlementFailureResult,
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
  type TrustedSecurityContext,
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
  /** Trusted server identity that payer authorizations must target. */
  audience: string;
  name: string;
  resource?: ResourceInfo;
  amount?: SompiString;
  scheme?: "exact" | "batch-settlement";
  /** Host-derived normalized claims, never raw credentials. */
  trustedSecurityContext?: TrustedSecurityContext;
  /** Required for batch tools; explicitly authorizes the fixed charge on isError. */
  mcpErrorChargeSompi?: SompiString;
}

export interface PaidMcpToolHandlerContext extends HandlerContext {
  params: McpToolCallParams;
}

export interface PaidMcpToolHandlerResult {
  result: McpToolResult;
  chargedAmount?: SompiString;
}

export type PaidMcpToolHandler = (
  context: PaidMcpToolHandlerContext,
) => Promise<PaidMcpToolHandlerResult> | PaidMcpToolHandlerResult;

export async function handlePaidMcpToolCall(
  server: DirectModeServer,
  options: PaidMcpToolOptions,
  params: McpToolCallParams,
  handler: PaidMcpToolHandler,
): Promise<McpToolResult> {
  let resource: ResourceInfo;
  try {
    assertJsonResourceBudget(
      {
        params,
        audience: options.audience,
        name: options.name,
        resource: options.resource ?? null,
      },
      { label: "MCP tool call" },
    );
    if (options.trustedSecurityContext) {
      assertJsonResourceBudget(options.trustedSecurityContext, {
        label: "MCP trusted security context",
      });
    }
    resource = options.resource ?? mcpToolResource({ name: options.name });
  } catch {
    return mcpErrorResult("invalid_payload");
  }
  if (params.name !== options.name) {
    return mcpErrorResult(`MCP tool name mismatch: expected ${options.name}`);
  }
  if (options.scheme !== "exact" && options.mcpErrorChargeSompi === undefined) {
    return mcpErrorResult(
      "batch MCP tools require an explicit payer-approved error charge",
    );
  }
  if (options.scheme !== "exact") {
    try {
      server.buildPaymentRequired({
        resource,
        amount: options.amount,
        scheme: "batch-settlement",
        trustedSecurityContext: options.trustedSecurityContext,
        mcpErrorChargeSompi: options.mcpErrorChargeSompi,
      });
    } catch {
      return mcpErrorResult("invalid batch MCP error-charge policy");
    }
  }

  let paymentPayload: PaymentPayload | undefined;
  try {
    paymentPayload = readMcpPaymentPayload(params);
  } catch {
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
        trustedSecurityContext: options.trustedSecurityContext,
        mcpErrorChargeSompi: options.mcpErrorChargeSompi,
      },
      async () => ({ body: mcpErrorResult("unreachable") }),
    );
    return controlledServerResponseToMcpResult(response);
  }
  const fallbackPaymentRequired: PaymentRequired | undefined = paymentPayload
    ? {
        x402Version: 2,
        resource,
        accepts: [paymentPayload.accepted],
      }
    : undefined;

  let requestHash: ReturnType<typeof mcpToolCallFingerprint> | undefined;
  try {
    requestHash = paymentPayload
      ? mcpToolCallFingerprint({
          audience: options.audience,
          toolName: options.name,
          arguments: params.arguments,
          accepted: paymentPayload.accepted,
          resource,
          trustedSecurityContext: options.trustedSecurityContext,
        })
      : undefined;
  } catch {
    return mcpErrorResult("invalid_payload");
  }

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
      trustedSecurityContext: options.trustedSecurityContext,
      mcpErrorChargeSompi: options.mcpErrorChargeSompi,
      headers: paymentPayload
        ? {
            [PAYMENT_SIGNATURE_HEADER]:
              encodePaymentSignatureHeader(paymentPayload),
          }
        : undefined,
    },
    async (context) => {
      const result = await handler({
        ...context,
        params,
      });
      assertJsonResourceBudget(result, { label: "MCP tool result" });
      assertMcpPaymentResponseCapacity(result.result);
      return {
        body: result.result,
        chargedAmount: result.chargedAmount,
      };
    },
  );

  return controlledServerResponseToMcpResult(
    response,
    fallbackPaymentRequired,
  );
}

function controlledServerResponseToMcpResult(
  response: ServerResponse,
  fallbackPaymentRequired?: PaymentRequired,
): McpToolResult {
  try {
    return serverResponseToMcpResult(response, fallbackPaymentRequired);
  } catch {
    const paymentResponseHeader = response.headers[PAYMENT_RESPONSE_HEADER];
    if (paymentResponseHeader) {
      try {
        return withMcpPaymentResponse(
          mcpErrorResult("invalid_payload"),
          decodePaymentResponseHeader(paymentResponseHeader),
        );
      } catch {
        // The header itself was invalid, so no trustworthy settlement exists.
      }
    }
    return mcpErrorResult("invalid_payload");
  }
}

function serverResponseToMcpResult(
  response: ServerResponse,
  fallbackPaymentRequired?: PaymentRequired,
): McpToolResult {
  assertJsonResourceBudget(response.body ?? null, {
    label: "MCP server response body",
  });
  const paymentResponseHeader = response.headers[PAYMENT_RESPONSE_HEADER];
  const settlement = paymentResponseHeader
    ? decodePaymentResponseHeader(paymentResponseHeader)
    : undefined;
  if (settlement && !settlement.success) {
    const paymentRequiredHeader = response.headers[PAYMENT_REQUIRED_HEADER];
    const challenge = paymentRequiredHeader
      ? decodePaymentRequiredHeader(paymentRequiredHeader)
      : fallbackPaymentRequired;
    if (challenge) return mcpSettlementFailureResult(challenge, settlement);
    return withMcpPaymentResponse(
      mcpErrorResult(settlement.errorReason ?? "Settlement failed"),
      settlement,
    );
  }

  const paymentRequiredHeader = response.headers[PAYMENT_REQUIRED_HEADER];
  if (paymentRequiredHeader) {
    return mcpPaymentRequiredResult(
      decodePaymentRequiredHeader(paymentRequiredHeader),
    );
  }

  if (response.status >= 400) {
    return settlement
      ? withMcpPaymentResponse(
          mcpErrorResult(errorMessageFromBody(response.body)),
          settlement,
        )
      : mcpErrorResult(errorMessageFromBody(response.body));
  }

  const result = isMcpToolResult(response.body)
    ? response.body
    : mcpTextResult(response.body);
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
  return (
    isRecord(value) &&
    ("content" in value ||
      "structuredContent" in value ||
      "isError" in value ||
      "_meta" in value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
