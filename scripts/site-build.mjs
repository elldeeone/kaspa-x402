import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isPublishableDirtyPath } from "./site-inputs.mjs";
import { createSiteMarkdown } from "./site-markdown.mjs";
import { fileURLToPath } from "node:url";
import { buildBrowserHashChain } from "./build-browser-hash-chain.mjs";

import {
  artifactSource,
  artifactRoute,
  ARTIFACT_NOTES,
  BROWSER_BUNDLE_INPUTS,
  GENERATED_SITE_ASSETS,
  CONTRACT_FILES,
  DOC_GROUPS,
  PUBLIC_DOC_FILES,
  PUBLISHABLE_PACKAGES,
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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, SITE_DIST);
const requireClean = process.argv.includes("--require-clean");

const schemaFiles = SCHEMA_FILES;
const specFiles = SPEC_FILES;
const contractFiles = CONTRACT_FILES;
const docFiles = PUBLIC_DOC_FILES;
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
  "scripts/site-markdown.mjs",
  "scripts/site-check.mjs",
  "scripts/site-config.mjs",
  "scripts/site-inputs.mjs",
  "scripts/site-serve.mjs",
];
const packages = readPackages();
const publicPackages = packages.filter((pkg) =>
  PUBLISHABLE_PACKAGES.includes(pkg.name),
);
const repositoryUrl = normalizeRepositoryUrl(
  readJson("package.json").repository?.url,
);
const releaseVersion = packages.find(
  (pkg) => pkg.name === "@kaspa-x402/core",
)?.version;
if (releaseVersion === undefined)
  throw new Error("missing @kaspa-x402/core release version");
const commit = git(["rev-parse", "HEAD"]);
const commitDate = git(["show", "-s", "--format=%cI", "HEAD"]);
const dirtyInputs = dirtyPublishableInputs();
const sourceState = dirtyInputs.length > 0 ? "working-tree-dirty" : "git-head";
const siteMarkdown = createSiteMarkdown(rewriteMarkdownHref);

if (requireClean && dirtyInputs.length > 0) {
  throw new Error(
    `site build requires clean publishable inputs: ${dirtyInputs.join(", ")}`,
  );
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

copyStaticAssets();
await buildBrowserHashChain(outDir);
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
writeJson("release.json", currentRelease());

writeIndexPages();
writeManifest(copiedArtifacts, vectorIndex);

function writeIndexPages() {
  writeHomePage();
  writeSchemasPage();
  writeSpecsPage();
  writeDocsPage();
  writeVectorsPage();
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
    "profile": "standard-native",
    "paymentFlow": "upfront"
  }
}`;
  const batchSnippet = `{
  "scheme": "batch-settlement",
  "network": "kaspa:<network>",
  "asset": "KAS",
  "amount": "<fixed per-request sompi>",
  "extra": {
    "binding": "kaspa-escrow-v3",
    "templateId": "kaspa-x402-escrow-v5"
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
      <li>Released Testnet candidate: <a href="${repositoryUrl}/releases/tag/v${escapeHtml(releaseVersion)}"><code>${escapeHtml(releaseVersion)}</code></a>. All four public npm packages are published under the <code>rc</code> tag, with specifications, JSON schemas, and conformance vectors.</li>
      <li>Network target: <code>kaspa:testnet-10</code> only.</li>
      <li>Hosted gateway: <a href="https://demo.kaspa-x402.org"><code>demo.kaspa-x402.org</code></a> runs <code>${escapeHtml(releaseVersion)}</code> using Testnet-10 PNN nodes for native exact, batch, and hash-chain payments. Release validation covered all 18 funded exact/batch flows, hosted payments, browser payments, owner rotation, and retries after redeployment. See the <a href="/docs/rc2-release/">RC2 release and evidence</a>.</li>
      <li>Mainnet: blocked. <code>kaspa:mainnet</code> is a reserved profile name; the blocking gates are listed in <a href="/docs/mainnet-readiness/">mainnet readiness</a>. Do not use any of this with production funds.</li>
      <li>Standards: the <code>kaspa:*</code> network identifiers are draft binding names, not accepted x402 registry or CAIP entries.</li>
      <li>Stability: package names, schemas, and field names may change before stable <code>1.0.0</code>. See the <a href="/docs/versioning-policy/">versioning policy</a>.</li>
    </ul>
    <p class="muted">Generated from commit <code>${escapeHtml(commit.slice(0, 12))}</code> (${escapeHtml(commitDate.slice(0, 10))}). <a href="/release.json"><code>release.json</code></a> identifies the current release.</p>

    <h2>What is x402</h2>
    <p>x402 is an open protocol that turns the HTTP <code>402 Payment Required</code> status code into a machine-payable flow: a server answers an unpaid request with a 402 carrying a machine-readable offer, the client retries with a signed payment payload, and the server verifies the payment, settles it, and serves the response. The same primitives work over HTTP headers and MCP <code>_meta</code> fields, so paid APIs and tools are usable by autonomous agents. See <a href="https://www.x402.org">x402.org</a>.</p>

    <h2>What is Kaspa</h2>
    <p>Kaspa is a proof-of-work layer 1 whose blockDAG consensus produces blocks at sub-second cadence with native UTXO semantics. See <a href="https://kaspa.org">kaspa.org</a>.</p>

    <h2>Why a native Kaspa binding</h2>
    <p>The claims below are engineering rationale, each specified or backed by testnet evidence. None of them is a mainnet claim.</p>
    <ul>
      <li><strong>Settlement latency close to request latency.</strong> Paying per HTTP request only works when payment confirmation is not the slow path. Kaspa's block cadence makes one-shot native payments practical at request time; the <a href="/docs/live-testnet-report/">live testnet report</a> records executed end-to-end flows.</li>
      <li><strong>Small per-request prices.</strong> Amounts are decimal strings in sompi (1 KAS = 100,000,000 sompi). KIP-9 storage mass depends on the complete transaction shape; Kaspa does not define a universal 0.1 KAS consensus dust floor. The reference runtime applies a conservative 10,000,000 sompi output policy. <a href="/spec/kaspa-batch-settlement-v3/">Batch-settlement</a> vouchers can price individual requests below that application policy.</li>
      <li><strong>Direct verification, no facilitator lock-in.</strong> Kaspa is UTXO-native, so a server can verify and settle against a node it trusts: payment identity is bound to transaction ids, outpoints, and script-public-key material rather than to a hosted intermediary. A <a href="/spec/facilitator-profile/">self-hosted facilitator profile</a> exists for x402 <code>/supported</code>, <code>/verify</code>, <code>/settle</code> compatibility, but it is optional.</li>
      <li><strong>Escrow channels for repeated requests.</strong> For clients making many fixed-price calls, <a href="/spec/kaspa-batch-settlement-v3/">batch settlement</a> creates one singleton KIP-20 genesis, signs lifetime cumulative ceilings off-chain, supports repeated partial claims and same-lineage top-ups, and ends with a timed refund. The stable covenant ID and A/S/T accounting survive successor rotation and runtime restart.</li>
    </ul>

    <h2>Payment schemes</h2>
    <p>The binding ships two schemes with different settlement shapes.</p>
    <p><code>exact</code> — fixed-price one-shot native transfer under <a href="/spec/kaspa-exact-v2/">kaspa-exact-v2</a>. <code>standard-native</code> is the default ordinary KAS transfer. The optional <code>additive</code> profile consumes and recreates a reusable merchant KIP-10 head; the successor increase is the sole exact payment, with no second merchant output and no per-offer inventory reservation.</p>
    <p>RC2 also ships the optional <a href="/spec/kaspa-hash-chain-exact-v1/"><code>hash-chain-additive</code></a> exact profile with OTP-style one-time signing grants. The payer independently broadcasts a payment that increases the head and advances its hash guard. Try it in the <a href="/demo/#demo-hash-chain">browser demo</a> when the hosted issuer is available.</p>
    <pre><code>${escapeHtml(exactSnippet)}</code></pre>
    <p><code>batch-settlement</code> — repeated requests with a payer-approved fixed charge per invocation against a KIP-20 escrow lane. Its lifecycle is singleton genesis → repeated partial claims → top-up → refund. The current outpoint and V rotate while the stable covenant ID and lifetime A/S/T remain recoverable; R is the advertised minimum successor reserve. Spec: <a href="/spec/kaspa-batch-settlement-v3/">kaspa-batch-settlement-v3</a>.</p>
    <pre><code>${escapeHtml(batchSnippet)}</code></pre>

    <h2>Start here</h2>
    <ul>
      <li><strong>Implementing:</strong> read the <a href="/docs/demo-implementer-guide/">implementer guide</a>, the <a href="/spec/kaspa-x402-v1/">core binding</a>, the relevant <a href="/spec/kaspa-exact-v2/">exact</a> or <a href="/spec/kaspa-batch-settlement-v3/">batch-settlement</a> scheme, and the <a href="/vectors/">conformance vectors</a>.</li>
      <li><strong>Testing:</strong> use the <a href="/docs/testnet-gateway/">hosted gateway reference</a> and the <a href="/demo/">browser demo</a>.</li>
      <li><strong>Reviewing:</strong> start with the <a href="/docs/security-threat-model/">threat model</a>, <a href="/docs/live-testnet-report/">live testnet report</a>, and <a href="/docs/mainnet-readiness/">mainnet readiness gates</a>.</li>
    </ul>

    <h2 id="packages">Packages</h2>
    <p><code>${escapeHtml(releaseVersion)}</code> is the current recommended Testnet release. Install it with <code>@rc</code> or the exact version; <code>@rc</code> is the npm channel for release candidates.</p>
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
      sha256File(path.join(root, artifactSource(file))),
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
      sha256File(path.join(root, artifactSource(file))),
    ),
  );
  writeHtml(
    "spec/index.html",
    layout(
      "Spec",
      `
  <main>
    <h1>Spec</h1>
    <p>Current binding and transport documents, in suggested reading order.</p>
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
        sha256File(path.join(root, artifactSource(file))),
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
            sha256File(path.join(root, artifactSource(file))),
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
      sha256File(path.join(root, artifactSource(file))),
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

function writeNotFoundPage() {
  writeHtml(
    "404.html",
    layout(
      "Not Found",
      `
  <main>
    <h1>Not Found</h1>
    <p>The requested page is not published on this site. Return to the <a href="/">current release candidate</a>.</p>
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
    <p class="muted">Testnet-only development browser client for inspecting Kaspa x402 offers, checking public-node connectivity, and rehearsing exact or batch payment headers. Current source uses escrow-v5 and head-v2; testing those templates requires a matching development server and fresh heads/channels. The published RC2 gateway uses the earlier templates. See the <a href="/docs/versioning-policy/#sighash-template-transition">signature policy and template transition</a> and <a href="/docs/testnet-gateway/">recorded gateway evidence</a>.</p>

    <section class="demo-panel" aria-labelledby="demo-safety">
      <h2 id="demo-safety">Safety Boundary</h2>
      <ul>
        <li>The network is fixed to <code>kaspa:testnet-10</code>; there is no mainnet selector.</li>
        <li>Generated or imported private keys stay in browser memory. The page does not write key material to local storage, cookies, query strings, or the server.</li>
        <li>Reset clears the in-memory key, visible fields, and RPC connection state.</li>
        <li>Hash-chain payments send signed grant claims and payment proofs to the demo gateway. Private wallet keys stay in the browser.</li>
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

    <section class="demo-panel" aria-labelledby="demo-hash-chain">
      <h2 id="demo-hash-chain">Hash-chain exact — live Testnet payment</h2>
      <p>Generate or import a throwaway key above, fund its Testnet-10 address, and connect to a node. Fetch a quote, then pay to claim a one-use grant and retrieve the protected report.</p>
      <p class="muted">One payment increases the merchant head by the quoted price. The target fee is 0.01 KAS; small change may be included in the fee, up to 0.1 KAS total. The result shows the actual fee. If someone abandons a claimed grant, the operator resets the head manually.</p>
      <div class="demo-actions">
        <button type="button" id="demo-hash-quote">Get hash-chain quote</button>
        <button type="button" id="demo-hash-pay" disabled>Pay quoted Testnet KAS</button>
        <button type="button" id="demo-hash-retry" disabled>Retry same payment</button>
      </div>
      <output id="demo-hash-status" class="demo-status">Fetch a quote to check availability.</output>
      <pre id="demo-hash-output"><code>{}</code></pre>
      <p><a href="/spec/kaspa-hash-chain-exact-v1/">Profile specification</a> · <a href="/docs/demo-implementer-guide/#hash-chain-browser-demo">Walkthrough</a></p>
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
        <h3>Development Batch Requirements</h3>
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
          <label>Signed cumulative authorization after this request (T)
            <input id="demo-signed-max" type="text" inputmode="numeric" value="22500000">
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
        <li>The published TypeScript helpers remain Node-oriented. The hash-chain panel bundles the payment client with a small browser adapter; the mock header builders use browser-native encoding.</li>
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
        "development batch voucher header generation",
        "batch A/S/T/V/R invariant checks",
        "batch partial-claim successor preview",
        "mixed-offer narrowing",
        "node info",
        "DAA score",
        "transaction status lookup missing-entry path",
        "hash-chain grant claim, signing, broadcast, and identical retry",
      ],
      constraints: [
        "testnet-only",
        "no implicit key persistence",
        "manual transaction broadcast only",
      ],
    },
    worker: {
      status:
        "1.0.0-rc.2 is released at https://demo.kaspa-x402.org with PNN-only chain evidence; funded native, batch, and browser hash-chain validation completed",
      verifiedCapabilities: [
        "PNN chain health and selected-chain evidence",
        "Durable Object state",
        "exact 402 offers",
        "standard-native exact settlement and idempotent replay",
        "cross-resource exact replay rejection",
        "batch-settlement 402 offers",
        "batch deposit, voucher, and duplicate retry",
        "hash-chain payments across owner rotation",
        "native, batch, and hash-chain retry recovery after redeployment",
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
  return `<p class="muted">Published release: <code>${escapeHtml(releaseVersion)}</code> for <code>kaspa:testnet-10</code>. See the <a href="/docs/rc2-release/">release details</a>. Mainnet use remains blocked by the documented readiness gates.</p>`;
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

function copyStaticAssets() {
  copyFile("site/src/styles.css", "assets/styles.css");
  for (const file of SITE_ASSET_FILES) {
    copyFile(file, path.relative(SITE_SRC, file).replaceAll(path.sep, "/"));
  }
}

function currentRelease() {
  return {
    version: releaseVersion,
    channel: "rc",
    network: "kaspa:testnet-10",
    generatedFrom: commit,
    commitDate,
    sourceState,
    dirtyInputs,
    npmInstall: releaseNpmInstall(),
    packages: publicPackages,
  };
}

function writeManifest(copiedArtifacts, vectorIndex) {
  writeJson("site-manifest.json", {
    baseUrl: SITE_BASE_URL,
    generatedFrom: commit,
    commitDate,
    sourceState,
    dirtyInputs,
    releaseVersion,
    releaseMetadata: "/release.json",
    schemas: schemaFiles.map((file) => ({
      path: `/${file}`,
      sha256: sha256File(path.join(root, artifactSource(file))),
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
      ...GENERATED_SITE_ASSETS.map((file) => ({ path: `/${file}`, sha256: sha256File(path.join(outDir, file)) })),
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
            ${markdownToHtml(markdown, path.dirname(artifactSource(source)))}
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
    bytes: fs.statSync(path.join(root, artifactSource(file))).size,
    sha256: sha256File(path.join(root, artifactSource(file))),
  }));
}

function artifactRecord(source, target) {
  return {
    source: artifactSource(source),
    target,
    bytes: fs.statSync(path.join(root, artifactSource(source))).size,
    sha256: sha256File(path.join(root, artifactSource(source))),
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
  <meta name="description" content="Kaspa x402 ${escapeHtml(releaseVersion)}: released Testnet-10 packages, payment profiles, schemas, and PNN gateway.">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${escapeHtml(fullTitle)}">
  <meta property="og:description" content="Kaspa x402 ${escapeHtml(releaseVersion)}: released Testnet-10 packages, payment profiles, schemas, and PNN gateway.">
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
      <a href="${repositoryUrl}">GitHub</a>
    </nav>
  </header>
  <p class="release-status"><strong>${escapeHtml(releaseVersion)} released</strong> · Testnet-10 · <a href="/docs/rc2-release/">Release details</a></p>
  <!--email_off-->
  <p class="muted">Development reference: escrow-v5 and head-v2 accept signer-chosen sighash types; reference signing defaults to ALL. Published RC2 packages and gateway use escrow-v4 and head-v1. See the <a href="/docs/versioning-policy/#sighash-template-transition">signature policy and template transition</a>.</p>
  ${body}
  <!--/email_off-->
  <footer>Kaspa x402 ${escapeHtml(releaseVersion)} documentation. <a href="/docs/rc2-release/">Published release and validation evidence</a>. <a href="https://demo.kaspa-x402.org">PNN-based Testnet-10 gateway</a>.</footer>
</body>
</html>`;
}

function markdownToHtml(markdown, sourceDir) {
  return siteMarkdown.render(markdown, sourceDir);
}

function inlineMarkdown(value, sourceDir) {
  return siteMarkdown.renderInline(value, sourceDir);
}

function rewriteMarkdownHref(href, sourceDir) {
  if (/^(?:https?:|mailto:|#|\/)/.test(href)) return href;
  const [target, suffix = ""] = href.split(/(?=#)/, 2);
  if (target.endsWith(".md")) {
    const normalized = artifactRoute(path.posix.normalize(`${sourceDir}/${target}`));
    if (htmlSourceFiles.has(normalized))
      return `/${htmlRoute(normalized)}/${suffix}`;
    return `/${normalized}${suffix}`;
  }
  const normalized = artifactRoute(path.posix.normalize(`${sourceDir}/${target}`));
  if (publishedArtifactFiles.has(normalized)) return `/${normalized}${suffix}`;
  return href;
}

function writeHeaders() {
  writeText(
    "_headers",
    `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  X-Frame-Options: DENY
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), clipboard-read=(), clipboard-write=(self)
  Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self' https://demo.kaspa-x402.org wss://vector-10.kaspa.green wss://electron-10.kaspa.stream wss://electron-10.kaspa.blue wss://muon-10.kaspa.blue; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'

/schemas/*.json
  Content-Type: application/schema+json; charset=utf-8
  Cache-Control: public, max-age=300, must-revalidate

/demo/
  Cache-Control: public, max-age=300, must-revalidate, no-transform

/demo/index.html
  Cache-Control: public, max-age=300, must-revalidate, no-transform

/release.json
  Content-Type: application/json; charset=utf-8
  Cache-Control: public, max-age=300, must-revalidate

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

function writeRedirects() {
  writeText(
    "_redirects",
    `/schema/* /schemas/:splat 301
/specs/* /spec/:splat 301
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
    ...schemaFiles.map(artifactSource),
    ...specFiles.map(artifactSource),
    ...contractFiles.map(artifactSource),
    ...docFiles.map(artifactSource),
    ...vectorFiles.map(artifactSource),
    ...sitePackageFiles(),
    ...siteScriptFiles,
    ...siteSourceInputs(),
    ...BROWSER_BUNDLE_INPUTS,
  ]);
  return git(["status", "--porcelain=v1", "--untracked-files=all"])
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .map((file) => file.replace(/^"|"$/g, ""))
    .filter((file) => isPublishableDirtyPath(file, inputs))
    .sort();
}

function trackedPackageFiles() {
  return [...trackedFiles("packages"), ...trackedFiles("protocol/packages")].filter((file) =>
    file.endsWith("package.json"),
  );
}

function sitePackageFiles() {
  const sitePackages = new Set(SITE_PACKAGE_NAMES);
  return trackedPackageFiles().filter((file) =>
    sitePackages.has(readJson(file).name),
  );
}

function releaseNpmInstall() {
  return PUBLISHABLE_PACKAGES.map((name) => `${name}@${releaseVersion}`);
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function siteSourceInputs() {
  return ["site/src/styles.css", ...SITE_ASSET_FILES];
}

function trackedFiles(relativeDir) {
  const physicalDir = artifactSource(`${relativeDir}/`).replace(/\/$/, "");
  const files = new Set([
    ...git(["ls-files", physicalDir]).split(/\r?\n/).filter(Boolean),
    ...listFiles(physicalDir),
  ]);
  return [...files]
    .map(file => /^(schemas|vectors|spec|contracts)$/.test(relativeDir) ? artifactRoute(file) : file)
    .filter((file) => fs.existsSync(path.join(root, artifactSource(file))))
    .sort();
}

function listFiles(relativeDir) {
  const fullDir = path.join(root, relativeDir);
  if (!fs.existsSync(fullDir)) return [];
  return fs
    .readdirSync(fullDir, { withFileTypes: true })
    .flatMap((entry) => {
      if (["node_modules", "dist"].includes(entry.name)) return [];
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
  fs.copyFileSync(path.join(root, artifactSource(source)), targetPath);
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
  return fs.readFileSync(path.join(root, artifactSource(relativePath)), "utf8");
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
