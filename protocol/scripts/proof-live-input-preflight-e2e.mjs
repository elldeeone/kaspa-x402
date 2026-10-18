// Real reference-adapter entry point, real file inputs. No wallet or RPC is
// available: incomplete proof bundles must fail before trying either.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
assert.equal(args[0], "--out");
assert.equal(args.length, 2);
const out = path.resolve(args[1]);
fs.mkdirSync(path.dirname(out), { recursive: true });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "live-input-preflight-"));
const report = { kind: "live-input-preflight-e2e", ok: false, cases: [] };
try {
  fs.cpSync(path.join(root, "scripts"), path.join(temporary, "scripts"), { recursive: true });
  fs.symlinkSync(path.join(root, "packages"), path.join(temporary, "packages"), "junction");
  // Root workspaces and standalone protocol installs keep dependencies in
  // different directories. Resolve the actual workspace installation instead
  // of inheriting dependencies from the report directory's ancestors.
  const dependencies = createRequire(import.meta.url).resolve.paths("@kaspa-x402/core")
    .find(directory => ["core", "client", "covenant", "server"].every(name =>
      fs.existsSync(path.join(directory, "@kaspa-x402", name))));
  assert.ok(dependencies, "installed protocol dependencies are required");
  fs.symlinkSync(dependencies, path.join(temporary, "node_modules"), "junction");
  fs.mkdirSync(path.join(temporary, "vectors/tx-v1"), { recursive: true });
  fs.writeFileSync(path.join(temporary, "invoke.mjs"), `
import { runLiveProof } from './scripts/live-adapter-reference.mjs';
await runLiveProof({ network: 'kaspa:testnet-10', fundingWallet: 'unavailable-wallet', dataDir: 'must-not-be-created' });
`);
  for (const missing of ["claim", "top-up", "refund"]) {
    for (const name of ["claim", "top-up", "refund"]) {
      const target = path.join(temporary, `vectors/tx-v1/batch-${name}.json`);
      if (name === missing) fs.rmSync(target, { force: true });
      else fs.copyFileSync(path.join(root, `vectors/tx-v1/batch-${name}.json`), target);
    }
    const result = spawnSync(process.execPath, ["invoke.mjs"], {
      cwd: temporary, encoding: "utf8",
      env: { ...process.env, KASPA_X402_KASPA_WASM_MODULE: path.join(temporary, "unavailable-sdk") },
    });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(`missing v1 RC2 consensus vector vectors/tx-v1/batch-${missing}.json`), result.stderr);
    assert.ok(!fs.existsSync(path.join(temporary, "must-not-be-created")), "proof touched wallet output before checking inputs");
    report.cases.push({ name: `missing batch-${missing} rejected before SDK or wallet access`, passed: true });
  }
  report.ok = true;
} catch (error) {
  report.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
}
console.log(JSON.stringify({ ok: report.ok, cases: report.cases.length, report: out }));
