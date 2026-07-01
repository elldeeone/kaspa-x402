import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  formatSompiString,
  isDecimalSompi,
  isKaspaX402Network,
  mcpPaymentRequiredResult,
  parseSompiString,
  readMcpPaymentRequired,
  validatePaymentIdentifierReuse,
  validatePaymentRetry,
  validateSchemaById,
  uptoAuthorizationDigest,
  uptoAuthorizationPreimageHex,
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

type UptoAuthorizationVector = {
  authorizationDigest: {
    input: Parameters<typeof uptoAuthorizationDigest>[0];
    expected: {
      preimage: string;
      digest: string;
    };
  };
  paymentRequired: PaymentRequired;
  paymentPayload: PaymentPayload;
  settlementResponses: {
    zeroCharge: SettlementResponse;
    nonzero: SettlementResponse;
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

describe("upto authorization vectors", () => {
  it("matches the capped one-shot authorization digest", () => {
    const vector = readJson<UptoAuthorizationVector>("vectors/upto/authorization.json");
    expect(uptoAuthorizationPreimageHex(vector.authorizationDigest.input)).toBe(vector.authorizationDigest.expected.preimage);
    expect(uptoAuthorizationDigest(vector.authorizationDigest.input)).toBe(vector.authorizationDigest.expected.digest);
    expect(validateSchemaById("https://kaspa-x402.org/schemas/payment-required.schema.json", vector.paymentRequired).ok).toBe(true);
    expect(validateSchemaById("https://kaspa-x402.org/schemas/payment-payload.schema.json", vector.paymentPayload).ok).toBe(true);
    expect(validateSchemaById("https://kaspa-x402.org/schemas/settlement-response.schema.json", vector.settlementResponses.zeroCharge).ok).toBe(true);
    expect(validateSchemaById("https://kaspa-x402.org/schemas/settlement-response.schema.json", vector.settlementResponses.nonzero).ok).toBe(true);
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
});

describe("MCP helpers", () => {
  it("only parses payment requirements from error tool results", () => {
    const vector = readJson<HttpVector>("vectors/x402-http/exact-transfer.json");
    const challenge = mcpPaymentRequiredResult(vector.paymentRequired);

    expect(challenge.structuredContent).toEqual(vector.paymentRequired);
    expect(challenge.content?.[0]?.text).toBe(JSON.stringify(vector.paymentRequired));
    expect(readMcpPaymentRequired(challenge)?.accepts[0]).toEqual(vector.paymentRequired.accepts[0]);
    expect(readMcpPaymentRequired({ ...challenge, isError: false })).toBeUndefined();
    expect(readMcpPaymentRequired({ structuredContent: challenge.structuredContent, content: challenge.content })).toBeUndefined();
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
    const result = validatePaymentRetry({
      paymentRequired: {
        ...vector.paymentRequired,
        extensions: {
          "payment-identifier": {
            info: { required: true },
          },
        },
      },
      paymentPayload: {
        ...vector.paymentPayload,
        extensions: {
          "payment-identifier": {
            info: { id: "pay_7d5d747be160e280504c099d984bcfe0" },
          },
        },
      },
    });

    expectFailureCode(result, "invalid_kaspa_payment_identifier");
  });

  it("rejects malformed advertised payment-identifier info before accepting a retry", () => {
    const vector = readJson<HttpVector>("vectors/x402-http/batch-voucher.json");
    const result = validatePaymentRetry({
      paymentRequired: {
        ...vector.paymentRequired,
        extensions: {
          "payment-identifier": {
            info: { required: "true" },
          },
        },
      },
      paymentPayload: vector.paymentPayload,
    });

    expectFailureCode(result, "invalid_kaspa_payment_identifier");
  });

  it("rejects non-object payment-identifier info before accepting a retry", () => {
    const vector = readJson<HttpVector>("vectors/x402-http/batch-voucher.json");
    const result = validatePaymentRetry({
      paymentRequired: {
        ...vector.paymentRequired,
        extensions: {
          "payment-identifier": {
            info: "bad",
          },
        },
      },
      paymentPayload: vector.paymentPayload,
    });

    expectFailureCode(result, "invalid_kaspa_payment_identifier");
  });

  it("rejects non-string payment-identifier ids before accepting a retry", () => {
    const vector = readJson<HttpVector>("vectors/x402-http/batch-voucher.json");
    const result = validatePaymentRetry({
      paymentRequired: {
        ...vector.paymentRequired,
        extensions: {
          "payment-identifier": {
            info: { required: true },
          },
        },
      },
      paymentPayload: {
        ...vector.paymentPayload,
        extensions: {
          "payment-identifier": {
            info: { required: true, id: 123 },
          },
        },
      },
    });

    expectFailureCode(result, "invalid_kaspa_payment_identifier");
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
