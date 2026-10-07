import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const KASPA_CONSENSUS_COMMIT = "01b532e8b553523216471682649693af92f0fd16";
export const KASPA_CONSENSUS_VERSION = "2.1.0";

export function readKaspaConsensusSource(kaspaRoot) {
  const workspace = fs.readFileSync(path.join(kaspaRoot, "Cargo.toml"), "utf8");
  const versions = ["consensus", "consensus/core"].map((directory) => {
    const manifest = fs.readFileSync(path.join(kaspaRoot, directory, "Cargo.toml"), "utf8");
    const fields = sectionLines(manifest, "package");
    const version = /^version\.workspace\s*=\s*true\s*(?:#.*)?$/m.test(fields)
      ? literalVersion(sectionLines(workspace, "workspace.package"))
      : literalVersion(fields);
    if (!version) throw new Error(`Cannot read ${directory} package version.`);
    return version;
  });
  if (versions[0] !== versions[1]) {
    throw new Error("kaspa-consensus and kaspa-consensus-core package versions differ.");
  }
  return {
    version: versions[0],
    commit: execFileSync("git", ["-C", kaspaRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  };
}

function sectionLines(manifest, selected) {
  let section;
  const lines = [];
  for (const line of manifest.split(/\r?\n/)) {
    const header = /^\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (header) section = header[1];
    else if (section === selected) lines.push(line);
  }
  return lines.join("\n");
}

function literalVersion(fields) {
  return /^version\s*=\s*"([^"]+)"\s*(?:#.*)?$/m.exec(fields)?.[1];
}
