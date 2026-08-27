#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const options = readOptions(process.argv.slice(2));
const fileEnv = readOptionalEnv(options.envFile);
const env = { ...nonEmptyValues(fileEnv), ...process.env };

const config = {
  network: env.KASPA_X402_NETWORK || "kaspa:testnet-10",
  rpcUrl: env.KASPA_X402_RPC_URL || "",
  fundingWallet: env.KASPA_X402_FUNDING_WALLET || "",
  dataDir: env.KASPA_X402_DATA_DIR || ".kaspa-x402-live",
  recoveryFile:
    env.KASPA_X402_RECOVERY_FILE || ".kaspa-x402-live/recovery.json",
  reportFile: env.KASPA_X402_REPORT_FILE || ".kaspa-x402-live/report.json",
  timeoutDaa: env.KASPA_X402_TIMEOUT_DAA || "1800",
  adapterModule: env.KASPA_X402_LIVE_ADAPTER_MODULE || "",
  confirmation: env.KASPA_X402_LIVE_CONFIRM || "",
};

const requiredFlows = [
  "tiny and normal standard-native exact settlement",
  "KIP-10 additive-head exact-delta settlement and replay rejection",
  "multiple additive head shards",
  "concurrent additive conflict and loser refresh",
  "duplicate exact settlement idempotency",
  "invalid exact signature rejected before protected work",
  "expired exact authorization rejected before protected work",
  "post-broadcast exact restart and trusted settlement reconciliation",
  "external additive head advancement and trusted reconciliation",
  "verified singleton KIP-20 batch genesis and deposit-voucher settlement",
  "batch voucher-only settlement",
  "partial batch claim preserving voucher ceiling and lineage",
  "second accepted partial batch claim using the same voucher",
  "bounded batch channel, artifact, and pre-broadcast attempt restart reload",
  "batch client-authorized top-up preserving KIP-20 lineage and lifetime voucher state",
  "batch stale-head rejection after a same-voucher partial claim",
  "replay rejection across exact and batch-settlement",
  "terminal batch refund after timeout",
];
const SDK_GENERATED_TX_VERSION_SOURCE = "sdk-generated-transaction";
const ADAPTER_SUBMITTED_TX_VERSION_SOURCE =
  "adapter-submitted-transaction-shape";

const report = {
  generatedAt: new Date().toISOString(),
  mode: "live-testnet",
  network: config.network,
  status: "blocked",
  checkOnly: !options.live,
  config: redactedConfig(config),
  requiredFlows,
  findings: [],
};

const missing = missingLiveConfig(config);
for (const name of missing) {
  report.findings.push({
    severity: "blocker",
    code: "missing_live_config",
    message: `${name} is required for a live testnet proof run.`,
  });
}
if (config.network !== "kaspa:testnet-10") {
  report.findings.push({
    severity: "blocker",
    code: "invalid_network",
    message: "Live proof is scoped to kaspa:testnet-10.",
  });
}
if (
  options.live &&
  config.confirmation !== "I_UNDERSTAND_THIS_USES_TESTNET_FUNDS"
) {
  report.findings.push({
    severity: "blocker",
    code: "missing_live_confirmation",
    message: "Set KASPA_X402_LIVE_CONFIRM before running with --live.",
  });
}

if (!options.live) {
  report.status =
    report.findings.length === 0 ? "ready-for-live-run" : "blocked";
  writeJson(config.reportFile, report, {
    onlyIfRequested: !options.writeReport,
  });
  if (options.writeReport && report.status === "blocked")
    writeRecovery(config.recoveryFile, config, report);
  printReport(report);
  process.exit(report.findings.length === 0 || options.allowBlocked ? 0 : 1);
}

if (report.findings.length > 0) {
  writeJson(config.reportFile, report);
  writeRecovery(config.recoveryFile, config, report);
  printReport(report);
  process.exit(1);
}

try {
  const adapterModule = await importAdapter(config.adapterModule);
  if (typeof adapterModule.runLiveProof !== "function") {
    throw new Error("adapter module must export runLiveProof(context)");
  }
  const result = await adapterModule.runLiveProof({
    network: config.network,
    rpcUrl: config.rpcUrl,
    fundingWallet: config.fundingWallet,
    dataDir: config.dataDir,
    recoveryFile: config.recoveryFile,
    reportFile: config.reportFile,
    timeoutDaa: config.timeoutDaa,
    requiredFlows,
  });
  validateLiveProofResult(result, requiredFlows);
  const completed = {
    ...report,
    status: "complete",
    checkOnly: false,
    result,
    findings: [],
  };
  writeJson(config.reportFile, completed);
  printReport(completed);
} catch (error) {
  const failed = {
    ...report,
    status: "blocked",
    findings: [
      ...report.findings,
      {
        severity: "blocker",
        code: "live_adapter_error",
        message: error instanceof Error ? error.message : String(error),
      },
    ],
  };
  writeJson(config.reportFile, failed);
  writeRecovery(config.recoveryFile, config, failed);
  printReport(failed);
  process.exit(1);
}

function validateLiveProofResult(result, flows) {
  const errors = [];
  const require = (condition, path, message) => {
    if (!condition) errors.push(`${path}: ${message}`);
  };
  const isObject = (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const isHash32 = (value) =>
    typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value);
  const isNonzeroHash32 = (value) =>
    isHash32(value) && !/^0{64}$/i.test(value);
  const isNonEmptyString = (value) =>
    typeof value === "string" && value.length > 0;
  const isSompi = (value) =>
    typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value);
  const isPositiveSompi = (value) => isSompi(value) && BigInt(value) > 0n;
  const isIndex = (value) => Number.isInteger(value) && value >= 0;
  const isTxVersion = (value) => Number.isInteger(value) && value >= 0;
  const isTxVersionSource = (value) =>
    value === SDK_GENERATED_TX_VERSION_SOURCE ||
    value === ADAPTER_SUBMITTED_TX_VERSION_SOURCE;
  const isFinal = (value) => value === "accepted" || value === "confirmed";
  const isHexBytes = (value) =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length % 2 === 0 &&
    /^[0-9a-fA-F]+$/.test(value);
  const validOutpoint = (value) =>
    isObject(value) && isHash32(value.txid) && isIndex(value.index);
  const sameOutpoint = (left, right) =>
    validOutpoint(left) &&
    validOutpoint(right) &&
    left.txid.toLowerCase() === right.txid.toLowerCase() &&
    left.index === right.index;
  const sameAmount = (left, right) =>
    isSompi(left) && isSompi(right) && BigInt(left) === BigInt(right);
  const sameHash = (left, right) =>
    isHash32(left) &&
    isHash32(right) &&
    left.toLowerCase() === right.toLowerCase();
  const sameHex = (left, right) =>
    isHexBytes(left) &&
    isHexBytes(right) &&
    left.toLowerCase() === right.toLowerCase();

  require(isObject(result), "result", "must be an object");
  if (!isObject(result))
    throw new Error(
      `live proof result failed validation: ${errors.join("; ")}`,
    );

  require(result.node?.networkId ===
    "testnet-10", "node.networkId", "must be testnet-10");

  for (const flow of flows) {
    require(result.requiredFlowStatus?.[flow] ===
      "passed", `requiredFlowStatus.${flow}`, "must be passed");
  }

  validateExactProfile(
    result.exact?.standardNativeTiny,
    "standard-native",
    0,
    "exact.standardNativeTiny",
  );
  validateExactProfile(
    result.exact?.standardNative,
    "standard-native",
    0,
    "exact.standardNative",
  );
  validateExactProfile(result.exact?.additive, "additive", 1, "exact.additive");
  require(Array.isArray(result.exact?.headFundings) &&
    result.exact.headFundings.length >=
      2, "exact.headFundings", "must contain at least two independently funded head shards");
  for (const [index, funding] of (result.exact?.headFundings ?? []).entries()) {
    require(isHash32(
      funding?.txid,
    ), `exact.headFundings[${index}].txid`, "must be a transaction id");
    require(funding?.txVersion ===
      0, `exact.headFundings[${index}].txVersion`, "must be transaction v0");
    require(validOutpoint(
      funding?.outpoint,
    ), `exact.headFundings[${index}].outpoint`, "must be an outpoint");
  }
  require(isHash32(
    result.exact?.headFunding?.txid,
  ), "exact.headFunding.txid", "must be a transaction id");
  require(result.exact?.headFunding?.txVersion ===
    0, "exact.headFunding.txVersion", "must be transaction v0");
  require(validOutpoint(
    result.exact?.headFunding?.outpoint,
  ), "exact.headFunding.outpoint", "must be an outpoint");
  require(isPositiveSompi(
    result.exact?.headFunding?.amount,
  ), "exact.headFunding.amount", "must be a positive sompi string");

  const additiveEvidence = result.exact?.additive?.payloadEvidence;
  require(isHash32(
    additiveEvidence?.headId,
  ), "exact.additive.payloadEvidence.headId", "must be a head id");
  require(isSompi(
    additiveEvidence?.headVersion,
  ), "exact.additive.payloadEvidence.headVersion", "must be a head version");
  require(validOutpoint(
    additiveEvidence?.expectedHeadOutpoint,
  ), "exact.additive.payloadEvidence.expectedHeadOutpoint", "must be the consumed head outpoint");
  require(isPositiveSompi(
    additiveEvidence?.headAmount,
  ), "exact.additive.payloadEvidence.headAmount", "must be the prior head amount");
  require(isPositiveSompi(
    additiveEvidence?.successorAmount,
  ), "exact.additive.payloadEvidence.successorAmount", "must be the successor amount");
  require(isPositiveSompi(
    additiveEvidence?.exactDeltaSompi,
  ), "exact.additive.payloadEvidence.exactDeltaSompi", "must be the exact successor delta");
  require(isPositiveSompi(
    additiveEvidence?.additiveThresholdSompi,
  ), "exact.additive.payloadEvidence.additiveThresholdSompi", "must be a positive covenant threshold");
  require(isHash32(
    additiveEvidence?.challengeId,
  ), "exact.additive.payloadEvidence.challengeId", "must be a challenge id");
  if (
    isSompi(additiveEvidence?.headAmount) &&
    isSompi(additiveEvidence?.successorAmount) &&
    isSompi(additiveEvidence?.exactDeltaSompi)
  ) {
    require(BigInt(additiveEvidence.successorAmount) -
      BigInt(additiveEvidence.headAmount) ===
      BigInt(
        additiveEvidence.exactDeltaSompi,
      ), "exact.additive.payloadEvidence.exactDeltaSompi", "must equal successorAmount minus headAmount");
  }
  if (
    isSompi(additiveEvidence?.exactDeltaSompi) &&
    isSompi(result.exact?.additive?.amount)
  ) {
    require(BigInt(additiveEvidence.exactDeltaSompi) ===
      BigInt(
        result.exact.additive.amount,
      ), "exact.additive.payloadEvidence.exactDeltaSompi", "must equal the advertised exact amount");
  }

  function validateExactProfile(
    exact,
    expectedProfile,
    expectedVersion,
    basePath,
  ) {
    require(exact?.profile ===
      expectedProfile, `${basePath}.profile`, `must be ${expectedProfile}`);
    require(isHash32(
      exact?.txid,
    ), `${basePath}.txid`, "must be a transaction id");
    require(exact?.txVersion ===
      expectedVersion, `${basePath}.txVersion`, `must be transaction v${expectedVersion}`);
    require(isTxVersionSource(
      exact?.txVersionSource,
    ), `${basePath}.txVersionSource`, "must state an allowed version evidence source");
    require(exact?.txVersionSource ===
      ADAPTER_SUBMITTED_TX_VERSION_SOURCE, `${basePath}.txVersionSource`, "must be adapter-submitted-transaction-shape");
    require(exact?.outputIndex ===
      0, `${basePath}.outputIndex`, "must use canonical output 0");
    require(isPositiveSompi(
      exact?.amount,
    ), `${basePath}.amount`, "must be a positive sompi string");
    require(isFinal(
      exact?.finality,
    ), `${basePath}.finality`, "must be accepted or confirmed");
    require(exact?.payloadEvidence?.type ===
      "exact-transaction", `${basePath}.payloadEvidence.type`, "must be exact-transaction");
    require(exact?.payloadEvidence?.profile ===
      expectedProfile, `${basePath}.payloadEvidence.profile`, "must match the exact profile");
    require(exact?.payloadEvidence?.transactionEncoding ===
      "kaspa-sdk-safe-json-v2.0.0", `${basePath}.payloadEvidence.transactionEncoding`, "must be kaspa-sdk-safe-json-v2.0.0");
    require(isHash32(
      exact?.payloadEvidence?.transactionArtifactSha256,
    ), `${basePath}.payloadEvidence.transactionArtifactSha256`, "must identify the signed transaction artifact");
    require(exact?.payloadEvidence?.paymentOutputIndex ===
      0, `${basePath}.payloadEvidence.paymentOutputIndex`, "must use canonical output 0");
    require(exact?.serverBroadcast?.txid?.toLowerCase() ===
      exact?.txid?.toLowerCase(), `${basePath}.serverBroadcast.txid`, "must match exact txid");
    require(isFinal(
      exact?.serverBroadcast?.finality,
    ), `${basePath}.serverBroadcast.finality`, "must be accepted or confirmed");
    require(exact?.replay?.status ===
      409, `${basePath}.replay.status`, "must be 409");
    require(exact?.replay?.error ===
      "invalid_transaction_state", `${basePath}.replay.error`, "must be invalid_transaction_state");
    require(exact?.duplicate?.status ===
      200, `${basePath}.duplicate.status`, "must return the cached successful response");
    require(exact?.duplicate?.handlerExecutions ===
      1, `${basePath}.duplicate.handlerExecutions`, "must not run the protected handler twice");
    require(isPositiveSompi(
      exact?.economics?.mass,
    ), `${basePath}.economics.mass`, "must record calculated transaction mass");
    require(isSompi(
      exact?.economics?.feeSompi,
    ), `${basePath}.economics.feeSompi`, "must record the paid fee");
    require(sameAmount(
      exact?.economics?.merchantGainSompi,
      exact?.amount,
    ), `${basePath}.economics.merchantGainSompi`, "must equal the advertised exact amount");
    if (
      isSompi(exact?.economics?.payerCostSompi) &&
      isSompi(exact?.economics?.feeSompi) &&
      isSompi(exact?.amount)
    ) {
      require(BigInt(exact.economics.payerCostSompi) ===
        BigInt(exact.amount) +
          BigInt(
            exact.economics.feeSompi,
          ), `${basePath}.economics.payerCostSompi`, "must equal the exact amount plus fee");
    }
  }

  require(result.exact?.conflict?.winnerStatus === 200 &&
    result.exact?.conflict?.loserStatus === 402 &&
    result.exact?.conflict?.retryStatus ===
      200, "exact.conflict", "must prove one winner, one refreshed loser, and one successful retry");
  require(result.exact?.conflict?.handlerExecutions ===
    2, "exact.conflict.handlerExecutions", "must execute protected work only for the winner and retry");
  require(result.exact?.invalidSignature?.handlerExecutions === 0 &&
    result.exact?.invalidSignature?.broadcasts ===
      0, "exact.invalidSignature", "must reject before protected work or broadcast");
  require(result.exact?.expiredAuthorization?.status === 402 &&
    result.exact?.expiredAuthorization?.error === "invalid_payload" &&
    result.exact?.expiredAuthorization?.handlerExecutions === 0 &&
    result.exact?.expiredAuthorization?.broadcasts ===
      0, "exact.expiredAuthorization", "must return corrective 402 invalid_payload before protected work or broadcast");
  require(result.exact?.recovery?.initialStatus === 503 &&
    result.exact?.recovery?.retryStatus === 200 &&
    result.exact?.recovery?.handlerExecutions ===
      1, "exact.recovery", "must recover an accepted broadcast after runtime re-instantiation");
  require(isHash32(result.exact?.externalAdvance?.transactionId) &&
    result.exact?.externalAdvance?.finality === "accepted" &&
    BigInt(result.exact?.externalAdvance?.afterVersion ?? "0") ===
      BigInt(result.exact?.externalAdvance?.beforeVersion ?? "0") +
        1n, "exact.externalAdvance", "must prove one trusted externally observed head advancement");

  const batchClaimReserve = result.batch?.claimReserveSompi;
  require(
    isSompi(batchClaimReserve),
    "batch.claimReserveSompi",
    "must carry the advertised deterministic claim reserve",
  );
  const restartReload = result.batch?.restartReload;
  require(
    restartReload?.snapshotFormat ===
      "kaspa-x402-alpha10-batch-recovery-v1",
    "batch.restartReload.snapshotFormat",
    "must use the Alpha.11 recovery snapshot",
  );
  require(
    restartReload?.preBroadcastSnapshotFormat ===
      "kaspa-x402-alpha10-claim-before-broadcast-v1",
    "batch.restartReload.preBroadcastSnapshotFormat",
    "must reload the exact pre-broadcast Alpha.11 claim snapshot",
  );
  require(
    restartReload?.preBroadcastClaimAttemptStatus === "pending",
    "batch.restartReload.preBroadcastClaimAttemptStatus",
    "must reload the claim reservation captured before broadcast",
  );
  for (const field of [
    "preBroadcastArtifactMatched",
    "acceptedTopUpHasNoOpenClaimAttempt",
    "clientChannelReloaded",
    "serverChannelReloaded",
    "genesisEvidenceReloaded",
    "topUpEvidenceReloaded",
    "interruptedArtifactTempIgnored",
  ]) {
    require(
      restartReload?.[field] === true,
      `batch.restartReload.${field}`,
      "must be true",
    );
  }
  require(
    Number.isInteger(restartReload?.artifactCount) &&
      restartReload.artifactCount >= 3,
    "batch.restartReload.artifactCount",
    "must reload genesis, claim, and top-up artifacts",
  );

  function validateBatchHead(head, basePath) {
    require(isObject(head), basePath, "must be an object");
    require(
      validOutpoint(head?.outpoint),
      `${basePath}.outpoint`,
      "must be an outpoint",
    );
    require(
      isHexBytes(head?.scriptPublicKey),
      `${basePath}.scriptPublicKey`,
      "must be serialized script-public-key hex",
    );
    require(
      isPositiveSompi(head?.fundingAmount),
      `${basePath}.fundingAmount`,
      "must be a positive sompi string",
    );
    require(
      isSompi(head?.claimedCumulativeAmount),
      `${basePath}.claimedCumulativeAmount`,
      "must be a sompi string",
    );
  }

  function validateVoucherProof(proof, covenantId, ceiling, basePath) {
    require(isObject(proof), basePath, "must be an object");
    require(
      sameHash(proof?.covenantId, covenantId),
      `${basePath}.covenantId`,
      "must match the stable covenant id",
    );
    require(
      sameAmount(proof?.amount, ceiling),
      `${basePath}.amount`,
      "must match signedMaxClaimable",
    );
    require(
      typeof proof?.signature === "string" &&
        /^[0-9a-fA-F]{128}$/.test(proof.signature),
      `${basePath}.signature`,
      "must be a raw 64-byte Schnorr signature",
    );
    require(
      isHash32(proof?.digest),
      `${basePath}.digest`,
      "must be the v2 voucher digest",
    );
  }

  function validateBatchState(state, basePath) {
    require(isObject(state), basePath, "must be an object");
    require(
      isNonzeroHash32(state?.covenantId),
      `${basePath}.covenantId`,
      "must be a non-zero KIP-20 covenant id",
    );
    validateBatchHead(
      {
        outpoint: state?.activeOutpoint,
        scriptPublicKey: state?.activeScriptPublicKey,
        fundingAmount: state?.fundingAmount,
        claimedCumulativeAmount: state?.claimedCumulativeAmount,
      },
      basePath,
    );
    require(
      isSompi(state?.chargedCumulativeAmount),
      `${basePath}.chargedCumulativeAmount`,
      "must be a sompi string",
    );
    require(
      isPositiveSompi(state?.signedMaxClaimable),
      `${basePath}.signedMaxClaimable`,
      "must be a positive sompi string",
    );
    if (
      isSompi(state?.claimedCumulativeAmount) &&
      isSompi(state?.chargedCumulativeAmount) &&
      isSompi(state?.signedMaxClaimable)
    ) {
      const settled = BigInt(state.claimedCumulativeAmount);
      const charged = BigInt(state.chargedCumulativeAmount);
      const ceiling = BigInt(state.signedMaxClaimable);
      require(
        settled <= charged && charged <= ceiling,
        basePath,
        "must satisfy 0 <= S <= A <= T",
      );
      if (isSompi(state?.fundingAmount) && isSompi(batchClaimReserve)) {
        require(
          ceiling - settled + BigInt(batchClaimReserve) <=
            BigInt(state.fundingAmount),
          `${basePath}.fundingAmount`,
          "must cover remaining voucher authorization plus claim reserve",
        );
      }
    }
  }

  function validateCompute(compute, basePath) {
    require(isObject(compute), basePath, "must be an object");
    require(
      Number.isInteger(compute?.computeBudget) &&
        compute.computeBudget >= 0 &&
        compute.computeBudget <= 0xffff,
      `${basePath}.computeBudget`,
      "must fit in uint16",
    );
    require(
      Number.isSafeInteger(compute?.scriptUnitsEstimate) &&
        compute.scriptUnitsEstimate >= 0,
      `${basePath}.scriptUnitsEstimate`,
      "must be a non-negative safe integer",
    );
    require(
      Number.isSafeInteger(compute?.scriptUnitAllowance) &&
        compute.scriptUnitAllowance >= 0,
      `${basePath}.scriptUnitAllowance`,
      "must be a non-negative safe integer",
    );
    if (
      Number.isInteger(compute?.computeBudget) &&
      Number.isSafeInteger(compute?.scriptUnitAllowance)
    ) {
      require(
        compute.scriptUnitAllowance === compute.computeBudget * 10_000 + 9_999,
        `${basePath}.scriptUnitAllowance`,
        "must equal computeBudget * 10000 + 9999",
      );
    }
    if (
      Number.isSafeInteger(compute?.scriptUnitsEstimate) &&
      Number.isSafeInteger(compute?.scriptUnitAllowance)
    ) {
      require(
        compute.scriptUnitsEstimate <= compute.scriptUnitAllowance,
        basePath,
        "script units must fit the declared allowance",
      );
    }
  }

  function validateBatchSpend(spend, operation, basePath) {
    require(
      spend?.operation === operation,
      `${basePath}.operation`,
      `must be ${operation}`,
    );
    require(
      isNonzeroHash32(spend?.covenantId),
      `${basePath}.covenantId`,
      "must be a non-zero KIP-20 covenant id",
    );
    require(isHash32(spend?.txid), `${basePath}.txid`, "must be a transaction id");
    require(
      spend?.txVersion === 1,
      `${basePath}.txVersion`,
      "must be transaction v1",
    );
    require(
      spend?.txVersionSource === ADAPTER_SUBMITTED_TX_VERSION_SOURCE,
      `${basePath}.txVersionSource`,
      "must be adapter-submitted-transaction-shape",
    );
    require(
      isFinal(spend?.finality),
      `${basePath}.finality`,
      "must be accepted or confirmed",
    );
    validateBatchHead(spend?.headBefore, `${basePath}.headBefore`);
    validateCompute(spend?.compute, `${basePath}.compute`);
  }

  function sameBatchHead(left, right) {
    return (
      sameOutpoint(left?.outpoint, right?.outpoint) &&
      sameHex(left?.scriptPublicKey, right?.scriptPublicKey) &&
      sameAmount(left?.fundingAmount, right?.fundingAmount) &&
      sameAmount(left?.claimedCumulativeAmount, right?.claimedCumulativeAmount)
    );
  }

  function sameVoucherProof(left, right) {
    return (
      sameHash(left?.covenantId, right?.covenantId) &&
      sameAmount(left?.amount, right?.amount) &&
      typeof left?.signature === "string" &&
      typeof right?.signature === "string" &&
      left.signature.toLowerCase() === right.signature.toLowerCase() &&
      sameHash(left?.digest, right?.digest)
    );
  }

  const deposit = result.batch?.deposit;
  const depositState = deposit?.state;
  const genesis = deposit?.genesis;
  require(isHash32(deposit?.txid), "batch.deposit.txid", "must be a transaction id");
  require(deposit?.txVersion === 1, "batch.deposit.txVersion", "must be transaction v1");
  require(
    isTxVersionSource(deposit?.txVersionSource),
    "batch.deposit.txVersionSource",
    "must state an allowed version evidence source",
  );
  require(isFinal(deposit?.finality), "batch.deposit.finality", "must be accepted or confirmed");
  require(isHash32(deposit?.channelId), "batch.deposit.channelId", "must be a channel id");
  require(
    isHash32(deposit?.settlementCommitment),
    "batch.deposit.settlementCommitment",
    "must be a commitment id",
  );
  validateBatchState(depositState, "batch.deposit.state");
  validateVoucherProof(
    deposit?.voucherProof,
    depositState?.covenantId,
    depositState?.signedMaxClaimable,
    "batch.deposit.voucherProof",
  );
  require(isObject(genesis), "batch.deposit.genesis", "must be an object");
  require(
    genesis?.verifiedSingletonGenesis === true,
    "batch.deposit.genesis.verifiedSingletonGenesis",
    "must be true",
  );
  require(
    sameHash(genesis?.covenantId, depositState?.covenantId),
    "batch.deposit.genesis.covenantId",
    "must match the accepted stable covenant id",
  );
  require(
    validOutpoint(genesis?.authorizingInputOutpoint),
    "batch.deposit.genesis.authorizingInputOutpoint",
    "must identify the KIP-20 authorizing input",
  );
  require(
    genesis?.authorizedOutputCount === 1,
    "batch.deposit.genesis.authorizedOutputCount",
    "must prove exactly one covenant-bound genesis output",
  );
  require(
    genesis?.totalOutputCount === 1,
    "batch.deposit.genesis.totalOutputCount",
    "must prove the genesis transaction has exactly one total output",
  );
  require(
    isPositiveSompi(genesis?.fundingInputTotalSompi),
    "batch.deposit.genesis.fundingInputTotalSompi",
    "must record the total ordinary funding input value",
  );
  require(
    isSompi(genesis?.feeSompi),
    "batch.deposit.genesis.feeSompi",
    "must record the genesis transaction fee",
  );
  if (
    isPositiveSompi(genesis?.fundingInputTotalSompi) &&
    isPositiveSompi(genesis?.fundingAmount) &&
    isSompi(genesis?.feeSompi)
  ) {
    require(
      BigInt(genesis.fundingInputTotalSompi) ===
        BigInt(genesis.fundingAmount) + BigInt(genesis.feeSompi),
      "batch.deposit.genesis.fundingAmount",
      "must use all selected input value as escrow V plus fee without change",
    );
  }
  require(
    isIndex(genesis?.authorizedOutputIndex),
    "batch.deposit.genesis.authorizedOutputIndex",
    "must be a non-negative integer",
  );
  require(
    sameOutpoint(genesis?.outpoint, depositState?.activeOutpoint),
    "batch.deposit.genesis.outpoint",
    "must be the persisted current outpoint",
  );
  if (validOutpoint(genesis?.outpoint) && isIndex(genesis?.authorizedOutputIndex)) {
    require(
      genesis.outpoint.index === genesis.authorizedOutputIndex,
      "batch.deposit.genesis.authorizedOutputIndex",
      "must identify the genesis head output",
    );
  }
  if (validOutpoint(genesis?.outpoint) && isHash32(deposit?.txid)) {
    require(
      genesis.outpoint.txid.toLowerCase() === deposit.txid.toLowerCase(),
      "batch.deposit.genesis.outpoint",
      "must belong to the genesis transaction",
    );
  }
  require(
    sameHex(genesis?.scriptPublicKey, depositState?.activeScriptPublicKey),
    "batch.deposit.genesis.scriptPublicKey",
    "must be the persisted current script",
  );
  require(
    sameAmount(genesis?.fundingAmount, depositState?.fundingAmount),
    "batch.deposit.genesis.fundingAmount",
    "must be the persisted current value",
  );
  require(
    genesis?.initialClaimedCumulativeAmount === "0" &&
      depositState?.claimedCumulativeAmount === "0",
    "batch.deposit.genesis.initialClaimedCumulativeAmount",
    "must prove genesis state S = 0",
  );
  require(
    Array.isArray(genesis?.inputComputeBudgets) &&
      genesis.inputComputeBudgets.length > 0 &&
      genesis.inputComputeBudgets.every(
        (value) => Number.isInteger(value) && value >= 0 && value <= 0xffff,
      ),
    "batch.deposit.genesis.inputComputeBudgets",
    "must explicitly record every transaction-v1 input compute budget",
  );

  for (const field of [
    "chargedAmount",
    "settlementAmount",
    "extensionChargedAmount",
    "chargedCumulativeBefore",
  ]) {
    require(isSompi(deposit?.[field]), `batch.deposit.${field}`, "must be a sompi string");
  }
  if (
    isSompi(deposit?.chargedCumulativeBefore) &&
    isSompi(deposit?.chargedAmount) &&
    isSompi(depositState?.chargedCumulativeAmount)
  ) {
    require(
      BigInt(deposit.chargedCumulativeBefore) + BigInt(deposit.chargedAmount) ===
        BigInt(depositState.chargedCumulativeAmount),
      "batch.deposit.state.chargedCumulativeAmount",
      "must equal chargedCumulativeBefore plus chargedAmount",
    );
  }
  require(
    sameAmount(deposit?.chargedAmount, deposit?.settlementAmount) &&
      sameAmount(deposit?.chargedAmount, deposit?.extensionChargedAmount),
    "batch.deposit.chargedAmount",
    "must match settlement and extension charges",
  );

  const voucherOnly = result.batch?.voucherOnly;
  const voucherState = voucherOnly?.state;
  require(voucherOnly?.openedChannel === false, "batch.voucherOnly.openedChannel", "must be false");
  require(
    sameHash(voucherOnly?.channelId, deposit?.channelId),
    "batch.voucherOnly.channelId",
    "must match the deposit channel",
  );
  require(
    isHash32(voucherOnly?.settlementCommitment),
    "batch.voucherOnly.settlementCommitment",
    "must be a commitment id",
  );
  validateBatchState(voucherState, "batch.voucherOnly.state");
  validateVoucherProof(
    voucherOnly?.voucherProof,
    voucherState?.covenantId,
    voucherState?.signedMaxClaimable,
    "batch.voucherOnly.voucherProof",
  );
  require(
    sameHash(voucherState?.covenantId, depositState?.covenantId),
    "batch.voucherOnly.state.covenantId",
    "must preserve the stable covenant id",
  );
  require(
    sameOutpoint(voucherState?.activeOutpoint, depositState?.activeOutpoint) &&
      sameHex(voucherState?.activeScriptPublicKey, depositState?.activeScriptPublicKey),
    "batch.voucherOnly.state.activeOutpoint",
    "must retain the persisted genesis head before an on-chain transition",
  );
  require(
    sameAmount(voucherState?.fundingAmount, depositState?.fundingAmount) &&
      sameAmount(
        voucherState?.claimedCumulativeAmount,
        depositState?.claimedCumulativeAmount,
      ),
    "batch.voucherOnly.state",
    "must preserve V and S before an on-chain transition",
  );
  for (const field of [
    "chargedAmount",
    "settlementAmount",
    "extensionChargedAmount",
    "chargedCumulativeBefore",
  ]) {
    require(isSompi(voucherOnly?.[field]), `batch.voucherOnly.${field}`, "must be a sompi string");
  }
  require(
    sameAmount(voucherOnly?.chargedCumulativeBefore, depositState?.chargedCumulativeAmount),
    "batch.voucherOnly.chargedCumulativeBefore",
    "must equal the first paid response A",
  );
  if (
    isSompi(voucherOnly?.chargedCumulativeBefore) &&
    isSompi(voucherOnly?.chargedAmount) &&
    isSompi(voucherState?.chargedCumulativeAmount)
  ) {
    require(
      BigInt(voucherOnly.chargedCumulativeBefore) + BigInt(voucherOnly.chargedAmount) ===
        BigInt(voucherState.chargedCumulativeAmount),
      "batch.voucherOnly.state.chargedCumulativeAmount",
      "must equal chargedCumulativeBefore plus chargedAmount",
    );
  }
  require(
    sameAmount(voucherOnly?.chargedAmount, voucherOnly?.settlementAmount) &&
      sameAmount(voucherOnly?.chargedAmount, voucherOnly?.extensionChargedAmount),
    "batch.voucherOnly.chargedAmount",
    "must match settlement and extension charges",
  );

  const claim = result.batch?.claim;
  validateBatchSpend(claim, "claim", "batch.claim");
  validateBatchHead(claim?.headAfter, "batch.claim.headAfter");
  validateVoucherProof(
    claim?.voucherProof,
    claim?.covenantId,
    claim?.signedMaxClaimable,
    "batch.claim.voucherProof",
  );
  require(
    sameHash(claim?.covenantId, voucherState?.covenantId),
    "batch.claim.covenantId",
    "must preserve the stable covenant id",
  );
  require(
    sameBatchHead(claim?.headBefore, {
      outpoint: voucherState?.activeOutpoint,
      scriptPublicKey: voucherState?.activeScriptPublicKey,
      fundingAmount: voucherState?.fundingAmount,
      claimedCumulativeAmount: voucherState?.claimedCumulativeAmount,
    }),
    "batch.claim.headBefore",
    "must consume the persisted voucher head",
  );
  require(
    claim?.successorCovenantOutputCount === 1,
    "batch.claim.successorCovenantOutputCount",
    "must prove one same-id successor",
  );
  if (validOutpoint(claim?.headAfter?.outpoint) && isHash32(claim?.txid)) {
    require(
      claim.headAfter.outpoint.txid.toLowerCase() === claim.txid.toLowerCase() &&
        claim.headAfter.outpoint.index === 1,
      "batch.claim.headAfter.outpoint",
      "must be canonical claim successor output 1",
    );
    require(
      !sameOutpoint(claim.headBefore?.outpoint, claim.headAfter.outpoint),
      "batch.claim.headAfter.outpoint",
      "must rotate the persisted current outpoint",
    );
  }
  require(
    isHexBytes(claim?.headBefore?.scriptPublicKey) &&
      isHexBytes(claim?.headAfter?.scriptPublicKey) &&
      !sameHex(claim.headBefore.scriptPublicKey, claim.headAfter.scriptPublicKey),
    "batch.claim.headAfter.scriptPublicKey",
    "must rotate the stateful covenant script after S advances",
  );
  for (const field of [
    "claimAmountSompi",
    "serverOutputAmountSompi",
    "feeSompi",
    "chargedCumulativeAmount",
    "signedMaxClaimable",
  ]) {
    require(isSompi(claim?.[field]), `batch.claim.${field}`, "must be a sompi string");
  }
  require(isPositiveSompi(claim?.claimAmountSompi), "batch.claim.claimAmountSompi", "must be positive");
  require(
    sameAmount(claim?.chargedCumulativeAmount, voucherState?.chargedCumulativeAmount) &&
      sameAmount(claim?.signedMaxClaimable, voucherState?.signedMaxClaimable),
    "batch.claim",
    "must preserve lifetime A and T",
  );
  require(
    sameVoucherProof(claim?.voucherProof, voucherOnly?.voucherProof),
    "batch.claim.voucherProof",
    "must preserve the latest voucher proof",
  );
  if (
    isSompi(claim?.headBefore?.claimedCumulativeAmount) &&
    isSompi(claim?.headAfter?.claimedCumulativeAmount) &&
    isSompi(claim?.claimAmountSompi)
  ) {
    require(
      BigInt(claim.headAfter.claimedCumulativeAmount) ===
        BigInt(claim.headBefore.claimedCumulativeAmount) +
          BigInt(claim.claimAmountSompi),
      "batch.claim.headAfter.claimedCumulativeAmount",
      "must advance S by gross claim D",
    );
  }
  if (
    isSompi(claim?.headBefore?.fundingAmount) &&
    isSompi(claim?.headAfter?.fundingAmount) &&
    isSompi(claim?.claimAmountSompi)
  ) {
    require(
      BigInt(claim.headAfter.fundingAmount) ===
        BigInt(claim.headBefore.fundingAmount) - BigInt(claim.claimAmountSompi),
      "batch.claim.headAfter.fundingAmount",
      "must reduce V by gross claim D",
    );
  }
  if (
    isSompi(claim?.chargedCumulativeAmount) &&
    isSompi(claim?.headBefore?.claimedCumulativeAmount) &&
    isSompi(claim?.claimAmountSompi)
  ) {
    require(
      BigInt(claim.claimAmountSompi) <
        BigInt(claim.chargedCumulativeAmount) -
          BigInt(claim.headBefore.claimedCumulativeAmount),
      "batch.claim.claimAmountSompi",
      "must be a partial claim below outstanding actual charge",
    );
  }
  if (
    isSompi(claim?.claimAmountSompi) &&
    isSompi(claim?.serverOutputAmountSompi) &&
    isSompi(claim?.feeSompi)
  ) {
    require(
      BigInt(claim.claimAmountSompi) ===
        BigInt(claim.serverOutputAmountSompi) + BigInt(claim.feeSompi),
      "batch.claim.serverOutputAmountSompi",
      "must take the fee from provider payout",
    );
  }

  const secondAcceptedClaim = result.batch?.secondAcceptedClaim;
  validateBatchSpend(
    secondAcceptedClaim,
    "claim",
    "batch.secondAcceptedClaim",
  );
  validateBatchHead(
    secondAcceptedClaim?.headAfter,
    "batch.secondAcceptedClaim.headAfter",
  );
  validateVoucherProof(
    secondAcceptedClaim?.voucherProof,
    secondAcceptedClaim?.covenantId,
    secondAcceptedClaim?.signedMaxClaimable,
    "batch.secondAcceptedClaim.voucherProof",
  );
  require(
    sameHash(secondAcceptedClaim?.covenantId, claim?.covenantId) &&
      sameBatchHead(secondAcceptedClaim?.headBefore, claim?.headAfter),
    "batch.secondAcceptedClaim.headBefore",
    "must consume the first accepted claim successor in the same lineage",
  );
  require(
    secondAcceptedClaim?.successorCovenantOutputCount === 1,
    "batch.secondAcceptedClaim.successorCovenantOutputCount",
    "must prove one same-id successor",
  );
  for (const field of [
    "claimAmountSompi",
    "serverOutputAmountSompi",
    "feeSompi",
    "chargedCumulativeAmount",
    "signedMaxClaimable",
  ]) {
    require(
      isSompi(secondAcceptedClaim?.[field]),
      `batch.secondAcceptedClaim.${field}`,
      "must be a sompi string",
    );
  }
  require(
    isPositiveSompi(secondAcceptedClaim?.claimAmountSompi),
    "batch.secondAcceptedClaim.claimAmountSompi",
    "must be positive",
  );
  require(
    sameAmount(
      secondAcceptedClaim?.chargedCumulativeAmount,
      claim?.chargedCumulativeAmount,
    ) &&
      sameAmount(
        secondAcceptedClaim?.signedMaxClaimable,
        claim?.signedMaxClaimable,
      ) &&
      sameVoucherProof(
        secondAcceptedClaim?.voucherProof,
        claim?.voucherProof,
      ),
    "batch.secondAcceptedClaim.voucherProof",
    "must reuse the same voucher and preserve lifetime A and T",
  );
  if (
    validOutpoint(secondAcceptedClaim?.headAfter?.outpoint) &&
    isHash32(secondAcceptedClaim?.txid)
  ) {
    require(
      secondAcceptedClaim.headAfter.outpoint.txid.toLowerCase() ===
          secondAcceptedClaim.txid.toLowerCase() &&
        secondAcceptedClaim.headAfter.outpoint.index === 1 &&
        !sameOutpoint(
          secondAcceptedClaim.headBefore?.outpoint,
          secondAcceptedClaim.headAfter.outpoint,
        ),
      "batch.secondAcceptedClaim.headAfter.outpoint",
      "must rotate to canonical claim successor output 1",
    );
  }
  require(
    isHexBytes(secondAcceptedClaim?.headBefore?.scriptPublicKey) &&
      isHexBytes(secondAcceptedClaim?.headAfter?.scriptPublicKey) &&
      !sameHex(
        secondAcceptedClaim.headBefore.scriptPublicKey,
        secondAcceptedClaim.headAfter.scriptPublicKey,
      ),
    "batch.secondAcceptedClaim.headAfter.scriptPublicKey",
    "must rotate the script as S advances again",
  );
  if (
    isSompi(secondAcceptedClaim?.headBefore?.claimedCumulativeAmount) &&
    isSompi(secondAcceptedClaim?.headAfter?.claimedCumulativeAmount) &&
    isSompi(secondAcceptedClaim?.claimAmountSompi)
  ) {
    require(
      BigInt(secondAcceptedClaim.headAfter.claimedCumulativeAmount) ===
        BigInt(secondAcceptedClaim.headBefore.claimedCumulativeAmount) +
          BigInt(secondAcceptedClaim.claimAmountSompi),
      "batch.secondAcceptedClaim.headAfter.claimedCumulativeAmount",
      "must advance S by the second gross claim D",
    );
  }
  if (
    isSompi(secondAcceptedClaim?.headBefore?.fundingAmount) &&
    isSompi(secondAcceptedClaim?.headAfter?.fundingAmount) &&
    isSompi(secondAcceptedClaim?.claimAmountSompi)
  ) {
    require(
      BigInt(secondAcceptedClaim.headAfter.fundingAmount) ===
        BigInt(secondAcceptedClaim.headBefore.fundingAmount) -
          BigInt(secondAcceptedClaim.claimAmountSompi),
      "batch.secondAcceptedClaim.headAfter.fundingAmount",
      "must reduce V by the second gross claim D",
    );
  }
  if (
    isSompi(secondAcceptedClaim?.chargedCumulativeAmount) &&
    isSompi(secondAcceptedClaim?.headBefore?.claimedCumulativeAmount) &&
    isSompi(secondAcceptedClaim?.claimAmountSompi)
  ) {
    require(
      BigInt(secondAcceptedClaim.claimAmountSompi) <
        BigInt(secondAcceptedClaim.chargedCumulativeAmount) -
          BigInt(secondAcceptedClaim.headBefore.claimedCumulativeAmount),
      "batch.secondAcceptedClaim.claimAmountSompi",
      "must remain partial against the same voucher authorization",
    );
  }
  if (
    isSompi(secondAcceptedClaim?.claimAmountSompi) &&
    isSompi(secondAcceptedClaim?.serverOutputAmountSompi) &&
    isSompi(secondAcceptedClaim?.feeSompi)
  ) {
    require(
      BigInt(secondAcceptedClaim.claimAmountSompi) ===
        BigInt(secondAcceptedClaim.serverOutputAmountSompi) +
          BigInt(secondAcceptedClaim.feeSompi),
      "batch.secondAcceptedClaim.serverOutputAmountSompi",
      "must take the fee from the second provider payout",
    );
  }

  const topUp = result.batch?.topUp;
  validateBatchSpend(topUp, "top-up", "batch.topUp");
  validateBatchHead(topUp?.headAfter, "batch.topUp.headAfter");
  validateVoucherProof(
    topUp?.voucherProof,
    topUp?.covenantId,
    topUp?.signedMaxClaimable,
    "batch.topUp.voucherProof",
  );
  require(
    sameHash(topUp?.covenantId, secondAcceptedClaim?.covenantId),
    "batch.topUp.covenantId",
    "must preserve the stable covenant id",
  );
  require(
    sameBatchHead(topUp?.headBefore, secondAcceptedClaim?.headAfter),
    "batch.topUp.headBefore",
    "must consume the persisted claim successor",
  );
  require(
    topUp?.successorCovenantOutputCount === 1,
    "batch.topUp.successorCovenantOutputCount",
    "must prove one same-id successor",
  );
  require(
    isPositiveSompi(topUp?.addedAmountSompi),
    "batch.topUp.addedAmountSompi",
    "must be a positive sompi string",
  );
  for (const field of ["chargedCumulativeAmount", "signedMaxClaimable"]) {
    require(isSompi(topUp?.[field]), `batch.topUp.${field}`, "must be a sompi string");
  }
  require(
    sameAmount(
      topUp?.chargedCumulativeAmount,
      secondAcceptedClaim?.chargedCumulativeAmount,
    ) &&
      sameAmount(
        topUp?.signedMaxClaimable,
        secondAcceptedClaim?.signedMaxClaimable,
      ),
    "batch.topUp",
    "must preserve lifetime A and T",
  );
  require(
    sameVoucherProof(topUp?.voucherProof, secondAcceptedClaim?.voucherProof),
    "batch.topUp.voucherProof",
    "must preserve the latest voucher proof",
  );
  if (validOutpoint(topUp?.headAfter?.outpoint) && isHash32(topUp?.txid)) {
    require(
      topUp.headAfter.outpoint.txid.toLowerCase() === topUp.txid.toLowerCase() &&
        topUp.headAfter.outpoint.index === 0,
      "batch.topUp.headAfter.outpoint",
      "must be canonical top-up successor output 0",
    );
    require(
      !sameOutpoint(topUp.headBefore?.outpoint, topUp.headAfter.outpoint),
      "batch.topUp.headAfter.outpoint",
      "must rotate the persisted current outpoint",
    );
  }
  require(
    sameHex(topUp?.headBefore?.scriptPublicKey, topUp?.headAfter?.scriptPublicKey),
    "batch.topUp.headAfter.scriptPublicKey",
    "must preserve the script because S is unchanged",
  );
  require(
    sameAmount(
      topUp?.headBefore?.claimedCumulativeAmount,
      topUp?.headAfter?.claimedCumulativeAmount,
    ),
    "batch.topUp.headAfter.claimedCumulativeAmount",
    "must preserve S",
  );
  require(
    sameHash(restartReload?.covenantId, topUp?.covenantId) &&
      sameOutpoint(restartReload?.activeOutpoint, topUp?.headAfter?.outpoint),
    "batch.restartReload.activeOutpoint",
    "must reload the accepted top-up head for the same lineage",
  );
  if (
    isSompi(topUp?.headBefore?.fundingAmount) &&
    isSompi(topUp?.headAfter?.fundingAmount) &&
    isSompi(topUp?.addedAmountSompi)
  ) {
    require(
      BigInt(topUp.headAfter.fundingAmount) ===
        BigInt(topUp.headBefore.fundingAmount) + BigInt(topUp.addedAmountSompi),
      "batch.topUp.headAfter.fundingAmount",
      "must increase V by addedAmountSompi",
    );
  }
  const topUpAdmission = topUp?.admission;
  const topUpAdmissionState = topUpAdmission?.state;
  require(
    topUpAdmission?.openedChannel === false,
    "batch.topUp.admission.openedChannel",
    "must admit the successor into the existing channel",
  );
  require(
    isHash32(topUpAdmission?.settlementCommitment),
    "batch.topUp.admission.settlementCommitment",
    "must prove server admission of the successor",
  );
  validateBatchState(topUpAdmissionState, "batch.topUp.admission.state");
  validateVoucherProof(
    topUpAdmission?.voucherProof,
    topUpAdmissionState?.covenantId,
    topUpAdmissionState?.signedMaxClaimable,
    "batch.topUp.admission.voucherProof",
  );
  require(
    sameHash(topUpAdmissionState?.covenantId, topUp?.covenantId) &&
      sameOutpoint(
        topUpAdmissionState?.activeOutpoint,
        topUp?.headAfter?.outpoint,
      ) &&
      sameHex(
        topUpAdmissionState?.activeScriptPublicKey,
        topUp?.headAfter?.scriptPublicKey,
      ) &&
      sameAmount(
        topUpAdmissionState?.fundingAmount,
        topUp?.headAfter?.fundingAmount,
      ) &&
      sameAmount(
        topUpAdmissionState?.claimedCumulativeAmount,
        topUp?.headAfter?.claimedCumulativeAmount,
      ),
    "batch.topUp.admission.state",
    "must admit the exact same-id top-up successor without changing S",
  );
  for (const field of [
    "chargedAmount",
    "settlementAmount",
    "extensionChargedAmount",
    "chargedCumulativeBefore",
  ]) {
    require(
      isSompi(topUpAdmission?.[field]),
      `batch.topUp.admission.${field}`,
      "must be a sompi string",
    );
  }
  require(
    isPositiveSompi(topUpAdmission?.chargedAmount) &&
      sameAmount(
        topUpAdmission?.chargedAmount,
        topUpAdmission?.settlementAmount,
      ) &&
      sameAmount(
        topUpAdmission?.chargedAmount,
        topUpAdmission?.extensionChargedAmount,
      ),
    "batch.topUp.admission.chargedAmount",
    "must be positive and match both settlement charge fields",
  );
  require(
    sameAmount(
      topUpAdmission?.chargedCumulativeBefore,
      topUp?.chargedCumulativeAmount,
    ),
    "batch.topUp.admission.chargedCumulativeBefore",
    "must start from the pure transition's preserved A",
  );
  if (
    isSompi(topUp?.chargedCumulativeAmount) &&
    isSompi(topUpAdmission?.chargedAmount) &&
    isSompi(topUpAdmissionState?.chargedCumulativeAmount)
  ) {
    require(
      BigInt(topUpAdmissionState.chargedCumulativeAmount) ===
        BigInt(topUp.chargedCumulativeAmount) +
          BigInt(topUpAdmission.chargedAmount),
      "batch.topUp.admission.state.chargedCumulativeAmount",
      "must advance A only when the admitted protected request commits",
    );
  }
  if (
    isSompi(topUpAdmissionState?.chargedCumulativeAmount) &&
    isSompi(topUpAdmissionState?.signedMaxClaimable) &&
    isSompi(topUp?.chargedCumulativeAmount) &&
    isSompi(topUp?.signedMaxClaimable)
  ) {
    require(
      BigInt(topUpAdmissionState.signedMaxClaimable) >=
        BigInt(topUpAdmissionState.chargedCumulativeAmount) &&
        BigInt(topUpAdmissionState.chargedCumulativeAmount) >
          BigInt(topUp.chargedCumulativeAmount) &&
        BigInt(topUpAdmissionState.signedMaxClaimable) >
          BigInt(topUp.signedMaxClaimable),
      "batch.topUp.admission.state.signedMaxClaimable",
      "must prove the forced paid admission advances A and its new voucher T",
    );
  }

  const replay = result.batch?.replay;
  require(replay?.kind === "stale-head", "batch.replay.kind", "must be stale-head");
  require(
    sameHash(replay?.covenantId, claim?.covenantId),
    "batch.replay.covenantId",
    "must identify the same stable lineage",
  );
  require(replay?.rejected === true, "batch.replay.rejected", "must be true");
  require(
    replay?.rpcSubmissionAttempted === true,
    "batch.replay.rpcSubmissionAttempted",
    "must prove the stale transaction reached RPC submission",
  );
  require(
    replay?.definitiveNodeRejection === true,
    "batch.replay.definitiveNodeRejection",
    "must be a transaction-id-bound node rule rejection, not a transport error",
  );
  require(
    isHash32(replay?.attemptedTransactionId) &&
      replay.attemptedTransactionId.toLowerCase() !== claim?.txid?.toLowerCase(),
    "batch.replay.attemptedTransactionId",
    "must identify the distinct stale-head transaction rejected by the node",
  );
  require(
    replay?.spentOutpointAbsent === true &&
      replay?.currentOutpointPresent === true,
    "batch.replay.spentOutpointAbsent",
    "must pair rejection with authoritative spent-old/current-new head evidence",
  );
  require(replay?.finality === "rejected", "batch.replay.finality", "must be rejected");
  require(
    replay?.attemptedTxVersion === 1,
    "batch.replay.attemptedTxVersion",
    "must be transaction v1",
  );
  require(
    replay?.attemptedTxVersionSource === ADAPTER_SUBMITTED_TX_VERSION_SOURCE,
    "batch.replay.attemptedTxVersionSource",
    "must be adapter-submitted-transaction-shape",
  );
  require(
    sameOutpoint(replay?.spentOutpoint, claim?.headBefore?.outpoint) &&
      sameOutpoint(replay?.attemptedInputOutpoint, claim?.headBefore?.outpoint),
    "batch.replay.attemptedInputOutpoint",
    "must retry the spent pre-claim head",
  );
  require(
    sameOutpoint(replay?.observedCurrentOutpoint, claim?.headAfter?.outpoint),
    "batch.replay.observedCurrentOutpoint",
    "must record the accepted successor at rejection time",
  );
  require(
    sameHex(replay?.spentScriptPublicKey, claim?.headBefore?.scriptPublicKey),
    "batch.replay.spentScriptPublicKey",
    "must record the spent head script",
  );
  require(
    sameVoucherProof(replay?.voucherProof, claim?.voucherProof),
    "batch.replay.voucherProof",
    "must show that the voucher remains valid while the spent head does not",
  );
  require(
    isNonEmptyString(replay?.reason),
    "batch.replay.reason",
    "must include node or verifier rejection reason",
  );

  const refund = result.batch?.refund;
  validateBatchSpend(refund, "refund", "batch.refund");
  require(
    sameHash(refund?.covenantId, topUp?.covenantId),
    "batch.refund.covenantId",
    "must terminate the same stable lineage",
  );
  require(
    sameBatchHead(refund?.headBefore, topUp?.headAfter),
    "batch.refund.headBefore",
    "must consume the persisted top-up successor",
  );
  require(refund?.terminal === true, "batch.refund.terminal", "must be true");
  require(
    refund?.clientState === "refunded",
    "batch.refund.clientState",
    "must persist accepted terminal state in the client store",
  );
  require(
    refund?.serverState === "retired",
    "batch.refund.serverState",
    "must retire the terminal lineage in the server store",
  );
  const refundRecovery = refund?.recovery;
  require(
    refundRecovery?.preBroadcastSnapshotFormat ===
      "kaspa-x402-alpha10-refund-before-broadcast-v1" &&
      refundRecovery?.appliedSnapshotFormat ===
        "kaspa-x402-alpha10-refund-applied-v1",
    "batch.refund.recovery",
    "must reload both the pre-broadcast and atomically applied refund snapshots",
  );
  require(
    refundRecovery?.preBroadcastAttemptStatus === "pending" &&
      refundRecovery?.appliedAttemptStatus === "applied",
    "batch.refund.recovery.appliedAttemptStatus",
    "must prove pending-before-send and applied-after-acceptance states",
  );
  for (const field of [
    "exactSignedTransactionReloaded",
    "exactTransactionIdMatched",
    "capturedHeadReloaded",
    "noAutomaticRebroadcast",
  ]) {
    require(
      refundRecovery?.[field] === true,
      `batch.refund.recovery.${field}`,
      "must be true",
    );
  }
  require(
    refund?.successorCovenantOutputCount === 0,
    "batch.refund.successorCovenantOutputCount",
    "must prove no same-id successor",
  );
  require(
    refund?.headAfter === undefined || refund?.headAfter === null,
    "batch.refund.headAfter",
    "must not exist for a terminal refund",
  );
  require(isNonEmptyString(refund?.refundAddress), "batch.refund.refundAddress", "must be present");
  for (const field of [
    "inputAmountSompi",
    "refundAmountSompi",
    "feeSompi",
    "timeoutDaa",
    "lockTimeDaa",
    "observedDaaScore",
  ]) {
    require(isSompi(refund?.[field]), `batch.refund.${field}`, "must be a decimal string");
  }
  require(refund?.outputIndex === 0, "batch.refund.outputIndex", "must be canonical output 0");
  require(
    sameAmount(refund?.inputAmountSompi, refund?.headBefore?.fundingAmount),
    "batch.refund.inputAmountSompi",
    "must consume the current head value",
  );
  if (
    isSompi(refund?.inputAmountSompi) &&
    isSompi(refund?.refundAmountSompi) &&
    isSompi(refund?.feeSompi)
  ) {
    require(
      BigInt(refund.inputAmountSompi) ===
        BigInt(refund.refundAmountSompi) + BigInt(refund.feeSompi),
      "batch.refund.refundAmountSompi",
      "must reconcile the terminal refund fee",
    );
  }
  if (isSompi(refund?.timeoutDaa) && isSompi(refund?.lockTimeDaa)) {
    require(
      BigInt(refund.lockTimeDaa) >= BigInt(refund.timeoutDaa),
      "batch.refund.lockTimeDaa",
      "must meet or exceed the refund timeout",
    );
  }
  if (isSompi(refund?.observedDaaScore) && isSompi(refund?.lockTimeDaa)) {
    require(
      BigInt(refund.observedDaaScore) > BigInt(refund.lockTimeDaa),
      "batch.refund.observedDaaScore",
      "must prove the authoritative DAA score is past the transaction lock time",
    );
  }

  if (errors.length > 0) {
    throw new Error(
      `live proof result failed validation: ${errors.join("; ")}`,
    );
  }
}

function parseArgs(argv) {
  const parsed = {
    envFile: undefined,
    live: false,
    writeReport: false,
    allowBlocked: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      parsed.live = false;
    } else if (arg === "--live") {
      parsed.live = true;
    } else if (arg === "--config-file" || arg === "--env-file") {
      parsed.envFile = argv[index + 1];
      if (!parsed.envFile) throw new Error(`${arg} requires a path`);
      index += 1;
    } else if (arg === "--write-report") {
      parsed.writeReport = true;
    } else if (arg === "--allow-blocked") {
      parsed.allowBlocked = true;
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

function readOptionalEnv(file) {
  if (!file) return {};
  try {
    return readEnvFile(file);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

function readEnvFile(file) {
  const resolved = path.resolve(file);
  const lines = fs.readFileSync(resolved, "utf8").split(/\r?\n/);
  const values = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) throw new Error(`invalid env file line: ${line}`);
    values[match[1]] = unquote(match[2]);
  }
  return values;
}

function nonEmptyValues(values) {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== ""),
  );
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function missingLiveConfig(current) {
  const required = ["rpcUrl", "fundingWallet", "adapterModule"];
  return required.filter((key) => !current[key]).map(envNameForConfigKey);
}

function envNameForConfigKey(key) {
  return {
    rpcUrl: "KASPA_X402_RPC_URL",
    fundingWallet: "KASPA_X402_FUNDING_WALLET",
    adapterModule: "KASPA_X402_LIVE_ADAPTER_MODULE",
  }[key];
}

function redactedConfig(current) {
  return {
    network: current.network,
    rpcUrl: redact(current.rpcUrl),
    fundingWallet: redact(current.fundingWallet),
    dataDir: current.dataDir,
    recoveryFile: current.recoveryFile,
    reportFile: current.reportFile,
    timeoutDaa: current.timeoutDaa,
    adapterModule: current.adapterModule || "",
  };
}

function redact(value) {
  if (!value) return "";
  if (value.length <= 12) return "<set>";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

async function importAdapter(specifier) {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.endsWith(".mjs") ||
    specifier.endsWith(".js")
  ) {
    return import(pathToFileURL(path.resolve(specifier)).href);
  }
  return import(specifier);
}

function writeJson(file, value, { onlyIfRequested = false } = {}) {
  if (onlyIfRequested) return;
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`);
}

function writeRecovery(file, current, currentReport) {
  const recovery = {
    generatedAt: new Date().toISOString(),
    network: current.network,
    status: currentReport.status,
    reportFile: current.reportFile,
    lastFindings: currentReport.findings,
    nextCommand:
      "npm run proof:live:check -- --config-file live-proof.env.example --write-report",
  };
  writeJson(file, recovery);
}

function printReport(value) {
  console.log(JSON.stringify(value, null, 2));
}
