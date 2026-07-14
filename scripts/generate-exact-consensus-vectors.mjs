import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync(process.execPath, [path.join(root, "scripts/validate-tx-v1-consensus.mjs")], {
  cwd: root,
  env: { ...process.env, KASPA_X402_GENERATE_EXACT_VECTORS: "1" },
  encoding: "utf8",
});

if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout || "exact consensus oracle failed\n");
  process.exit(result.status ?? 1);
}

const oracle = JSON.parse(result.stdout);
const vector = {
  kind: "exact-consensus-profiles",
  description:
    "Deterministic standard-native v0 and corrected KIP-10 additive v1 transactions validated by the full Rusty Kaspa isolation and populated-UTXO consensus paths.",
  validation: {
    status: "full-consensus-cross-validated",
    tool: "kaspa-consensus",
    toolVersion: oracle.source.version,
    sourceCommit: oracle.source.commit,
    command: "KASPA_X402_KASPA_CONSENSUS_ROOT=<kaspa-consensus-checkout> npm run validate:tx-v1-consensus",
  },
  expected: oracle.exactProfiles,
};

const output = path.join(root, "vectors/exact/consensus-profiles.json");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(vector, null, 2)}\n`);
console.log(`wrote ${path.relative(root, output)}`);
