import Ajv2020 from "ajv/dist/2020.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const U64_DECIMAL_PATTERN =
  /^(?:0|[1-9][0-9]{0,18}|1[0-7][0-9]{18}|18[0-3][0-9]{17}|184[0-3][0-9]{16}|1844[0-5][0-9]{15}|18446[0-6][0-9]{14}|184467[0-3][0-9]{13}|1844674[0-3][0-9]{12}|184467440[0-6][0-9]{10}|1844674407[0-2][0-9]{9}|18446744073[0-6][0-9]{8}|1844674407370[0-8][0-9]{6}|18446744073709[0-4][0-9]{5}|184467440737095[0-4][0-9]{4}|18446744073709550[0-9]{3}|18446744073709551[0-5][0-9]{2}|1844674407370955160[0-9]{1}|1844674407370955161[0-4]|18446744073709551615)$/;
const HEX32_PATTERN = /^[0-9a-fA-F]{64}$/;
const GIT_COMMIT_PATTERN = /^[0-9a-fA-F]{40}$/;
const TX_V1_CONSENSUS_COMMIT = "ef1a093bcf8560fe05221b56f0c896f97e7d8d77";
const EXACT_CONSENSUS_COMMIT = "78257f273a26c4be085bab0f79437dee99ca8835";
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
    exact: "kaspa-exact-v2",
    "batch-settlement": "kaspa-escrow-v1",
  }[scheme];
}

function expectedPayloadTypesForScheme(scheme) {
  return {
    exact: ["exact-transaction"],
    "batch-settlement": ["deposit-voucher", "voucher", "claim", "refund"],
  }[scheme];
}

function classifyInvalidValue(schemaId, value) {
  if (
    schemaId === "https://kaspa-x402.org/schemas/payment-required.schema.json"
  ) {
    const requirement = value?.accepts?.[0];
    if (value?.x402Version !== 2) return "invalid_kaspa_x402_version";
    if (
      !requirement ||
      !["exact", "batch-settlement"].includes(requirement.scheme)
    )
      return "invalid_kaspa_x402_scheme";
    if (!["kaspa:mainnet", "kaspa:testnet-10"].includes(requirement.network))
      return "invalid_kaspa_x402_network";
    if (requirement.asset !== "KAS") return "invalid_kaspa_x402_asset";
    if (!isUint64String(requirement.amount)) return "invalid_kaspa_x402_amount";
    if (
      requirement.extra?.binding !==
      expectedBindingForScheme(requirement.scheme)
    )
      return "invalid_kaspa_x402_binding";
    return "invalid_kaspa_x402_payload";
  }

  if (
    schemaId === "https://kaspa-x402.org/schemas/payment-payload.schema.json"
  ) {
    const expectedTypes = expectedPayloadTypesForScheme(
      value?.accepted?.scheme,
    );
    if (expectedTypes && !expectedTypes.includes(value?.payload?.type))
      return "invalid_kaspa_payment_payload_type";
    return "invalid_kaspa_x402_payload";
  }

  if (
    schemaId ===
    "https://kaspa-x402.org/schemas/kaspa-payment-payload.schema.json"
  ) {
    if (
      value?.clientPublicKey !== undefined &&
      !HEX32_PATTERN.test(value.clientPublicKey)
    )
      return "invalid_kaspa_public_key";
    if (
      value?.fundingOutpoint !== undefined &&
      (!HEX32_PATTERN.test(value.fundingOutpoint.txid) ||
        !isUint32(value.fundingOutpoint.index))
    ) {
      return "invalid_kaspa_outpoint";
    }
    if (
      value?.voucher?.signature !== undefined &&
      !SIGNATURE64_PATTERN.test(value.voucher.signature)
    )
      return "invalid_kaspa_signature";
    if (
      value?.voucher?.amount !== undefined &&
      !isUint64String(value.voucher.amount)
    )
      return "invalid_kaspa_x402_amount";
    if (value?.claimAmount !== undefined && !isUint64String(value.claimAmount))
      return "invalid_kaspa_x402_amount";
    if (
      value?.refundAmount !== undefined &&
      !isUint64String(value.refundAmount)
    )
      return "invalid_kaspa_x402_amount";
    return "invalid_kaspa_x402_payload";
  }

  if (
    schemaId ===
    "https://kaspa-x402.org/schemas/settlement-response.schema.json"
  ) {
    if (value?.success === true && value?.transaction === "")
      return "invalid_kaspa_settlement_response";
    if (
      typeof value?.transaction === "string" &&
      !/^(?:|[0-9a-fA-F]{64})$/.test(value.transaction)
    )
      return "invalid_kaspa_transaction";
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
    throw new Error(
      `${label} mismatch\nexpected: ${expected}\nactual:   ${actual}`,
    );
  }
}

function assertValid(ajv, schemaId, value, label) {
  const validate = ajv.getSchema(schemaId);
  if (!validate) throw new Error(`schema not loaded: ${schemaId}`);
  if (!validate(value)) {
    throw new Error(
      `${label} failed ${schemaId}: ${ajv.errorsText(validate.errors)}`,
    );
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
  const offered = paymentRequired.accepts.some(
    (requirement) => stableStringify(requirement) === accepted,
  );
  if (!offered) {
    throw new Error(
      `${label}: accepted PaymentRequirements is not present in PaymentRequired.accepts`,
    );
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
  assertTxV1Validation(file, vector.validation);
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
  if (!isUint64String(artifact.transaction.mass))
    throw new Error(`${file}: transaction.mass must be a uint64 string`);
  if (
    !Number.isSafeInteger(artifact.transaction.estimatedSerializedSize) ||
    artifact.transaction.estimatedSerializedSize <= 0
  ) {
    throw new Error(
      `${file}: estimatedSerializedSize must be a positive safe integer`,
    );
  }
  assertHexBytes(
    artifact.serializedTransaction,
    `${file}:serializedTransaction`,
  );
  assertHash32(artifact.transactionId, `${file}:transactionId`);
  assertHash32(artifact.transactionHash, `${file}:transactionHash`);
  assertEqual(
    artifact.serializedTransaction,
    artifact.hash?.preimage,
    `${file}:hash.preimage`,
  );
  assertEqual(
    artifact.transactionId,
    artifact.txid?.digest,
    `${file}:txid.digest`,
  );
  assertEqual(
    artifact.transactionHash,
    artifact.hash?.digest,
    `${file}:hash.digest`,
  );
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
  if (
    !Number.isInteger(computeBudget) ||
    computeBudget < 0 ||
    computeBudget > 0xffff
  ) {
    throw new Error(`${file}: compute budget must fit in uint16`);
  }
  if (!Number.isSafeInteger(scriptUnitsEstimate) || scriptUnitsEstimate < 0) {
    throw new Error(
      `${file}: script-unit estimate must be a non-negative integer`,
    );
  }
  assertEqual(
    computeBudget * 10000 + 9999,
    scriptUnitAllowance,
    `${file}:scriptUnitAllowance`,
  );
  if (scriptUnitAllowance < scriptUnitsEstimate) {
    throw new Error(
      `${file}: compute budget does not cover script-unit estimate`,
    );
  }
  for (const [index, input] of (artifact.transaction.inputs ?? []).entries()) {
    assertHash32(
      input.previousOutpoint?.txid,
      `${file}:inputs[${index}].previousOutpoint.txid`,
    );
    if (!isUint32(input.previousOutpoint?.index))
      throw new Error(
        `${file}:inputs[${index}].previousOutpoint.index must fit in uint32`,
      );
    assertHexBytes(
      input.signatureScript,
      `${file}:inputs[${index}].signatureScript`,
    );
    if (!isUint64String(input.sequence))
      throw new Error(
        `${file}:inputs[${index}].sequence must be a uint64 string`,
      );
    if (input.computeBudget !== computeBudget)
      throw new Error(
        `${file}:inputs[${index}].computeBudget must match artifact compute budget`,
      );
    assertHexBytes(
      input.utxo?.scriptPublicKey,
      `${file}:inputs[${index}].utxo.scriptPublicKey`,
    );
    if (!isUint64String(input.utxo?.amount))
      throw new Error(
        `${file}:inputs[${index}].utxo.amount must be a uint64 string`,
      );
  }
  for (const [index, output] of (
    artifact.transaction.outputs ?? []
  ).entries()) {
    if (!isUint64String(output.amount))
      throw new Error(
        `${file}:outputs[${index}].amount must be a uint64 string`,
      );
    assertHexBytes(
      output.scriptPublicKey,
      `${file}:outputs[${index}].scriptPublicKey`,
    );
    if (output.covenant !== null)
      throw new Error(
        `${file}:outputs[${index}].covenant must be null unless explicitly supported`,
      );
  }

  if (expectedKind === "batch-claim") {
    if (artifact.fee?.source !== "server-output")
      throw new Error(`${file}: claim fee source must be server-output`);
    if ((artifact.transaction.outputs ?? []).length !== 2)
      throw new Error(`${file}: claim vector must have two outputs`);
    assertHash32(artifact.voucherDigest, `${file}:voucherDigest`);
    assertEqual(
      artifact.continuation?.outputIndex,
      1,
      `${file}:continuation.outputIndex`,
    );
    assertEqual(
      artifact.continuation?.outpoint?.txid,
      artifact.transactionId,
      `${file}:continuation.outpoint.txid`,
    );
  } else if (expectedKind === "batch-refund") {
    if (artifact.fee?.source !== "refund-output")
      throw new Error(`${file}: refund fee source must be refund-output`);
    if ((artifact.transaction.outputs ?? []).length !== 1)
      throw new Error(`${file}: refund vector must have one output`);
  }
}

function assertTxV1Validation(file, validation) {
  if (!validation || typeof validation !== "object") {
    throw new Error(`${file}: tx-v1 vector requires validation metadata`);
  }
  if (validation.status !== "consensus-cross-validated") {
    throw new Error(
      `${file}: tx-v1 validation.status must be consensus-cross-validated`,
    );
  }
  if (validation.tool !== "kaspa-consensus-core") {
    throw new Error(
      `${file}: tx-v1 validation.tool must be kaspa-consensus-core`,
    );
  }
  if (validation.toolVersion !== "2.0.1") {
    throw new Error(`${file}: tx-v1 validation.toolVersion must be 2.0.1`);
  }
  if (
    typeof validation.sourceCommit !== "string" ||
    !GIT_COMMIT_PATTERN.test(validation.sourceCommit)
  ) {
    throw new Error(
      `${file}: tx-v1 validation.sourceCommit must be a git commit id`,
    );
  }
  if (validation.sourceCommit !== TX_V1_CONSENSUS_COMMIT) {
    throw new Error(
      `${file}: tx-v1 validation.sourceCommit must match the pinned consensus source`,
    );
  }
  if (
    typeof validation.command !== "string" ||
    !validation.command.includes("validate:tx-v1-consensus")
  ) {
    throw new Error(
      `${file}: tx-v1 validation.command must name validate:tx-v1-consensus`,
    );
  }
  const checkedFields = validation.checkedFields;
  if (!Array.isArray(checkedFields)) {
    throw new Error(`${file}: tx-v1 validation.checkedFields must be an array`);
  }
  for (const field of [
    "transactionId",
    "transactionHash",
    "serializedTransaction",
    "hash.preimage",
    "txid.payloadDigest",
    "txid.restPreimage",
    "txid.restDigest",
    "sighash.preimage",
    "sighash.digest",
    "transaction.mass",
    "transaction.estimatedSerializedSize",
    "transaction.inputs[].computeBudget",
    "transaction.outputs[].covenant",
  ]) {
    if (!checkedFields.includes(field)) {
      throw new Error(
        `${file}: tx-v1 validation.checkedFields must include ${field}`,
      );
    }
  }
  if (
    !["offline-reference", "node-broadcast"].includes(validation.liveStatus)
  ) {
    throw new Error(`${file}: tx-v1 validation.liveStatus is invalid`);
  }
}

function validateVector(ajv, file, vector, rootDir = root) {
  switch (vector.kind) {
    case "voucher-digest": {
      for (const item of vector.cases) {
        const preimage = voucherPreimage(item.input).toString("hex");
        assertEqual(
          preimage,
          item.expected.preimage,
          `${file}:${item.name}:preimage`,
        );
        assertEqual(
          sha256(Buffer.from(preimage, "hex")).toString("hex"),
          item.expected.digest,
          `${file}:${item.name}:digest`,
        );
      }
      break;
    }
    case "channel-id": {
      const preimage = channelIdPreimage(vector.input).toString("hex");
      assertEqual(preimage, vector.expected.preimage, `${file}:preimage`);
      assertEqual(
        sha256(Buffer.from(preimage, "hex")).toString("hex"),
        vector.expected.channelId,
        `${file}:channelId`,
      );
      break;
    }
    case "x402-http": {
      assertValid(
        ajv,
        "https://kaspa-x402.org/schemas/payment-required.schema.json",
        vector.paymentRequired,
        `${file}:paymentRequired`,
      );
      assertValid(
        ajv,
        "https://kaspa-x402.org/schemas/payment-payload.schema.json",
        vector.paymentPayload,
        `${file}:paymentPayload`,
      );
      assertValid(
        ajv,
        "https://kaspa-x402.org/schemas/settlement-response.schema.json",
        vector.settlementResponse,
        `${file}:settlementResponse`,
      );
      assertAcceptedOffered(
        vector.paymentRequired,
        vector.paymentPayload,
        file,
      );
      assertEqual(
        Buffer.from(stableStringify(vector.paymentRequired)).toString("base64"),
        vector.headers.paymentRequired,
        `${file}:PAYMENT-REQUIRED`,
      );
      assertEqual(
        Buffer.from(stableStringify(vector.paymentPayload)).toString("base64"),
        vector.headers.paymentSignature,
        `${file}:PAYMENT-SIGNATURE`,
      );
      assertEqual(
        Buffer.from(stableStringify(vector.settlementResponse)).toString(
          "base64",
        ),
        vector.headers.paymentResponse,
        `${file}:PAYMENT-RESPONSE`,
      );
      break;
    }
    case "settlement-response": {
      assertValid(
        ajv,
        "https://kaspa-x402.org/schemas/settlement-response.schema.json",
        vector.response,
        `${file}:response`,
      );
      if (vector.correctivePaymentRequired) {
        assertValid(
          ajv,
          "https://kaspa-x402.org/schemas/payment-required.schema.json",
          vector.correctivePaymentRequired,
          `${file}:correctivePaymentRequired`,
        );
      }
      break;
    }
    case "negative": {
      if (!vector.name || !vector.expectedError) {
        throw new Error(
          `${file}: negative vectors require name and expectedError`,
        );
      }
      assertInvalid(
        ajv,
        vector.schema,
        vector.value,
        `${file}:${vector.name}`,
        vector.expectedError,
      );
      break;
    }
    case "semantic-negative": {
      if (!vector.name || !vector.expectedError) {
        throw new Error(
          `${file}: semantic-negative vectors require name and expectedError`,
        );
      }
      if (vector.scenario === "payment-identifier-conflict") {
        assertValid(
          ajv,
          "https://kaspa-x402.org/schemas/payment-identifier.schema.json",
          vector.first.extensionInfo,
          `${file}:first.extensionInfo`,
        );
        assertValid(
          ajv,
          "https://kaspa-x402.org/schemas/payment-identifier.schema.json",
          vector.second.extensionInfo,
          `${file}:second.extensionInfo`,
        );
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
          throw new Error(
            `${file}: payment-identifier-conflict must reuse id with a changed requestHash`,
          );
        }
        assertEqual(
          "kaspa_payment_identifier_conflict",
          vector.expectedError,
          `${file}:expectedError`,
        );
      } else if (vector.scenario === "missing-payment-identifier") {
        assertValid(
          ajv,
          "https://kaspa-x402.org/schemas/payment-required.schema.json",
          vector.paymentRequired,
          `${file}:paymentRequired`,
        );
        assertValid(
          ajv,
          "https://kaspa-x402.org/schemas/payment-payload.schema.json",
          vector.paymentPayload,
          `${file}:paymentPayload`,
        );
        const paymentIdentifierInfo =
          vector.paymentRequired?.extensions?.["payment-identifier"]?.info;
        assertValid(
          ajv,
          "https://kaspa-x402.org/schemas/payment-identifier.schema.json",
          paymentIdentifierInfo,
          `${file}:paymentRequired.payment-identifier.info`,
        );
        const required = paymentIdentifierInfo.required;
        const id =
          vector.paymentPayload?.extensions?.["payment-identifier"]?.info?.id;
        if (required !== true || typeof id === "string") {
          throw new Error(
            `${file}: missing-payment-identifier must advertise required:true and omit payload id`,
          );
        }
        assertEqual(
          "missing_kaspa_payment_identifier",
          vector.expectedError,
          `${file}:expectedError`,
        );
      } else if (vector.scenario === "accepted-not-offered") {
        assertValid(
          ajv,
          "https://kaspa-x402.org/schemas/payment-required.schema.json",
          vector.paymentRequired,
          `${file}:paymentRequired`,
        );
        assertValid(
          ajv,
          "https://kaspa-x402.org/schemas/payment-payload.schema.json",
          vector.paymentPayload,
          `${file}:paymentPayload`,
        );
        const accepted = stableStringify(vector.paymentPayload.accepted);
        const offered = vector.paymentRequired.accepts.some(
          (requirement) => stableStringify(requirement) === accepted,
        );
        if (offered) {
          throw new Error(
            `${file}: accepted-not-offered must use an accepted object absent from PaymentRequired.accepts`,
          );
        }
        assertEqual(
          "invalid_kaspa_x402_accepted",
          vector.expectedError,
          `${file}:expectedError`,
        );
      } else {
        throw new Error(
          `${file}: unknown semantic-negative scenario ${vector.scenario}`,
        );
      }
      break;
    }
    case "tx-v1-plan": {
      if (stableStringify(vector).includes("blocked-until-")) {
        throw new Error(
          `${file}: tx-v1 plan must not contain blocked-until entries`,
        );
      }
      if (
        !Array.isArray(vector.coveredVectors) ||
        vector.coveredVectors.length === 0
      ) {
        throw new Error(`${file}: tx-v1 plan must list covered vectors`);
      }
      const coveredPaths = new Set();
      const requiredValidationByPath = new Map([
        [
          "vectors/tx-v1/batch-claim.json",
          "consensus-cross-validated-offline-reference",
        ],
        [
          "vectors/tx-v1/batch-refund.json",
          "consensus-cross-validated-offline-reference",
        ],
      ]);
      for (const item of vector.coveredVectors) {
        if (
          typeof item.path !== "string" ||
          typeof item.validation !== "string"
        ) {
          throw new Error(
            `${file}: tx-v1 covered vectors require path and validation`,
          );
        }
        if (!fs.existsSync(path.join(rootDir, item.path))) {
          throw new Error(
            `${file}: tx-v1 covered vector file is missing: ${item.path}`,
          );
        }
        const requiredValidation = requiredValidationByPath.get(item.path);
        if (requiredValidation && item.validation !== requiredValidation) {
          throw new Error(
            `${file}: tx-v1 covered vector ${item.path} must use validation ${requiredValidation}`,
          );
        }
        coveredPaths.add(item.path);
      }
      for (const requiredPath of requiredValidationByPath.keys()) {
        if (!coveredPaths.has(requiredPath)) {
          throw new Error(
            `${file}: tx-v1 plan missing covered vector ${requiredPath}`,
          );
        }
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
    case "exact-consensus-profiles": {
      assertExactConsensusProfiles(file, vector);
      break;
    }
    default:
      throw new Error(`${file}: unknown vector kind ${vector.kind}`);
  }
}

function assertExactConsensusProfiles(file, vector) {
  const validation = vector.validation;
  if (
    validation?.status !== "full-consensus-cross-validated" ||
    validation?.tool !== "kaspa-consensus" ||
    validation?.toolVersion !== "2.0.1" ||
    validation?.sourceCommit !== EXACT_CONSENSUS_COMMIT ||
    typeof validation?.command !== "string" ||
    !validation.command.includes("validate:tx-v1-consensus")
  ) {
    throw new Error(
      `${file}: exact profiles require pinned full-consensus validation metadata`,
    );
  }
  const profiles = [
    ["standardNative", "standard-native", 0],
    ["additive", "additive", 1],
  ];
  for (const [field, profile, version] of profiles) {
    const item = vector.expected?.[field];
    if (
      item?.profile !== profile ||
      item?.version !== version ||
      item?.transaction?.version !== version
    ) {
      throw new Error(`${file}: ${field} profile/version mismatch`);
    }
    assertHash32(item.transactionId, `${file}:${field}:transactionId`);
    assertHash32(item.transactionHash, `${file}:${field}:transactionHash`);
    for (const amountField of [
      "amount",
      "fee",
      "storageMass",
      "computeMass",
      "transientMass",
    ]) {
      if (!isUint64String(item[amountField]))
        throw new Error(
          `${file}:${field}:${amountField} must be a uint64 string`,
        );
    }
    if (
      !Array.isArray(item.transaction.inputs) ||
      item.transaction.inputs.length !== item.inputs
    ) {
      throw new Error(`${file}:${field}: input evidence mismatch`);
    }
    if (
      !Array.isArray(item.transaction.outputs) ||
      item.transaction.outputs.length !== item.outputs
    ) {
      throw new Error(`${file}:${field}: output evidence mismatch`);
    }
    for (const [index, input] of item.transaction.inputs.entries()) {
      assertHash32(
        input.previousOutpoint?.txid,
        `${file}:${field}:input[${index}].txid`,
      );
      assertHexBytes(
        input.signatureScript,
        `${file}:${field}:input[${index}].signatureScript`,
      );
      assertHexBytes(
        input.utxo?.scriptPublicKey,
        `${file}:${field}:input[${index}].utxo.scriptPublicKey`,
      );
      if (!isUint64String(input.utxo?.amount))
        throw new Error(
          `${file}:${field}:input[${index}].utxo.amount must be uint64`,
        );
    }
    for (const [index, output] of item.transaction.outputs.entries()) {
      if (!isUint64String(output.amount))
        throw new Error(
          `${file}:${field}:output[${index}].amount must be uint64`,
        );
      assertHexBytes(
        output.scriptPublicKey,
        `${file}:${field}:output[${index}].scriptPublicKey`,
      );
      if (output.covenant !== null)
        throw new Error(
          `${file}:${field}:output[${index}] must not have a covenant binding`,
        );
    }
  }
  if (
    vector.expected.standardNative.transaction.outputs[0].amount !==
    vector.expected.standardNative.amount
  ) {
    throw new Error(
      `${file}: standard-native merchant output must equal the exact amount`,
    );
  }
  const additive = vector.expected.additive;
  const headInput = BigInt(additive.transaction.inputs[0].utxo.amount);
  const successor = BigInt(additive.transaction.outputs[0].amount);
  if (successor - headInput !== BigInt(additive.amount)) {
    throw new Error(
      `${file}: additive successor delta must equal the exact amount`,
    );
  }
}

export function validateSchemasAndVectors(options = {}) {
  const rootDir = path.resolve(options.root ?? root);
  const schemasDir = path.join(rootDir, "schemas");
  const vectorsDir = path.join(rootDir, "vectors");
  const schemaFiles = listJsonFiles(schemasDir);
  const vectorFiles = listJsonFiles(vectorsDir);
  const ajv = new Ajv2020({ allErrors: true, strict: false });

  for (const file of schemaFiles) {
    const schema = readJson(file);
    ajv.addSchema(schema);
  }

  for (const file of schemaFiles) {
    const schema = readJson(file);
    if (!ajv.getSchema(schema.$id)) {
      throw new Error(`schema failed to register: ${file}`);
    }
  }

  for (const file of vectorFiles) {
    validateVector(ajv, path.relative(rootDir, file), readJson(file), rootDir);
  }

  return {
    root: rootDir,
    schemaCount: schemaFiles.length,
    vectorCount: vectorFiles.length,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  validateSchemasAndVectors();
  console.log("schemas and vectors ok");
}
