import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  decodePaymentRequiredEnvelopeHeader,
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredEnvelopeHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  formatSompiString,
  isDecimalSompi,
  isKaspaX402Network,
  mcpPaymentRequiredResult,
  mcpSettlementFailureResult,
  narrowPaymentRequiredEnvelope,
  paymentIdentifierExtension,
  parseSompiString,
  readMcpPaymentRequired,
  readMcpPaymentResponse,
  validateKaspaPaymentRequirement,
  validatePaymentIdentifierReuse,
  validatePaymentRequired,
  validatePaymentRetry,
  validateSchemaById,
  voucherDigest,
  voucherPreimageHex,
  channelId,
  channelIdPreimageHex,
  validateChannelId,
} from "../src/index.js";
import type {
  ChannelConfig,
  PaymentIdentifierObservation,
  PaymentPayload,
  PaymentRequired,
  SettlementResponse,
} from "../src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

type VoucherVector = {
  cases: Array<{
    name: string;
    input: Parameters<typeof voucherDigest>[0];
    expected: {
      preimage: string;
      digest: string;
    };
  }>;
};

type ChannelVector = {
  input: ChannelConfig;
  expected: {
    preimage: string;
    channelId: string;
  };
};

type HttpVector = {
  paymentRequired: PaymentRequired;
  paymentPayload: PaymentPayload;
  settlementResponse: SettlementResponse;
  headers: {
    paymentRequired: string;
    paymentSignature: string;
    paymentResponse: string;
  };
};

type NegativeVector =
  | {
      kind: "negative";
      schema: string;
      value: unknown;
      expectedError: string;
    }
  | {
      kind: "semantic-negative";
      scenario: "missing-payment-identifier" | "accepted-not-offered";
      paymentRequired: PaymentRequired;
      paymentPayload: PaymentPayload;
      expectedError: string;
    }
  | {
      kind: "semantic-negative";
      scenario: "payment-identifier-conflict";
      first: PaymentIdentifierObservation;
      second: PaymentIdentifierObservation;
      expectedError: string;
    };

function readJson<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8")) as T;
}

function foreignEvmEntry(): Record<string, unknown> {
  return {
    scheme: "exact",
    network: "eip155:8453",
    amount: "1000",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    payTo: "0x0000000000000000000000000000000000000001",
    maxTimeoutSeconds: 60,
    extra: {},
  };
}

function foreignUptoEntry(): Record<string, unknown> {
  return {
    scheme: "upto",
    network: "kaspa:testnet-10",
    amount: "1000",
    asset: "KAS",
    payTo: "kaspatest:payout",
    maxTimeoutSeconds: 60,
    extra: {
      binding: "kaspa-upto-v1",
    },
  };
}

function listJson(relativeDir: string): string[] {
  return fs
    .readdirSync(path.join(repoRoot, relativeDir))
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .map((entry) => path.join(relativeDir, entry));
}

function expectFailureCode(result: { ok: true } | { ok: false; error: { code: string } }, code: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error(`expected failure ${code}`);
  expect(result.error.code).toBe(code);
}

describe("amount and network primitives", () => {
  it("validates canonical uint64 sompi strings", () => {
    expect(isDecimalSompi("0")).toBe(true);
    expect(isDecimalSompi("2500000")).toBe(true);
    expect(isDecimalSompi("18446744073709551615")).toBe(true);
    expect(isDecimalSompi("01")).toBe(false);
    expect(isDecimalSompi("1.5")).toBe(false);
    expect(isDecimalSompi("18446744073709551616")).toBe(false);
    expect(parseSompiString("2500000")).toBe(2500000n);
    expect(formatSompiString(2500000n)).toBe("2500000");
  });

  it("validates supported Kaspa x402 networks", () => {
    expect(isKaspaX402Network("kaspa:testnet-10")).toBe(true);
    expect(isKaspaX402Network("kaspa:mainnet")).toBe(true);
    expect(isKaspaX402Network("testnet-10")).toBe(false);
  });
});

describe("voucher digest vectors", () => {
  const vector = readJson<VoucherVector>("vectors/voucher/full-outpoint-binding.json");

  for (const item of vector.cases) {
    it(`matches ${item.name}`, () => {
      expect(voucherPreimageHex(item.input)).toBe(item.expected.preimage);
      expect(voucherDigest(item.input)).toBe(item.expected.digest);
    });
  }

  it("rejects bare script bytes for activeScriptPublicKey", () => {
    const item = vector.cases[0];
    if (!item) throw new Error("missing base voucher vector");

    expect(() =>
      voucherDigest({
        ...item.input,
        activeScriptPublicKey: item.input.activeScriptPublicKey.slice(4),
      }),
    ).toThrow("activeScriptPublicKey version must be 0");
  });
});

describe("channel id vectors", () => {
  it("matches immutable channel config digest", () => {
    const vector = readJson<ChannelVector>("vectors/channel-id/base.json");
    expect(channelIdPreimageHex(vector.input)).toBe(vector.expected.preimage);
    expect(channelId(vector.input)).toBe(vector.expected.channelId);
    expect(validateChannelId(vector.input, vector.expected.channelId)).toBe(true);
  });
});

describe("x402 HTTP vectors", () => {
  for (const file of listJson("vectors/x402-http")) {
    it(`roundtrips deterministic base64 headers for ${file}`, () => {
      const vector = readJson<HttpVector>(file);

      expect(encodePaymentRequiredHeader(vector.paymentRequired)).toBe(vector.headers.paymentRequired);
      expect(encodePaymentSignatureHeader(vector.paymentPayload)).toBe(vector.headers.paymentSignature);
      expect(encodePaymentResponseHeader(vector.settlementResponse)).toBe(vector.headers.paymentResponse);

      expect(decodePaymentRequiredHeader(vector.headers.paymentRequired)).toEqual(vector.paymentRequired);
      expect(decodePaymentSignatureHeader(vector.headers.paymentSignature)).toEqual(vector.paymentPayload);
      expect(decodePaymentResponseHeader(vector.headers.paymentResponse)).toEqual(vector.settlementResponse);
    });
  }

  it("rejects non-JSON values before encoding headers", () => {
    const vector = readJson<HttpVector>("vectors/x402-http/batch-voucher.json");

    expect(() =>
      encodePaymentRequiredHeader({
        ...vector.paymentRequired,
        extensions: {
          nonJson: undefined,
        },
      }),
    ).toThrow("JSON-serializable");
  });

  it("rejects non-plain object values before encoding headers", () => {
    const vector = readJson<HttpVector>("vectors/x402-http/batch-voucher.json");

    expect(() =>
      encodePaymentRequiredHeader({
        ...vector.paymentRequired,
        extensions: {
          when: new Date("2026-07-01T00:00:00.000Z"),
          map: new Map([["key", "value"]]),
        },
      }),
    ).toThrow("JSON-serializable");
  });

  it("accepts mixed exact and batch-settlement offers in one envelope", () => {
    const exact = readJson<HttpVector>("vectors/x402-http/exact-transaction.json");
    const batch = readJson<HttpVector>("vectors/x402-http/batch-voucher.json");
    const paymentRequired: PaymentRequired = {
      ...exact.paymentRequired,
      accepts: [exact.paymentRequired.accepts[0]!, batch.paymentRequired.accepts[0]!],
    };

    expect(validateSchemaById("https://kaspa-x402.org/schemas/payment-required.schema.json", paymentRequired).ok).toBe(true);
    expect(decodePaymentRequiredHeader(encodePaymentRequiredHeader(paymentRequired))).toEqual(paymentRequired);
    expect(validatePaymentRetry({ paymentRequired, paymentPayload: exact.paymentPayload }).ok).toBe(true);
    expect(validatePaymentRetry({ paymentRequired, paymentPayload: batch.paymentPayload }).ok).toBe(true);
  });

  it("rejects empty recipients and zero timeout requirements", () => {
    const exact = readJson<HttpVector>("vectors/x402-http/exact-transaction.json");

    expectFailureCode(
      validateSchemaById("https://kaspa-x402.org/schemas/payment-required.schema.json", {
        ...exact.paymentRequired,
        accepts: [{ ...exact.paymentRequired.accepts[0]!, payTo: "" }],
      }),
      "invalid_kaspa_x402_payload",
    );
    expectFailureCode(
      validatePaymentRequired({
        ...exact.paymentRequired,
        accepts: [{ ...exact.paymentRequired.accepts[0]!, maxTimeoutSeconds: 0 }],
      }),
      "invalid_kaspa_x402_payload",
    );
  });

  it("narrows envelopes that mix Kaspa entries with entries from other schemes or networks", () => {
    const exact = readJson<HttpVector>("vectors/x402-http/exact-transaction.json");
    const kaspaEntry = exact.paymentRequired.accepts[0]!;
    const envelope = {
      ...exact.paymentRequired,
      accepts: [foreignEvmEntry(), kaspaEntry, foreignUptoEntry()],
    };

    expect(validateSchemaById("https://kaspa-x402.org/schemas/payment-required.schema.json", envelope).ok).toBe(false);

    const decoded = decodePaymentRequiredEnvelopeHeader(encodePaymentRequiredEnvelopeHeader(envelope));
    const narrowed = narrowPaymentRequiredEnvelope(decoded);
    expect(narrowed.ok).toBe(true);
    if (!narrowed.ok) return;
    expect(narrowed.value.paymentRequired.accepts).toEqual([kaspaEntry]);
    expect(narrowed.value.skippedAccepts).toHaveLength(2);
    expect(validatePaymentRetry({ paymentRequired: narrowed.value.paymentRequired, paymentPayload: exact.paymentPayload }).ok).toBe(true);
  });

  it("rejects envelopes without any Kaspa entry instead of narrowing to an empty offer", () => {
    const exact = readJson<HttpVector>("vectors/x402-http/exact-transaction.json");
    const envelope = {
      ...exact.paymentRequired,
      accepts: [foreignEvmEntry(), foreignUptoEntry()],
    };

    const narrowed = narrowPaymentRequiredEnvelope(envelope);
    expect(narrowed.ok).toBe(false);
    if (narrowed.ok) return;
    expect(narrowed.error.code).toBe("invalid_kaspa_x402_accepted");
  });

  it("keeps single Kaspa requirement validation strict for narrowed entries", () => {
    const exact = readJson<HttpVector>("vectors/x402-http/exact-transaction.json");
    expect(validateKaspaPaymentRequirement(exact.paymentRequired.accepts[0]).ok).toBe(true);
    expect(validateKaspaPaymentRequirement(foreignEvmEntry()).ok).toBe(false);
    expect(validateKaspaPaymentRequirement(foreignUptoEntry()).ok).toBe(false);
  });
});

describe("MCP helpers", () => {
  it("only parses payment requirements from error tool results", () => {
    const vector = readJson<HttpVector>("vectors/x402-http/exact-transaction.json");
    const challenge = mcpPaymentRequiredResult(vector.paymentRequired);

    expect(challenge.structuredContent).toEqual(vector.paymentRequired);
    expect(challenge.content?.[0]?.text).toBe(JSON.stringify(vector.paymentRequired));
    expect(readMcpPaymentRequired(challenge)?.accepts[0]).toEqual(vector.paymentRequired.accepts[0]);
    expect(readMcpPaymentRequired({ ...challenge, isError: false })).toBeUndefined();
    expect(readMcpPaymentRequired({ structuredContent: challenge.structuredContent, content: challenge.content })).toBeUndefined();
  });

  it("reads mixed challenges from upstream servers without rejecting the envelope", () => {
    const vector = readJson<HttpVector>("vectors/x402-http/exact-transaction.json");
    const kaspaEntry = vector.paymentRequired.accepts[0]!;
    const mixed = {
      ...vector.paymentRequired,
      accepts: [foreignEvmEntry(), kaspaEntry, foreignUptoEntry()],
    };
    const challenge = {
      isError: true,
      structuredContent: mixed,
      content: [{ type: "text" as const, text: JSON.stringify(mixed) }],
    };

    const envelope = readMcpPaymentRequired(challenge);
    expect(envelope?.accepts).toHaveLength(3);

    const narrowed = narrowPaymentRequiredEnvelope(envelope);
    expect(narrowed.ok).toBe(true);
    if (!narrowed.ok) return;
    expect(narrowed.value.paymentRequired.accepts).toEqual([kaspaEntry]);
  });

  it("emits settlement failures as payment challenges with settlement metadata", () => {
    const vector = readJson<HttpVector>("vectors/x402-http/exact-transaction.json");
    const settlement: SettlementResponse = {
      success: false,
      transaction: "",
      network: "kaspa:testnet-10",
      errorReason: "invalid_transaction_state",
    };

    const result = mcpSettlementFailureResult(vector.paymentRequired, settlement);
    const expectedChallenge = { ...vector.paymentRequired, error: "invalid_transaction_state" };

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual(expectedChallenge);
    expect(result.content?.[0]?.text).toBe(JSON.stringify(expectedChallenge));
    expect(readMcpPaymentRequired(result)?.error).toBe("invalid_transaction_state");
    expect(readMcpPaymentResponse(result)).toEqual(settlement);
  });
});

describe("settlement response vectors", () => {
  for (const file of listJson("vectors/settlement-response")) {
    it(`validates ${file}`, () => {
      const vector = readJson<{ response: SettlementResponse; correctivePaymentRequired?: PaymentRequired }>(file);
      expect(validateSchemaById("https://kaspa-x402.org/schemas/settlement-response.schema.json", vector.response).ok).toBe(true);
      if (vector.correctivePaymentRequired) {
        expect(validateSchemaById("https://kaspa-x402.org/schemas/payment-required.schema.json", vector.correctivePaymentRequired).ok).toBe(true);
      }
    });
  }
});

describe("negative vectors", () => {
  for (const file of listJson("vectors/negative")) {
    it(`rejects ${file} with the expected error`, () => {
      const vector = readJson<NegativeVector>(file);

      if (vector.kind === "negative") {
        expectFailureCode(validateSchemaById(vector.schema, vector.value), vector.expectedError);
        return;
      }

      if (vector.scenario === "payment-identifier-conflict") {
        expectFailureCode(validatePaymentIdentifierReuse(vector.first, vector.second), vector.expectedError);
        return;
      }

      expectFailureCode(
        validatePaymentRetry({
          paymentRequired: vector.paymentRequired,
          paymentPayload: vector.paymentPayload,
        }),
        vector.expectedError,
      );
    });
  }
});

describe("payment-identifier semantic validation", () => {
  it("treats request hashes as case-insensitive hex", () => {
    const first: PaymentIdentifierObservation = {
      extensionInfo: {
        required: true,
        id: "pay_7d5d747be160e280504c099d984bcfe0",
      },
      requestHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
    const second: PaymentIdentifierObservation = {
      extensionInfo: {
        required: true,
        id: "pay_7d5d747be160e280504c099d984bcfe0",
      },
      requestHash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    };

    expect(validatePaymentIdentifierReuse(first, second).ok).toBe(true);
  });

  it("rejects malformed echoed payment-identifier info before accepting a retry", () => {
    const vector = readJson<HttpVector>("vectors/x402-http/batch-voucher.json");
    const schema = paymentIdentifierExtension({ required: true }).schema;
    const result = validatePaymentRetry({
      paymentRequired: {
        ...vector.paymentRequired,
        extensions: {
          "payment-identifier": {
            info: { required: true },
            schema,
          },
        },
      },
      paymentPayload: {
        ...vector.paymentPayload,
        extensions: {
          "payment-identifier": {
            info: { id: "pay_7d5d747be160e280504c099d984bcfe0" },
            schema,
          },
        },
      },
    });

    expectFailureCode(result, "invalid_kaspa_payment_identifier");
  });

  it("rejects malformed advertised payment-identifier info before accepting a retry", () => {
    const vector = readJson<HttpVector>("vectors/x402-http/batch-voucher.json");
    const schema = paymentIdentifierExtension({ required: true }).schema;
    const result = validatePaymentRetry({
      paymentRequired: {
        ...vector.paymentRequired,
        extensions: {
          "payment-identifier": {
            info: { required: "true" },
            schema,
          },
        },
      },
      paymentPayload: vector.paymentPayload,
    });

    expectFailureCode(result, "invalid_kaspa_payment_identifier");
  });

  it("rejects non-object payment-identifier info before accepting a retry", () => {
    const vector = readJson<HttpVector>("vectors/x402-http/batch-voucher.json");
    const schema = paymentIdentifierExtension({ required: true }).schema;
    const result = validatePaymentRetry({
      paymentRequired: {
        ...vector.paymentRequired,
        extensions: {
          "payment-identifier": {
            info: "bad",
            schema,
          },
        },
      },
      paymentPayload: vector.paymentPayload,
    });

    expectFailureCode(result, "invalid_kaspa_payment_identifier");
  });

  it("rejects non-string payment-identifier ids before accepting a retry", () => {
    const vector = readJson<HttpVector>("vectors/x402-http/batch-voucher.json");
    const schema = paymentIdentifierExtension({ required: true }).schema;
    const result = validatePaymentRetry({
      paymentRequired: {
        ...vector.paymentRequired,
        extensions: {
          "payment-identifier": {
            info: { required: true },
            schema,
          },
        },
      },
      paymentPayload: {
        ...vector.paymentPayload,
        extensions: {
          "payment-identifier": {
            info: { required: true, id: 123 },
            schema,
          },
        },
      },
    });

    expectFailureCode(result, "invalid_kaspa_payment_identifier");
  });

  it("validates payment-identifier info against the advertised schema", () => {
    const vector = readJson<HttpVector>("vectors/x402-http/batch-voucher.json");
    const schema = {
      type: "object",
      required: ["required", "tenant"],
      properties: {
        required: { type: "boolean" },
        id: { type: "string" },
        tenant: { const: "tenant-a" },
      },
      additionalProperties: true,
    };
    const result = validatePaymentRetry({
      paymentRequired: {
        ...vector.paymentRequired,
        extensions: {
          "payment-identifier": {
            info: { required: true, tenant: "tenant-a" },
            schema,
          },
        },
      },
      paymentPayload: {
        ...vector.paymentPayload,
        extensions: {
          "payment-identifier": {
            info: { required: true, id: "pay_7d5d747be160e280504c099d984bcfe0" },
            schema,
          },
        },
      },
    });

    expectFailureCode(result, "invalid_kaspa_payment_identifier");
  });

  it("enforces type-less enum constraints in advertised payment-identifier schemas", () => {
    const vector = readJson<HttpVector>("vectors/x402-http/batch-voucher.json");
    const schema = {
      type: "object",
      required: ["required", "tenant"],
      properties: {
        required: { type: "boolean" },
        id: { type: "string" },
        tenant: { enum: ["tenant-a"] },
      },
      additionalProperties: true,
    };
    const result = validatePaymentRetry({
      paymentRequired: {
        ...vector.paymentRequired,
        extensions: {
          "payment-identifier": {
            info: { required: true, tenant: "tenant-a" },
            schema,
          },
        },
      },
      paymentPayload: {
        ...vector.paymentPayload,
        extensions: {
          "payment-identifier": {
            info: { required: true, tenant: "tenant-b", id: "pay_7d5d747be160e280504c099d984bcfe0" },
            schema,
          },
        },
      },
    });

    expectFailureCode(result, "invalid_kaspa_payment_identifier");
  });

  it("rejects unsupported advertised payment-identifier schema references", () => {
    const vector = readJson<HttpVector>("vectors/x402-http/batch-voucher.json");
    const schema = {
      type: "object",
      required: ["required", "tenant"],
      properties: {
        required: { type: "boolean" },
        id: { type: "string" },
        tenant: { $ref: "#/$defs/tenant" },
      },
      $defs: {
        tenant: { const: "tenant-a" },
      },
      additionalProperties: true,
    };
    const result = validatePaymentRetry({
      paymentRequired: {
        ...vector.paymentRequired,
        extensions: {
          "payment-identifier": {
            info: { required: true, tenant: "tenant-a" },
            schema,
          },
        },
      },
      paymentPayload: {
        ...vector.paymentPayload,
        extensions: {
          "payment-identifier": {
            info: { required: true, tenant: "tenant-a", id: "pay_7d5d747be160e280504c099d984bcfe0" },
            schema,
          },
        },
      },
    });

    expectFailureCode(result, "invalid_kaspa_payment_identifier");
    if (result.ok) throw new Error("expected unsupported schema failure");
    expect(result.error.message).toBe("payment-identifier extension schema is invalid");
  });

  it("rejects unsupported advertised payment-identifier schema composition", () => {
    const vector = readJson<HttpVector>("vectors/x402-http/batch-voucher.json");
    const schema = {
      oneOf: [
        {
          type: "object",
          required: ["required"],
          properties: { required: { type: "boolean" } },
        },
      ],
    };
    const result = validatePaymentRetry({
      paymentRequired: {
        ...vector.paymentRequired,
        extensions: {
          "payment-identifier": {
            info: { required: true },
            schema,
          },
        },
      },
      paymentPayload: {
        ...vector.paymentPayload,
        extensions: {
          "payment-identifier": {
            info: { required: true, id: "pay_7d5d747be160e280504c099d984bcfe0" },
            schema,
          },
        },
      },
    });

    expectFailureCode(result, "invalid_kaspa_payment_identifier");
  });

  it("accepts payment-identifier retries that preserve advertised info and schema", () => {
    const vector = readJson<HttpVector>("vectors/x402-http/batch-voucher.json");
    const schema = {
      type: "object",
      required: ["required", "tenant"],
      properties: {
        required: { type: "boolean" },
        id: { type: "string" },
        tenant: { const: "tenant-a" },
      },
      additionalProperties: true,
    };
    const result = validatePaymentRetry({
      paymentRequired: {
        ...vector.paymentRequired,
        extensions: {
          "payment-identifier": {
            info: { required: true, tenant: "tenant-a" },
            schema,
          },
        },
      },
      paymentPayload: {
        ...vector.paymentPayload,
        extensions: {
          "payment-identifier": {
            info: { required: true, tenant: "tenant-a", id: "pay_7d5d747be160e280504c099d984bcfe0" },
            schema,
          },
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("rejects payment-identifier retries that strip advertised info or schema", () => {
    const vector = readJson<HttpVector>("vectors/x402-http/batch-voucher.json");
    const advertisedSchema = {
      type: "object",
      required: ["required", "tenant"],
      properties: {
        required: { type: "boolean" },
        id: { type: "string" },
        tenant: { const: "tenant-a" },
      },
      additionalProperties: true,
    };
    const looseSchema = paymentIdentifierExtension({ required: true }).schema;
    const result = validatePaymentRetry({
      paymentRequired: {
        ...vector.paymentRequired,
        extensions: {
          "payment-identifier": {
            info: { required: true, tenant: "tenant-a" },
            schema: advertisedSchema,
          },
        },
      },
      paymentPayload: {
        ...vector.paymentPayload,
        extensions: {
          "payment-identifier": {
            info: { required: true, id: "pay_7d5d747be160e280504c099d984bcfe0" },
            schema: looseSchema,
          },
        },
      },
    });

    expectFailureCode(result, "invalid_kaspa_payment_identifier");
  });

  it("rejects payment-identifier retries that preserve info but replace the schema", () => {
    const vector = readJson<HttpVector>("vectors/x402-http/batch-voucher.json");
    const advertisedSchema = {
      type: "object",
      required: ["required", "tenant"],
      properties: {
        required: { type: "boolean" },
        id: { type: "string" },
        tenant: { const: "tenant-a" },
      },
      additionalProperties: true,
    };
    const swappedSchema = {
      type: "object",
      required: ["required", "tenant"],
      properties: {
        required: { type: "boolean" },
        id: { type: "string" },
        tenant: { type: "string" },
      },
      additionalProperties: true,
    };
    const result = validatePaymentRetry({
      paymentRequired: {
        ...vector.paymentRequired,
        extensions: {
          "payment-identifier": {
            info: { required: true, tenant: "tenant-a" },
            schema: advertisedSchema,
          },
        },
      },
      paymentPayload: {
        ...vector.paymentPayload,
        extensions: {
          "payment-identifier": {
            info: { required: true, tenant: "tenant-a", id: "pay_7d5d747be160e280504c099d984bcfe0" },
            schema: swappedSchema,
          },
        },
      },
    });

    expectFailureCode(result, "invalid_kaspa_payment_identifier");
    if (result.ok) throw new Error("expected schema echo failure");
    expect(result.error.message).toBe("payment-identifier extension schema must echo the advertised schema");
  });

  it("returns a stable validation error for non-JSON accepted fields", () => {
    const vector = readJson<HttpVector>("vectors/x402-http/batch-voucher.json");
    const result = validatePaymentRetry({
      paymentRequired: vector.paymentRequired,
      paymentPayload: {
        ...vector.paymentPayload,
        accepted: {
          ...vector.paymentPayload.accepted,
          extra: {
            ...vector.paymentPayload.accepted.extra,
            undefinedField: undefined,
          },
        },
      },
    });

    expectFailureCode(result, "invalid_kaspa_x402_payload");
  });
});

describe("schema dispatch", () => {
  it("validates PaymentRequirements extra by schema id", () => {
    expect(
      validateSchemaById("https://kaspa-x402.org/schemas/kaspa-requirements-extra.schema.json", {
        binding: "kaspa-exact-v1",
      }).ok,
    ).toBe(true);
  });
});
