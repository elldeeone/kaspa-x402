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
const HEX_BYTES_PATTERN = /^(?:[0-9a-fA-F]{2})*$/;
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

function uptoAuthorizationPreimage(input) {
  const requestHashBytes = hexToBytes(input.requestHash);
  return Buffer.concat([
    sha256(Buffer.from("kaspa:x402:upto-authorization:v1", "utf8")),
    sha256(Buffer.from(input.network, "utf8")),
    sha256(Buffer.from("KAS", "utf8")),
    sha256(Buffer.from(input.payTo, "utf8")),
    sha256(Buffer.from(input.refundAddress, "utf8")),
    hexToBytes(input.clientPublicKey),
    hexToBytes(input.serverPublicKey),
    hexToBytes(input.authorizationOutpoint.txid),
    le32(input.authorizationOutpoint.index),
    le64(input.maxAmountSompi),
    le64(input.validAfterDaa),
    le64(input.validBeforeDaa),
    hexToBytes(input.nonce),
    sha256(requestHashBytes),
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

function assertUptoDigestInputMatchesPayload(vector, label) {
  const accepted = vector.paymentPayload.accepted;
  const payload = vector.paymentPayload.payload;
  const authorization = payload.authorization;
  const input = vector.authorizationDigest.input;
  const expectedFields = {
    network: accepted.network,
    payTo: authorization.payTo,
    refundAddress: payload.refundAddress,
    clientPublicKey: payload.clientPublicKey,
    serverPublicKey: authorization.serverPublicKey,
    authorizationOutpoint: payload.authorizationOutpoint,
    maxAmountSompi: authorization.maxAmountSompi,
    validAfterDaa: authorization.validAfterDaa,
    validBeforeDaa: authorization.validBeforeDaa,
    nonce: authorization.nonce,
    requestHash: authorization.requestHash,
  };
  for (const [key, expected] of Object.entries(expectedFields)) {
    if (stableStringify(input[key]) !== stableStringify(expected)) {
      throw new Error(`${label}: authorizationDigest.input.${key} does not match paymentPayload`);
    }
  }
}

function assertHexBytes(value, label) {
  if (typeof value !== "string" || !HEX_BYTES_PATTERN.test(value)) {
    throw new Error(`${label} must be an even-length hex byte string`);
  }
}

function assertHash32(value, label) {
  if (typeof value !== "string" || !HEX32_PATTERN.test(value)) {
    throw new Error(`${label} must be a 32-byte hex string`);
  }
}

function assertTxV1Vector(file, vector, expectedKind) {
  if (!vector.input || !vector.expected) {
    throw new Error(`${file}: tx-v1 vectors require input and expected`);
  }
  const artifact = vector.expected;
  if (artifact.format !== "kaspa-x402-tx-v1-reference-v1") {
    throw new Error(`${file}: unexpected tx-v1 artifact format`);
  }
  if (artifact.kind !== expectedKind) {
    throw new Error(`${file}: expected artifact kind ${expectedKind}`);
  }
  if (artifact.transaction?.version !== 1) {
    throw new Error(`${file}: transaction version must be 1`);
  }
  if (!isUint64String(artifact.transaction.mass)) throw new Error(`${file}: transaction.mass must be a uint64 string`);
  if (!Number.isSafeInteger(artifact.transaction.estimatedSerializedSize) || artifact.transaction.estimatedSerializedSize <= 0) {
    throw new Error(`${file}: estimatedSerializedSize must be a positive safe integer`);
  }
  assertHexBytes(artifact.serializedTransaction, `${file}:serializedTransaction`);
  assertHash32(artifact.transactionId, `${file}:transactionId`);
  assertHash32(artifact.transactionHash, `${file}:transactionHash`);
  assertEqual(artifact.serializedTransaction, artifact.hash?.preimage, `${file}:hash.preimage`);
  assertEqual(artifact.transactionId, artifact.txid?.digest, `${file}:txid.digest`);
  assertEqual(artifact.transactionHash, artifact.hash?.digest, `${file}:hash.digest`);
  assertHash32(artifact.txid?.payloadDigest, `${file}:txid.payloadDigest`);
  assertHexBytes(artifact.txid?.restPreimage, `${file}:txid.restPreimage`);
  assertHash32(artifact.txid?.restDigest, `${file}:txid.restDigest`);
  assertHexBytes(artifact.sighash?.preimage, `${file}:sighash.preimage`);
  assertHash32(artifact.sighash?.digest, `${file}:sighash.digest`);
  if (artifact.sighash?.hashType !== "all") {
    throw new Error(`${file}: only sighash-all vectors are supported`);
  }
  const computeBudget = artifact.compute?.computeBudget;
  const scriptUnitsEstimate = artifact.compute?.scriptUnitsEstimate;
  const scriptUnitAllowance = artifact.compute?.scriptUnitAllowance;
  if (!Number.isInteger(computeBudget) || computeBudget < 0 || computeBudget > 0xffff) {
    throw new Error(`${file}: compute budget must fit in uint16`);
  }
  if (!Number.isSafeInteger(scriptUnitsEstimate) || scriptUnitsEstimate < 0) {
    throw new Error(`${file}: script-unit estimate must be a non-negative integer`);
  }
  assertEqual(computeBudget * 10000 + 9999, scriptUnitAllowance, `${file}:scriptUnitAllowance`);
  if (scriptUnitAllowance < scriptUnitsEstimate) {
    throw new Error(`${file}: compute budget does not cover script-unit estimate`);
  }
  for (const [index, input] of (artifact.transaction.inputs ?? []).entries()) {
    assertHash32(input.previousOutpoint?.txid, `${file}:inputs[${index}].previousOutpoint.txid`);
    if (!isUint32(input.previousOutpoint?.index)) throw new Error(`${file}:inputs[${index}].previousOutpoint.index must fit in uint32`);
    assertHexBytes(input.signatureScript, `${file}:inputs[${index}].signatureScript`);
    if (!isUint64String(input.sequence)) throw new Error(`${file}:inputs[${index}].sequence must be a uint64 string`);
    if (input.computeBudget !== computeBudget) throw new Error(`${file}:inputs[${index}].computeBudget must match artifact compute budget`);
    assertHexBytes(input.utxo?.scriptPublicKey, `${file}:inputs[${index}].utxo.scriptPublicKey`);
    if (!isUint64String(input.utxo?.amount)) throw new Error(`${file}:inputs[${index}].utxo.amount must be a uint64 string`);
  }
  for (const [index, output] of (artifact.transaction.outputs ?? []).entries()) {
    if (!isUint64String(output.amount)) throw new Error(`${file}:outputs[${index}].amount must be a uint64 string`);
    assertHexBytes(output.scriptPublicKey, `${file}:outputs[${index}].scriptPublicKey`);
  }

  if (expectedKind === "batch-claim") {
    if (artifact.fee?.source !== "server-output") throw new Error(`${file}: claim fee source must be server-output`);
    if ((artifact.transaction.outputs ?? []).length !== 2) throw new Error(`${file}: claim vector must have two outputs`);
    assertHash32(artifact.voucherDigest, `${file}:voucherDigest`);
    assertEqual(artifact.continuation?.outputIndex, 1, `${file}:continuation.outputIndex`);
    assertEqual(artifact.continuation?.outpoint?.txid, artifact.transactionId, `${file}:continuation.outpoint.txid`);
  } else if (expectedKind === "batch-refund") {
    if (artifact.fee?.source !== "refund-output") throw new Error(`${file}: refund fee source must be refund-output`);
    if ((artifact.transaction.outputs ?? []).length !== 1) throw new Error(`${file}: refund vector must have one output`);
  }
}

function classifyUptoRejection(vector, rejection) {
  const paymentPayload = structuredClone(vector.paymentPayload);
  applyUptoMutation(paymentPayload, rejection.mutation);
  const accepted = paymentPayload.accepted;
  const payload = paymentPayload.payload;
  const authorization = payload.authorization;
  if (rejection.consumed === "outpoint" || rejection.consumed === "nonce") return "invalid_kaspa_upto_replay";
  const currentDaa = BigInt(rejection.currentDaa ?? authorization.validAfterDaa);
  if (
    BigInt(authorization.validAfterDaa) > BigInt(authorization.validBeforeDaa) ||
    BigInt(authorization.validBeforeDaa) > BigInt(accepted.extra.authorizationTimeoutDaa) ||
    currentDaa < BigInt(authorization.validAfterDaa) ||
    currentDaa > BigInt(authorization.validBeforeDaa)
  ) {
    return "invalid_kaspa_upto_expired";
  }
  if (authorization.payTo !== accepted.payTo) return "invalid_kaspa_upto_recipient";
  if (authorization.maxAmountSompi !== accepted.amount) return "invalid_kaspa_upto_max_amount";
  return "ok";
}

function applyUptoMutation(paymentPayload, mutation) {
  if (!mutation) return;
  const authorization = paymentPayload.payload.authorization;
  for (const [path, value] of Object.entries(mutation)) {
    switch (path) {
      case "authorization.validBeforeDaa":
        authorization.validBeforeDaa = value;
        break;
      case "authorization.payTo":
        authorization.payTo = value;
        break;
      case "authorization.maxAmountSompi":
        authorization.maxAmountSompi = value;
        break;
      default:
        throw new Error(`unsupported upto rejection mutation: ${path}`);
    }
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
    case "upto-authorization": {
      assertValid(ajv, "https://kaspa-x402.org/schemas/payment-required.schema.json", vector.paymentRequired, `${file}:paymentRequired`);
      assertValid(ajv, "https://kaspa-x402.org/schemas/payment-payload.schema.json", vector.paymentPayload, `${file}:paymentPayload`);
      assertAcceptedOffered(vector.paymentRequired, vector.paymentPayload, file);
      assertUptoDigestInputMatchesPayload(vector, file);
      const preimage = uptoAuthorizationPreimage(vector.authorizationDigest.input).toString("hex");
      assertEqual(preimage, vector.authorizationDigest.expected.preimage, `${file}:authorizationDigest.preimage`);
      assertEqual(sha256(Buffer.from(preimage, "hex")).toString("hex"), vector.authorizationDigest.expected.digest, `${file}:authorizationDigest.digest`);
      assertEqual(
        vector.paymentPayload.payload.authorization.signature,
        `${vector.authorizationDigest.expected.digest}${vector.authorizationDigest.expected.digest}`,
        `${file}:authorization.signature`,
      );
      assertValid(
        ajv,
        "https://kaspa-x402.org/schemas/settlement-response.schema.json",
        vector.settlementResponses.zeroCharge,
        `${file}:settlementResponses.zeroCharge`,
      );
      assertValid(
        ajv,
        "https://kaspa-x402.org/schemas/settlement-response.schema.json",
        vector.settlementResponses.nonzero,
        `${file}:settlementResponses.nonzero`,
      );
      if (vector.settlementResponses.zeroCharge.transaction !== "" || vector.settlementResponses.zeroCharge.amount !== undefined) {
        throw new Error(`${file}: zero-charge upto response must not move value`);
      }
      if (!isUint64String(vector.settlementResponses.nonzero.amount) || BigInt(vector.settlementResponses.nonzero.amount) <= 0n) {
        throw new Error(`${file}: nonzero upto response must include a positive amount`);
      }
      assertEqual(Buffer.from(stableStringify(vector.paymentRequired)).toString("base64"), vector.headers.paymentRequired, `${file}:PAYMENT-REQUIRED`);
      assertEqual(Buffer.from(stableStringify(vector.paymentPayload)).toString("base64"), vector.headers.paymentSignature, `${file}:PAYMENT-SIGNATURE`);
      assertEqual(
        Buffer.from(stableStringify(vector.settlementResponses.zeroCharge)).toString("base64"),
        vector.headers.zeroChargeResponse,
        `${file}:zeroChargeResponse`,
      );
      assertEqual(
        Buffer.from(stableStringify(vector.settlementResponses.nonzero)).toString("base64"),
        vector.headers.nonzeroResponse,
        `${file}:nonzeroResponse`,
      );
      for (const rejection of vector.rejections ?? []) {
        if (typeof rejection.name !== "string" || typeof rejection.expectedError !== "string") {
          throw new Error(`${file}: upto rejection entries require name and expectedError`);
        }
        assertEqual(classifyUptoRejection(vector, rejection), rejection.expectedError, `${file}:${rejection.name}:expectedError`);
      }
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
    case "tx-v1-batch-claim": {
      assertTxV1Vector(file, vector, "batch-claim");
      break;
    }
    case "tx-v1-batch-refund": {
      assertTxV1Vector(file, vector, "batch-refund");
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
