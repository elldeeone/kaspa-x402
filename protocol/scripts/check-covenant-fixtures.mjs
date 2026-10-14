import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkEscrowFixtureReproducibility } from "../packages/covenant/dist/index.js";
import { generateEscrowFixture } from "./generate-covenant-fixture.mjs";
import { generateHashChainFixture } from "./generate-hash-chain-fixture.mjs";
import { withPinnedSilverScript } from "./silverscript-compiler.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length > 1 || args.some((arg) => arg !== "--internal-consistency-only"))
  throw new Error("usage: check-covenant-fixtures.mjs [--internal-consistency-only]");
let reproduction;
if (!args.includes("--internal-consistency-only")) {
  reproduction = withPinnedSilverScript(process.env.SILVERSCRIPT_DIR, (compiler) => {
    const artifacts = [generateEscrowFixture(compiler, { check: true }), generateHashChainFixture(compiler, { check: true })];
    return { artifacts, compilerProvenance: compiler.provenance() };
  });
}
const escrowFixture = JSON.parse(fs.readFileSync(path.join(root, "contracts/fixtures/kaspa-x402-escrow-v5.json"), "utf8"));
const escrowSource = fs.readFileSync(path.join(root, escrowFixture.source));
const escrowReport = checkEscrowFixtureReproducibility(escrowFixture, escrowSource);

console.log(JSON.stringify({ ok: true, compilerReproduced: !!reproduction, internalConsistencyChecks: escrowReport.checks.length, ...reproduction }));
