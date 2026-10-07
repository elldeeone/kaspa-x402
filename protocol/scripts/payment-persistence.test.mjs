import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { persistExactPaymentAttempt } from "./live-adapter-reference.mjs";

for (const code of ["EPERM", "EISDIR", "EINVAL", "EIO"]) {
  test(`payment file sync failure ${code} prevents publishing the record`, (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "x402-sync-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const error = Object.assign(new Error("injected file sync failure"), { code });
    t.mock.method(fs, "fsyncSync", () => { throw error; });

    assert.throws(
      () => persistExactPaymentAttempt(directory, { attemptId: "ab".repeat(32) }),
      (actual) => actual === error,
    );
    assert.deepEqual(fs.readdirSync(path.join(directory, "exact-payment-attempts")), []);
  });
}

test("payment persistence syncs the file and syncs the directory on POSIX", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "x402-sync-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sync = fs.fsyncSync;
  const synced = [];
  t.mock.method(fs, "fsyncSync", (handle) => {
    synced.push(fs.fstatSync(handle).isDirectory() ? "directory" : "file");
    return sync(handle);
  });
  const record = { attemptId: "ab".repeat(32) };
  persistExactPaymentAttempt(directory, record);
  assert.deepEqual(synced, process.platform === "win32" ? ["file"] : ["file", "directory"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, "exact-payment-attempts", `${record.attemptId}.json`), "utf8")), record);
});

test("POSIX directory sync errors remain fatal", { skip: process.platform === "win32" }, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "x402-sync-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sync = fs.fsyncSync;
  const error = Object.assign(new Error("injected directory sync failure"), { code: "EPERM" });
  t.mock.method(fs, "fsyncSync", (handle) => {
    if (fs.fstatSync(handle).isDirectory()) throw error;
    return sync(handle);
  });
  assert.throws(
    () => persistExactPaymentAttempt(directory, { attemptId: "ab".repeat(32) }),
    (actual) => actual === error,
  );
});
