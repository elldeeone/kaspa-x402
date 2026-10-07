import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { proofFeeSompi } from "./live-proof-fees.mjs";

test("proof fee overrides reject malformed or excessive fees without echoing input", () => {
  const name = "KASPA_X402_TEST_PROOF_FEE";
  const previous = process.env[name];
  try {
    delete process.env[name];
    assert.equal(proofFeeSompi(name, "1000000"), 1_000_000n);
    process.env[name] = "60000000";
    assert.equal(proofFeeSompi(name, "1000000"), 60_000_000n);
    process.env[name] = "10000000";
    assert.equal(proofFeeSompi(name, "1000000", 10_000_000n), 10_000_000n);
    for (const value of ["", "0", "-1", "01", "1.5", "1e6", "10000001", "secret-sentinel"]) {
      process.env[name] = value;
      assert.throws(() => proofFeeSompi(name, "1000000", 10_000_000n), (error) => {
        assert.match(error.message, /positive integer at most 10000000/);
        assert.equal(error.message.includes("secret-sentinel"), false);
        return true;
      });
    }
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
});

test("exact/batch fees preserve the second claim payout and fail before SDK or wallet access", () => {
  const adapterUrl = new URL("./live-adapter-reference.mjs", import.meta.url).href;
  for (const fee of [undefined, "40000000", "40000001", "50000000", "60000000", "100000000"]) {
    const env = { ...process.env, KASPA_X402_KASPA_WASM_MODULE: "" };
    if (fee === undefined) delete env.KASPA_X402_PROOF_FEE_SOMPI;
    else env.KASPA_X402_PROOF_FEE_SOMPI = fee;
    const run = spawnSync(process.execPath, [
      "--input-type=module", "--eval",
      `const { runLiveProof } = await import(${JSON.stringify(adapterUrl)}); await runLiveProof({});`,
    ], { encoding: "utf8", env, timeout: 10_000 });
    assert.ifError(run.error);
    assert.equal(run.status, 1);
    if (fee === undefined || fee === "40000000") {
      assert.match(run.stderr, /KASPA_X402_KASPA_WASM_MODULE is required/);
    } else {
      assert.match(run.stderr, /KASPA_X402_PROOF_FEE_SOMPI must be a positive integer at most 40000000 sompi/);
      assert.doesNotMatch(run.stderr, /KASPA_X402_KASPA_WASM_MODULE is required/);
    }
  }
});

test("hash-chain proof requires an external SDK before creating run artifacts", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kaspa-proof-sdk-"));
  const output = path.join(directory, "run");
  try {
    const run = spawnSync(process.execPath, [
      fileURLToPath(new URL("./proof-hash-chain-testnet.mjs", import.meta.url)),
      "--live", "--wallet-file", path.join(directory, "absent-wallet"),
      "--rpc-url", "ws://127.0.0.1:1", "--output-dir", output,
    ], { encoding: "utf8", env: { ...process.env, KASPA_X402_KASPA_WASM_MODULE: "" } });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /KASPA_X402_KASPA_WASM_MODULE is required/);
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
