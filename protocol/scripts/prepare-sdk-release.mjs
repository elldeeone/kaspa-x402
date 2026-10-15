#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_PACKAGES, argumentsFor, cleanEnvironment, run, sha256, integrity, readFile,
  exportRevision, inspectTarball, validateCompilerProof } from "./sdk-release-artifacts.mjs";
import { normalizeNpmPackOutput } from "./npm-pack-output.mjs";
import { writeNetworkFixture } from "./sdk-network-fixture.mjs";

const args = argumentsFor(process.argv.slice(2), ["--revision", "--out", "--compiler-proof"]);
if (!args["--revision"] || !args["--out"]) throw new Error("usage: prepare-sdk-release.mjs --revision <commit> --out <new-directory> [--compiler-proof <receipt.json>]");
const output = path.resolve(args["--out"]);
if (fs.existsSync(output)) throw new Error("release output directory must not already exist");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-release-build-"));
let created = false;
try {
  const env = cleanEnvironment(path.join(temporary, "home"));
  const snapshot = path.join(temporary, "protocol"); fs.mkdirSync(snapshot, { mode: 0o700 });
  const source = exportRevision(process.cwd(), args["--revision"], snapshot, env);
  let compilerBytes, compilerProvenance;
  if (args["--compiler-proof"]) {
    compilerBytes = readFile(path.resolve(args["--compiler-proof"]));
    compilerProvenance = validateCompilerProof(compilerBytes, source);
  }
  const lock = JSON.parse(fs.readFileSync(path.join(snapshot, "package-lock.json")));
  const npmVersion = run("npm", ["--version"], snapshot, env).trim();
  run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], snapshot, env);
  run(process.execPath, [path.join(snapshot, "scripts/build-packages.mjs"), ...PUBLIC_PACKAGES], snapshot, env);
  fs.mkdirSync(output, { recursive: true, mode: 0o700 }); created = true;
  const packed = normalizeNpmPackOutput(JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", output,
    ...PUBLIC_PACKAGES.flatMap(name => ["--workspace", name])], snapshot, env)));
  const packages = packed.map(pkg => {
    const bytes = readFile(path.join(output, pkg.filename));
    const inspected = inspectTarball(bytes);
    return { name: inspected.manifest.name, version: inspected.manifest.version, filename: pkg.filename,
      sha256: sha256(bytes), integrity: integrity(bytes), files: inspected.files, exports: inspected.exports };
  });
  if (packages.length !== 4 || new Set(packages.map(p => p.name)).size !== 4) throw new Error("unexpected packed package set");
  const consumer = path.join(temporary, "consumer"); fs.mkdirSync(consumer);
  const overrides = {};
  for (const [location, pkg] of Object.entries(lock.packages)) {
    if (location.startsWith("node_modules/") && !location.slice(13).includes("/node_modules/") && pkg.version && !pkg.link)
      overrides[location.slice(13)] = pkg.version;
  }
  const manifest = { private: true, type: "module", dependencies: Object.fromEntries(packages.map(p => [p.name, `file:${path.join(output, p.filename)}`])),
    devDependencies: { typescript: lock.packages["node_modules/typescript"].version, "@types/node": lock.packages["node_modules/@types/node"].version }, overrides };
  fs.writeFileSync(path.join(consumer, "package.json"), JSON.stringify(manifest));
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], consumer, env);
  for (const name of PUBLIC_PACKAGES) if (fs.lstatSync(path.join(consumer, "node_modules", name)).isSymbolicLink()) throw new Error("consumer must install archives, not workspace links");
  const entries = packages.flatMap(p => p.exports);
  fs.writeFileSync(path.join(consumer, "smoke.mjs"), `import assert from 'node:assert/strict';\nimport { stableStringify } from '@kaspa-x402/core';\n` +
    entries.map((name, i) => `import * as m${i} from ${JSON.stringify(name)}; assert.ok(Object.keys(m${i}).length);`).join("\n") +
    '\nassert.equal(stableStringify({b:2,a:1}), \'{"a":1,"b":2}\');\n');
  run(process.execPath, ["smoke.mjs"], consumer, env);
  const consumerTool = fs.readFileSync(new URL("./sdk-release-consumer.mjs", import.meta.url));
  fs.writeFileSync(path.join(consumer, "sdk-consumer.mjs"), consumerTool);
  const consumerProof = JSON.parse(run(process.execPath, ["sdk-consumer.mjs"], consumer, env));
  const networkTool = fs.readFileSync(new URL("./sdk-network-consumer.mjs", import.meta.url));
  fs.writeFileSync(path.join(consumer, "sdk-network-consumer.mjs"), networkTool);
  writeNetworkFixture(snapshot, path.join(consumer, "mock-testnet.mjs"), "kaspa:testnet-10", { facilitator: false });
  writeNetworkFixture(snapshot, path.join(consumer, "mock-mainnet.mjs"), "kaspa:mainnet", { facilitator: false });
  const networkProof = JSON.parse(run(process.execPath, ["sdk-network-consumer.mjs"], consumer, env));
  fs.writeFileSync(path.join(consumer, "consumer.mts"), entries.map((name, i) => `import * as m${i} from ${JSON.stringify(name)}; void m${i};`).join("\n"));
  run(process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit", "--strict", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", "--types", "node", "consumer.mts"], consumer, env);
  for (const [file, original] of Object.entries(source.files)) {
    if (sha256(readFile(path.join(snapshot, file))) !== original.sha256) throw new Error("release build changed authenticated source inputs");
  }
  if (compilerBytes) fs.writeFileSync(path.join(output, "compiler-proof.json"), compilerBytes, { flag: "wx", mode: 0o600 });
  const receipt = { schema: "kaspa-x402-sdk-release/v1", revision: args["--revision"], source,
    inputs: { lockSha256: source.files["package-lock.json"].sha256, nodeVersion: process.version, npmVersion,
      preparationToolSha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))),
      librarySha256: sha256(fs.readFileSync(new URL("./sdk-release-artifacts.mjs", import.meta.url))) },
    compilerProof: compilerBytes ? { sha256: sha256(compilerBytes), provenance: compilerProvenance } : null,
    consumer: { ok: true, exports: entries, proof: consumerProof, networkProof, networkToolSha256: sha256(networkTool),
      networkFixtureToolSha256: sha256(fs.readFileSync(new URL("./sdk-network-fixture.mjs", import.meta.url))),
      toolSha256: sha256(consumerTool), lockSha256: sha256(fs.readFileSync(path.join(consumer, "package-lock.json"))) }, packages };
  const bytes = Buffer.from(JSON.stringify(receipt, null, 2) + "\n");
  fs.writeFileSync(path.join(output, "manifest.json"), bytes, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ bundle: output, revision: receipt.revision, manifestSha256: sha256(bytes), consumer: true,
    compilerReproduced: !!compilerBytes, publicationReady: !!compilerBytes }));
} catch (error) {
  if (created) fs.rmSync(output, { recursive: true, force: true });
  throw error;
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
