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
import { parsePaymentRequiredHeaderValue } from "./payment-required.js";
import type { ApplySettlementResult, CreatePaymentResult } from "./types.js";

export type McpToolCaller = (params: McpToolCallParams) => Promise<McpToolResult> | McpToolResult;

export interface PaidMcpToolCallOptions {
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
  options: PaidMcpToolCallOptions = {},
): Promise<PaidMcpToolCallResult> {
  const firstResult = await callTool(params);
  let paymentRequired = readMcpPaymentRequired(firstResult);
  if (!paymentRequired) return { result: firstResult };

  const maxPaymentRetries = options.maxPaymentRetries ?? 2;
  for (let attempt = 0; attempt <= maxPaymentRetries; attempt += 1) {
    const header = encodePaymentRequiredEnvelopeHeader(paymentRequired);
    const parsed = parsePaymentRequiredHeaderValue(header, {
      supportedNetworks: client.supportedNetworks(),
      supportedSchemes: client.supportedSchemes(),
    });
    const requestHash =
      options.requestHash ??
      mcpToolCallFingerprint({
        toolName: params.name,
        arguments: params.arguments,
        accepted: parsed.accepted,
      });
    const payment = await client.createPayment(header, {
      url: paymentRequired.resource.url,
      origin: options.origin ?? `mcp://tool/${params.name}`,
      paymentIdentifier: options.paymentIdentifier,
      requestHash,
    });
    const retryResult = await callTool(withMcpPaymentPayload(params, payment.paymentPayload));
    const settlementResponse = readMcpPaymentResponse(retryResult);
    if (settlementResponse) {
      const settlement = await client.applySettlement(payment, settlementResponse);
      return {
        result: retryResult,
        payment,
        settlement,
      };
    }

    const corrective = readMcpPaymentRequired(retryResult);
    if (retryResult.isError && corrective) {
      paymentRequired = corrective;
      continue;
    }

    throw new KaspaX402Error("invalid_kaspa_settlement_response", "paid MCP tool result is missing x402 payment response metadata");
  }

  throw new KaspaX402Error("invalid_kaspa_x402_payload", "too many corrective MCP payment retries");
}
