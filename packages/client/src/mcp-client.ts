import {
  assertJsonResourceBudget,
  encodePaymentRequiredEnvelopeHeader,
  mcpToolCallFingerprint,
  readMcpPaymentRequired,
  readMcpPaymentResponse,
  withMcpPaymentPayload,
  type Hash32Hex,
  type McpToolCallParams,
  type McpToolResult,
  type TrustedSecurityContext,
} from "@kaspa-x402/core";
import { KaspaX402Error } from "@kaspa-x402/core";
import { DirectModeClient, PendingExactPaymentError } from "./direct-client.js";
import type { ApplySettlementResult, CreatePaymentResult } from "./types.js";

export type McpToolCaller = (
  params: McpToolCallParams,
) => Promise<McpToolResult> | McpToolResult;

export interface PaidMcpToolCallOptions {
  /** Authenticated MCP server identity approved by the payer. */
  audience: string;
  paymentIdentifier?: string;
  /** Optional assertion of the attempt ID derived from paymentIdentifier. */
  paymentAttemptId?: Hash32Hex;
  requestHash?: Hash32Hex;
  origin?: string;
  /** Host-derived normalized claims, never raw credentials. */
  trustedSecurityContext?: TrustedSecurityContext;
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
  assertJsonResourceBudget(params, { label: "MCP tool call parameters" });
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
      resource: paymentRequired.resource,
      trustedSecurityContext: options.trustedSecurityContext,
    });
  const payment = await client.createPayment(header, {
    url: paymentRequired.resource.url,
    origin: options.origin ?? options.audience,
    paymentIdentifier: options.paymentIdentifier,
    paymentAttemptId: options.paymentAttemptId,
    requestHash,
    trustedSecurityContext: options.trustedSecurityContext,
  });
  try {
    const retryResult = await callTool(
      withMcpPaymentPayload(params, payment.paymentPayload),
    );
    const settlementResponse = readMcpPaymentResponse(retryResult);
    if (settlementResponse) {
      if (
        retryResult.isError &&
        payment.accepted.scheme === "batch-settlement" &&
        settlementResponse.success &&
        (payment.accepted.extra.mcpErrorChargeSompi !==
          payment.accepted.amount ||
          settlementResponse.amount !== payment.accepted.amount)
      ) {
        throw new KaspaX402Error(
          "invalid_kaspa_settlement_response",
          "unexpected MCP error result carried a non-approved batch charge",
        );
      }
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
  } catch (error) {
    await client.quarantineDisclosedPayment(payment);
    throw payment.scheme === "exact"
      ? new PendingExactPaymentError(payment, error)
      : error;
  }
}
