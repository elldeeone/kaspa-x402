import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isPublishableDirtyPath } from "./site-inputs.mjs";
import { fileURLToPath } from "node:url";

import {
  ACTIVE_REDIRECTS,
  ARTIFACT_NOTES,
  CONTRACT_FILES,
  DOC_GROUPS,
  PUBLIC_DOC_FILES,
  PUBLISHABLE_PACKAGES,
  RELEASE_DOC_FILES,
  RELEASE_LOCK_DIR,
  RELEASE_SNAPSHOT_DIR,
  SITE_ASSET_FILES,
  SCHEMA_FILES,
  SITE_BASE_URL,
  SITE_DIST,
  SITE_PACKAGE_NAMES,
  SITE_SRC,
  SPEC_FILES,
  VENDORED_KASPA_WASM,
  VECTOR_GROUPS,
} from "./site-config.mjs";
import { releaseMetadataForHash } from "./release-metadata.mjs";
import { assertReleaseLocalSchema } from "./release-schema.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, SITE_DIST);
const requireClean = process.argv.includes("--require-clean");

const schemaFiles = SCHEMA_FILES;
const specFiles = SPEC_FILES;
const contractFiles = CONTRACT_FILES;
const docFiles = PUBLIC_DOC_FILES;
const releaseDocFiles = RELEASE_DOC_FILES;
const htmlSourceFiles = new Set([...specFiles, ...docFiles]);
const vectorFiles = trackedFiles("vectors").filter(
  (file) => file.endsWith(".json") || file.endsWith(".md"),
);
const publishedArtifactFiles = new Set([
  ...schemaFiles,
  ...specFiles,
  ...contractFiles,
  ...docFiles,
  ...vectorFiles,
]);
const siteScriptFiles = [
  "scripts/site-build.mjs",
  "scripts/site-check.mjs",
  "scripts/site-config.mjs",
  "scripts/site-serve.mjs",
];
const packages = readPackages();
const publicPackages = packages.filter((pkg) =>
  PUBLISHABLE_PACKAGES.includes(pkg.name),
);
const repositoryUrl = normalizeRepositoryUrl(
  readJson("package.json").repository?.url,
);
const releaseVersion =
  packages.find((pkg) => pkg.name === "@kaspa-x402/core")?.version ??
  "0.1.0-alpha.1";
const releasePath = `v${releaseVersion}`;
const releaseEntries = buildReleaseEntries();
const commit = git(["rev-parse", "HEAD"]);
const commitDate = git(["show", "-s", "--format=%cI", "HEAD"]);
const dirtyInputs = dirtyPublishableInputs();
const sourceState = dirtyInputs.length > 0 ? "working-tree-dirty" : "git-head";
const releaseSnapshotScope =
  "schemas, specs, covenant artifacts, selected docs, vectors, package metadata, and release metadata";
const activeAlphaOnlyRoutes = [
  "/",
  "/demo/",
  "/assets/",
  "/vendor/",
  "/site-manifest.json",
  "/releases/",
];

if (requireClean && dirtyInputs.length > 0) {
  throw new Error(
    `site build requires clean publishable inputs: ${dirtyInputs.join(", ")}`,
  );
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

copyStaticAssets();
writeHeaders();
writeRedirects();
writeText("robots.txt", "User-agent: *\nAllow: /\n");
writeText("favicon.ico", "");

const copiedArtifacts = [
  ...copyCollection(schemaFiles, "schemas"),
  ...copyCollection(specFiles, "spec"),
  ...copyCollection(contractFiles, "contracts"),
  ...copyCollection(docFiles, "docs"),
  ...copyCollection(vectorFiles, "vectors"),
];

const vectorIndex = buildVectorIndex(vectorFiles);
writeJson("vectors/index.json", vectorIndex);
writeJson("packages.json", {
  generatedFrom: commit,
  releaseVersion,
  packages: publicPackages,
});

writeIndexPages();
writeReleaseSnapshot(releaseArtifacts(copiedArtifacts), vectorIndex);
copyStoredReleaseSnapshots();
writeManifest(copiedArtifacts, vectorIndex);

function writeIndexPages() {
  writeHomePage();
  writeSchemasPage();
  writeSpecsPage();
  writeDocsPage();
  writeVectorsPage();
  writeReleasesPage();
  writeNotFoundPage();
  writeDemoPage();
  writePnnSpikeJson();

  for (const file of specFiles) writeMarkdownDocument(file, htmlRoute(file));
  for (const file of docFiles) writeMarkdownDocument(file, htmlRoute(file));
}

function writeHomePage() {
  const exactSnippet = `{
  "scheme": "exact",
  "network": "kaspa:<network>",
  "asset": "KAS",
  "amount": "<sompi>",
  "extra": {
    "binding": "kaspa-exact-v2",
    "paymentFlow": "upfront",
    "profile": "standard-native"
  }
}`;
  const batchSnippet = `{
  "scheme": "batch-settlement",
  "network": "kaspa:<network>",
  "asset": "KAS",
  "amount": "<max per-request sompi>",
  "extra": {
    "binding": "kaspa-escrow-v2",
    "templateId": "kaspa-x402-escrow-v3"
  }
}`;
  writeHtml(
    "index.html",
    layout(
      "Kaspa x402",
      `
  <main>
    <h1>Kaspa x402</h1>
    <p>Kaspa x402 is a proposed native Kaspa binding for <a href="https://www.x402.org">x402</a>, the HTTP 402 payment protocol. It lets HTTP APIs and MCP tools charge native KAS per request, and lets servers verify and settle those payments directly against the Kaspa network.</p>

    <h2 id="status">Status</h2>
    <ul>
      <li>Alpha reference: draft specs, JSON schemas, conformance vectors, and TypeScript packages under prerelease npm tags.</li>
      <li>Network target: <code>kaspa:testnet-10</code> only.</li>
      <li>Hosted gateway: <a href="https://demo.kaspa-x402.org"><code>demo.kaspa-x402.org</code></a> is the Testnet-10 integration endpoint. The unversioned site describes the ${escapeHtml(releaseVersion)} candidate source; Alpha.11 funded deployment proof is pending, and the <a href="/docs/testnet-gateway/">gateway reference</a> separates it from historical Alpha.10 evidence.</li>
      <li>Mainnet: blocked. <code>kaspa:mainnet</code> is a reserved profile name; the blocking gates are listed in <a href="/docs/mainnet-readiness/">mainnet readiness</a>. Do not use any of this with production funds.</li>
      <li>Standards: the <code>kaspa:*</code> network identifiers are draft binding names, not accepted x402 registry or CAIP entries.</li>
      <li>Stability: package names, schemas, and field names may change until the first tagged spec release. See the <a href="/docs/versioning-policy/">versioning policy</a>.</li>
    </ul>
    <p class="muted">Generated from commit <code>${escapeHtml(commit.slice(0, 12))}</code> (${escapeHtml(commitDate.slice(0, 10))}). Unversioned routes track the active alpha; immutable snapshots are listed under <a href="/releases/">releases</a>.</p>

    <h2>What is x402</h2>
    <p>x402 is an open protocol that turns the HTTP <code>402 Payment Required</code> status code into a machine-payable flow: a server answers an unpaid request with a 402 carrying a machine-readable offer, the client retries with a signed payment payload, and the server verifies the payment, settles it, and serves the response. The same primitives work over HTTP headers and MCP <code>_meta</code> fields, so paid APIs and tools are usable by autonomous agents. See <a href="https://www.x402.org">x402.org</a>.</p>

    <h2>What is Kaspa</h2>
    <p>Kaspa is a proof-of-work layer 1 whose blockDAG consensus produces blocks at sub-second cadence with native UTXO semantics. See <a href="https://kaspa.org">kaspa.org</a>.</p>

    <h2>Why a native Kaspa binding</h2>
    <p>The claims below are engineering rationale, each specified or backed by testnet evidence. None of them is a mainnet claim.</p>
    <ul>
      <li><strong>Settlement latency close to request latency.</strong> Paying per HTTP request only works when payment confirmation is not the slow path. Kaspa's block cadence makes one-shot native payments practical at request time; the <a href="/docs/live-testnet-report/">live testnet report</a> records executed end-to-end flows.</li>
      <li><strong>Small per-request prices.</strong> Amounts are decimal strings in sompi (1 KAS = 100,000,000 sompi). KIP-9 storage mass depends on the complete transaction shape; Kaspa does not define a universal 0.1 KAS consensus dust floor. The reference runtime applies a conservative 10,000,000 sompi output policy. <a href="/spec/kaspa-batch-settlement-v2/">Batch-settlement</a> vouchers can price individual requests below that application policy.</li>
      <li><strong>Direct verification, no facilitator lock-in.</strong> Kaspa is UTXO-native, so a server can verify and settle against a node it trusts: payment identity is bound to transaction ids, outpoints, and script-public-key material rather than to a hosted intermediary. A <a href="/spec/facilitator-profile/">self-hosted facilitator profile</a> exists for x402 <code>/supported</code>, <code>/verify</code>, <code>/settle</code> compatibility, but it is optional.</li>
      <li><strong>Escrow channels for repeated requests.</strong> For clients making many small or variable-cost calls, <a href="/spec/kaspa-batch-settlement-v2/">batch settlement</a> creates one singleton KIP-20 genesis, signs lifetime cumulative ceilings off-chain, supports repeated partial claims and same-lineage top-ups, and ends with a timed refund. The stable covenant ID and A/S/T accounting survive successor rotation and runtime restart.</li>
    </ul>

    <h2>Payment schemes</h2>
    <p>The binding ships two schemes with different settlement shapes.</p>
    <p><code>exact</code> — fixed-price one-shot native transfer under <a href="/spec/kaspa-exact-v2/">kaspa-exact-v2</a>. <code>standard-native</code> is the default ordinary KAS transfer. The optional <code>additive</code> profile consumes and recreates a reusable merchant KIP-10 head; the successor increase is the sole exact payment, with no second merchant output and no per-offer inventory reservation.</p>
    <pre><code>${escapeHtml(exactSnippet)}</code></pre>
    <p><code>batch-settlement</code> — repeated or variable-cost requests against a KIP-20 escrow lane. Its lifecycle is singleton genesis → repeated partial claims → top-up → refund. The current outpoint and V rotate while the stable covenant ID and lifetime A/S/T remain recoverable; R is the advertised minimum successor reserve. Spec: <a href="/spec/kaspa-batch-settlement-v2/">kaspa-batch-settlement-v2</a>.</p>
    <pre><code>${escapeHtml(batchSnippet)}</code></pre>

    <h2>Start here</h2>
    <ul>
      <li><strong>Implementing:</strong> read the <a href="/docs/demo-implementer-guide/">implementer guide</a>, the <a href="/spec/kaspa-x402-v1/">core binding</a>, the relevant <a href="/spec/kaspa-exact-v2/">exact</a> or <a href="/spec/kaspa-batch-settlement-v2/">batch-settlement</a> scheme, and the <a href="/vectors/">conformance vectors</a>.</li>
      <li><strong>Testing:</strong> use the <a href="/docs/testnet-gateway/">hosted gateway reference</a> and the <a href="/demo/">browser demo</a>.</li>
      <li><strong>Reviewing:</strong> start with the <a href="/docs/security-threat-model/">threat model</a>, <a href="/docs/live-testnet-report/">live testnet report</a>, and <a href="/docs/mainnet-readiness/">mainnet readiness gates</a>.</li>
    </ul>

    <h2 id="packages">Packages</h2>
    <p>Install with an explicit prerelease tag or exact version; <code>latest</code> dist-tags are not the recommended alpha install path.</p>
    <pre><code>npm install ${escapeHtml(releaseNpmInstall().join(" "))}</code></pre>
    ${packagesTable()}
    <p class="muted">Machine-readable: <a href="/packages.json"><code>packages.json</code></a>, <a href="/site-manifest.json"><code>site-manifest.json</code></a>.</p>
  </main>
      `,
    ),
  );
}

function writeSchemasPage() {
  const rows = schemaFiles.map((file) =>
    annotatedRow(
      `/${file}`,
      path.basename(file),
      ARTIFACT_NOTES[file],
      sha256File(path.join(root, file)),
    ),
  );
  writeHtml(
    "schemas/index.html",
    layout(
      "Schemas",
      `
  <main>
    <h1>Schemas</h1>
    <p>Canonical JSON Schemas for the wire format. Each schema's <code>$id</code> resolves to its path on this site, and the served files are byte-identical to the repository sources.</p>
    ${statusLine()}
    ${annotatedTable("Schema", rows)}
  </main>
      `,
    ),
  );
}

function writeSpecsPage() {
  const rows = specFiles.map((file) =>
    annotatedRow(
      `/${htmlRoute(file)}/`,
      path.basename(file, ".md"),
      ARTIFACT_NOTES[file],
      sha256File(path.join(root, file)),
    ),
  );
  writeHtml(
    "spec/index.html",
    layout(
      "Spec",
      `
  <main>
    <h1>Spec</h1>
    <p>Current binding and transport documents, in suggested reading order. Historical versions remain available in the immutable <a href="/releases/">release snapshots</a>.</p>
    ${statusLine()}
    ${annotatedTable("Document", rows, { hashes: false })}
  </main>
      `,
    ),
  );
}

function writeDocsPage() {
  const sections = DOC_GROUPS.map((group) => {
    const rows = group.files.map((file) =>
      annotatedRow(
        `/${htmlRoute(file)}/`,
        path.basename(file, ".md"),
        ARTIFACT_NOTES[file],
        sha256File(path.join(root, file)),
      ),
    );
    return `<h2>${escapeHtml(group.title)}</h2>\n    ${annotatedTable("Document", rows, { hashes: false })}`;
  }).join("\n    ");
  writeHtml(
    "docs/index.html",
    layout(
      "Docs",
      `
  <main>
    <h1>Docs</h1>
    <p>Selected public documents, grouped by what they are for.</p>
    ${statusLine()}
    ${sections}
  </main>
      `,
    ),
  );
}

function writeVectorsPage() {
  const grouped = new Map();
  const rootFiles = [];
  for (const file of vectorFiles) {
    const parts = file.split("/");
    if (parts.length >= 3) {
      const dir = parts[1];
      if (!grouped.has(dir)) grouped.set(dir, []);
      grouped.get(dir).push(file);
    } else if (path.basename(file) !== "README.md") {
      rootFiles.push(file);
    }
  }
  const orderedGroups = [
    ...VECTOR_GROUPS.filter((group) => grouped.has(group.dir)),
    ...[...grouped.keys()]
      .filter((dir) => !VECTOR_GROUPS.some((group) => group.dir === dir))
      .sort()
      .map((dir) => ({ dir, note: "" })),
  ];
  const sections = orderedGroups
    .map(({ dir, note }) => {
      const rows = grouped
        .get(dir)
        .map((file) =>
          annotatedRow(
            `/${file}`,
            file.split("/").slice(2).join("/"),
            "",
            sha256File(path.join(root, file)),
          ),
        );
      return `<h2><code>${escapeHtml(dir)}/</code></h2>
    ${note ? `<p>${inlineMarkdown(note, "")}</p>` : ""}
    ${annotatedTable("File", rows, { notes: false })}`;
    })
    .join("\n    ");
  const otherRows = rootFiles.map((file) =>
    annotatedRow(
      `/${file}`,
      path.basename(file),
      "",
      sha256File(path.join(root, file)),
    ),
  );
  writeHtml(
    "vectors/index.html",
    layout(
      "Vectors",
      `
  <main>
    <h1>Vectors</h1>
    <p>Conformance fixtures for implementations to validate against. <a href="/vectors/index.json"><code>index.json</code></a> lists byte counts and SHA-256 digests for every file; <a href="/vectors/README.md"><code>README.md</code></a> covers how fixtures are produced.</p>
    ${statusLine()}
    ${sections}
    ${otherRows.length > 0 ? `<h2>Other files</h2>\n    ${annotatedTable("File", otherRows, { notes: false })}` : ""}
  </main>
      `,
    ),
  );
}

function writeReleasesPage() {
  const rows = releaseEntries
    .map((entry) => {
      const path = `v${entry.version}`;
      const hash = entry.contentSha256
        ? `<code>${escapeHtml(entry.contentSha256.slice(0, 16))}</code>`
        : "active build";
      return `<tr><td><code>${escapeHtml(entry.version)}</code></td><td><a href="/${path}/"><code>/${path}/</code></a></td><td><a href="/${path}/release.json"><code>release.json</code></a></td><td>${hash}</td></tr>`;
    })
    .join("");
  writeHtml(
    "releases/index.html",
    layout(
      "Releases",
      `
  <main>
    <h1>Releases</h1>
    <p>Immutable snapshots of the published surface, one per release. Unversioned routes track the active alpha; snapshot content is hash-locked.</p>
    <p>Install alpha packages with an explicit prerelease tag or exact version; <code>latest</code> dist-tags are not the recommended alpha install path.</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Version</th><th>Snapshot</th><th>Metadata</th><th>Lock</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </main>
      `,
    ),
  );
}

function writeNotFoundPage() {
  writeHtml(
    "404.html",
    layout(
      "Not Found",
      `
  <main>
    <h1>Not Found</h1>
    <p>The requested page is not published on this site. Use <a href="/releases/">releases</a> for immutable snapshots or return to the <a href="/">current alpha reference</a>.</p>
  </main>
      `,
    ),
  );
}

function writeDemoPage() {
  writeHtml(
    "demo/index.html",
    layout(
      "Browser Test Client",
      `
  <main>
    <h1>Browser Test Client</h1>
    <p class="muted">Testnet-only browser client for inspecting Kaspa x402 offers, checking public-node connectivity, and rehearsing exact or Alpha.11 batch payment headers. The hosted gateway at <a href="https://demo.kaspa-x402.org"><code>demo.kaspa-x402.org</code></a> is the Testnet-10 integration endpoint; Alpha.11 funded deployment proof is pending. See the <a href="/docs/testnet-gateway/">gateway reference</a> for the candidate boundary and historical Alpha.10 evidence.</p>

    <section class="demo-panel" aria-labelledby="demo-safety">
      <h2 id="demo-safety">Safety Boundary</h2>
      <ul>
        <li>The network is fixed to <code>kaspa:testnet-10</code>; there is no mainnet selector.</li>
        <li>Generated or imported private keys stay in browser memory. The page does not write key material to local storage, cookies, query strings, or the server.</li>
        <li>Reset clears the in-memory key, visible fields, and RPC connection state.</li>
        <li>The only signed data that should leave the page is a transaction you intentionally broadcast through the public node network.</li>
        <li>The apex domain hosts static files only. The hosted gateway and its paid test resources run on the separate <code>demo.kaspa-x402.org</code> subdomain.</li>
      </ul>
    </section>

    <section class="demo-panel" aria-labelledby="demo-runtime">
      <h2 id="demo-runtime">Runtime Status</h2>
      <div class="demo-actions">
        <button type="button" id="demo-init">Load SDK</button>
        <button type="button" id="demo-connect">Connect PNN</button>
        <button type="button" id="demo-disconnect">Disconnect</button>
        <button type="button" id="demo-reset">Reset</button>
      </div>
      <label for="demo-endpoint">Endpoint override</label>
      <input id="demo-endpoint" type="url" inputmode="url" placeholder="leave blank to try public WSS endpoints">
      <p class="muted">Public HTTPS pages must use the listed <code>wss://</code> endpoints. Local custom endpoints require a local preview opened with <code>?allow-custom-endpoints=1&amp;endpoint=...</code>; the field must match that local or private-network endpoint.</p>
      <output id="demo-status" class="demo-status">Not loaded.</output>
      <pre id="demo-rpc-output"><code>{}</code></pre>
    </section>

    <section class="demo-panel" aria-labelledby="demo-key">
      <h2 id="demo-key">Testnet Key</h2>
      <form autocomplete="off">
        <div class="demo-actions">
          <button type="button" id="demo-generate-key">Generate Throwaway Key</button>
          <button type="button" id="demo-import-key">Import Key</button>
          <button type="button" id="demo-copy-address">Copy Address</button>
        </div>
        <label for="demo-private-key">Private key hex</label>
        <input id="demo-private-key" type="password" autocomplete="off" spellcheck="false" placeholder="64 hex characters">
        <p class="muted">Import only throwaway testnet keys. Do not import a key that controls mainnet funds; the same private key can derive addresses on multiple Kaspa networks.</p>
        <label class="demo-check"><input id="demo-reveal-key" type="checkbox"> Show private key</label>
        <label for="demo-address">Address</label>
        <input id="demo-address" type="text" readonly spellcheck="false">
        <div class="demo-actions">
          <button type="button" id="demo-load-utxos">Load UTXOs</button>
        </div>
        <pre id="demo-utxo-output"><code>{}</code></pre>
      </form>
    </section>

    <section class="demo-panel" aria-labelledby="demo-offer">
      <h2 id="demo-offer">x402 Offer Builder</h2>
      <div class="demo-grid">
        <label>Profile
          <select id="demo-profile">
            <option value="exact">exact</option>
            <option value="batch-settlement">batch-settlement</option>
          </select>
        </label>
        <label>Amount (sompi)
          <input id="demo-amount" type="text" inputmode="numeric" value="20000000">
        </label>
        <label>Timeout seconds
          <input id="demo-timeout" type="number" min="1" max="4294967295" value="60">
        </label>
        <label>Finality
          <select id="demo-finality">
            <option value="accepted">accepted</option>
            <option value="confirmed">confirmed</option>
          </select>
        </label>
      </div>
      <label for="demo-resource-url">Resource URL</label>
      <input id="demo-resource-url" type="url" value="https://example.test/paid-resource">
      <label for="demo-description">Resource description</label>
      <input id="demo-description" type="text" value="Test paid resource">
      <label for="demo-pay-to">Pay-to address</label>
      <input id="demo-pay-to" type="text" spellcheck="false" placeholder="kaspatest:...">
      <div id="demo-batch-fields" hidden>
        <h3>Alpha.11 Batch Requirements</h3>
        <label for="demo-server-public-key">Server public key</label>
        <input id="demo-server-public-key" type="text" spellcheck="false" value="22222222222222222222222222222222222222222222222222222222222222bb">
        <label for="demo-min-deposit">Minimum deposit (sompi)</label>
        <input id="demo-min-deposit" type="text" inputmode="numeric" value="20000000">
        <label for="demo-refund-daa">Refund timeout DAA</label>
        <input id="demo-refund-daa" type="text" inputmode="numeric" value="1000000">
        <h3>Current Lane And Voucher</h3>
        <p class="muted"><code>covenantId</code> is the stable KIP-20 lineage; it does not locate the UTXO. The current outpoint and script must be persisted and advanced after every accepted claim or top-up.</p>
        <label for="demo-channel-id">Channel id</label>
        <input id="demo-channel-id" type="text" spellcheck="false" value="4444444444444444444444444444444444444444444444444444444444444444">
        <label for="demo-covenant-id">Covenant id (stable)</label>
        <input id="demo-covenant-id" type="text" spellcheck="false" value="7777777777777777777777777777777777777777777777777777777777777777">
        <div class="demo-grid">
          <label>Current outpoint txid
            <input id="demo-current-txid" type="text" spellcheck="false" value="8888888888888888888888888888888888888888888888888888888888888888">
          </label>
          <label>Current outpoint index
            <input id="demo-current-index" type="number" min="0" max="4294967295" value="1">
          </label>
        </div>
        <label for="demo-current-script-public-key">Current serialized script public key</label>
        <textarea id="demo-current-script-public-key" rows="2" spellcheck="false">0000aa20055732f4cde47799ad439700e5055c9670feaaec97381746f908584bb39f980987</textarea>
        <div class="demo-grid">
          <label>Current covenant value (V)
            <input id="demo-funding-amount" type="text" inputmode="numeric" value="88300000">
          </label>
          <label>Lifetime charged (A)
            <input id="demo-charged-amount" type="text" inputmode="numeric" value="2500000">
          </label>
          <label>Lifetime claimed (S)
            <input id="demo-claimed-amount" type="text" inputmode="numeric" value="1700000">
          </label>
          <label>Signed lifetime ceiling (T)
            <input id="demo-signed-max" type="text" inputmode="numeric" value="30000000">
          </label>
          <label>Advertised claim reserve (R)
            <input id="demo-claim-reserve" type="text" inputmode="numeric" value="10000000">
          </label>
          <label>Partial claim preview (D)
            <input id="demo-partial-claim" type="text" inputmode="numeric" value="800000">
          </label>
        </div>
        <label for="demo-voucher-signature">Voucher signature (schema-only sample)</label>
        <textarea id="demo-voucher-signature" rows="2" spellcheck="false">cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd</textarea>
        <p class="muted">The preview enforces <code>0 &lt;= S &lt;= A &lt;= T</code> and <code>(T - S) + R &lt;= V</code>. A partial claim advances <code>S</code> and reduces <code>V</code>; <code>A</code>, <code>T</code>, the voucher signature, and <code>covenantId</code> stay unchanged.</p>
      </div>
      <div class="demo-actions">
        <button type="button" id="demo-build-offer">Build Offer</button>
        <button type="button" id="demo-copy-required">Copy PAYMENT-REQUIRED</button>
      </div>
      <label for="demo-payment-required">PAYMENT-REQUIRED</label>
      <textarea id="demo-payment-required" readonly rows="4"></textarea>
      <pre id="demo-offer-output"><code>{}</code></pre>
    </section>

    <section class="demo-panel" aria-labelledby="demo-mock">
      <h2 id="demo-mock">Mock Payment Retry</h2>
      <p class="muted">Use this to rehearse the selected 402 retry envelope. Exact uses a schema-only request authorization. Batch uses a schema-only voucher signature and shows the current lane plus a partial-claim successor. These placeholders are not valid settlement evidence.</p>
      <div id="demo-exact-payment-fields">
        <label for="demo-transaction">Signed transaction artifact</label>
        <textarea id="demo-transaction" rows="4" spellcheck="false" placeholder="safe JSON Transaction object from the SDK; a deterministic placeholder is used if empty"></textarea>
        <div class="demo-grid">
          <label>Payment output index
            <input id="demo-output-index" type="number" min="0" max="4294967295" value="0">
          </label>
          <label>Observed transaction id
            <input id="demo-transaction-id" type="text" spellcheck="false" placeholder="required 64 hex characters">
          </label>
        </div>
      </div>
      <div class="demo-actions">
        <button type="button" id="demo-build-payment">Build Payment Retry</button>
        <button type="button" id="demo-copy-signature">Copy PAYMENT-SIGNATURE</button>
        <span id="demo-exact-payment-actions" class="demo-inline-actions">
          <button type="button" id="demo-check-tx">Check Tx Status</button>
          <button type="button" id="demo-broadcast-tx">Broadcast Transaction JSON</button>
        </span>
      </div>
      <label for="demo-payment-signature">PAYMENT-SIGNATURE</label>
      <textarea id="demo-payment-signature" readonly rows="4"></textarea>
      <pre id="demo-payment-output"><code>{}</code></pre>
    </section>

    <section class="demo-panel" aria-labelledby="demo-narrow">
      <h2 id="demo-narrow">Offer Compatibility Debug</h2>
      <p class="muted">Paste a PaymentRequired JSON object to see which entries are supported by this Kaspa binding and which entries a client would skip during selection.</p>
      <textarea id="demo-narrow-input" rows="6" spellcheck="false" placeholder='{"x402Version":2,"resource":{"url":"https://example.test"},"accepts":[]}'></textarea>
      <div class="demo-actions">
        <button type="button" id="demo-narrow-offer">Inspect Accepts</button>
      </div>
      <pre id="demo-narrow-output"><code>{}</code></pre>
    </section>

    <section class="demo-panel" aria-labelledby="demo-notes">
      <h2 id="demo-notes">Developer Notes</h2>
      <ul>
        <li>Run locally with <code>npm run site:serve</code> and open <code>/demo/</code>. The local preview binds to the LAN; use the host IP from another device. Add <code>?allow-custom-endpoints=1&amp;endpoint=...</code> only when testing a local or private-network node endpoint.</li>
        <li>Fund generated addresses with testnet funds only. The Kaspa testnet page lists a TN10 faucet at <a href="https://faucet-tn10.kaspanet.io/">faucet-tn10.kaspanet.io</a>; a local or private faucet is also suitable.</li>
        <li>The browser SDK is loaded from <code>/vendor/kaspa-wasm/2.0.0/kaspa-core/</code>. The browser uses public WSS endpoints directly; <code>npm run check:pnn-browser</code> verifies resolver lookup from Node. Runtime spike metadata is available at <a href="/demo/pnn-spike.json"><code>/demo/pnn-spike.json</code></a>.</li>
        <li>The published TypeScript helpers are currently Node-oriented for header encoding and hashing. This page uses browser-native header encoding until a browser-safe package build is added.</li>
        <li>Public Node Network endpoints are shared test infrastructure. Treat outages, latency, and endpoint rotation as expected development failures.</li>
      </ul>
    </section>
  </main>
  <script type="module" src="/assets/demo.js"></script>
      `,
      { head: '  <link rel="stylesheet" href="/assets/demo.css">' },
    ),
  );
}

function writePnnSpikeJson() {
  writeJson("demo/pnn-spike.json", {
    generatedFrom: commit,
    generatedAt: commitDate,
    network: "kaspa:testnet-10",
    sdk: {
      package: VENDORED_KASPA_WASM.package,
      version: VENDORED_KASPA_WASM.version,
      route: VENDORED_KASPA_WASM.route,
      source: VENDORED_KASPA_WASM.source,
      assets: siteAssetRecords("site/src/vendor/kaspa-wasm/2.0.0/kaspa-core/"),
    },
    browser: {
      status: "covered by check:browser-demo",
      connection:
        "Public wss endpoint list; resolver lookup covered by the Node smoke script",
      verifiedCapabilities: [
        "sdk initialization",
        "throwaway testnet key generation",
        "exact header generation",
        "Alpha.11 batch voucher header generation",
        "batch A/S/T/V/R invariant checks",
        "batch partial-claim successor preview",
        "mixed-offer narrowing",
        "node info",
        "DAA score",
        "transaction status lookup missing-entry path",
      ],
      constraints: [
        "testnet-only",
        "no implicit key persistence",
        "manual transaction broadcast only",
      ],
    },
    worker: {
      status:
        "Alpha.11 candidate source for https://demo.kaspa-x402.org; funded cutover proof is pending and the recorded funded evidence is Alpha.10",
      verifiedCapabilities: [
        "REST chain health",
        "Durable Object state",
        "exact 402 offers",
        "standard-native exact settlement and idempotent replay",
        "cross-resource exact replay rejection",
        "batch-settlement 402 offers",
        "unsupported-scheme rejection",
      ],
      constraints: [
        "testnet-only",
        "claim broadcasting disabled",
        "not part of the apex static site",
        "testnet integration only; not a production or mainnet service",
      ],
    },
    packageBoundary: {
      browserSafeToday: [
        "static schemas",
        "browser SDK",
        "browser-native header encoder",
      ],
      needsAdapter: [
        "@kaspa-x402/core header helpers currently use Buffer",
        "@kaspa-x402/core hashing helpers currently use node:crypto",
      ],
    },
  });
}

function statusLine() {
  return `<p class="muted">Status: draft alpha targeting <code>kaspa:testnet-10</code>. Mainnet use remains blocked by the documented readiness gates.</p>`;
}

function annotatedRow(href, label, note, sha256) {
  return {
    cells: [
      `<a href="${escapeAttribute(href)}"><code>${escapeHtml(label)}</code></a>`,
      note ? inlineMarkdown(note, "") : "",
      `<code>${sha256.slice(0, 16)}</code>`,
    ],
  };
}

function annotatedTable(
  artifactHeading,
  rows,
  { notes = true, hashes = true } = {},
) {
  const headers = [artifactHeading];
  if (notes) headers.push("Purpose");
  if (hashes) headers.push("SHA-256 prefix");
  const body = rows
    .map((row) => {
      const cells = [row.cells[0]];
      if (notes) cells.push(row.cells[1]);
      if (hashes) cells.push(row.cells[2]);
      return `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
    })
    .join("");
  return `<div class="table-wrap"><table><thead><tr>${headers.map((heading) => `<th>${escapeHtml(heading)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function packagesTable() {
  const rows = publicPackages
    .map(
      (pkg) =>
        `<tr><td><code>${escapeHtml(pkg.name)}</code></td><td><code>${escapeHtml(pkg.version)}</code></td><td>${pkg.private ? "Repository only" : `<a href="${npmPackageUrl(pkg.name)}">npm</a>`}</td><td><a href="${repositoryUrl}/tree/${commit}/${pkg.path}">source</a></td></tr>`,
    )
    .join("");
  return `<div class="table-wrap"><table><thead><tr><th>Package</th><th>Version</th><th>Registry</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function copyCollection(files, routeRoot) {
  return files.map((file) => {
    const target = `${routeRoot}/${path.relative(routeRoot, file)}`;
    copyFile(file, target);
    return artifactRecord(file, target);
  });
}

function releaseArtifacts(copiedArtifacts) {
  const releaseSources = [
    ...schemaFiles,
    ...specFiles,
    ...contractFiles,
    ...releaseDocFiles,
    ...vectorFiles,
  ];
  const copiedBySource = new Map(
    copiedArtifacts.map((artifact) => [artifact.source, artifact]),
  );
  return releaseSources.map(
    (source) => copiedBySource.get(source) ?? artifactRecord(source, source),
  );
}

function copyStaticAssets() {
  copyFile("site/src/styles.css", "assets/styles.css");
  for (const file of SITE_ASSET_FILES) {
    copyFile(file, path.relative(SITE_SRC, file).replaceAll(path.sep, "/"));
  }
}

function writeReleaseSnapshot(copiedArtifacts, vectorIndex) {
  const releaseLock = readReleaseLock(releaseVersion);
  if (releaseLock?.frozen === true) {
    const source = `${RELEASE_SNAPSHOT_DIR}/${releasePath}`;
    if (!fs.existsSync(path.join(root, source))) {
      throw new Error(
        `frozen release ${releaseVersion} is missing ${RELEASE_SNAPSHOT_DIR}/${releasePath}`,
      );
    }
    copyTrackedSnapshot(source, releasePath);
    return;
  }
  const releaseArtifacts = [];
  for (const artifact of copiedArtifacts) {
    const target = `${releasePath}/${artifact.target}`;
    if (artifact.source.startsWith("schemas/"))
      copyVersionedSchema(artifact.source, target);
    else copyFile(artifact.source, target);
    releaseArtifacts.push({
      source: artifact.source,
      target,
      bytes: fs.statSync(path.join(outDir, target)).size,
      sha256: sha256File(path.join(outDir, target)),
    });
  }
  const releasePackages = releasePackagesMetadata();
  writeJson(`${releasePath}/packages.json`, releasePackages);
  writeJson(`${releasePath}/vectors/index.json`, vectorIndex);
  writeHtml(`${releasePath}/index.html`, releaseIndexHtml(releaseArtifacts));

  const releaseProvenance =
    dirtyInputs.length > 0
      ? {
          generatedFrom: commit,
          commitDate,
          sourceState,
          dirtyInputs,
        }
      : {
          sourceState: "locked",
          dirtyInputs: [],
        };
  const releaseWithoutHash = releaseMetadata(
    releaseLock,
    releaseArtifacts,
    releaseProvenance,
  );
  const contentSha256 = releaseContentHash(releaseWithoutHash);
  if (!releaseLock && (requireClean || dirtyInputs.length === 0)) {
    throw new Error(
      `release ${releaseVersion} is missing a content lock in ${RELEASE_LOCK_DIR}`,
    );
  }
  if (
    releaseLock &&
    releaseLock.contentSha256 !== contentSha256 &&
    (requireClean || dirtyInputs.length === 0)
  ) {
    throw new Error(
      `release ${releaseVersion} content differs from ${releaseLock.path}; bump the package version or update the release lock`,
    );
  }

  const release = {
    ...releaseWithoutHash,
    contentSha256,
  };

  writeJson(`${releasePath}/release.json`, release);
}

function copyStoredReleaseSnapshots() {
  for (const entry of releaseEntries) {
    const snapshotPath = `v${entry.version}`;
    if (snapshotPath === releasePath) continue;
    const source = `${RELEASE_SNAPSHOT_DIR}/${snapshotPath}`;
    if (!fs.existsSync(path.join(root, source))) {
      throw new Error(
        `release ${entry.version} is locked but missing ${RELEASE_SNAPSHOT_DIR}/${snapshotPath}`,
      );
    }
    copyTrackedSnapshot(source, snapshotPath);
  }
}

function copyTrackedSnapshot(sourceDirectory, targetDirectory) {
  const targetRoot = path.join(outDir, targetDirectory);
  fs.rmSync(targetRoot, { recursive: true, force: true });
  for (const source of trackedFiles(sourceDirectory)) {
    const relative = path
      .relative(sourceDirectory, source)
      .replaceAll(path.sep, "/");
    copyFile(source, `${targetDirectory}/${relative}`);
  }
}

function releaseMetadata(releaseLock, releaseArtifacts, releaseProvenance) {
  return {
    version: releaseVersion,
    ...releaseProvenance,
    contentLock: releaseLock?.path,
    snapshotScope: releaseSnapshotScope,
    activeAlphaOnlyRoutes,
    unversionedRoutes:
      "active alpha; not part of the immutable release snapshot",
    npmInstall: releaseNpmInstall(),
    artifacts: releaseArtifacts,
  };
}

function releaseIndexHtml(releaseArtifacts) {
  return snapshotLayout(
    `Release ${releaseVersion}`,
    `
      <main>
        <h1>Release ${escapeHtml(releaseVersion)}</h1>
        <p>Status: locked alpha snapshot for this version. Machine-readable metadata is available at <a href="/${releasePath}/release.json"><code>/${releasePath}/release.json</code></a>.</p>
        <p>This snapshot locks ${escapeHtml(releaseSnapshotScope)}. The browser test client, shared site assets, vendored browser SDK files, and package index route remain active-alpha routes.</p>
        <p>Stable consumers should pin a versioned path once a stable release exists.</p>
        ${artifactTable(releaseArtifacts)}
      </main>
    `,
  );
}

function writeManifest(copiedArtifacts, vectorIndex) {
  writeJson("site-manifest.json", {
    baseUrl: SITE_BASE_URL,
    generatedFrom: commit,
    commitDate,
    sourceState,
    dirtyInputs,
    releaseSnapshotScope,
    activeAlphaOnlyRoutes,
    releaseVersion,
    releasePath,
    releases: releaseEntries.map((entry) => ({
      version: entry.version,
      path: `/v${entry.version}/`,
      metadata: `/v${entry.version}/release.json`,
      contentSha256: entry.contentSha256,
    })),
    schemas: schemaFiles.map((file) => ({
      path: `/${file}`,
      sha256: sha256File(path.join(root, file)),
    })),
    specs: specFiles.map((file) => ({
      path: `/${htmlRoute(file)}/`,
      source: `/${file}`,
    })),
    docs: docFiles.map((file) => ({
      path: `/${htmlRoute(file)}/`,
      source: `/${file}`,
    })),
    vectors: vectorIndex,
    packages: publicPackages,
    siteAssets: [
      artifactRecord("site/src/styles.css", "assets/styles.css"),
      ...SITE_ASSET_FILES.map((file) =>
        artifactRecord(
          file,
          path.relative(SITE_SRC, file).replaceAll(path.sep, "/"),
        ),
      ),
    ],
    artifacts: copiedArtifacts,
  });
}

function writeMarkdownDocument(source, route) {
  const title = titleFromMarkdown(readText(source)) ?? titleFromPath(source);
  const markdown = readText(source);
  writeHtml(
    `${route}/index.html`,
    layout(
      title,
      `
        <main>
          <article>
            ${markdownToHtml(markdown, path.dirname(source))}
            <p class="muted">Source: <a href="/${source}"><code>/${source}</code></a></p>
          </article>
        </main>
      `,
    ),
  );
}

function buildVectorIndex(files) {
  return files.map((file) => ({
    path: `/${file}`,
    bytes: fs.statSync(path.join(root, file)).size,
    sha256: sha256File(path.join(root, file)),
  }));
}

function artifactRecord(source, target) {
  return {
    source,
    target,
    bytes: fs.statSync(path.join(root, source)).size,
    sha256: sha256File(path.join(root, source)),
  };
}

function siteAssetRecords(prefix) {
  return SITE_ASSET_FILES.filter((file) => file.startsWith(prefix)).map(
    (file) =>
      artifactRecord(
        file,
        path.relative(SITE_SRC, file).replaceAll(path.sep, "/"),
      ),
  );
}

function layout(title, body, options = {}) {
  const fullTitle = title === "Kaspa x402" ? title : `${title} — Kaspa x402`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(fullTitle)}</title>
  <meta name="description" content="Proposed native Kaspa bindings for x402 payments: schemas, specs, conformance vectors, docs, and release snapshots.">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${escapeHtml(fullTitle)}">
  <meta property="og:description" content="Proposed native Kaspa bindings for x402 payments: schemas, specs, conformance vectors, docs, and release snapshots.">
  <meta property="og:image" content="${SITE_BASE_URL}/assets/og.png">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="stylesheet" href="/assets/styles.css">
${options.head ?? ""}
</head>
<body>
  <header>
    <a class="site" href="/">Kaspa x402</a>
    <nav aria-label="Primary">
      <a href="/spec/">Spec</a>
      <a href="/schemas/">Schemas</a>
      <a href="/vectors/">Vectors</a>
      <a href="/docs/">Docs</a>
      <a href="/demo/">Demo</a>
      <a href="/releases/">Releases</a>
      <a href="${repositoryUrl}">GitHub</a>
    </nav>
  </header>
  ${body}
  <footer>Alpha standards reference for the Kaspa x402 binding. This domain does not host a custodial wallet, hosted signer, facilitator, or payment API.</footer>
</body>
</html>`;
}

function snapshotLayout(title, body) {
  const fullTitle = title === "Kaspa x402" ? title : `${title} — Kaspa x402`;
  const content = body.trim();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(fullTitle)}</title>
  <meta name="description" content="Proposed native Kaspa bindings for x402 payments: schemas, specs, conformance vectors, docs, and release snapshots.">
  <link rel="stylesheet" href="/assets/styles.css">
</head>
<body>
  <header>
    <a class="site" href="/">Kaspa x402</a>
    <nav aria-label="Primary">
      <a href="/spec/">Spec</a>
      <a href="/schemas/">Schemas</a>
      <a href="/vectors/">Vectors</a>
      <a href="/docs/">Docs</a>
      <a href="/releases/">Releases</a>
      <a href="${repositoryUrl}">GitHub</a>
    </nav>
  </header>
${content}
  <footer>Alpha standards reference for the Kaspa x402 binding. This domain does not host a wallet, signer, facilitator, or payment API.</footer>
</body>
</html>`;
}

function markdownToHtml(markdown, sourceDir) {
  const lines = markdown.split(/\r?\n/);
  const out = [];
  let inCode = false;
  let inList = false;
  let inTable = false;
  let tableLines = [];
  let paragraphLines = [];
  let codeLines = [];

  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  const closeTable = () => {
    if (inTable) {
      out.push(markdownTableToHtml(tableLines));
      tableLines = [];
      inTable = false;
    }
  };
  const closeParagraph = () => {
    if (paragraphLines.length > 0) {
      out.push(`<p>${paragraphLines.join(" ")}</p>`);
      paragraphLines = [];
    }
  };

  for (const line of lines) {
    if (line.startsWith("```")) {
      closeList();
      closeTable();
      closeParagraph();
      if (inCode) {
        out.push(`<pre><code>${codeLines.join("\n")}</code></pre>`);
        codeLines = [];
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(escapeHtml(line));
      continue;
    }
    if (/^\|.*\|$/.test(line.trim())) {
      closeList();
      closeParagraph();
      inTable = true;
      tableLines.push(line);
      continue;
    }
    closeTable();
    if (line.trim() === "") {
      closeList();
      closeParagraph();
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      closeList();
      closeParagraph();
      const level = heading[1].length;
      out.push(
        `<h${level}>${inlineMarkdown(heading[2], sourceDir)}</h${level}>`,
      );
      continue;
    }
    const bullet = /^-\s+(.+)$/.exec(line);
    if (bullet) {
      closeParagraph();
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inlineMarkdown(bullet[1], sourceDir)}</li>`);
      continue;
    }
    if (inList) {
      out[out.length - 1] = out[out.length - 1].replace(
        /<\/li>$/,
        ` ${inlineMarkdown(line.trim(), sourceDir)}</li>`,
      );
      continue;
    }
    paragraphLines.push(inlineMarkdown(line, sourceDir));
  }

  closeList();
  closeTable();
  closeParagraph();
  if (inCode) out.push(`<pre><code>${codeLines.join("\n")}</code></pre>`);
  return out.join("\n");
}

function markdownTableToHtml(lines) {
  const rows = lines
    .filter((line) => !/^\|\s*-/.test(line))
    .map((line) =>
      line
        .trim()
        .slice(1, -1)
        .split("|")
        .map((cell) => inlineMarkdown(cell.trim(), "")),
    );
  if (rows.length === 0) return "";
  const [head, ...body] = rows;
  const thead = `<thead><tr>${head.map((cell) => `<th>${cell}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody>`;
  return `<div class="table-wrap"><table>${thead}${tbody}</table></div>`;
}

function inlineMarkdown(value, sourceDir) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_match, label, href) =>
        `<a href="${escapeAttribute(rewriteMarkdownHref(href, sourceDir))}">${label}</a>`,
    );
}

function rewriteMarkdownHref(href, sourceDir) {
  if (/^(?:https?:|mailto:|#|\/)/.test(href)) return href;
  const [target, suffix = ""] = href.split(/(?=#)/, 2);
  if (target.endsWith(".md")) {
    const normalized = path.posix.normalize(`${sourceDir}/${target}`);
    if (htmlSourceFiles.has(normalized))
      return `/${htmlRoute(normalized)}/${suffix}`;
    return `/${normalized}${suffix}`;
  }
  const normalized = path.posix.normalize(`${sourceDir}/${target}`);
  if (publishedArtifactFiles.has(normalized)) return `/${normalized}${suffix}`;
  return href;
}

function artifactTable(artifacts) {
  const rows = artifacts
    .map(
      (artifact) =>
        `<tr><td><a href="/${artifact.target}"><code>${escapeHtml(artifact.target)}</code></a></td><td><code>${artifact.sha256.slice(0, 16)}</code></td></tr>`,
    )
    .join("");
  return `<div class="table-wrap"><table><thead><tr><th>Artifact</th><th>SHA-256 prefix</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function writeHeaders() {
  writeText(
    "_headers",
    `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  X-Frame-Options: DENY
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), clipboard-read=(), clipboard-write=(self)
  Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self' wss://vector-10.kaspa.green wss://electron-10.kaspa.stream wss://electron-10.kaspa.blue wss://muon-10.kaspa.blue; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'

/schemas/*.json
  Content-Type: application/schema+json; charset=utf-8
  Cache-Control: public, max-age=300, must-revalidate

/demo/
  Cache-Control: public, max-age=300, must-revalidate, no-transform

/demo/index.html
  Cache-Control: public, max-age=300, must-revalidate, no-transform

${releaseHeaderBlocks()}

/packages.json
  Content-Type: application/json; charset=utf-8
  Cache-Control: public, max-age=300, must-revalidate

/site-manifest.json
  Content-Type: application/json; charset=utf-8
  Cache-Control: public, max-age=300, must-revalidate

/vectors/index.json
  Content-Type: application/json; charset=utf-8
  Cache-Control: public, max-age=300, must-revalidate

/demo/pnn-spike.json
  Content-Type: application/json; charset=utf-8
  Cache-Control: public, max-age=300, must-revalidate

/assets/*.js
  Content-Type: text/javascript; charset=utf-8
  Cache-Control: public, max-age=300, must-revalidate

/assets/*.css
  Content-Type: text/css; charset=utf-8
  Cache-Control: public, max-age=300, must-revalidate

/assets/*.png
  Content-Type: image/png
  Cache-Control: public, max-age=300, must-revalidate

/vendor/kaspa-wasm/*
  Cache-Control: public, max-age=31536000, immutable

/vendor/kaspa-wasm/*.wasm
  Content-Type: application/wasm
`,
  );
}

function releaseHeaderBlocks() {
  return releaseEntries
    .map((entry) => {
      const path = `v${entry.version}`;
      return `/${path}/schemas/*.json
  Content-Type: application/schema+json; charset=utf-8
  Cache-Control: public, max-age=31536000, immutable

/${path}/
  Cache-Control: public, max-age=31536000, immutable

/${path}/index.html
  Cache-Control: public, max-age=31536000, immutable

/${path}/spec/*
  Cache-Control: public, max-age=31536000, immutable

/${path}/docs/*
  Cache-Control: public, max-age=31536000, immutable

/${path}/vectors/*
  Cache-Control: public, max-age=31536000, immutable

/${path}/release.json
  Content-Type: application/json; charset=utf-8
  Cache-Control: public, max-age=31536000, immutable

/${path}/packages.json
  Content-Type: application/json; charset=utf-8
  Cache-Control: public, max-age=31536000, immutable

/${path}/vectors/index.json
  Content-Type: application/json; charset=utf-8
  Cache-Control: public, max-age=31536000, immutable`;
    })
    .join("\n\n");
}

function writeRedirects() {
  const activeRedirects = ACTIVE_REDIRECTS.map(
    ({ from, to, status }) => `${from} ${to} ${status}`,
  ).join("\n");
  writeText(
    "_redirects",
    `/schema/* /schemas/:splat 301
/specs/* /spec/:splat 301
/latest/* /:splat 302
${activeRedirects}
`,
  );
}

function readPackages() {
  const packagesByName = new Map(
    trackedPackageFiles().map((file) => {
      const pkg = readJson(file);
      return [
        pkg.name,
        {
          name: pkg.name,
          version: pkg.version,
          private: pkg.private === true,
          publishTag: pkg.publishConfig?.tag,
          path: path.dirname(file),
        },
      ];
    }),
  );
  return SITE_PACKAGE_NAMES.map((name) => {
    const pkg = packagesByName.get(name);
    if (pkg === undefined)
      throw new Error(`missing site package metadata: ${name}`);
    return pkg;
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function dirtyPublishableInputs() {
  const inputs = new Set([
    "package.json",
    "wrangler.jsonc",
    "site/README.md",
    ...schemaFiles,
    ...specFiles,
    ...contractFiles,
    ...docFiles,
    ...vectorFiles,
    ...sitePackageFiles(),
    ...siteScriptFiles,
    ...siteSourceInputs(),
    ...trackedFiles(RELEASE_LOCK_DIR),
  ]);
  return git(["status", "--porcelain=v1", "--untracked-files=all"])
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .map((file) => file.replace(/^"|"$/g, ""))
    .filter((file) => isPublishableDirtyPath(file, inputs, RELEASE_LOCK_DIR))
    .sort();
}

function trackedPackageFiles() {
  return trackedFiles("packages").filter((file) =>
    file.endsWith("package.json"),
  );
}

function sitePackageFiles() {
  const sitePackages = new Set(SITE_PACKAGE_NAMES);
  return trackedPackageFiles().filter((file) =>
    sitePackages.has(readJson(file).name),
  );
}

function readReleaseLock(version) {
  const relativePath = `${RELEASE_LOCK_DIR}/v${version}.json`;
  const fullPath = path.join(root, relativePath);
  if (!fs.existsSync(fullPath)) return undefined;
  return {
    ...JSON.parse(fs.readFileSync(fullPath, "utf8")),
    path: relativePath,
  };
}

function readReleaseLocks() {
  return trackedFiles(RELEASE_LOCK_DIR)
    .filter((file) => /^site\/releases\/v[^/]+\.json$/.test(file))
    .map((file) => ({ ...readJson(file), path: file }))
    .sort((a, b) => compareVersions(a.version, b.version));
}

function buildReleaseEntries() {
  const entries = readReleaseLocks();
  if (!entries.some((entry) => entry.version === releaseVersion)) {
    entries.push({
      version: releaseVersion,
      contentSha256: undefined,
      path: `${RELEASE_LOCK_DIR}/v${releaseVersion}.json`,
    });
  }
  return entries.sort((a, b) => compareVersions(a.version, b.version));
}

function compareVersions(left, right) {
  return String(left).localeCompare(String(right), "en", { numeric: true });
}

function releasePackagesMetadata() {
  return { releaseVersion, packages };
}

function releaseNpmInstall() {
  return PUBLISHABLE_PACKAGES.map((name) => `${name}@${releaseVersion}`);
}

function releaseContentHash(lockedRelease) {
  const records = listFiles(`${SITE_DIST}/${releasePath}`)
    .map((file) => path.join(root, file))
    .map((file) => ({
      file,
      target: path.relative(outDir, file).replaceAll(path.sep, "/"),
    }))
    .filter(({ target }) => target !== `${releasePath}/release.json`)
    .map(({ file, target }) => fileRecord(target, file));
  records.push(
    contentRecord(
      `${releasePath}/release.json`,
      jsonText(releaseMetadataForHash(lockedRelease)),
    ),
  );
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify(records.sort((a, b) => a.target.localeCompare(b.target))),
    )
    .digest("hex");
}

function copyVersionedSchema(source, target) {
  const activeBase = `${SITE_BASE_URL}/schemas/`;
  const versionedBase = `${SITE_BASE_URL}/${releasePath}/schemas/`;
  const rewritten = fs
    .readFileSync(path.join(root, source), "utf8")
    .replaceAll(activeBase, versionedBase);
  const schema = JSON.parse(rewritten);
  assertReleaseLocalSchema(schema, `${versionedBase}${path.basename(source)}`);
  writeText(target, rewritten);
}

function fileRecord(target, file) {
  return {
    target,
    bytes: fs.statSync(file).size,
    sha256: sha256File(file),
  };
}

function contentRecord(target, value) {
  const buffer = Buffer.from(value);
  return {
    target,
    bytes: buffer.byteLength,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
  };
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function siteSourceInputs() {
  return ["site/src/styles.css", ...SITE_ASSET_FILES];
}

function trackedFiles(relativeDir) {
  const files = new Set(
    git(["ls-files", relativeDir]).split(/\r?\n/).filter(Boolean),
  );
  return [...files]
    .filter((file) => fs.existsSync(path.join(root, file)))
    .sort();
}

function listFiles(relativeDir) {
  const fullDir = path.join(root, relativeDir);
  if (!fs.existsSync(fullDir)) return [];
  return fs
    .readdirSync(fullDir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(fullDir, entry.name);
      const relative = path.relative(root, full).replaceAll(path.sep, "/");
      if (entry.isDirectory()) return listFiles(relative);
      return entry.isFile() ? [relative] : [];
    })
    .sort();
}

function copyFile(source, target) {
  const targetPath = path.join(outDir, target);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(path.join(root, source), targetPath);
}

function writeHtml(target, html) {
  writeText(target, html);
}

function writeJson(target, value) {
  writeText(target, jsonText(value));
}

function writeText(target, value) {
  const targetPath = path.join(outDir, target);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, value);
}

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function titleFromMarkdown(markdown) {
  return /^#\s+(.+)$/m.exec(markdown)?.[1];
}

function titleFromPath(file) {
  return path.basename(file, path.extname(file)).replaceAll("-", " ");
}

function htmlRoute(file) {
  const ext = path.extname(file);
  return file.slice(0, -ext.length);
}

function sha256File(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function normalizeRepositoryUrl(value) {
  return String(value ?? "https://github.com/elldeeone/kaspa-x402")
    .replace(/^git\+/, "")
    .replace(/\.git$/, "");
}

function npmPackageUrl(name) {
  return `https://www.npmjs.com/package/${encodeURIComponent(name)}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}
