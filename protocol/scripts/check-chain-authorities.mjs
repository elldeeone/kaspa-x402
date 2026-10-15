#!/usr/bin/env node
// Read-only preflight: never creates a signing key, grant or transaction.
import fs from "node:fs";
import { KaspaPnnClient, selectPnnChainEvidenceClient } from "@kaspa-x402/adapters";
import { createNodeBoundedPnnWebSocket } from "@kaspa-x402/adapters/pnn-node";
import { parseKaspaNetwork } from "@kaspa-x402/core";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--config") throw Error("usage: check-chain-authorities.mjs --config <private-json-file>");
const config = JSON.parse(fs.readFileSync(args[1], "utf8"));
const network = parseKaspaNetwork(config.network);
if (network === "kaspa:mainnet" && config.allowMainnet !== true) throw Error("mainnet requires allowMainnet");
if (!Array.isArray(config.authorities) || !config.authorities.every(a => Array.isArray(a.endpoints) && a.endpoints.length > 0)) throw Error("each independent authority needs endpoints");
const seen = new Set();
for (const authority of config.authorities) for (const endpoint of authority.endpoints) {
  const u = new URL(endpoint); u.hash = "";
  if (seen.has(u.href)) throw Error("one endpoint cannot represent multiple independent authorities");
  seen.add(u.href);
}
const makeClient = endpoints => new KaspaPnnClient({ network, allowMainnet: config.allowMainnet === true,
  endpoints, allowInsecureLoopback: config.allowInsecureLoopback === true, boundedWebSocketFactory: createNodeBoundedPnnWebSocket });
const submission = makeClient(config.submissionEndpoints ?? config.authorities[0].endpoints);
const client = selectPnnChainEvidenceClient({ mode: "independent-corroboration", requiredAuthorities: config.requiredAuthorities,
  submission,
  authorities: config.authorities.map(a => ({ trustDomain: a.trustDomain, client: makeClient(a.endpoints) })) });
await submission.health();
await client.health();
const snapshot = await client.snapshotHashChainUtxos(config.addresses ?? []);
console.log(JSON.stringify({ ok: true, network, requiredAuthorities: config.requiredAuthorities,
  trustDomains: config.authorities.map(a => a.trustDomain), checkpoint: snapshot.checkpoint, utxoCount: snapshot.utxos.length,
  evidenceBoundary: "Read-only agreement for declared administrative domains; operator independence and funded recovery require separate evidence." }, null, 2));
