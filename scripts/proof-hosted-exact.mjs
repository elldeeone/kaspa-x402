#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import {
  bytesToHex,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  exactRequestAuthorizationDigest,
  hexToBytes,
  readKaspaSettlementExtension,
  stableStringify,
} from "@kaspa-x402/core";
import {
  DirectModeClient,
  MemoryChannelStore,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
} from "@kaspa-x402/client";
import {
  KIP10_ADDITIVE_TEMPLATE_ID,
  KIP10_EXACT_TRANSACTION_ENCODING,
  buildKip10AdditiveBorrowArgs,
  buildKip10AdditiveRedeemScript,
  calculateKaspaStorageMass,
  kip10AdditiveScriptPublicKey,
  serializedScriptPublicKey,
} from "@kaspa-x402/covenant";
import {
  assertHostedOfferPinned,
  assertHostedSettlementHeadPinned,
} from "./hosted-offer-pins.mjs";

const DEFAULT_GATEWAY_URL = "https://demo.kaspa-x402.org";
const DEFAULT_CONFIRMATION_TIMEOUT_MS = 120_000;
const DEFAULT_FEE_SOMPI = 2_000_000n;
const DEFAULT_HEAD_AMOUNT = 100_000_000n;
const DEFAULT_ADDITIVE_THRESHOLD = 10_000_000n;
const EXACT_KIP10_COMPUTE_BUDGET = 10;
const NATIVE_SUBNETWORK_ID = "00".repeat(20);
const CONFIRMATION = "I_UNDERSTAND_THIS_USES_TESTNET_FUNDS";

const options = readOptions(process.argv.slice(2));
const fileEnv = readOptionalEnv(options.configFile);
const env = { ...nonEmptyValues(fileEnv), ...process.env };
const config = {
  gatewayBase: normalizedBaseUrl(
    env.KASPA_X402_DEMO_GATEWAY_URL ||
      env.KASPA_X402_GATEWAY_BASE_URL ||
      DEFAULT_GATEWAY_URL,
  ),
  adminToken: env.KASPA_X402_DEMO_ADMIN_TOKEN || "",
  network: env.KASPA_X402_NETWORK || "kaspa:testnet-10",
  rpcUrl: env.KASPA_X402_RPC_URL || "",
  fundingWallet: env.KASPA_X402_FUNDING_WALLET || "",
  dataDir: env.KASPA_X402_DATA_DIR || ".kaspa-x402-live",
  sdkPath: env.KASPA_X402_KASPA_WASM_MODULE || "",
  reportFile:
    env.KASPA_X402_HOSTED_EXACT_REPORT_FILE ||
    ".kaspa-x402-live/hosted-exact-report.json",
  exactProfile: env.KASPA_X402_EXACT_PROFILE || "standard-native",
  expectedGatewayOrigin: env.KASPA_X402_EXPECTED_GATEWAY_ORIGIN || "",
  expectedExactProfile: env.KASPA_X402_EXPECTED_EXACT_PROFILE || "",
  expectedExactAmount: env.KASPA_X402_EXPECTED_EXACT_AMOUNT || "",
  expectedExactPayTo: env.KASPA_X402_EXPECTED_EXACT_PAY_TO || "",
  headAmount: BigInt(env.KASPA_X402_EXACT_HEAD_AMOUNT || DEFAULT_HEAD_AMOUNT),
  additiveThreshold: BigInt(
    env.KASPA_X402_EXACT_ADDITIVE_THRESHOLD || DEFAULT_ADDITIVE_THRESHOLD,
  ),
  confirmation: env.KASPA_X402_LIVE_CONFIRM || "",
};

const report = {
  generatedAt: new Date().toISOString(),
  mode: "hosted-exact-testnet",
  status: "blocked",
  network: config.network,
  gatewayBase: config.gatewayBase,
  findings: [],
};

try {
  validateConfig(config);
  const result = await runHostedExactProof(config);
  writeJson(config.reportFile, {
    ...report,
    status: "complete",
    findings: [],
    result,
  });
  console.log(
    JSON.stringify(
      { ...report, status: "complete", findings: [], result },
      null,
      2,
    ),
  );
} catch (error) {
  const failed = {
    ...report,
    findings: [
      {
        severity: "blocker",
        code: "hosted_exact_error",
        message: error instanceof Error ? error.message : String(error),
      },
    ],
  };
  writeJson(config.reportFile, failed);
  console.error(JSON.stringify(failed, null, 2));
  process.exitCode = 1;
}

async function runHostedExactProof(input) {
  const sdkRequire = createRequire(path.resolve(input.sdkPath));
  globalThis.WebSocket = sdkRequire("websocket").w3cwebsocket;
  const sdk = sdkRequire(path.resolve(input.sdkPath));
  const { schnorr } = sdkRequire("@noble/curves/secp256k1.js");
  sdk.initConsolePanicHook?.();

  const networkId = kaspaNetworkId(input.network);
  fs.mkdirSync(path.resolve(input.dataDir), { recursive: true, mode: 0o700 });
  const fundingPrivateKeyHex = loadFundingPrivateKey(input.fundingWallet);
  const fundingPrivateKey = new sdk.PrivateKey(fundingPrivateKeyHex);
  const fundingAddress = fundingPrivateKey.toAddress(networkId).toString();
  const fundingPublicKey = bytesToHex(
    schnorr.getPublicKey(
      hexToBytes(fundingPrivateKeyHex, { expectedLength: 32 }),
    ),
  );
  const rpc = new sdk.RpcClient({ url: input.rpcUrl, networkId });
  const spentOutpoints = new Set();

  try {
    await rpc.connect({ timeoutDuration: 15_000, retries: 2 });
    const info = await rpc.getServerInfo();
    if (!info.isSynced)
      throw new Error("configured testnet node reports unsynced");
    if (!info.hasUtxoIndex)
      throw new Error("configured testnet node does not expose UTXO index");

    const addressCodec = makeAddressCodec(sdk, networkId);
    let additiveHead;
    let registration;
    let statsAfterRegister;
    if (input.exactProfile === "additive") {
      additiveHead = await createHostedHead({
        rpc,
        sdk,
        network: input.network,
        networkId,
        addressCodec,
        fundingPrivateKey,
        fundingAddress,
        fundingPublicKey,
        headAmount: input.headAmount,
        additiveThreshold: input.additiveThreshold,
        spentOutpoints,
      });
      registration = await gatewayAdminRequest(
        input.gatewayBase,
        "/admin/exact-heads/register",
        input.adminToken,
        {
          method: "POST",
          body: JSON.stringify({ records: [additiveHead.record] }),
        },
      );
      statsAfterRegister = await gatewayAdminRequest(
        input.gatewayBase,
        "/admin/exact-heads",
        input.adminToken,
      );
    }

    const fundingProvider = makeFundingProvider({
      rpc,
      sdk,
      network: input.network,
      networkId,
      fundingPrivateKey,
      fundingPrivateKeyHex,
      fundingAddress,
      schnorr,
      spentOutpoints,
    });
    const expectedPayTo =
      input.expectedExactPayTo || additiveHead?.record.payTo || "";
    const client = new DirectModeClient({
      fundingProvider,
      signer: makeSigner({ schnorr, dataDir: input.dataDir }),
      store: new MemoryChannelStore(),
      addressCodec,
      refundAddress: fundingAddress,
      supportedNetworks: [input.network],
      fetch: gatewayFetch,
      maxPaymentRetries: 0,
      fundingPolicy: {
        allowedOrigins: [input.expectedGatewayOrigin],
        allowedExactProfiles: [input.expectedExactProfile],
        allowedPayTo: [expectedPayTo],
        maximumExactAmountSompi: input.expectedExactAmount,
      },
    });

    const exactUrl = new URL("/exact", input.gatewayBase).toString();
    const required = await fetchPaymentRequired(exactUrl);
    assertHostedOfferPinned(required, {
      exactUrl,
      gatewayOrigin: input.expectedGatewayOrigin,
      profile: input.expectedExactProfile,
      amount: input.expectedExactAmount,
      payTo: expectedPayTo,
      network: input.network,
      ...(additiveHead ? { head: additiveHead.record } : {}),
    });
    const paymentIdentifier = `hosted-exact-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const payment = await client.createPayment(required, {
      url: exactUrl,
      paymentIdentifier,
    });
    if (
      payment.scheme !== "exact" ||
      payment.paymentPayload.payload.type !== "exact-transaction"
    ) {
      throw new Error(
        "hosted exact challenge did not produce an exact-transaction payment",
      );
    }
    writeJson(path.join(input.dataDir, "last-hosted-exact-payment.json"), {
      generatedAt: new Date().toISOString(),
      paymentIdentifier,
      accepted: payment.paymentPayload.accepted,
      payload: payment.paymentPayload.payload,
      extensions: payment.paymentPayload.extensions,
      transactionArtifactSha256: sha256Hex(
        payment.paymentPayload.payload.transaction,
      ),
    });
    const paid = await submitPayment(exactUrl, payment.paymentPayload, {
      expectStatus: 200,
      label: "hosted exact",
    });
    const settlement = decodePaymentResponseHeader(
      paid.headers.get(PAYMENT_RESPONSE_HEADER),
    );
    const applied = await client.applySettlement(payment, settlement);
    const replay = await submitPayment(exactUrl, payment.paymentPayload, {
      expectStatus: 200,
      label: "hosted exact idempotent replay",
    });
    const replaySettlement = decodePaymentResponseHeader(
      replay.headers.get(PAYMENT_RESPONSE_HEADER),
    );
    const crossResourceReplay = await submitPayment(
      new URL("/exact/report", input.gatewayBase).toString(),
      payment.paymentPayload,
      {
        expectStatus: 409,
        label: "hosted exact cross-resource replay",
      },
    );
    if (crossResourceReplay.body?.error !== "invalid_transaction_state") {
      throw new Error(
        `hosted exact cross-resource replay returned unexpected error: ${JSON.stringify(crossResourceReplay.body)}`,
      );
    }
    const statsAfterPayment =
      input.exactProfile === "additive"
        ? await gatewayAdminRequest(
            input.gatewayBase,
            "/admin/exact-heads",
            input.adminToken,
          )
        : undefined;
    const extra = readKaspaSettlementExtension(settlement);
    if (additiveHead) {
      assertHostedSettlementHeadPinned(extra, additiveHead.record);
    }
    const observedPayment = await waitForAddressOutpoint({
      rpc,
      address: payment.paymentPayload.accepted.payTo,
      txid: settlement.transaction,
      index:
        extra?.paymentOutputIndex ??
        payment.paymentPayload.payload.paymentOutputIndex,
      amount:
        input.exactProfile === "additive"
          ? BigInt(payment.paymentPayload.accepted.extra.headAmount) +
            BigInt(settlement.amount)
          : BigInt(settlement.amount),
      scriptPublicKey: addressCodec.scriptPublicKeyForAddress(
        payment.paymentPayload.accepted.payTo,
        input.network,
      ),
    });

    return {
      node: {
        rpcUrl: redactRpc(input.rpcUrl),
        networkId: info.networkId,
        virtualDaaScore: String(info.virtualDaaScore),
      },
      fundingAddress,
      exactProfile: input.exactProfile,
      expectedOffer: {
        gatewayOrigin: input.expectedGatewayOrigin,
        profile: input.expectedExactProfile,
        amount: input.expectedExactAmount,
        payTo: expectedPayTo,
      },
      ...(additiveHead
        ? {
            head: {
              headId: additiveHead.record.headId,
              fundingOutpoint: additiveHead.record.currentOutpoint,
              headAmount: additiveHead.record.currentAmount,
              additiveThresholdSompi:
                additiveHead.record.additiveThresholdSompi,
              address: additiveHead.record.payTo,
              registrationStatus:
                registration?.ok === true ? "registered" : "unknown",
              statsAfterRegister:
                registration?.stats ?? statsAfterRegister?.stats,
            },
          }
        : {}),
      exact: {
        status: paid.status,
        responseBody: paid.body,
        settlementTransaction: settlement.transaction,
        settlementAmount: settlement.amount,
        finality: extra?.finality,
        paymentOutputIndex: extra?.paymentOutputIndex,
        exactProfile: extra?.exactProfile,
        headId: extra?.headId,
        chargedAmount: applied.chargedAmount,
        transactionArtifactSha256: sha256Hex(
          payment.paymentPayload.payload.transaction,
        ),
        gatewaySettlement: {
          broadcaster: "demo-gateway-pnn",
          observedFinality: "accepted",
          observedOutpoint: observedPayment.outpoint,
        },
        replayStatus: replay.status,
        replaySettlementTransaction: replaySettlement.transaction,
        crossResourceReplayStatus: crossResourceReplay.status,
        crossResourceReplayError: crossResourceReplay.body.error,
      },
      ...(statsAfterPayment
        ? { statsAfterPayment: statsAfterPayment.stats }
        : {}),
    };
  } finally {
    await rpc.disconnect().catch(() => undefined);
  }
}

async function createHostedHead(input) {
  const redeemScript = buildKip10AdditiveRedeemScript({
    ownerPublicKey: input.fundingPublicKey,
    amount: input.additiveThreshold,
  });
  const scriptPublicKey = kip10AdditiveScriptPublicKey({
    ownerPublicKey: input.fundingPublicKey,
    amount: input.additiveThreshold,
  });
  const headScriptPublicKey = serializedScriptPublicKey(scriptPublicKey);
  const headAddress = input.addressCodec.encodeScriptAddress({
    network: input.network,
    scriptPublicKey,
    serializedScriptPublicKey: headScriptPublicKey,
  });
  const sent = await fundKip10Head({
    rpc: input.rpc,
    sdk: input.sdk,
    networkId: input.networkId,
    fundingPrivateKey: input.fundingPrivateKey,
    fundingAddress: input.fundingAddress,
    headAmount: input.headAmount,
    headScriptPublicKey,
    spentOutpoints: input.spentOutpoints,
  });
  const utxo = await waitForAddressOutpoint({
    rpc: input.rpc,
    address: headAddress,
    txid: sent.txid,
    amount: input.headAmount,
    scriptPublicKey: headScriptPublicKey,
  });
  const now = new Date().toISOString();
  const headId = sha256Hex(
    stableStringify({
      scope: "kaspa:x402:additive-head:v1",
      network: input.network,
      payTo: headAddress,
      redeemScript,
      fundingOutpoint: utxo.outpoint,
    }),
  );
  return {
    record: {
      headId,
      network: input.network,
      payTo: headAddress,
      templateId: KIP10_ADDITIVE_TEMPLATE_ID,
      transactionEncoding: KIP10_EXACT_TRANSACTION_ENCODING,
      currentOutpoint: utxo.outpoint,
      currentAmount: utxo.amount,
      scriptPublicKey: headScriptPublicKey,
      redeemScript,
      additiveThresholdSompi: input.additiveThreshold.toString(),
      version: "0",
      status: "available",
      createdAt: now,
      updatedAt: now,
    },
  };
}

function makeFundingProvider(input) {
  return {
    networkId: input.network,
    sourceKind: "hot-wallet",
    async getPublicIdentity() {
      const { schnorr } = createRequire(path.resolve(config.sdkPath))(
        "@noble/curves/secp256k1.js",
      );
      return {
        address: input.fundingAddress,
        publicKey: bytesToHex(
          schnorr.getPublicKey(
            hexToBytes(loadFundingPrivateKey(config.fundingWallet), {
              expectedLength: 32,
            }),
          ),
        ),
      };
    },
    async authorizeExactPayment() {},
    async payExactTransaction(request) {
      return buildExactTransaction({
        rpc: input.rpc,
        sdk: input.sdk,
        networkId: input.networkId,
        fundingPrivateKey: input.fundingPrivateKey,
        fundingPrivateKeyHex: input.fundingPrivateKeyHex,
        fundingAddress: input.fundingAddress,
        schnorr: input.schnorr,
        request,
        spentOutpoints: input.spentOutpoints,
      });
    },
    async getUtxos(addresses) {
      const utxos = [];
      for (const address of addresses)
        utxos.push(...(await getAddressUtxos(input.rpc, address)));
      return utxos;
    },
    async getVirtualDaaScore() {
      const info = await input.rpc.getServerInfo();
      return String(info.virtualDaaScore);
    },
    async estimateFees() {
      return { feeSompi: DEFAULT_FEE_SOMPI.toString() };
    },
  };
}

async function buildExactTransaction(input) {
  return input.request.profile === "additive"
    ? buildKip10ExactTransaction(input)
    : buildStandardExactTransaction(input);
}

async function buildStandardExactTransaction(input) {
  const paymentAmount = BigInt(input.request.amount);
  const fundingNeeded = paymentAmount + DEFAULT_FEE_SOMPI;
  const fundingUtxo = await selectFundingUtxo(
    input.rpc,
    input.fundingAddress,
    fundingNeeded + 10_000_000n,
    input.spentOutpoints,
  );
  const fundingAmount = BigInt(fundingUtxo.amount);
  const fundingScriptPublicKey = scriptPublicKeyFromSerialized(
    input.sdk,
    fundingUtxo.scriptPublicKey,
  );
  const outputs = [
    {
      value: paymentAmount,
      scriptPublicKey: input.sdk.payToAddressScript(input.request.payTo),
    },
  ];
  const change = fundingAmount - fundingNeeded;
  if (change >= 10_000_000n)
    outputs.push({
      value: change,
      scriptPublicKey: input.sdk.payToAddressScript(input.fundingAddress),
    });
  const inputBase = p2pkLegacyInputBase(
    fundingUtxo.outpoint,
    fundingAmount,
    fundingScriptPublicKey,
    0n,
  );
  const txShape = {
    version: 0,
    outputs,
    lockTime: 0n,
    subnetworkId: NATIVE_SUBNETWORK_ID,
    gas: 0n,
    storageMass: exactStorageMass(
      [{ amount: fundingAmount, scriptPublicKey: fundingScriptPublicKey }],
      outputs,
    ),
    payload: "",
  };
  const unsigned = new input.sdk.Transaction({
    ...txShape,
    inputs: [{ ...inputBase, signatureScript: "" }],
  });
  const signatureScript = input.sdk.createInputSignature(
    unsigned,
    0,
    input.fundingPrivateKey,
    input.sdk.SighashType.All,
  );
  const signed = new input.sdk.Transaction({
    ...txShape,
    inputs: [{ ...inputBase, signatureScript }],
  });
  markOutpointSpent(input.spentOutpoints, fundingUtxo.outpoint);
  return exactPaymentArtifact(
    signed,
    input.fundingAddress,
    input.request,
    0,
    input.schnorr,
    input.fundingPrivateKeyHex,
  );
}

async function buildKip10ExactTransaction(input) {
  const head = input.request.head;
  if (!head)
    throw new Error(
      "hosted additive exact payment requires head challenge terms",
    );
  const paymentAmount = BigInt(input.request.amount);
  const headAmount = BigInt(head.headAmount);
  if (paymentAmount < BigInt(head.additiveThresholdSompi))
    throw new Error("payment is below the additive head threshold");
  const fundingNeeded = paymentAmount + DEFAULT_FEE_SOMPI;
  const fundingUtxo = await selectFundingUtxo(
    input.rpc,
    input.fundingAddress,
    fundingNeeded + 10_000_000n,
    input.spentOutpoints,
  );
  const fundingAmount = BigInt(fundingUtxo.amount);
  const headScriptPublicKey = scriptPublicKeyFromSerialized(
    input.sdk,
    head.headScriptPublicKey,
  );
  const fundingScriptPublicKey = scriptPublicKeyFromSerialized(
    input.sdk,
    fundingUtxo.scriptPublicKey,
  );
  const changeScriptPublicKey = input.sdk.payToAddressScript(
    input.fundingAddress,
  );
  const change = fundingAmount - fundingNeeded;
  const outputs = [
    { value: headAmount + paymentAmount, scriptPublicKey: headScriptPublicKey },
  ];
  if (change >= 10_000_000n)
    outputs.push({ value: change, scriptPublicKey: changeScriptPublicKey });
  const headInput = p2shComputeBudgetInputBase(
    head.expectedHeadOutpoint,
    headAmount,
    headScriptPublicKey,
    0n,
    EXACT_KIP10_COMPUTE_BUDGET,
  );
  const fundingInput = p2pkInputBase(
    fundingUtxo.outpoint,
    fundingAmount,
    fundingScriptPublicKey,
    0n,
  );
  const txShape = {
    version: 1,
    outputs,
    lockTime: 0n,
    subnetworkId: NATIVE_SUBNETWORK_ID,
    gas: 0n,
    storageMass: exactStorageMass(
      [
        { amount: headAmount, scriptPublicKey: headScriptPublicKey },
        { amount: fundingAmount, scriptPublicKey: fundingScriptPublicKey },
      ],
      outputs,
    ),
    payload: "",
  };
  const unsigned = new input.sdk.Transaction({
    ...txShape,
    inputs: [
      { ...headInput, signatureScript: "" },
      { ...fundingInput, signatureScript: "" },
    ],
  });
  const fundingSignature = input.sdk.createInputSignature(
    unsigned,
    1,
    input.fundingPrivateKey,
    input.sdk.SighashType.All,
  );
  const headSignatureScript = input.sdk.payToScriptHashSignatureScript(
    head.headRedeemScript,
    buildKip10AdditiveBorrowArgs(),
  );
  const signed = new input.sdk.Transaction({
    ...txShape,
    inputs: [
      { ...headInput, signatureScript: headSignatureScript },
      { ...fundingInput, signatureScript: fundingSignature },
    ],
  });
  markOutpointSpent(input.spentOutpoints, fundingUtxo.outpoint);
  return exactPaymentArtifact(
    signed,
    input.fundingAddress,
    input.request,
    1,
    input.schnorr,
    input.fundingPrivateKeyHex,
  );
}

function exactPaymentArtifact(
  transaction,
  payerAddress,
  request,
  authorizationInputIndex,
  schnorr,
  fundingPrivateKeyHex,
) {
  const authorizationDigest = exactRequestAuthorizationDigest({
    network: request.network,
    profile: request.profile,
    transactionId: transaction.id,
    paymentOutputIndex: 0,
    amount: request.amount,
    payTo: request.payTo,
    payToScriptPublicKey: request.payToScriptPublicKey,
    paymentRequirementsHash: request.paymentRequirementsHash,
    requestHash: request.requestHash,
    challengeId: request.head?.challengeId,
    inputIndex: authorizationInputIndex,
    expiresAt: request.authorizationExpiresAt,
  });
  return {
    transaction: transaction.serializeToSafeJSON(),
    transactionEncoding: KIP10_EXACT_TRANSACTION_ENCODING,
    paymentOutputIndex: 0,
    transactionId: transaction.id,
    authorization: {
      version: "kaspa-x402-exact-request-authorization-v1",
      inputIndex: authorizationInputIndex,
      expiresAt: request.authorizationExpiresAt,
      digest: authorizationDigest,
      signature: bytesToHex(
        schnorr.sign(
          hexToBytes(authorizationDigest, { expectedLength: 32 }),
          hexToBytes(fundingPrivateKeyHex, { expectedLength: 32 }),
        ),
      ),
    },
    payerAddress,
    fundingSource: "hot-wallet",
  };
}

async function fundKip10Head(input) {
  const source = await selectFundingUtxo(
    input.rpc,
    input.fundingAddress,
    input.headAmount + DEFAULT_FEE_SOMPI + 10_000_000n,
    input.spentOutpoints,
  );
  const sourceAmount = BigInt(source.amount);
  const sourceScriptPublicKey = scriptPublicKeyFromSerialized(
    input.sdk,
    source.scriptPublicKey,
  );
  const headSpk = scriptPublicKeyFromSerialized(
    input.sdk,
    input.headScriptPublicKey,
  );
  const fundingSpk = input.sdk.payToAddressScript(input.fundingAddress);
  const change = sourceAmount - input.headAmount - DEFAULT_FEE_SOMPI;
  if (change < 10_000_000n)
    throw new Error(
      `funding UTXO ${sourceAmount} leaves non-standard change ${change}`,
    );
  const txShape = {
    version: 0,
    outputs: [
      { value: input.headAmount, scriptPublicKey: headSpk },
      { value: change, scriptPublicKey: fundingSpk },
    ],
    lockTime: 0n,
    subnetworkId: NATIVE_SUBNETWORK_ID,
    gas: 0n,
    payload: "",
  };
  const inputBase = p2pkLegacyInputBase(
    source.outpoint,
    sourceAmount,
    sourceScriptPublicKey,
    0n,
  );
  const unsigned = new input.sdk.Transaction({
    ...txShape,
    inputs: [{ ...inputBase, signatureScript: "" }],
  });
  const signatureScript = input.sdk.createInputSignature(
    unsigned,
    0,
    input.fundingPrivateKey,
    input.sdk.SighashType.All,
  );
  const signed = new input.sdk.Transaction({
    ...txShape,
    inputs: [{ ...inputBase, signatureScript }],
  });
  const { transactionId } = await input.rpc.submitTransaction({
    transaction: signed,
    allowOrphan: false,
  });
  markOutpointSpent(input.spentOutpoints, source.outpoint);
  return { txid: String(transactionId) };
}

async function fetchPaymentRequired(url) {
  const response = await fetch(url, { redirect: "error" });
  if (response.status !== 402)
    throw new Error(
      `${url} expected 402, got ${response.status}: ${await response.text()}`,
    );
  const header = response.headers.get(PAYMENT_REQUIRED_HEADER);
  if (!header) throw new Error(`${url} missing PAYMENT-REQUIRED`);
  return header;
}

async function submitPayment(url, paymentPayload, { expectStatus, label }) {
  const header = encodePaymentSignatureHeader(paymentPayload);
  const response = await fetch(url, {
    method: "GET",
    redirect: "error",
    headers: { [PAYMENT_SIGNATURE_HEADER]: header },
  });
  const text = await response.text();
  const body = parseJson(text);
  if (response.status !== expectStatus) {
    throw new Error(
      `${label} expected ${expectStatus}, got ${JSON.stringify({ status: response.status, body, text })}`,
    );
  }
  return { status: response.status, body, text, headers: response.headers };
}

async function gatewayFetch(input, init = {}) {
  return fetch(input, {
    method: init.method,
    body: init.body,
    headers: init.headers,
    redirect: "error",
  });
}

async function gatewayAdminRequest(baseUrl, pathName, adminToken, init = {}) {
  const response = await fetch(new URL(pathName, baseUrl), {
    ...init,
    redirect: "error",
    headers: {
      authorization: `Bearer ${adminToken}`,
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const text = await response.text();
  const body = parseJson(text);
  if (!response.ok || body?.ok === false)
    throw new Error(
      `gateway admin request failed ${response.status}: ${body?.error ?? text.slice(0, 200)}`,
    );
  return body;
}

async function selectFundingUtxo(
  rpc,
  fundingAddress,
  minimumAmount,
  spentOutpoints,
) {
  const candidates = await getAddressUtxos(rpc, fundingAddress);
  const sorted = candidates
    .filter(
      (utxo) =>
        BigInt(utxo.amount) >= minimumAmount &&
        !spentOutpoints?.has(outpointKey(utxo.outpoint)),
    )
    .sort((left, right) =>
      BigInt(left.amount) > BigInt(right.amount)
        ? -1
        : BigInt(left.amount) < BigInt(right.amount)
          ? 1
          : 0,
    );
  const selected = sorted[0];
  if (!selected) {
    const available =
      candidates.map((utxo) => utxo.amount).join(", ") || "none";
    throw new Error(
      `no funding UTXO covers ${minimumAmount} sompi; available: ${available}`,
    );
  }
  return selected;
}

async function waitForAddressOutpoint(input) {
  const started = Date.now();
  let last = "not checked";
  while (Date.now() - started < DEFAULT_CONFIRMATION_TIMEOUT_MS) {
    const entries = await getAddressUtxos(input.rpc, input.address);
    const match = entries.find((utxo) => {
      if (
        input.txid &&
        utxo.outpoint.txid.toLowerCase() !== input.txid.toLowerCase()
      )
        return false;
      if (input.index !== undefined && utxo.outpoint.index !== input.index)
        return false;
      if (input.amount !== undefined && BigInt(utxo.amount) !== input.amount)
        return false;
      if (
        input.scriptPublicKey &&
        utxo.scriptPublicKey.toLowerCase() !==
          input.scriptPublicKey.toLowerCase()
      )
        return false;
      return true;
    });
    if (match) return match;
    last = `${entries.length} candidate UTXO(s)`;
    await sleep(1_000);
  }
  throw new Error(
    `timed out waiting for ${input.address} outpoint ${input.txid ?? "*"}:${input.index ?? "*"} (${last})`,
  );
}

async function getAddressUtxos(rpc, address) {
  const { entries } = await rpc.getUtxosByAddresses([address]);
  return entries.map((entry) => {
    const raw = entry.entry ?? entry;
    const outpoint = raw.outpoint ?? entry.outpoint;
    return {
      outpoint: {
        txid: String(outpoint.transactionId),
        index: Number(outpoint.index),
      },
      amount: String(raw.amount ?? entry.amount),
      scriptPublicKey: serializeSdkScriptPublicKey(
        raw.scriptPublicKey ?? entry.scriptPublicKey,
      ),
      finality: "accepted",
      raw: entry,
    };
  });
}

function makeSigner({ schnorr, dataDir }) {
  return {
    async generateChannelKey() {
      const privateKey = bytesToHex(schnorr.utils.randomSecretKey());
      const publicKey = bytesToHex(
        schnorr.getPublicKey(hexToBytes(privateKey, { expectedLength: 32 })),
      );
      fs.writeFileSync(
        path.join(
          path.resolve(dataDir),
          `hosted-exact-client-${Date.now()}-${publicKey.slice(0, 12)}.json`,
        ),
        `${JSON.stringify({ createdAt: new Date().toISOString(), publicKey, privateKey }, null, 2)}\n`,
        { mode: 0o600 },
      );
      return { privateKey, publicKey };
    },
    async randomSalt() {
      return crypto.randomBytes(32).toString("hex");
    },
    async randomNonce() {
      return crypto.randomBytes(32).toString("hex");
    },
    async signVoucher() {
      throw new Error("hosted exact proof does not sign batch vouchers");
    },
  };
}

function makeAddressCodec(sdk, networkId) {
  return {
    scriptPublicKeyForAddress(address) {
      return serializeSdkScriptPublicKey(sdk.payToAddressScript(address));
    },
    encodeScriptAddress(input) {
      const spk = new sdk.ScriptPublicKey(
        input.scriptPublicKey.version,
        input.scriptPublicKey.script,
      );
      const address = sdk.addressFromScriptPublicKey(spk, networkId);
      if (!address) throw new Error("could not encode script address");
      return address.toString();
    },
  };
}

function p2pkLegacyInputBase(outpoint, amount, scriptPublicKey, sequence) {
  return {
    previousOutpoint: { transactionId: outpoint.txid, index: outpoint.index },
    sequence,
    sigOpCount: 1,
    utxo: {
      outpoint: { transactionId: outpoint.txid, index: outpoint.index },
      amount,
      scriptPublicKey,
      blockDaaScore: 0n,
      isCoinbase: false,
    },
  };
}

function p2pkInputBase(outpoint, amount, scriptPublicKey, sequence) {
  return {
    previousOutpoint: { transactionId: outpoint.txid, index: outpoint.index },
    sequence,
    sigOpCount: 0,
    computeBudget: EXACT_KIP10_COMPUTE_BUDGET,
    utxo: {
      outpoint: { transactionId: outpoint.txid, index: outpoint.index },
      amount,
      scriptPublicKey,
      blockDaaScore: 0n,
      isCoinbase: false,
    },
  };
}

function p2shComputeBudgetInputBase(
  outpoint,
  amount,
  scriptPublicKey,
  sequence,
  computeBudget,
) {
  return {
    previousOutpoint: { transactionId: outpoint.txid, index: outpoint.index },
    sequence,
    sigOpCount: 0,
    computeBudget,
    utxo: {
      outpoint: { transactionId: outpoint.txid, index: outpoint.index },
      amount,
      scriptPublicKey,
      blockDaaScore: 0n,
      isCoinbase: false,
    },
  };
}

function scriptPublicKeyFromSerialized(sdk, serialized) {
  const bytes = hexToBytes(serialized);
  if (bytes.length < 3)
    throw new Error("serialized script public key is too short");
  const version = (bytes[0] << 8) | bytes[1];
  const script = bytesToHex(bytes.slice(2));
  return new sdk.ScriptPublicKey(version, script);
}

function serializeSdkScriptPublicKey(scriptPublicKey) {
  const script = hexToBytes(String(scriptPublicKey.script));
  const version = Number(scriptPublicKey.version ?? 0);
  return bytesToHex(
    Uint8Array.from([(version >>> 8) & 0xff, version & 0xff, ...script]),
  );
}

function exactStorageMass(inputs, outputs) {
  return calculateKaspaStorageMass({
    inputs: inputs.map((input) => ({
      amount: input.amount,
      scriptPublicKey: serializeSdkScriptPublicKey(input.scriptPublicKey),
      hasCovenant: false,
    })),
    outputs: outputs.map((output) => ({
      amount: output.value,
      scriptPublicKey: serializeSdkScriptPublicKey(output.scriptPublicKey),
      hasCovenant: false,
    })),
  });
}

function loadFundingPrivateKey(specifier) {
  if (specifier.startsWith("wallet-key:"))
    return fs
      .readFileSync(path.resolve(specifier.slice("wallet-key:".length)), "utf8")
      .trim();
  if (/^[0-9a-fA-F]{64}$/.test(specifier)) return specifier.toLowerCase();
  throw new Error(
    "KASPA_X402_FUNDING_WALLET must be wallet-key:<path> or 32-byte private key hex",
  );
}

function validateConfig(input) {
  if (input.network !== "kaspa:testnet-10")
    throw new Error("hosted exact proof is scoped to kaspa:testnet-10");
  if (!input.rpcUrl) throw new Error("KASPA_X402_RPC_URL is required");
  if (!input.fundingWallet)
    throw new Error("KASPA_X402_FUNDING_WALLET is required");
  if (!input.sdkPath)
    throw new Error("KASPA_X402_KASPA_WASM_MODULE is required");
  if (
    input.exactProfile !== "standard-native" &&
    input.exactProfile !== "additive"
  ) {
    throw new Error(
      "KASPA_X402_EXACT_PROFILE must be standard-native or additive",
    );
  }
  if (!input.expectedGatewayOrigin)
    throw new Error("KASPA_X402_EXPECTED_GATEWAY_ORIGIN is required");
  if (new URL(input.gatewayBase).origin !== input.expectedGatewayOrigin)
    throw new Error(
      "expected gateway origin does not match the configured gateway URL",
    );
  if (input.expectedExactProfile !== input.exactProfile)
    throw new Error(
      "KASPA_X402_EXPECTED_EXACT_PROFILE must match KASPA_X402_EXACT_PROFILE",
    );
  if (!/^[1-9][0-9]*$/.test(input.expectedExactAmount))
    throw new Error(
      "KASPA_X402_EXPECTED_EXACT_AMOUNT must be a positive sompi string",
    );
  if (input.exactProfile === "standard-native" && !input.expectedExactPayTo)
    throw new Error(
      "KASPA_X402_EXPECTED_EXACT_PAY_TO is required for standard-native proofs",
    );
  if (input.exactProfile === "additive" && !input.adminToken)
    throw new Error(
      "KASPA_X402_DEMO_ADMIN_TOKEN is required for additive head registration",
    );
  if (input.confirmation !== CONFIRMATION)
    throw new Error(
      "Set KASPA_X402_LIVE_CONFIRM before running hosted exact proof",
    );
  if (input.headAmount <= 0n)
    throw new Error("KASPA_X402_EXACT_HEAD_AMOUNT must be positive");
  if (input.additiveThreshold <= 0n)
    throw new Error("KASPA_X402_EXACT_ADDITIVE_THRESHOLD must be positive");
}

function kaspaNetworkId(network) {
  if (network === "kaspa:testnet-10") return "testnet-10";
  throw new Error(`unsupported network ${network}`);
}

function normalizedBaseUrl(value) {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  return `${url.toString().replace(/\/$/, "")}/`;
}

function redactRpc(value) {
  return value.replace(/\/\/([^:/]+)(?::\d+)?/, "//<redacted>");
}

function markOutpointSpent(spentOutpoints, outpoint) {
  spentOutpoints?.add(outpointKey(outpoint));
}

function outpointKey(outpoint) {
  return `${outpoint.txid.toLowerCase()}:${outpoint.index}`;
}

function parseJson(text) {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(path.resolve(file)), {
    recursive: true,
    mode: 0o700,
  });
  fs.writeFileSync(path.resolve(file), `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
}

function readOptions(argv) {
  return {
    configFile: option(argv, "--config-file"),
  };
}

function option(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} requires a value`);
  return value;
}

function readOptionalEnv(file) {
  if (!file) return {};
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved))
    throw new Error(`config file not found: ${file}`);
  const result = {};
  for (const line of fs.readFileSync(resolved, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals < 0) continue;
    result[trimmed.slice(0, equals).trim()] = trimmed.slice(equals + 1).trim();
  }
  return result;
}

function nonEmptyValues(values) {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== ""),
  );
}
