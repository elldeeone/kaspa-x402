import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  argumentsFor,
  cleanEnvironment,
  verifyBundle,
} from "../../protocol/scripts/sdk-release-artifacts.mjs";
import { normalizeNpmPackOutput } from "../../protocol/scripts/npm-pack-output.mjs";
import { writeNetworkFixture } from "../../protocol/scripts/sdk-network-fixture.mjs";

// Preparation may read source fixtures. The resulting consumer executes only
// installed archives and copied test code, in a directory outside this repo.
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const protocol = path.join(root, "protocol");
const args = argumentsFor(process.argv.slice(2), [
  "--bundle", "--revision", "--manifest-sha256", "--out",
]);
for (const option of ["--bundle", "--revision", "--manifest-sha256", "--out"])
  assert.ok(args[option], `${option} is required`);
const output = path.resolve(args["--out"]);
const relative = path.relative(root, output);
assert.ok(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
  "consumer must be outside the repository");
assert.ok(!fs.existsSync(output), "use a fresh consumer directory for each run");
const { receipt } = verifyBundle(path.resolve(args["--bundle"]),
  args["--revision"], args["--manifest-sha256"], true);
const digest = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

// Keep the reference/support code paired with the source that produced the SDK.
for (const [file, expected] of Object.entries(receipt.source.files))
  assert.equal(digest(path.join(protocol, file)), expected.sha256,
    `source differs from approved bundle: ${file}`);

fs.mkdirSync(output, { recursive: true, mode: 0o700 });
for (const folder of ["archives", "fixtures", "standard", "additive", "hash-chain", "batch", "examples"])
  fs.mkdirSync(path.join(output, folder), { mode: 0o700 });
const env = cleanEnvironment(path.join(output, "preparation-home"));
function run(command, argv, cwd, log) {
  const result = spawnSync(command, argv, { cwd, env, encoding: "utf8", timeout: 600_000 });
  fs.writeFileSync(path.join(output, log), (result.stdout ?? "") + (result.stderr ?? ""));
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed; see ${path.join(output, log)}`);
  return result.stdout;
}
const packages = {};
for (const pkg of receipt.packages) {
  const target = path.join(output, "archives", pkg.filename);
  fs.copyFileSync(path.join(path.resolve(args["--bundle"]), pkg.filename), target);
  assert.equal(digest(target), pkg.sha256);
  packages[pkg.name] = { file: pkg.filename, sha256: pkg.sha256, public: true };
}

// The documented source examples use a private facilitator, and real verifier
// tests use private adapters. Pack them as explicit test fixtures, not releases.
run("npm", ["run", "build"], protocol, "support-build.log");
for (const name of ["facilitator", "adapters"]) {
  const packed = normalizeNpmPackOutput(JSON.parse(run("npm", ["pack",
    "--workspaces=false", "--ignore-scripts", "--json", "--pack-destination",
    path.join(output, "archives")], path.join(protocol, "packages", name), `pack-${name}.log`)));
  const pkg = packed.find(item => item.name === `@kaspa-x402/${name}`);
  assert.ok(pkg, `missing source-support archive: ${name}`);
  packages[pkg.name] = { file: pkg.filename,
    sha256: digest(path.join(output, "archives", pkg.filename)), public: false };
}
fs.writeFileSync(path.join(output, "package.json"), JSON.stringify({ private: true,
  type: "module", dependencies: Object.fromEntries(Object.entries(packages)
    .map(([name, pkg]) => [name, `file:./archives/${pkg.file}`])) }, null, 2) + "\n");
run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], output, "install.log");
for (const name of Object.keys(packages))
  assert.equal(fs.lstatSync(path.join(output, "node_modules", name)).isSymbolicLink(), false);

for (const [network, name] of [["kaspa:testnet-10", "mock-testnet.mjs"], ["kaspa:mainnet", "mock-mainnet.mjs"]])
  writeNetworkFixture(protocol, path.join(output, "fixtures", name), network, { facilitator: false });
fs.cpSync(path.join(protocol, "vectors"), path.join(output, "fixtures", "vectors"), { recursive: true });
fs.cpSync(path.join(protocol, "examples"), path.join(output, "examples", "source"), { recursive: true });
for (const folder of ["standard", "additive", "hash-chain", "batch", "examples"])
  fs.cpSync(path.join(here, folder), path.join(output, folder), { recursive: true });
fs.copyFileSync(path.join(here, "run.mjs"), path.join(output, "run.mjs"));
const harnesses = {};
for (const file of fs.readdirSync(output, { recursive: true })) {
  if (!/^(standard|additive|hash-chain|batch|examples|fixtures)\//.test(file) ||
    !/\.(mjs|json)$/.test(file)) continue;
  harnesses[file] = digest(path.join(output, file));
}
fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify({
  revision: args["--revision"], node: process.version,
  baselineReleaseManifestSha256: args["--manifest-sha256"], packages, harnesses,
  evidenceBoundary: "Public archives plus explicit private source-support fixtures; controlled chain stress. Funded proof is separate.",
}, null, 2) + "\n");
console.log(JSON.stringify({ consumer: output, command: `node ${path.join(output, "run.mjs")}` }));
