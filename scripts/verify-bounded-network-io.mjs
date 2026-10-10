#!/usr/bin/env node
// Re-run the offline PR3 gates, or check that the saved proof matches this source tree.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactPath = join(root, "verification", "bounded-network-io.json");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const git = (...args) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};
const baseSha = "7231e842d8ba69190ff11868554b9bf71d7c5082";
const sourceFiles = [...new Set([
  ...git("diff", "--name-only", baseSha, "--").split("\n"),
  ...git("ls-files", "--others", "--exclude-standard").split("\n"),
])].filter((file) => file && file !== "verification/bounded-network-io.json").sort();
const sourceSha256 = hash(sourceFiles.map((file) =>
  `${file}\0${existsSync(join(root, file)) ? hash(readFileSync(join(root, file))) : "deleted"}\n`).join(""));
const headSha = git("rev-parse", "HEAD");

if (process.argv.includes("--check")) {
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  if (artifact.baseSha !== baseSha || artifact.sourceSha256 !== sourceSha256 ||
      JSON.stringify(artifact.sourceFiles) !== JSON.stringify(sourceFiles) ||
      artifact.commands.some((command) => command.exitCode !== 0))
    throw new Error("bounded-network-io proof is stale or has a failed gate");
  console.log(`${artifactPath}\nsha256 ${hash(readFileSync(artifactPath))}`);
  process.exit(0);
}

const focused = ["npx", "vitest", "run",
  "protocol/packages/client/test/direct-client.test.ts",
  "protocol/packages/client/test/hash-chain-paid-fetch.test.ts",
  "protocol/packages/client/test/node-paid-fetch.test.ts",
  "protocol/packages/client/test/hash-chain-signer.test.ts",
  "protocol/packages/adapters/test/adapters.test.ts",
  "protocol/packages/adapters/test/pnn-transport.test.ts",
  "protocol/packages/server/test/direct-server.test.ts",
  "packages/demo-gateway/test/config.test.ts",
  "packages/demo-gateway/test/hash-chain-proxy.test.ts",
  "packages/demo-gateway/test/gateway.test.ts"];
const required = [
  ["node", "--test", "scripts/verify-bounded-network-io.test.mjs"],
  focused,
  ["npm", "--prefix", "protocol", "run", "verify"],
  ["npm", "test"],
  ["npm", "run", "site:build"],
  ["npm", "run", "site:check"],
  ...["validate:schemas", "check:protocol-isolation", "check:host-isolation",
    "check:browser-demo", "check:pnn-browser", "check:worker-types",
    "check:demo-gateway", "check:hash-chain-demo", "check:hash-chain-worker",
    "proof:offline", "check:diff"].map((name) => ["npm", "run", name]),
];
const commands = [];
for (const argv of required) {
  console.log(`Running ${argv.join(" ")}`);
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: root, encoding: "utf8", timeout: 900_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const vitestPasses = [...output.matchAll(/\bTests\s+(\d+) passed\s+\(\d+\)/g)]
    .reduce((count, match) => count + Number(match[1]), 0);
  const nodePasses = [...output.matchAll(/ℹ pass (\d+)/g)]
    .reduce((count, match) => count + Number(match[1]), 0);
  const entry = {
    argv, exitCode: result.status, signal: result.signal,
    passingTests: vitestPasses + nodePasses,
  };
  commands.push(entry);
  console.log(`${entry.exitCode === 0 ? "PASS" : "FAIL"} ${argv.join(" ")} (${entry.passingTests} tests)`);
  if (entry.exitCode !== 0) console.error(output.trim().split("\n").slice(-25).join("\n"));
}
const artifact = {
  schema: "kaspa-x402-bounded-network-io-proof/v1",
  branch: git("branch", "--show-current"),
  baseSha, headSha, sourceSha256,
  sourceFiles,
  findings: {
    csf_689da0dd966372097af326a6: ["protocol/packages/client/test/direct-client.test.ts", "protocol/packages/client/test/node-paid-fetch.test.ts"],
    csf_199510e80943b5cda1071693: ["protocol/packages/server/test/direct-server.test.ts", "packages/demo-gateway/test/hash-chain-proxy.test.ts"],
    csf_689a4f7a8fa42f9dbe77436c: ["protocol/packages/client/test/hash-chain-signer.test.ts", "protocol/packages/client/test/hash-chain-paid-fetch.test.ts", "scripts/check-browser-demo.mjs"],
    csf_4564c6b425bf5f62466a19b4: ["protocol/packages/adapters/test/pnn-transport.test.ts"],
    csf_acd63ad25d9834f933474e9e: ["protocol/packages/adapters/test/adapters.test.ts", "packages/demo-gateway/test/gateway.test.ts"],
    csf_497321332bb308753976b608: ["protocol/packages/adapters/test/adapters.test.ts"],
    csf_b4008edd75e4b62fd74fba41: ["protocol/packages/adapters/test/adapters.test.ts", "packages/demo-gateway/test/config.test.ts"],
  },
  supportedRuntimeTransport: {
    node: "ws maxPayload enforces frames and reassembled messages before MessageEvent; real socket regression covers oversize, fragmentation, cumulative and unsolicited traffic, and normal health; injected RPC factories require explicit bounded authority",
    browser: "Direct untrusted JSON PNN adapter has no bounded browser factory and fails closed; browser demo uses the separate Kaspa WASM RPC transport",
    worker: "Direct untrusted JSON PNN adapter has no bounded Worker factory and fails closed; a controlled bounded proxy is required for hosted PNN operation",
  },
  commands,
  totalPassingTests: commands.find((entry) => entry.argv.join(" ") === "npm test")?.passingTests ?? 0,
  limitations: [
    "Offline, isolated-browser, and single configured node proof only; no funded Testnet transaction was sent",
    "Hosted Worker omits paid offers and returns 503 for paid routes until a bounded PNN transport is provided; a separately configured hash-chain proxy can remain available",
    "The separate browser Kaspa WASM RPC transport has no pre-delivery limit proof in this artifact; direct JSON PNN use in browsers is unsupported",
    "Independent network corroboration remains PR4 scope",
  ],
};
writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`${artifactPath}\nsha256 ${hash(readFileSync(artifactPath))}`);
if (commands.some((entry) => entry.exitCode !== 0)) process.exitCode = 1;
