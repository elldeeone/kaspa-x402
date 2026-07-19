import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { schnorr } from "@noble/curves/secp256k1.js";
import {
  batchCommitmentId,
  batchCommitmentPreimageHex,
  batchPaymentRequirementsHash,
  batchPaymentRequirementsPreimageHex,
  channelId,
  channelIdPreimageHex,
  stableStringify,
  voucherDigest,
  voucherPreimageHex,
} from "@kaspa-x402/core";
import {
  buildEscrowRedeemScript,
  escrowScriptPublicKey,
  serializedScriptPublicKey,
} from "../packages/covenant/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const clientPrivateKey = new Uint8Array(32).fill(7);
const clientPublicKey = bytesToHex(schnorr.getPublicKey(clientPrivateKey));
const serverPublicKey = bytesToHex(
  schnorr.getPublicKey(new Uint8Array(32).fill(9)),
);
const payoutPublicKey = bytesToHex(
  schnorr.getPublicKey(new Uint8Array(32).fill(8)),
);
const payoutScriptPublicKey = `000020${payoutPublicKey}ac`;
const refundScriptPublicKey = `000020${clientPublicKey}ac`;
const payTo =
  "kaspatest:qruer72y68se2jnlezum7chq678szh6vqamz65z7yrnvg5nq5dnpkw0ggt9lz";
const refundAddress =
  "kaspatest:qzvfczmkedtrju0aexl0x8kqds6kpueyn4hwnewc83tky4vkup0k7mkzgqdwu";
const channelConfig = {
  network: "kaspa:testnet-10",
  asset: "KAS",
  templateId: "kaspa-x402-escrow-v1",
  clientPublicKey,
  serverPublicKey,
  payTo,
  refundAddress,
  refundTimeoutDaa: "123456789",
  salt: "55".repeat(32),
};
const escrowParams = {
  clientPublicKey,
  serverPublicKey,
  network: channelConfig.network,
  payoutScriptPublicKeyHash: sha256HexBytes(payoutScriptPublicKey),
  refundScriptPublicKeyHash: sha256HexBytes(refundScriptPublicKey),
  timeoutDaa: channelConfig.refundTimeoutDaa,
};
const redeemScript = buildEscrowRedeemScript(escrowParams);
const activeScriptPublicKey = serializedScriptPublicKey(
  escrowScriptPublicKey(escrowParams),
);
const activeOutpoint = { txid: "44".repeat(32), index: 2 };
const voucherInput = {
  network: channelConfig.network,
  activeScriptPublicKey,
  outpoint: activeOutpoint,
  amount: "30000000",
};
const voucherDigestHex = voucherDigest(voucherInput);
const voucher = {
  amount: voucherInput.amount,
  signature: bytesToHex(
    schnorr.sign(
      Buffer.from(voucherDigestHex, "hex"),
      clientPrivateKey,
      new Uint8Array(32),
    ),
  ),
};
if (
  !schnorr.verify(
    Buffer.from(voucher.signature, "hex"),
    Buffer.from(voucherDigestHex, "hex"),
    Buffer.from(clientPublicKey, "hex"),
  )
) {
  throw new Error("deterministic voucher signature does not verify");
}

const accepted = {
  scheme: "batch-settlement",
  network: channelConfig.network,
  amount: "1000000",
  asset: "KAS",
  payTo,
  maxTimeoutSeconds: 60,
  extra: {
    binding: "kaspa-escrow-v1",
    templateId: channelConfig.templateId,
    serverPublicKey,
    minDepositSompi: "90000000",
    refundTimeoutDaa: channelConfig.refundTimeoutDaa,
  },
};
const requestFingerprint = "99".repeat(32);
const commitmentInput = {
  accepted,
  channelId: channelId(channelConfig),
  requestFingerprint,
  activeOutpoint,
  voucher,
  chargedAmount: "700000",
  chargedCumulativeBefore: "24300000",
  chargedCumulativeAfter: "25000000",
  claimedCumulativeAmount: "0",
};
const commitmentId = batchCommitmentId(commitmentInput);
const channelStateBefore = {
  channelId: commitmentInput.channelId,
  activeOutpoint,
  activeScriptPublicKey,
  fundingAmount: "90000000",
  chargedCumulativeAmount: commitmentInput.chargedCumulativeBefore,
  claimedCumulativeAmount: commitmentInput.claimedCumulativeAmount,
  signedMaxClaimable: voucher.amount,
};
const channelStateAfter = {
  ...channelStateBefore,
  chargedCumulativeAmount: commitmentInput.chargedCumulativeAfter,
};
const paymentRequired = {
  x402Version: 2,
  resource: {
    url: "https://api.example.test/report.pdf",
    description: "Research report",
    mimeType: "application/pdf",
  },
  accepts: [accepted],
};
const paymentPayload = {
  x402Version: 2,
  accepted,
  payload: {
    type: "voucher",
    channelId: commitmentInput.channelId,
    clientPublicKey,
    fundingOutpoint: activeOutpoint,
    activeScriptPublicKey,
    voucher,
  },
};
const settlementResponse = {
  success: true,
  transaction: commitmentId,
  network: channelConfig.network,
  payer: refundAddress,
  amount: commitmentInput.chargedAmount,
  extensions: {
    kaspa: {
      commitmentId,
      chargedAmount: commitmentInput.chargedAmount,
      channelState: channelStateAfter,
    },
  },
};
const httpVector = {
  kind: "x402-http",
  description:
    "Semantic HTTP header vector for a batch-settlement voucher request.",
  verificationContext: {
    channelConfig,
    channelStateBefore,
    requestFingerprint,
  },
  paymentRequired,
  paymentPayload,
  settlementResponse,
  headers: {
    paymentRequired: encode(paymentRequired),
    paymentSignature: encode(paymentPayload),
    paymentResponse: encode(settlementResponse),
  },
};

const claim = readJson("vectors/tx-v1/batch-claim.json");
const refund = readJson("vectors/tx-v1/batch-refund.json");
assertEqual(
  claim.input.activeScriptPublicKey,
  activeScriptPublicKey,
  "claim active script",
);
assertEqual(
  claim.input.voucherSignature,
  voucher.signature,
  "claim voucher signature",
);
assertEqual(
  claim.input.claimAmount,
  commitmentInput.chargedCumulativeAfter,
  "claim amount",
);
assertEqual(
  refund.input.activeScriptPublicKey,
  activeScriptPublicKey,
  "refund active script",
);

const interopVector = {
  kind: "batch-interop-v1",
  description:
    "Language-independent channel, escrow, voucher, commitment, claim, refund, expiry, and finality evidence for Kaspa batch-settlement v1.",
  channel: {
    config: channelConfig,
    preimage: channelIdPreimageHex(channelConfig),
    channelId: commitmentInput.channelId,
  },
  escrow: {
    templateId: channelConfig.templateId,
    params: escrowParams,
    redeemScript,
    scriptPublicKey: activeScriptPublicKey,
    payoutScriptPublicKey,
    refundScriptPublicKey,
  },
  voucher: {
    input: voucherInput,
    preimage: voucherPreimageHex(voucherInput),
    digest: voucherDigestHex,
    signerPublicKey: clientPublicKey,
    signature: voucher.signature,
    expected: "valid-schnorr-signature",
  },
  paymentRequirements: {
    value: accepted,
    preimage: batchPaymentRequirementsPreimageHex(accepted),
    sha256: batchPaymentRequirementsHash(accepted),
  },
  commitment: {
    input: commitmentInput,
    preimage: batchCommitmentPreimageHex(commitmentInput),
    commitmentId,
  },
  transactions: {
    claim: transactionReference("vectors/tx-v1/batch-claim.json", claim),
    refund: transactionReference("vectors/tx-v1/batch-refund.json", refund),
    note: "Funding and top-up construction is wallet-adapter-owned. The binding verifies the accepted resulting escrow UTXO and, for top-up, its transition from the prior active outpoint.",
  },
  expiry: {
    timeoutDaa: channelConfig.refundTimeoutDaa,
    lockTimeBoundary: "500000000000",
    rule: "the refund transaction lock time is at least timeoutDaa and consensus can accept it only when the current DAA score strictly exceeds that lock time",
    cases: [
      { currentDaa: "123456788", expected: "refund-not-mature" },
      { currentDaa: "123456789", expected: "refund-not-mature" },
      { currentDaa: "123456790", expected: "refund-mature" },
      {
        timeoutDaa: "500000000000",
        expected: "invalid-timestamp-domain-timeout",
      },
    ],
  },
  finality: {
    ordering: ["mempool", "accepted", "confirmed"],
    cases: [
      { actual: "mempool", required: "accepted", expected: false },
      { actual: "accepted", required: "accepted", expected: true },
      { actual: "accepted", required: "confirmed", expected: false },
      { actual: "confirmed", required: "accepted", expected: true },
      { actual: "confirmed", required: "confirmed", expected: true },
    ],
  },
};

writeOrCheck("vectors/x402-http/batch-voucher.json", httpVector);
writeOrCheck("vectors/batch/interop-v1.json", interopVector);

function transactionReference(relativePath, vector) {
  return {
    path: relativePath,
    sha256: crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.join(root, relativePath)))
      .digest("hex"),
    transactionId: vector.expected.transactionId,
    transactionHash: vector.expected.transactionHash,
    sighash: vector.expected.sighash,
    compute: vector.expected.compute,
    fullConsensusValidated: true,
    scriptExecuted: true,
  };
}

function writeOrCheck(relativePath, value) {
  const output = path.join(root, relativePath);
  const rendered = `${JSON.stringify(value, null, 2)}\n`;
  if (check) {
    if (
      !fs.existsSync(output) ||
      fs.readFileSync(output, "utf8") !== rendered
    ) {
      throw new Error(
        `${relativePath} is stale; run scripts/generate-batch-interop-vector.mjs`,
      );
    }
    console.log(`verified ${relativePath}`);
    return;
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, rendered);
  console.log(`wrote ${relativePath}`);
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
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

function encode(value) {
  return Buffer.from(stableStringify(value), "utf8").toString("base64");
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch: expected ${expected}, got ${actual}`);
  }
}
