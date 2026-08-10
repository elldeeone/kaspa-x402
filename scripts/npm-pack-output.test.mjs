import assert from "node:assert/strict";
import test from "node:test";

import { normalizeNpmPackOutput } from "./npm-pack-output.mjs";

test("accepts the legacy npm pack array shape", () => {
  const records = [{ name: "@kaspa-x402/core" }];
  assert.deepEqual(normalizeNpmPackOutput(records), records);
});

test("accepts the npm 12 keyed workspace shape", () => {
  const record = { name: "@kaspa-x402/core" };
  assert.deepEqual(normalizeNpmPackOutput({ "@kaspa-x402/core": record }), [
    record,
  ]);
});

test("rejects empty or non-record output", () => {
  assert.throws(() => normalizeNpmPackOutput([]), /did not contain/);
  assert.throws(() => normalizeNpmPackOutput({}), /did not contain/);
  assert.throws(() => normalizeNpmPackOutput(null), /was not an array/);
  assert.throws(
    () => normalizeNpmPackOutput({ "@kaspa-x402/core": null }),
    /invalid record/,
  );
});

test("rejects a keyed record whose package name differs", () => {
  assert.throws(
    () =>
      normalizeNpmPackOutput({
        "@kaspa-x402/core": { name: "@kaspa-x402/client" },
      }),
    /did not match package name/,
  );
});
