import { U64_DECIMAL_PATTERN, U64_MAX } from "./constants.js";
import { KaspaX402Error } from "./errors.js";
import type { SompiString } from "./types.js";

export function isDecimalSompi(value: unknown): value is SompiString {
  return typeof value === "string" && U64_DECIMAL_PATTERN.test(value);
}

export function parseSompiString(value: unknown): bigint {
  if (!isDecimalSompi(value)) {
    throw new KaspaX402Error("invalid_kaspa_x402_amount", "amount must be a canonical uint64 decimal sompi string");
  }
  return BigInt(value);
}

export function formatSompiString(value: bigint | number | string): SompiString {
  const normalized =
    typeof value === "bigint"
      ? value
      : typeof value === "number"
        ? numberToBigInt(value)
        : parseSompiString(value);

  if (normalized < 0n || normalized > U64_MAX) {
    throw new KaspaX402Error("invalid_kaspa_x402_amount", "amount is outside uint64 range");
  }

  return normalized.toString();
}

function numberToBigInt(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new KaspaX402Error("invalid_kaspa_x402_amount", "number amount must be a non-negative safe integer");
  }
  return BigInt(value);
}
