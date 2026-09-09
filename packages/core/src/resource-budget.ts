import { KaspaX402Error, type KaspaX402ErrorCode } from "./errors.js";

export interface ResourceBudgetProfile {
  readonly version: "kaspa-x402-resource-budget-v1";
  readonly maxEncodedHeaderBytes: number;
  readonly maxDecodedHeaderBytes: number;
  readonly maxStringBytes: number;
  readonly maxArtifactBytes: number;
  readonly maxArrayItems: number;
  readonly maxObjectProperties: number;
  readonly maxAccepts: number;
  readonly maxExtensionProperties: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxCanonicalBytes: number;
  readonly maxValidationWork: number;
  readonly maxMcpAudienceBytes: number;
  readonly maxMcpToolNameBytes: number;
}

/**
 * Alpha.11's single structural admission profile. Embedding transports must
 * enforce these limits or stricter limits before materializing request data.
 */
export const KASPA_X402_RESOURCE_BUDGET: ResourceBudgetProfile =
  Object.freeze({
    version: "kaspa-x402-resource-budget-v1",
    maxEncodedHeaderBytes: 131_072,
    maxDecodedHeaderBytes: 98_304,
    maxStringBytes: 16_384,
    maxArtifactBytes: 65_536,
    maxArrayItems: 256,
    maxObjectProperties: 128,
    maxAccepts: 16,
    maxExtensionProperties: 32,
    maxDepth: 32,
    maxNodes: 4_096,
    maxCanonicalBytes: 98_304,
    maxValidationWork: 8_191,
    maxMcpAudienceBytes: 2_048,
    maxMcpToolNameBytes: 1_024,
  });

export interface JsonResourceBudgetResult {
  nodes: number;
  work: number;
  canonicalBytes: number;
}

export interface JsonResourceBudgetOptions {
  label?: string;
  errorCode?: KaspaX402ErrorCode;
  profile?: ResourceBudgetProfile;
}

const ARTIFACT_FIELDS = new Set([
  "activeScriptPublicKey",
  "clientSignature",
  "fundingTransaction",
  "headRedeemScript",
  "headScriptPublicKey",
  "signature",
  "transaction",
]);

type PendingValue = {
  value: unknown;
  depth: number;
  field?: string;
  exit?: boolean;
};

/**
 * Performs a bounded, iterative pre-walk before AJV, custom schema walking,
 * canonicalisation, hashing, or adapter work. Accessors, cycles, and non-JSON
 * values are rejected so validation and later use observe ordinary data.
 */
export function assertJsonResourceBudget(
  root: unknown,
  options: JsonResourceBudgetOptions = {},
): JsonResourceBudgetResult {
  const profile = options.profile ?? KASPA_X402_RESOURCE_BUDGET;
  const label = options.label ?? "value";
  const errorCode = options.errorCode ?? "invalid_kaspa_x402_payload";
  const pending: PendingValue[] = [{ value: root, depth: 0 }];
  const active = new WeakSet<object>();
  let nodes = 0;
  let work = 0;
  let canonicalBytes = 0;

  const fail = (message: string): never => {
    throw new KaspaX402Error(errorCode, `${label} ${message}`);
  };
  const addWork = (amount = 1): void => {
    work += amount;
    if (work > profile.maxValidationWork)
      fail(`exceeds validation work limit ${profile.maxValidationWork}`);
  };
  const addCanonicalBytes = (amount: number): void => {
    canonicalBytes += amount;
    if (canonicalBytes > profile.maxCanonicalBytes)
      fail(`exceeds canonical JSON limit ${profile.maxCanonicalBytes} bytes`);
  };

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.exit) {
      active.delete(current.value as object);
      continue;
    }
    nodes += 1;
    addWork();
    if (nodes > profile.maxNodes)
      fail(`exceeds node limit ${profile.maxNodes}`);
    if (current.depth > profile.maxDepth)
      fail(`exceeds depth limit ${profile.maxDepth}`);

    const value = current.value;
    if (value === null) {
      addCanonicalBytes(4);
      continue;
    }
    if (typeof value === "string") {
      const byteLength = utf8ByteLength(value);
      const maximum =
        current.field && ARTIFACT_FIELDS.has(current.field)
          ? profile.maxArtifactBytes
          : profile.maxStringBytes;
      if (byteLength > maximum) {
        fail(
          `${current.field ?? "string"} exceeds string limit ${maximum} bytes`,
        );
      }
      addCanonicalBytes(utf8ByteLength(JSON.stringify(value)));
      continue;
    }
    if (typeof value === "boolean") {
      addCanonicalBytes(value ? 4 : 5);
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) fail("contains a non-finite number");
      addCanonicalBytes(utf8ByteLength(JSON.stringify(value)));
      continue;
    }
    if (typeof value !== "object") fail("is not JSON-serializable");

    const object = value as object;
    if (active.has(object)) fail("contains a cyclic object graph");
    active.add(object);
    pending.push({
      value,
      depth: current.depth,
      field: current.field,
      exit: true,
    });

    if (Array.isArray(value)) {
      const maximum =
        current.field === "accepts"
          ? profile.maxAccepts
          : profile.maxArrayItems;
      if (value.length > maximum) {
        fail(
          `${current.field ?? "array"} exceeds array limit ${maximum}`,
        );
      }
      addWork(value.length);
      addCanonicalBytes(2 + Math.max(0, value.length - 1));
      for (let index = value.length - 1; index >= 0; index -= 1) {
        if (!Object.hasOwn(value, index)) fail("contains a sparse array");
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        const descriptorValue =
          descriptor && "value" in descriptor
            ? descriptor.value
            : fail("contains an accessor property");
        pending.push({ value: descriptorValue, depth: current.depth + 1 });
      }
      continue;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      fail("is not JSON-serializable: only plain JSON objects are allowed");
    if (Object.getOwnPropertySymbols(value).length > 0)
      fail("contains symbol properties");

    const keys = Object.keys(value as Record<string, unknown>);
    const maximum =
      current.field === "extensions" || current.field === "_meta"
        ? profile.maxExtensionProperties
        : profile.maxObjectProperties;
    if (keys.length > maximum) {
      fail(
        `${current.field ?? "object"} exceeds property limit ${maximum}`,
      );
    }
    addWork(keys.length);
    addCanonicalBytes(2 + Math.max(0, keys.length - 1));
    const record = value as Record<string, unknown>;
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]!;
      const keyBytes = utf8ByteLength(key);
      if (keyBytes > profile.maxStringBytes)
        fail(`property name exceeds string limit ${profile.maxStringBytes} bytes`);
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      const descriptorValue =
        descriptor && "value" in descriptor
          ? descriptor.value
          : fail("contains an accessor property");
      addCanonicalBytes(utf8ByteLength(JSON.stringify(key)) + 1);
      pending.push({
        value: descriptorValue,
        depth: current.depth + 1,
        field: key,
      });
    }
  }

  return { nodes, work, canonicalBytes };
}

export function assertEncodedHeaderBudget(
  value: unknown,
  label = "header",
): { decodedBytes: number } {
  const profile = KASPA_X402_RESOURCE_BUDGET;
  if (typeof value !== "string")
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      `${label} must be a base64 string`,
    );
  if (value.length > profile.maxEncodedHeaderBytes)
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      `${label} exceeds encoded limit ${profile.maxEncodedHeaderBytes} bytes`,
    );
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      `${label} must use canonical padded base64`,
    );
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const decodedBytes = (value.length / 4) * 3 - padding;
  if (decodedBytes > profile.maxDecodedHeaderBytes)
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      `${label} exceeds decoded limit ${profile.maxDecodedHeaderBytes} bytes`,
    );
  return { decodedBytes };
}

export function assertDecodedByteBudget(
  value: string | Uint8Array,
  label: string,
): void {
  const byteLength =
    typeof value === "string" ? utf8ByteLength(value) : value.byteLength;
  if (byteLength > KASPA_X402_RESOURCE_BUDGET.maxDecodedHeaderBytes)
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      `${label} exceeds decoded limit ${KASPA_X402_RESOURCE_BUDGET.maxDecodedHeaderBytes} bytes`,
    );
}

export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
