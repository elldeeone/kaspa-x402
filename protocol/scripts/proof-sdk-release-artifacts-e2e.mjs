#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { normalizeNpmPackOutput } from "./npm-pack-output.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
assert.equal(args.length, 2, "usage: proof-sdk-release-artifacts-e2e.mjs --out <report.json>");
assert.equal(args[0], "--out");
const output = path.resolve(args[1]);
fs.mkdirSync(path.dirname(output), { recursive: true });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "release-proof-"));
const records = [];
let releaseFixture;
const uploads = [];
const published = new Map();
let registryFault;
const server = http.createServer((request, response) => {
  const name = decodeURIComponent(request.url.slice(1));
  if (request.method === "PUT") {
    let body = ""; request.on("data", b => { body += b; });
    request.on("end", () => {
      const doc = JSON.parse(body), attachment = Object.values(doc._attachments)[0];
      const bytes = Buffer.from(attachment.data, "base64");
      published.set(doc.name, { doc, bytes }); uploads.push({ name: doc.name, sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
      response.writeHead(201, { "content-type": "application/json" }); response.end('{"ok":true}');
    }); return;
  }
  if (request.method === "GET") {
    const entry = published.get(name);
    if (entry) {
      const doc = structuredClone(entry.doc);
      if (registryFault === "metadata") for (const pkg of Object.values(doc.versions)) pkg.dist.integrity = "sha512-WRONG";
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(doc)); return;
    }
    for (const value of published.values()) for (const pkg of Object.values(value.doc.versions)) {
      if (new URL(pkg.dist.tarball).pathname === request.url) {
        response.writeHead(200, { "content-type": "application/octet-stream" }); response.end(registryFault === "bytes" ? Buffer.from("SUBSTITUTED_REGISTRY_ARCHIVE") : value.bytes); return;
      }
    }
  }
  request.resume(); response.writeHead(404, { "content-type": "application/json" }); response.end('{"error":"not_found"}');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const registry = `http://127.0.0.1:${server.address().port}/`;
const home = path.join(temporary, "home"); fs.mkdirSync(home);
const userconfig = path.join(home, "npmrc");
fs.writeFileSync(userconfig, `registry=${registry}\n//127.0.0.1:${server.address().port}/:_authToken=LOCAL_PROOF_ONLY\n`);
const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home,
  ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
  NPM_CONFIG_USERCONFIG: userconfig, NPM_CONFIG_GLOBALCONFIG: path.join(home, "empty-npmrc"),
  NPM_CONFIG_CACHE: path.join(home, "cache"), NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false" };
fs.writeFileSync(env.NPM_CONFIG_GLOBALCONFIG, "");
function run(command, argv, cwd, extra = {}) {
  return new Promise(resolve => {
    const child = spawn(command, argv, { cwd, env: { ...env, ...extra }, shell: process.platform === "win32" && command === "npm" });
    let stdout = "", stderr = "";
    const timeout = setTimeout(() => child.kill(), 120000);
    child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
    child.on("error", error => { clearTimeout(timeout); resolve({ code: null, stdout, stderr: error.message }); });
    child.on("close", code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
  });
}
function fixture(name, pkg) {
  const protocol = path.join(temporary, name); const directory = path.join(protocol, "packages", pkg);
  fs.mkdirSync(path.join(protocol, "scripts"), { recursive: true });
  fs.cpSync(path.join(root, "packages", pkg), directory, { recursive: true, filter: f => !f.split(path.sep).includes("node_modules") });
  fs.copyFileSync(path.join(root, "scripts/assert-package-dist.mjs"), path.join(protocol, "scripts/assert-package-dist.mjs"));
  return directory;
}
async function check(name, callback) {
  try { records.push({ name, passed: true, evidence: await callback() }); }
  catch (error) { records.push({ name, passed: false, error: error.message }); }
}
function inspect(bundle, digest) {
  return run(process.execPath, [path.join(root, "scripts/inspect-sdk-release.mjs"), "--bundle", bundle,
    "--revision", releaseFixture.revision, "--manifest-sha256", digest], temporary);
}
try {
  await check("stale directory output cannot be published as reviewed SDK code", async () => {
    const directory = fixture("stale", "core");
    fs.writeFileSync(path.join(directory, "dist/index.js"), 'export const substituted = "STALE_DIST_PROOF";\n');
    const result = await run("npm", ["publish", "--dry-run", "--registry", registry], directory);
    assert.notEqual(result.code, 0, "directory publication accepted substituted dist");
    assert.match(result.stderr + result.stdout, /approved.*tarball|release.*artifact/i);
    return { rejected: true };
  });
  await check("missing server subpath export fails local package inspection", async () => {
    const directory = fixture("missing-export", "server");
    fs.rmSync(path.join(directory, "dist/hash-chain-grants.js"));
    const result = await run("npm", ["pack", "--dry-run", "--json"], directory);
    assert.notEqual(result.code, 0, "index-only check accepted a missing public export");
    return { rejected: true };
  });
  await check("legitimate local package inspection needs no Git history", async () => {
    const directory = fixture("control", "server");
    const result = await run("npm", ["pack", "--dry-run", "--json"], directory);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(normalizeNpmPackOutput(JSON.parse(result.stdout))[0].name, "@kaspa-x402/server");
    assert.equal(uploads.length, 0, "proof attempted a registry upload");
    return { localPackPassed: true, uploads: 0 };
  });
  await check("immutable SDK release preparation excludes substituted checkout output and credentials", async () => {
    const source = path.join(temporary, "source");
    fs.mkdirSync(source);
    fs.cpSync(root, path.join(source, "protocol"), { recursive: true,
      filter: f => !path.relative(root, f).split(path.sep).some(p => ["node_modules", "dist", ".git", ".npmrc", "coverage"].includes(p) || p.startsWith(".kaspa-x402-") || p.startsWith(".env")) });
    const manifestFile = path.join(source, "protocol/packages/core/package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile));
    manifest.scripts["build:self"] = 'node -e "if(process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN || process.env.NODE_OPTIONS)process.exit(91)" && ' + manifest.scripts["build:self"];
    manifest.scripts.prepublishOnly = `node -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(path.join(temporary, "lifecycle-ran"))}, 'executed')`)}`;
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    for (const argv of [["init", "--quiet"], ["add", "."], ["-c", "user.name=SDK proof", "-c", "user.email=proof@example.invalid", "commit", "--quiet", "-m", "SDK release proof fixture"]]) {
      const r = await run("git", argv, source); assert.equal(r.code, 0, r.stderr);
    }
    const revision = (await run("git", ["rev-parse", "HEAD"], source)).stdout.trim();
    const hash = f => crypto.createHash("sha256").update(fs.readFileSync(path.join(source, "protocol", f))).digest("hex");
    // Controlled external compiler receipt: this proof tests binding, not SilverScript.
    const compiler = { ok: true, compilerReproduced: true, artifacts: [
      { templateId: "kaspa-x402-escrow-v5", check: true, fixtureSha256: hash("contracts/fixtures/kaspa-x402-escrow-v5.json"), generatedSha256: hash("packages/covenant/src/generated/escrow-v5-template.ts") },
      { templateId: "kaspa-x402-hash-chain-head-v2", check: true, fixtureSha256: hash("contracts/fixtures/kaspa-x402-hash-chain-head-v2.json"), generatedSha256: hash("packages/covenant/src/generated/hash-chain-head-v2.ts") },
    ], compilerProvenance: { compilerCommit: "3ed973335b59269293564805cc2c58a14595ec03", compilerTree: "1".repeat(40),
      sourceManifestSha256: "1".repeat(64), cargoManifestSha256: "2".repeat(64), cargoLockSha256: "3".repeat(64), compilerBinarySha256: "4".repeat(64),
      cargoVersion: "cargo 1.95.0 (controlled proof)", rustcVersion: "rustc 1.95.0 (controlled proof)",
      compilations: [["kaspa-x402-escrow-v5.sil", 9], ["kaspa-x402-hash-chain-head-v2.sil", 3]].flatMap(([f, count]) =>
        Array.from({ length: count }, () => ({ source: f, sourceSha256: hash(`contracts/${f}`), outputSha256: "5".repeat(64) }))) } };
    const compilerFile = path.join(source, "compiler-proof.json"); fs.writeFileSync(compilerFile, JSON.stringify(compiler));
    fs.mkdirSync(path.join(source, "protocol/packages/core/dist"));
    fs.writeFileSync(path.join(source, "protocol/packages/core/dist/index.js"), 'export const substituted = "STALE_DIST_PROOF";');
    fs.writeFileSync(path.join(source, "protocol/.npmrc"), "ignore-scripts=true\nregistry=http://127.0.0.1:1/\n");
    const bundle = path.join(temporary, "bundle");
    const r = await run(process.execPath, [path.join(root, "scripts/prepare-sdk-release.mjs"), "--revision", revision, "--out", bundle, "--compiler-proof", compilerFile], source,
      { NODE_AUTH_TOKEN: "LOCAL_PROOF_ONLY", NPM_TOKEN: "LOCAL_PROOF_ONLY", NODE_OPTIONS: "--no-warnings" });
    assert.equal(r.code, 0, r.stderr);
    const receipt = JSON.parse(fs.readFileSync(path.join(bundle, "manifest.json")));
    assert.equal(receipt.revision, revision);
    assert.equal(receipt.packages.length, 4);
    assert.equal(receipt.consumer.ok, true);
    for (const pkg of receipt.packages) assert.ok(!zlib.gunzipSync(fs.readFileSync(path.join(bundle, pkg.filename))).includes(Buffer.from("STALE_DIST_PROOF")));
    releaseFixture = { bundle, revision, manifestSha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(bundle, "manifest.json"))).digest("hex") };
    return { revision, immutableBuild: true, packages: 4, installedConsumer: true };
  });
  await check("approved bundle inspection binds exact manifest, revision and four tarballs", async () => {
    const r = await inspect(releaseFixture.bundle, releaseFixture.manifestSha256);
    assert.equal(r.code, 0, r.stderr); return { inspected: true };
  });
  await check("tarball substitution after inspection fails before publication", async () => {
    const copy = path.join(temporary, "substituted"); fs.cpSync(releaseFixture.bundle, copy, { recursive: true });
    const m = JSON.parse(fs.readFileSync(path.join(copy, "manifest.json")));
    fs.appendFileSync(path.join(copy, m.packages[0].filename), "SUBSTITUTION");
    const r = await inspect(copy, releaseFixture.manifestSha256);
    assert.notEqual(r.code, 0); assert.match(r.stderr, /tarball SHA-256 mismatch/);
    return { rejectedBeforeUpload: true };
  });
  await check("modified approval receipt cannot authorize substituted provenance", async () => {
    const copy = path.join(temporary, "receipt-substitution"); fs.cpSync(releaseFixture.bundle, copy, { recursive: true });
    fs.appendFileSync(path.join(copy, "manifest.json"), "\n");
    const r = await inspect(copy, releaseFixture.manifestSha256);
    assert.notEqual(r.code, 0); assert.match(r.stderr, /manifest digest mismatch/); return { rejected: true };
  });
  await check("a different source revision cannot reuse an approved bundle", async () => {
    const r = await run(process.execPath, [path.join(root, "scripts/inspect-sdk-release.mjs"), "--bundle", releaseFixture.bundle,
      "--revision", "0".repeat(40), "--manifest-sha256", releaseFixture.manifestSha256], temporary);
    assert.notEqual(r.code, 0); assert.match(r.stderr, /provenance.*mismatch/); return { rejected: true };
  });
  await check("a missing export in an actual archive is rejected even with updated digests", async () => {
    const directory = fixture("archive-missing-export", "server");
    fs.rmSync(path.join(directory, "dist/hash-chain-grants.js"));
    const copy = path.join(temporary, "bad-export-bundle"); fs.cpSync(releaseFixture.bundle, copy, { recursive: true });
    const packed = await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", copy], directory);
    assert.equal(packed.code, 0, packed.stderr);
    const m = JSON.parse(fs.readFileSync(path.join(copy, "manifest.json")));
    const pkg = m.packages.find(p => p.name === "@kaspa-x402/server"), bytes = fs.readFileSync(path.join(copy, pkg.filename));
    pkg.sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    pkg.integrity = "sha512-" + crypto.createHash("sha512").update(bytes).digest("base64");
    const manifestBytes = Buffer.from(JSON.stringify(m)); fs.writeFileSync(path.join(copy, "manifest.json"), manifestBytes);
    const r = await inspect(copy, crypto.createHash("sha256").update(manifestBytes).digest("hex"));
    assert.notEqual(r.code, 0); assert.match(r.stderr, /missing public export/); return { rejected: true };
  });
  await check("publisher uploads only the approved archives without lifecycle execution", async () => {
    const r = await run(process.execPath, [path.join(root, "scripts/publish-sdk-release.mjs"), "--bundle", releaseFixture.bundle,
      "--revision", releaseFixture.revision, "--manifest-sha256", releaseFixture.manifestSha256,
      "--registry", registry, "--tag", "rc", "--publish"], temporary, { NODE_AUTH_TOKEN: "LOCAL_PROOF_ONLY" });
    assert.equal(r.code, 0, r.stderr); assert.equal(uploads.length, 4);
    const manifest = JSON.parse(fs.readFileSync(path.join(releaseFixture.bundle, "manifest.json")));
    for (const upload of uploads) assert.equal(upload.sha256, manifest.packages.find(p => p.name === upload.name).sha256);
    assert.equal(fs.existsSync(path.join(temporary, "lifecycle-ran")), false);
    return { approvedArchivesPublished: 4, loopbackOnly: true };
  });
  for (const fault of ["metadata", "bytes"]) await check(`registry ${fault} substitution is detected after upload`, async () => {
    published.clear(); uploads.length = 0; registryFault = fault;
    try {
      const copy = path.join(temporary, `registry-fault-${fault}`); fs.cpSync(releaseFixture.bundle, copy, { recursive: true });
      fs.rmSync(path.join(copy, "publication.json"), { force: true });
      const r = await run(process.execPath, [path.join(root, "scripts/publish-sdk-release.mjs"), "--bundle", copy,
        "--revision", releaseFixture.revision, "--manifest-sha256", releaseFixture.manifestSha256,
        "--registry", registry, "--tag", "rc", "--publish"], temporary, { NODE_AUTH_TOKEN: "LOCAL_PROOF_ONLY" });
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, fault === "metadata" ? /registry integrity differs/ : /registry bytes differ/);
      assert.equal(uploads.length, 1, "publication continued after registry integrity failure");
      return { detected: true, stoppedAfterUpload: 1 };
    } finally { registryFault = undefined; }
  });
  await check("publication refuses to overwrite a prior journal before uploading", async () => {
    published.clear(); uploads.length = 0;
    const copy = path.join(temporary, "prior-publication"); fs.cpSync(releaseFixture.bundle, copy, { recursive: true });
    fs.writeFileSync(path.join(copy, "publication.json"), "PRIOR_APPROVAL_RECORD");
    const r = await run(process.execPath, [path.join(root, "scripts/publish-sdk-release.mjs"), "--bundle", copy,
      "--revision", releaseFixture.revision, "--manifest-sha256", releaseFixture.manifestSha256,
      "--registry", registry, "--tag", "rc", "--publish"], temporary, { NODE_AUTH_TOKEN: "LOCAL_PROOF_ONLY" });
    assert.notEqual(r.code, 0); assert.equal(uploads.length, 0);
    assert.equal(fs.readFileSync(path.join(copy, "publication.json"), "utf8"), "PRIOR_APPROVAL_RECORD");
    return { priorJournalRetained: true, uploads: 0 };
  });
} finally {
  await new Promise(resolve => server.close(resolve));
  const sourceFiles = ["scripts/assert-package-dist.mjs", "scripts/proof-sdk-release-artifacts-e2e.mjs",
    "scripts/sdk-release-artifacts.mjs", "scripts/prepare-sdk-release.mjs", "scripts/inspect-sdk-release.mjs",
    "scripts/publish-sdk-release.mjs", "scripts/sdk-release-consumer.mjs"];
  const report = { schema: "kaspa-x402-sdk-release-e2e/v1", evidenceBoundary: "Real Git/npm/build/consumer/registry bytes; controlled compiler receipt; loopback uploads only, no public publication.",
    cases: records, passed: records.filter(c => c.passed).length, failed: records.filter(c => !c.passed).length,
    sourceSha256: Object.fromEntries(sourceFiles.map(f => [f, crypto.createHash("sha256").update(fs.readFileSync(path.join(root, f))).digest("hex")])) };
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  fs.rmSync(temporary, { recursive: true, force: true });
  console.log(JSON.stringify({ report: output, passed: report.passed, failed: report.failed }));
  if (report.failed) process.exitCode = 1;
}
