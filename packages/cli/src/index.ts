#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  X402_VERSION,
  decodePaymentRequiredEnvelopeHeader,
  decodePaymentSignatureHeader,
  narrowPaymentRequiredEnvelope,
  parseSompiString,
  stableStringify,
  validatePaymentPayload,
  validatePaymentRequired,
  validatePaymentRetry,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type SompiString,
} from "@kaspa-x402/core";

type CliIo = {
  cwd: string;
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
};

type ParsedArgs = {
  command: string[];
  options: Record<string, string | boolean>;
  positionals: string[];
};

type CommandHandler = (parsed: ParsedArgs, io: CliIo) => Promise<unknown> | unknown;

type CommandDefinition = {
  path: string[];
  summary: string;
  usage: string;
  handler: CommandHandler;
};

class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

const COMMANDS: CommandDefinition[] = [
  {
    path: ["vectors", "verify"],
    summary: "Verify schemas, vectors, x402 headers, digests, tx-v1 fixtures, and negative vectors.",
    usage: "kaspa-x402 vectors verify [--root <repo>] [--json]",
    handler: verifyVectors,
  },
  {
    path: ["exact", "verify"],
    summary: "Validate an exact payment payload against offered payment requirements.",
    usage: "kaspa-x402 exact verify --payment <payload.json> --requirements <requirements.json> [--json]",
    handler: verifyExact,
  },
  {
    path: ["exact", "inspect"],
    summary: "Inspect an exact payment payload or PAYMENT-SIGNATURE header.",
    usage: "kaspa-x402 exact inspect --payment <payload.json> [--json]",
    handler: inspectExact,
  },
  {
    path: ["channel", "inspect"],
    summary: "Inspect client channel state, server channel state, or wire channel state JSON.",
    usage: "kaspa-x402 channel inspect --channel <channel.json> [--json]",
    handler: inspectChannel,
  },
  {
    path: ["claim", "preview"],
    summary: "Preview the currently claimable channel amount before building a claim transaction.",
    usage: "kaspa-x402 claim preview --channel <channel.json> [--fee <amount>] [--json]",
    handler: previewClaim,
  },
  {
    path: ["claim", "submit"],
    summary: "Validate a prepared claim transaction submission request in dry-run mode.",
    usage: "kaspa-x402 claim submit --channel <channel.json> --transaction <hex> --dry-run [--json]",
    handler: submitClaim,
  },
  {
    path: ["refund", "preview"],
    summary: "Preview refund eligibility and refund amount for a channel.",
    usage: "kaspa-x402 refund preview --channel <channel.json> [--now-daa <daa>] [--json]",
    handler: previewRefund,
  },
  {
    path: ["refund", "submit"],
    summary: "Validate a prepared refund transaction submission request in dry-run mode.",
    usage: "kaspa-x402 refund submit --channel <channel.json> --transaction <hex> --dry-run [--json]",
    handler: submitRefund,
  },
];

export async function runCli(argv = process.argv.slice(2), io: CliIo = defaultIo()): Promise<number> {
  try {
    const parsed = parseArgs(argv);
    if (parsed.command.length === 0 || hasHelp(parsed)) {
      writeText(io, commandHelp(parsed.command));
      return 0;
    }

    const command = findCommand(parsed.command);
    if (!command) {
      throw new CliError(`Unknown command: ${parsed.command.join(" ")}\n\n${commandHelp([])}`);
    }

    const result = await command.handler(parsed, io);
    if (result !== undefined) writeResult(io, parsed, result);
    return 0;
  } catch (error) {
    const exitCode = error instanceof CliError ? error.exitCode : 1;
    writeText(io, `${error instanceof Error ? error.message : String(error)}\n`, "stderr");
    return exitCode;
  }
}

async function verifyVectors(parsed: ParsedArgs, io: CliIo): Promise<Record<string, unknown>> {
  const root = optionString(parsed, "root") ?? findRepoRoot(io.cwd);
  const validatorPath = path.join(root, "scripts", "validate-schemas.mjs");
  if (!fs.existsSync(validatorPath)) {
    throw new CliError(`cannot find vector validator at ${validatorPath}`);
  }

  const module = (await import(pathToFileURL(validatorPath).href)) as {
    validateSchemasAndVectors(options?: { root?: string }): { schemaCount: number; vectorCount: number };
  };
  const report = module.validateSchemasAndVectors({ root });
  const fixtureReport = await verifyCovenantFixture(root);
  return {
    ok: true,
    root,
    schemas: report.schemaCount,
    vectors: report.vectorCount,
    covenantFixtureChecks: fixtureReport.checks,
  };
}

function verifyExact(parsed: ParsedArgs): Record<string, unknown> {
  const paymentPayload = readPaymentPayload(parsed);
  if (paymentPayload.accepted.scheme !== "exact" || paymentPayload.payload.type !== "exact-transaction") {
    throw new CliError("payment payload is not an exact-transaction");
  }
  const paymentRequired = readPaymentRequiredForRetry(parsed, paymentPayload);
  const retry = validatePaymentRetry({ paymentPayload, paymentRequired });
  if (!retry.ok) throw retry.error;

  return {
    ok: true,
    scheme: "exact",
    network: paymentPayload.accepted.network,
    amount: paymentPayload.accepted.amount,
    payTo: paymentPayload.accepted.payTo,
    transactionEncoding: paymentPayload.payload.transactionEncoding,
    paymentOutputIndex: paymentPayload.payload.paymentOutputIndex,
  };
}

function inspectExact(parsed: ParsedArgs): Record<string, unknown> {
  const paymentPayload = readPaymentPayload(parsed);
  if (paymentPayload.accepted.scheme !== "exact" || paymentPayload.payload.type !== "exact-transaction") {
    throw new CliError("payment payload is not an exact-transaction");
  }
  return {
    scheme: "exact",
    network: paymentPayload.accepted.network,
    amount: paymentPayload.accepted.amount,
    payTo: paymentPayload.accepted.payTo,
    payerAddress: paymentPayload.payload.payerAddress ?? null,
    transactionEncoding: paymentPayload.payload.transactionEncoding,
    transactionBytes: paymentPayload.payload.transaction.length,
    paymentOutputIndex: paymentPayload.payload.paymentOutputIndex,
    requestHash: paymentPayload.payload.requestHash ?? null,
  };
}

function inspectChannel(parsed: ParsedArgs): Record<string, unknown> {
  const channel = readChannel(parsed);
  return channelSummary(channel);
}

function previewClaim(parsed: ParsedArgs): Record<string, unknown> {
  const channel = readChannel(parsed);
  const charged = amountFromChannel(channel, "chargedCumulativeAmount");
  const claimed = amountFromChannel(channel, "claimedCumulativeAmount");
  const fee = optionAmount(parsed, "fee") ?? "0";
  const active = charged - claimed;
  const feeValue = parseSompiString(fee);
  const funding = amountFromChannel(channel, "fundingAmount");
  const reasons: string[] = [];
  const status = stringField(channel, "status");
  const signedMaxClaimable = stringField(channel, "signedMaxClaimable") ?? stringField(channel, "signedCumulativeAmount");
  const signedMax = signedMaxClaimable === undefined ? undefined : parseSompiString(signedMaxClaimable);
  const hasVoucher = typeof channel.voucherSignature === "string" || isRecord(channel.latestVoucher);
  if (status !== "active") reasons.push("channel_status_is_not_active");
  if (active < 0n) reasons.push("claimed_amount_exceeds_charged_amount");
  if (active > funding) reasons.push("active_claim_exceeds_funding_amount");
  if (active <= 0n) reasons.push("no_unclaimed_amount");
  if (signedMax === undefined) reasons.push("missing_signed_claim_ceiling");
  if (signedMax !== undefined && active > signedMax) reasons.push("signed_claim_ceiling_below_active_claim");
  if (signedMax !== undefined && signedMax > funding) reasons.push("signed_claim_ceiling_exceeds_funding_amount");
  if (!hasVoucher) reasons.push("missing_latest_voucher_or_signature");
  if (feeValue >= active) reasons.push("fee_is_not_below_claim_amount");
  const localChecksPassed = reasons.length === 0;
  const continuationAmount = localChecksPassed ? (funding - active).toString() : null;
  return {
    ok: true,
    action: "claim-preview",
    channel: channelSummary(channel),
    claimable: localChecksPassed ? "unknown" : false,
    localChecksPassed,
    reasons,
    previewClaimAmount: active > 0n ? active.toString() : "0",
    fee,
    continuationAmount,
    requiredEvidence: ["active server channel state", "latest voucher signature", "claim transaction builder", "claim fee estimate"],
  };
}

function submitClaim(parsed: ParsedArgs): Record<string, unknown> {
  assertDryRun(parsed, "claim submit");
  const channel = readChannel(parsed);
  const transaction = requiredHexOption(parsed, "transaction");
  return {
    ok: true,
    dryRun: true,
    action: "claim-submit",
    transaction,
    channel: channelSummary(channel),
  };
}

function previewRefund(parsed: ParsedArgs): Record<string, unknown> {
  const channel = readChannel(parsed);
  const nowDaa = optionAmount(parsed, "now-daa");
  const refundTimeoutDaa = amountFromChannel(channel, "refundTimeoutDaa", ["channelConfig", "refundTimeoutDaa"]);
  const reasons: string[] = [];
  const status = stringField(channel, "status");
  if (status === undefined) reasons.push("missing_channel_status");
  if (status !== undefined && !["active", "retired", "refundable"].includes(status)) reasons.push("channel_status_is_not_refundable");
  if (nowDaa === undefined) reasons.push("now_daa_required");
  if (nowDaa !== undefined && parseSompiString(nowDaa) < refundTimeoutDaa) reasons.push("refund_timeout_not_reached");
  const localChecksPassed = reasons.length === 0;
  return {
    ok: true,
    action: "refund-preview",
    channel: channelSummary(channel),
    refundable: localChecksPassed ? "unknown" : false,
    localChecksPassed,
    refundAmount: amountFromChannel(channel, "fundingAmount").toString(),
    refundTimeoutDaa: refundTimeoutDaa.toString(),
    nowDaa: nowDaa ?? null,
    reasons,
    requiredEvidence: ["active funding UTXO", "matching covenant script", "refund transaction builder", "broadcast result"],
  };
}

function submitRefund(parsed: ParsedArgs): Record<string, unknown> {
  assertDryRun(parsed, "refund submit");
  const channel = readChannel(parsed);
  const transaction = requiredHexOption(parsed, "transaction");
  return {
    ok: true,
    dryRun: true,
    action: "refund-submit",
    transaction,
    channel: channelSummary(channel),
  };
}

function readPaymentPayload(parsed: ParsedArgs): PaymentPayload {
  if (typeof parsed.options["payment-header"] === "string") {
    return decodePaymentSignatureHeader(parsed.options["payment-header"]);
  }
  const raw = readJsonInput(parsed, "payment");
  const validation = validatePaymentPayload(raw);
  if (!validation.ok) throw validation.error;
  return validation.value;
}

function readPaymentRequiredForRetry(parsed: ParsedArgs, paymentPayload: PaymentPayload): PaymentRequired {
  if (typeof parsed.options["payment-required-header"] === "string") {
    const envelope = decodePaymentRequiredEnvelopeHeader(parsed.options["payment-required-header"]);
    const narrowed = narrowPaymentRequiredEnvelope(envelope);
    if (!narrowed.ok) throw narrowed.error;
    return narrowed.value.paymentRequired;
  }
  const raw = readJsonInput(parsed, "requirements");
  const required = validatePaymentRequired(raw);
  if (required.ok) return required.value;

  const requirements = raw as PaymentRequirements;
  const paymentRequired: PaymentRequired = {
    x402Version: X402_VERSION,
    resource: {
      url: optionString(parsed, "resource") ?? "kaspa-x402:cli",
    },
    accepts: [requirements],
  };
  const wrapped = validatePaymentRequired(paymentRequired);
  if (!wrapped.ok) throw required.error;
  if (stableStringify(requirements) !== stableStringify(paymentPayload.accepted)) {
    throw new CliError("payment requirements do not match payload accepted requirements");
  }
  return wrapped.value;
}

function readChannel(parsed: ParsedArgs): Record<string, unknown> {
  const raw = readJsonInput(parsed, "channel");
  if (!isRecord(raw)) throw new CliError("channel input must be a JSON object");
  return raw;
}

function channelSummary(channel: Record<string, unknown>): Record<string, unknown> {
  const config = isRecord(channel.config) ? channel.config : isRecord(channel.channelConfig) ? channel.channelConfig : undefined;
  const activeOutpoint = isRecord(channel.activeOutpoint) ? channel.activeOutpoint : undefined;
  return {
    channelId: stringField(channel, "id") ?? stringField(channel, "channelId"),
    network: stringField(config, "network"),
    status: stringField(channel, "status"),
    activeOutpoint,
    fundingAmount: stringField(channel, "fundingAmount"),
    chargedCumulativeAmount: stringField(channel, "chargedCumulativeAmount"),
    claimedCumulativeAmount: stringField(channel, "claimedCumulativeAmount"),
    signedMaxClaimable: stringField(channel, "signedMaxClaimable") ?? stringField(channel, "signedCumulativeAmount"),
    refundTimeoutDaa: stringField(channel, "refundTimeoutDaa") ?? stringField(config, "refundTimeoutDaa"),
  };
}

function amountFromChannel(channel: Record<string, unknown>, field: string, fallbackPath?: [string, string]): bigint {
  const direct = stringField(channel, field);
  if (direct !== undefined) return parseSompiString(direct);
  if (fallbackPath) {
    const parentValue = channel[fallbackPath[0]];
    const parent = isRecord(parentValue) ? parentValue : undefined;
    const nested = stringField(parent, fallbackPath[1]);
    if (nested !== undefined) return parseSompiString(nested);
  }
  throw new CliError(`channel is missing ${field}`);
}

function readJsonInput(parsed: ParsedArgs, optionName: string): unknown {
  const file = optionString(parsed, optionName) ?? parsed.positionals[0];
  if (file) return JSON.parse(fs.readFileSync(file, "utf8"));
  if (parsed.options.stdin === true) return JSON.parse(fs.readFileSync(0, "utf8"));
  throw new CliError(`missing --${optionName}`);
}

function optionAmount(parsed: ParsedArgs, name: string): SompiString | undefined {
  const value = optionString(parsed, name);
  if (value === undefined) return undefined;
  parseSompiString(value);
  return value;
}

function requiredHexOption(parsed: ParsedArgs, name: string): string {
  const value = optionString(parsed, name);
  if (!value) throw new CliError(`missing --${name}`);
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(value)) throw new CliError(`--${name} must be an even-length hex string`);
  return value;
}

function assertDryRun(parsed: ParsedArgs, command: string): void {
  if (parsed.options["dry-run"] !== true) {
    throw new CliError(`${command} requires --dry-run until a broadcast adapter is configured`);
  }
}

async function verifyCovenantFixture(root: string): Promise<{ checks: number }> {
  const escrowFixture = readCovenantFixture(root, "kaspa-x402-escrow-v1.json");
  const module = (await import("@kaspa-x402/covenant")) as {
    checkEscrowFixtureReproducibility: (fixture: unknown, source: Uint8Array) => { checks: readonly unknown[] };
  };
  const escrowReport = module.checkEscrowFixtureReproducibility(escrowFixture.fixture, escrowFixture.source);
  return { checks: escrowReport.checks.length };
}

function readCovenantFixture(root: string, name: string): { fixture: unknown; source: Uint8Array } {
  const fixturePath = path.join(root, "contracts", "fixtures", name);
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  if (!isRecord(fixture) || typeof fixture.source !== "string") throw new CliError(`${name} covenant fixture is missing source`);
  return {
    fixture,
    source: fs.readFileSync(path.join(root, fixture.source)),
  };
}

function parseArgs(argv: string[]): ParsedArgs {
  const command: string[] = [];
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};
  let parsingOptions = true;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq >= 0) {
        options[arg.slice(2, eq)] = arg.slice(eq + 1);
        continue;
      }
      const key = arg.slice(2);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("-")) {
        options[key] = next;
        index += 1;
      } else {
        options[key] = true;
      }
      continue;
    }
    if (command.length < 2 && !findCommand(command)) {
      command.push(arg);
    } else {
      positionals.push(arg);
    }
  }

  if (command[0] === "help") {
    return { command: command.slice(1).concat(positionals), options: { help: true }, positionals: [] };
  }
  return { command, options, positionals };
}

function hasHelp(parsed: ParsedArgs): boolean {
  return parsed.options.help === true || parsed.options.h === true;
}

function findCommand(pathParts: string[]): CommandDefinition | undefined {
  return COMMANDS.find((command) => command.path.length === pathParts.length && command.path.every((part, index) => part === pathParts[index]));
}

function commandHelp(pathParts: string[]): string {
  const command = pathParts.length > 0 ? findCommand(pathParts) : undefined;
  if (command) {
    return `${command.usage}\n\n${command.summary}\n`;
  }
  return [
    "kaspa-x402",
    "",
    "Usage:",
    "  kaspa-x402 <command> [options]",
    "",
    "Commands:",
    ...COMMANDS.map((item) => `  ${item.path.join(" ").padEnd(18)} ${item.summary}`),
    "",
    "Use `kaspa-x402 <command> --help` for command-specific options.",
    "",
  ].join("\n");
}

function writeResult(io: CliIo, parsed: ParsedArgs, value: unknown): void {
  if (parsed.options.json === true) {
    writeText(io, `${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  writeText(io, `${formatHuman(value)}\n`);
}

function formatHuman(value: unknown): string {
  if (!isRecord(value)) return String(value);
  return Object.entries(value)
    .map(([key, item]) => `${key}: ${formatHumanValue(item)}`)
    .join("\n");
}

function formatHumanValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function writeText(io: CliIo, text: string, stream: "stdout" | "stderr" = "stdout"): void {
  io[stream].write(text);
}

function optionString(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.options[name];
  return typeof value === "string" ? value : undefined;
}

function findRepoRoot(cwd: string): string {
  let current = path.resolve(cwd);
  while (true) {
    const packagePath = path.join(current, "package.json");
    if (fs.existsSync(packagePath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { name?: string };
        if (pkg.name === "kaspa-x402" && fs.existsSync(path.join(current, "vectors"))) return current;
      } catch {
        // Keep walking.
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new CliError("could not find kaspa-x402 repo root; pass --root");
}

function stringField(record: Record<string, unknown> | undefined, field: string): string | undefined {
  const value = record?.[field];
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function defaultIo(): CliIo {
  return {
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = await runCli();
}
