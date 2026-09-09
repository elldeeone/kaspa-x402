import { KaspaX402Error } from "./errors.js";
import {
  assertDecodedByteBudget,
  assertEncodedHeaderBudget,
  assertJsonResourceBudget,
} from "./resource-budget.js";
import { stableStringify } from "./stable-json.js";
import type { PaymentPayload, PaymentRequired, PaymentRequiredEnvelope, SettlementResponse } from "./types.js";
import {
  validatePaymentPayload,
  validatePaymentRequired,
  validatePaymentRequiredEnvelope,
  validateSettlementResponse,
} from "./schema-validation.js";

export function encodePaymentRequiredHeader(value: PaymentRequired): string {
  return encodeHeader(value, validatePaymentRequired);
}

export function decodePaymentRequiredHeader(value: string): PaymentRequired {
  return decodeHeader(value, validatePaymentRequired);
}

export function encodePaymentRequiredEnvelopeHeader(value: PaymentRequiredEnvelope): string {
  return encodeHeader(value, validatePaymentRequiredEnvelope);
}

export function decodePaymentRequiredEnvelopeHeader(value: string): PaymentRequiredEnvelope {
  return decodeHeader(value, validatePaymentRequiredEnvelope);
}

export function encodePaymentSignatureHeader(value: PaymentPayload): string {
  return encodeHeader(value, validatePaymentPayload);
}

export function decodePaymentSignatureHeader(value: string): PaymentPayload {
  return decodeHeader(value, validatePaymentPayload);
}

export function encodePaymentResponseHeader(value: SettlementResponse): string {
  return encodeHeader(value, validateSettlementResponse);
}

export function decodePaymentResponseHeader(value: string): SettlementResponse {
  return decodeHeader(value, validateSettlementResponse);
}

function encodeHeader<T>(value: T, validate: (value: unknown) => { ok: true; value: T } | { ok: false; error: Error }): string {
  assertJsonResourceBudget(value, { label: "header value" });
  const result = validate(value);
  if (!result.ok) throw result.error;
  try {
    return Buffer.from(stableStringify(value), "utf8").toString("base64");
  } catch (error) {
    throw new KaspaX402Error("invalid_kaspa_x402_payload", "header value must be JSON-serializable", error);
  }
}

function decodeHeader<T>(value: string, validate: (value: unknown) => { ok: true; value: T } | { ok: false; error: Error }): T {
  const decoded = decodeBoundedJsonHeader(value);

  const result = validate(decoded);
  if (!result.ok) throw result.error;
  return result.value;
}

/** Bounded discriminator decoder for hosts that must inspect foreign schemes. */
export function decodeBoundedJsonHeader(value: string): unknown {
  assertEncodedHeaderBudget(value);
  let decoded: unknown;
  try {
    const bytes = Buffer.from(value, "base64");
    assertDecodedByteBudget(bytes, "header");
    decoded = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof KaspaX402Error) throw error;
    throw new KaspaX402Error("invalid_kaspa_x402_payload", "header must contain base64-encoded JSON", error);
  }
  assertJsonResourceBudget(decoded, { label: "decoded header" });
  return decoded;
}
