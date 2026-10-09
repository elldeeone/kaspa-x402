#!/usr/bin/env node
// Offline PR 2 integration proof. Run from any working directory with:
// node scripts/verify-atomic-durable-state.mjs
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = join(root, "verification", "atomic-durable-state.json");
const files = [
  "protocol/packages/core/test/chain-truth.test.ts",
  "protocol/packages/client/test/direct-client.test.ts",
  "protocol/packages/adapters/test/adapters.test.ts",
  "protocol/packages/server/test/direct-server.test.ts",
  "protocol/packages/server/test/public-boundary.test.ts",
  "protocol/packages/server/test/server-state-store-contract.test.ts",
  "packages/demo-gateway/test/gateway.test.ts",
  "packages/demo-gateway/test/state.test.ts",
  "packages/demo-gateway/test/remote-state.test.ts",
];
const args = ["exec", "--", "vitest", "run", ...files, "--reporter=dot"];
const run = spawnSync("npm", args, {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
  timeout: 180_000,
});
const git = (...args) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trimEnd();
};
const hash = (value) => createHash("sha256").update(value).digest("hex");
const stdout = run.stdout ?? "";
const stderr = run.stderr ?? "";
const baseCommit = git("merge-base", "HEAD", "origin/main");
const artifact = {
  schema: "kaspa-x402-atomic-durable-state-offline-proof/v1",
  generatedAtUtc: new Date().toISOString(),
  branch: git("branch", "--show-current"),
  baseCommit,
  trackedDiffSha256: hash(git(
    "diff", "--binary", baseCommit, "--", ".",
    ":(exclude)verification/atomic-durable-state.json",
  )),
  verifierSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
  command: ["npm", ...args],
  exitCode: run.status,
  signal: run.signal,
  stdoutSha256: hash(stdout),
  stderrSha256: hash(stderr),
  stdout,
  stderr,
  scope: "Offline component integration with deterministic fake chain and Durable Object state; no funded Testnet operation.",
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
process.stdout.write(`${outputPath}\nsha256 ${hash(readFileSync(outputPath))}\n`);
if (run.error) throw run.error;
if (run.status !== 0) process.exitCode = 1;
