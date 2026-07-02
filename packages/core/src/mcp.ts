import { X402_VERSION } from "./constants.js";
import { KaspaX402Error } from "./errors.js";
import { sha256Hex } from "./binary.js";
import { validatePaymentPayload, validatePaymentRequiredEnvelope, validateSettlementResponse } from "./schema-validation.js";
import { stableStringify } from "./stable-json.js";
import type {
  Hash32Hex,
  JsonRecord,
  PaymentPayload,
  PaymentRequired,
  PaymentRequiredEnvelope,
  PaymentRequirements,
  SettlementResponse,
} from "./types.js";

export const MCP_PAYMENT_META_KEY = "x402/payment";
export const MCP_PAYMENT_RESPONSE_META_KEY = "x402/payment-response";

export interface McpTextContent extends JsonRecord {
  type: "text";
  text: string;
}

export interface McpToolResult extends JsonRecord {
  isError?: boolean;
  structuredContent?: unknown;
  content?: McpTextContent[];
  _meta?: JsonRecord;
}

export interface McpToolCallParams extends JsonRecord {
  name: string;
  arguments?: unknown;
  _meta?: JsonRecord;
}

export interface McpToolResourceInput {
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpToolCallFingerprintInput {
  toolName: string;
  arguments?: unknown;
  accepted: PaymentRequirements;
}

export interface McpToolPaymentFingerprintInput extends McpToolCallFingerprintInput {
  paymentPayload: PaymentPayload;
}

export function mcpToolResource(input: McpToolResourceInput): PaymentRequired["resource"] {
  return {
    url: `mcp://tool/${encodeURIComponent(input.name)}`,
    ...(input.description ? { description: input.description } : {}),
    ...(input.mimeType ? { mimeType: input.mimeType } : {}),
  };
}

export function mcpToolCallFingerprint(input: McpToolCallFingerprintInput): Hash32Hex {
  return sha256Hex(
    stableStringify({
      scope: "kaspa:x402:mcp-tool-call:v1",
      toolName: input.toolName,
      arguments: input.arguments ?? null,
      paymentRequirementsHash: sha256Hex(stableStringify(input.accepted)),
    }),
  );
}

export function mcpToolPaymentFingerprint(input: McpToolPaymentFingerprintInput): Hash32Hex {
  return sha256Hex(
    stableStringify({
      scope: "kaspa:x402:mcp-tool-payment:v1",
      toolCallFingerprint: mcpToolCallFingerprint(input),
      paymentIdentity: mcpPaymentIdentity(input.paymentPayload),
    }),
  );
}

export function mcpPaymentRequiredResult(paymentRequired: PaymentRequired): McpToolResult {
  return {
    isError: true,
    structuredContent: paymentRequired,
    content: [
      {
        type: "text",
        text: JSON.stringify(paymentRequired),
      },
    ],
  };
}

export function readMcpPaymentRequired(result: McpToolResult): PaymentRequiredEnvelope | undefined {
  if (result.isError !== true) return undefined;
  const structured = readPaymentRequiredCandidate(result.structuredContent);
  if (structured) return structured;
  const text = result.content?.[0]?.text;
  if (typeof text !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return readPaymentRequiredCandidate(parsed);
}

export function readMcpPaymentPayload(params: McpToolCallParams): PaymentPayload | undefined {
  const value = params._meta?.[MCP_PAYMENT_META_KEY];
  if (value === undefined) return undefined;
  const result = validatePaymentPayload(value);
  if (!result.ok) throw result.error;
  return result.value;
}

export function withMcpPaymentPayload(params: McpToolCallParams, paymentPayload: PaymentPayload): McpToolCallParams {
  return {
    ...params,
    _meta: {
      ...(params._meta ?? {}),
      [MCP_PAYMENT_META_KEY]: paymentPayload,
    },
  };
}

export function readMcpPaymentResponse(result: McpToolResult): SettlementResponse | undefined {
  const value = result._meta?.[MCP_PAYMENT_RESPONSE_META_KEY];
  if (value === undefined) return undefined;
  const validation = validateSettlementResponse(value);
  if (!validation.ok) throw validation.error;
  return validation.value;
}

export function withMcpPaymentResponse(result: McpToolResult, settlement: SettlementResponse): McpToolResult {
  return {
    ...result,
    _meta: {
      ...(result._meta ?? {}),
      [MCP_PAYMENT_RESPONSE_META_KEY]: settlement,
    },
  };
}

function readPaymentRequiredCandidate(value: unknown): PaymentRequiredEnvelope | undefined {
  if (!isRecord(value) || value.x402Version !== X402_VERSION || !Array.isArray(value.accepts)) return undefined;
  const result = validatePaymentRequiredEnvelope(value);
  if (!result.ok) throw result.error;
  return result.value;
}

function mcpPaymentIdentity(paymentPayload: PaymentPayload): JsonRecord {
  const payload = paymentPayload.payload;
  switch (payload.type) {
    case "exact-transfer":
      return {
        scheme: paymentPayload.accepted.scheme,
        ...(payload.transactionId ? { transactionId: payload.transactionId } : { transactionHash: sha256Hex(payload.transaction) }),
        paymentOutputIndex: payload.paymentOutputIndex,
      };
    case "deposit-voucher":
      return {
        scheme: paymentPayload.accepted.scheme,
        channelId: payload.channelId,
        voucherAmount: payload.voucher.amount,
        payloadType: payload.type,
      };
    case "voucher":
      return {
        scheme: paymentPayload.accepted.scheme,
        channelId: payload.channelId,
        voucherAmount: payload.voucher.amount,
        payloadType: payload.type,
      };
    case "claim":
      return {
        scheme: paymentPayload.accepted.scheme,
        channelId: payload.channelId,
        voucherAmount: payload.voucher.amount,
        payloadType: payload.type,
      };
    case "refund":
      return {
        scheme: paymentPayload.accepted.scheme,
        channelId: payload.channelId,
        payloadType: payload.type,
      };
    default:
      throw new KaspaX402Error("invalid_kaspa_payment_payload_type", "unsupported MCP payment payload type");
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
