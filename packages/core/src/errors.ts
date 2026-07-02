export type KaspaX402ErrorCode =
  | "invalid_kaspa_x402_version"
  | "invalid_kaspa_x402_scheme"
  | "invalid_kaspa_x402_network"
  | "invalid_kaspa_x402_asset"
  | "invalid_kaspa_x402_amount"
  | "invalid_kaspa_x402_binding"
  | "invalid_kaspa_x402_payload"
  | "invalid_kaspa_x402_accepted"
  | "invalid_kaspa_payment_payload_type"
  | "invalid_kaspa_public_key"
  | "invalid_kaspa_outpoint"
  | "invalid_kaspa_signature"
  | "invalid_kaspa_settlement_response"
  | "invalid_kaspa_transaction"
  | "invalid_kaspa_hex"
  | "invalid_kaspa_channel_id"
  | "invalid_kaspa_payment_identifier"
  | "missing_kaspa_payment_identifier"
  | "kaspa_payment_identifier_conflict"
  | "invalid_kaspa_exact_replay";

export class KaspaX402Error extends Error {
  readonly code: KaspaX402ErrorCode;
  readonly details?: unknown;

  constructor(code: KaspaX402ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "KaspaX402Error";
    this.code = code;
    this.details = details;
  }
}

export type ValidationSuccess<T> = {
  ok: true;
  value: T;
};

export type ValidationFailure = {
  ok: false;
  error: KaspaX402Error;
};

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

export function ok<T>(value: T): ValidationSuccess<T> {
  return { ok: true, value };
}

export function fail<T = never>(code: KaspaX402ErrorCode, message: string, details?: unknown): ValidationResult<T> {
  return { ok: false, error: new KaspaX402Error(code, message, details) };
}

export function throwValidation(result: ValidationFailure): never {
  throw result.error;
}

export function toX402ErrorReason(reason: string | undefined): string {
  switch (reason) {
    case "invalid_kaspa_x402_version":
      return "invalid_x402_version";
    case "invalid_kaspa_x402_scheme":
      return "invalid_scheme";
    case "invalid_kaspa_x402_network":
      return "invalid_network";
    case "invalid_kaspa_x402_asset":
    case "invalid_kaspa_x402_amount":
    case "invalid_kaspa_x402_binding":
    case "invalid_kaspa_x402_accepted":
      return "invalid_payment_requirements";
    case "invalid_kaspa_x402_payload":
    case "invalid_kaspa_payment_payload_type":
    case "invalid_kaspa_public_key":
    case "invalid_kaspa_signature":
    case "invalid_kaspa_hex":
    case "invalid_kaspa_payment_identifier":
    case "missing_kaspa_payment_identifier":
      return "invalid_payload";
    case "invalid_kaspa_settlement_response":
    case "invalid_kaspa_transaction":
    case "invalid_kaspa_outpoint":
    case "invalid_kaspa_channel_id":
    case "kaspa_payment_identifier_conflict":
    case "payment_identifier_conflict":
    case "exact_payment_replay":
    case "invalid_kaspa_exact_replay":
      return "invalid_transaction_state";
    case "unsupported_scheme":
      return "unsupported_scheme";
    case "unsupported_kaspa_facilitator_action":
      return "unsupported_scheme";
    default:
      return "unexpected_settle_error";
  }
}

export function toX402ErrorReasonFromError(error: unknown, fallback = "unexpected_settle_error"): string {
  if (error instanceof KaspaX402Error) return toX402ErrorReason(error.code);
  return fallback;
}
