import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

import { schnorr } from "@noble/curves/secp256k1.js";

import {
  CLAIM_COMPUTE_BUDGET,
  CLAIM_SCRIPT_UNITS_ESTIMATE,
  REFUND_COMPUTE_BUDGET,
  REFUND_SCRIPT_UNITS_ESTIMATE,
  buildBatchClaimTxV1Artifact,
  buildBatchRefundTxV1Artifact,
  buildEscrowRedeemScript,
  escrowScriptPublicKey,
  serializedScriptPublicKey,
  voucherDigest,
} from "../packages/covenant/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLIENT_PRIVATE_KEY = new Uint8Array(32).fill(7);
const SERVER_PRIVATE_KEY = new Uint8Array(32).fill(9);
const PAYOUT_PUBLIC_KEY = bytesToHex(
  schnorr.getPublicKey(new Uint8Array(32).fill(8)),
);
const CLIENT_PUBLIC_KEY = bytesToHex(schnorr.getPublicKey(CLIENT_PRIVATE_KEY));
const SERVER_PUBLIC_KEY = bytesToHex(schnorr.getPublicKey(SERVER_PRIVATE_KEY));
const PAYOUT_SCRIPT_PUBLIC_KEY = `000020${PAYOUT_PUBLIC_KEY}ac`;
const REFUND_SCRIPT_PUBLIC_KEY = `000020${CLIENT_PUBLIC_KEY}ac`;
const escrowParams = {
  clientPublicKey: CLIENT_PUBLIC_KEY,
  serverPublicKey: SERVER_PUBLIC_KEY,
  network: "kaspa:testnet-10",
  payoutScriptPublicKeyHash: sha256HexBytes(PAYOUT_SCRIPT_PUBLIC_KEY),
  refundScriptPublicKeyHash: sha256HexBytes(REFUND_SCRIPT_PUBLIC_KEY),
  timeoutDaa: "123456789",
};
const activeScriptPublicKey = serializedScriptPublicKey(
  escrowScriptPublicKey(escrowParams),
);
const redeemScript = buildEscrowRedeemScript(escrowParams);

const consensusValidation = {
  status: "full-consensus-cross-validated",
  tool: "kaspa-consensus",
  toolVersion: "2.0.1",
  sourceCommit: "78257f273a26c4be085bab0f79437dee99ca8835",
  command:
    "KASPA_X402_KASPA_CONSENSUS_ROOT=<kaspa-consensus-checkout> npm run validate:tx-v1-consensus",
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
    "fullConsensus",
    "scriptExecution",
    "mutatedSignatureRejection",
  ],
  liveStatus: "offline-reference",
};

const claimInputWithoutMass = {
  network: escrowParams.network,
  activeOutpoint: {
    txid: "44".repeat(32),
    index: 2,
  },
  activeAmount: "90000000",
  activeScriptPublicKey,
  redeemScript,
  serverOutputScriptPublicKey: PAYOUT_SCRIPT_PUBLIC_KEY,
  expectedPayoutScriptPublicKeyHash: escrowParams.payoutScriptPublicKeyHash,
  claimAmount: "25000000",
  voucherAmount: "30000000",
  fee: "1000",
  serverSignature: "00".repeat(65),
  voucherSignature: signVoucher({
    network: escrowParams.network,
    activeScriptPublicKey,
    outpoint: { txid: "44".repeat(32), index: 2 },
    amount: "30000000",
  }),
  computeBudget: CLAIM_COMPUTE_BUDGET,
  scriptUnitsEstimate: CLAIM_SCRIPT_UNITS_ESTIMATE,
};
const claimMass = buildBatchClaimTxV1Artifact(claimInputWithoutMass).transaction
  .mass;
const unsignedClaim = buildBatchClaimTxV1Artifact({
  ...claimInputWithoutMass,
  mass: claimMass,
});
const claimInput = {
  ...claimInputWithoutMass,
  mass: claimMass,
  serverSignature: transactionSignature(
    unsignedClaim.sighash.digest,
    SERVER_PRIVATE_KEY,
  ),
};
const claim = buildBatchClaimTxV1Artifact(claimInput);

const refundInputWithoutMass = {
  activeOutpoint: claim.continuation.outpoint,
  activeAmount: claim.continuation.amount,
  activeScriptPublicKey,
  redeemScript,
  refundOutputScriptPublicKey: REFUND_SCRIPT_PUBLIC_KEY,
  expectedRefundScriptPublicKeyHash: escrowParams.refundScriptPublicKeyHash,
  fee: "900",
  clientSignature: "00".repeat(65),
  timeoutDaa: escrowParams.timeoutDaa,
  lockTimeDaa: escrowParams.timeoutDaa,
  inputSequence: "0",
  computeBudget: REFUND_COMPUTE_BUDGET,
  scriptUnitsEstimate: REFUND_SCRIPT_UNITS_ESTIMATE,
};
const refundMass = buildBatchRefundTxV1Artifact(refundInputWithoutMass)
  .transaction.mass;
const unsignedRefund = buildBatchRefundTxV1Artifact({
  ...refundInputWithoutMass,
  mass: refundMass,
});
const refundInput = {
  ...refundInputWithoutMass,
  mass: refundMass,
  clientSignature: transactionSignature(
    unsignedRefund.sighash.digest,
    CLIENT_PRIVATE_KEY,
  ),
};
const refund = buildBatchRefundTxV1Artifact(refundInput);

try {
  writeVectorsWithConsensusRollback([
    {
      path: "vectors/tx-v1/batch-claim.json",
      value: {
        kind: "tx-v1-batch-claim",
        description:
          "Reference transaction-v1 artifact for claiming a charged amount from a batch-settlement escrow.",
        validation: consensusValidation,
        input: claimInput,
        expected: claim,
      },
    },
    {
      path: "vectors/tx-v1/batch-refund.json",
      value: {
        kind: "tx-v1-batch-refund",
        description:
          "Reference transaction-v1 artifact for refunding an escrow after timeout.",
        validation: consensusValidation,
        input: refundInput,
        expected: refund,
      },
    },
  ]);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function signVoucher(input) {
  const digest = voucherDigest(input);
  return bytesToHex(
    schnorr.sign(
      Buffer.from(digest, "hex"),
      CLIENT_PRIVATE_KEY,
      new Uint8Array(32),
    ),
  );
}

function transactionSignature(digest, privateKey) {
  return `${bytesToHex(
    schnorr.sign(Buffer.from(digest, "hex"), privateKey, new Uint8Array(32)),
  )}01`;
}

function sha256HexBytes(hex) {
  return crypto
    .createHash("sha256")
    .update(Buffer.from(hex, "hex"))
    .digest("hex");
}

function bytesToHex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

function writeJson(relativePath, value) {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeVectorsWithConsensusRollback(vectors) {
  const outputPaths = [
    ...vectors.map((vector) => vector.path),
    "vectors/batch/interop-v1.json",
    "vectors/x402-http/batch-voucher.json",
  ];
  const snapshots = outputPaths.map((relativePath) => {
    const file = path.join(root, relativePath);
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
    runBatchInteropGeneration();
    runConsensusValidation();
  } catch (error) {
    restoreSnapshots(snapshots);
    throw error;
  }
}

function runBatchInteropGeneration() {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "scripts/generate-batch-interop-vector.mjs")],
    {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `batch interoperability vector generation failed with status ${result.status ?? 1}`,
    );
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
  const result = spawnSync(
    process.execPath,
    [path.join(root, "scripts/validate-tx-v1-consensus.mjs")],
    {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `consensus validation failed with status ${result.status ?? 1}`,
    );
  }
}
