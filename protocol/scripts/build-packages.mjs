import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packages = new Map(fs.readdirSync(path.join(root, "packages")).map(directory => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "packages", directory, "package.json"), "utf8"));
  return [manifest.name, manifest];
}));
const targets = process.argv.slice(2);
const built = new Set();
const visiting = new Set();
for (const name of targets.length ? targets : packages.keys()) build(name);

function build(name) {
  if (built.has(name)) return;
  const manifest = packages.get(name);
  if (!manifest) throw new Error(`Unknown protocol workspace: ${name}`);
  if (visiting.has(name)) throw new Error(`Workspace dependency cycle: ${name}`);
  visiting.add(name);
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    if (packages.has(dependency)) build(dependency);
  }
  const result = spawnSync("npm", ["--workspace", name, "run", "build:self"], {
    cwd: root, stdio: "inherit", shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${name} build failed (${result.status ?? result.signal}).`);
  visiting.delete(name);
  built.add(name);
}
