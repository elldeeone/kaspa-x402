import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_PACKAGES = ["@kaspa-x402/core", "@kaspa-x402/covenant", "@kaspa-x402/client", "@kaspa-x402/server"];

const args = ["pack", "--dry-run", "--json", ...PUBLIC_PACKAGES.flatMap((name) => ["--workspace", name])];
const result = spawnSync("npm", args, {
  cwd: root,
  encoding: "utf8",
});

if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.stderr.write(result.stdout);
  process.exit(result.status ?? 1);
}

let packed;
try {
  packed = JSON.parse(result.stdout);
} catch (error) {
  process.stderr.write(result.stdout);
  throw new Error(`npm pack did not emit JSON: ${error instanceof Error ? error.message : String(error)}`);
}

if (!Array.isArray(packed)) throw new Error("npm pack output must be a JSON array");
const names = packed.map((entry) => entry?.name).sort();
const expected = [...PUBLIC_PACKAGES].sort();
if (JSON.stringify(names) !== JSON.stringify(expected)) {
  throw new Error(`unexpected packed workspaces: expected ${expected.join(", ")}, got ${names.join(", ")}`);
}

console.log(JSON.stringify(packed, null, 2));
