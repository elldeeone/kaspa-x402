import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkEscrowFixtureReproducibility } from "../packages/covenant/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(fs.readFileSync(path.join(root, "contracts/fixtures/kaspa-x402-escrow-v1.json"), "utf8"));
const source = fs.readFileSync(path.join(root, fixture.source));
const report = checkEscrowFixtureReproducibility(fixture, source);

console.log(`covenant fixtures ok (${report.checks.length} checks)`);
