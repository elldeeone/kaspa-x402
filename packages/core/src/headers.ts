import { KaspaX402Error } from "./errors.js";
import { stableStringify } from "./stable-json.js";
import type { PaymentPayload, PaymentRequired, PaymentRequiredEnvelope, SettlementResponse } from "./types.js";
import {
  validatePaymentPayload,
  validatePaymentRequired,
  validatePaymentRequiredEnvelope,
  validateSettlementResponse,
} from "./schema-validation.js";

const MAX_PAYMENT_HEADER_BYTES = 256 * 1_024;

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
    if (Buffer.byteLength(value, "utf8") > MAX_PAYMENT_HEADER_BYTES)
      throw new RangeError("encoded payment header exceeds the byte limit");
    const bytes = Buffer.from(value, "base64");
    if (bytes.byteLength > MAX_PAYMENT_HEADER_BYTES)
      throw new RangeError("decoded payment header exceeds the byte limit");
    decoded = JSON.parse(bytes.toString("utf8"));
    stableStringify(decoded, {
      maxDepth: 32,
      maxNodes: 16_384,
      maxObjectKeys: 1_024,
      maxOutputBytes: MAX_PAYMENT_HEADER_BYTES,
    });
  } catch (error) {
    throw new KaspaX402Error("invalid_kaspa_x402_payload", "header must contain base64-encoded JSON", error);
  }

  const result = validate(decoded);
  if (!result.ok) throw result.error;
  return result.value;
}
