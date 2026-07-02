import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";

import channelStateSchema from "../../../schemas/channel-state.schema.json";
import kaspaBatchExtraSchema from "../../../schemas/kaspa-batch-extra.schema.json";
import kaspaPaymentPayloadSchema from "../../../schemas/kaspa-payment-payload.schema.json";
import kaspaRequirementsExtraSchema from "../../../schemas/kaspa-requirements-extra.schema.json";
import paymentIdentifierSchema from "../../../schemas/payment-identifier.schema.json";
import paymentPayloadSchema from "../../../schemas/payment-payload.schema.json";
import paymentRequiredSchema from "../../../schemas/payment-required.schema.json";
import settlementResponseSchema from "../../../schemas/settlement-response.schema.json";

import { HASH32_PATTERN, SIGNATURE64_PATTERN, U32_MAX, U64_DECIMAL_PATTERN } from "./constants.js";
import { KaspaX402Error, fail, ok, type KaspaX402ErrorCode, type ValidationResult } from "./errors.js";
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
  SettlementResponse,
} from "./types.js";

export const SCHEMA_IDS = {
  channelState: "https://kaspa-x402.org/schemas/channel-state.schema.json",
  kaspaBatchExtra: "https://kaspa-x402.org/schemas/kaspa-batch-extra.schema.json",
  kaspaPaymentPayload: "https://kaspa-x402.org/schemas/kaspa-payment-payload.schema.json",
  kaspaRequirementsExtra: "https://kaspa-x402.org/schemas/kaspa-requirements-extra.schema.json",
  paymentIdentifier: "https://kaspa-x402.org/schemas/payment-identifier.schema.json",
  paymentPayload: "https://kaspa-x402.org/schemas/payment-payload.schema.json",
  paymentRequired: "https://kaspa-x402.org/schemas/payment-required.schema.json",
  settlementResponse: "https://kaspa-x402.org/schemas/settlement-response.schema.json",
} as const;

type SchemaId = (typeof SCHEMA_IDS)[keyof typeof SCHEMA_IDS];

const schemaEntries = [
  channelStateSchema,
  kaspaBatchExtraSchema,
  kaspaPaymentPayloadSchema,
  kaspaRequirementsExtraSchema,
  paymentIdentifierSchema,
  paymentPayloadSchema,
  paymentRequiredSchema,
  settlementResponseSchema,
];

const ajv = new Ajv2020({ allErrors: true, strict: false });
for (const schema of schemaEntries) {
  ajv.addSchema(schema);
}

export function validatePaymentRequired(value: unknown): ValidationResult<PaymentRequired> {
  return validateWithSchema<PaymentRequired>(SCHEMA_IDS.paymentRequired, value, classifyPaymentRequired);
}

export function validatePaymentPayload(value: unknown): ValidationResult<PaymentPayload> {
  return validateWithSchema<PaymentPayload>(SCHEMA_IDS.paymentPayload, value, classifyPaymentPayload);
}

export function validateSettlementResponse(value: unknown): ValidationResult<SettlementResponse> {
  return validateWithSchema<SettlementResponse>(SCHEMA_IDS.settlementResponse, value, classifySettlementResponse);
}

export function validateKaspaBatchExtra(value: unknown): ValidationResult<BatchRequirementsExtra> {
  return validateWithSchema<BatchRequirementsExtra>(SCHEMA_IDS.kaspaBatchExtra, value, () => "invalid_kaspa_x402_payload");
}

export function validateKaspaRequirementsExtra(value: unknown): ValidationResult<KaspaRequirementsExtra> {
  return validateWithSchema<KaspaRequirementsExtra>(SCHEMA_IDS.kaspaRequirementsExtra, value, () => "invalid_kaspa_x402_payload");
}

export function validateKaspaPayload(value: unknown): ValidationResult<KaspaPaymentPayload> {
  return validateWithSchema<KaspaPaymentPayload>(SCHEMA_IDS.kaspaPaymentPayload, value, classifyKaspaPaymentPayload);
}

export function validateChannelState(value: unknown): ValidationResult<ChannelState> {
  return validateWithSchema<ChannelState>(SCHEMA_IDS.channelState, value, () => "invalid_kaspa_x402_payload");
}

export function validatePaymentIdentifierInfo(value: unknown, schema?: JsonRecord): ValidationResult<PaymentIdentifierInfo> {
  if (schema) {
    const advertised = validateWithInlineSchema<PaymentIdentifierInfo>(schema, value, () => "invalid_kaspa_payment_identifier");
    if (!advertised.ok) return advertised;
  }
  return validateWithSchema<PaymentIdentifierInfo>(SCHEMA_IDS.paymentIdentifier, value, () => "invalid_kaspa_payment_identifier");
}

export function validateSchemaById(schemaId: string, value: unknown): ValidationResult<unknown> {
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
      return fail("invalid_kaspa_x402_payload", `unknown schema id: ${schemaId}`);
  }
}

export function validatePaymentRetry(input: {
  paymentRequired: unknown;
  paymentPayload: unknown;
}): ValidationResult<{ paymentRequired: PaymentRequired; paymentPayload: PaymentPayload }> {
  const required = validatePaymentRequired(input.paymentRequired);
  if (!required.ok) return required;

  const payload = validatePaymentPayload(input.paymentPayload);
  if (!payload.ok) return payload;

  const acceptedOffered = isAcceptedOffered(required.value, payload.value);
  if (!acceptedOffered.ok) return acceptedOffered;

  if (!acceptedOffered.value) {
    return fail("invalid_kaspa_x402_accepted", "accepted PaymentRequirements is not present in PaymentRequired.accepts");
  }

  const paymentIdentifier = readPaymentIdentifierExtension(required.value);
  if (!paymentIdentifier.ok) return paymentIdentifier;
  if (paymentIdentifier.present) {
    const info = validatePaymentIdentifierInfo(paymentIdentifier.value.info, paymentIdentifier.value.schema);
    if (!info.ok) return info;
  }

  const payloadPaymentIdentifier = readPaymentIdentifierExtension(payload.value);
  if (!payloadPaymentIdentifier.ok) return payloadPaymentIdentifier;
  if (payloadPaymentIdentifier.present) {
    const info = validatePaymentIdentifierInfo(
      payloadPaymentIdentifier.value.info,
      paymentIdentifier.present ? paymentIdentifier.value.schema : payloadPaymentIdentifier.value.schema,
    );
    if (!info.ok) return info;
  }

  const requiredInfo = paymentIdentifier.present ? paymentIdentifier.value.info : undefined;
  const payloadInfo = payloadPaymentIdentifier.present ? payloadPaymentIdentifier.value.info : undefined;

  if (requiredInfo?.required === true && !payloadInfo?.id) {
    return fail("missing_kaspa_payment_identifier", "payment-identifier extension is required for this retry");
  }
  if (paymentIdentifier.present && payloadPaymentIdentifier.present) {
    const echo = validatePaymentIdentifierEcho(paymentIdentifier.value, payloadPaymentIdentifier.value);
    if (!echo.ok) return echo;
  }

  return ok({ paymentRequired: required.value, paymentPayload: payload.value });
}

export function validatePaymentIdentifierReuse(
  first: PaymentIdentifierObservation,
  second: PaymentIdentifierObservation,
): ValidationResult<{ first: PaymentIdentifierObservation; second: PaymentIdentifierObservation }> {
  const firstInfo = validatePaymentIdentifierInfo(first.extensionInfo);
  if (!firstInfo.ok) return firstInfo;

  const secondInfo = validatePaymentIdentifierInfo(second.extensionInfo);
  if (!secondInfo.ok) return secondInfo;

  if (!HASH32_PATTERN.test(first.requestHash) || !HASH32_PATTERN.test(second.requestHash)) {
    return fail("invalid_kaspa_payment_identifier", "requestHash must be a 32-byte hex string");
  }

  const firstRequestHash = first.requestHash.toLowerCase();
  const secondRequestHash = second.requestHash.toLowerCase();

  if (firstInfo.value.id && firstInfo.value.id === secondInfo.value.id && firstRequestHash !== secondRequestHash) {
    return fail("kaspa_payment_identifier_conflict", "payment identifier was reused with a different request fingerprint");
  }

  return ok({ first, second });
}

function validateWithSchema<T>(
  schemaId: SchemaId,
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
  let validate: ValidateFunction;
  try {
    validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  } catch (error) {
    return fail(classify(value), "payment-identifier extension schema is invalid", error instanceof Error ? { message: error.message } : error);
  }

  if (validate(value)) {
    return ok(value as T);
  }

  return fail(classify(value), "value failed advertised payment-identifier extension schema", validate.errors);
}

function validatePaymentIdentifierEcho(
  advertised: PaymentIdentifierExtension,
  echoed: PaymentIdentifierExtension,
): ValidationResult<PaymentIdentifierExtension> {
  if (stableStringify(echoed.schema) !== stableStringify(advertised.schema)) {
    return fail("invalid_kaspa_payment_identifier", "payment-identifier extension schema must echo the advertised schema");
  }

  for (const [key, value] of Object.entries(advertised.info)) {
    if (!Object.hasOwn(echoed.info, key) || stableStringify(echoed.info[key]) !== stableStringify(value)) {
      return fail("invalid_kaspa_payment_identifier", "payment-identifier extension info must preserve advertised fields");
    }
  }

  return ok(echoed);
}

function getSchema(schemaId: SchemaId): ValidateFunction {
  const validate = ajv.getSchema(schemaId);
  if (!validate) {
    throw new Error(`schema not loaded: ${schemaId}`);
  }
  return validate;
}

function classifyPaymentRequired(value: unknown): KaspaX402ErrorCode {
  if (hasInvalidPaymentIdentifierExtension(value)) return "invalid_kaspa_payment_identifier";
  const requirement = asRecord(value)?.accepts;
  const firstRequirement = Array.isArray(requirement) ? asRecord(requirement[0]) : undefined;

  if (asRecord(value)?.x402Version !== 2) return "invalid_kaspa_x402_version";
  if (!firstRequirement || !["exact", "upto", "batch-settlement"].includes(String(firstRequirement.scheme))) {
    return "invalid_kaspa_x402_scheme";
  }
  if (!["kaspa:mainnet", "kaspa:testnet-10"].includes(String(firstRequirement.network))) return "invalid_kaspa_x402_network";
  if (firstRequirement.asset !== "KAS") return "invalid_kaspa_x402_asset";
  if (typeof firstRequirement.amount !== "string" || !U64_DECIMAL_PATTERN.test(firstRequirement.amount)) {
    return "invalid_kaspa_x402_amount";
  }

  const extra = asRecord(firstRequirement.extra);
  if (extra?.binding !== expectedBindingForScheme(String(firstRequirement.scheme))) return "invalid_kaspa_x402_binding";

  return "invalid_kaspa_x402_payload";
}

function classifyPaymentPayload(value: unknown): KaspaX402ErrorCode {
  const record = asRecord(value);
  if (hasInvalidPaymentIdentifierExtension(value)) return "invalid_kaspa_payment_identifier";
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
  if (!extensions || !Object.hasOwn(extensions, "payment-identifier")) return false;
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

  if (record?.clientPublicKey !== undefined && !HASH32_PATTERN.test(String(record.clientPublicKey))) {
    return "invalid_kaspa_public_key";
  }

  if (
    fundingOutpoint !== undefined &&
    (!HASH32_PATTERN.test(String(fundingOutpoint.txid)) || !isUint32(fundingOutpoint.index))
  ) {
    return "invalid_kaspa_outpoint";
  }

  if (voucher?.signature !== undefined && !SIGNATURE64_PATTERN.test(String(voucher.signature))) return "invalid_kaspa_signature";
  if (voucher?.amount !== undefined && !U64_DECIMAL_PATTERN.test(String(voucher.amount))) return "invalid_kaspa_x402_amount";
  if (record?.claimAmount !== undefined && !U64_DECIMAL_PATTERN.test(String(record.claimAmount))) return "invalid_kaspa_x402_amount";
  if (record?.refundAmount !== undefined && !U64_DECIMAL_PATTERN.test(String(record.refundAmount))) return "invalid_kaspa_x402_amount";

  return "invalid_kaspa_x402_payload";
}

function classifySettlementResponse(value: unknown): KaspaX402ErrorCode {
  const record = asRecord(value);
  if (typeof record?.transaction === "string" && !/^(?:|[0-9a-fA-F]{64})$/.test(record.transaction)) {
    return "invalid_kaspa_transaction";
  }
  return "invalid_kaspa_settlement_response";
}

function expectedBindingForScheme(scheme: string): string | undefined {
  return {
    exact: "kaspa-exact-v1",
    upto: "kaspa-upto-v1",
    "batch-settlement": "kaspa-escrow-v1",
  }[scheme];
}

function expectedPayloadTypesForScheme(scheme: string): string[] | undefined {
  return {
    exact: ["exact-transfer"],
    upto: ["upto-authorization"],
    "batch-settlement": ["deposit-voucher", "voucher", "claim", "refund"],
  }[scheme];
}

function isAcceptedOffered(paymentRequired: PaymentRequired, paymentPayload: PaymentPayload): ValidationResult<boolean> {
  try {
    const accepted = stableStringify(paymentPayload.accepted);
    return ok(paymentRequired.accepts.some((requirement) => stableStringify(requirement) === accepted));
  } catch (error) {
    return fail("invalid_kaspa_x402_payload", "PaymentRequirements must be JSON-serializable", error);
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

function readPaymentIdentifierExtension(value: PaymentPayload | PaymentRequired): PaymentIdentifierExtensionRead {
  const extensions = asRecord(value.extensions);
  if (!extensions || !Object.hasOwn(extensions, "payment-identifier")) {
    return { ok: true, present: false };
  }

  const paymentIdentifier = asRecord(extensions?.["payment-identifier"]);
  if (!paymentIdentifier || !Object.hasOwn(paymentIdentifier, "info") || !Object.hasOwn(paymentIdentifier, "schema")) {
    return {
      ok: false,
      error: new KaspaX402Error("invalid_kaspa_payment_identifier", "payment-identifier extension must contain info and schema"),
    };
  }

  const schema = asRecord(paymentIdentifier.schema);
  if (!schema) {
    return {
      ok: false,
      error: new KaspaX402Error("invalid_kaspa_payment_identifier", "payment-identifier extension schema must be an object"),
    };
  }

  return { ok: true, present: true, value: paymentIdentifier as PaymentIdentifierExtension };
}

function isUint32(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= U32_MAX;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
