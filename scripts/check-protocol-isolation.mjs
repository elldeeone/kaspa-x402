import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "protocol");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kaspa-x402-protocol-"));
const excluded = new Set([
  "node_modules", "dist", "coverage", ".git", ".env", ".DS_Store",
]);
try {
  fs.cpSync(source, temporary, {
    recursive: true,
    filter: file => !path.relative(source, file).split(path.sep).some(part =>
      excluded.has(part) || part.startsWith(".env.") || part.startsWith(".kaspa-x402-") || part.endsWith(".log")),
  });
  console.log(`Verifying standalone protocol workspace in ${temporary}`);
  const env = { ...process.env };
  delete env.NODE_PATH;
  for (const args of [["ci", "--no-audit", "--no-fund"], ["run", "verify"]]) {
    const result = spawnSync("npm", args, { cwd: temporary, env, stdio: "inherit", shell: process.platform === "win32" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Standalone npm ${args.join(" ")} failed (${result.status ?? result.signal}).`);
  }
  console.log("Standalone protocol install, build and verification passed.");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
