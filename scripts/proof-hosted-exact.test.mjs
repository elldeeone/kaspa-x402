import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
