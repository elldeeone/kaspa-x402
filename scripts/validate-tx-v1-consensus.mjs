#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_COMMIT = "78257f273a26c4be085bab0f79437dee99ca8835";
const EXPECTED_VERSION = "2.0.1";
const CONSENSUS_SOURCE_PATHS = [
  "Cargo.lock",
  "Cargo.toml",
  "consensus/core",
  "consensus/src",
  "core",
  "crypto/addresses",
  "crypto/hashes",
  "crypto/merkle",
  "crypto/muhash",
  "crypto/smt",
  "crypto/txscript/errors",
  "crypto/txscript",
  "math",
  "utils",
];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parseArgs(process.argv.slice(2));
const kaspaRoot = path.resolve(options.kaspaRoot ?? process.env.KASPA_X402_KASPA_CONSENSUS_ROOT ?? process.env.KASPA_CONSENSUS_ROOT ?? "");

if (!kaspaRoot || kaspaRoot === process.cwd()) {
  fail(
    "Set KASPA_X402_KASPA_CONSENSUS_ROOT or pass --kaspa-root <path> to a canonical Kaspa checkout.",
  );
}

const consensusCargo = path.join(kaspaRoot, "consensus/core/Cargo.toml");
const hashesCargo = path.join(kaspaRoot, "crypto/hashes/Cargo.toml");
if (!fs.existsSync(consensusCargo) || !fs.existsSync(hashesCargo)) {
  fail("Kaspa checkout must contain consensus/core and crypto/hashes Cargo packages.");
}

const actualCommit = run("git", ["-C", kaspaRoot, "rev-parse", "HEAD"]).stdout.trim();
if (actualCommit !== EXPECTED_COMMIT && !options.allowDifferentSource) {
  fail(`Kaspa checkout is at ${actualCommit}; expected ${EXPECTED_COMMIT}.`);
}
const dirtySourceEntries = gitStatusEntries(kaspaRoot).filter((entry) => entry.status !== "??" || isConsensusSourcePath(entry.path));
if (dirtySourceEntries.length > 0 && !options.allowDifferentSource) {
  fail(
    `Kaspa checkout has local changes in pinned consensus validation scope:\n${dirtySourceEntries
      .map((entry) => `${entry.status} ${entry.path}`)
      .join("\n")}`,
  );
}

const consensusCargoToml = fs.readFileSync(consensusCargo, "utf8");
const workspaceCargoToml = fs.readFileSync(path.join(kaspaRoot, "Cargo.toml"), "utf8");
const packageVersionMatches = new RegExp(`^version\\s*=\\s*"${escapeRegExp(EXPECTED_VERSION)}"`, "m").test(consensusCargoToml);
const workspaceVersionMatches =
  /^version\.workspace\s*=\s*true/m.test(consensusCargoToml) &&
  new RegExp(`^version\\s*=\\s*"${escapeRegExp(EXPECTED_VERSION)}"`, "m").test(workspaceCargoToml);
if (!packageVersionMatches && !workspaceVersionMatches) {
  fail(`kaspa-consensus-core package version must be ${EXPECTED_VERSION}.`);
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kaspa-x402-txv1-"));
try {
  const srcDir = path.join(tempDir, "src");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.copyFileSync(path.join(root, "tools/tx-v1-consensus/src/main.rs"), path.join(srcDir, "main.rs"));
  fs.writeFileSync(path.join(tempDir, "Cargo.toml"), cargoToml(kaspaRoot));

  const targetDir = process.env.CARGO_TARGET_DIR ?? path.join(root, ".kaspa-x402-consensus-target");
  const result = spawnSync(
    "cargo",
    ["run", "--quiet", "--manifest-path", path.join(tempDir, "Cargo.toml"), "--", root],
    {
      cwd: root,
      env: { ...process.env, CARGO_TARGET_DIR: targetDir },
      encoding: "utf8",
    },
  );

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

if (process.exitCode) process.exit(process.exitCode);

function parseArgs(args) {
  const parsed = { kaspaRoot: undefined, allowDifferentSource: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--kaspa-root") {
      parsed.kaspaRoot = args[++index];
    } else if (arg === "--allow-different-source") {
      parsed.allowDifferentSource = true;
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function cargoToml(kaspaRoot) {
  const validatorPath = path.join(kaspaRoot, "consensus").replaceAll("\\", "\\\\");
  const consensusPath = path.join(kaspaRoot, "consensus/core").replaceAll("\\", "\\\\");
  const hashesPath = path.join(kaspaRoot, "crypto/hashes").replaceAll("\\", "\\\\");
  const txscriptPath = path.join(kaspaRoot, "crypto/txscript").replaceAll("\\", "\\\\");
  return `[package]
name = "kaspa-x402-tx-v1-consensus-check"
version = "0.0.0"
edition = "2024"
publish = false

[dependencies]
anyhow = "1"
hex = "0.4"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
kaspa-consensus-core = { path = "${consensusPath}" }
kaspa-consensus = { path = "${validatorPath}" }
kaspa-hashes = { path = "${hashesPath}" }
kaspa-txscript = { path = "${txscriptPath}" }
secp256k1 = { version = "0.29.0", features = ["global-context"] }
`;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    const message = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    fail(message || `${command} ${args.join(" ")} failed`);
  }
  return result;
}

function gitStatusEntries(repoRoot) {
  const stdout = run("git", ["-C", repoRoot, "status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout;
  const tokens = stdout.split("\0").filter(Boolean);
  const entries = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const status = token.slice(0, 2);
    const file = token.slice(3);
    entries.push({ status, path: file });
    if (status.includes("R") || status.includes("C")) {
      index += 1;
    }
  }
  return entries;
}

function isConsensusSourcePath(file) {
  return CONSENSUS_SOURCE_PATHS.some((sourcePath) => file === sourcePath || file.startsWith(`${sourcePath}/`));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
