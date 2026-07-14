#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizedBaseUrl } from "./demo-exact-heads.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

assert.throws(
  () => normalizedBaseUrl("http://example.com"),
  /non-loopback HTTP/,
);
assert.equal(
  normalizedBaseUrl("http://127.0.0.1:8787"),
  "http://127.0.0.1:8787/",
);
assert.equal(normalizedBaseUrl("http://[::1]:8787"), "http://[::1]:8787/");
assert.equal(
  normalizedBaseUrl("https://demo.kaspa-x402.org"),
  "https://demo.kaspa-x402.org/",
);

const argvSecret = spawnSync(
  process.execPath,
  [
    "scripts/demo-exact-heads.mjs",
    "stats",
    "--admin-token",
    "must-not-be-used",
  ],
  {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, KASPA_X402_DEMO_ADMIN_TOKEN: "" },
  },
);
assert.notEqual(argvSecret.status, 0);
assert.match(argvSecret.stderr, /--admin-token is not accepted/);

console.log("admin CLI transport and secret handling ok");
