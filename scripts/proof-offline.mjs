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
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
} from "@kaspa-x402/client";

import {
  buildBatchClaimTxV1Artifact,
  buildBatchGenesisTxV1Artifact,
  buildBatchRefundTxV1Artifact,
  buildBatchTopUpTxV1Artifact,
  checkEscrowFixtureReproducibility,
  scriptUnitAllowance,
  transactionV1CovenantId,
} from "../packages/covenant/dist/index.js";
import {
  NETWORK,
  createMockDirectModeEnvironment,
  mockRequestHash,
  paymentRequiredFor,
} from "../examples/lib/mock-direct-mode.mjs";
import { runBatchArtifactPersistenceProof } from "./live-adapter-reference.mjs";

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
  report.flows.batchArtifactPersistence = runBatchArtifactPersistenceProof();
  check(
    "atomic batch artifact persistence and interrupted-temp recovery",
    report.flows.batchArtifactPersistence,
  );
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
  const { client, facilitator, server, serverStore } =
    createMockDirectModeEnvironment({ requirePaymentIdentifier: true });
  const url = "https://api.example.test/exact-download";
  const resource = {
    url,
    description: "Fixed-price native KAS file",
    mimeType: "application/octet-stream",
  };
  const amount = "100000";
  const requestHash = mockRequestHash({
    proof: "offline",
    scheme: "exact",
    profile: "standard-native",
    step: "download",
  });
  const unpaid = await server.handlePaidRequest(
    { url, resource, paymentAmount: amount, paymentScheme: "exact" },
    async () => ({
      status: 200,
      body: { ok: false },
    }),
  );
  assert.equal(unpaid.status, 402);
  const paymentRequiredHeader = unpaid.headers[PAYMENT_REQUIRED_HEADER];
  assert.ok(paymentRequiredHeader);
  const required = decodePaymentRequiredHeader(paymentRequiredHeader);
  const accepted = required.accepts[0];
  assert.equal(accepted.scheme, "exact");
  assert.equal(accepted.extra.binding, "kaspa-exact-v2");
  assert.equal(accepted.extra.profile, "standard-native");
  assert.equal(
    accepted.extra.transactionEncoding,
    "kaspa-sdk-safe-json-v2.0.0",
  );

  const payment = await client.createPayment(paymentRequiredHeader, {
    url,
    paymentIdentifier: "offline-exact-kip10-download",
    requestHash,
  });
  assert.equal(payment.scheme, "exact");
  assert.equal(payment.paymentPayload.payload.type, "exact-transaction");
  assert.equal(
    payment.paymentPayload.payload.transactionEncoding,
    "kaspa-sdk-safe-json-v2.0.0",
  );
  check("standard-native exact transaction payload creation", {
    profile: payment.paymentPayload.payload.profile,
    transactionEncoding: payment.paymentPayload.payload.transactionEncoding,
    paymentOutputIndex: payment.paymentOutputIndex,
  });

  const verification = await facilitator.verify({
    x402Version: X402_VERSION,
    paymentPayload: payment.paymentPayload,
    paymentRequirements: payment.accepted,
    resource,
    requestHash,
  });
  assert.equal(verification.isValid, true);
  check("standard-native exact server verification", {
    payer: verification.payer,
  });

  let executions = 0;
  const response = await server.handlePaidRequest(
    requestWithPayment(payment.paymentPayload, {
      url,
      resource,
      scheme: "exact",
      amount,
      requestHash,
    }),
    async () => {
      executions += 1;
      return {
        status: 200,
        body: { ok: true, route: "exact-download" },
      };
    },
  );
  assert.equal(response.status, 200);
  assert.equal(executions, 1);
  const settlement = decodeResponse(response);
  const settlementExtra = readKaspaSettlementExtension(settlement);
  assert.equal(settlement.success, true);
  assert.equal(settlement.amount, amount);
  assert.equal(
    settlementExtra?.transactionEncoding,
    "kaspa-sdk-safe-json-v2.0.0",
  );
  assert.equal(settlementExtra?.exactProfile, "standard-native");
  check("standard-native exact settlement commit", {
    transaction: settlement.transaction,
    amount: settlement.amount,
  });

  let cachedExecutions = 0;
  const cached = await server.handlePaidRequest(
    requestWithPayment(payment.paymentPayload, {
      url,
      resource,
      scheme: "exact",
      amount,
      requestHash,
    }),
    async () => {
      cachedExecutions += 1;
      return {
        status: 200,
        body: { ok: false, route: "unexpected" },
      };
    },
  );
  assert.equal(cached.status, 200);
  assert.equal(cachedExecutions, 0);
  assert.equal(cached.body.route, "exact-download");
  check("standard-native exact payment identifier idempotency", {
    status: cached.status,
    handlerExecutions: cachedExecutions,
  });

  const { client: replayClient, server: replayServer } =
    createMockDirectModeEnvironment();
  const replayUrl = "https://api.example.test/exact-replay";
  const replayResource = {
    url: replayUrl,
    description: "Fixed-price exact replay source",
    mimeType: "application/octet-stream",
  };
  const replayRequired = await replayServer.handlePaidRequest(
    {
      url: replayUrl,
      resource: replayResource,
      paymentAmount: amount,
      paymentScheme: "exact",
    },
    async () => ({
      status: 200,
      body: { ok: false },
    }),
  );
  assert.equal(replayRequired.status, 402);
  const replayPayment = await replayClient.createPayment(
    replayRequired.headers[PAYMENT_REQUIRED_HEADER],
    {
      url: replayUrl,
    },
  );
  const replayFirstHash = replayPayment.paymentPayload.payload.requestHash;
  assert.ok(replayFirstHash);
  const replaySource = await replayServer.handlePaidRequest(
    requestWithPayment(replayPayment.paymentPayload, {
      url: replayUrl,
      resource: replayResource,
      scheme: "exact",
      amount,
      requestHash: replayFirstHash,
    }),
    async () => ({
      status: 200,
      body: { ok: true, route: "exact-replay-source" },
    }),
  );
  assert.equal(replaySource.status, 200);

  let replayExecutions = 0;
  const replay = await replayServer.handlePaidRequest(
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
  check("standard-native exact request-bound replay rejection", {
    status: replay.status,
    error: replay.body.error,
  });

  assert.deepEqual(await serverStore.listExactHeads(), []);
  const stored = await serverStore.loadExactPayment(settlement.transaction);
  assert.equal(stored?.amount, amount);

  return {
    transaction: settlement.transaction,
    amount: settlement.amount,
    profile: settlementExtra?.exactProfile,
    transactionEncoding: settlementExtra?.transactionEncoding,
    idempotentStatus: cached.status,
    replayStatus: replay.status,
  };
}

async function runBatchProof() {
  const { client, facilitator, server, serverStore } =
    createMockDirectModeEnvironment({ requirePaymentIdentifier: true });
  const url = "https://api.example.test/metered";
  const resource = {
    url,
    description: "Repeated metered call",
    mimeType: "application/json",
  };
  const firstHash = mockRequestHash({
    proof: "offline",
    scheme: "batch-settlement",
    step: "deposit",
  });
  const secondHash = mockRequestHash({
    proof: "offline",
    scheme: "batch-settlement",
    step: "voucher",
  });

  const deposit = await client.createPayment(
    paymentRequiredFor(server, {
      resource,
      amount: "50000",
      scheme: "batch-settlement",
    }),
    {
      url,
      paymentIdentifier: "offline-batch-deposit",
      requestHash: firstHash,
    },
  );
  assert.equal(deposit.scheme, "batch-settlement");
  assert.equal(deposit.openedChannel, true);
  assert.equal(deposit.paymentPayload.payload.type, "deposit-voucher");
  assert.match(deposit.channel.covenantId, /^(?!0{64})[0-9a-f]{64}$/);
  assert.equal(
    deposit.paymentPayload.payload.voucher.covenantId,
    deposit.channel.covenantId,
  );
  assert.equal(deposit.channel.genesisEvidence.authorizedOutputCount, 1);
  assert.deepEqual(
    deposit.channel.genesisEvidence.genesisOutpoint,
    deposit.channel.activeOutpoint,
  );
  assert.equal(
    deposit.channel.genesisEvidence.genesisScriptPublicKey,
    deposit.channel.activeScriptPublicKey,
  );
  check("batch deposit-voucher payload creation", {
    channelId: deposit.channel?.id,
    covenantId: deposit.channel?.covenantId,
    voucherAmount: deposit.paymentPayload.payload.voucher.amount,
    verifiedSingletonGenesis:
      deposit.channel?.genesisEvidence.authorizedOutputCount === 1,
    activeOutpoint: deposit.channel?.activeOutpoint,
    activeScriptPublicKey: deposit.channel?.activeScriptPublicKey,
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

  const depositResponse = await server.handlePaidRequest(
    requestWithPayment(deposit.paymentPayload, {
      url,
      resource,
      scheme: "batch-settlement",
      amount: "50000",
      requestHash: firstHash,
    }),
    async () => ({
      status: 200,
      body: { ok: true, route: "metered", sequence: 1 },
      chargedAmount: "50000",
    }),
  );
  assert.equal(depositResponse.status, 200);
  const depositSettlement = decodeResponse(depositResponse);
  const depositSettlementMetadata =
    requireSettlementMetadata(depositSettlement);
  assert.equal(depositSettlement.success, true);
  assert.equal(depositSettlement.amount, "50000");
  assert.equal(depositSettlementMetadata.chargedAmount, "50000");
  assert.equal(
    depositSettlementMetadata.channelState?.chargedCumulativeAmount,
    "50000",
  );
  const appliedDeposit = await client.applySettlement(
    deposit,
    depositSettlement,
  );
  assert.equal(appliedDeposit.channel?.chargedCumulativeAmount, "50000");
  check("batch deposit settlement", {
    commitmentId: depositSettlementMetadata.commitmentId,
    fundingAmount: depositSettlementMetadata.fundingAmount,
  });

  const voucher = await client.createPayment(
    paymentRequiredFor(server, {
      resource,
      amount: "50000",
      scheme: "batch-settlement",
    }),
    {
      url,
      paymentIdentifier: "offline-batch-voucher",
      requestHash: secondHash,
    },
  );
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
  underpaidPayload.payload.voucher = structuredClone(
    deposit.paymentPayload.payload.voucher,
  );
  const corrective = await server.handlePaidRequest(
    requestWithPayment(underpaidPayload, {
      url,
      resource,
      scheme: "batch-settlement",
      amount: "50000",
      requestHash: secondHash,
    }),
    async () => ({
      status: 200,
      body: { ok: false },
      chargedAmount: "50000",
    }),
  );
  assert.equal(corrective.status, 402);
  assert.equal(corrective.body.error, "invalid_payment_requirements");
  const correctiveRequired = decodePaymentRequiredHeader(
    corrective.headers[PAYMENT_REQUIRED_HEADER],
  );
  const correctiveAccepted = correctiveRequired.accepts[0];
  assert.equal(correctiveAccepted.scheme, "batch-settlement");
  assert.equal(
    correctiveAccepted.extra.channelState.channelId,
    deposit.channel.id,
  );
  assert.equal(
    correctiveAccepted.extra.channelState.chargedCumulativeAmount,
    "50000",
  );
  check("batch corrective 402 channel state", {
    status: corrective.status,
    channelId: correctiveAccepted.extra.channelState.channelId,
    chargedCumulativeAmount:
      correctiveAccepted.extra.channelState.chargedCumulativeAmount,
  });

  let executions = 0;
  const voucherResponse = await server.handlePaidRequest(
    requestWithPayment(voucher.paymentPayload, {
      url,
      resource,
      scheme: "batch-settlement",
      amount: "50000",
      requestHash: secondHash,
    }),
    async () => {
      executions += 1;
      return {
        status: 200,
        body: { ok: true, route: "metered", sequence: 2 },
        chargedAmount: "50000",
      };
    },
  );
  assert.equal(voucherResponse.status, 200);
  assert.equal(executions, 1);
  const voucherSettlement = decodeResponse(voucherResponse);
  const voucherSettlementMetadata =
    requireSettlementMetadata(voucherSettlement);
  assert.equal(voucherSettlement.success, true);
  assert.equal(voucherSettlement.amount, "50000");
  assert.equal(
    voucherSettlement.transaction,
    voucherSettlementMetadata.commitmentId,
  );
  assert.equal(voucherSettlementMetadata.chargedAmount, "50000");
  assert.equal(
    voucherSettlementMetadata.channelState?.chargedCumulativeAmount,
    "100000",
  );
  check("batch voucher settlement", {
    commitmentId: voucherSettlementMetadata.commitmentId,
    chargedCumulativeAmount:
      voucherSettlementMetadata.channelState?.chargedCumulativeAmount,
  });

  let cachedExecutions = 0;
  const cached = await server.handlePaidRequest(
    requestWithPayment(voucher.paymentPayload, {
      url,
      resource,
      scheme: "batch-settlement",
      amount: "50000",
      requestHash: secondHash,
    }),
    async () => {
      cachedExecutions += 1;
      return {
        status: 200,
        body: { ok: false },
        chargedAmount: "1",
      };
    },
  );
  assert.equal(cached.status, 200);
  assert.equal(cachedExecutions, 0);
  check("batch payment identifier idempotency", {
    status: cached.status,
    handlerExecutions: cachedExecutions,
  });

  let replayExecutions = 0;
  const staleReplayPayload = withPaymentIdentifier(
    voucher.paymentPayload,
    "offline-batch-stale-replay",
  );
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
  const staleReplayRequired = decodePaymentRequiredHeader(
    staleReplay.headers[PAYMENT_REQUIRED_HEADER],
  );
  const staleReplayAccepted = staleReplayRequired.accepts[0];
  assert.equal(staleReplayAccepted.scheme, "batch-settlement");
  assert.equal(
    staleReplayAccepted.extra.channelState.chargedCumulativeAmount,
    "100000",
  );
  check("batch corrective stale-voucher handling", {
    status: staleReplay.status,
    error: staleReplay.body.error,
    chargedCumulativeAmount:
      staleReplayAccepted.extra.channelState.chargedCumulativeAmount,
  });

  const channels = await serverStore.listChannels();
  assert.equal(channels.length, 1);
  assert.equal(channels[0].chargedCumulativeAmount, "100000");
  assert.equal(channels[0].signedMaxClaimable, "100000");
  const digest = voucherDigest({
    network: voucher.accepted.network,
    covenantId: voucher.paymentPayload.payload.voucher.covenantId,
    amount: voucher.paymentPayload.payload.voucher.amount,
  });
  assert.equal(
    voucher.paymentPayload.payload.voucher.covenantId,
    channels[0].covenantId,
  );
  check("batch voucher digest", {
    digest,
    channelId: channels[0].channelId,
    covenantId: channels[0].covenantId,
  });

  const beforeClaim = structuredClone(channels[0]);
  const claim = await server.executeClaim(beforeClaim.channelId, "50000");
  assert.equal(claim.accepted, true);
  const afterClaim = await serverStore.loadChannel(beforeClaim.channelId);
  assert.ok(afterClaim);
  assert.equal(afterClaim.covenantId, beforeClaim.covenantId);
  assert.notDeepEqual(afterClaim.activeOutpoint, beforeClaim.activeOutpoint);
  assert.notEqual(
    afterClaim.activeScriptPublicKey,
    beforeClaim.activeScriptPublicKey,
  );
  assert.equal(afterClaim.chargedCumulativeAmount, "100000");
  assert.equal(afterClaim.claimedCumulativeAmount, "50000");
  assert.equal(afterClaim.signedMaxClaimable, "100000");
  assert.equal(afterClaim.voucherSignature, beforeClaim.voucherSignature);
  assert.equal(afterClaim.fundingAmount, "3950000");
  check("batch KIP-20 partial-claim successor", {
    covenantId: afterClaim.covenantId,
    transactionId: claim.transactionId,
    headBefore: {
      outpoint: beforeClaim.activeOutpoint,
      scriptPublicKey: beforeClaim.activeScriptPublicKey,
      fundingAmount: beforeClaim.fundingAmount,
      claimedCumulativeAmount: beforeClaim.claimedCumulativeAmount,
    },
    headAfter: {
      outpoint: afterClaim.activeOutpoint,
      scriptPublicKey: afterClaim.activeScriptPublicKey,
      fundingAmount: afterClaim.fundingAmount,
      claimedCumulativeAmount: afterClaim.claimedCumulativeAmount,
    },
    chargedCumulativeAmount: afterClaim.chargedCumulativeAmount,
    signedMaxClaimable: afterClaim.signedMaxClaimable,
    voucherSignaturePreserved:
      afterClaim.voucherSignature === beforeClaim.voucherSignature,
  });

  return {
    channelId: afterClaim.channelId,
    covenantId: afterClaim.covenantId,
    genesis: deposit.channel.genesisEvidence,
    activeOutpoint: afterClaim.activeOutpoint,
    activeScriptPublicKey: afterClaim.activeScriptPublicKey,
    fundingAmount: afterClaim.fundingAmount,
    chargedCumulativeAmount: afterClaim.chargedCumulativeAmount,
    claimedCumulativeAmount: afterClaim.claimedCumulativeAmount,
    signedMaxClaimable: afterClaim.signedMaxClaimable,
    correctiveStatus: corrective.status,
    replayStatus: staleReplay.status,
    voucherDigest: digest,
    claim: {
      transactionId: claim.transactionId,
      headBefore: beforeClaim.activeOutpoint,
      headAfter: afterClaim.activeOutpoint,
      signedMaxClaimablePreserved:
        afterClaim.signedMaxClaimable === beforeClaim.signedMaxClaimable,
      voucherSignaturePreserved:
        afterClaim.voucherSignature === beforeClaim.voucherSignature,
    },
  };
}

function runTxV1Proof() {
  const fixture = readJson("contracts/fixtures/kaspa-x402-escrow-v3.json");
  const source = fs.readFileSync(path.join(root, fixture.source));
  const fixtureReport = checkEscrowFixtureReproducibility(fixture, source);
  assert.equal(fixture.templateId, "kaspa-x402-escrow-v3");
  check("Alpha.11 escrow fixture reproducibility", {
    checks: fixtureReport.checks.length,
    compilerCommit: fixture.compiler?.checkedCommit,
  });

  const vectorPaths = [
    "vectors/tx-v1/batch-genesis.json",
    "vectors/tx-v1/batch-claim.json",
    "vectors/tx-v1/batch-claim-second.json",
    "vectors/tx-v1/batch-top-up.json",
    "vectors/tx-v1/batch-refund.json",
  ];
  const vectors = vectorPaths.map((vectorPath) => ({
    path: vectorPath,
    ...readJson(vectorPath),
  }));
  for (const [index, vector] of vectors.entries()) {
    assert.equal(vector.validation.status, "full-consensus-cross-validated");
    assert.equal(vector.sequence.step, index);
    assert.equal(vector.expected.format, "kaspa-x402-tx-v1-reference-v2");
    assert.equal(vector.expected.transaction.version, 1);
    assert.equal(vector.expected.transactionId, vector.expected.txid.digest);
    assert.equal(vector.expected.serializedTransaction, vector.expected.hash.preimage);
    assert.ok(BigInt(vector.expected.transaction.mass) >= 0n);
    assert.ok(
      vector.expected.transaction.inputs.every(
        ({ computeBudget }) =>
          Number.isInteger(computeBudget) &&
          computeBudget >= 0 &&
          computeBudget <= 0xffff,
      ),
    );
    assert.equal(
      vector.sequence.previousTransactionId,
      index === 0 ? null : vectors[index - 1].expected.transactionId,
    );
    const builder = {
      "batch-genesis": buildBatchGenesisTxV1Artifact,
      "batch-claim": buildBatchClaimTxV1Artifact,
      "batch-top-up": buildBatchTopUpTxV1Artifact,
      "batch-refund": buildBatchRefundTxV1Artifact,
    }[vector.expected.kind];
    assert.ok(builder, `missing builder for ${vector.expected.kind}`);
    assert.deepEqual(builder(vector.input), vector.expected);
  }

  const [genesisVector, firstClaimVector, secondClaimVector, topUpVector, refundVector] =
    vectors;
  const genesis = genesisVector.expected;
  const covenantId = genesis.covenantId;
  assert.match(covenantId, /^(?!0{64})[0-9a-f]{64}$/);
  assert.ok(vectors.every((vector) => vector.sequence.covenantId === covenantId));
  const authorizedGenesisOutputs = genesis.transaction.outputs
    .map((output, index) => ({ index, output }))
    .filter(({ output }) => output.covenant?.covenantId === covenantId);
  const genesisInputTotal = genesis.transaction.inputs.reduce(
    (total, input) => total + BigInt(input.utxo.amount),
    0n,
  );
  assert.equal(genesis.transaction.outputs.length, 1);
  assert.equal(authorizedGenesisOutputs.length, 1);
  assert.equal(
    genesisInputTotal,
    BigInt(genesis.escrow.amount) + BigInt(genesis.fee.amount),
  );
  assert.equal(authorizedGenesisOutputs[0].output.covenant.authorizingInput, 0);
  assert.equal(genesis.transaction.inputs[0].utxo.covenantId, null);
  assert.equal(
    transactionV1CovenantId(
      genesis.transaction.inputs[0].previousOutpoint,
      authorizedGenesisOutputs.map(({ index, output }) => ({ index, output })),
    ),
    covenantId,
  );
  assert.equal(genesis.escrow.settledTotal, "0");
  assert.deepEqual(genesis.escrow.outpoint, {
    txid: genesis.transactionId,
    index: genesis.escrow.outputIndex,
  });
  check("batch singleton genesis tx-v1 construction", {
    transactionId: genesis.transactionId,
    covenantId,
    authorizingInput: genesis.transaction.inputs[0].previousOutpoint,
    authorizedOutputCount: authorizedGenesisOutputs.length,
    totalOutputCount: genesis.transaction.outputs.length,
    inputTotal: genesisInputTotal.toString(),
    escrowAmount: genesis.escrow.amount,
    fee: genesis.fee.amount,
    inputComputeBudgets: genesis.transaction.inputs.map(
      ({ computeBudget }) => computeBudget,
    ),
  });

  const claims = [firstClaimVector, secondClaimVector];
  let prior = genesis.escrow;
  for (const [index, vector] of claims.entries()) {
    const claim = vector.expected;
    assert.equal(claim.kind, "batch-claim");
    assert.equal(vector.sequence.totalAuthorized, firstClaimVector.sequence.totalAuthorized);
    assert.equal(vector.sequence.voucherSignature, firstClaimVector.sequence.voucherSignature);
    assert.deepEqual(claim.transaction.inputs[0].previousOutpoint, prior.outpoint);
    assert.equal(claim.transaction.inputs[0].utxo.covenantId, covenantId);
    assert.equal(claim.continuation.covenantId, covenantId);
    assert.equal(claim.continuation.outputIndex, 1);
    assert.deepEqual(claim.continuation.outpoint, {
      txid: claim.transactionId,
      index: 1,
    });
    assert.equal(
      BigInt(claim.continuation.settledTotal),
      BigInt(prior.settledTotal) + BigInt(claim.fee.claimAmount),
    );
    assert.equal(
      BigInt(claim.continuation.amount),
      BigInt(prior.amount) - BigInt(claim.fee.claimAmount),
    );
    assert.ok(
      BigInt(claim.fee.claimAmount) <
        BigInt(claim.fee.totalAuthorized) - BigInt(prior.settledTotal),
    );
    validateVectorCompute(claim, `claim ${index + 1}`);
    prior = claim.continuation;
  }
  check("batch repeated partial-claim tx-v1 construction", {
    covenantId,
    voucherSignatureReused:
      firstClaimVector.sequence.voucherSignature ===
      secondClaimVector.sequence.voucherSignature,
    transactions: claims.map(({ expected }) => ({
      transactionId: expected.transactionId,
      claimAmount: expected.fee.claimAmount,
      settledTotal: expected.continuation.settledTotal,
      computeBudget: expected.compute.computeBudget,
    })),
  });

  const topUp = topUpVector.expected;
  assert.equal(topUp.kind, "batch-top-up");
  assert.deepEqual(topUp.transaction.inputs[0].previousOutpoint, prior.outpoint);
  assert.equal(topUp.transaction.inputs[0].utxo.covenantId, covenantId);
  assert.equal(topUp.continuation.covenantId, covenantId);
  assert.equal(topUp.continuation.outputIndex, 0);
  assert.equal(topUp.continuation.settledTotal, prior.settledTotal);
  assert.equal(topUp.continuation.scriptPublicKey, prior.scriptPublicKey);
  assert.ok(BigInt(topUp.continuation.amount) > BigInt(prior.amount));
  assert.equal(
    topUp.transaction.outputs.filter(
      (output) => output.covenant?.covenantId === covenantId,
    ).length,
    1,
  );
  validateVectorCompute(topUp, "top-up");
  check("batch top-up tx-v1 construction", {
    transactionId: topUp.transactionId,
    covenantId,
    settledTotal: topUp.continuation.settledTotal,
    successorAmount: topUp.continuation.amount,
    computeBudget: topUp.compute.computeBudget,
  });

  const refund = refundVector.expected;
  assert.equal(refund.kind, "batch-refund");
  assert.deepEqual(
    refund.transaction.inputs[0].previousOutpoint,
    topUp.continuation.outpoint,
  );
  assert.equal(refund.transaction.inputs[0].utxo.covenantId, covenantId);
  assert.equal(
    refund.transaction.outputs.filter((output) => output.covenant !== null).length,
    0,
  );
  assert.ok(BigInt(refund.transaction.lockTime) < 500_000_000_000n);
  assert.equal(
    BigInt(refund.transaction.inputs[0].utxo.amount),
    BigInt(refund.fee.refundOutputAmount) + BigInt(refund.fee.amount),
  );
  validateVectorCompute(refund, "refund");
  check("batch terminal refund tx-v1 construction", {
    transactionId: refund.transactionId,
    covenantId,
    refundOutputAmount: refund.fee.refundOutputAmount,
    successorCovenantOutputCount: 0,
    computeBudget: refund.compute.computeBudget,
  });

  const exactProfiles = readJson(
    "vectors/exact/consensus-profiles.json",
  ).expected;
  assert.equal(exactProfiles.standardNative.profile, "standard-native");
  assert.equal(exactProfiles.additive.profile, "additive");
  assert.equal(
    exactProfiles.standardNative.transaction.outputs[0].amount,
    exactProfiles.standardNative.amount,
  );
  assert.equal(
    BigInt(exactProfiles.additive.transaction.outputs[0].amount) -
      BigInt(exactProfiles.additive.transaction.inputs[0].utxo.amount),
    BigInt(exactProfiles.additive.amount),
  );
  check("exact profile consensus vectors", {
    standardNativeTransactionId: exactProfiles.standardNative.transactionId,
    additiveTransactionId: exactProfiles.additive.transactionId,
    merchantGainSompi: exactProfiles.additive.amount,
  });

  return {
    fixtureChecks: fixtureReport.checks.length,
    genesis: {
      transactionId: genesis.transactionId,
      covenantId,
      authorizedOutputCount: authorizedGenesisOutputs.length,
      totalOutputCount: genesis.transaction.outputs.length,
    },
    claims: claims.map(({ expected }) => ({
      transactionId: expected.transactionId,
      continuationOutpoint: expected.continuation.outpoint,
      settledTotal: expected.continuation.settledTotal,
      computeBudget: expected.compute.computeBudget,
    })),
    topUp: {
      transactionId: topUp.transactionId,
      continuationOutpoint: topUp.continuation.outpoint,
      settledTotal: topUp.continuation.settledTotal,
      computeBudget: topUp.compute.computeBudget,
    },
    refund: {
      transactionId: refund.transactionId,
      refundOutputAmount: refund.fee.refundOutputAmount,
      computeBudget: refund.compute.computeBudget,
    },
    exactProfiles: {
      standardNativeTransactionId: exactProfiles.standardNative.transactionId,
      additiveTransactionId: exactProfiles.additive.transactionId,
    },
  };
}

function validateVectorCompute(artifact, label) {
  assert.equal(
    artifact.transaction.inputs[0].computeBudget,
    artifact.compute.computeBudget,
    `${label} transaction input compute budget does not match evidence`,
  );
  assert.equal(
    artifact.compute.scriptUnitAllowance,
    scriptUnitAllowance(artifact.compute.computeBudget),
    `${label} script-unit allowance does not match compute budget`,
  );
  assert.ok(
    artifact.compute.scriptUnitsEstimate <= artifact.compute.scriptUnitAllowance,
    `${label} script units exceed the declared allowance`,
  );
}

function requestWithPayment(
  paymentPayload,
  { url, resource, scheme, amount, requestHash },
) {
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

function withPaymentIdentifier(paymentPayload, id) {
  const next = structuredClone(paymentPayload);
  next.extensions["payment-identifier"].info.id = id;
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
