import Ajv2020 from "ajv/dist/2020.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const U64_DECIMAL_PATTERN =
  /^(?:0|[1-9][0-9]{0,18}|1[0-7][0-9]{18}|18[0-3][0-9]{17}|184[0-3][0-9]{16}|1844[0-5][0-9]{15}|18446[0-6][0-9]{14}|184467[0-3][0-9]{13}|1844674[0-3][0-9]{12}|184467440[0-6][0-9]{10}|1844674407[0-2][0-9]{9}|18446744073[0-6][0-9]{8}|1844674407370[0-8][0-9]{6}|18446744073709[0-4][0-9]{5}|184467440737095[0-4][0-9]{4}|18446744073709550[0-9]{3}|18446744073709551[0-5][0-9]{2}|1844674407370955160[0-9]{1}|1844674407370955161[0-4]|18446744073709551615)$/;
const BATCH_AMOUNT_DECIMAL_PATTERN =
  /^(?:0|[1-9][0-9]{0,17}|[1-8][0-9]{18}|9[0-1][0-9]{17}|92[0-1][0-9]{16}|922[0-2][0-9]{15}|9223[0-2][0-9]{14}|92233[0-6][0-9]{13}|922337[0-1][0-9]{12}|92233720[0-2][0-9]{10}|922337203[0-5][0-9]{9}|9223372036[0-7][0-9]{8}|92233720368[0-4][0-9]{7}|922337203685[0-3][0-9]{6}|9223372036854[0-6][0-9]{5}|92233720368547[0-6][0-9]{4}|922337203685477[0-4][0-9]{3}|9223372036854775[0-7][0-9]{2}|922337203685477580[0-7])$/;
const HEX32_PATTERN = /^[0-9a-fA-F]{64}$/;
const NONZERO_HEX32_PATTERN = /^(?=[0-9a-fA-F]{64}$)(?=.*[1-9a-fA-F])/;
const GIT_COMMIT_PATTERN = /^[0-9a-fA-F]{40}$/;
const TX_V1_CONSENSUS_COMMIT = "c338d495bec29e4dc8b5149f99e8db6fa916ed4a";
const EXACT_CONSENSUS_COMMIT = "c338d495bec29e4dc8b5149f99e8db6fa916ed4a";
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

function isBatchAmountString(value) {
  return typeof value === "string" && BATCH_AMOUNT_DECIMAL_PATTERN.test(value);
}

function expectedBindingForScheme(scheme) {
  return {
    exact: "kaspa-exact-v2",
    "batch-settlement": "kaspa-escrow-v2",
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
    if (
      requirement.scheme === "batch-settlement" &&
      requirement.network !== "kaspa:testnet-10"
    )
      return "invalid_kaspa_x402_network";
    if (requirement.asset !== "KAS") return "invalid_kaspa_x402_asset";
    if (!isUint64String(requirement.amount)) return "invalid_kaspa_x402_amount";
    if (
      requirement.scheme === "batch-settlement" &&
      !isBatchAmountString(requirement.amount)
    )
      return "invalid_kaspa_x402_amount";
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
      (value?.covenantId !== undefined &&
        !NONZERO_HEX32_PATTERN.test(value.covenantId)) ||
      (value?.voucher?.covenantId !== undefined &&
        !NONZERO_HEX32_PATTERN.test(value.voucher.covenantId))
    ) {
      return "invalid_kaspa_x402_binding";
    }
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
      !isBatchAmountString(value.voucher.amount)
    )
      return "invalid_kaspa_x402_amount";
    if (
      value?.fundingAmountSompi !== undefined &&
      !isBatchAmountString(value.fundingAmountSompi)
    )
      return "invalid_kaspa_x402_amount";
    if (
      value?.claimAmount !== undefined &&
      !isBatchAmountString(value.claimAmount)
    )
      return "invalid_kaspa_x402_amount";
    if (
      value?.refundAmount !== undefined &&
      !isBatchAmountString(value.refundAmount)
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
    sha256(Buffer.from("kaspa:x402:escrow-voucher:v2", "utf8")),
    sha256(Buffer.from(input.network, "utf8")),
    hexToBytes(input.covenantId),
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

function batchPaymentRequirementsPreimage(accepted) {
  return Buffer.concat([
    sha256(Buffer.from("kaspa:x402:batch-payment-requirements:v2", "utf8")),
    sha256(Buffer.from("batch-settlement", "utf8")),
    sha256(Buffer.from(accepted.network, "utf8")),
    sha256(Buffer.from("KAS", "utf8")),
    le64(accepted.amount),
    sha256(Buffer.from(accepted.payTo, "utf8")),
    le64(accepted.maxTimeoutSeconds),
    sha256(Buffer.from("kaspa-escrow-v2", "utf8")),
    sha256(Buffer.from(accepted.extra.templateId, "utf8")),
    hexToBytes(accepted.extra.serverPublicKey),
    le64(accepted.extra.minDepositSompi),
    le64(accepted.extra.claimReserveSompi),
    le64(accepted.extra.refundTimeoutDaa),
  ]);
}

function batchCommitmentPreimage(input) {
  return Buffer.concat([
    sha256(Buffer.from("kaspa:x402:batch-commitment:v2", "utf8")),
    hexToBytes(input.channelId),
    hexToBytes(input.voucher.covenantId),
    hexToBytes(input.requestFingerprint),
    sha256(batchPaymentRequirementsPreimage(input.accepted)),
    hexToBytes(input.activeOutpoint.txid),
    le32(input.activeOutpoint.index),
    le64(input.voucher.amount),
    sha256(hexToBytes(input.voucher.signature)),
    le64(input.chargedAmount),
    le64(input.chargedCumulativeBefore),
    le64(input.chargedCumulativeAfter),
    le64(input.claimedCumulativeAmount),
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

function assertCovenantId(value, label) {
  if (typeof value !== "string" || !NONZERO_HEX32_PATTERN.test(value)) {
    throw new Error(`${label} must be a non-zero 32-byte hex string`);
  }
}

function assertTxV1Vector(file, vector, expectedKind) {
  if (!vector.input || !vector.expected) {
    throw new Error(`${file}: tx-v1 vectors require input and expected`);
  }
  assertTxV1Validation(file, vector.validation);
  const artifact = vector.expected;
  if (artifact.format !== "kaspa-x402-tx-v1-reference-v2") {
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
  if (
    !Array.isArray(artifact.sighashes) ||
    artifact.sighashes.length !== artifact.transaction.inputs.length
  ) {
    throw new Error(`${file}: sighash evidence must cover every input`);
  }
  const sighashInputIndexes = new Set();
  for (const [index, sighash] of artifact.sighashes.entries()) {
    if (
      !Number.isSafeInteger(sighash.inputIndex) ||
      sighash.inputIndex < 0 ||
      sighash.inputIndex >= artifact.transaction.inputs.length ||
      sighashInputIndexes.has(sighash.inputIndex)
    ) {
      throw new Error(`${file}:sighashes[${index}].inputIndex is invalid`);
    }
    sighashInputIndexes.add(sighash.inputIndex);
    assertHexBytes(sighash.preimage, `${file}:sighashes[${index}].preimage`);
    assertHash32(sighash.digest, `${file}:sighashes[${index}].digest`);
    if (sighash.hashType !== "all") {
      throw new Error(`${file}: only sighash-all vectors are supported`);
    }
  }
  if (artifact.compute !== undefined) {
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
    assertEqual(
      artifact.transaction.inputs[0]?.computeBudget,
      computeBudget,
      `${file}:inputs[0].computeBudget`,
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
    if (
      !Number.isInteger(input.computeBudget) ||
      input.computeBudget < 0 ||
      input.computeBudget > 0xffff
    ) {
      throw new Error(
        `${file}:inputs[${index}].computeBudget must fit in uint16`,
      );
    }
    assertHexBytes(
      input.utxo?.scriptPublicKey,
      `${file}:inputs[${index}].utxo.scriptPublicKey`,
    );
    if (!isUint64String(input.utxo?.amount))
      throw new Error(
        `${file}:inputs[${index}].utxo.amount must be a uint64 string`,
      );
    if (input.utxo?.covenantId !== null) {
      assertCovenantId(
        input.utxo?.covenantId,
        `${file}:inputs[${index}].utxo.covenantId`,
      );
    }
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
    if (output.covenant !== null) {
      if (
        !Number.isInteger(output.covenant?.authorizingInput) ||
        output.covenant.authorizingInput < 0 ||
        output.covenant.authorizingInput > 0xffff
      ) {
        throw new Error(
          `${file}:outputs[${index}].covenant.authorizingInput must fit in uint16`,
        );
      }
      assertCovenantId(
        output.covenant?.covenantId,
        `${file}:outputs[${index}].covenant.covenantId`,
      );
    }
  }

  if (expectedKind === "batch-genesis") {
    if (artifact.fee?.source !== "funding-inputs") {
      throw new Error(`${file}: genesis fee source must be funding-inputs`);
    }
    assertCovenantId(artifact.covenantId, `${file}:covenantId`);
    assertEqual(artifact.escrow?.outputIndex, 0, `${file}:escrow.outputIndex`);
    assertEqual(
      artifact.escrow?.outpoint?.txid,
      artifact.transactionId,
      `${file}:escrow.outpoint.txid`,
    );
    assertEqual(
      artifact.transaction.outputs[0]?.covenant?.covenantId,
      artifact.covenantId,
      `${file}:genesis covenantId`,
    );
    assertEqual(
      artifact.transaction.outputs[0]?.covenant?.authorizingInput,
      0,
      `${file}:genesis authorizingInput`,
    );
    if (
      artifact.transaction.outputs
        .slice(1)
        .some((output) => output.covenant !== null)
    ) {
      throw new Error(`${file}: genesis change outputs must be unbound`);
    }
  } else if (expectedKind === "batch-claim") {
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
    if (artifact.transaction.outputs[0]?.covenant !== null) {
      throw new Error(`${file}: claim payout must be unbound`);
    }
    assertEqual(
      artifact.transaction.outputs[1]?.covenant?.covenantId,
      artifact.continuation?.covenantId,
      `${file}: claim continuation covenantId`,
    );
    assertEqual(
      artifact.transaction.outputs[1]?.covenant?.authorizingInput,
      0,
      `${file}: claim continuation authorizingInput`,
    );
  } else if (expectedKind === "batch-top-up") {
    if (artifact.fee?.source !== "funding-inputs") {
      throw new Error(`${file}: top-up fee source must be funding-inputs`);
    }
    if ((artifact.transaction.inputs ?? []).length < 2) {
      throw new Error(`${file}: top-up vector must have at least two inputs`);
    }
    assertEqual(
      artifact.continuation?.outputIndex,
      0,
      `${file}:continuation.outputIndex`,
    );
    assertEqual(
      artifact.continuation?.outpoint?.txid,
      artifact.transactionId,
      `${file}:continuation.outpoint.txid`,
    );
    assertEqual(
      artifact.transaction.outputs[0]?.covenant?.covenantId,
      artifact.continuation?.covenantId,
      `${file}: top-up continuation covenantId`,
    );
    assertEqual(
      artifact.transaction.outputs[0]?.covenant?.authorizingInput,
      0,
      `${file}: top-up continuation authorizingInput`,
    );
    if (
      artifact.transaction.outputs
        .slice(1)
        .some((output) => output.covenant !== null)
    ) {
      throw new Error(`${file}: top-up change outputs must be unbound`);
    }
  } else if (expectedKind === "batch-refund") {
    if (artifact.fee?.source !== "refund-output")
      throw new Error(`${file}: refund fee source must be refund-output`);
    if ((artifact.transaction.outputs ?? []).length !== 1)
      throw new Error(`${file}: refund vector must have one output`);
    assertCovenantId(artifact.covenantId, `${file}:covenantId`);
    if (artifact.transaction.outputs[0]?.covenant !== null) {
      throw new Error(
        `${file}: refund output must terminate the covenant lineage`,
      );
    }
  }
}

function assertTxV1Validation(file, validation) {
  if (!validation || typeof validation !== "object") {
    throw new Error(`${file}: tx-v1 vector requires validation metadata`);
  }
  if (validation.status !== "full-consensus-cross-validated") {
    throw new Error(
      `${file}: tx-v1 validation.status must be full-consensus-cross-validated`,
    );
  }
  if (validation.tool !== "kaspa-consensus") {
    throw new Error(`${file}: tx-v1 validation.tool must be kaspa-consensus`);
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
    "sighashes[].preimage",
    "sighashes[].digest",
    "transaction.mass",
    "transaction.estimatedSerializedSize",
    "transaction.inputs[].computeBudget",
    "transaction.inputs[].utxo.covenantId",
    "transaction.outputs[].covenant",
    "fullTransactionValidator",
    "measuredScriptUnits",
    "minimumComputeBudget",
    "mutatedSignatureRejection",
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
      if (vector.expectedMissingProperty) {
        const validate = ajv.getSchema(vector.schema);
        validate(vector.value);
        const matched = validate.errors?.some(
          (error) =>
            error.keyword === "required" &&
            error.params?.missingProperty === vector.expectedMissingProperty,
        );
        if (!matched) {
          throw new Error(
            `${file}: expected missing property ${vector.expectedMissingProperty}`,
          );
        }
      }
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
          "vectors/tx-v1/batch-genesis.json",
          "full-consensus-and-script-execution-offline-reference",
        ],
        [
          "vectors/tx-v1/batch-claim.json",
          "full-consensus-and-script-execution-offline-reference",
        ],
        [
          "vectors/tx-v1/batch-claim-second.json",
          "full-consensus-and-script-execution-offline-reference",
        ],
        [
          "vectors/tx-v1/batch-top-up.json",
          "full-consensus-and-script-execution-offline-reference",
        ],
        [
          "vectors/tx-v1/batch-refund.json",
          "full-consensus-and-script-execution-offline-reference",
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
    case "tx-v1-batch-genesis": {
      assertTxV1Vector(file, vector, "batch-genesis");
      break;
    }
    case "tx-v1-batch-claim": {
      assertTxV1Vector(file, vector, "batch-claim");
      break;
    }
    case "tx-v1-batch-top-up": {
      assertTxV1Vector(file, vector, "batch-top-up");
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
    case "exact-interop-v1": {
      assertExactInteropVector(ajv, file, vector);
      break;
    }
    case "batch-interop-v2": {
      assertBatchInteropVector(ajv, file, vector, rootDir);
      break;
    }
    default:
      throw new Error(`${file}: unknown vector kind ${vector.kind}`);
  }
}

function assertBatchInteropVector(ajv, file, vector, rootDir) {
  assertBatchInteropCrossLinks(file, vector, rootDir);

  const channelPreimage = channelIdPreimage(vector.channel.config);
  assertEqual(
    channelPreimage.toString("hex"),
    vector.channel.preimage,
    `${file}:channel.preimage`,
  );
  assertEqual(
    sha256(channelPreimage).toString("hex"),
    vector.channel.channelId,
    `${file}:channel.channelId`,
  );

  const voucherBytes = voucherPreimage(vector.voucher.input);
  assertEqual(
    voucherBytes.toString("hex"),
    vector.voucher.preimage,
    `${file}:voucher.preimage`,
  );
  assertEqual(
    sha256(voucherBytes).toString("hex"),
    vector.voucher.digest,
    `${file}:voucher.digest`,
  );
  assertHash32(
    vector.voucher.signerPublicKey,
    `${file}:voucher.signerPublicKey`,
  );
  if (!SIGNATURE64_PATTERN.test(vector.voucher.signature)) {
    throw new Error(`${file}: voucher signature must be 64-byte hex`);
  }

  assertValid(
    ajv,
    "https://kaspa-x402.org/schemas/payment-required.schema.json",
    {
      x402Version: 2,
      resource: { url: "kaspa-x402:batch-interop-vector" },
      accepts: [vector.paymentRequirements.value],
    },
    `${file}:paymentRequirements.value`,
  );
  const requirementsBytes = batchPaymentRequirementsPreimage(
    vector.paymentRequirements.value,
  );
  assertEqual(
    requirementsBytes.toString("hex"),
    vector.paymentRequirements.preimage,
    `${file}:paymentRequirements.preimage`,
  );
  assertEqual(
    sha256(requirementsBytes).toString("hex"),
    vector.paymentRequirements.sha256,
    `${file}:paymentRequirements.sha256`,
  );

  const commitment = vector.commitment.input;
  if (
    BigInt(commitment.chargedCumulativeBefore) +
      BigInt(commitment.chargedAmount) !==
    BigInt(commitment.chargedCumulativeAfter)
  ) {
    throw new Error(`${file}: commitment cumulative accounting is invalid`);
  }
  const commitmentBytes = batchCommitmentPreimage(commitment);
  assertEqual(
    commitmentBytes.toString("hex"),
    vector.commitment.preimage,
    `${file}:commitment.preimage`,
  );
  assertEqual(
    sha256(commitmentBytes).toString("hex"),
    vector.commitment.commitmentId,
    `${file}:commitment.commitmentId`,
  );

  const timeout = BigInt(vector.expiry.timeoutDaa);
  const boundary = BigInt(vector.expiry.lockTimeBoundary);
  for (const testCase of vector.expiry.cases ?? []) {
    const actual = testCase.timeoutDaa
      ? BigInt(testCase.timeoutDaa) >= boundary
        ? "invalid-timestamp-domain-timeout"
        : "valid-timeout"
      : BigInt(testCase.currentDaa) > timeout
        ? "refund-mature"
        : "refund-not-mature";
    assertEqual(actual, testCase.expected, `${file}:expiry.case`);
  }
  if (
    stableStringify(vector.finality?.ordering) !==
    stableStringify(["mempool", "accepted", "confirmed"])
  ) {
    throw new Error(`${file}: finality ordering is invalid`);
  }
  for (const testCase of vector.finality.cases ?? []) {
    const actual = vector.finality.ordering.indexOf(testCase.actual);
    const required = vector.finality.ordering.indexOf(testCase.required);
    if (
      actual < 0 ||
      required < 0 ||
      actual >= required !== testCase.expected
    ) {
      throw new Error(
        `${file}: invalid finality case ${stableStringify(testCase)}`,
      );
    }
  }
}

export function assertBatchInteropCrossLinks(file, vector, rootDir = root) {
  const config = vector.channel.config;
  const lineage = vector.lineage;
  const voucher = vector.voucher;
  const accepted = vector.paymentRequirements.value;
  const commitment = vector.commitment.input;

  assertEqual(vector.kind, "batch-interop-v2", `${file}: vector kind`);
  assertEqual(
    vector.scope?.transactionEvidenceIncluded,
    false,
    `${file}: non-transaction scope`,
  );
  assertCovenantId(lineage?.covenantId, `${file}: lineage covenant id`);

  assertEqual(
    accepted.network,
    config.network,
    `${file}: payment requirements network mismatch`,
  );
  assertEqual(
    accepted.asset,
    config.asset,
    `${file}: payment requirements asset mismatch`,
  );
  assertEqual(
    accepted.payTo,
    config.payTo,
    `${file}: payment requirements payTo mismatch`,
  );
  assertEqual(
    accepted.extra.templateId,
    config.templateId,
    `${file}: payment requirements template mismatch`,
  );
  assertEqual(
    accepted.extra.serverPublicKey,
    config.serverPublicKey,
    `${file}: payment requirements server key mismatch`,
  );
  assertEqual(
    accepted.extra.refundTimeoutDaa,
    config.refundTimeoutDaa,
    `${file}: payment requirements timeout mismatch`,
  );

  assertEqual(
    voucher.signerPublicKey,
    config.clientPublicKey,
    `${file}: voucher signer mismatch`,
  );
  assertEqual(
    voucher.input.network,
    config.network,
    `${file}: voucher network mismatch`,
  );
  assertCovenantId(voucher.input.covenantId, `${file}: voucher covenant id`);
  assertEqual(
    voucher.input.covenantId,
    lineage.covenantId,
    `${file}: voucher covenant id mismatch`,
  );

  assertEqual(
    commitment.channelId,
    vector.channel.channelId,
    `${file}: commitment channel id mismatch`,
  );
  assertEqual(
    stableStringify(commitment.accepted),
    stableStringify(accepted),
    `${file}: commitment payment requirements mismatch`,
  );
  assertEqual(
    stableStringify(commitment.voucher),
    stableStringify({
      covenantId: voucher.input.covenantId,
      amount: voucher.input.amount,
      signature: voucher.signature,
    }),
    `${file}: commitment voucher mismatch`,
  );
  assertEqual(
    stableStringify(commitment.activeOutpoint),
    stableStringify(lineage.currentHead.outpoint),
    `${file}: current head outpoint mismatch`,
  );

  const genesis = lineage.genesisDerivation;
  assertHash32(
    genesis.authorizingInput?.txid,
    `${file}: genesis authorizing input txid`,
  );
  if (!isUint32(genesis.authorizingInput?.index)) {
    throw new Error(`${file}: genesis authorizing input index must fit uint32`);
  }
  if (genesis.authorizedOutputs?.length !== 1) {
    throw new Error(`${file}: genesis must describe one authorized output`);
  }
  assertEqual(
    genesis.authorizedOutputs[0].index,
    0,
    `${file}: genesis authorized output index`,
  );
  if (!isBatchAmountString(genesis.authorizedOutputs[0].amount)) {
    throw new Error(`${file}: genesis amount must fit signed int64`);
  }
  assertHexBytes(
    genesis.authorizedOutputs[0].scriptPublicKey,
    `${file}: genesis script public key`,
  );

  const before = vector.accounting.beforeRequest;
  const afterRequest = vector.accounting.afterRequest;
  const afterClaim = vector.accounting.afterClaim;
  for (const [name, state] of Object.entries({
    before,
    afterRequest,
    afterClaim,
  })) {
    assertEqual(
      state.channelId,
      vector.channel.channelId,
      `${file}: ${name} channel id`,
    );
    assertEqual(
      state.covenantId,
      lineage.covenantId,
      `${file}: ${name} covenant id`,
    );
    assertBatchAccountingState(file, name, state);
  }
  assertEqual(
    stableStringify(before.activeOutpoint),
    stableStringify(lineage.currentHead.outpoint),
    `${file}: before-request outpoint`,
  );
  assertEqual(
    before.activeScriptPublicKey,
    lineage.currentHead.scriptPublicKey,
    `${file}: before-request script`,
  );
  assertEqual(
    stableStringify(afterClaim.activeOutpoint),
    stableStringify(lineage.successorHead.outpoint),
    `${file}: successor outpoint`,
  );
  assertEqual(
    afterClaim.activeScriptPublicKey,
    lineage.successorHead.scriptPublicKey,
    `${file}: successor script`,
  );

  const chargedAmount = BigInt(commitment.chargedAmount);
  assertEqual(
    (BigInt(before.chargedCumulativeAmount) + chargedAmount).toString(),
    afterRequest.chargedCumulativeAmount,
    `${file}: request charge transition`,
  );
  for (const field of [
    "fundingAmount",
    "claimedCumulativeAmount",
    "signedMaxClaimable",
  ]) {
    assertEqual(
      afterRequest[field],
      before[field],
      `${file}: request ${field}`,
    );
  }

  const claimAmount = BigInt(vector.accounting.claimAmount);
  if (claimAmount <= 0n)
    throw new Error(`${file}: claim amount must be positive`);
  assertEqual(
    (BigInt(afterRequest.fundingAmount) - claimAmount).toString(),
    afterClaim.fundingAmount,
    `${file}: claim funding transition`,
  );
  assertEqual(
    (BigInt(afterRequest.claimedCumulativeAmount) + claimAmount).toString(),
    afterClaim.claimedCumulativeAmount,
    `${file}: claim settled transition`,
  );
  assertEqual(
    afterClaim.chargedCumulativeAmount,
    afterRequest.chargedCumulativeAmount,
    `${file}: claim actual-charge preservation`,
  );
  assertEqual(
    afterClaim.signedMaxClaimable,
    afterRequest.signedMaxClaimable,
    `${file}: claim signed-ceiling preservation`,
  );

  const reserve = BigInt(vector.accounting.reserveAmount);
  if (
    BigInt(afterRequest.signedMaxClaimable) -
      BigInt(afterRequest.claimedCumulativeAmount) +
      reserve >
    BigInt(afterRequest.fundingAmount)
  ) {
    throw new Error(`${file}: voucher reserve invariant is invalid`);
  }

  void rootDir;
}

function assertBatchAccountingState(file, name, state) {
  for (const field of [
    "fundingAmount",
    "chargedCumulativeAmount",
    "claimedCumulativeAmount",
    "signedMaxClaimable",
  ]) {
    if (!isBatchAmountString(state[field])) {
      throw new Error(`${file}: ${name}.${field} must fit signed int64`);
    }
  }
  const value = BigInt(state.fundingAmount);
  const actual = BigInt(state.chargedCumulativeAmount);
  const settled = BigInt(state.claimedCumulativeAmount);
  const signed = BigInt(state.signedMaxClaimable);
  if (settled > actual || actual > signed) {
    throw new Error(`${file}: ${name} violates S <= A <= T`);
  }
  if (actual - settled > value || signed - settled > value) {
    throw new Error(`${file}: ${name} exceeds current covenant value`);
  }
}

function assertExactInteropVector(ajv, file, vector) {
  const profiles = vector.transactionEncoding?.profiles;
  for (const field of ["standardNative", "additive"]) {
    const profile = profiles?.[field];
    if (!profile || !HEX32_PATTERN.test(profile.transactionId)) {
      throw new Error(`${file}: ${field} requires a canonical transaction id`);
    }
    assertEqual(
      profile.artifact?.id,
      profile.transactionId,
      `${file}:${field}:artifact.id`,
    );
    assertEqual(
      profile.txid?.digest,
      profile.transactionId,
      `${file}:${field}:txid.digest`,
    );
    if (!HEX_BYTES_PATTERN.test(profile.txid?.preimage ?? "")) {
      throw new Error(`${file}: ${field} txid preimage must be byte hex`);
    }
  }

  const requirements = vector.paymentRequirements;
  assertValid(
    ajv,
    "https://kaspa-x402.org/schemas/payment-required.schema.json",
    {
      x402Version: 2,
      resource: { url: "kaspa-x402:exact-interop-vector" },
      accepts: [requirements?.value],
    },
    `${file}:paymentRequirements.value`,
  );
  const requirementsPreimage = stableStringify(requirements.value);
  assertEqual(
    requirementsPreimage,
    requirements.canonicalJsonUtf8,
    `${file}:paymentRequirements.canonicalJsonUtf8`,
  );
  assertEqual(
    sha256(Buffer.from(requirementsPreimage)).toString("hex"),
    requirements.sha256,
    `${file}:paymentRequirements.sha256`,
  );

  const authorization = vector.requestAuthorization;
  const authorizationPreimage = stableStringify({
    scope: "kaspa-x402-exact-request-authorization-v1",
    ...authorization.input,
  });
  assertEqual(
    authorizationPreimage,
    authorization.canonicalJsonUtf8,
    `${file}:requestAuthorization.canonicalJsonUtf8`,
  );
  assertEqual(
    sha256(Buffer.from(authorizationPreimage)).toString("hex"),
    authorization.sha256,
    `${file}:requestAuthorization.sha256`,
  );
  if (
    !HEX32_PATTERN.test(authorization.signerPublicKey) ||
    !SIGNATURE64_PATTERN.test(authorization.signature) ||
    authorization.expected !== "valid-schnorr-signature"
  ) {
    throw new Error(`${file}: request authorization evidence is incomplete`);
  }

  if (
    !Array.isArray(vector.expiry?.cases) ||
    vector.expiry.cases.length < 6 ||
    stableStringify(vector.finality?.ordering) !==
      stableStringify(["mempool", "accepted", "confirmed"]) ||
    !Array.isArray(vector.finality?.cases) ||
    vector.finality.cases.length < 5
  ) {
    throw new Error(`${file}: expiry or finality cases are incomplete`);
  }
  for (const testCase of vector.finality.cases) {
    const actual = vector.finality.ordering.indexOf(testCase.actual);
    const required = vector.finality.ordering.indexOf(testCase.required);
    if (
      actual < 0 ||
      required < 0 ||
      actual >= required !== testCase.expected
    ) {
      throw new Error(
        `${file}: invalid finality case ${stableStringify(testCase)}`,
      );
    }
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
  path.basename(process.argv[1]) === "validate-schemas.mjs" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  validateSchemasAndVectors();
  console.log("schemas and vectors ok");
}
