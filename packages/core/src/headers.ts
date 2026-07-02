import { KaspaX402Error } from "./errors.js";
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
  const result = validate(value);
  if (!result.ok) throw result.error;
  try {
    return Buffer.from(stableStringify(value), "utf8").toString("base64");
  } catch (error) {
    throw new KaspaX402Error("invalid_kaspa_x402_payload", "header value must be JSON-serializable", error);
  }
}

function decodeHeader<T>(value: string, validate: (value: unknown) => { ok: true; value: T } | { ok: false; error: Error }): T {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch (error) {
    throw new KaspaX402Error("invalid_kaspa_x402_payload", "header must contain base64-encoded JSON", error);
  }

  const result = validate(decoded);
  if (!result.ok) throw result.error;
  return result.value;
}
