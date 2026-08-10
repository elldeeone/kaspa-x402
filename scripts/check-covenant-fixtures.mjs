import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkEscrowFixtureReproducibility } from "../packages/covenant/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const escrowFixture = JSON.parse(fs.readFileSync(path.join(root, "contracts/fixtures/kaspa-x402-escrow-v2.json"), "utf8"));
const escrowSource = fs.readFileSync(path.join(root, escrowFixture.source));
const escrowReport = checkEscrowFixtureReproducibility(escrowFixture, escrowSource);

console.log(`covenant fixtures ok (${escrowReport.checks.length} checks)`);
