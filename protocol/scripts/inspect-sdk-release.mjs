#!/usr/bin/env node
import path from "node:path";
import { argumentsFor, verifyBundle } from "./sdk-release-artifacts.mjs";
const args = argumentsFor(process.argv.slice(2), ["--bundle", "--revision", "--manifest-sha256"]);
if (!args["--bundle"]) throw new Error("--bundle is required");
const { receipt } = verifyBundle(path.resolve(args["--bundle"] ?? ""), args["--revision"], args["--manifest-sha256"]);
console.log(JSON.stringify({ ok: true, revision: receipt.revision, packages: receipt.packages.map(p => ({ name: p.name, integrity: p.integrity })),
  publicationReady: !!receipt.compilerProof }));
