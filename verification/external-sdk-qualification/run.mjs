import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json")));
const digest = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
for (const [name, pkg] of Object.entries(manifest.packages)) {
  assert.equal(digest(path.join(directory, "archives", pkg.file)), pkg.sha256);
  assert.equal(fs.lstatSync(path.join(directory, "node_modules", name)).isSymbolicLink(), false);
}
for (const [file, expected] of Object.entries(manifest.harnesses))
  assert.equal(digest(path.join(directory, file)), expected, `harness changed: ${file}`);
const scripts = ["examples/qualify.mjs", "standard/proof.mjs", "standard/crypto-mcp.mjs", "standard/crypto-stress.mjs",
  "standard/mcp-http.mjs", "additive/run.mjs", "hash-chain/qualify.mjs",
  "hash-chain/stress.mjs", "batch/qualify.mjs"];
const results = [];
const env = { ...process.env };
for (const name of ["NODE_PATH", "NODE_OPTIONS", "KASPA_X402_RPC_URL", "KASPA_X402_FUNDING_WALLET"])
  delete env[name];
for (const script of scripts) {
  const result = spawnSync(process.execPath, [path.join(directory, script)], {
    cwd: directory, env, encoding: "utf8", timeout: 300_000,
  });
  fs.writeFileSync(path.join(directory, script.replaceAll("/", "-") + ".log"),
    (result.stdout ?? "") + (result.stderr ?? ""));
  const outcome = { script, exitCode: result.status, signal: result.signal,
    error: result.error?.message };
  results.push(outcome);
  console.log(JSON.stringify(outcome));
}
const report = { revision: manifest.revision, node: process.version,
  archiveManifestSha256: digest(path.join(directory, "manifest.json")),
  status: results.every(result => result.exitCode === 0) ? "passed" : "failed",
  results, evidenceBoundary: "External archive consumer; controlled chain stress, not funded or production load evidence." };
fs.writeFileSync(path.join(directory, "qualification-report.json"), JSON.stringify(report, null, 2) + "\n");
if (report.status !== "passed") process.exitCode = 1;
