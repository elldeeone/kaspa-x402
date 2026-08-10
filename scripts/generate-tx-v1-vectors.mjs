import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

import { schnorr } from "@noble/curves/secp256k1.js";

import {
  TX_V1_P2PK_COMPUTE_BUDGET,
  buildBatchClaimTxV1Artifact,
  buildBatchGenesisTxV1Artifact,
  buildBatchRefundTxV1Artifact,
  buildBatchTopUpTxV1Artifact,
  buildEscrowV2RedeemScript,
  computeBudgetForScriptUnits,
  escrowV2ScriptPublicKey,
  serializedScriptPublicKey,
  transactionV1Sighash,
  voucherV2Digest,
} from "../packages/covenant/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLIENT_PRIVATE_KEY = new Uint8Array(32).fill(7);
const SERVER_PRIVATE_KEY = new Uint8Array(32).fill(9);
const PAYOUT_PRIVATE_KEY = new Uint8Array(32).fill(8);
const CLIENT_PUBLIC_KEY = bytesToHex(schnorr.getPublicKey(CLIENT_PRIVATE_KEY));
const SERVER_PUBLIC_KEY = bytesToHex(schnorr.getPublicKey(SERVER_PRIVATE_KEY));
const PAYOUT_PUBLIC_KEY = bytesToHex(schnorr.getPublicKey(PAYOUT_PRIVATE_KEY));
const CLIENT_SCRIPT_PUBLIC_KEY = `000020${CLIENT_PUBLIC_KEY}ac`;
const PAYOUT_SCRIPT_PUBLIC_KEY = `000020${PAYOUT_PUBLIC_KEY}ac`;

// These values are the exact execution measurements returned by the pinned
// full Rusty Kaspa TransactionValidator harness. During a contract change the
// harness rejects stale values and reports the newly measured units.
const FIRST_CLAIM_SCRIPT_UNITS = 207_144;
const SECOND_CLAIM_SCRIPT_UNITS = 207_147;
const TOP_UP_SCRIPT_UNITS = 106_490;
const REFUND_SCRIPT_UNITS = 102_330;

const escrowBaseParams = {
  clientPublicKey: CLIENT_PUBLIC_KEY,
  serverPublicKey: SERVER_PUBLIC_KEY,
  network: "kaspa:testnet-10",
  payoutScriptPublicKeyHash: sha256HexBytes(PAYOUT_SCRIPT_PUBLIC_KEY),
  refundScriptPublicKeyHash: sha256HexBytes(CLIENT_SCRIPT_PUBLIC_KEY),
  timeoutDaa: "123456789",
};
const escrowAt = (settledTotal) => {
  const params = { ...escrowBaseParams, settledTotal };
  const redeemScript = buildEscrowV2RedeemScript(params);
  return {
    settledTotal,
    redeemScript,
    scriptPublicKey: serializedScriptPublicKey(escrowV2ScriptPublicKey(params)),
  };
};
const state0 = escrowAt("0");
const state8m = escrowAt("8000000");
const state17m = escrowAt("17000000");

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
    "exhaustionRejection",
    "wrongCovenantIdRejection",
    "wrongSuccessorRejection",
    "earlyRefundRejection",
  ],
  liveStatus: "offline-reference",
};

const genesisBuild = buildSignedGenesis();
const genesis = genesisBuild.expected;
const covenantId = genesis.covenantId;
const totalAuthorized = "30000000";
const voucherSignature = signVoucher({
  network: escrowBaseParams.network,
  covenantId,
  totalAuthorized,
});
const claim1Build = buildSignedClaim({
  active: genesis.escrow,
  settledTotal: "0",
  successor: state8m,
  claimAmount: "8000000",
  scriptUnits: FIRST_CLAIM_SCRIPT_UNITS,
});
const claim1 = claim1Build.expected;
const claim2Build = buildSignedClaim({
  active: claim1.continuation,
  settledTotal: "8000000",
  successor: state17m,
  claimAmount: "9000000",
  scriptUnits: SECOND_CLAIM_SCRIPT_UNITS,
});
const claim2 = claim2Build.expected;
const topUpBuild = buildSignedTopUp();
const topUp = topUpBuild.expected;
const refundBuild = buildSignedRefund();
const refund = refundBuild.expected;

const vectors = [
  vector(
    "vectors/tx-v1/batch-genesis.json",
    "tx-v1-batch-genesis",
    "KIP-20 singleton genesis with exactly one total output from an ordinary client P2PK input.",
    0,
    genesisBuild,
  ),
  vector(
    "vectors/tx-v1/batch-claim.json",
    "tx-v1-batch-claim",
    "First partial claim under one lifetime cumulative voucher and stable covenant id.",
    1,
    claim1Build,
  ),
  vector(
    "vectors/tx-v1/batch-claim-second.json",
    "tx-v1-batch-claim",
    "Second partial claim reusing the same voucher and stable covenant id.",
    2,
    claim2Build,
  ),
  vector(
    "vectors/tx-v1/batch-top-up.json",
    "tx-v1-batch-top-up",
    "Client-authorized top-up preserving the stable covenant id and settled state.",
    3,
    topUpBuild,
  ),
  vector(
    "vectors/tx-v1/batch-refund.json",
    "tx-v1-batch-refund",
    "Client refund terminating the lane at its strict DAA timeout.",
    4,
    refundBuild,
  ),
];

const plan = {
  kind: "tx-v1-plan",
  description:
    "Alpha.10 KIP-20 batch lane chain validated by the pinned full Rusty Kaspa TransactionValidator.",
  mainnetReadiness: {},
  invariant: {
    covenantId,
    voucherDigest: voucherV2Digest({
      network: escrowBaseParams.network,
      covenantId,
      totalAuthorized,
    }),
    totalAuthorized,
    sequence: vectors.map(({ path: vectorPath, value }) => ({
      step: value.sequence.step,
      path: vectorPath,
      kind: value.kind,
      transactionId: value.expected.transactionId,
    })),
  },
  coveredVectors: vectors.map(({ path: vectorPath, value }) => ({
    name: value.kind,
    path: vectorPath,
    validation: "full-consensus-and-script-execution-offline-reference",
    description: value.description,
  })),
};

try {
  writeVectorsWithConsensusRollback([
    ...vectors,
    { path: "vectors/tx-v1/plan.json", value: plan },
  ]);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function buildSignedGenesis() {
  const base = {
    fundingInputs: [fundingInput("01", 0, "90001000")],
    escrowAmount: "90000000",
    escrowScriptPublicKey: state0.scriptPublicKey,
    escrowRedeemScript: state0.redeemScript,
    initialSettledTotal: "0",
    fee: "1000",
  };
  const mass = buildBatchGenesisTxV1Artifact(base).transaction.mass;
  const unsigned = buildBatchGenesisTxV1Artifact({ ...base, mass });
  const input = {
    ...base,
    mass,
    fundingInputs: [
      {
        ...base.fundingInputs[0],
        signature: rawTransactionSignature(
          transactionV1Sighash(unsigned.transaction, 0).digest,
          CLIENT_PRIVATE_KEY,
        ),
      },
    ],
  };
  return { input, expected: buildBatchGenesisTxV1Artifact(input) };
}

function buildSignedClaim({ active, settledTotal, successor, claimAmount, scriptUnits }) {
  const base = {
    network: escrowBaseParams.network,
    activeOutpoint: active.outpoint,
    activeAmount: active.amount,
    activeScriptPublicKey: active.scriptPublicKey,
    activeRedeemScript: active.redeemScript,
    covenantId,
    settledTotal,
    totalAuthorized,
    claimAmount,
    successorScriptPublicKey: successor.scriptPublicKey,
    successorRedeemScript: successor.redeemScript,
    serverOutputScriptPublicKey: PAYOUT_SCRIPT_PUBLIC_KEY,
    expectedPayoutScriptPublicKeyHash: escrowBaseParams.payoutScriptPublicKeyHash,
    fee: "1000",
    serverSignature: "00".repeat(65),
    voucherSignature,
    computeBudget: computeBudgetForScriptUnits(scriptUnits),
    scriptUnitsEstimate: scriptUnits,
  };
  const mass = buildBatchClaimTxV1Artifact(base).transaction.mass;
  const unsigned = buildBatchClaimTxV1Artifact({ ...base, mass });
  const input = {
    ...base,
    mass,
    serverSignature: transactionSignature(
      transactionV1Sighash(unsigned.transaction, 0).digest,
      SERVER_PRIVATE_KEY,
    ),
  };
  return { input, expected: buildBatchClaimTxV1Artifact(input) };
}

function buildSignedTopUp() {
  const base = {
    activeOutpoint: claim2.continuation.outpoint,
    activeAmount: claim2.continuation.amount,
    activeScriptPublicKey: state17m.scriptPublicKey,
    activeRedeemScript: state17m.redeemScript,
    covenantId,
    settledTotal: "17000000",
    successorAmount: "90000000",
    successorScriptPublicKey: state17m.scriptPublicKey,
    successorRedeemScript: state17m.redeemScript,
    clientSignature: "00".repeat(65),
    fundingInputs: [fundingInput("05", 0, "20000000")],
    changeOutputs: [
      { amount: "2999000", scriptPublicKey: CLIENT_SCRIPT_PUBLIC_KEY, covenant: null },
    ],
    expectedRefundScriptPublicKeyHash: escrowBaseParams.refundScriptPublicKeyHash,
    fee: "1000",
    computeBudget: computeBudgetForScriptUnits(TOP_UP_SCRIPT_UNITS),
    scriptUnitsEstimate: TOP_UP_SCRIPT_UNITS,
  };
  const mass = buildBatchTopUpTxV1Artifact(base).transaction.mass;
  const unsigned = buildBatchTopUpTxV1Artifact({ ...base, mass });
  const input = {
    ...base,
    mass,
    clientSignature: transactionSignature(
      transactionV1Sighash(unsigned.transaction, 0).digest,
      CLIENT_PRIVATE_KEY,
    ),
    fundingInputs: [
      {
        ...base.fundingInputs[0],
        signature: rawTransactionSignature(
          transactionV1Sighash(unsigned.transaction, 1).digest,
          CLIENT_PRIVATE_KEY,
        ),
      },
    ],
  };
  return { input, expected: buildBatchTopUpTxV1Artifact(input) };
}

function buildSignedRefund() {
  const base = {
    activeOutpoint: topUp.continuation.outpoint,
    activeAmount: topUp.continuation.amount,
    activeScriptPublicKey: state17m.scriptPublicKey,
    activeRedeemScript: state17m.redeemScript,
    covenantId,
    refundOutputScriptPublicKey: CLIENT_SCRIPT_PUBLIC_KEY,
    expectedRefundScriptPublicKeyHash: escrowBaseParams.refundScriptPublicKeyHash,
    fee: "900",
    clientSignature: "00".repeat(65),
    timeoutDaa: escrowBaseParams.timeoutDaa,
    lockTimeDaa: escrowBaseParams.timeoutDaa,
    inputSequence: "0",
    computeBudget: computeBudgetForScriptUnits(REFUND_SCRIPT_UNITS),
    scriptUnitsEstimate: REFUND_SCRIPT_UNITS,
  };
  const mass = buildBatchRefundTxV1Artifact(base).transaction.mass;
  const unsigned = buildBatchRefundTxV1Artifact({ ...base, mass });
  const input = {
    ...base,
    mass,
    clientSignature: transactionSignature(
      transactionV1Sighash(unsigned.transaction, 0).digest,
      CLIENT_PRIVATE_KEY,
    ),
  };
  return { input, expected: buildBatchRefundTxV1Artifact(input) };
}

function vector(vectorPath, kind, description, step, build) {
  return {
    path: vectorPath,
    value: {
      kind,
      description,
      validation: consensusValidation,
      input: build.input,
      sequence: {
        step,
        covenantId,
        previousTransactionId:
          step === 0
            ? null
            : [genesis, claim1, claim2, topUp][step - 1].transactionId,
        totalAuthorized: step === 1 || step === 2 ? totalAuthorized : null,
        voucherSignature: step === 1 || step === 2 ? voucherSignature : null,
      },
      expected: build.expected,
    },
  };
}

function fundingInput(txidByte, index, amount) {
  return {
    previousOutpoint: { txid: txidByte.repeat(32), index },
    amount,
    scriptPublicKey: CLIENT_SCRIPT_PUBLIC_KEY,
    signature: "00".repeat(64),
    computeBudget: TX_V1_P2PK_COMPUTE_BUDGET,
  };
}

function signVoucher(input) {
  return bytesToHex(
    schnorr.sign(
      Buffer.from(voucherV2Digest(input), "hex"),
      CLIENT_PRIVATE_KEY,
      new Uint8Array(32),
    ),
  );
}

function rawTransactionSignature(digest, privateKey) {
  return bytesToHex(
    schnorr.sign(Buffer.from(digest, "hex"), privateKey, new Uint8Array(32)),
  );
}

function transactionSignature(digest, privateKey) {
  return `${rawTransactionSignature(digest, privateKey)}01`;
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

function writeVectorsWithConsensusRollback(items) {
  const snapshots = items.map(({ path: relativePath }) => {
    const file = path.join(root, relativePath);
    const existed = fs.existsSync(file);
    return {
      file,
      existed,
      contents: existed ? fs.readFileSync(file, "utf8") : undefined,
    };
  });

  try {
    for (const item of items) writeJson(item.path, item.value);
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
  const result = spawnSync(
    process.execPath,
    [path.join(root, "scripts/validate-tx-v1-consensus.mjs")],
    { cwd: root, env: process.env, stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(`consensus validation failed with status ${result.status ?? 1}`);
  }
}
