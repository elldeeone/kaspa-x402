import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { schnorr } from "@noble/curves/secp256k1.js";
import {
  applyBatchClaimAccounting,
  assertBatchVoucherReserve,
  batchCommitmentId,
  batchCommitmentPreimageHex,
  batchRequestAuthorizationDigest,
  batchRequestAuthorizationPreimage,
  batchLaneAccounting,
  batchPaymentRequirementsHash,
  batchPaymentRequirementsPreimageHex,
  channelId,
  channelIdPreimageHex,
  stableStringify,
  voucherDigest,
  voucherPreimageHex,
} from "@kaspa-x402/core";
import {
  escrowScriptPublicKey,
  serializedScriptPublicKey,
  transactionV1CovenantId,
} from "../packages/covenant/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const clientPrivateKey = new Uint8Array(32).fill(7);
const clientPublicKey = bytesToHex(schnorr.getPublicKey(clientPrivateKey));
const serverPublicKey = bytesToHex(
  schnorr.getPublicKey(new Uint8Array(32).fill(9)),
);
const payTo =
  "kaspatest:qruer72y68se2jnlezum7chq678szh6vqamz65z7yrnvg5nq5dnpkw0ggt9lz";
const refundAddress =
  "kaspatest:qzvfczmkedtrju0aexl0x8kqds6kpueyn4hwnewc83tky4vkup0k7mkzgqdwu";

const activeOutpoint = { txid: "44".repeat(32), index: 2 };
const successorOutpoint = { txid: "45".repeat(32), index: 1 };
const channelConfig = {
  network: "kaspa:testnet-10",
  asset: "KAS",
  templateId: "kaspa-x402-escrow-v3",
  clientPublicKey,
  serverPublicKey,
  payTo,
  refundAddress,
  refundTimeoutDaa: "123456789",
  salt: "55".repeat(32),
};
const resolvedChannelId = channelId(channelConfig);
const payoutScriptPublicKey = `000020${bytesToHex(
  schnorr.getPublicKey(new Uint8Array(32).fill(8)),
)}ac`;
const refundScriptPublicKey = `000020${clientPublicKey}ac`;
const escrowParams = (settledTotal) => ({
  clientPublicKey,
  serverPublicKey,
  network: channelConfig.network,
  payoutScriptPublicKeyHash: sha256HexBytes(payoutScriptPublicKey),
  refundScriptPublicKeyHash: sha256HexBytes(refundScriptPublicKey),
  timeoutDaa: channelConfig.refundTimeoutDaa,
  settledTotal,
});
const genesisScriptPublicKey = serializedScriptPublicKey(
  escrowScriptPublicKey(escrowParams("0")),
);
const activeScriptPublicKey = serializedScriptPublicKey(
  escrowScriptPublicKey(escrowParams("17000000")),
);
const successorScriptPublicKey = serializedScriptPublicKey(
  escrowScriptPublicKey(escrowParams("25000000")),
);
const genesisAuthorizingInput = { txid: "01".repeat(32), index: 0 };
const covenantId = transactionV1CovenantId(genesisAuthorizingInput, [
  {
    index: 0,
    output: {
      amount: "90000000",
      scriptPublicKey: genesisScriptPublicKey,
    },
  },
]);

const voucherInput = {
  network: channelConfig.network,
  covenantId,
  amount: "30000000",
};
const voucherDigestHex = voucherDigest(voucherInput);
const voucher = {
  covenantId,
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
    binding: "kaspa-escrow-v2",
    templateId: channelConfig.templateId,
    serverPublicKey,
    minDepositSompi: "90000000",
    claimReserveSompi: "2000000",
    refundTimeoutDaa: channelConfig.refundTimeoutDaa,
  },
};
const requestFingerprint = "99".repeat(32);
const requestAuthorizationInput = {
  network: accepted.network,
  channelId: resolvedChannelId,
  covenantId,
  amount: voucher.amount,
  paymentRequirementsHash: batchPaymentRequirementsHash(accepted),
  requestHash: requestFingerprint,
  audience: "https://api.example.test/report.pdf",
  expiresAt: "2026-08-27T12:00:00.000Z",
  nonce: "98".repeat(32),
};
const requestAuthorizationDigest = batchRequestAuthorizationDigest(
  requestAuthorizationInput,
);
const requestAuthorization = {
  version: "kaspa-x402-batch-request-authorization-v1",
  expiresAt: requestAuthorizationInput.expiresAt,
  nonce: requestAuthorizationInput.nonce,
  digest: requestAuthorizationDigest,
  signature: bytesToHex(
    schnorr.sign(
      Buffer.from(requestAuthorizationDigest, "hex"),
      clientPrivateKey,
      new Uint8Array(32),
    ),
  ),
};
const commitmentInput = {
  accepted,
  channelId: resolvedChannelId,
  requestFingerprint,
  activeOutpoint,
  voucher,
  chargedAmount: "700000",
  chargedCumulativeBefore: "24300000",
  chargedCumulativeAfter: "25000000",
  claimedCumulativeAmount: "17000000",
};
const commitmentId = batchCommitmentId(commitmentInput);
const channelStateBefore = {
  channelId: resolvedChannelId,
  covenantId,
  activeOutpoint,
  activeScriptPublicKey,
  fundingAmount: "90000000",
  chargedCumulativeAmount: commitmentInput.chargedCumulativeBefore,
  claimedCumulativeAmount: commitmentInput.claimedCumulativeAmount,
  signedMaxClaimable: voucher.amount,
};
const channelStateAfterCharge = {
  ...channelStateBefore,
  chargedCumulativeAmount: commitmentInput.chargedCumulativeAfter,
};
const claimAmount = "8000000";
const channelStateAfterClaim = {
  ...channelStateAfterCharge,
  ...applyBatchClaimAccounting(channelStateAfterCharge, claimAmount),
  activeOutpoint: successorOutpoint,
  activeScriptPublicKey: successorScriptPublicKey,
};
assertBatchVoucherReserve(
  channelStateAfterCharge,
  accepted.extra.claimReserveSompi,
);

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
    channelId: resolvedChannelId,
    clientPublicKey,
    fundingOutpoint: activeOutpoint,
    activeScriptPublicKey,
    voucher,
    authorization: requestAuthorization,
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
      covenantId,
      chargedAmount: commitmentInput.chargedAmount,
      channelState: channelStateAfterCharge,
    },
  },
};

const baseChannelConfig = {
  network: "kaspa:testnet-10",
  asset: "KAS",
  templateId: "kaspa-x402-escrow-v3",
  clientPublicKey: "33".repeat(32),
  serverPublicKey: "44".repeat(32),
  payTo:
    "kaspatest:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
  refundAddress:
    "kaspatest:qrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr",
  refundTimeoutDaa: "123456789",
  salt: "55".repeat(32),
};
const channelVector = {
  kind: "channel-id",
  description:
    "Alpha.11 channel ID vector for immutable batch lane configuration on kaspa:testnet-10.",
  context: {
    x402Version: 2,
    scheme: "batch-settlement",
    notHashed: ["covenantId", "activeOutpoint", "activeScriptPublicKey"],
  },
  input: baseChannelConfig,
  expected: {
    preimage: channelIdPreimageHex(baseChannelConfig),
    channelId: channelId(baseChannelConfig),
  },
};

const voucherCases = [
  ["base", voucherInput],
  ["different-network", { ...voucherInput, network: "kaspa:mainnet" }],
  ["different-covenant-id", { ...voucherInput, covenantId: "67".repeat(32) }],
  ["amount-plus-one", { ...voucherInput, amount: "30000001" }],
].map(([name, input]) => ({
  name,
  input,
  expected: {
    preimage: voucherPreimageHex(input),
    digest: voucherDigest(input),
  },
}));
const voucherVector = {
  kind: "voucher-digest",
  description:
    "Alpha.11 voucher digest vectors proving network, stable covenant id, and lifetime cumulative ceiling binding.",
  context: {
    domain: "kaspa:x402:escrow-voucher:v2",
    signedFields: ["network", "covenantId", "amount"],
    notSigned: ["activeOutpoint", "activeScriptPublicKey"],
  },
  cases: voucherCases,
};

const httpVector = {
  kind: "x402-http",
  description:
    "Alpha.11 semantic HTTP header vector for a batch-settlement voucher request.",
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

const interopVector = {
  kind: "batch-interop-v2",
  description:
    "Language-independent Alpha.11 channel, KIP-20 lineage, voucher, request commitment, lifetime accounting, expiry, and finality evidence.",
  scope: {
    transactionEvidenceIncluded: false,
    reason:
      "KIP-20 genesis and successor transaction evidence is maintained in transaction-v1 vectors; this vector covers the non-transaction protocol layer.",
  },
  channel: {
    config: channelConfig,
    preimage: channelIdPreimageHex(channelConfig),
    channelId: resolvedChannelId,
  },
  lineage: {
    covenantId,
    genesisDerivation: {
      authorizingInput: genesisAuthorizingInput,
      authorizedOutputs: [
        {
          index: 0,
          amount: "90000000",
          scriptPublicKey: genesisScriptPublicKey,
        },
      ],
      note: "Canonical KIP-20 id derivation input only; this is not accepted transaction evidence.",
    },
    currentHead: {
      outpoint: activeOutpoint,
      scriptPublicKey: activeScriptPublicKey,
    },
    successorHead: {
      outpoint: successorOutpoint,
      scriptPublicKey: successorScriptPublicKey,
    },
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
  requestAuthorization: {
    input: requestAuthorizationInput,
    preimage: batchRequestAuthorizationPreimage(requestAuthorizationInput),
    digest: requestAuthorizationDigest,
    signerPublicKey: clientPublicKey,
    signature: requestAuthorization.signature,
    expected: "valid-schnorr-signature",
  },
  commitment: {
    input: commitmentInput,
    preimage: batchCommitmentPreimageHex(commitmentInput),
    commitmentId,
  },
  accounting: {
    reserveAmount: accepted.extra.claimReserveSompi,
    claimAmount,
    beforeRequest: channelStateBefore,
    afterRequest: channelStateAfterCharge,
    afterClaim: channelStateAfterClaim,
    derivedBeforeRequest: stringifyBigints(batchLaneAccounting(channelStateBefore)),
    derivedAfterRequest: stringifyBigints(
      batchLaneAccounting(channelStateAfterCharge),
    ),
    derivedAfterClaim: stringifyBigints(batchLaneAccounting(channelStateAfterClaim)),
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

writeOrCheck("vectors/channel-id/base.json", channelVector);
writeOrCheck("vectors/voucher/stable-covenant-binding.json", voucherVector);
writeOrCheck("vectors/x402-http/batch-voucher.json", httpVector);
writeOrCheck("vectors/batch/interop-v2.json", interopVector);

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

function bytesToHex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

function encode(value) {
  return Buffer.from(stableStringify(value), "utf8").toString("base64");
}

function sha256HexBytes(hex) {
  return crypto
    .createHash("sha256")
    .update(Buffer.from(hex, "hex"))
    .digest("hex");
}

function stringifyBigints(value) {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, item.toString()]),
  );
}
