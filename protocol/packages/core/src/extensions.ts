import paymentIdentifierInfoSchema from "../../../schemas/payment-identifier.schema.json";

import type {
  JsonRecord,
  PaymentIdentifierExtension,
  PaymentIdentifierInfo,
  SettlementResponse,
  SettlementResponseExtra,
  SettlementResponseExtensions,
} from "./types.js";

export const PAYMENT_IDENTIFIER_EXTENSION_KEY = "payment-identifier";
export const KASPA_SETTLEMENT_EXTENSION_KEY = "kaspa";

export const PAYMENT_IDENTIFIER_INFO_SCHEMA = paymentIdentifierInfoSchema as JsonRecord;

export function paymentIdentifierExtension(info: PaymentIdentifierInfo, schema: JsonRecord = PAYMENT_IDENTIFIER_INFO_SCHEMA): PaymentIdentifierExtension {
  return {
    info,
    schema,
  };
}

export function kaspaSettlementExtensions(extra: SettlementResponseExtra): SettlementResponseExtensions {
  return {
    [KASPA_SETTLEMENT_EXTENSION_KEY]: extra,
  };
}

export function withKaspaSettlementExtension(response: SettlementResponse, extra: SettlementResponseExtra): SettlementResponse {
  const { extra: _legacyExtra, extensions, ...rest } = response;
  return {
    ...rest,
    extensions: {
      ...(extensions ?? {}),
      ...kaspaSettlementExtensions(extra),
    },
  };
}

export function readKaspaSettlementExtension(response: SettlementResponse): SettlementResponseExtra | undefined {
  const extension = response.extensions?.[KASPA_SETTLEMENT_EXTENSION_KEY];
  return isRecord(extension) ? (extension as SettlementResponseExtra) : response.extra;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
