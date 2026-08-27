#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_COMMIT = "c338d495bec29e4dc8b5149f99e8db6fa916ed4a";
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
const committedLock = path.join(root, "tools/tx-v1-consensus/Cargo.lock");
const cargoHome = path.resolve(
  process.env.KASPA_X402_CONSENSUS_CARGO_HOME ??
    path.join(root, ".kaspa-x402-consensus-cargo-home"),
);
const cargoEnvironment = isolatedCargoEnvironment(cargoHome);
const options = parseArgs(process.argv.slice(2));
const kaspaRootInput =
  options.kaspaRoot ??
  process.env.KASPA_X402_KASPA_CONSENSUS_ROOT ??
  process.env.KASPA_CONSENSUS_ROOT ??
  "";
const kaspaRoot = path.resolve(kaspaRootInput || ".");

if (!kaspaRootInput) {
  fail(
    "Set KASPA_X402_KASPA_CONSENSUS_ROOT or pass --kaspa-root <path> to a canonical Kaspa checkout.",
  );
}

const canonicalKaspaRoot = fs.realpathSync(kaspaRoot);
const gitTopLevel = fs.realpathSync(
  run("git", [
    "-C",
    canonicalKaspaRoot,
    "rev-parse",
    "--show-toplevel",
  ]).stdout.trim(),
);
if (canonicalKaspaRoot !== gitTopLevel) {
  fail(
    `Kaspa checkout root must equal its Git top-level: selected ${canonicalKaspaRoot}, top-level ${gitTopLevel}.`,
  );
}

const consensusCargo = path.join(kaspaRoot, "consensus/core/Cargo.toml");
const hashesCargo = path.join(kaspaRoot, "crypto/hashes/Cargo.toml");
if (!fs.existsSync(consensusCargo) || !fs.existsSync(hashesCargo)) {
  fail(
    "Kaspa checkout must contain consensus/core and crypto/hashes Cargo packages.",
  );
}

const actualCommit = run("git", [
  "-C",
  kaspaRoot,
  "rev-parse",
  "HEAD",
]).stdout.trim();
if (actualCommit !== EXPECTED_COMMIT && !options.allowDifferentSource) {
  fail(`Kaspa checkout is at ${actualCommit}; expected ${EXPECTED_COMMIT}.`);
}
const dirtySourceEntries = gitStatusEntries(kaspaRoot).filter(
  (entry) => entry.status !== "??" || isConsensusSourcePath(entry.path),
);
const specialIndexEntries = run("git", [
  "-C",
  kaspaRoot,
  "ls-files",
  "-v",
  "--",
  ...CONSENSUS_SOURCE_PATHS,
])
  .stdout.split(/\r?\n/)
  .filter(Boolean)
  .filter((entry) => !entry.startsWith("H "));
if (specialIndexEntries.length > 0 && !options.allowDifferentSource) {
  fail(
    `Kaspa checkout uses hidden or special index state in consensus validation scope:\n${specialIndexEntries.join("\n")}`,
  );
}
const ignoredSourceEntries = run("git", [
  "-C",
  kaspaRoot,
  "ls-files",
  "--others",
  "--ignored",
  "--exclude-standard",
  "--",
  ...CONSENSUS_SOURCE_PATHS,
])
  .stdout.split(/\r?\n/)
  .filter(Boolean);
if (ignoredSourceEntries.length > 0 && !options.allowDifferentSource) {
  fail(
    `Kaspa checkout has ignored files in consensus validation scope:\n${ignoredSourceEntries.join("\n")}`,
  );
}
if (dirtySourceEntries.length > 0 && !options.allowDifferentSource) {
  fail(
    `Kaspa checkout has local changes in pinned consensus validation scope:\n${dirtySourceEntries
      .map((entry) => `${entry.status} ${entry.path}`)
      .join("\n")}`,
  );
}

const consensusCargoToml = fs.readFileSync(consensusCargo, "utf8");
const workspaceCargoToml = fs.readFileSync(
  path.join(kaspaRoot, "Cargo.toml"),
  "utf8",
);
const packageVersionMatches = new RegExp(
  `^version\\s*=\\s*"${escapeRegExp(EXPECTED_VERSION)}"`,
  "m",
).test(consensusCargoToml);
const workspaceVersionMatches =
  /^version\.workspace\s*=\s*true/m.test(consensusCargoToml) &&
  new RegExp(`^version\\s*=\\s*"${escapeRegExp(EXPECTED_VERSION)}"`, "m").test(
    workspaceCargoToml,
  );
if (!packageVersionMatches && !workspaceVersionMatches) {
  fail(`kaspa-consensus-core package version must be ${EXPECTED_VERSION}.`);
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kaspa-x402-txv1-"));
try {
  const srcDir = path.join(tempDir, "src");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.copyFileSync(
    path.join(root, "tools/tx-v1-consensus/src/main.rs"),
    path.join(srcDir, "main.rs"),
  );
  fs.writeFileSync(path.join(tempDir, "Cargo.toml"), cargoToml(kaspaRoot));
  if (options.refreshLock) {
    const lock = spawnSync(
      "cargo",
      [
        "generate-lockfile",
        "--manifest-path",
        path.join(tempDir, "Cargo.toml"),
      ],
      { cwd: root, env: cargoEnvironment, encoding: "utf8" },
    );
    if (lock.status !== 0) {
      process.stderr.write(
        lock.stderr || lock.stdout || "cargo generate-lockfile failed\n",
      );
      process.exitCode = lock.status ?? 1;
    } else {
      fs.copyFileSync(path.join(tempDir, "Cargo.lock"), committedLock);
    }
  } else if (!fs.existsSync(committedLock)) {
    fail(
      "Committed consensus Cargo.lock is missing; run with --refresh-lock using the pinned Kaspa source.",
    );
  } else {
    fs.copyFileSync(committedLock, path.join(tempDir, "Cargo.lock"));
  }

  if (!process.exitCode) {
    const targetDir =
      process.env.CARGO_TARGET_DIR ??
      path.join(root, ".kaspa-x402-consensus-target");
    const result = spawnSync(
      "cargo",
      [
        "run",
        "--locked",
        "--quiet",
        "--manifest-path",
        path.join(tempDir, "Cargo.toml"),
        "--",
        root,
      ],
      {
        cwd: root,
        env: { ...cargoEnvironment, CARGO_TARGET_DIR: targetDir },
        encoding: "utf8",
      },
    );

    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) process.exitCode = result.status ?? 1;
  }
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

if (process.exitCode) process.exit(process.exitCode);

function parseArgs(args) {
  const parsed = {
    kaspaRoot: undefined,
    allowDifferentSource: false,
    refreshLock: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--kaspa-root") {
      parsed.kaspaRoot = args[++index];
    } else if (arg === "--allow-different-source") {
      parsed.allowDifferentSource = true;
    } else if (arg === "--refresh-lock") {
      parsed.refreshLock = true;
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function cargoToml(kaspaRoot) {
  const validatorPath = path
    .join(kaspaRoot, "consensus")
    .replaceAll("\\", "\\\\");
  const consensusPath = path
    .join(kaspaRoot, "consensus/core")
    .replaceAll("\\", "\\\\");
  const hashesPath = path
    .join(kaspaRoot, "crypto/hashes")
    .replaceAll("\\", "\\\\");
  const addressesPath = path
    .join(kaspaRoot, "crypto/addresses")
    .replaceAll("\\", "\\\\");
  const txscriptPath = path
    .join(kaspaRoot, "crypto/txscript")
    .replaceAll("\\", "\\\\");
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
kaspa-addresses = { path = "${addressesPath}" }
kaspa-hashes = { path = "${hashesPath}" }
kaspa-txscript = { path = "${txscriptPath}" }
secp256k1 = { version = "0.29.0", features = ["global-context"] }
`;
}

function isolatedCargoEnvironment(cargoHome) {
  fs.mkdirSync(cargoHome, { recursive: true });
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          key !== "CARGO_HOME" &&
          !key.startsWith("CARGO_REGISTRIES_") &&
          !key.startsWith("CARGO_SOURCE_"),
      ),
    ),
    CARGO_HOME: cargoHome,
  };
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    const message = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    fail(message || `${command} ${args.join(" ")} failed`);
  }
  return result;
}

function gitStatusEntries(repoRoot) {
  const stdout = run("git", [
    "-C",
    repoRoot,
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]).stdout;
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
  return CONSENSUS_SOURCE_PATHS.some(
    (sourcePath) => file === sourcePath || file.startsWith(`${sourcePath}/`),
  );
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
