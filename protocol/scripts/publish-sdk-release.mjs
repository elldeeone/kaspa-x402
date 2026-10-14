#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { argumentsFor, verifyBundle, cleanEnvironment, run, MAX_TARBALL_BYTES, sha256, integrity } from "./sdk-release-artifacts.mjs";

const args = argumentsFor(process.argv.slice(2), ["--bundle", "--revision", "--manifest-sha256", "--registry", "--tag"], ["--publish"]);
if (!args["--bundle"]) throw new Error("--bundle is required");
const bundle = path.resolve(args["--bundle"] ?? "");
const { receipt, captured } = verifyBundle(bundle, args["--revision"], args["--manifest-sha256"], true);
const registry = new URL(args["--registry"] ?? "https://registry.npmjs.org/");
if (registry.username || registry.password || registry.search || registry.hash || registry.pathname !== "/" ||
  !(registry.protocol === "https:" || (registry.protocol === "http:" && registry.hostname === "127.0.0.1"))) throw new Error("registry must be an HTTPS origin (HTTP loopback is for proofs)");
const tag = args["--tag"] ?? "rc";
if (!/^[a-z][a-z0-9-]*$/.test(tag) || captured.some(p => p.manifest.publishConfig?.tag !== tag)) throw new Error("tag must match the approved package publication configuration");
if (!args["--publish"]) {
  console.log(JSON.stringify({ ok: true, publicationRequested: false, revision: receipt.revision, packages: captured.length }));
} else {
  if (!process.env.NODE_AUTH_TOKEN) throw new Error("NODE_AUTH_TOKEN is required only for the isolated publication step");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-release-publish-"));
  const status = { revision: receipt.revision, manifestSha256: args["--manifest-sha256"], registry: registry.href, tag, packages: [] };
  let journal;
  function recordStatus() {
    const bytes = Buffer.from(JSON.stringify(status, null, 2) + "\n");
    fs.ftruncateSync(journal, 0);
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(journal, bytes, offset, bytes.length - offset, offset);
    fs.fsyncSync(journal);
  }
  try {
    // Create a fresh journal before any upload; never overwrite an earlier
    // publication record or follow a substituted output symlink.
    journal = fs.openSync(path.join(bundle, "publication.json"), "wx", 0o600);
    recordStatus();
    const env = cleanEnvironment(path.join(temporary, "home"));
    env.NODE_AUTH_TOKEN = process.env.NODE_AUTH_TOKEN;
    env.NPM_CONFIG_REGISTRY = registry.href;
    fs.writeFileSync(env.NPM_CONFIG_USERCONFIG, `//${registry.host}/:_authToken=\${NODE_AUTH_TOKEN}\n`, { mode: 0o600 });
    // Capture and verify every input before npm runs. Never reread mutable bundle
    // paths or execute the candidate's source/build/lifecycle with credentials.
    for (const pkg of captured) fs.writeFileSync(path.join(temporary, pkg.filename), pkg.bytes, { flag: "wx", mode: 0o600 });
    for (const pkg of captured) {
      run("npm", ["publish", path.join(temporary, pkg.filename), "--ignore-scripts", "--workspaces=false", "--access", "public", "--tag", tag, "--registry", registry.href], temporary, env);
      status.packages.push({ name: pkg.name, version: pkg.version, uploaded: true, verified: false });
      recordStatus();
      const view = JSON.parse(run("npm", ["view", `${pkg.name}@${pkg.version}`, "dist", "--json", "--registry", registry.href, "--workspaces=false"], temporary, env));
      if (Array.isArray(view) && view.length !== 1) throw new Error("registry must return one exact package version");
      const dist = Array.isArray(view) ? view[0] : view;
      assert.equal(dist.integrity, pkg.integrity, "registry integrity differs from approved archive");
      const url = new URL(dist.tarball);
      if (url.origin !== registry.origin || url.username || url.password || url.hash) throw new Error("registry tarball must stay on the selected origin");
      const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30000) });
      if (!response.ok || !response.body) throw new Error("registry tarball download failed");
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > MAX_TARBALL_BYTES) throw new Error("registry tarball exceeds release bound"); chunks.push(chunk); }
      const downloaded = Buffer.concat(chunks);
      assert.equal(sha256(downloaded), pkg.sha256, "registry bytes differ from approved archive");
      assert.equal(integrity(downloaded), pkg.integrity, "registry download integrity mismatch");
      status.packages.at(-1).verified = true;
      recordStatus();
    }
    console.log(JSON.stringify({ ok: true, registryVerified: true, revision: receipt.revision, packages: status.packages }));
  } finally { if (journal !== undefined) fs.closeSync(journal); fs.rmSync(temporary, { recursive: true, force: true }); }
}
