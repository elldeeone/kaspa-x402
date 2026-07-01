import Ajv2020 from "ajv/dist/2020.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemasDir = path.join(root, "schemas");
const vectorsDir = path.join(root, "vectors");
const U64_DECIMAL_PATTERN =
  /^(?:0|[1-9][0-9]{0,18}|1[0-7][0-9]{18}|18[0-3][0-9]{17}|184[0-3][0-9]{16}|1844[0-5][0-9]{15}|18446[0-6][0-9]{14}|184467[0-3][0-9]{13}|1844674[0-3][0-9]{12}|184467440[0-6][0-9]{10}|1844674407[0-2][0-9]{9}|18446744073[0-6][0-9]{8}|1844674407370[0-8][0-9]{6}|18446744073709[0-4][0-9]{5}|184467440737095[0-4][0-9]{4}|18446744073709550[0-9]{3}|18446744073709551[0-5][0-9]{2}|1844674407370955160[0-9]{1}|1844674407370955161[0-4]|18446744073709551615)$/;
const HEX32_PATTERN = /^[0-9a-fA-F]{64}$/;
const SIGNATURE64_PATTERN = /^[0-9a-fA-F]{128}$/;
const U32_MAX = 4294967295;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function listJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return listJsonFiles(fullPath);
      return entry.isFile() && entry.name.endsWith(".json") ? [fullPath] : [];
    })
    .sort();
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest();
}

function hexToBytes(hex) {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) {
    throw new Error(`invalid byte hex: ${hex}`);
  }
  return Buffer.from(hex, "hex");
}

function le32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(Number(value));
  return buffer;
}

function le64(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isUint32(value) {
  return Number.isInteger(value) && value >= 0 && value <= U32_MAX;
}

function isUint64String(value) {
  return typeof value === "string" && U64_DECIMAL_PATTERN.test(value);
}

function expectedBindingForScheme(scheme) {
  return {
    exact: "kaspa-exact-v1",
    upto: "kaspa-upto-v1",
    "batch-settlement": "kaspa-escrow-v1",
  }[scheme];
}

function expectedPayloadTypesForScheme(scheme) {
  return {
    exact: ["exact-transfer"],
    upto: ["upto-authorization"],
    "batch-settlement": ["deposit-voucher", "voucher", "claim", "refund"],
  }[scheme];
}

function classifyInvalidValue(schemaId, value) {
  if (schemaId === "https://kaspa-x402.org/schemas/payment-required.schema.json") {
    const requirement = value?.accepts?.[0];
    if (value?.x402Version !== 2) return "invalid_kaspa_x402_version";
    if (!requirement || !["exact", "upto", "batch-settlement"].includes(requirement.scheme)) return "invalid_kaspa_x402_scheme";
    if (!["kaspa:mainnet", "kaspa:testnet-10"].includes(requirement.network)) return "invalid_kaspa_x402_network";
    if (requirement.asset !== "KAS") return "invalid_kaspa_x402_asset";
    if (!isUint64String(requirement.amount)) return "invalid_kaspa_x402_amount";
    if (requirement.extra?.binding !== expectedBindingForScheme(requirement.scheme)) return "invalid_kaspa_x402_binding";
    return "invalid_kaspa_x402_payload";
  }

  if (schemaId === "https://kaspa-x402.org/schemas/payment-payload.schema.json") {
    const expectedTypes = expectedPayloadTypesForScheme(value?.accepted?.scheme);
    if (expectedTypes && !expectedTypes.includes(value?.payload?.type)) return "invalid_kaspa_payment_payload_type";
    return "invalid_kaspa_x402_payload";
  }

  if (schemaId === "https://kaspa-x402.org/schemas/kaspa-payment-payload.schema.json") {
    if (value?.clientPublicKey !== undefined && !HEX32_PATTERN.test(value.clientPublicKey)) return "invalid_kaspa_public_key";
    if (
      value?.fundingOutpoint !== undefined &&
      (!HEX32_PATTERN.test(value.fundingOutpoint.txid) || !isUint32(value.fundingOutpoint.index))
    ) {
      return "invalid_kaspa_outpoint";
    }
    if (value?.voucher?.signature !== undefined && !SIGNATURE64_PATTERN.test(value.voucher.signature)) return "invalid_kaspa_signature";
    if (value?.voucher?.amount !== undefined && !isUint64String(value.voucher.amount)) return "invalid_kaspa_x402_amount";
    if (value?.claimAmount !== undefined && !isUint64String(value.claimAmount)) return "invalid_kaspa_x402_amount";
    if (value?.refundAmount !== undefined && !isUint64String(value.refundAmount)) return "invalid_kaspa_x402_amount";
    return "invalid_kaspa_x402_payload";
  }

  if (schemaId === "https://kaspa-x402.org/schemas/settlement-response.schema.json") {
    if (value?.success === true && value?.transaction === "" && !value?.extra?.commitmentId) return "invalid_kaspa_settlement_response";
    if (typeof value?.transaction === "string" && !/^(?:|[0-9a-fA-F]{64})$/.test(value.transaction)) return "invalid_kaspa_transaction";
    return "invalid_kaspa_settlement_response";
  }

  return "invalid_kaspa_x402_payload";
}

function voucherPreimage(input) {
  return Buffer.concat([
    sha256(Buffer.from("kaspa:x402:escrow-voucher:v1", "utf8")),
    sha256(Buffer.from(input.network, "utf8")),
    sha256(hexToBytes(input.activeScriptPublicKey)),
    hexToBytes(input.outpoint.txid),
    le32(input.outpoint.index),
    le64(input.amount),
  ]);
}

function channelIdPreimage(input) {
  return Buffer.concat([
    sha256(Buffer.from("kaspa:x402:channel:v1", "utf8")),
    sha256(Buffer.from(input.network, "utf8")),
    sha256(Buffer.from("KAS", "utf8")),
    sha256(Buffer.from(input.templateId, "utf8")),
    hexToBytes(input.clientPublicKey),
    hexToBytes(input.serverPublicKey),
    sha256(Buffer.from(input.payTo, "utf8")),
    sha256(Buffer.from(input.refundAddress, "utf8")),
    le64(input.refundTimeoutDaa),
    hexToBytes(input.salt),
  ]);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch\nexpected: ${expected}\nactual:   ${actual}`);
  }
}

function assertValid(ajv, schemaId, value, label) {
  const validate = ajv.getSchema(schemaId);
  if (!validate) throw new Error(`schema not loaded: ${schemaId}`);
  if (!validate(value)) {
    throw new Error(`${label} failed ${schemaId}: ${ajv.errorsText(validate.errors)}`);
  }
}

function assertInvalid(ajv, schemaId, value, label, expectedError) {
  const validate = ajv.getSchema(schemaId);
  if (!validate) throw new Error(`schema not loaded: ${schemaId}`);
  if (validate(value)) {
    throw new Error(`${label} unexpectedly passed ${schemaId}`);
  }
  if (expectedError) {
    const actualError = classifyInvalidValue(schemaId, value);
    assertEqual(actualError, expectedError, `${label}:expectedError`);
  }
}

function assertAcceptedOffered(paymentRequired, paymentPayload, label) {
  const accepted = stableStringify(paymentPayload.accepted);
  const offered = paymentRequired.accepts.some((requirement) => stableStringify(requirement) === accepted);
  if (!offered) {
    throw new Error(`${label}: accepted PaymentRequirements is not present in PaymentRequired.accepts`);
  }
}

function validateVector(ajv, file, vector) {
  switch (vector.kind) {
    case "voucher-digest": {
      for (const item of vector.cases) {
        const preimage = voucherPreimage(item.input).toString("hex");
        assertEqual(preimage, item.expected.preimage, `${file}:${item.name}:preimage`);
        assertEqual(sha256(Buffer.from(preimage, "hex")).toString("hex"), item.expected.digest, `${file}:${item.name}:digest`);
      }
      break;
    }
    case "channel-id": {
      const preimage = channelIdPreimage(vector.input).toString("hex");
      assertEqual(preimage, vector.expected.preimage, `${file}:preimage`);
      assertEqual(sha256(Buffer.from(preimage, "hex")).toString("hex"), vector.expected.channelId, `${file}:channelId`);
      break;
    }
    case "x402-http": {
      assertValid(ajv, "https://kaspa-x402.org/schemas/payment-required.schema.json", vector.paymentRequired, `${file}:paymentRequired`);
      assertValid(ajv, "https://kaspa-x402.org/schemas/payment-payload.schema.json", vector.paymentPayload, `${file}:paymentPayload`);
      assertValid(ajv, "https://kaspa-x402.org/schemas/settlement-response.schema.json", vector.settlementResponse, `${file}:settlementResponse`);
      assertAcceptedOffered(vector.paymentRequired, vector.paymentPayload, file);
      assertEqual(Buffer.from(stableStringify(vector.paymentRequired)).toString("base64"), vector.headers.paymentRequired, `${file}:PAYMENT-REQUIRED`);
      assertEqual(Buffer.from(stableStringify(vector.paymentPayload)).toString("base64"), vector.headers.paymentSignature, `${file}:PAYMENT-SIGNATURE`);
      assertEqual(Buffer.from(stableStringify(vector.settlementResponse)).toString("base64"), vector.headers.paymentResponse, `${file}:PAYMENT-RESPONSE`);
      break;
    }
    case "settlement-response": {
      assertValid(ajv, "https://kaspa-x402.org/schemas/settlement-response.schema.json", vector.response, `${file}:response`);
      if (vector.correctivePaymentRequired) {
        assertValid(ajv, "https://kaspa-x402.org/schemas/payment-required.schema.json", vector.correctivePaymentRequired, `${file}:correctivePaymentRequired`);
      }
      break;
    }
    case "negative": {
      if (!vector.name || !vector.expectedError) {
        throw new Error(`${file}: negative vectors require name and expectedError`);
      }
      assertInvalid(ajv, vector.schema, vector.value, `${file}:${vector.name}`, vector.expectedError);
      break;
    }
    case "semantic-negative": {
      if (!vector.name || !vector.expectedError) {
        throw new Error(`${file}: semantic-negative vectors require name and expectedError`);
      }
      if (vector.scenario === "payment-identifier-conflict") {
        assertValid(ajv, "https://kaspa-x402.org/schemas/payment-identifier.schema.json", vector.first.extensionInfo, `${file}:first.extensionInfo`);
        assertValid(ajv, "https://kaspa-x402.org/schemas/payment-identifier.schema.json", vector.second.extensionInfo, `${file}:second.extensionInfo`);
        const firstId = vector.first.extensionInfo.id;
        const secondId = vector.second.extensionInfo.id;
        if (
          typeof firstId !== "string" ||
          typeof secondId !== "string" ||
          firstId !== secondId ||
          vector.first.requestHash === vector.second.requestHash ||
          !/^[0-9a-fA-F]{64}$/.test(vector.first.requestHash) ||
          !/^[0-9a-fA-F]{64}$/.test(vector.second.requestHash)
        ) {
          throw new Error(`${file}: payment-identifier-conflict must reuse id with a changed requestHash`);
        }
        assertEqual("kaspa_payment_identifier_conflict", vector.expectedError, `${file}:expectedError`);
      } else if (vector.scenario === "missing-payment-identifier") {
        assertValid(ajv, "https://kaspa-x402.org/schemas/payment-required.schema.json", vector.paymentRequired, `${file}:paymentRequired`);
        assertValid(ajv, "https://kaspa-x402.org/schemas/payment-payload.schema.json", vector.paymentPayload, `${file}:paymentPayload`);
        const paymentIdentifierInfo = vector.paymentRequired?.extensions?.["payment-identifier"]?.info;
        assertValid(ajv, "https://kaspa-x402.org/schemas/payment-identifier.schema.json", paymentIdentifierInfo, `${file}:paymentRequired.payment-identifier.info`);
        const required = paymentIdentifierInfo.required;
        const id = vector.paymentPayload?.extensions?.["payment-identifier"]?.info?.id;
        if (required !== true || typeof id === "string") {
          throw new Error(`${file}: missing-payment-identifier must advertise required:true and omit payload id`);
        }
        assertEqual("missing_kaspa_payment_identifier", vector.expectedError, `${file}:expectedError`);
      } else if (vector.scenario === "accepted-not-offered") {
        assertValid(ajv, "https://kaspa-x402.org/schemas/payment-required.schema.json", vector.paymentRequired, `${file}:paymentRequired`);
        assertValid(ajv, "https://kaspa-x402.org/schemas/payment-payload.schema.json", vector.paymentPayload, `${file}:paymentPayload`);
        const accepted = stableStringify(vector.paymentPayload.accepted);
        const offered = vector.paymentRequired.accepts.some((requirement) => stableStringify(requirement) === accepted);
        if (offered) {
          throw new Error(`${file}: accepted-not-offered must use an accepted object absent from PaymentRequired.accepts`);
        }
        assertEqual("invalid_kaspa_x402_accepted", vector.expectedError, `${file}:expectedError`);
      } else {
        throw new Error(`${file}: unknown semantic-negative scenario ${vector.scenario}`);
      }
      break;
    }
    case "tx-v1-plan": {
      if (!Array.isArray(vector.requiredFutureVectors) || vector.requiredFutureVectors.length === 0) {
        throw new Error(`${file}: tx-v1 plan must list required future vectors`);
      }
      break;
    }
    default:
      throw new Error(`${file}: unknown vector kind ${vector.kind}`);
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
for (const file of listJsonFiles(schemasDir)) {
  const schema = readJson(file);
  ajv.addSchema(schema);
}

for (const file of listJsonFiles(schemasDir)) {
  const schema = readJson(file);
  if (!ajv.getSchema(schema.$id)) {
    throw new Error(`schema failed to register: ${file}`);
  }
}

for (const file of listJsonFiles(vectorsDir)) {
  validateVector(ajv, path.relative(root, file), readJson(file));
}

console.log("schemas and vectors ok");
