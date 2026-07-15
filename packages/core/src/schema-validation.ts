import {
  HASH32_PATTERN,
  SIGNATURE64_PATTERN,
  U32_MAX,
  U64_DECIMAL_PATTERN,
  X402_VERSION,
} from "./constants.js";
import {
  KaspaX402Error,
  fail,
  ok,
  type KaspaX402ErrorCode,
  type ValidationResult,
} from "./errors.js";
import {
  validateChannelState as validateChannelStateSchema,
  validateKaspaBatchExtra as validateKaspaBatchExtraSchema,
  validateKaspaPaymentPayload as validateKaspaPaymentPayloadSchema,
  validateKaspaRequirementsExtra as validateKaspaRequirementsExtraSchema,
  validatePaymentIdentifier as validatePaymentIdentifierSchema,
  validatePaymentPayload as validatePaymentPayloadSchema,
  validatePaymentRequired as validatePaymentRequiredSchema,
  validatePaymentRequirementsEntry as validatePaymentRequirementsEntrySchema,
  validateSettlementResponse as validateSettlementResponseSchema,
  type StandaloneValidateFunction,
} from "./generated/schema-validators.js";
import { stableStringify } from "./stable-json.js";
import type {
  BatchRequirementsExtra,
  ChannelState,
  JsonRecord,
  KaspaPaymentPayload,
  KaspaRequirementsExtra,
  PaymentIdentifierExtension,
  PaymentIdentifierInfo,
  PaymentIdentifierObservation,
  PaymentPayload,
  PaymentRequired,
  PaymentRequiredEnvelope,
  PaymentRequirements,
  SettlementResponse,
} from "./types.js";

export const SCHEMA_IDS = {
  channelState: "https://kaspa-x402.org/schemas/channel-state.schema.json",
  kaspaBatchExtra:
    "https://kaspa-x402.org/schemas/kaspa-batch-extra.schema.json",
  kaspaPaymentPayload:
    "https://kaspa-x402.org/schemas/kaspa-payment-payload.schema.json",
  kaspaRequirementsExtra:
    "https://kaspa-x402.org/schemas/kaspa-requirements-extra.schema.json",
  paymentIdentifier:
    "https://kaspa-x402.org/schemas/payment-identifier.schema.json",
  paymentPayload: "https://kaspa-x402.org/schemas/payment-payload.schema.json",
  paymentRequired:
    "https://kaspa-x402.org/schemas/payment-required.schema.json",
  settlementResponse:
    "https://kaspa-x402.org/schemas/settlement-response.schema.json",
} as const;

type SchemaId = (typeof SCHEMA_IDS)[keyof typeof SCHEMA_IDS];

const PAYMENT_REQUIREMENTS_ENTRY_SCHEMA_ID =
  "https://kaspa-x402.org/schemas/internal/payment-requirements-entry.schema.json";

const compiledSchemas: Record<
  SchemaId | typeof PAYMENT_REQUIREMENTS_ENTRY_SCHEMA_ID,
  StandaloneValidateFunction
> = {
  [SCHEMA_IDS.channelState]: validateChannelStateSchema,
  [SCHEMA_IDS.kaspaBatchExtra]: validateKaspaBatchExtraSchema,
  [SCHEMA_IDS.kaspaPaymentPayload]: validateKaspaPaymentPayloadSchema,
  [SCHEMA_IDS.kaspaRequirementsExtra]: validateKaspaRequirementsExtraSchema,
  [SCHEMA_IDS.paymentIdentifier]: validatePaymentIdentifierSchema,
  [SCHEMA_IDS.paymentPayload]: validatePaymentPayloadSchema,
  [SCHEMA_IDS.paymentRequired]: validatePaymentRequiredSchema,
  [SCHEMA_IDS.settlementResponse]: validateSettlementResponseSchema,
  [PAYMENT_REQUIREMENTS_ENTRY_SCHEMA_ID]:
    validatePaymentRequirementsEntrySchema,
};

export function validatePaymentRequired(
  value: unknown,
): ValidationResult<PaymentRequired> {
  return validateWithSchema<PaymentRequired>(
    SCHEMA_IDS.paymentRequired,
    value,
    classifyPaymentRequired,
  );
}

export function validateKaspaPaymentRequirement(
  value: unknown,
): ValidationResult<PaymentRequirements> {
  return validateWithSchema<PaymentRequirements>(
    PAYMENT_REQUIREMENTS_ENTRY_SCHEMA_ID,
    value,
    (entry) => classifyRequirementEntry(asRecord(entry)),
  );
}

export function validatePaymentRequiredEnvelope(
  value: unknown,
): ValidationResult<PaymentRequiredEnvelope> {
  const record = asRecord(value);
  if (!record)
    return fail(
      "invalid_kaspa_x402_payload",
      "PaymentRequired must be a JSON object",
    );
  if (record.x402Version !== X402_VERSION)
    return fail(
      "invalid_kaspa_x402_version",
      "PaymentRequired must use x402Version 2",
    );
  const resource = asRecord(record.resource);
  if (
    !resource ||
    typeof resource.url !== "string" ||
    resource.url.length === 0
  ) {
    return fail(
      "invalid_kaspa_x402_payload",
      "PaymentRequired.resource must include a url",
    );
  }
  if (
    !Array.isArray(record.accepts) ||
    record.accepts.length === 0 ||
    !record.accepts.every((entry) => asRecord(entry) !== undefined)
  ) {
    return fail(
      "invalid_kaspa_x402_payload",
      "PaymentRequired.accepts must be a non-empty array of objects",
    );
  }
  if (record.error !== undefined && typeof record.error !== "string") {
    return fail(
      "invalid_kaspa_x402_payload",
      "PaymentRequired.error must be a string",
    );
  }
  if (record.extensions !== undefined && !asRecord(record.extensions)) {
    return fail(
      "invalid_kaspa_x402_payload",
      "PaymentRequired.extensions must be an object",
    );
  }
  return ok(record as PaymentRequiredEnvelope);
}

export interface NarrowedPaymentRequired {
  paymentRequired: PaymentRequired;
  skippedAccepts: JsonRecord[];
}

export function narrowPaymentRequiredEnvelope(
  value: unknown,
): ValidationResult<NarrowedPaymentRequired> {
  const envelope = validatePaymentRequiredEnvelope(value);
  if (!envelope.ok) return envelope;

  const accepts: PaymentRequirements[] = [];
  const skippedAccepts: JsonRecord[] = [];
  for (const entry of envelope.value.accepts) {
    const requirement = validateKaspaPaymentRequirement(entry);
    if (requirement.ok) accepts.push(requirement.value);
    else skippedAccepts.push(entry);
  }
  if (accepts.length === 0) {
    return fail(
      "invalid_kaspa_x402_accepted",
      "no supported Kaspa x402 requirement was offered",
    );
  }

  const narrowed = validatePaymentRequired({ ...envelope.value, accepts });
  if (!narrowed.ok) return narrowed;
  return ok({ paymentRequired: narrowed.value, skippedAccepts });
}

export function validatePaymentPayload(
  value: unknown,
): ValidationResult<PaymentPayload> {
  return validateWithSchema<PaymentPayload>(
    SCHEMA_IDS.paymentPayload,
    value,
    classifyPaymentPayload,
  );
}

export function validateSettlementResponse(
  value: unknown,
): ValidationResult<SettlementResponse> {
  return validateWithSchema<SettlementResponse>(
    SCHEMA_IDS.settlementResponse,
    value,
    classifySettlementResponse,
  );
}

export function validateKaspaBatchExtra(
  value: unknown,
): ValidationResult<BatchRequirementsExtra> {
  return validateWithSchema<BatchRequirementsExtra>(
    SCHEMA_IDS.kaspaBatchExtra,
    value,
    () => "invalid_kaspa_x402_payload",
  );
}

export function validateKaspaRequirementsExtra(
  value: unknown,
): ValidationResult<KaspaRequirementsExtra> {
  return validateWithSchema<KaspaRequirementsExtra>(
    SCHEMA_IDS.kaspaRequirementsExtra,
    value,
    () => "invalid_kaspa_x402_payload",
  );
}

export function validateKaspaPayload(
  value: unknown,
): ValidationResult<KaspaPaymentPayload> {
  return validateWithSchema<KaspaPaymentPayload>(
    SCHEMA_IDS.kaspaPaymentPayload,
    value,
    classifyKaspaPaymentPayload,
  );
}

export function validateChannelState(
  value: unknown,
): ValidationResult<ChannelState> {
  return validateWithSchema<ChannelState>(
    SCHEMA_IDS.channelState,
    value,
    () => "invalid_kaspa_x402_payload",
  );
}

export function validatePaymentIdentifierInfo(
  value: unknown,
  schema?: JsonRecord,
): ValidationResult<PaymentIdentifierInfo> {
  if (schema) {
    const advertised = validateWithInlineSchema<PaymentIdentifierInfo>(
      schema,
      value,
      () => "invalid_kaspa_payment_identifier",
    );
    if (!advertised.ok) return advertised;
  }
  return validateWithSchema<PaymentIdentifierInfo>(
    SCHEMA_IDS.paymentIdentifier,
    value,
    () => "invalid_kaspa_payment_identifier",
  );
}

export function validateSchemaById(
  schemaId: string,
  value: unknown,
): ValidationResult<unknown> {
  switch (schemaId) {
    case SCHEMA_IDS.paymentRequired:
      return validatePaymentRequired(value);
    case SCHEMA_IDS.paymentPayload:
      return validatePaymentPayload(value);
    case SCHEMA_IDS.settlementResponse:
      return validateSettlementResponse(value);
    case SCHEMA_IDS.kaspaPaymentPayload:
      return validateKaspaPayload(value);
    case SCHEMA_IDS.kaspaBatchExtra:
      return validateKaspaBatchExtra(value);
    case SCHEMA_IDS.kaspaRequirementsExtra:
      return validateKaspaRequirementsExtra(value);
    case SCHEMA_IDS.channelState:
      return validateChannelState(value);
    case SCHEMA_IDS.paymentIdentifier:
      return validatePaymentIdentifierInfo(value);
    default:
      return fail(
        "invalid_kaspa_x402_payload",
        `unknown schema id: ${schemaId}`,
      );
  }
}

export function validatePaymentRetry(input: {
  paymentRequired: unknown;
  paymentPayload: unknown;
}): ValidationResult<{
  paymentRequired: PaymentRequired;
  paymentPayload: PaymentPayload;
}> {
  const required = validatePaymentRequired(input.paymentRequired);
  if (!required.ok) return required;

  const payload = validatePaymentPayload(input.paymentPayload);
  if (!payload.ok) return payload;

  const acceptedOffered = isAcceptedOffered(required.value, payload.value);
  if (!acceptedOffered.ok) return acceptedOffered;

  if (!acceptedOffered.value) {
    return fail(
      "invalid_kaspa_x402_accepted",
      "accepted PaymentRequirements is not present in PaymentRequired.accepts",
    );
  }

  const paymentIdentifier = readPaymentIdentifierExtension(required.value);
  if (!paymentIdentifier.ok) return paymentIdentifier;
  if (paymentIdentifier.present) {
    const info = validatePaymentIdentifierInfo(
      paymentIdentifier.value.info,
      paymentIdentifier.value.schema,
    );
    if (!info.ok) return info;
  }

  const payloadPaymentIdentifier = readPaymentIdentifierExtension(
    payload.value,
  );
  if (!payloadPaymentIdentifier.ok) return payloadPaymentIdentifier;
  if (payloadPaymentIdentifier.present) {
    const info = validatePaymentIdentifierInfo(
      payloadPaymentIdentifier.value.info,
      paymentIdentifier.present
        ? paymentIdentifier.value.schema
        : payloadPaymentIdentifier.value.schema,
    );
    if (!info.ok) return info;
  }

  const requiredInfo = paymentIdentifier.present
    ? paymentIdentifier.value.info
    : undefined;
  const payloadInfo = payloadPaymentIdentifier.present
    ? payloadPaymentIdentifier.value.info
    : undefined;

  if (requiredInfo?.required === true && !payloadInfo?.id) {
    return fail(
      "missing_kaspa_payment_identifier",
      "payment-identifier extension is required for this retry",
    );
  }
  if (paymentIdentifier.present && payloadPaymentIdentifier.present) {
    const echo = validatePaymentIdentifierEcho(
      paymentIdentifier.value,
      payloadPaymentIdentifier.value,
    );
    if (!echo.ok) return echo;
  }

  return ok({ paymentRequired: required.value, paymentPayload: payload.value });
}

export function validatePaymentIdentifierReuse(
  first: PaymentIdentifierObservation,
  second: PaymentIdentifierObservation,
): ValidationResult<{
  first: PaymentIdentifierObservation;
  second: PaymentIdentifierObservation;
}> {
  const firstInfo = validatePaymentIdentifierInfo(first.extensionInfo);
  if (!firstInfo.ok) return firstInfo;

  const secondInfo = validatePaymentIdentifierInfo(second.extensionInfo);
  if (!secondInfo.ok) return secondInfo;

  if (
    !HASH32_PATTERN.test(first.requestHash) ||
    !HASH32_PATTERN.test(second.requestHash)
  ) {
    return fail(
      "invalid_kaspa_payment_identifier",
      "requestHash must be a 32-byte hex string",
    );
  }

  const firstRequestHash = first.requestHash.toLowerCase();
  const secondRequestHash = second.requestHash.toLowerCase();

  if (
    firstInfo.value.id &&
    firstInfo.value.id === secondInfo.value.id &&
    firstRequestHash !== secondRequestHash
  ) {
    return fail(
      "kaspa_payment_identifier_conflict",
      "payment identifier was reused with a different request fingerprint",
    );
  }

  return ok({ first, second });
}

function validateWithSchema<T>(
  schemaId: SchemaId | typeof PAYMENT_REQUIREMENTS_ENTRY_SCHEMA_ID,
  value: unknown,
  classify: (value: unknown) => KaspaX402ErrorCode,
): ValidationResult<T> {
  const validate = getSchema(schemaId);
  if (validate(value)) {
    return ok(value as T);
  }

  return fail(classify(value), `value failed ${schemaId}`, validate.errors);
}

function validateWithInlineSchema<T>(
  schema: JsonRecord,
  value: unknown,
  classify: (value: unknown) => KaspaX402ErrorCode,
): ValidationResult<T> {
  const result = validateJsonSchemaSubset(schema, value);
  if (result.ok) {
    return ok(value as T);
  }

  return fail(
    classify(value),
    result.schemaSupported
      ? "value failed advertised payment-identifier extension schema"
      : "payment-identifier extension schema is invalid",
    result.errors,
  );
}

type SubsetValidationResult =
  | {
      ok: true;
      schemaSupported: true;
    }
  | {
      ok: false;
      schemaSupported: boolean;
      errors: Array<{ path: string; message: string }>;
    };

function validateJsonSchemaSubset(
  schema: unknown,
  value: unknown,
  path = "",
): SubsetValidationResult {
  const schemaRecord = asRecord(schema);
  if (!schemaRecord)
    return subsetFailure(path, "schema must be an object", false);

  const unsupportedKeyword = firstUnsupportedSchemaKeyword(schemaRecord);
  if (unsupportedKeyword)
    return subsetFailure(
      path,
      `unsupported schema keyword: ${unsupportedKeyword}`,
      false,
    );

  const type = schemaRecord.type;
  if (
    type !== undefined &&
    type !== "object" &&
    type !== "string" &&
    type !== "boolean" &&
    type !== "number" &&
    type !== "integer"
  ) {
    return subsetFailure(path, "unsupported schema type", false);
  }

  if (
    Object.hasOwn(schemaRecord, "const") &&
    stableStringify(value) !== stableStringify(schemaRecord.const)
  ) {
    return subsetFailure(path, "must equal const", true);
  }

  const enumValues = schemaRecord.enum;
  if (enumValues !== undefined) {
    if (!Array.isArray(enumValues))
      return subsetFailure(path, "enum must be an array", false);
    if (
      !enumValues.some(
        (candidate) => stableStringify(candidate) === stableStringify(value),
      )
    )
      return subsetFailure(path, "must equal one enum value", true);
  }

  const effectiveType = type ?? inferSchemaType(schemaRecord, path);
  if (typeof effectiveType !== "string") return effectiveType;

  if (effectiveType === "object") {
    const valueRecord = asRecord(value);
    if (!valueRecord) return subsetFailure(path, "must be an object", true);

    const required = schemaRecord.required;
    if (required !== undefined) {
      if (
        !Array.isArray(required) ||
        !required.every((field) => typeof field === "string")
      ) {
        return subsetFailure(
          path,
          "required must be an array of strings",
          false,
        );
      }
      for (const field of required) {
        if (!Object.hasOwn(valueRecord, field))
          return subsetFailure(
            joinPath(path, field),
            "required property is missing",
            true,
          );
      }
    }

    const properties = asRecord(schemaRecord.properties);
    if (schemaRecord.properties !== undefined && !properties)
      return subsetFailure(path, "properties must be an object", false);
    if (properties) {
      for (const [key, propertySchema] of Object.entries(properties)) {
        if (!Object.hasOwn(valueRecord, key)) continue;
        const propertyResult = validateJsonSchemaSubset(
          propertySchema,
          valueRecord[key],
          joinPath(path, key),
        );
        if (!propertyResult.ok) return propertyResult;
      }
    }

    if (schemaRecord.additionalProperties === false) {
      for (const key of Object.keys(valueRecord)) {
        if (!properties || !Object.hasOwn(properties, key))
          return subsetFailure(
            joinPath(path, key),
            "additional property is not allowed",
            true,
          );
      }
    } else if (
      schemaRecord.additionalProperties !== undefined &&
      schemaRecord.additionalProperties !== true
    ) {
      return subsetFailure(path, "additionalProperties must be boolean", false);
    }

    return { ok: true, schemaSupported: true };
  }

  if (effectiveType === "string") {
    if (typeof value !== "string")
      return subsetFailure(path, "must be a string", true);
    if (
      schemaRecord.minLength !== undefined &&
      (!Number.isInteger(schemaRecord.minLength) ||
        value.length < Number(schemaRecord.minLength))
    ) {
      return subsetFailure(
        path,
        "string is shorter than minLength",
        Number.isInteger(schemaRecord.minLength),
      );
    }
    if (
      schemaRecord.maxLength !== undefined &&
      (!Number.isInteger(schemaRecord.maxLength) ||
        value.length > Number(schemaRecord.maxLength))
    ) {
      return subsetFailure(
        path,
        "string is longer than maxLength",
        Number.isInteger(schemaRecord.maxLength),
      );
    }
    if (schemaRecord.pattern !== undefined) {
      if (typeof schemaRecord.pattern !== "string")
        return subsetFailure(path, "pattern must be a string", false);
      let pattern: RegExp;
      try {
        pattern = new RegExp(schemaRecord.pattern);
      } catch {
        return subsetFailure(
          path,
          "pattern must be a valid regular expression",
          false,
        );
      }
      if (!pattern.test(value))
        return subsetFailure(path, "string does not match pattern", true);
    }
    return { ok: true, schemaSupported: true };
  }

  if (effectiveType === "boolean") {
    return typeof value === "boolean"
      ? { ok: true, schemaSupported: true }
      : subsetFailure(path, "must be a boolean", true);
  }

  if (effectiveType === "number") {
    return typeof value === "number" && Number.isFinite(value)
      ? { ok: true, schemaSupported: true }
      : subsetFailure(path, "must be a number", true);
  }

  if (effectiveType === "integer") {
    return Number.isInteger(value)
      ? { ok: true, schemaSupported: true }
      : subsetFailure(path, "must be an integer", true);
  }

  return { ok: true, schemaSupported: true };
}

const SUPPORTED_INLINE_SCHEMA_KEYWORDS = new Set([
  "$id",
  "$schema",
  "additionalProperties",
  "const",
  "default",
  "description",
  "enum",
  "examples",
  "maxLength",
  "minLength",
  "pattern",
  "properties",
  "required",
  "title",
  "type",
]);

function firstUnsupportedSchemaKeyword(schema: JsonRecord): string | undefined {
  return Object.keys(schema).find(
    (key) => !SUPPORTED_INLINE_SCHEMA_KEYWORDS.has(key),
  );
}

function inferSchemaType(
  schema: JsonRecord,
  path: string,
): "object" | "string" | SubsetValidationResult {
  const objectKeywords = [
    "additionalProperties",
    "properties",
    "required",
  ].filter((key) => Object.hasOwn(schema, key));
  const stringKeywords = ["maxLength", "minLength", "pattern"].filter((key) =>
    Object.hasOwn(schema, key),
  );
  if (objectKeywords.length > 0 && stringKeywords.length > 0) {
    return subsetFailure(
      path,
      "type is required when object and string keywords are mixed",
      false,
    );
  }
  if (objectKeywords.length > 0) return "object";
  if (stringKeywords.length > 0) return "string";
  return { ok: true, schemaSupported: true };
}

function subsetFailure(
  path: string,
  message: string,
  schemaSupported: boolean,
): SubsetValidationResult {
  return {
    ok: false,
    schemaSupported,
    errors: [
      {
        path,
        message,
      },
    ],
  };
}

function joinPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function validatePaymentIdentifierEcho(
  advertised: PaymentIdentifierExtension,
  echoed: PaymentIdentifierExtension,
): ValidationResult<PaymentIdentifierExtension> {
  if (stableStringify(echoed.schema) !== stableStringify(advertised.schema)) {
    return fail(
      "invalid_kaspa_payment_identifier",
      "payment-identifier extension schema must echo the advertised schema",
    );
  }

  for (const [key, value] of Object.entries(advertised.info)) {
    if (
      !Object.hasOwn(echoed.info, key) ||
      stableStringify(echoed.info[key]) !== stableStringify(value)
    ) {
      return fail(
        "invalid_kaspa_payment_identifier",
        "payment-identifier extension info must preserve advertised fields",
      );
    }
  }

  return ok(echoed);
}

function getSchema(
  schemaId: SchemaId | typeof PAYMENT_REQUIREMENTS_ENTRY_SCHEMA_ID,
): StandaloneValidateFunction {
  const validate = compiledSchemas[schemaId];
  if (!validate) {
    throw new Error(`schema not loaded: ${schemaId}`);
  }
  return validate;
}

function classifyPaymentRequired(value: unknown): KaspaX402ErrorCode {
  if (hasInvalidPaymentIdentifierExtension(value))
    return "invalid_kaspa_payment_identifier";
  const requirement = asRecord(value)?.accepts;
  const firstRequirement = Array.isArray(requirement)
    ? asRecord(requirement[0])
    : undefined;

  if (asRecord(value)?.x402Version !== 2) return "invalid_kaspa_x402_version";
  return classifyRequirementEntry(firstRequirement);
}

function classifyRequirementEntry(
  entry: Record<string, unknown> | undefined,
): KaspaX402ErrorCode {
  if (!entry || !["exact", "batch-settlement"].includes(String(entry.scheme))) {
    return "invalid_kaspa_x402_scheme";
  }
  if (!["kaspa:mainnet", "kaspa:testnet-10"].includes(String(entry.network)))
    return "invalid_kaspa_x402_network";
  if (entry.asset !== "KAS") return "invalid_kaspa_x402_asset";
  if (
    typeof entry.amount !== "string" ||
    !U64_DECIMAL_PATTERN.test(entry.amount)
  ) {
    return "invalid_kaspa_x402_amount";
  }

  const extra = asRecord(entry.extra);
  if (!isExpectedBindingForScheme(String(entry.scheme), extra?.binding))
    return "invalid_kaspa_x402_binding";

  return "invalid_kaspa_x402_payload";
}

function classifyPaymentPayload(value: unknown): KaspaX402ErrorCode {
  const record = asRecord(value);
  if (hasInvalidPaymentIdentifierExtension(value))
    return "invalid_kaspa_payment_identifier";
  const accepted = asRecord(record?.accepted);
  const payload = asRecord(record?.payload);
  const expectedTypes = expectedPayloadTypesForScheme(String(accepted?.scheme));

  if (expectedTypes && !expectedTypes.includes(String(payload?.type))) {
    return "invalid_kaspa_payment_payload_type";
  }

  return "invalid_kaspa_x402_payload";
}

function hasInvalidPaymentIdentifierExtension(value: unknown): boolean {
  const extensions = asRecord(asRecord(value)?.extensions);
  if (!extensions || !Object.hasOwn(extensions, "payment-identifier"))
    return false;
  const extension = asRecord(extensions["payment-identifier"]);
  if (!extension) return true;
  if (!asRecord(extension.schema)) return true;
  const info = asRecord(extension.info);
  if (!info) return true;
  if (typeof info.required !== "boolean") return true;
  if (info.id !== undefined && typeof info.id !== "string") return true;
  return false;
}

function classifyKaspaPaymentPayload(value: unknown): KaspaX402ErrorCode {
  const record = asRecord(value);
  const fundingOutpoint = asRecord(record?.fundingOutpoint);
  const voucher = asRecord(record?.voucher);

  if (
    record?.clientPublicKey !== undefined &&
    !HASH32_PATTERN.test(String(record.clientPublicKey))
  ) {
    return "invalid_kaspa_public_key";
  }

  if (
    fundingOutpoint !== undefined &&
    (!HASH32_PATTERN.test(String(fundingOutpoint.txid)) ||
      !isUint32(fundingOutpoint.index))
  ) {
    return "invalid_kaspa_outpoint";
  }

  if (
    voucher?.signature !== undefined &&
    !SIGNATURE64_PATTERN.test(String(voucher.signature))
  )
    return "invalid_kaspa_signature";
  if (
    voucher?.amount !== undefined &&
    !U64_DECIMAL_PATTERN.test(String(voucher.amount))
  )
    return "invalid_kaspa_x402_amount";
  if (
    record?.claimAmount !== undefined &&
    !U64_DECIMAL_PATTERN.test(String(record.claimAmount))
  )
    return "invalid_kaspa_x402_amount";
  if (
    record?.refundAmount !== undefined &&
    !U64_DECIMAL_PATTERN.test(String(record.refundAmount))
  )
    return "invalid_kaspa_x402_amount";

  return "invalid_kaspa_x402_payload";
}

function classifySettlementResponse(value: unknown): KaspaX402ErrorCode {
  const record = asRecord(value);
  if (
    typeof record?.transaction === "string" &&
    !/^(?:|[0-9a-fA-F]{64})$/.test(record.transaction)
  ) {
    return "invalid_kaspa_transaction";
  }
  return "invalid_kaspa_settlement_response";
}

function isExpectedBindingForScheme(scheme: string, binding: unknown): boolean {
  if (scheme === "exact") return binding === "kaspa-exact-v2";
  return scheme === "batch-settlement" && binding === "kaspa-escrow-v1";
}

function expectedPayloadTypesForScheme(scheme: string): string[] | undefined {
  return {
    exact: ["exact-transaction"],
    "batch-settlement": ["deposit-voucher", "voucher", "claim", "refund"],
  }[scheme];
}

function isAcceptedOffered(
  paymentRequired: PaymentRequired,
  paymentPayload: PaymentPayload,
): ValidationResult<boolean> {
  try {
    const accepted = stableStringify(paymentPayload.accepted);
    return ok(
      paymentRequired.accepts.some(
        (requirement) => stableStringify(requirement) === accepted,
      ),
    );
  } catch (error) {
    return fail(
      "invalid_kaspa_x402_payload",
      "PaymentRequirements must be JSON-serializable",
      error,
    );
  }
}

type PaymentIdentifierExtensionRead =
  | {
      ok: true;
      present: false;
    }
  | {
      ok: true;
      present: true;
      value: PaymentIdentifierExtension;
    }
  | {
      ok: false;
      error: KaspaX402Error;
    };

function readPaymentIdentifierExtension(
  value: PaymentPayload | PaymentRequired,
): PaymentIdentifierExtensionRead {
  const extensions = asRecord(value.extensions);
  if (!extensions || !Object.hasOwn(extensions, "payment-identifier")) {
    return { ok: true, present: false };
  }

  const paymentIdentifier = asRecord(extensions?.["payment-identifier"]);
  if (
    !paymentIdentifier ||
    !Object.hasOwn(paymentIdentifier, "info") ||
    !Object.hasOwn(paymentIdentifier, "schema")
  ) {
    return {
      ok: false,
      error: new KaspaX402Error(
        "invalid_kaspa_payment_identifier",
        "payment-identifier extension must contain info and schema",
      ),
    };
  }

  const schema = asRecord(paymentIdentifier.schema);
  if (!schema) {
    return {
      ok: false,
      error: new KaspaX402Error(
        "invalid_kaspa_payment_identifier",
        "payment-identifier extension schema must be an object",
      ),
    };
  }

  return {
    ok: true,
    present: true,
    value: paymentIdentifier as PaymentIdentifierExtension,
  };
}

function isUint32(value: unknown): boolean {
  return (
    Number.isInteger(value) && Number(value) >= 0 && Number(value) <= U32_MAX
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
