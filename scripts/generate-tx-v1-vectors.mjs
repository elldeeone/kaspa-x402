import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  CLAIM_COMPUTE_BUDGET,
  CLAIM_SCRIPT_UNITS_ESTIMATE,
  REFUND_COMPUTE_BUDGET,
  REFUND_SCRIPT_UNITS_ESTIMATE,
  UPTO_SETTLE_COMPUTE_BUDGET,
  UPTO_SETTLE_SCRIPT_UNITS_ESTIMATE,
  buildBatchClaimTxV1Artifact,
  buildBatchRefundTxV1Artifact,
  buildUptoSettlementTxV1Artifact,
} from "../packages/covenant/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = readJson("contracts/fixtures/kaspa-x402-escrow-v1.json");
const uptoFixture = readJson("contracts/fixtures/kaspa-x402-upto-v1.json");
const sample = fixture.sample;
const uptoSample = uptoFixture.sample;

const consensusValidation = {
  status: "consensus-cross-validated",
  tool: "kaspa-consensus-core",
  toolVersion: "2.0.1",
  sourceCommit: "ef1a093bcf8560fe05221b56f0c896f97e7d8d77",
  command: "KASPA_X402_KASPA_CONSENSUS_ROOT=<kaspa-consensus-checkout> npm run validate:tx-v1-consensus",
  checkedFields: [
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
  ],
  liveStatus: "offline-reference",
};

const claimInputWithoutMass = {
  network: sample.params.network,
  activeOutpoint: {
    txid: "44".repeat(32),
    index: 2,
  },
  activeAmount: "90000000",
  activeScriptPublicKey: sample.scriptPublicKey.serialized,
  redeemScript: sample.redeemScript,
  serverOutputScriptPublicKey: sample.payoutScriptPublicKey.serialized,
  expectedPayoutScriptPublicKeyHash: sample.payoutScriptPublicKey.hash,
  claimAmount: "25000000",
  voucherAmount: "30000000",
  fee: "1000",
  serverSignature: "aa".repeat(65),
  voucherSignature: "bb".repeat(64),
  computeBudget: CLAIM_COMPUTE_BUDGET,
  scriptUnitsEstimate: CLAIM_SCRIPT_UNITS_ESTIMATE,
};
const claimInput = { ...claimInputWithoutMass, mass: buildBatchClaimTxV1Artifact(claimInputWithoutMass).transaction.mass };
const claim = buildBatchClaimTxV1Artifact(claimInput);

const refundInputWithoutMass = {
  activeOutpoint: {
    txid: "55".repeat(32),
    index: 3,
  },
  activeAmount: "65000000",
  activeScriptPublicKey: sample.scriptPublicKey.serialized,
  redeemScript: sample.redeemScript,
  refundOutputScriptPublicKey: sample.refundScriptPublicKey.serialized,
  expectedRefundScriptPublicKeyHash: sample.refundScriptPublicKey.hash,
  fee: "900",
  clientSignature: "cc".repeat(65),
  timeoutDaa: sample.params.timeoutDaa,
  lockTimeDaa: sample.params.timeoutDaa,
  inputSequence: "0",
  computeBudget: REFUND_COMPUTE_BUDGET,
  scriptUnitsEstimate: REFUND_SCRIPT_UNITS_ESTIMATE,
};
const refundInput = { ...refundInputWithoutMass, mass: buildBatchRefundTxV1Artifact(refundInputWithoutMass).transaction.mass };
const refund = buildBatchRefundTxV1Artifact(refundInput);

const uptoSettlementInputWithoutMass = {
  authorizationOutpoint: {
    txid: "66".repeat(32),
    index: 4,
  },
  authorizationAmount: "300000",
  authorizationScriptPublicKey: uptoSample.scriptPublicKey.serialized,
  redeemScript: uptoSample.redeemScript,
  paymentOutputScriptPublicKey: uptoSample.payoutScriptPublicKey.serialized,
  expectedPayoutScriptPublicKeyHash: uptoSample.payoutScriptPublicKey.hash,
  refundOutputScriptPublicKey: uptoSample.refundScriptPublicKey.serialized,
  expectedRefundScriptPublicKeyHash: uptoSample.refundScriptPublicKey.hash,
  chargeAmount: "100000",
  maxAmountSompi: uptoSample.params.maxAmountSompi,
  validAfterDaa: uptoSample.params.validAfterDaa,
  settlementFeeReserveSompi: uptoSample.params.settlementFeeReserveSompi,
  fee: "1000",
  serverSignature: "dd".repeat(65),
  clientAuthorization: "ee".repeat(64),
  computeBudget: UPTO_SETTLE_COMPUTE_BUDGET,
  scriptUnitsEstimate: UPTO_SETTLE_SCRIPT_UNITS_ESTIMATE,
  lockTimeDaa: uptoSample.params.validAfterDaa,
};
const uptoSettlementInput = {
  ...uptoSettlementInputWithoutMass,
  mass: buildUptoSettlementTxV1Artifact(uptoSettlementInputWithoutMass).transaction.mass,
};
const uptoSettlement = buildUptoSettlementTxV1Artifact(uptoSettlementInput);

try {
  writeVectorsWithConsensusRollback([
    {
      path: "vectors/tx-v1/batch-claim.json",
      value: {
        kind: "tx-v1-batch-claim",
        description: "Reference transaction-v1 artifact for claiming a charged amount from a batch-settlement escrow.",
        validation: consensusValidation,
        input: claimInput,
        expected: claim,
      },
    },
    {
      path: "vectors/tx-v1/batch-refund.json",
      value: {
        kind: "tx-v1-batch-refund",
        description: "Reference transaction-v1 artifact for refunding an escrow after timeout.",
        validation: consensusValidation,
        input: refundInput,
        expected: refund,
      },
    },
    {
      path: "vectors/tx-v1/upto-settlement.json",
      value: {
        kind: "tx-v1-upto-settlement",
        description: "Reference transaction-v1 artifact for settling a nonzero upto authorization.",
        validation: consensusValidation,
        input: uptoSettlementInput,
        expected: uptoSettlement,
      },
    },
  ]);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function writeJson(relativePath, value) {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeVectorsWithConsensusRollback(vectors) {
  const snapshots = vectors.map((vector) => {
    const file = path.join(root, vector.path);
    const existed = fs.existsSync(file);
    return {
      file,
      existed,
      contents: existed ? fs.readFileSync(file, "utf8") : undefined,
    };
  });

  try {
    for (const vector of vectors) {
      writeJson(vector.path, vector.value);
    }
    runConsensusValidation();
  } catch (error) {
    restoreSnapshots(snapshots);
    throw error;
  }
}

function restoreSnapshots(snapshots) {
  for (const snapshot of snapshots) {
    if (snapshot.existed) {
      fs.writeFileSync(snapshot.file, snapshot.contents);
    } else {
      fs.rmSync(snapshot.file, { force: true });
    }
  }
}

function runConsensusValidation() {
  const result = spawnSync(process.execPath, [path.join(root, "scripts/validate-tx-v1-consensus.mjs")], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`consensus validation failed with status ${result.status ?? 1}`);
  }
}
