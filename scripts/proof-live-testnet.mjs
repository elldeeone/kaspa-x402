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
  recoveryFile: env.KASPA_X402_RECOVERY_FILE || ".kaspa-x402-live/recovery.json",
  reportFile: env.KASPA_X402_REPORT_FILE || ".kaspa-x402-live/report.json",
  timeoutDaa: env.KASPA_X402_TIMEOUT_DAA || "1800",
  adapterModule: env.KASPA_X402_LIVE_ADAPTER_MODULE || "",
  confirmation: env.KASPA_X402_LIVE_CONFIRM || "",
};

const requiredFlows = [
  "exact payment and replay rejection",
  "upto zero-charge authorization",
  "upto nonzero settlement",
  "batch deposit-voucher settlement",
  "batch voucher-only settlement",
  "batch claim transaction construction and broadcast",
  "replay rejection across exact, upto, and batch-settlement",
  "batch refund transaction construction and broadcast after timeout",
];
const SDK_GENERATED_TX_VERSION_SOURCE = "sdk-generated-transaction";
const ADAPTER_SUBMITTED_TX_VERSION_SOURCE = "adapter-submitted-transaction-shape";

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
if (options.live && config.confirmation !== "I_UNDERSTAND_THIS_USES_TESTNET_FUNDS") {
  report.findings.push({
    severity: "blocker",
    code: "missing_live_confirmation",
    message: "Set KASPA_X402_LIVE_CONFIRM before running with --live.",
  });
}

if (!options.live) {
  report.status = report.findings.length === 0 ? "ready-for-live-run" : "blocked";
  writeJson(config.reportFile, report, { onlyIfRequested: !options.writeReport });
  if (options.writeReport && report.status === "blocked") writeRecovery(config.recoveryFile, config, report);
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
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const isHash32 = (value) => typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value);
  const isNonEmptyString = (value) => typeof value === "string" && value.length > 0;
  const isSompi = (value) => typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value);
  const isPositiveSompi = (value) => isSompi(value) && BigInt(value) > 0n;
  const isIndex = (value) => Number.isInteger(value) && value >= 0;
  const isTxVersion = (value) => Number.isInteger(value) && value >= 0;
  const isTxVersionSource = (value) =>
    value === SDK_GENERATED_TX_VERSION_SOURCE || value === ADAPTER_SUBMITTED_TX_VERSION_SOURCE;
  const isFinal = (value) => value === "accepted" || value === "confirmed";
  const isHexBytes = (value) => typeof value === "string" && value.length > 0 && value.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(value);
  const validOutpoint = (value) => isObject(value) && isHash32(value.txid) && isIndex(value.index);
  const sameOutpoint = (left, right) =>
    validOutpoint(left) &&
    validOutpoint(right) &&
    left.txid.toLowerCase() === right.txid.toLowerCase() &&
    left.index === right.index;

  require(isObject(result), "result", "must be an object");
  if (!isObject(result)) throw new Error(`live proof result failed validation: ${errors.join("; ")}`);

  for (const flow of flows) {
    require(result.requiredFlowStatus?.[flow] === "passed", `requiredFlowStatus.${flow}`, "must be passed");
  }

  require(isHash32(result.exact?.txid), "exact.txid", "must be a transaction id");
  require(isTxVersion(result.exact?.txVersion), "exact.txVersion", "must state the transaction version");
  require(isTxVersionSource(result.exact?.txVersionSource), "exact.txVersionSource", "must state an allowed version evidence source");
  require(result.exact?.txVersionSource === SDK_GENERATED_TX_VERSION_SOURCE, "exact.txVersionSource", "must be sdk-generated-transaction");
  require(isIndex(result.exact?.outputIndex), "exact.outputIndex", "must be a non-negative integer");
  require(isPositiveSompi(result.exact?.amount), "exact.amount", "must be a positive sompi string");
  require(isFinal(result.exact?.finality), "exact.finality", "must be accepted or confirmed");
  require(result.exact?.replay?.status === 409, "exact.replay.status", "must be 409");
  require(result.exact?.replay?.error === "invalid_transaction_state", "exact.replay.error", "must be invalid_transaction_state");

  require(validOutpoint(result.upto?.zero?.authorizationOutpoint), "upto.zero.authorizationOutpoint", "must be an outpoint");
  require(isTxVersion(result.upto?.zero?.authorizationTxVersion), "upto.zero.authorizationTxVersion", "must state the authorization transaction version");
  require(isTxVersionSource(result.upto?.zero?.authorizationTxVersionSource), "upto.zero.authorizationTxVersionSource", "must state an allowed authorization version evidence source");
  require(result.upto?.zero?.authorizationTxVersionSource === SDK_GENERATED_TX_VERSION_SOURCE, "upto.zero.authorizationTxVersionSource", "must be sdk-generated-transaction");
  require(isPositiveSompi(result.upto?.zero?.maxAmountSompi), "upto.zero.maxAmountSompi", "must be a positive sompi string");
  require(result.upto?.zero?.chargedAmount === "0", "upto.zero.chargedAmount", "must be zero");
  require(result.upto?.zero?.transaction === "", "upto.zero.transaction", "must be empty for zero-charge");
  require(result.upto?.zero?.txVersion === null, "upto.zero.txVersion", "must be null for zero-charge");
  require(result.upto?.zero?.txVersionSource === "no-transaction", "upto.zero.txVersionSource", "must state no-transaction");
  require(validOutpoint(result.upto?.nonzero?.authorizationOutpoint), "upto.nonzero.authorizationOutpoint", "must be an outpoint");
  require(isTxVersion(result.upto?.nonzero?.authorizationTxVersion), "upto.nonzero.authorizationTxVersion", "must state the authorization transaction version");
  require(isTxVersionSource(result.upto?.nonzero?.authorizationTxVersionSource), "upto.nonzero.authorizationTxVersionSource", "must state an allowed authorization version evidence source");
  require(result.upto?.nonzero?.authorizationTxVersionSource === SDK_GENERATED_TX_VERSION_SOURCE, "upto.nonzero.authorizationTxVersionSource", "must be sdk-generated-transaction");
  require(isPositiveSompi(result.upto?.nonzero?.maxAmountSompi), "upto.nonzero.maxAmountSompi", "must be a positive sompi string");
  require(isPositiveSompi(result.upto?.nonzero?.chargedAmount), "upto.nonzero.chargedAmount", "must be a positive sompi string");
  if (isSompi(result.upto?.nonzero?.chargedAmount) && isSompi(result.upto?.nonzero?.maxAmountSompi)) {
    require(BigInt(result.upto.nonzero.chargedAmount) <= BigInt(result.upto.nonzero.maxAmountSompi), "upto.nonzero.chargedAmount", "must not exceed maxAmountSompi");
  }
  require(isHash32(result.upto?.nonzero?.txid), "upto.nonzero.txid", "must be a transaction id");
  require(result.upto?.nonzero?.txVersion === 1, "upto.nonzero.txVersion", "must be transaction v1");
  require(isTxVersionSource(result.upto?.nonzero?.txVersionSource), "upto.nonzero.txVersionSource", "must state an allowed version evidence source");
  require(result.upto?.nonzero?.txVersionSource === ADAPTER_SUBMITTED_TX_VERSION_SOURCE, "upto.nonzero.txVersionSource", "must be adapter-submitted-transaction-shape");
  require(isIndex(result.upto?.nonzero?.paymentOutputIndex), "upto.nonzero.paymentOutputIndex", "must be a non-negative integer");
  require(result.upto?.replay?.status === 409, "upto.replay.status", "must be 409");
  require(result.upto?.replay?.error === "invalid_transaction_state", "upto.replay.error", "must be invalid_transaction_state");

  require(isHash32(result.batch?.deposit?.txid), "batch.deposit.txid", "must be a transaction id");
  require(isTxVersion(result.batch?.deposit?.txVersion), "batch.deposit.txVersion", "must state the transaction version");
  require(isTxVersionSource(result.batch?.deposit?.txVersionSource), "batch.deposit.txVersionSource", "must state an allowed version evidence source");
  require(result.batch?.deposit?.txVersionSource === SDK_GENERATED_TX_VERSION_SOURCE, "batch.deposit.txVersionSource", "must be sdk-generated-transaction");
  require(validOutpoint(result.batch?.deposit?.outpoint), "batch.deposit.outpoint", "must be an outpoint");
  if (validOutpoint(result.batch?.deposit?.outpoint) && isHash32(result.batch?.deposit?.txid)) {
    require(result.batch.deposit.outpoint.txid.toLowerCase() === result.batch.deposit.txid.toLowerCase(), "batch.deposit.outpoint", "must belong to deposit txid");
  }
  require(isNonEmptyString(result.batch?.deposit?.escrowAddress), "batch.deposit.escrowAddress", "must be present");
  require(isPositiveSompi(result.batch?.deposit?.fundingAmountSompi), "batch.deposit.fundingAmountSompi", "must be a positive sompi string");
  require(isHash32(result.batch?.deposit?.channelId), "batch.deposit.channelId", "must be a channel id");
  require(isHash32(result.batch?.deposit?.settlementCommitment), "batch.deposit.settlementCommitment", "must be a commitment id");
  require(result.batch?.voucherOnly?.openedChannel === false, "batch.voucherOnly.openedChannel", "must be false");
  require(isHash32(result.batch?.voucherOnly?.settlementCommitment), "batch.voucherOnly.settlementCommitment", "must be a commitment id");
  require(isPositiveSompi(result.batch?.voucherOnly?.chargedCumulativeAmount), "batch.voucherOnly.chargedCumulativeAmount", "must be a positive sompi string");
  require(isPositiveSompi(result.batch?.voucherOnly?.signedMaxClaimable), "batch.voucherOnly.signedMaxClaimable", "must be a positive sompi string");
  require(isHash32(result.batch?.claim?.txid), "batch.claim.txid", "must be a transaction id");
  require(result.batch?.claim?.txVersion === 1, "batch.claim.txVersion", "must be transaction v1");
  require(isTxVersionSource(result.batch?.claim?.txVersionSource), "batch.claim.txVersionSource", "must state an allowed version evidence source");
  require(result.batch?.claim?.txVersionSource === ADAPTER_SUBMITTED_TX_VERSION_SOURCE, "batch.claim.txVersionSource", "must be adapter-submitted-transaction-shape");
  require(isFinal(result.batch?.claim?.finality), "batch.claim.finality", "must be accepted or confirmed");
  require(validOutpoint(result.batch?.claim?.originalOutpoint), "batch.claim.originalOutpoint", "must be an outpoint");
  require(validOutpoint(result.batch?.claim?.continuationOutpoint), "batch.claim.continuationOutpoint", "must be an outpoint");
  if (validOutpoint(result.batch?.claim?.continuationOutpoint) && isHash32(result.batch?.claim?.txid)) {
    require(result.batch.claim.continuationOutpoint.txid.toLowerCase() === result.batch.claim.txid.toLowerCase(), "batch.claim.continuationOutpoint", "must belong to claim txid");
  }
  require(isPositiveSompi(result.batch?.claim?.continuationFundingAmountSompi), "batch.claim.continuationFundingAmountSompi", "must be a positive sompi string");
  require(result.batch?.replay?.rejected === true, "batch.replay.rejected", "must be true");
  require(validOutpoint(result.batch?.replay?.oldOutpoint), "batch.replay.oldOutpoint", "must be an outpoint");
  if (validOutpoint(result.batch?.replay?.oldOutpoint) && validOutpoint(result.batch?.claim?.originalOutpoint)) {
    require(sameOutpoint(result.batch.replay.oldOutpoint, result.batch.claim.originalOutpoint), "batch.replay.oldOutpoint", "must match original claimed outpoint");
  }
  require(isHexBytes(result.batch?.replay?.oldScriptPublicKey), "batch.replay.oldScriptPublicKey", "must be hex bytes");
  require(validOutpoint(result.batch?.replay?.attemptedInputOutpoint), "batch.replay.attemptedInputOutpoint", "must be an outpoint");
  require(result.batch?.replay?.attemptedTxVersion === 1, "batch.replay.attemptedTxVersion", "must be transaction v1");
  require(isTxVersionSource(result.batch?.replay?.attemptedTxVersionSource), "batch.replay.attemptedTxVersionSource", "must state an allowed version evidence source");
  require(result.batch?.replay?.attemptedTxVersionSource === ADAPTER_SUBMITTED_TX_VERSION_SOURCE, "batch.replay.attemptedTxVersionSource", "must be adapter-submitted-transaction-shape");
  if (validOutpoint(result.batch?.replay?.attemptedInputOutpoint) && validOutpoint(result.batch?.claim?.continuationOutpoint)) {
    require(sameOutpoint(result.batch.replay.attemptedInputOutpoint, result.batch.claim.continuationOutpoint), "batch.replay.attemptedInputOutpoint", "must match continuation outpoint");
  }
  require(isPositiveSompi(result.batch?.replay?.serverOutputAmountSompi), "batch.replay.serverOutputAmountSompi", "must be a positive sompi string");
  require(isPositiveSompi(result.batch?.replay?.continuationOutputAmountSompi), "batch.replay.continuationOutputAmountSompi", "must be a positive sompi string");
  require(isNonEmptyString(result.batch?.replay?.reason), "batch.replay.reason", "must include node or verifier rejection reason");
  if (isNonEmptyString(result.batch?.replay?.reason)) {
    require(/script|signature|verificat/i.test(result.batch.replay.reason), "batch.replay.reason", "must indicate script or signature verification failure");
    require(!/zero value|malformed|invalid output/i.test(result.batch.replay.reason), "batch.replay.reason", "must not be a malformed transaction rejection");
  }
  require(isHash32(result.batch?.refund?.txid), "batch.refund.txid", "must be a transaction id");
  require(result.batch?.refund?.txVersion === 1, "batch.refund.txVersion", "must be transaction v1");
  require(isTxVersionSource(result.batch?.refund?.txVersionSource), "batch.refund.txVersionSource", "must state an allowed version evidence source");
  require(result.batch?.refund?.txVersionSource === ADAPTER_SUBMITTED_TX_VERSION_SOURCE, "batch.refund.txVersionSource", "must be adapter-submitted-transaction-shape");
  require(isNonEmptyString(result.batch?.refund?.refundAddress), "batch.refund.refundAddress", "must be present");
  require(isPositiveSompi(result.batch?.refund?.refundAmountSompi), "batch.refund.refundAmountSompi", "must be a positive sompi string");
  require(isIndex(result.batch?.refund?.outputIndex), "batch.refund.outputIndex", "must be a non-negative integer");

  if (errors.length > 0) {
    throw new Error(`live proof result failed validation: ${errors.join("; ")}`);
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
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ""));
}

function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
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
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.endsWith(".mjs") || specifier.endsWith(".js")) {
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
    nextCommand: "npm run proof:live:check -- --config-file live-proof.env.example --write-report",
  };
  writeJson(file, recovery);
}

function printReport(value) {
  console.log(JSON.stringify(value, null, 2));
}
