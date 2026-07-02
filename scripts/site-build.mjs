import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ARTIFACT_NOTES,
  DOC_GROUPS,
  PUBLIC_DOC_FILES,
  PUBLISHABLE_PACKAGES,
  RELEASE_LOCK_DIR,
  SITE_ASSET_FILES,
  SCHEMA_FILES,
  SITE_BASE_URL,
  SITE_DIST,
  SITE_SRC,
  SPEC_FILES,
  VECTOR_GROUPS,
} from "./site-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, SITE_DIST);
const requireClean = process.argv.includes("--require-clean");

const schemaFiles = SCHEMA_FILES;
const specFiles = SPEC_FILES;
const docFiles = PUBLIC_DOC_FILES;
const htmlSourceFiles = new Set([...specFiles, ...docFiles]);
const vectorFiles = trackedFiles("vectors").filter((file) => file.endsWith(".json") || file.endsWith(".md"));
const siteScriptFiles = ["scripts/site-build.mjs", "scripts/site-check.mjs", "scripts/site-config.mjs", "scripts/site-serve.mjs"];
const packages = readPackages();
const repositoryUrl = normalizeRepositoryUrl(readJson("package.json").repository?.url);
const releaseVersion = packages.find((pkg) => pkg.name === "@kaspa-x402/core")?.version ?? "0.1.0-alpha.1";
const releasePath = `v${releaseVersion}`;
const commit = git(["rev-parse", "HEAD"]);
const commitDate = git(["show", "-s", "--format=%cI", "HEAD"]);
const dirtyInputs = dirtyPublishableInputs();
const sourceState = dirtyInputs.length > 0 ? "working-tree-dirty" : "git-head";

if (requireClean && dirtyInputs.length > 0) {
  throw new Error(`site build requires clean publishable inputs: ${dirtyInputs.join(", ")}`);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

copyStaticAssets();
writeHeaders();
writeRedirects();
writeText("robots.txt", "User-agent: *\nAllow: /\n");

const copiedArtifacts = [
  ...copyCollection(schemaFiles, "schemas"),
  ...copyCollection(specFiles, "spec"),
  ...copyCollection(docFiles, "docs"),
  ...copyCollection(vectorFiles, "vectors"),
];

const vectorIndex = buildVectorIndex(vectorFiles);
writeJson("vectors/index.json", vectorIndex);
writeJson("packages.json", { generatedFrom: commit, releaseVersion, packages });

writeIndexPages();
writeReleaseSnapshot(copiedArtifacts, vectorIndex);
writeManifest(copiedArtifacts, vectorIndex);

function writeIndexPages() {
  writeHomePage();
  writeSchemasPage();
  writeSpecsPage();
  writeDocsPage();
  writeVectorsPage();
  writeReleasesPage();

  for (const file of specFiles) writeMarkdownDocument(file, htmlRoute(file));
  for (const file of docFiles) writeMarkdownDocument(file, htmlRoute(file));
}

function writeHomePage() {
  const exactSnippet = `{
  "scheme": "exact",
  "network": "kaspa:<network>",
  "asset": "KAS",
  "amount": "<sompi>"
}`;
  const batchSnippet = `{
  "scheme": "batch-settlement",
  "network": "kaspa:<network>",
  "asset": "KAS",
  "amount": "<max per-request sompi>",
  "extra": {
    "binding": "kaspa-escrow-v1"
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
      <li>Network target: <code>kaspa:testnet-10</code> only. Reference flows have been executed live on testnet; see the <a href="/docs/live-testnet-report/">live testnet report</a>.</li>
      <li>Mainnet: blocked. <code>kaspa:mainnet</code> is a reserved profile name; the blocking gates are listed in <a href="/docs/mainnet-readiness/">mainnet readiness</a>. Do not use any of this with production funds.</li>
      <li>Standards: the <code>kaspa:*</code> network identifiers are draft binding names, not accepted x402 registry or CAIP entries.</li>
      <li>Stability: package names, schemas, and field names may change until the first tagged spec release. See the <a href="/docs/versioning-policy/">versioning policy</a>.</li>
    </ul>
    <p class="muted">Generated from commit <code>${escapeHtml(commit.slice(0, 12))}</code> (${escapeHtml(commitDate.slice(0, 10))}). Unversioned routes track the active alpha; immutable snapshots are listed under <a href="/releases/">releases</a>.</p>

    <h2>What is x402</h2>
    <p>x402 is an open protocol that turns the HTTP <code>402 Payment Required</code> status code into a machine-payable flow: a server answers an unpaid request with a 402 carrying a machine-readable offer, the client retries with a signed payment payload, and the server verifies the payment, settles it, and serves the response. The same primitives work over HTTP headers and MCP <code>_meta</code> fields, so paid APIs and paid tools are usable by autonomous agents, not only by humans with checkout pages. See <a href="https://www.x402.org">x402.org</a>.</p>

    <h2>What is Kaspa</h2>
    <p>Kaspa is a proof-of-work layer 1 whose blockDAG consensus produces blocks at sub-second cadence with native UTXO semantics. See <a href="https://kaspa.org">kaspa.org</a>.</p>

    <h2>Why a native Kaspa binding</h2>
    <p>The claims below are engineering rationale, each specified or backed by testnet evidence. None of them is a mainnet claim.</p>
    <ul>
      <li><strong>Settlement latency close to request latency.</strong> Paying per HTTP request only works when payment confirmation is not the slow path. Kaspa's block cadence makes one-shot native payments practical at request time; the <a href="/docs/live-testnet-report/">live testnet report</a> records executed end-to-end flows.</li>
      <li><strong>Micropayment-scale pricing.</strong> Amounts are decimal strings in sompi (1 KAS = 100,000,000 sompi), and native transfer fees are low enough that small per-request prices stay economical.</li>
      <li><strong>Direct verification, no facilitator lock-in.</strong> Kaspa is UTXO-native, so a server can verify and settle against a node it trusts: payment identity is bound to transaction ids, outpoints, and script-public-key material rather than to a hosted intermediary. A <a href="/spec/facilitator-profile/">self-hosted facilitator profile</a> exists for x402 <code>/supported</code>, <code>/verify</code>, <code>/settle</code> compatibility, but it is optional.</li>
      <li><strong>Escrow channels for repeated requests.</strong> For clients making many small or variable-cost calls, <a href="/spec/kaspa-batch-settlement-v1/">batch settlement</a> funds a covenant-backed escrow once, signs a cumulative voucher per paid request, and touches the chain again only at claim or refund time.</li>
    </ul>

    <h2>The two profiles</h2>
    <p>The binding deliberately ships two schemes with different settlement shapes instead of overloading one.</p>
    <p><code>exact</code> — fixed-price one-shot native transfer. Spec: <a href="/spec/kaspa-exact-v1/">kaspa-exact-v1</a>.</p>
    <pre><code>${escapeHtml(exactSnippet)}</code></pre>
    <p><code>batch-settlement</code> — repeated or variable-cost requests against escrow/channel state. Spec: <a href="/spec/kaspa-batch-settlement-v1/">kaspa-batch-settlement-v1</a>.</p>
    <pre><code>${escapeHtml(batchSnippet)}</code></pre>

    <h2>Start here</h2>
    <ul>
      <li><strong>Implementing a paid HTTP API or MCP tool:</strong> read the <a href="/spec/kaspa-x402-v1/">core binding</a>, then the <a href="/spec/http-profile/">HTTP</a> or <a href="/spec/mcp-profile/">MCP</a> transport profile; install the <a href="#packages">alpha packages</a> and validate against the <a href="/vectors/">conformance vectors</a>.</li>
      <li><strong>Reviewing correctness or security:</strong> start from the <a href="/docs/security-threat-model/">threat model</a> and the <a href="/docs/review-closure-ledger/">review closure ledger</a>, then the <a href="/schemas/">schemas</a> and <a href="/vectors/">vectors</a>.</li>
      <li><strong>Evaluating the initiative:</strong> the <a href="/docs/public-proposal/">public proposal</a>, the <a href="/docs/live-testnet-report/">live testnet report</a>, and the <a href="/docs/mainnet-readiness/">mainnet readiness gates</a>.</li>
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
    annotatedRow(`/${file}`, path.basename(file), ARTIFACT_NOTES[file], sha256File(path.join(root, file))),
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
    annotatedRow(`/${htmlRoute(file)}/`, path.basename(file, ".md"), ARTIFACT_NOTES[file], sha256File(path.join(root, file))),
  );
  writeHtml(
    "spec/index.html",
    layout(
      "Spec",
      `
  <main>
    <h1>Spec</h1>
    <p>Binding and transport documents, in suggested reading order. Each rendered page links its markdown source; hashes are of the source files.</p>
    ${statusLine()}
    ${annotatedTable("Document", rows)}
  </main>
      `,
    ),
  );
}

function writeDocsPage() {
  const sections = DOC_GROUPS.map((group) => {
    const rows = group.files.map((file) =>
      annotatedRow(`/${htmlRoute(file)}/`, path.basename(file, ".md"), ARTIFACT_NOTES[file], sha256File(path.join(root, file))),
    );
    return `<h2>${escapeHtml(group.title)}</h2>\n    ${annotatedTable("Document", rows)}`;
  }).join("\n    ");
  writeHtml(
    "docs/index.html",
    layout(
      "Docs",
      `
  <main>
    <h1>Docs</h1>
    <p>Selected public documents, grouped by what they are for. Internal planning documents are not published.</p>
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
        .map((file) => annotatedRow(`/${file}`, file.split("/").slice(2).join("/"), "", sha256File(path.join(root, file))));
      return `<h2><code>${escapeHtml(dir)}/</code></h2>
    ${note ? `<p>${inlineMarkdown(note, "")}</p>` : ""}
    ${annotatedTable("File", rows, { notes: false })}`;
    })
    .join("\n    ");
  const otherRows = rootFiles.map((file) => annotatedRow(`/${file}`, path.basename(file), "", sha256File(path.join(root, file))));
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
  writeHtml(
    "releases/index.html",
    layout(
      "Releases",
      `
  <main>
    <h1>Releases</h1>
    <p>Immutable snapshots of the published surface, one per release. Unversioned routes on this site always track the active alpha; snapshot content is locked by hash and is not mutated after release. New releases add new snapshots.</p>
    <p>Install alpha packages with an explicit prerelease tag or exact version; <code>latest</code> dist-tags are not the recommended alpha install path.</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Version</th><th>Snapshot</th><th>Metadata</th></tr></thead>
      <tbody><tr><td><code>${escapeHtml(releaseVersion)}</code></td><td><a href="/${releasePath}/"><code>/${releasePath}/</code></a></td><td><a href="/${releasePath}/release.json"><code>release.json</code></a></td></tr></tbody>
    </table></div>
  </main>
      `,
    ),
  );
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

function annotatedTable(artifactHeading, rows, { notes = true } = {}) {
  const headers = notes ? [artifactHeading, "Purpose", "SHA-256 prefix"] : [artifactHeading, "SHA-256 prefix"];
  const body = rows
    .map((row) => {
      const cells = notes ? row.cells : [row.cells[0], row.cells[2]];
      return `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
    })
    .join("");
  return `<div class="table-wrap"><table><thead><tr>${headers.map((heading) => `<th>${escapeHtml(heading)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function packagesTable() {
  const rows = packages
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

function writeReleaseSnapshot(copiedArtifacts, vectorIndex) {
  const releaseArtifacts = [];
  for (const artifact of copiedArtifacts) {
    const target = `${releasePath}/${artifact.target}`;
    copyFile(artifact.source, target);
    releaseArtifacts.push({ ...artifact, target });
  }
  const releasePackages = releasePackagesMetadata();
  const releaseLock = readReleaseLock(releaseVersion);
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
  const lockedRelease = releaseMetadata(releaseLock, releaseArtifacts, {
    sourceState: "locked",
    dirtyInputs: [],
  });
  const contentSha256 = releaseContentHash(lockedRelease);
  if (!releaseLock && (requireClean || dirtyInputs.length === 0)) {
    throw new Error(`release ${releaseVersion} is missing a content lock in ${RELEASE_LOCK_DIR}`);
  }
  if (releaseLock && releaseLock.contentSha256 !== contentSha256 && (requireClean || dirtyInputs.length === 0)) {
    throw new Error(`release ${releaseVersion} content differs from ${releaseLock.path}; bump the package version or update the release lock`);
  }

  const release = {
    ...releaseMetadata(releaseLock, releaseArtifacts, releaseProvenance),
    contentSha256,
  };

  writeJson(`${releasePath}/release.json`, release);
}

function releaseMetadata(releaseLock, releaseArtifacts, releaseProvenance) {
  return {
    version: releaseVersion,
    ...releaseProvenance,
    contentLock: releaseLock?.path,
    unversionedRoutes: "active alpha",
    npmInstall: releaseNpmInstall(),
    artifacts: releaseArtifacts,
  };
}

function releaseIndexHtml(releaseArtifacts) {
  return layout(
    `Release ${releaseVersion}`,
    `
      <main>
        <h1>Release ${escapeHtml(releaseVersion)}</h1>
        <p>Status: locked alpha snapshot for this version. Machine-readable metadata is available at <a href="/${releasePath}/release.json"><code>/${releasePath}/release.json</code></a>.</p>
        <p>Unversioned routes follow the active alpha. Stable consumers should pin a versioned path once a stable release exists.</p>
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
    releaseVersion,
    releasePath,
    schemas: schemaFiles.map((file) => ({ path: `/${file}`, sha256: sha256File(path.join(root, file)) })),
    specs: specFiles.map((file) => ({ path: `/${htmlRoute(file)}/`, source: `/${file}` })),
    docs: docFiles.map((file) => ({ path: `/${htmlRoute(file)}/`, source: `/${file}` })),
    vectors: vectorIndex,
    packages,
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

function layout(title, body) {
  const fullTitle = title === "Kaspa x402" ? title : `${title} — Kaspa x402`;
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
  ${body}
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
      out.push(`<h${level}>${inlineMarkdown(heading[2], sourceDir)}</h${level}>`);
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
      out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, ` ${inlineMarkdown(line.trim(), sourceDir)}</li>`);
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
    .map((line) => line.trim().slice(1, -1).split("|").map((cell) => inlineMarkdown(cell.trim(), "")));
  if (rows.length === 0) return "";
  const [head, ...body] = rows;
  const thead = `<thead><tr>${head.map((cell) => `<th>${cell}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody>`;
  return `<div class="table-wrap"><table>${thead}${tbody}</table></div>`;
}

function inlineMarkdown(value, sourceDir) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => `<a href="${escapeAttribute(rewriteMarkdownHref(href, sourceDir))}">${label}</a>`);
}

function rewriteMarkdownHref(href, sourceDir) {
  if (/^(?:https?:|mailto:|#)/.test(href)) return href;
  const [target, suffix = ""] = href.split(/(?=#)/, 2);
  if (target.endsWith(".md")) {
    const normalized = path.posix.normalize(`${sourceDir}/${target}`);
    if (htmlSourceFiles.has(normalized)) return `/${htmlRoute(normalized)}/${suffix}`;
    return `/${normalized}${suffix}`;
  }
  return href;
}

function artifactTable(artifacts) {
  const rows = artifacts
    .map((artifact) => `<tr><td><a href="/${artifact.target}"><code>${escapeHtml(artifact.target)}</code></a></td><td><code>${artifact.sha256.slice(0, 16)}</code></td></tr>`)
    .join("");
  return `<div class="table-wrap"><table><thead><tr><th>Artifact</th><th>SHA-256 prefix</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function writeHeaders() {
  writeText(
    "_headers",
    `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer

/schemas/*.json
  Content-Type: application/schema+json; charset=utf-8
  Cache-Control: public, max-age=300, must-revalidate

/${releasePath}/schemas/*.json
  Content-Type: application/schema+json; charset=utf-8
  Cache-Control: public, max-age=31536000, immutable

/${releasePath}/
  Cache-Control: public, max-age=31536000, immutable

/${releasePath}/index.html
  Cache-Control: public, max-age=31536000, immutable

/${releasePath}/spec/*
  Cache-Control: public, max-age=31536000, immutable

/${releasePath}/docs/*
  Cache-Control: public, max-age=31536000, immutable

/${releasePath}/vectors/*
  Cache-Control: public, max-age=31536000, immutable

/packages.json
  Content-Type: application/json; charset=utf-8
  Cache-Control: public, max-age=300, must-revalidate

/site-manifest.json
  Content-Type: application/json; charset=utf-8
  Cache-Control: public, max-age=300, must-revalidate

/vectors/index.json
  Content-Type: application/json; charset=utf-8
  Cache-Control: public, max-age=300, must-revalidate

/${releasePath}/release.json
  Content-Type: application/json; charset=utf-8
  Cache-Control: public, max-age=31536000, immutable

/${releasePath}/packages.json
  Content-Type: application/json; charset=utf-8
  Cache-Control: public, max-age=31536000, immutable

/${releasePath}/vectors/index.json
  Content-Type: application/json; charset=utf-8
`,
  );
}

function writeRedirects() {
  writeText(
    "_redirects",
    `/schema/* /schemas/:splat 301
/specs/* /spec/:splat 301
/latest/* /:splat 302
`,
  );
}

function readPackages() {
  return trackedFiles("packages")
    .filter((file) => file.endsWith("package.json"))
    .map((file) => {
      const pkg = readJson(file);
      return {
        name: pkg.name,
        version: pkg.version,
        private: pkg.private === true,
        publishTag: pkg.publishConfig?.tag,
        path: path.dirname(file),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function dirtyPublishableInputs() {
  const inputs = new Set([
    "package.json",
    "wrangler.jsonc",
    "site/README.md",
    ...schemaFiles,
    ...specFiles,
    ...docFiles,
    ...vectorFiles,
    ...trackedFiles("packages").filter((file) => file.endsWith("package.json")),
    ...siteScriptFiles,
    ...siteSourceInputs(),
    ...listFiles(RELEASE_LOCK_DIR),
    ...trackedFiles(RELEASE_LOCK_DIR),
  ]);
  return git(["status", "--porcelain=v1", "--untracked-files=all"])
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .map((file) => file.replace(/^"|"$/g, ""))
    .filter((file) => inputs.has(file) || [...inputs].some((input) => file.startsWith(`${input}/`)))
    .sort();
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

function releasePackagesMetadata() {
  return { releaseVersion, packages };
}

function releaseNpmInstall() {
  return PUBLISHABLE_PACKAGES.map((name) => `${name}@alpha`);
}

function releaseContentHash(lockedRelease) {
  const records = listFiles(`${SITE_DIST}/${releasePath}`)
    .map((file) => path.join(root, file))
    .map((file) => ({ file, target: path.relative(outDir, file).replaceAll(path.sep, "/") }))
    .filter(({ target }) => target !== `${releasePath}/release.json`)
    .map(({ file, target }) => fileRecord(target, file));
  records.push(contentRecord(`${releasePath}/release.json`, jsonText(lockedRelease)));
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(records.sort((a, b) => a.target.localeCompare(b.target))))
    .digest("hex");
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
  return git(["ls-files", relativeDir])
    .split(/\r?\n/)
    .filter(Boolean)
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
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
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
