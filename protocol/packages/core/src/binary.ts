import crypto from "node:crypto";
import { HEX_BYTE_PATTERN, U32_MAX, U64_MAX } from "./constants.js";
import { KaspaX402Error, type KaspaX402ErrorCode } from "./errors.js";
import { parseSompiString } from "./amount.js";

export type HexToBytesOptions = {
  expectedLength?: number;
  errorCode?: KaspaX402ErrorCode;
  label?: string;
};

export function hexToBytes(hex: unknown, options: HexToBytesOptions = {}): Uint8Array {
  const errorCode = options.errorCode ?? "invalid_kaspa_hex";
  const label = options.label ?? "hex";
  if (typeof hex !== "string" || !HEX_BYTE_PATTERN.test(hex)) {
    throw new KaspaX402Error(errorCode, `${label} must be an even-length hex byte string`);
  }
  if (options.expectedLength !== undefined && hex.length !== options.expectedLength * 2) {
    throw new KaspaX402Error(errorCode, `${label} must be ${options.expectedLength} bytes`);
  }
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function utf8Bytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "utf8"));
}

export function sha256(value: Uint8Array | string): Uint8Array {
  const input = typeof value === "string" ? utf8Bytes(value) : value;
  return Uint8Array.from(crypto.createHash("sha256").update(input).digest());
}

export function sha256Hex(value: Uint8Array | string): string {
  return bytesToHex(sha256(value));
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

export function le32(value: unknown, errorCode: KaspaX402ErrorCode = "invalid_kaspa_outpoint"): Uint8Array {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > U32_MAX) {
    throw new KaspaX402Error(errorCode, "value must fit in uint32");
  }
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(Number(value));
  return Uint8Array.from(buffer);
}

export function le64(value: bigint | number | string): Uint8Array {
  const normalized = normalizeUint64(value);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(normalized);
  return Uint8Array.from(buffer);
}

export function normalizeUint64(value: bigint | number | string): bigint {
  const normalized =
    typeof value === "bigint"
      ? value
      : typeof value === "number"
        ? numberToUint64(value)
        : parseSompiString(value);

  if (normalized < 0n || normalized > U64_MAX) {
    throw new KaspaX402Error("invalid_kaspa_x402_amount", "value must fit in uint64");
  }

  return normalized;
}

function numberToUint64(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new KaspaX402Error("invalid_kaspa_x402_amount", "number must be a non-negative safe integer");
  }
  return BigInt(value);
}
