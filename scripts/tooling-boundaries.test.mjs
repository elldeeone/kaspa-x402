import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";
import { readPrivateKeyFile, writePrivateKeyFile } from "./private-key-files.mjs";
import { download, sha256File } from "./archive-download.mjs";

const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), "tooling-boundary-"));

test("key files reject unsafe permissions, links, non-files and overwrite", () => {
  const dir = temporary();
  const file = path.join(dir, "key");
  try {
    writePrivateKeyFile(file, "secret\n");
    assert.equal(readPrivateKeyFile(file), "secret");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.throws(() => writePrivateKeyFile(file, "replacement"));
    fs.symlinkSync(file, path.join(dir, "link"));
    assert.throws(() => readPrivateKeyFile(path.join(dir, "link")));
    assert.throws(() => readPrivateKeyFile(dir));
    fs.chmodSync(file, 0o644);
    assert.throws(() => readPrivateKeyFile(file));
    fs.chmodSync(file, 0o600);
    fs.chmodSync(dir, 0o755);
    assert.throws(() => readPrivateKeyFile(file));
    assert.throws(() => writePrivateKeyFile(path.join(dir, "new"), "secret"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function getResponse({ statusCode = 200, location, chunks = [Buffer.from("abc")], stalled = false, broken = false } = {}) {
  return (_url, { signal }, callback) => {
    const request = new EventEmitter();
    const response = stalled ? new Readable({ read() {} }) : Readable.from(chunks);
    response.statusCode = statusCode;
    response.headers = location ? { location } : {};
    const abort = () => { response.destroy(signal.reason); request.emit("error", signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    response.on("close", () => signal.removeEventListener("abort", abort));
    queueMicrotask(() => { callback(response); if (broken) response.destroy(new Error("response failed")); });
    return request;
  };
}

test("archive streams enforce size, HTTPS, redirect and deadline bounds and clean failures", async () => {
  const dir = temporary();
  try {
    const target = path.join(dir, "archive");
    await download("https://archive.example/file", target, { get: getResponse() });
    assert.equal(await sha256File(target), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    await assert.rejects(sha256File(target, 2), /size limit/);
    fs.unlinkSync(target);
    for (const options of [
      { get: getResponse(), maximumBytes: 2 },
      { get: getResponse({ statusCode: 302, location: "http://unsafe.example/file" }) },
      { get: getResponse({ statusCode: 302, location: "/again" }) },
      { get: getResponse({ statusCode: 500 }) },
      { get: getResponse({ broken: true }) },
      { get: getResponse({ stalled: true }), timeoutMs: 15 },
    ]) {
      const timer = setTimeout(() => {}, 1000);
      try { await assert.rejects(download("https://archive.example/file", target, options)); }
      finally { clearTimeout(timer); }
      assert.deepEqual(fs.readdirSync(dir), []);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
