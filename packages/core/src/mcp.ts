import { X402_VERSION } from "./constants.js";
import { KaspaX402Error } from "./errors.js";
import { sha256Hex } from "./binary.js";
import {
  normalizePaymentRequirementsHex,
  paymentReplayIdentityHash,
} from "./replay-identity.js";
import {
  KASPA_X402_RESOURCE_BUDGET,
  assertDecodedByteBudget,
  assertJsonResourceBudget,
  utf8ByteLength,
} from "./resource-budget.js";
import {
  trustedSecurityContextHash,
  type TrustedSecurityContext,
} from "./security-context.js";
import { validatePaymentPayload, validatePaymentRequiredEnvelope, validateSettlementResponse } from "./schema-validation.js";
import { stableStringify } from "./stable-json.js";
import type {
  Hash32Hex,
  JsonRecord,
  PaymentPayload,
  PaymentRequired,
  PaymentRequiredEnvelope,
  PaymentRequirements,
  ResourceInfo,
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
  /** Authenticated, operator-configured identity of the intended MCP server. */
  audience: string;
  toolName: string;
  arguments?: unknown;
  accepted: PaymentRequirements;
  /** Exact challenged resource. Defaults only to the tool-derived resource. */
  resource?: ResourceInfo;
  /** Normalized host-derived claims, never raw authorization headers. */
  trustedSecurityContext?: TrustedSecurityContext;
}

export interface McpToolPaymentFingerprintInput extends McpToolCallFingerprintInput {
  paymentPayload: PaymentPayload;
}

export function mcpToolResource(
  input: McpToolResourceInput,
): PaymentRequired["resource"] {
  assertJsonResourceBudget(input, { label: "MCP tool resource input" });
  const resource = {
    url: `mcp://tool/${encodeURIComponent(input.name)}`,
    ...(input.description ? { description: input.description } : {}),
    ...(input.mimeType ? { mimeType: input.mimeType } : {}),
  };
  assertJsonResourceBudget(resource, { label: "MCP tool resource" });
  return resource;
}

export function mcpToolCallFingerprint(
  input: McpToolCallFingerprintInput,
): Hash32Hex {
  if (
    typeof input.audience !== "string" ||
    input.audience.length === 0 ||
    utf8ByteLength(input.audience) >
      KASPA_X402_RESOURCE_BUDGET.maxMcpAudienceBytes
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      `MCP payment audience must be a non-empty string of at most ${KASPA_X402_RESOURCE_BUDGET.maxMcpAudienceBytes} bytes`,
    );
  }
  if (
    typeof input.toolName !== "string" ||
    input.toolName.length === 0 ||
    utf8ByteLength(input.toolName) >
      KASPA_X402_RESOURCE_BUDGET.maxMcpToolNameBytes
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      `MCP tool name must be a non-empty string of at most ${KASPA_X402_RESOURCE_BUDGET.maxMcpToolNameBytes} bytes`,
    );
  }
  const resource = canonicalMcpResource(
    input.resource ?? mcpToolResource({ name: input.toolName }),
  );
  assertJsonResourceBudget(
    {
      audience: input.audience,
      toolName: input.toolName,
      arguments: input.arguments ?? null,
      accepted: input.accepted,
      resource,
      ...(input.trustedSecurityContext
        ? { trustedSecurityContext: input.trustedSecurityContext }
        : {}),
    },
    { label: "MCP tool call" },
  );
  const accepted = normalizePaymentRequirementsHex(input.accepted);
  return sha256Hex(
    stableStringify({
      scope: "kaspa:x402:mcp-tool-call:v3",
      audience: input.audience,
      toolName: input.toolName,
      arguments: input.arguments ?? null,
      paymentRequirementsHash: sha256Hex(stableStringify(accepted)),
      resource,
      securityContextHash: input.trustedSecurityContext
        ? trustedSecurityContextHash(input.trustedSecurityContext)
        : null,
    }),
  );
}

export function mcpToolPaymentFingerprint(
  input: McpToolPaymentFingerprintInput,
): Hash32Hex {
  return sha256Hex(
    stableStringify({
      scope: "kaspa:x402:mcp-tool-payment:v1",
      toolCallFingerprint: mcpToolCallFingerprint(input),
      paymentIdentity: paymentReplayIdentityHash(input.paymentPayload),
    }),
  );
}

export function mcpPaymentRequiredResult(paymentRequired: PaymentRequired): McpToolResult {
  assertJsonResourceBudget(paymentRequired, {
    label: "MCP payment requirements",
  });
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

export function mcpSettlementFailureResult(paymentRequired: PaymentRequired, settlement: SettlementResponse): McpToolResult {
  const error = settlement.errorReason ?? paymentRequired.error ?? "unexpected_settle_error";
  return withMcpPaymentResponse(mcpPaymentRequiredResult({ ...paymentRequired, error }), settlement);
}

export function readMcpPaymentRequired(result: McpToolResult): PaymentRequiredEnvelope | undefined {
  if (result.isError !== true) return undefined;
  const structured = readPaymentRequiredCandidate(result.structuredContent);
  if (structured) return structured;
  const text = result.content?.[0]?.text;
  if (typeof text !== "string") return undefined;
  assertDecodedByteBudget(text, "MCP payment text fallback");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return readPaymentRequiredCandidate(parsed);
}

export function readMcpPaymentPayload(params: McpToolCallParams): PaymentPayload | undefined {
  assertJsonResourceBudget(params, { label: "MCP tool call parameters" });
  const value = params._meta?.[MCP_PAYMENT_META_KEY];
  if (value === undefined) return undefined;
  const result = validatePaymentPayload(value);
  if (!result.ok) throw result.error;
  return result.value;
}

export function withMcpPaymentPayload(params: McpToolCallParams, paymentPayload: PaymentPayload): McpToolCallParams {
  assertJsonResourceBudget(params, { label: "MCP tool call parameters" });
  const result = {
    ...params,
    _meta: {
      ...(params._meta ?? {}),
      [MCP_PAYMENT_META_KEY]: paymentPayload,
    },
  };
  assertJsonResourceBudget(result, { label: "paid MCP tool call parameters" });
  return result;
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

export function canonicalMcpResource(resource: ResourceInfo): ResourceInfo {
  assertJsonResourceBudget(resource, { label: "MCP ResourceInfo" });
  if (typeof resource.url !== "string" || resource.url.length === 0) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      "MCP ResourceInfo must include a non-empty URL",
    );
  }
  if (
    resource.description !== undefined &&
    typeof resource.description !== "string"
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      "MCP ResourceInfo description must be a string",
    );
  }
  if (resource.mimeType !== undefined && typeof resource.mimeType !== "string") {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      "MCP ResourceInfo mimeType must be a string",
    );
  }
  return JSON.parse(stableStringify(resource)) as ResourceInfo;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
