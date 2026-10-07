import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
if (process.argv.slice(2).some((arg) => arg !== "--check")) throw new Error("usage: generate-sighash-consensus-vectors.mjs [--check]");
const oracle = JSON.parse(execFileSync(process.execPath, [path.join(root, "scripts/validate-tx-v1-consensus.mjs")], {
  cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
}));
const value = { kind: "kaspa-sighash-consensus-v1", source: oracle.source, ...oracle.sighashScopes };
const output = path.join(root, "vectors/sighash/consensus.json");
const serialized = `${JSON.stringify(value, null, 2)}\n`;
if (check) {
  if (fs.readFileSync(output, "utf8") !== serialized) throw new Error("sighash consensus vector is stale");
} else {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, serialized);
}
console.log(`${check ? "verified" : "wrote"} vectors/sighash/consensus.json`);
