import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sourceScript = fileURLToPath(new URL("./verify-bounded-network-io.mjs", import.meta.url));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const baseSha = "7231e842d8ba69190ff11868554b9bf71d7c5082";

test("proof check survives a clean candidate commit and a moving origin/main", () => {
  const root = mkdtempSync(join(tmpdir(), "bounded-network-proof-"));
  try {
    for (const path of ["scripts", "verification", "src", "bin"]) mkdirSync(join(root, path));
    copyFileSync(sourceScript, join(root, "scripts", "verify-bounded-network-io.mjs"));
    const path = "src/paid.ts";
    const contents = "export const paid = true;\n";
    writeFileSync(join(root, path), contents);
    const sourceSha256 = sha256(`${path}\0${sha256(contents)}\n`);
    writeFileSync(join(root, "verification", "bounded-network-io.json"), JSON.stringify({
      baseSha, headSha: baseSha, sourceFiles: [path], sourceSha256,
      commands: [{ exitCode: 0 }],
    }));
    const git = join(root, "bin", "git");
    writeFileSync(git, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "diff" && args.includes("--name-only")) console.log("src/paid.ts");
else if (args[0] === "rev-parse" && args[1] === "HEAD") console.log("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
else if (args[0] === "rev-parse" && args[1] === "origin/main") console.log("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
else if (args[0] === "branch") console.log("bound-network-io");
`);
    chmodSync(git, 0o755);
    const result = spawnSync(process.execPath,
      [join(root, "scripts", "verify-bounded-network-io.mjs"), "--check"],
      { cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /sha256 [0-9a-f]{64}/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
