import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(directory, "../manifest.json")));
const cases = [];
for (const name of ["paid-http-api", "paid-mcp-tool", "self-hosted-facilitator", "recovery"]) {
  const result = spawnSync(process.execPath, [path.join(directory, "source", name, "index.mjs")], {
    cwd: directory, encoding: "utf8", timeout: 30_000,
  });
  fs.writeFileSync(path.join(directory, `${name}.log`), (result.stdout ?? "") + (result.stderr ?? ""));
  assert.equal(result.status, 0, `${name} did not complete`);
  const output = JSON.parse(result.stdout);
  if (name === "paid-http-api") {
    assert.equal(output.exact.status, 200);
    assert.equal(output.exact.settlement, true);
    assert.equal(output.batch.firstOpenedChannel, true);
    assert.equal(output.batch.secondOpenedChannel, false);
    assert.equal(output.batch.firstChargedAmount, "50000");
    assert.equal(output.batch.secondChargedAmount, "50000");
  } else if (name === "paid-mcp-tool") {
    assert.equal(output.paid, true);
    assert.equal(output.metadataPresent, true);
    assert.equal(output.chargedAmount, "250000");
  } else if (name === "self-hosted-facilitator") {
    assert.deepEqual(output.supportedKinds.sort(), ["batch-settlement:kaspa:testnet-10", "exact:kaspa:testnet-10"]);
    assert.equal(output.verify.isValid, true);
    assert.equal(output.settle.success, true);
  } else {
    assert.equal(output.exactReplay.isValid, false);
    assert.equal(output.fresh402.voucherRemainsClientLocal, true);
    assert.equal(output.refundPreview.refundableChannels, 1);
    assert.equal(output.refundPreview.refundAmount, "4000000");
  }
  cases.push({ name, passed: true, output });
}
const report = { revision: manifest.revision, cases,
  evidenceBoundary: "Documented mock examples with installed public archives and explicit private facilitator source-support archive. No live settlement." };
fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ passed: cases.length, failed: 0 }));
