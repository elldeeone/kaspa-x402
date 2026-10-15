import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";

export const PUBLIC_PACKAGES = ["core", "covenant", "client", "server"].map(n => `@kaspa-x402/${n}`);
export const MAX_TARBALL_BYTES = 16 * 1024 * 1024;
export const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
export const integrity = bytes => "sha512-" + crypto.createHash("sha512").update(bytes).digest("base64");
export function argumentsFor(argv, keys, flags = []) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key in result || (!keys.includes(key) && !flags.includes(key))) throw new Error(`unknown or duplicate option: ${key}`);
    result[key] = flags.includes(key) ? true : argv[++i];
    if (result[key] === undefined) throw new Error(`missing value: ${key}`);
  }
  return result;
}
export function cleanEnvironment(home) {
  const env = { HOME: home, USERPROFILE: home, PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH,
    NPM_CONFIG_USERCONFIG: path.join(home, "npmrc"), NPM_CONFIG_GLOBALCONFIG: path.join(home, "global-npmrc"),
    NPM_CONFIG_CACHE: path.join(home, "cache"), NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
    NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false" };
  for (const name of ["SYSTEMROOT", "WINDIR"]) if (process.env[name]) env[name] = process.env[name];
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  for (const file of [env.NPM_CONFIG_USERCONFIG, env.NPM_CONFIG_GLOBALCONFIG]) fs.writeFileSync(file, "", { mode: 0o600 });
  return env;
}
export function run(command, argv, cwd, env, timeout = 300000) {
  if (command === "npm") {
    const cli = [path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
      path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js")].find(f => fs.existsSync(f));
    if (!cli) throw new Error("the Node installation must include npm-cli.js");
    command = process.execPath; argv = [cli, ...argv];
  }
  const result = spawnSync(command, argv, { cwd, env, encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024,
    shell: false });
  if (result.error || result.status !== 0) {
    let message = `${command} ${argv[0]} failed: ${result.error?.message ?? result.stderr ?? result.status}`;
    if (env.NODE_AUTH_TOKEN) message = message.replaceAll(env.NODE_AUTH_TOKEN, "<redacted>");
    throw new Error(message);
  }
  return result.stdout;
}
export function readFile(file, max = MAX_TARBALL_BYTES) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > max) throw new Error("release input must be a bounded regular file");
    const bytes = fs.readFileSync(fd);
    if (bytes.length > max) throw new Error("release input grew beyond its bound");
    return bytes;
  } finally { fs.closeSync(fd); }
}
function safePath(name) {
  if (!name || !/^[\x20-\x7e]+$/.test(name) || name.includes("\\") || name.includes(":")) throw new Error("unsafe release path");
  if (name.split("/").some(p => !p || p === "." || p === ".." || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p))) throw new Error("unsafe release path");
  return name;
}
/** Authenticate raw objects; no checkout, attributes, replacements or filters. */
export function exportRevision(repository, revision, target, env) {
  if (!/^[0-9a-f]{40}$/.test(revision ?? "")) throw new Error("a full immutable Git commit is required");
  const gitEnv = { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull, GIT_NO_REPLACE_OBJECTS: "1" };
  const git = (...argv) => {
    const r = spawnSync("git", ["--no-replace-objects", "-C", repository, ...argv], { env: gitEnv, maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`Git source read failed: ${r.stderr}`);
    return r.stdout;
  };
  const read = (type, oid) => {
    const bytes = git("cat-file", type, oid);
    assert.equal(crypto.createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex"), oid, "Git object identity mismatch");
    return bytes;
  };
  const commit = read("commit", revision).toString("utf8");
  const tree = /^tree ([0-9a-f]{40})$/m.exec(commit)?.[1];
  if (!tree) throw new Error("commit tree is missing");
  function entries(oid) {
    read("tree", oid);
    return git("ls-tree", "-z", oid).toString("utf8").split("\0").filter(Boolean).map(row => {
      const match = /^(\d+) (blob|tree|commit) ([0-9a-f]{40})\t(.+)$/.exec(row);
      if (!match) throw new Error("invalid Git tree entry");
      return { mode: match[1], type: match[2], oid: match[3], name: safePath(match[4]) };
    });
  }
  const protocol = entries(tree).find(e => e.name === "protocol" && e.type === "tree");
  if (!protocol) throw new Error("revision has no protocol workspace");
  const files = Object.create(null);
  function walk(oid, prefix) {
    for (const entry of entries(oid)) {
      const relative = safePath(prefix + entry.name);
      if (["dist", "node_modules", ".git"].some(p => relative.split("/").includes(p))) throw new Error("tracked build/cache inputs are not allowed in a release");
      if (entry.name === ".npmrc" || entry.name.startsWith(".env")) throw new Error("release source must not contain credential/config files");
      if (entry.type === "tree" && entry.mode === "040000") walk(entry.oid, relative + "/");
      else {
        if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) throw new Error("release source symlinks/gitlinks are forbidden");
        const bytes = read("blob", entry.oid), file = path.join(target, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, bytes, { flag: "wx", mode: entry.mode === "100755" ? 0o700 : 0o600 });
        files[relative] = { gitBlob: entry.oid, sha256: sha256(bytes) };
      }
    }
  }
  walk(protocol.oid, "");
  return { commitTree: tree, protocolTree: protocol.oid, files };
}

/** Restricted npm tar format: reject links, extension headers and duplicates. */
export function inspectTarball(bytes) {
  if (bytes.length > MAX_TARBALL_BYTES) throw new Error("tarball exceeds release bound");
  const tar = zlib.gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 });
  const files = new Map();
  const text = b => b.toString("utf8").split("\0")[0];
  const octal = b => { const s = text(b).trim(); if (!/^[0-7]+$/.test(s)) throw new Error("invalid tar number"); return Number.parseInt(s, 8); };
  let offset = 0, ended = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512); offset += 512;
    if (header.every(b => b === 0)) { ended = true; if (!tar.subarray(offset).every(b => b === 0)) throw new Error("trailing tar data"); break; }
    const expected = octal(header.subarray(148, 156));
    const checksum = [...header].reduce((sum, b, i) => sum + (i >= 148 && i < 156 ? 32 : b), 0);
    assert.equal(checksum, expected, "tar header checksum mismatch");
    const prefix = text(header.subarray(345, 500));
    const name = (prefix ? prefix + "/" : "") + text(header.subarray(0, 100));
    const type = header[156], size = octal(header.subarray(124, 136));
    if (type === 53 && size === 0) {
      const directory = safePath(name.replace(/\/$/, ""));
      if (directory !== "package" && !directory.startsWith("package/")) throw new Error("unexpected tar directory");
      continue;
    }
    if (type !== 0 && type !== 48) throw new Error("tar links/extension headers are forbidden");
    safePath(name);
    if (!name.startsWith("package/") || files.has(name.slice(8))) throw new Error("unexpected or duplicate tar path");
    const relative = name.slice(8);
    if (!(relative.startsWith("dist/") && /\.(js|d\.ts)$/.test(relative)) && !/^(package\.json|README(?:\.md)?|LICENSE(?:\.md|\.txt)?)$/i.test(relative)) throw new Error(`unexpected package file: ${relative}`);
    if (offset + size > tar.length) throw new Error("truncated tar file");
    files.set(relative, Buffer.from(tar.subarray(offset, offset + size)));
    offset += Math.ceil(size / 512) * 512;
  }
  if (!ended || !files.has("package.json")) throw new Error("incomplete npm archive");
  const manifest = JSON.parse(files.get("package.json").toString("utf8"));
  if (!PUBLIC_PACKAGES.includes(manifest.name) || manifest.private || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.version)) throw new Error("unexpected public package identity");
  const exports = [];
  function requireFile(value) {
    if (typeof value === "string") {
      if (!value.startsWith("./dist/") || !files.has(value.slice(2))) throw new Error(`missing public export: ${value}`);
    } else if (value && typeof value === "object") for (const child of Object.values(value)) requireFile(child);
    else throw new Error("invalid package export");
  }
  if (!manifest.exports || !manifest.exports["."]) throw new Error("package root export is missing");
  for (const [subpath, value] of Object.entries(manifest.exports)) {
    if (subpath !== "." && !/^\.\/[a-z0-9-]+$/.test(subpath)) throw new Error("unexpected public subpath");
    requireFile(value); exports.push(manifest.name + (subpath === "." ? "" : subpath.slice(1)));
  }
  requireFile(manifest.main); requireFile(manifest.types);
  if (manifest.publishConfig?.access !== "public" || Object.keys(manifest.publishConfig).some(k => !["access", "tag"].includes(k))) throw new Error("package registry/access must be controlled by the publisher");
  return { manifest, exports, files: [...files].map(([file, content]) => ({ path: file, bytes: content.length, sha256: sha256(content) })) };
}

export function validateCompilerProof(bytes, source) {
  const receipt = JSON.parse(bytes.toString("utf8"));
  if (receipt.ok !== true || receipt.compilerReproduced !== true || receipt.compilerProvenance?.compilerCommit !== "3ed973335b59269293564805cc2c58a14595ec03") throw new Error("independent pinned compiler proof is required");
  const provenance = receipt.compilerProvenance;
  if (!/^[0-9a-f]{40}$/.test(provenance.compilerTree) ||
    ["sourceManifestSha256", "cargoManifestSha256", "cargoLockSha256", "compilerBinarySha256"].some(k => !/^[0-9a-f]{64}$/.test(provenance[k])) ||
    !provenance.cargoVersion?.startsWith("cargo 1.95.0 ") || !provenance.rustcVersion?.startsWith("rustc 1.95.0 ")) throw new Error("compiler provenance is incomplete");
  for (const [templateId, fixture, generated, contract, count] of [
    ["kaspa-x402-escrow-v5", "contracts/fixtures/kaspa-x402-escrow-v5.json", "packages/covenant/src/generated/escrow-v5-template.ts", "contracts/kaspa-x402-escrow-v5.sil", 9],
    ["kaspa-x402-hash-chain-head-v2", "contracts/fixtures/kaspa-x402-hash-chain-head-v2.json", "packages/covenant/src/generated/hash-chain-head-v2.ts", "contracts/kaspa-x402-hash-chain-head-v2.sil", 3],
  ]) {
    const artifact = receipt.artifacts?.find(a => a.templateId === templateId);
    if (!artifact?.check || artifact.fixtureSha256 !== source.files[fixture]?.sha256 || artifact.generatedSha256 !== source.files[generated]?.sha256) throw new Error("compiler proof does not match release artifacts");
    const compilations = receipt.compilerProvenance.compilations?.filter(c => c.source === path.basename(contract));
    if (compilations?.length !== count || compilations.some(c => c.sourceSha256 !== source.files[contract]?.sha256 || !/^[0-9a-f]{64}$/.test(c.outputSha256))) throw new Error("compiler proof does not match contract sources/variants");
  }
  return receipt.compilerProvenance;
}

export function verifyBundle(directory, revision, expectedDigest, publication = false) {
  if (!/^[0-9a-f]{40}$/.test(revision ?? "") || !/^[0-9a-f]{64}$/.test(expectedDigest ?? "")) throw new Error("expected revision and manifest SHA-256 are required");
  const manifestBytes = readFile(path.join(directory, "manifest.json"));
  assert.equal(sha256(manifestBytes), expectedDigest, "approved manifest digest mismatch");
  const receipt = JSON.parse(manifestBytes.toString("utf8"));
  if (receipt.schema !== "kaspa-x402-sdk-release/v1" || receipt.revision !== revision || receipt.consumer?.ok !== true) throw new Error("release provenance or consumer validation mismatch");
  if (publication) {
    const proof = receipt.consumer.networkProof;
    const expected = ["kaspa:testnet-10", "kaspa:mainnet"].flatMap(network =>
      ["standard-native", "additive", "hash-chain-additive", "batch-settlement"].map(profile => `${network}/${profile}`)).sort();
    if (proof?.ok !== true || !Array.isArray(proof.profiles) ||
      JSON.stringify(proof.profiles.map(p => `${p.network}/${p.profile}`).sort()) !== JSON.stringify(expected))
      throw new Error("publication requires installed SDK proof of all profiles on both networks");
  }
  if (!Array.isArray(receipt.packages) || receipt.packages.length !== 4 || new Set(receipt.packages.map(p => p.name)).size !== 4) throw new Error("exactly four unique SDK packages are required");
  const captured = [];
  for (const pkg of receipt.packages) {
    if (!PUBLIC_PACKAGES.includes(pkg.name) || !/^[a-z0-9][a-z0-9._-]+\.tgz$/.test(pkg.filename)) throw new Error("unexpected release package/path");
    const bytes = readFile(path.join(directory, pkg.filename));
    assert.equal(sha256(bytes), pkg.sha256, "approved tarball SHA-256 mismatch");
    assert.equal(integrity(bytes), pkg.integrity, "approved tarball integrity mismatch");
    const inspected = inspectTarball(bytes);
    assert.equal(inspected.manifest.name, pkg.name); assert.equal(inspected.manifest.version, pkg.version);
    assert.deepEqual(inspected.files, pkg.files, "package contents differ from inspection");
    assert.deepEqual(inspected.exports, pkg.exports, "public exports differ from inspection");
    captured.push({ ...pkg, bytes, manifest: inspected.manifest });
  }
  for (const pkg of captured) for (const [name, version] of Object.entries(pkg.manifest.dependencies ?? {})) {
    if (PUBLIC_PACKAGES.includes(name) && captured.find(p => p.name === name)?.version !== version) throw new Error("internal package dependency version mismatch");
  }
  if (new Set(captured.map(p => p.version)).size !== 1) throw new Error("public SDK versions must move together");
  if (receipt.compilerProof) {
    const bytes = readFile(path.join(directory, "compiler-proof.json"));
    assert.equal(sha256(bytes), receipt.compilerProof.sha256, "compiler proof digest mismatch");
    assert.deepEqual(validateCompilerProof(bytes, receipt.source), receipt.compilerProof.provenance);
  } else if (publication) throw new Error("publication requires independently reproduced compiler evidence");
  return { receipt, captured };
}
