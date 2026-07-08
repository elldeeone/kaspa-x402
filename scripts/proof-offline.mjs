#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  X402_VERSION,
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  readKaspaSettlementExtension,
  voucherDigest,
} from "@kaspa-x402/core";
import { PAYMENT_REQUIRED_HEADER, PAYMENT_RESPONSE_HEADER, PAYMENT_SIGNATURE_HEADER } from "@kaspa-x402/client";

import {
  buildBatchClaimTxV1Artifact,
  buildBatchRefundTxV1Artifact,
  checkEscrowFixtureReproducibility,
} from "../packages/covenant/dist/index.js";
import { NETWORK, createMockDirectModeEnvironment, mockRequestHash, paymentRequiredFor } from "../examples/lib/mock-direct-mode.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = readOptions(process.argv.slice(2));
const report = {
  generatedAt: new Date().toISOString(),
  mode: "offline",
  network: NETWORK,
  flows: {},
  checks: [],
};

try {
  report.flows.exact = await runExactProof();
  report.flows.batch = await runBatchProof();
  report.flows.txV1 = runTxV1Proof();
  report.summary = {
    ok: true,
    checkCount: report.checks.length,
    schemes: ["exact", "batch-settlement"],
  };
  writeReport(report, options.out);
  if (!options.quiet) console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.summary = {
    ok: false,
    checkCount: report.checks.length,
    error: error instanceof Error ? error.message : String(error),
  };
  writeReport(report, options.out);
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
}

async function runExactProof() {
  const { client, facilitator, server, serverStore } = createMockDirectModeEnvironment();
  const url = "https://api.example.test/kip10-download";
  const resource = {
    url,
    description: "Fixed-price KIP-10 file",
    mimeType: "application/octet-stream",
  };
  const amount = "100000";
  const requestHash = mockRequestHash({ proof: "offline", scheme: "exact", mode: "kip10-transaction", step: "download" });
  const unpaid = await server.handlePaidRequest({ url, resource, paymentAmount: amount, paymentScheme: "exact" }, async () => ({
    status: 200,
    body: { ok: false },
  }));
  assert.equal(unpaid.status, 402);
  const paymentRequiredHeader = unpaid.headers[PAYMENT_REQUIRED_HEADER];
  assert.ok(paymentRequiredHeader);
  const required = decodePaymentRequiredHeader(paymentRequiredHeader);
  const accepted = required.accepts[0];
  assert.equal(accepted.scheme, "exact");
  assert.equal(accepted.extra.templateId, "kaspa-x402-kip10-additive-v1");
  assert.equal(accepted.extra.transactionEncoding, "kaspa-sdk-safe-json-v2.0.0");

  const payment = await client.createPayment(paymentRequiredHeader, {
    url,
    paymentIdentifier: "offline-exact-kip10-download",
    requestHash,
  });
  assert.equal(payment.scheme, "exact");
  assert.equal(payment.paymentPayload.payload.type, "exact-transaction");
  assert.equal(payment.paymentPayload.payload.transactionEncoding, "kaspa-sdk-safe-json-v2.0.0");
  check("exact KIP-10 transaction payload creation", {
    transactionEncoding: payment.paymentPayload.payload.transactionEncoding,
    paymentOutputIndex: payment.paymentOutputIndex,
    reservationId: accepted.extra.reservationId,
  });

  const verification = await facilitator.verify({
    x402Version: X402_VERSION,
    paymentPayload: payment.paymentPayload,
    paymentRequirements: payment.accepted,
    resource,
    requestHash,
  });
  assert.equal(verification.isValid, true);
  check("exact KIP-10 server verification", {
    payer: verification.payer,
    reservationId: accepted.extra.reservationId,
  });

  let executions = 0;
  const response = await server.handlePaidRequest(requestWithPayment(payment.paymentPayload, { url, resource, scheme: "exact", amount, requestHash }), async () => {
    executions += 1;
    return {
      status: 200,
      body: { ok: true, route: "kip10-download" },
    };
  });
  assert.equal(response.status, 200);
  assert.equal(executions, 1);
  const settlement = decodeResponse(response);
  const settlementExtra = readKaspaSettlementExtension(settlement);
  assert.equal(settlement.success, true);
  assert.equal(settlement.amount, amount);
  assert.equal(settlementExtra?.transactionEncoding, "kaspa-sdk-safe-json-v2.0.0");
  assert.equal(settlementExtra?.templateId, "kaspa-x402-kip10-additive-v1");
  assert.equal(settlementExtra?.reservationId, accepted.extra.reservationId);
  check("exact KIP-10 settlement commit", {
    transaction: settlement.transaction,
    amount: settlement.amount,
    reservationId: settlementExtra?.reservationId,
  });

  let cachedExecutions = 0;
  const cached = await server.handlePaidRequest(requestWithPayment(payment.paymentPayload, { url, resource, scheme: "exact", amount, requestHash }), async () => {
    cachedExecutions += 1;
    return {
      status: 200,
      body: { ok: false, route: "unexpected" },
    };
  });
  assert.equal(cached.status, 200);
  assert.equal(cachedExecutions, 0);
  assert.equal(cached.body.route, "kip10-download");
  check("exact KIP-10 payment identifier idempotency", {
    status: cached.status,
    handlerExecutions: cachedExecutions,
  });

  const replayUrl = "https://api.example.test/kip10-replay";
  const replayResource = {
    url: replayUrl,
    description: "Fixed-price KIP-10 replay source",
    mimeType: "application/octet-stream",
  };
  const replayRequired = await server.handlePaidRequest({ url: replayUrl, resource: replayResource, paymentAmount: amount, paymentScheme: "exact" }, async () => ({
    status: 200,
    body: { ok: false },
  }));
  assert.equal(replayRequired.status, 402);
  const replayPayment = await client.createPayment(replayRequired.headers[PAYMENT_REQUIRED_HEADER], {
    url: replayUrl,
  });
  const replayFirstHash = replayPayment.paymentPayload.payload.requestHash;
  assert.ok(replayFirstHash);
  const replaySource = await server.handlePaidRequest(
    requestWithPayment(replayPayment.paymentPayload, {
      url: replayUrl,
      resource: replayResource,
      scheme: "exact",
      amount,
      requestHash: replayFirstHash,
    }),
    async () => ({
      status: 200,
      body: { ok: true, route: "kip10-replay-source" },
    }),
  );
  assert.equal(replaySource.status, 200);

  let replayExecutions = 0;
  const replay = await server.handlePaidRequest(
    requestWithPayment(replayPayment.paymentPayload, {
      url: replayUrl,
      resource: replayResource,
      scheme: "exact",
      amount,
      requestHash: "13".repeat(32),
    }),
    async () => {
      replayExecutions += 1;
      return {
        status: 200,
        body: { ok: false },
      };
    },
  );
  assert.equal(replay.status, 402);
  assert.equal(replay.body.error, "invalid_payload");
  assert.equal(replayExecutions, 0);
  check("exact KIP-10 request-bound replay rejection", {
    status: replay.status,
    error: replay.body.error,
  });

  const storedReservation = await serverStore.loadExactReservation(accepted.extra.reservationId);
  assert.equal(storedReservation?.status, "consumed");
  assert.equal(storedReservation?.transactionId, settlement.transaction);
  const stored = await serverStore.loadExactPayment(settlement.transaction);
  assert.equal(stored?.amount, amount);

  return {
    transaction: settlement.transaction,
    amount: settlement.amount,
    transactionEncoding: settlementExtra?.transactionEncoding,
    reservationStatus: storedReservation?.status,
    idempotentStatus: cached.status,
    replayStatus: replay.status,
  };
}

async function runBatchProof() {
  const { client, facilitator, server, serverStore } = createMockDirectModeEnvironment();
  const url = "https://api.example.test/metered";
  const resource = {
    url,
    description: "Repeated metered call",
    mimeType: "application/json",
  };
  const firstHash = mockRequestHash({ proof: "offline", scheme: "batch-settlement", step: "deposit" });
  const secondHash = mockRequestHash({ proof: "offline", scheme: "batch-settlement", step: "voucher" });

  const deposit = await client.createPayment(paymentRequiredFor(server, { resource, amount: "50000", scheme: "batch-settlement" }), {
    url,
    paymentIdentifier: "offline-batch-deposit",
    requestHash: firstHash,
  });
  assert.equal(deposit.scheme, "batch-settlement");
  assert.equal(deposit.openedChannel, true);
  assert.equal(deposit.paymentPayload.payload.type, "deposit-voucher");
  check("batch deposit-voucher payload creation", {
    channelId: deposit.channel?.id,
    voucherAmount: deposit.paymentPayload.payload.voucher.amount,
  });

  const depositVerify = await facilitator.verify({
    x402Version: X402_VERSION,
    paymentPayload: deposit.paymentPayload,
    paymentRequirements: deposit.accepted,
    resource,
    requestHash: firstHash,
  });
  assert.equal(depositVerify.isValid, true);
  check("batch deposit server verification", {
    channelId: depositVerify.extra?.channelId,
  });

  const depositResponse = await server.handlePaidRequest(requestWithPayment(deposit.paymentPayload, { url, resource, scheme: "batch-settlement", amount: "50000", requestHash: firstHash }), async () => ({
    status: 200,
    body: { ok: true, route: "metered", sequence: 1 },
    chargedAmount: "50000",
  }));
  assert.equal(depositResponse.status, 200);
  const depositSettlement = decodeResponse(depositResponse);
  const depositSettlementMetadata = requireSettlementMetadata(depositSettlement);
  assert.equal(depositSettlement.success, true);
  assert.equal(depositSettlement.amount, "50000");
  assert.equal(depositSettlementMetadata.chargedAmount, "50000");
  assert.equal(depositSettlementMetadata.channelState?.chargedCumulativeAmount, "50000");
  const appliedDeposit = await client.applySettlement(deposit, depositSettlement);
  assert.equal(appliedDeposit.channel?.chargedCumulativeAmount, "50000");
  check("batch deposit settlement", {
    commitmentId: depositSettlementMetadata.commitmentId,
    fundingAmount: depositSettlementMetadata.fundingAmount,
  });

  const voucher = await client.createPayment(paymentRequiredFor(server, { resource, amount: "50000", scheme: "batch-settlement" }), {
    url,
    paymentIdentifier: "offline-batch-voucher",
    requestHash: secondHash,
  });
  assert.equal(voucher.scheme, "batch-settlement");
  assert.equal(voucher.openedChannel, false);
  assert.equal(voucher.paymentPayload.payload.type, "voucher");
  assert.equal(voucher.paymentPayload.payload.voucher.amount, "100000");
  check("batch voucher-only payload creation", {
    channelId: voucher.channel?.id,
    voucherAmount: voucher.paymentPayload.payload.voucher.amount,
  });

  const voucherVerify = await facilitator.verify({
    x402Version: X402_VERSION,
    paymentPayload: voucher.paymentPayload,
    paymentRequirements: voucher.accepted,
    resource,
    requestHash: secondHash,
  });
  assert.equal(voucherVerify.isValid, true);
  check("batch voucher server verification", {
    channelId: voucherVerify.extra?.channelId,
  });

  const underpaidPayload = structuredClone(voucher.paymentPayload);
  underpaidPayload.payload.voucher = structuredClone(deposit.paymentPayload.payload.voucher);
  const corrective = await server.handlePaidRequest(
    requestWithPayment(underpaidPayload, { url, resource, scheme: "batch-settlement", amount: "50000", requestHash: secondHash }),
    async () => ({
      status: 200,
      body: { ok: false },
      chargedAmount: "50000",
    }),
  );
  assert.equal(corrective.status, 402);
  assert.equal(corrective.body.error, "invalid_payment_requirements");
  const correctiveRequired = decodePaymentRequiredHeader(corrective.headers[PAYMENT_REQUIRED_HEADER]);
  const correctiveAccepted = correctiveRequired.accepts[0];
  assert.equal(correctiveAccepted.scheme, "batch-settlement");
  assert.equal(correctiveAccepted.extra.channelState.channelId, deposit.channel.id);
  assert.equal(correctiveAccepted.extra.channelState.chargedCumulativeAmount, "50000");
  check("batch corrective 402 channel state", {
    status: corrective.status,
    channelId: correctiveAccepted.extra.channelState.channelId,
    chargedCumulativeAmount: correctiveAccepted.extra.channelState.chargedCumulativeAmount,
  });

  let executions = 0;
  const voucherResponse = await server.handlePaidRequest(requestWithPayment(voucher.paymentPayload, { url, resource, scheme: "batch-settlement", amount: "50000", requestHash: secondHash }), async () => {
    executions += 1;
    return {
      status: 200,
      body: { ok: true, route: "metered", sequence: 2 },
      chargedAmount: "50000",
    };
  });
  assert.equal(voucherResponse.status, 200);
  assert.equal(executions, 1);
  const voucherSettlement = decodeResponse(voucherResponse);
  const voucherSettlementMetadata = requireSettlementMetadata(voucherSettlement);
  assert.equal(voucherSettlement.success, true);
  assert.equal(voucherSettlement.amount, "50000");
  assert.equal(voucherSettlement.transaction, voucherSettlementMetadata.commitmentId);
  assert.equal(voucherSettlementMetadata.chargedAmount, "50000");
  assert.equal(voucherSettlementMetadata.channelState?.chargedCumulativeAmount, "100000");
  check("batch voucher settlement", {
    commitmentId: voucherSettlementMetadata.commitmentId,
    chargedCumulativeAmount: voucherSettlementMetadata.channelState?.chargedCumulativeAmount,
  });

  let cachedExecutions = 0;
  const cached = await server.handlePaidRequest(requestWithPayment(voucher.paymentPayload, { url, resource, scheme: "batch-settlement", amount: "50000", requestHash: secondHash }), async () => {
    cachedExecutions += 1;
    return {
      status: 200,
      body: { ok: false },
      chargedAmount: "1",
    };
  });
  assert.equal(cached.status, 200);
  assert.equal(cachedExecutions, 0);
  check("batch payment identifier idempotency", {
    status: cached.status,
    handlerExecutions: cachedExecutions,
  });

  let replayExecutions = 0;
  const staleReplayPayload = withoutPaymentIdentifier(voucher.paymentPayload);
  const staleReplay = await server.handlePaidRequest(
    requestWithPayment(staleReplayPayload, {
      url,
      resource,
      scheme: "batch-settlement",
      amount: "50000",
      requestHash: "15".repeat(32),
    }),
    async () => {
      replayExecutions += 1;
      return {
        status: 200,
        body: { ok: false },
        chargedAmount: "50000",
      };
    },
  );
  assert.equal(staleReplay.status, 402);
  assert.equal(staleReplay.body.error, "invalid_payment_requirements");
  assert.equal(replayExecutions, 0);
  const staleReplayRequired = decodePaymentRequiredHeader(staleReplay.headers[PAYMENT_REQUIRED_HEADER]);
  const staleReplayAccepted = staleReplayRequired.accepts[0];
  assert.equal(staleReplayAccepted.scheme, "batch-settlement");
  assert.equal(staleReplayAccepted.extra.channelState.chargedCumulativeAmount, "100000");
  check("batch corrective stale-voucher handling", {
    status: staleReplay.status,
    error: staleReplay.body.error,
    chargedCumulativeAmount: staleReplayAccepted.extra.channelState.chargedCumulativeAmount,
  });

  const channels = await serverStore.listChannels();
  assert.equal(channels.length, 1);
  assert.equal(channels[0].chargedCumulativeAmount, "100000");
  assert.equal(channels[0].signedMaxClaimable, "100000");
  const digest = voucherDigest({
    network: voucher.accepted.network,
    activeScriptPublicKey: voucher.paymentPayload.payload.activeScriptPublicKey,
    outpoint: voucher.paymentPayload.payload.fundingOutpoint,
    amount: voucher.paymentPayload.payload.voucher.amount,
  });
  check("batch voucher digest", {
    digest,
    channelId: channels[0].channelId,
  });

  return {
    channelId: channels[0].channelId,
    chargedCumulativeAmount: channels[0].chargedCumulativeAmount,
    signedMaxClaimable: channels[0].signedMaxClaimable,
    correctiveStatus: corrective.status,
    replayStatus: staleReplay.status,
    voucherDigest: digest,
  };
}

function runTxV1Proof() {
  const fixture = readJson("contracts/fixtures/kaspa-x402-escrow-v1.json");
  const source = fs.readFileSync(path.join(root, fixture.source));
  const fixtureReport = checkEscrowFixtureReproducibility(fixture, source);
  check("escrow fixture reproducibility", {
    checks: fixtureReport.checks.length,
    compilerCommit: fixture.compiler?.checkedCommit,
  });

  const claimVector = readJson("vectors/tx-v1/batch-claim.json");
  const claim = buildBatchClaimTxV1Artifact(claimVector.input);
  assert.deepEqual(claim, claimVector.expected);
  check("batch claim tx-v1 construction", {
    transactionId: claim.transactionId,
    continuationOutpoint: claim.continuation.outpoint,
    computeBudget: claim.compute.computeBudget,
  });

  const refundVector = readJson("vectors/tx-v1/batch-refund.json");
  const refund = buildBatchRefundTxV1Artifact(refundVector.input);
  assert.deepEqual(refund, refundVector.expected);
  check("batch refund tx-v1 construction", {
    transactionId: refund.transactionId,
    refundOutputAmount: refund.fee.refundOutputAmount,
    computeBudget: refund.compute.computeBudget,
  });


  return {
    fixtureChecks: fixtureReport.checks.length,
    claim: {
      transactionId: claim.transactionId,
      continuationOutpoint: claim.continuation.outpoint,
      computeBudget: claim.compute.computeBudget,
    },
    refund: {
      transactionId: refund.transactionId,
      refundOutputAmount: refund.fee.refundOutputAmount,
      computeBudget: refund.compute.computeBudget,
    },
  };
}

function requestWithPayment(paymentPayload, { url, resource, scheme, amount, requestHash }) {
  return {
    method: "GET",
    url,
    body: null,
    headers: {
      [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader(paymentPayload),
    },
    resource,
    paymentAmount: amount,
    paymentScheme: scheme,
    requestHash,
  };
}

function withoutPaymentIdentifier(paymentPayload) {
  const next = structuredClone(paymentPayload);
  if (!next.extensions) return next;
  delete next.extensions["payment-identifier"];
  if (Object.keys(next.extensions).length === 0) delete next.extensions;
  return next;
}

function decodeResponse(response) {
  const header = response.headers[PAYMENT_RESPONSE_HEADER];
  assert.equal(typeof header, "string");
  return decodePaymentResponseHeader(header);
}

function requireSettlementMetadata(settlement) {
  const metadata = readKaspaSettlementExtension(settlement);
  assert.ok(metadata);
  return metadata;
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function check(name, evidence) {
  report.checks.push({
    name,
    ok: true,
    evidence,
  });
}

function writeReport(value, out) {
  if (!out) return;
  const outputPath = path.resolve(root, out);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(value, null, 2)}\n`);
}

function parseArgs(argv) {
  const parsed = {
    out: undefined,
    quiet: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") {
      parsed.out = argv[index + 1];
      if (!parsed.out) throw new Error("--out requires a path");
      index += 1;
    } else if (arg === "--quiet") {
      parsed.quiet = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function readOptions(argv) {
  try {
    return parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
