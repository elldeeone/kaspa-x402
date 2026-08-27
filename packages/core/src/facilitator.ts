import { X402_VERSION } from "./constants.js";
import type {
  Hash32Hex,
  JsonRecord,
  NetworkId,
  PaymentPayload,
  PaymentRequirements,
  PaymentScheme,
  ResourceInfo,
  SettlementResponse,
} from "./types.js";

export interface SupportedKind extends JsonRecord {
  x402Version: typeof X402_VERSION;
  scheme: PaymentScheme;
  network: NetworkId;
  extra?: JsonRecord;
}

export interface SupportedResponse extends JsonRecord {
  kinds: SupportedKind[];
  extensions: string[];
  signers: Record<string, string[]>;
}

export interface FacilitatorRequest extends JsonRecord {
  x402Version: typeof X402_VERSION;
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
  resource?: ResourceInfo;
  requestHash: Hash32Hex;
  extensions?: JsonRecord;
}

export type VerifyRequest = FacilitatorRequest;
export type SettleRequest = FacilitatorRequest;

export interface VerifyResponse extends JsonRecord {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
  extra?: JsonRecord;
}

export type SettleResponse = SettlementResponse;

export function isFacilitatorRequest(
  value: unknown,
): value is FacilitatorRequest {
  if (!isRecord(value)) return false;
  const record = value as {
    x402Version?: unknown;
    paymentPayload?: unknown;
    paymentRequirements?: unknown;
  };
  const requestHash = recordWithRequestHash(value).requestHash;
  return (
    record.x402Version === X402_VERSION &&
    isRecord(record.paymentPayload) &&
    isRecord(record.paymentRequirements) &&
    isHash32Hex(requestHash)
  );
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recordWithRequestHash(value: unknown): { requestHash?: unknown } {
  return value as { requestHash?: unknown };
}

function isHash32Hex(value: unknown): boolean {
  return typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value);
}
