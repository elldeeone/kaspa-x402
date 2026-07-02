import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkEscrowFixtureReproducibility, checkUptoFixtureReproducibility } from "../packages/covenant/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const escrowFixture = JSON.parse(fs.readFileSync(path.join(root, "contracts/fixtures/kaspa-x402-escrow-v1.json"), "utf8"));
const escrowSource = fs.readFileSync(path.join(root, escrowFixture.source));
const escrowReport = checkEscrowFixtureReproducibility(escrowFixture, escrowSource);

const uptoFixture = JSON.parse(fs.readFileSync(path.join(root, "contracts/fixtures/kaspa-x402-upto-v1.json"), "utf8"));
const uptoSource = fs.readFileSync(path.join(root, uptoFixture.source));
const uptoReport = checkUptoFixtureReproducibility(uptoFixture, uptoSource);

console.log(`covenant fixtures ok (${escrowReport.checks.length + uptoReport.checks.length} checks)`);
