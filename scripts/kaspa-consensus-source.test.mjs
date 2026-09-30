import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readKaspaConsensusSource } from "./kaspa-consensus-source.mjs";

function checkout(t, { workspaceVersion, consensusVersion, coreVersion }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kaspa-consensus-source-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "consensus/core"), { recursive: true });
  fs.writeFileSync(path.join(root, "Cargo.toml"),
    `[workspace.package]\nversion = "${workspaceVersion}"\n[workspace.dependencies.example]\nversion = "99.0.0"\n`);
  for (const [directory, version] of [["consensus", consensusVersion], ["consensus/core", coreVersion]]) {
    fs.writeFileSync(path.join(root, directory, "Cargo.toml"),
      `[package]\nname = "${directory.replaceAll("/", "-")}"\n${version === undefined ? "version.workspace = true" : `version = "${version}"`}\n[dependencies.example]\nversion = "88.0.0"\n`);
  }
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "-c", "user.name=Source test", "-c", "user.email=source-test@example.invalid", "commit", "--quiet", "-m", "Fixture"]);
  return root;
}

test("reports the real checkout commit and inherited package version", (t) => {
  const root = checkout(t, { workspaceVersion: "7.3.2" });
  const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.deepEqual(readKaspaConsensusSource(root), { version: "7.3.2", commit });
  execFileSync("git", ["-C", root, "-c", "user.name=Source test", "-c", "user.email=source-test@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "Different source"]);
  assert.notEqual(readKaspaConsensusSource(root).commit, commit);
});

test("uses explicit package versions instead of unrelated workspace or dependency versions", (t) => {
  const root = checkout(t, { workspaceVersion: "7.3.2", consensusVersion: "4.5.6", coreVersion: "4.5.6" });
  assert.equal(readKaspaConsensusSource(root).version, "4.5.6");
});

test("rejects mismatched validator and consensus-core versions", (t) => {
  const root = checkout(t, { workspaceVersion: "7.3.2", coreVersion: "4.5.6" });
  assert.throws(() => readKaspaConsensusSource(root), /package versions differ/);
});

test("rejects missing package provenance instead of using a dependency version", (t) => {
  const root = checkout(t, { workspaceVersion: "7.3.2" });
  fs.writeFileSync(path.join(root, "consensus/Cargo.toml"), '[package]\nname = "kaspa-consensus"\n[dependencies.example]\nversion = "88.0.0"\n');
  assert.throws(() => readKaspaConsensusSource(root), /Cannot read consensus package version/);
});
