import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLAIM_COMPUTE_BUDGET,
  CLAIM_SCRIPT_UNITS_ESTIMATE,
  REFUND_COMPUTE_BUDGET,
  REFUND_SCRIPT_UNITS_ESTIMATE,
  buildBatchClaimTxV1Artifact,
  buildBatchRefundTxV1Artifact,
} from "../packages/covenant/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = readJson("contracts/fixtures/kaspa-x402-escrow-v1.json");
const sample = fixture.sample;

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

writeJson("vectors/tx-v1/batch-claim.json", {
  kind: "tx-v1-batch-claim",
  description: "Reference transaction-v1 artifact for claiming a charged amount from a batch-settlement escrow.",
  input: claimInput,
  expected: claim,
});
writeJson("vectors/tx-v1/batch-refund.json", {
  kind: "tx-v1-batch-refund",
  description: "Reference transaction-v1 artifact for refunding an escrow after timeout.",
  input: refundInput,
  expected: refund,
});

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function writeJson(relativePath, value) {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
