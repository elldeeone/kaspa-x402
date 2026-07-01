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
  | "invalid_kaspa_upto_authorization"
  | "invalid_kaspa_upto_expired"
  | "invalid_kaspa_upto_recipient"
  | "invalid_kaspa_upto_max_amount"
  | "invalid_kaspa_upto_replay"
  | "invalid_kaspa_upto_settlement_amount"
  | "invalid_kaspa_upto_authorization_outpoint"
  | "invalid_kaspa_upto_template";

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
