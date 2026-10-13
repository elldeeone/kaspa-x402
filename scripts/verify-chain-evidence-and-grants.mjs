#!/usr/bin/env node
// Re-run the offline gates or check this candidate against its pinned base.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactPath = join(root, "verification", "chain-evidence-and-grant-availability.json");
const baseSha = "6918defe91f5fd830c1a297aa72ce382c3428b94";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const git = (...args) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};
const headSha = git("rev-parse", "HEAD");
if (git("merge-base", baseSha, headSha) !== baseSha)
  throw new Error("recorded base is not an ancestor of the working-tree HEAD");
const sourceFiles = [...new Set([
  ...git("diff", "--name-only", baseSha, "--").split("\n"),
  ...git("ls-files", "--others", "--exclude-standard").split("\n"),
])].filter((file) => file && file !== "verification/chain-evidence-and-grant-availability.json").sort();
const sourceSha256 = hash(sourceFiles.map((file) =>
  `${file}\0${existsSync(join(root, file)) ? hash(readFileSync(join(root, file))) : "deleted"}\n`).join(""));

if (process.argv.includes("--check")) {
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  if (artifact.baseSha !== baseSha ||
    artifact.sourceSha256 !== sourceSha256 ||
    JSON.stringify(artifact.sourceFiles) !== JSON.stringify(sourceFiles) ||
    artifact.commands.some((command) => command.exitCode !== 0))
    throw new Error("chain-evidence and grant proof is stale or has a failed gate");
  console.log(`${artifactPath}\nsha256 ${hash(readFileSync(artifactPath))}`);
  process.exit(0);
}

const commands = [];
const required = [
  ["npx", "vitest", "run", "protocol/packages/adapters/test/adapters.test.ts",
    "protocol/packages/adapters/test/pnn-trust-boundary.test.ts",
    "protocol/packages/server/test/hash-chain-grants.test.ts", "protocol/packages/server/test/hash-chain-product.test.ts",
    "protocol/packages/server/test/direct-server.test.ts",
    "packages/demo-gateway/test/config.test.ts", "packages/demo-gateway/test/gateway.test.ts",
    "packages/demo-gateway/test/hash-chain-pnn-view.test.ts",
    "packages/demo-gateway/test/hash-chain-proxy.test.ts"],
  ["npm", "--prefix", "protocol", "run", "verify"],
  ["npm", "test"],
  ...["validate:schemas", "validate:tx-v1-consensus", "validate:reorg-consensus",
    "check:covenant-fixtures", "check:hash-chain-fixture", "check:protocol-isolation",
    "check:host-isolation", "site:build", "site:check", "check:browser-demo",
    "check:pnn-browser", "check:worker-types", "check:demo-gateway",
    "check:hash-chain-demo", "check:hash-chain-worker", "proof:offline", "check:diff"]
    .map((name) => ["npm", "run", name]),
  ["git", "diff", "--check"],
];
for (const argv of required) {
  console.log(`Running ${argv.join(" ")}`);
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: root, encoding: "utf8", timeout: 900_000, maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const vitestPasses = [...output.matchAll(/\bTests\s+(\d+) passed\s+\(\d+\)/g)]
    .reduce((count, match) => count + Number(match[1]), 0);
  const nodePasses = [...output.matchAll(/ℹ pass (\d+)/g)]
    .reduce((count, match) => count + Number(match[1]), 0);
  const entry = { argv, exitCode: result.status, signal: result.signal,
    passingTests: vitestPasses + nodePasses };
  commands.push(entry);
  console.log(`${entry.exitCode === 0 ? "PASS" : "FAIL"} ${argv.join(" ")} (${entry.passingTests} tests)`);
  if (entry.exitCode !== 0) console.error(output.trim().split("\n").slice(-28).join("\n"));
}

const artifact = {
  schema: "kaspa-x402-chain-evidence-and-grant-availability/v1",
  branch: git("branch", "--show-current"), baseSha, sourceSha256, sourceFiles,
  findings: {
    csf_7eae12cfa24c2a26e35632a3: ["protocol/packages/server/test/hash-chain-grants.test.ts",
      "protocol/packages/server/test/hash-chain-product.test.ts", "packages/demo-gateway/test/gateway.test.ts"],
    csf_33cd655a82fc168eff00df5e: ["protocol/packages/adapters/test/adapters.test.ts",
      "protocol/packages/server/test/direct-server.test.ts"],
    csf_9dbf8ad7ee69a2cfc2a39038: ["protocol/packages/adapters/test/adapters.test.ts",
      "protocol/packages/adapters/test/pnn-trust-boundary.test.ts",
      "packages/demo-gateway/test/config.test.ts"],
  },
  beforeFixFailingEvidence: [
    { test: "shallow selected-chain lineage with large blue-score jump", command: "npx vitest run protocol/packages/adapters/test/adapters.test.ts -t 'rejects a shallow covenant spend'", exitCode: 1,
      observed: "base accepted two selected positions as 30 confirmations" },
    { test: "enabled gateway missing explicit trust policy", command: "npx vitest run packages/demo-gateway/test/config.test.ts -t 'requires an explicit chain-evidence trust policy'", exitCode: 1,
      observed: "base accepted omitted trust policy" },
    { test: "unrestricted boolean grant admission", command: "npx vitest run protocol/packages/server/test/hash-chain-grants.test.ts -t 'rejects unrestricted boolean admission'", exitCode: 1,
      observed: "base accepted canClaim: () => true" },
    { test: "signed payer changes admission identity", command: "npx vitest run protocol/packages/server/test/hash-chain-grants.test.ts -t 'tombstones an abandoned funding outpoint'", exitCode: 1,
      observed: "candidate before dual-identity quota delivered another private grant" },
    { test: "pre-admission schema-v2 assignment", command: "npx vitest run protocol/packages/server/test/hash-chain-grants.test.ts -t 'pre-admission'", exitCode: 1,
      observed: "the old assignment made getCurrent and listHeads throw before recovery" },
    { test: "old schema-v2 claimant quota", command: "npx vitest run protocol/packages/server/test/hash-chain-grants.test.ts -t 'pre-admission schema-v2 assignment'", exitCode: 1,
      observed: "without a migrated admission row, the same payer claimed another head" },
    { test: "adjacent PNN tips", command: "npx vitest run protocol/packages/adapters/test/adapters.test.ts -t 'adjacent tips'", exitCode: 1,
      observed: "identical UTXOs at different selected tips conflicted; the first authority's lower DAA was later returned" },
    { test: "fresh funding after abandoned grant", command: "npx vitest run packages/demo-gateway/test/hash-chain-pnn-view.test.ts -t 'fresh funding'", exitCode: 1,
      observed: "the gateway repeatedly selected the lower-sorting tombstoned outpoint" },
    { test: "raw PNN client at protected authorization constructors", command: "npx vitest run protocol/packages/adapters/test/pnn-trust-boundary.test.ts", exitCode: 1,
      observed: "raw and missing clients were accepted, and single-source policy selection returned the raw client itself" },
  ],
  selectedParentDepth: {
    rpc: "GetVirtualChainFromBlockV2 with minConfirmationCount 0; count the ordered selected positions through the pinned checkpoint, including the accepting block",
    reason: "Rusty Kaspa 2.1.0 V2 filters by strict blue-score distance, not selected-parent position count",
    rustyKaspaCommit: "01b532e8b553523216471682649693af92f0fd16",
    shallow: "2 or 29 selected positions with blue-score delta > 30 reject",
    exact: "30 selected positions with irregular blue scores pass and persist measured count 30",
  },
  grantReservationAndRecovery: {
    commit: "Unique outpoint tombstone and quotas for signed payer key and host admission identity commit in the same SQL transaction as sealed assignment before private key delivery",
    recovery: "Expiry quarantines; owner-signed selected-chain rotation and fresh grants restore readiness; unchanged outpoint remains tombstoned",
    availability: "Another ready head serves while one requires rotation; exact and batch profiles remain available",
  },
  supportedTrustModes: ["trusted-single-source", "independent-corroboration"],
  secondNodeRequired: false,
  commands,
  totalPassingTests: commands.find((entry) => entry.argv.join(" ") === "npm test")?.passingTests ?? 0,
  limitations: [
    "Offline and isolated Worker proof only; no funded Testnet transaction or deployment was performed",
    "Single-source mode explicitly trusts one operator as the full payment authority",
    "Independent trust domains are configured by the host and cannot be established from URL count alone",
    "A payer can create fresh key and funding identities; the demo also limits the host admission identity, which derives from gateway client IP",
    "The Worker requires a pre-delivery bounded PNN transport to offer hosted paid routes",
    "Selected-chain traversal is bounded and rejects an acceptance older than its 4096-block or response-byte limit",
  ],
};
writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`${artifactPath}\nsha256 ${hash(readFileSync(artifactPath))}`);
if (commands.some((entry) => entry.exitCode !== 0)) process.exitCode = 1;
