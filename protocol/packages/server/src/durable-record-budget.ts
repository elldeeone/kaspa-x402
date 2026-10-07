import { KASPA_X402_RESOURCE_BUDGET } from "@kaspa-x402/core";

export const MAX_DURABLE_HANDLER_RESULT_BYTES = 256 * 1024;
const MAX_DURABLE_RESPONSE_BYTES =
  MAX_DURABLE_HANDLER_RESULT_BYTES +
  KASPA_X402_RESOURCE_BUDGET.maxEncodedHeaderBytes +
  1024;

export function durableByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function durableOpenRecordBytes(value: unknown): number {
  // Replay state caches the response in the payment or commitment and the
  // identifier. Reserve both copies before protected work starts.
  return durableByteLength(value) + 2 * MAX_DURABLE_RESPONSE_BYTES;
}
