import {
  encodePaymentRequiredEnvelopeHeader,
  mcpToolCallFingerprint,
  readMcpPaymentRequired,
  readMcpPaymentResponse,
  withMcpPaymentPayload,
  type Hash32Hex,
  type McpToolCallParams,
  type McpToolResult,
} from "@kaspa-x402/core";
import { KaspaX402Error } from "@kaspa-x402/core";
import { DirectModeClient } from "./direct-client.js";
import type { ApplySettlementResult, CreatePaymentResult } from "./types.js";

export type McpToolCaller = (
  params: McpToolCallParams,
) => Promise<McpToolResult> | McpToolResult;

export interface PaidMcpToolCallOptions {
  /** Authenticated MCP server identity approved by the payer. */
  audience: string;
  paymentIdentifier?: string;
  requestHash?: Hash32Hex;
  origin?: string;
  maxPaymentRetries?: number;
}

export interface PaidMcpToolCallResult {
  result: McpToolResult;
  payment?: CreatePaymentResult;
  settlement?: ApplySettlementResult;
}

export async function paidMcpToolCall(
  client: DirectModeClient,
  callTool: McpToolCaller,
  params: McpToolCallParams,
  options: PaidMcpToolCallOptions,
): Promise<PaidMcpToolCallResult> {
  if (
    options.maxPaymentRetries !== undefined &&
    options.maxPaymentRetries !== 0
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      "automatic corrective MCP payment retries are disabled; authorize a new payment explicitly",
    );
  }
  const firstResult = await callTool(params);
  const paymentRequired = readMcpPaymentRequired(firstResult);
  if (!paymentRequired) return { result: firstResult };

  const header = encodePaymentRequiredEnvelopeHeader(paymentRequired);
  const parsed = client.selectPaymentRequirement(header);
  const requestHash =
    options.requestHash ??
    mcpToolCallFingerprint({
      audience: options.audience,
      toolName: params.name,
      arguments: params.arguments,
      accepted: parsed.accepted,
    });
  const payment = await client.createPayment(header, {
    url: paymentRequired.resource.url,
    origin: options.origin ?? options.audience,
    paymentIdentifier: options.paymentIdentifier,
    requestHash,
  });
  const retryResult = await callTool(
    withMcpPaymentPayload(params, payment.paymentPayload),
  );
  const settlementResponse = readMcpPaymentResponse(retryResult);
  if (settlementResponse) {
    const settlement = await client.applySettlement(
      payment,
      settlementResponse,
    );
    return {
      result: retryResult,
      payment,
      settlement,
    };
  }

  const corrective = readMcpPaymentRequired(retryResult);
  if (retryResult.isError && corrective) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      "corrective MCP payment requirements need a new explicit payment authorization",
    );
  }

  throw new KaspaX402Error(
    "invalid_kaspa_settlement_response",
    "paid MCP tool result is missing x402 payment response metadata",
  );
}
