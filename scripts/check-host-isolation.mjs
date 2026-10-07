import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root, encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
const env = { ...process.env };
delete env.NODE_PATH;

// Build the dependency artifacts once. Each host then installs only its own
// declared dependency graph and consumes these package exports, never TS aliases.
run(root, "npm", ["--prefix", "protocol", "run", "build"]);
for (const host of ["site", "demo-gateway"]) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `kaspa-x402-${host}-`));
  try {
    const excluded = host === "site" ? "packages/demo-gateway/" : "site/";
    for (const file of new Set(files)) {
      if (file.startsWith(excluded) || !fs.existsSync(path.join(root, file))) continue;
      const target = path.join(temporary, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(root, file), target);
    }
    for (const pkg of fs.readdirSync(path.join(root, "protocol/packages"))) {
      fs.cpSync(
        path.join(root, "protocol/packages", pkg, "dist"),
        path.join(temporary, "protocol/packages", pkg, "dist"),
        { recursive: true },
      );
    }
    // Site provenance checks need a Git snapshot. This temporary fixture has no
    // remotes and never changes the user's index, history or working files.
    run(temporary, "git", ["init", "--quiet"]);
    run(temporary, "git", ["-c", "core.autocrlf=false", "add", "."]);
    run(temporary, "git", [
      "-c",
      "user.name=Isolation check",
      "-c",
      "user.email=isolation@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--quiet",
      "-m",
      "Isolation fixture",
    ]);
    const workspace = `@kaspa-x402/${host}`;
    run(temporary, "npm", [
      "ci",
      "--workspace",
      workspace,
      "--include-workspace-root=false",
      "--no-audit",
      "--no-fund",
    ]);
    run(temporary, "npm", ["--workspace", workspace, "run", "build:self"]);
    run(temporary, "npm", [
      "--workspace",
      workspace,
      "run",
      host === "site" ? "check" : "test:self",
    ]);
    if (host === "site") {
      for (const file of ["site/package.json", "protocol/scripts/build-packages.mjs"]) {
        const target = path.join(temporary, file);
        const original = fs.readFileSync(target);
        fs.appendFileSync(target, "\n");
        const rejected = spawnSync(process.execPath, ["site/scripts/site-build.mjs", "--require-clean"], {
          cwd: temporary, env, encoding: "utf8",
        });
        fs.writeFileSync(target, original);
        if (rejected.error) throw rejected.error;
        if (rejected.status === 0 || !rejected.stderr.includes("requires clean publishable inputs") || !rejected.stderr.includes(file))
          throw new Error(`Site deployment did not reject changed build input: ${file}`);
      }
    }
    console.log(`${host}: independent dependency install and host checks passed.`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function run(cwd, command, args) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? result.signal}).`);
}
