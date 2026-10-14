#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pin = "3ed973335b59269293564805cc2c58a14595ec03";
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--out");
if (outputIndex < 0 || !args[outputIndex + 1] ||
    args.filter((_, index) => index !== outputIndex && index !== outputIndex + 1).some((arg) => arg !== "--real")) {
  throw new Error("usage: proof-covenant-compiler-e2e.mjs --out <report.json> [--real]");
}
const output = path.resolve(args[outputIndex + 1]);
const compilerInput = process.env.SILVERSCRIPT_DIR;
if (!compilerInput) throw new Error("SILVERSCRIPT_DIR must contain the pinned compiler Git objects");
fs.mkdirSync(path.dirname(output), { recursive: true });
const temporary = fs.mkdtempSync(path.join(path.dirname(output), "compiler-e2e-"));
const records = [];
const report = { schema: "kaspa-x402-covenant-compiler-e2e/v1", compilerCommit: pin,
  evidenceBoundary: "Real Git/filesystem/CLI; controlled external Cargo/compiler. --real separately rebuilds pinned SilverScript.",
  cases: records };
const git = (...argv) => execFileSync("git", argv, { encoding: "utf8" }).trim();
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const originalFiles = ["contracts/fixtures/kaspa-x402-escrow-v5.json",
  "packages/covenant/src/generated/escrow-v5-template.ts",
  "contracts/fixtures/kaspa-x402-hash-chain-head-v2.json",
  "packages/covenant/src/generated/hash-chain-head-v2.ts"];
const originalHashes = Object.fromEntries(originalFiles.map((file) => [file, hash(fs.readFileSync(path.join(root, file)))]));
const escrow = JSON.parse(fs.readFileSync(path.join(root, originalFiles[0])));
const head = JSON.parse(fs.readFileSync(path.join(root, originalFiles[2])));
const reference = path.join(temporary, "reference.json");
fs.writeFileSync(reference, JSON.stringify({ escrow, head }));
const attackMarker = path.join(temporary, "attack-executed");
const invocationLog = path.join(temporary, "compiler-inputs.jsonl");
const bin = path.join(temporary, "bin");
fs.mkdirSync(bin);
// Extensionless Node launchers must stay CommonJS even beneath this ESM repo.
fs.writeFileSync(path.join(bin, "package.json"), '{"type":"commonjs"}');
// This external compiler is an explicit test boundary, not the production helper.
// Its outputs come from separately retained baseline artifacts, not the candidate.
const driver = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const reference = JSON.parse(fs.readFileSync(${JSON.stringify(reference)}));
const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-Vv')) {
 console.log(path.basename(process.argv[1]).startsWith('rustc') ? 'rustc 1.95.0 (test boundary)' : 'cargo 1.95.0 (test boundary)'); process.exit(0);
}
const manifest = argv.includes('--manifest-path') ? argv[argv.indexOf('--manifest-path') + 1] : path.join(process.cwd(), 'Cargo.toml');
if (argv.includes('build') || argv.includes('run')) {
 const sourceRoot = path.dirname(manifest);
 const inherited = Object.keys(process.env).filter(k => /^(RUSTC|RUSTFLAGS|CARGO_BUILD_RUSTC|CARGO_ENCODED_RUSTFLAGS|CARGO_TARGET_DIR|CARGO_SOURCE_|CARGO_REGISTRIES_)/.test(k) && process.env[k].includes('PROVENANCE_ATTACK'));
 const unsafe = ['Cargo.toml','Cargo.lock','.cargo/config.toml','silverscript-lang/src/lib.rs'].filter(p => fs.existsSync(path.join(sourceRoot,p)) && fs.readFileSync(path.join(sourceRoot,p),'utf8').includes('PROVENANCE_ATTACK'));
 fs.appendFileSync(${JSON.stringify(invocationLog)}, JSON.stringify({ sourceRoot, inherited, unsafe, argv })+'\\n');
 if (inherited.length || unsafe.length) { fs.writeFileSync(${JSON.stringify(attackMarker)}, 'untrusted compiler input executed'); process.exit(73); }
 if (argv.includes('build')) {
  const target = argv[argv.indexOf('--target-dir')+1]; fs.mkdirSync(path.join(target,'debug'),{recursive:true});
  fs.copyFileSync(process.argv[1],path.join(target,'debug',process.platform==='win32'?'silverc.exe':'silverc'));
  fs.chmodSync(path.join(target,'debug','silverc'),0o700); process.exit(0);
 }
}
const constructorPath = argv[argv.indexOf('--constructor-args')+1];
const values = JSON.parse(fs.readFileSync(constructorPath));
const isEscrow = argv.some(v=>v.endsWith('kaspa-x402-escrow-v5.sil'));
const bytes = v=>Buffer.from(v.value);
if (isEscrow) {
 const f=reference.escrow; const base=Buffer.from(f.sample.genesis.redeemScript,'hex');
 const names=['clientPublicKey','serverPublicKey','networkHash','payoutScriptPublicKeyHash','refundScriptPublicKeyHash','timeoutDaa','claimedCumulativeAmount'];
 for (const slot of f.constructorLayout.slots) { const value=values[names.indexOf(slot.name)]; let encoded;
  if(slot.name==='claimedCumulativeAmount'){encoded=Buffer.alloc(8);encoded.writeBigInt64LE(BigInt(value.value));}else encoded=bytes(value);
  for(const offset of slot.offsets)encoded.copy(base,offset);
 }
 console.log(JSON.stringify({compiler_version:f.compiler.compilerVersion,contracts:{KaspaX402EscrowV5:{runtime_state:f.generatedDeclarations.runtimeState,cov_decl_to_abi:f.generatedDeclarations.covenantDeclarations,entries:f.generatedDeclarations.entries,compiled:{bytecode:[...base],state_span:{offset:f.stateLayout.start,len:f.stateLayout.len},template_hash:[...Buffer.from(f.generatedDeclarations.templateHash,'hex')]}}}}));
} else {
 const f=reference.head; const artifact=structuredClone(f.artifact);const c=artifact.contracts.KaspaX402HashChainHeadV2;
 const base=Buffer.from(c.compiled.bytecode);for(const offset of f.layout.ownerOffsets)bytes(values[0]).copy(base,offset);bytes(values[1]).copy(base,f.layout.guardOffset);
 c.compiled.bytecode=[...base];if(bytes(values[0]).toString('hex')!==f.constructor.sampleOwnerPublicKey)c.compiled.template_hash=Array(32).fill(1);
 console.log(JSON.stringify(artifact));
}
`;
for (const name of ["cargo", "rustc"]) fs.writeFileSync(path.join(bin, name), driver, { mode: 0o700 });
const environment = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };

function sandbox(name) {
  const directory = path.join(temporary, name);
  fs.mkdirSync(directory);
  git("clone", "--quiet", "--no-checkout", "--shared", path.resolve(compilerInput), path.join(directory, "compiler"));
  git("-C", path.join(directory, "compiler"), "checkout", "--quiet", "--detach", pin);
  const protocol = path.join(directory, "protocol");
  fs.mkdirSync(protocol);
  for (const entry of ["scripts", "contracts", "packages/covenant/src/generated", "packages/covenant/dist"]) {
    fs.cpSync(path.join(root, entry), path.join(protocol, entry), { recursive: true });
  }
  let dependencyRoot = root;
  while (!fs.existsSync(path.join(dependencyRoot, "node_modules/blakejs/index.js"))) {
    const parent = path.dirname(dependencyRoot);
    if (parent === dependencyRoot) throw new Error("Install protocol dependencies before running the E2E proof");
    dependencyRoot = parent;
  }
  const dependencies = path.join(dependencyRoot, "node_modules");
  fs.symlinkSync(dependencies, path.join(protocol, "node_modules"), "dir");
  fs.writeFileSync(path.join(protocol, "package.json"), '{"type":"module"}');
  return { directory, compiler: path.join(directory, "compiler"), protocol };
}
function invoke(s, script, argv = [], extra = {}) {
  fs.rmSync(attackMarker, { force: true });
  const result = spawnSync(process.execPath, [path.join(s.protocol, "scripts", script), ...argv], {
    cwd: s.protocol, env: { ...environment, SILVERSCRIPT_DIR: s.compiler, ...extra }, encoding: "utf8", timeout: 120_000,
  });
  assert.doesNotMatch(`${result.stderr}`, /ERR_MODULE_NOT_FOUND|Cannot find package/, "E2E setup must resolve dependencies");
  return { exitCode: result.status, signal: result.signal, output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    attackExecuted: fs.existsSync(attackMarker) };
}
function hashes(s) { return Object.fromEntries(originalFiles.map(file => [file, hash(fs.readFileSync(path.join(s.protocol, file)))])); }
function check(name, callback) {
  try { const evidence = callback(); records.push({ name, passed: true, evidence }); }
  catch (error) { records.push({ name, passed: false, error: error.message }); }
}
try {
  check("release gate requires compiler reproduction", () => {
    const s = sandbox("missing-compiler");
    const result = invoke(s, "check-covenant-fixtures.mjs", [], { SILVERSCRIPT_DIR: "" });
    assert.notEqual(result.exitCode, 0, "release checker accepted artifacts without an independent compiler");
    return result;
  });
  for (const [script, positional] of [["generate-covenant-fixture.mjs", true], ["generate-hash-chain-fixture.mjs", false]]) {
    const label = positional ? "escrow" : "head";
    check(`${label}: clean non-mutating check`, () => {
      const s = sandbox(`${label}-clean`);
      const result = invoke(s, script, [...(positional ? [s.compiler] : []), "--check"]);
      assert.equal(result.exitCode, 0, result.output);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.protocol, originalFiles[positional ? 0 : 2]))), positional ? escrow : head);
      assert.deepEqual(hashes(s), originalHashes);
      return result;
    });
    check(`${label}: stale runtime fails without writes`, () => {
      const s = sandbox(`${label}-stale`);
      const file = path.join(s.protocol, originalFiles[positional ? 1 : 3]);
      fs.appendFileSync(file, "\n// stale runtime substitution\n");
      const before = hashes(s);
      const result = invoke(s, script, [...(positional ? [s.compiler] : []), "--check"]);
      assert.notEqual(result.exitCode, 0, "stale runtime was accepted or silently regenerated");
      assert.deepEqual(hashes(s), before, "check wrote candidate artifacts"); return result;
    });
    check(`${label}: stale fixture fails without writes`, () => {
      const s = sandbox(`${label}-stale-fixture`);
      fs.appendFileSync(path.join(s.protocol, originalFiles[positional ? 0 : 2]), "\n");
      const before = hashes(s); const result = invoke(s, script, [...(positional ? [s.compiler] : []), "--check"]);
      assert.notEqual(result.exitCode, 0, "stale fixture was accepted or silently regenerated");
      assert.deepEqual(hashes(s), before); return result;
    });
    for (const [name, mutate] of [
      ["root manifest", s => fs.appendFileSync(path.join(s.compiler, "Cargo.toml"), "\n# PROVENANCE_ATTACK\n")],
      ["root lockfile", s => fs.appendFileSync(path.join(s.compiler, "Cargo.lock"), "\n# PROVENANCE_ATTACK\n")],
      ["ignored Cargo config", s => { fs.mkdirSync(path.join(s.compiler, ".cargo")); fs.writeFileSync(path.join(s.compiler, ".cargo/config.toml"), "# PROVENANCE_ATTACK\n"); }],
      ["hidden index source", s => { git("-C", s.compiler, "update-index", "--assume-unchanged", "silverscript-lang/src/lib.rs"); fs.appendFileSync(path.join(s.compiler, "silverscript-lang/src/lib.rs"), "\n// PROVENANCE_ATTACK\n"); }],
      ["skip-worktree source", s => { git("-C", s.compiler, "update-index", "--skip-worktree", "silverscript-lang/src/lib.rs"); fs.appendFileSync(path.join(s.compiler, "silverscript-lang/src/lib.rs"), "\n// PROVENANCE_ATTACK\n"); }],
    ]) check(`${label}: ${name} cannot influence execution`, () => {
      const s = sandbox(`${label}-${name.replaceAll(" ", "-")}`); mutate(s);
      const result = invoke(s, script, [...(positional ? [s.compiler] : []), "--check"]);
      assert.equal(result.attackExecuted, false, "unchecked compiler input reached execution");
      assert.equal(result.exitCode, 0, result.output); assert.deepEqual(hashes(s), originalHashes); return result;
    });
    check(`${label}: inherited execution overrides cannot influence compilation`, () => {
      const s = sandbox(`${label}-environment`);
      const result = invoke(s, script, [...(positional ? [s.compiler] : []), "--check"], {
        RUSTC_WRAPPER: "PROVENANCE_ATTACK", RUSTFLAGS: "PROVENANCE_ATTACK", CARGO_TARGET_DIR: "PROVENANCE_ATTACK",
        CARGO_ENCODED_RUSTFLAGS: "PROVENANCE_ATTACK", CARGO_BUILD_RUSTC_WRAPPER: "PROVENANCE_ATTACK",
      });
      assert.equal(result.attackExecuted, false, "environment override reached compiler");
      assert.equal(result.exitCode, 0, result.output); assert.deepEqual(hashes(s), originalHashes); return result;
    });
    check(`${label}: wrong root and arguments fail before writes`, () => {
      const s = sandbox(`${label}-arguments`); const before = hashes(s);
      for (const argv of [[...(positional ? [s.compiler] : []), "--unknown"],
        [...(positional ? [path.join(s.compiler, "silverscript-lang")] : []), "--check"]]) {
        const result = invoke(s, script, argv, positional ? {} : { SILVERSCRIPT_DIR: path.join(s.compiler, "silverscript-lang") });
        assert.notEqual(result.exitCode, 0, "unsafe root or unknown argument accepted"); assert.deepEqual(hashes(s), before);
      }
      return { rejected: 2 };
    });
  }
  if (args.includes("--real")) check("real pinned compiler reproduces both covenants", () => {
    const result = spawnSync(process.execPath, [path.join(root, "scripts/check-covenant-fixtures.mjs")], {
      cwd: root, env: process.env, encoding: "utf8", timeout: 1_800_000, maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const after = Object.fromEntries(originalFiles.map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
    assert.deepEqual(after, originalHashes); return { exitCode: result.status, output: result.stdout, artifactSha256: after };
  });
} finally {
  report.compilerBoundaryInvocations = fs.existsSync(invocationLog) ? fs.readFileSync(invocationLog, "utf8").trim().split("\n").map(JSON.parse) : [];
  report.sourceRevision = git("-C", root, "rev-parse", "HEAD");
  report.sourceFilesSha256 = Object.fromEntries(["scripts/proof-covenant-compiler-e2e.mjs", "scripts/generate-covenant-fixture.mjs", "scripts/generate-hash-chain-fixture.mjs", "scripts/check-covenant-fixtures.mjs", "scripts/silverscript-compiler.mjs"].filter(file=>fs.existsSync(path.join(root,file))).map(file=>[file,hash(fs.readFileSync(path.join(root,file)))]));
  report.artifactSha256 = originalHashes;
  report.passed = records.filter(record => record.passed).length;
  report.failed = records.length - report.passed;
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.rmSync(temporary, { recursive: true, force: true });
}
console.log(JSON.stringify({ report: output, passed: report.passed, failed: report.failed }));
if (report.failed) process.exitCode = 1;
