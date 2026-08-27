import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  sanitizeProofOutputText,
  stringifySanitizedProofOutput,
} from "./proof-output-security.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("scrubs nested raw, embedded, encoded, and known-secret values", () => {
  const privateKey = "ab".repeat(32);
  const url =
    "wss://user-sentinel:password-sentinel@rpc-secret.example/secret-path?token=query-secret#fragment-secret";
  const output = stringifySanitizedProofOutput(
    {
      node: { rpcUrl: url },
      [url]: "URL-shaped object keys are scrubbed too",
      error: `failed via ${url}.`,
      encoded: encodeURIComponent(url),
      derived: {
        username: "user-sentinel",
        password: "password-sentinel",
        path: "secret-path",
        query: "query-secret",
        fragment: "fragment-secret",
        base64Password: Buffer.from("password-sentinel").toString("base64"),
        base64Url: Buffer.from(url).toString("base64"),
        escapedUrl: url.replaceAll("/", "\\/"),
      },
      privateKey,
      transactionId: "12".repeat(32),
    },
    { secrets: [url, privateKey] },
  );

  for (const secret of [
    "user-sentinel",
    "password-sentinel",
    "rpc-secret.example",
    "secret-path",
    "query-secret",
    "fragment-secret",
    privateKey,
    encodeURIComponent(url),
  ]) {
    assert.equal(output.includes(secret), false, secret);
  }
  assert.match(output, /<redacted>/);
  assert.match(output, new RegExp("12".repeat(32)));
});

test("keeps clean public origins while removing token-bearing URL details", () => {
  const clean = "https://gateway.example/";
  const tokenBearing =
    "https://user-sentinel:password-sentinel@gateway.example/token-path?token=query-secret#fragment-secret";
  const output = stringifySanitizedProofOutput({ clean, tokenBearing });

  assert.match(output, /https:\/\/gateway\.example\//);
  assert.equal(output.includes("user-sentinel"), false);
  assert.equal(output.includes("password-sentinel"), false);
  assert.equal(output.includes("token-path"), false);
  assert.equal(output.includes("query-secret"), false);
  assert.equal(output.includes("fragment-secret"), false);
});

test("live proof scrubs output and restricts report and recovery permissions", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "kaspa-x402-proof-output-"),
  );
  try {
    const reportFile = path.join(directory, "report.json");
    const recoveryFile = path.join(directory, "recovery.json");
    fs.writeFileSync(reportFile, "stale\n", { mode: 0o644 });
    fs.writeFileSync(recoveryFile, "stale\n", { mode: 0o644 });
    const rpcUrl =
      "wss://user:password@rpc.example/token-path?token=query-secret#fragment-secret";
    const fundingWallet = `wallet-key:${path.join(directory, "secret.key")}`;
    const run = spawnSync(
      process.execPath,
      [
        "scripts/proof-live-testnet.mjs",
        "--check",
        "--write-report",
        "--allow-blocked",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          KASPA_X402_RPC_URL: rpcUrl,
          KASPA_X402_FUNDING_WALLET: fundingWallet,
          KASPA_X402_LIVE_ADAPTER_MODULE: "",
          KASPA_X402_REPORT_FILE: reportFile,
          KASPA_X402_RECOVERY_FILE: recoveryFile,
        },
      },
    );

    assert.equal(run.status, 0, run.stderr);
    const combined = [
      run.stdout,
      run.stderr,
      fs.readFileSync(reportFile, "utf8"),
      fs.readFileSync(recoveryFile, "utf8"),
    ].join("\n");
    for (const secret of [rpcUrl, fundingWallet, "password", "query-secret"]) {
      assert.equal(combined.includes(secret), false, secret);
    }
    assert.equal(fs.statSync(reportFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(recoveryFile).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("malformed config errors do not echo credential-bearing lines", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "kaspa-x402-proof-config-"),
  );
  try {
    const secretUrl =
      "wss://user:password@rpc.example/token-path?token=query-secret";
    const envFile = path.join(directory, "proof.env");
    fs.writeFileSync(envFile, `${secretUrl}\n`, { mode: 0o600 });
    const run = spawnSync(
      process.execPath,
      ["scripts/proof-live-testnet.mjs", "--config-file", envFile],
      { cwd: root, encoding: "utf8" },
    );

    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /invalid env file line 1/);
    assert.equal(run.stderr.includes(secretUrl), false);
    assert.equal(run.stderr.includes("password"), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("malformed hosted gateway URLs fail without echoing credentials", () => {
  const gatewayUrl =
    "https://user-sentinel:password-sentinel@[invalid/token-path?token=query-secret";
  const run = spawnSync(process.execPath, ["scripts/proof-hosted-exact.mjs"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      KASPA_X402_DEMO_GATEWAY_URL: gatewayUrl,
    },
  });

  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /configured gateway URL is invalid or unsafe/);
  for (const secret of [
    gatewayUrl,
    "user-sentinel",
    "password-sentinel",
    "token-path",
    "query-secret",
  ]) {
    assert.equal(run.stderr.includes(secret), false, secret);
  }
});

test("plain non-URL diagnostics remain unchanged", () => {
  assert.equal(
    sanitizeProofOutputText("transaction accepted at DAA 123"),
    "transaction accepted at DAA 123",
  );
});
