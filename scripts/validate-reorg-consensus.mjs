#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const input = process.argv[2] ?? process.env.KASPA_X402_KASPA_CONSENSUS_ROOT;
if (!input) throw new Error("Pass the pinned canonical Rusty Kaspa checkout path.");
const kaspa = fs.realpathSync(input);
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed`);
  return result.stdout.trim();
}
const commit = "c338d495bec29e4dc8b5149f99e8db6fa916ed4a";
if (run("git", ["-C", kaspa, "rev-parse", "HEAD"]) !== commit)
  throw new Error(`Expected canonical consensus commit ${commit}`);
if (fs.realpathSync(run("git", ["-C", kaspa, "rev-parse", "--show-toplevel"])) !== kaspa)
  throw new Error("Pass the Git checkout root.");
if (run("git", ["-C", kaspa, "status", "--porcelain", "--untracked-files=all"]))
  throw new Error("Canonical checkout must be clean, including untracked files.");
if (run("git", ["-C", kaspa, "ls-files", "-v"]).split("\n").some((line) => !line.startsWith("H ")))
  throw new Error("Canonical checkout has special index state.");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "x402-reorg-consensus-"));
try {
  fs.mkdirSync(path.join(temporary, "src"));
  fs.copyFileSync(path.join(root, "tools/reorg-consensus/src/main.rs"), path.join(temporary, "src/main.rs"));
  const dependencies = { "kaspa-consensus": "consensus", "kaspa-consensus-core": "consensus/core", "kaspa-addresses": "crypto/addresses", "kaspa-hashes": "crypto/hashes", "kaspa-txscript": "crypto/txscript" };
  fs.writeFileSync(path.join(temporary, "Cargo.toml"), `[package]
name = "kaspa-x402-reorg-consensus-check"
version = "0.0.0"
edition = "2024"
publish = false
[dependencies]
anyhow = "1"
hex = "0.4"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
secp256k1 = { version = "0.29.0", features = ["global-context"] }
tokio = { version = "1", features = ["rt", "macros"] }
${Object.entries(dependencies).map(([name, sub]) => `${name} = { path = ${JSON.stringify(path.join(kaspa, sub))} }`).join("\n")}
`);
  // Share the oracle's exact dependency versions; only the executable package differs.
  const lock = fs.readFileSync(path.join(root, "tools/tx-v1-consensus/Cargo.lock"), "utf8").replace(/name = "kaspa-x402-tx-v1-consensus-check"([\s\S]*?)\n\]/, 'name = "kaspa-x402-reorg-consensus-check"$1\n "tokio",\n]');
  fs.writeFileSync(path.join(temporary, "Cargo.lock"), lock);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "CARGO_HOME" && !key.startsWith("CARGO_REGISTRIES_") && !key.startsWith("CARGO_SOURCE_")));
  environment.CARGO_HOME = process.env.KASPA_X402_CONSENSUS_CARGO_HOME ?? path.join(root, ".kaspa-x402-consensus-cargo-home");
  environment.CARGO_TARGET_DIR = process.env.CARGO_TARGET_DIR ?? path.join(root, ".kaspa-x402-consensus-target");
  const result = spawnSync("cargo", ["run", "--locked", "--quiet", "--manifest-path", path.join(temporary, "Cargo.toml")], { cwd: root, env: environment, stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
