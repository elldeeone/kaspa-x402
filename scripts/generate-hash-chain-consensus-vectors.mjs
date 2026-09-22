#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
if (process.argv.slice(2).some((arg) => arg !== "--check")) {
  throw new Error("usage: generate-hash-chain-consensus-vectors.mjs [--check]");
}
const result = spawnSync(process.execPath, [path.join(root, "scripts/validate-tx-v1-consensus.mjs")], {
  cwd: root,
  env: { ...process.env, KASPA_X402_GENERATE_HASH_CHAIN_VECTORS: "1" },
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout || "hash-chain consensus oracle failed\n");
  process.exit(result.status ?? 1);
}
const oracle = JSON.parse(result.stdout);
const vector = {
  kind: "native-kas-hash-chain-consensus-v1",
  description: "Deterministic KCC20 hash-chain adaptation: genesis, two signed borrows, owner rotation, recovery, and negative cases under pinned Rusty-Kaspa full consensus.",
  validation: {
    status: "full-consensus-cross-validated",
    tool: "kaspa-consensus",
    toolVersion: oracle.source.version,
    sourceCommit: oracle.source.commit,
    command: "KASPA_X402_KASPA_CONSENSUS_ROOT=<pinned-kaspa-checkout> npm run validate:tx-v1-consensus",
  },
  expected: oracle.hashChain,
};
const output = path.join(root, "vectors/hash-chain/consensus-v1.json");
const serialized = `${JSON.stringify(vector, null, 2)}\n`;
if (check) {
  if (!fs.existsSync(output) || fs.readFileSync(output, "utf8") !== serialized) {
    throw new Error("hash-chain consensus vector is stale; run npm run vectors:hash-chain-consensus");
  }
  console.log(`verified ${path.relative(root, output)}`);
} else {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, serialized);
  console.log(`wrote ${path.relative(root, output)}`);
}
