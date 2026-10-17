// E2E at the release-validator CLI: valid fixtures pass; a correctly signed,
// consensus-valid low-fee vector must fail specifically at upstream relay policy.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { schnorr } from "@noble/curves/secp256k1.js";
import { buildBatchGenesisTxV1Artifact, transactionV1Sighash } from "@kaspa-x402/covenant";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
assert.equal(args[0], "--out", "usage: proof-vector-relay-policy-e2e.mjs --out <report.json>");
assert.equal(args.length, 2);
for (const name of ["KASPA_X402_GENERATE_EXACT_VECTORS", "KASPA_X402_GENERATE_HASH_CHAIN_VECTORS"]) {
  assert.notEqual(process.env[name], "1", "release proof must compare the committed golden vectors");
}
const out = path.resolve(args[1]);
fs.mkdirSync(path.dirname(out), { recursive: true });
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
const sha256 = value => createHash("sha256").update(value).digest("hex");
const report = { kind: "vector-relay-policy-e2e", ok: false, cases: [] };
const run = extra => spawnSync(process.execPath, [path.join(root, "scripts/validate-tx-v1-consensus.mjs"), ...extra], {
  cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
});
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kaspa-x402-low-fee-vector-"));
try {
  const good = run([]);
  fs.writeFileSync(out + ".consensus.json", good.stdout);
  fs.writeFileSync(out + ".consensus.stderr.log", good.stderr);
  assert.equal(good.status, 0, good.stderr || String(good.error));
  const consensus = JSON.parse(good.stdout);
  const policies = [];
  function collect(value, location = "") {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const name = location ? `${location}.${key}` : key;
      if (key === "relayPolicy") {
        if (child.status) policies.push({ path: name, ...child });
        else for (const [profile, policy] of Object.entries(child)) policies.push({ path: `${name}.${profile}`, ...policy });
      } else collect(child, name);
    }
  }
  collect(consensus);
  const required = [
    ...Array.from({ length: 5 }, (_, i) => `vectors.${i}.validation.relayPolicy`),
    ...["standardNative", "additive"].map(name => `exactProfiles.relayPolicy.${name}`),
    ...["genesis", "borrow1", "borrow2", "smallTopUp", "ownerRotation", "postRotationBorrow", "ownerSweep"]
      .map(name => `hashChain.transactions.${name}.relayPolicy`),
    ...Array.from({ length: 36 }, (_, i) => `hashChain.sighashModes.${i}.relayPolicy`),
    ...Array.from({ length: 38 }, (_, i) => `sighashScopes.transactions.${i}.relayPolicy`),
    ...Array.from({ length: 36 }, (_, i) => `sighashScopes.mixedTopUps.${i}.relayPolicy`),
  ];
  assert.deepEqual(policies.map(policy => policy.path).sort(), required.sort(),
    "relay evidence must cover every profile, batch operation and positive signature-scope case");
  for (const policy of policies) {
    assert.equal(policy.status, "accepted", policy.path);
    assert.ok(BigInt(policy.feeSompi) >= BigInt(policy.minimumFeeSompi), policy.path);
    assert.equal(policy.feeFieldControls.exactFloor, "accepted", policy.path);
    assert.match(policy.feeFieldControls.floorMinusOne, /under the required amount/, policy.path);
  }
  report.source = consensus.source;
  report.consensusSha256 = sha256(good.stdout);
  report.policies = policies;
  report.cases.push({ name: "all positive vectors pass consensus and default node relay policy", passed: true });

  // Generate via public builders and sign again; an invalid signature would
  // fail earlier and cannot satisfy this negative control.
  const vector = JSON.parse(fs.readFileSync(path.join(root, "vectors/tx-v1/batch-genesis.json")));
  const input = structuredClone(vector.input);
  input.fee = "1000";
  input.fundingInputs[0].amount = (BigInt(input.escrowAmount) + 1000n).toString();
  delete input.mass;
  input.fundingInputs[0].signature = "00".repeat(64);
  input.mass = buildBatchGenesisTxV1Artifact(input).transaction.mass;
  const unsigned = buildBatchGenesisTxV1Artifact(input);
  input.fundingInputs[0].signature = Buffer.from(schnorr.sign(
    Buffer.from(transactionV1Sighash(unsigned.transaction, 0).digest, "hex"),
    new Uint8Array(32).fill(7), new Uint8Array(32),
  )).toString("hex");
  vector.input = input;
  vector.expected = buildBatchGenesisTxV1Artifact(input);
  const fixture = path.join(temp, "vectors/tx-v1/batch-genesis.json");
  fs.mkdirSync(path.dirname(fixture), { recursive: true });
  write(fixture, vector);
  write(out + ".low-fee-vector.json", vector);
  const bad = run(["--fixture-root", temp]);
  fs.writeFileSync(out + ".low-fee.stderr.log", bad.stderr);
  assert.notEqual(bad.status, 0, "release validator accepted a low-fee fixture");
  assert.match(bad.stderr, /consensus-valid fixture fails default node relay policy/);
  assert.match(bad.stderr, /1000 fees.*required amount of 167100 for compute mass 1671/);
  report.cases.push({ name: "correctly signed low-fee vector fails specifically at relay policy", passed: true,
    transactionId: vector.expected.transactionId, error: bad.stderr.trim() });
  report.ok = true;
} catch (error) {
  report.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
  write(out, report);
}
console.log(JSON.stringify({ ok: report.ok, cases: report.cases.length, policyChecks: report.policies?.length, report: out }));
