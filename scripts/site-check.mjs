import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isPublishableDirtyPath } from "./site-inputs.mjs";
import { fileURLToPath } from "node:url";

import {
  BROWSER_BUNDLE_INPUTS,
  GENERATED_SITE_ASSETS,
  CONTRACT_FILES,
  PRIVATE_SITE_PATTERNS,
  PUBLIC_DOC_FILES,
  PUBLISHABLE_PACKAGES,
  SCHEMA_FILES,
  SITE_ASSET_FILES,
  SITE_DIST,
  SITE_PACKAGE_NAMES,
  SITE_SRC,
  SPEC_FILES,
  VENDORED_KASPA_WASM,
} from "./site-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, SITE_DIST);
const errors = [];
const requireClean = process.argv.includes("--require-clean");
const siteScriptFiles = [
  "scripts/site-build.mjs",
  "scripts/site-markdown.mjs",
  "scripts/site-check.mjs",
  "scripts/site-config.mjs",
  "scripts/site-inputs.mjs",
  "scripts/site-serve.mjs",
];

if (!fs.existsSync(outDir)) {
  fail("site/dist is missing; run npm run site:build first");
} else {
  checkSchemaInventory();
  checkCopiedArtifacts();
  checkMetadataFreshness();
  checkUntrackedPublishableFiles();
  checkPrivateFiles();
  checkAssetAllowlist();
  checkContent();
  checkLinks();
}

if (errors.length > 0) {
  for (const error of errors) console.error(`site check failed: ${error}`);
  process.exit(1);
}

console.log("site ok");

function checkSchemaInventory() {
  const trackedSchemas = trackedFiles("schemas").filter((file) =>
    file.endsWith(".schema.json"),
  );
  if (
    JSON.stringify(trackedSchemas) !== JSON.stringify([...SCHEMA_FILES].sort())
  ) {
    fail(
      `schema inventory mismatch: tracked=${trackedSchemas.join(", ")} configured=${SCHEMA_FILES.join(", ")}`,
    );
  }
  for (const source of SCHEMA_FILES) {
    const schema = readJson(path.join(root, source));
    const expectedPath = new URL(schema.$id).pathname.slice(1);
    if (expectedPath !== source) {
      fail(`${source} $id path mismatch: ${schema.$id}`);
    }
    assertFile(path.join(outDir, source), `${source} route`);
    assertContains(
      path.join(outDir, "_headers"),
      "/schemas/*.json",
      "_headers schema rule",
    );
  }
}

function checkCopiedArtifacts() {
  const vectors = trackedFiles("vectors").filter(
    (file) => file.endsWith(".json") || file.endsWith(".md"),
  );
  const activeFiles = [
    ...SCHEMA_FILES,
    ...SPEC_FILES,
    ...CONTRACT_FILES,
    ...PUBLIC_DOC_FILES,
    ...vectors,
  ];
  for (const source of activeFiles) {
    assertSameBytes(path.join(root, source), path.join(outDir, source), source);
  }
}

function checkMetadataFreshness() {
  const manifest = readJson(path.join(outDir, "site-manifest.json"));
  const release = readJson(path.join(outDir, "release.json"));
  const packages = readPackages();
  const publicPackages = packages.filter((pkg) =>
    PUBLISHABLE_PACKAGES.includes(pkg.name),
  );
  const dirtyInputs = dirtyPublishableInputs();
  const headersPath = path.join(outDir, "_headers");
  const expectedRelease = {
    version: manifest.releaseVersion,
    channel: "rc",
    network: "kaspa:testnet-10",
    generatedFrom: manifest.generatedFrom,
    commitDate: manifest.commitDate,
    sourceState: manifest.sourceState,
    dirtyInputs,
    npmInstall: releaseNpmInstall(manifest.releaseVersion),
    packages: publicPackages,
  };

  assertFile(path.join(outDir, "404.html"), "404 page");
  assertFile(path.join(outDir, "release.json"), "release.json");
  assertContains(headersPath, "/release.json", "release.json cache header");
  if (manifest.generatedFrom !== git(["rev-parse", "HEAD"]))
    fail("site-manifest generatedFrom does not match HEAD");
  if (manifest.releaseMetadata !== "/release.json")
    fail("site-manifest release metadata route is stale");
  if (JSON.stringify(release) !== JSON.stringify(expectedRelease))
    fail("release.json is stale");
  if (JSON.stringify(manifest.packages) !== JSON.stringify(publicPackages))
    fail("site-manifest package metadata is stale");
  if (
    JSON.stringify(readJson(path.join(outDir, "packages.json")).packages) !==
    JSON.stringify(publicPackages)
  )
    fail("packages.json is stale");
  if (JSON.stringify(manifest.dirtyInputs) !== JSON.stringify(dirtyInputs))
    fail("site-manifest dirtyInputs is stale");
  if (requireClean && dirtyInputs.length > 0)
    fail(`publishable inputs are dirty: ${dirtyInputs.join(", ")}`);
}

function checkUntrackedPublishableFiles() {
  const untrackedVectors = git([
    "ls-files",
    "--others",
    "--exclude-standard",
    "vectors",
  ])
    .split(/\r?\n/)
    .filter((file) => /\.(?:json|md)$/.test(file));
  for (const file of untrackedVectors) {
    if (!fs.existsSync(path.join(outDir, file)))
      fail(`untracked vector-like file was not copied by site build: ${file}`);
  }
}

function checkPrivateFiles() {
  const outputFiles = listFiles(outDir);
  for (const file of outputFiles) {
    const relative = path.relative(outDir, file).replaceAll(path.sep, "/");
    for (const pattern of PRIVATE_SITE_PATTERNS) {
      if (pattern.test(relative)) fail(`private path published: ${relative}`);
    }
  }
}

function checkAssetAllowlist() {
  const expectedAssets = new Set([
    ...GENERATED_SITE_ASSETS,
    "assets/styles.css",
    ...SITE_ASSET_FILES.map((file) =>
      path.relative(SITE_SRC, file).replaceAll(path.sep, "/"),
    ),
  ]);
  assertSameBytes(
    path.join(root, "site/src/styles.css"),
    path.join(outDir, "assets/styles.css"),
    "assets/styles.css",
  );
  for (const source of SITE_ASSET_FILES) {
    const target = path.relative(SITE_SRC, source).replaceAll(path.sep, "/");
    assertSameBytes(path.join(root, source), path.join(outDir, target), target);
  }
  const vendorPackageJson = readJson(
    path.join(root, "site/src/vendor/kaspa-wasm/2.0.0/kaspa-core/package.json"),
  );
  if (
    vendorPackageJson.name !== VENDORED_KASPA_WASM.package ||
    vendorPackageJson.version !== VENDORED_KASPA_WASM.version
  ) {
    fail(
      "vendored kaspa-wasm package metadata does not match pinned provenance",
    );
  }
  for (const asset of VENDORED_KASPA_WASM.files) {
    if (!SITE_ASSET_FILES.includes(asset.source))
      fail(
        `vendored kaspa-wasm file is not in site asset allowlist: ${asset.source}`,
      );
    if (
      path.relative(SITE_SRC, asset.source).replaceAll(path.sep, "/") !==
      asset.target
    ) {
      fail(`vendored kaspa-wasm target mismatch: ${asset.source}`);
    }
    const sourcePath = path.join(root, asset.source);
    const targetPath = path.join(outDir, asset.target);
    if (!fs.existsSync(sourcePath))
      fail(`missing vendored kaspa-wasm source: ${asset.source}`);
    if (!fs.existsSync(targetPath))
      fail(`missing vendored kaspa-wasm output: ${asset.target}`);
    if (fs.existsSync(sourcePath) && sha256File(sourcePath) !== asset.sha256)
      fail(`vendored kaspa-wasm source hash drifted: ${asset.source}`);
    if (fs.existsSync(targetPath) && sha256File(targetPath) !== asset.sha256)
      fail(`vendored kaspa-wasm output hash drifted: ${asset.target}`);
  }
  for (const file of listFiles(outDir).filter((item) => {
    const relative = path.relative(outDir, item).replaceAll(path.sep, "/");
    return relative.startsWith("assets/") || relative.startsWith("vendor/");
  })) {
    const relative = path.relative(outDir, file).replaceAll(path.sep, "/");
    if (!expectedAssets.has(relative))
      fail(`unexpected generated asset: ${relative}`);
  }
  const headersPath = path.join(outDir, "_headers");
  assertContains(
    path.join(outDir, "assets/demo.js"),
    "/vendor/kaspa-wasm/2.0.0/kaspa-core/kaspa.js",
    "demo SDK import",
  );
  assertContains(headersPath, "/assets/*.js", "javascript asset header");
  assertContains(headersPath, "/assets/*.css", "css asset header");
  assertContains(headersPath, "/vendor/kaspa-wasm/*", "vendor cache header");
  assertContains(
    headersPath,
    "/vendor/kaspa-wasm/*.wasm",
    "vendor wasm header",
  );
  assertContains(
    headersPath,
    "Content-Type: application/wasm",
    "wasm content type header",
  );
  assertContains(headersPath, "/demo/", "demo no-transform header");
  assertContains(
    headersPath,
    "Cache-Control: public, max-age=300, must-revalidate, no-transform",
    "demo no-transform cache rule",
  );
}

function checkContent() {
  const textFiles = listFiles(outDir).filter((file) => {
    const relative = path.relative(outDir, file).replaceAll(path.sep, "/");
    return (
      /\.(html|md|json|txt|css|svg)$/.test(file) ||
      (relative.startsWith("assets/") && file.endsWith(".js"))
    );
  });
  const internalPhase = /\b(?:P[0-9]+|Phase\s+[0-9]+)\b/i;
  const privateRepoReference =
    /(?:\/home\/[^/\s]+\/projects\/[^\s)]+|projects\/[^\s)]+)/i;
  const privateIpv4 =
    /\b(?:10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2})\b/;
  const localEndpoint =
    /\b(?:wss?|https?):\/\/(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/i;
  const readinessClaims = [
    /\bmainnet\s+ready\b/i,
    /\bready\s+for\s+mainnet\b/i,
    /\bproduction\s+ready\b/i,
    /\bmainnet-ready\b/i,
  ];
  const secretPatterns = [
    /\bnpm_[A-Za-z0-9]{20,}\b/,
    /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\b(?:api|access|secret|private|auth)[_-]?key\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{16,}/i,
    /\b(?:token|password|passwd)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{16,}/i,
  ];

  for (const file of textFiles) {
    const relative = path.relative(outDir, file).replaceAll(path.sep, "/");
    const text = fs.readFileSync(file, "utf8");
    // Bundled cryptography uses identifiers such as p1/p2. Editorial labels
    // are checked in authored content; generated JS still gets secret checks.
    if (!GENERATED_SITE_ASSETS.includes(relative) && internalPhase.test(text))
      fail(`internal phase label in ${relative}`);
    if (privateRepoReference.test(text))
      fail(`private repo reference in ${relative}`);
    if (privateIpv4.test(text) || localEndpoint.test(text))
      fail(`private network endpoint in ${relative}`);
    for (const pattern of secretPatterns) {
      if (pattern.test(text)) fail(`secret-like value in ${relative}`);
    }
    for (const pattern of readinessClaims) {
      if (pattern.test(text))
        fail(`mainnet/production readiness claim in ${relative}`);
    }
  }

  const { releaseVersion } = readJson(path.join(outDir, "site-manifest.json"));
  for (const file of textFiles.filter((file) => file.endsWith(".html"))) {
    assertContains(
      file,
      `<strong>${releaseVersion} released</strong>`,
      "shared published-release status",
    );
  }
  for (const source of [...SPEC_FILES, ...PUBLIC_DOC_FILES]) {
    const file = path.join(outDir, source.replace(/\.md$/, "/index.html"));
    const prose = fs.readFileSync(file, "utf8")
      .replace(/<(pre|code)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<[^>]*>/g, "");
    if (prose.includes("**")) fail(`unrendered Markdown emphasis in ${source}`);
  }

  const home = path.join(outDir, "index.html");
  assertContains(home, "Payment schemes", "homepage scheme heading");
  assertContains(
    home,
    "kaspa-batch-settlement-v3",
    "homepage active batch specification",
  );
  assertNotContains(
    home,
    "kaspa-batch-settlement-v1",
    "homepage excludes superseded batch binding",
  );
  assertContains(
    path.join(outDir, "demo/index.html"),
    "Current Lane And Voucher",
    "browser demo exposes v1 RC2 batch lane state",
  );
  assertContains(
    path.join(outDir, "assets/demo.js"),
    'binding: "kaspa-escrow-v3"',
    "browser demo uses active escrow binding",
  );
  for (const privatePackage of ["@kaspa-x402/cli", "@kaspa-x402/facilitator"]) {
    assertNotContains(
      home,
      `<code>${privatePackage}</code>`,
      `homepage excludes ${privatePackage}`,
    );
  }
}

function checkLinks() {
  const htmlFiles = listFiles(outDir).filter((file) => file.endsWith(".html"));
  for (const file of htmlFiles) {
    const html = fs.readFileSync(file, "utf8");
    for (const match of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
      const target = match[1];
      if (
        target.startsWith("http://") ||
        target.startsWith("https://") ||
        target.startsWith("mailto:") ||
        target.startsWith("#")
      ) {
        continue;
      }
      const resolved = resolveLocalHref(file, target);
      if (!isInsideOutput(resolved)) {
        fail(
          `link escapes output from ${path.relative(outDir, file)} to ${target}`,
        );
        continue;
      }
      if (!fs.existsSync(resolved)) {
        fail(`broken link from ${path.relative(outDir, file)} to ${target}`);
      }
    }
  }

  const cssFiles = listFiles(outDir).filter((file) => file.endsWith(".css"));
  for (const file of cssFiles) {
    const css = fs.readFileSync(file, "utf8");
    for (const match of css.matchAll(/url\(([^)]+)\)/g)) {
      const target = match[1].trim().replace(/^['"]|['"]$/g, "");
      if (
        target.startsWith("data:") ||
        target.startsWith("http://") ||
        target.startsWith("https://")
      )
        continue;
      const resolved = resolveLocalHref(file, target);
      if (!isInsideOutput(resolved)) {
        fail(
          `CSS asset escapes output from ${path.relative(outDir, file)} to ${target}`,
        );
        continue;
      }
      if (!fs.existsSync(resolved))
        fail(
          `broken CSS asset from ${path.relative(outDir, file)} to ${target}`,
        );
    }
  }
}

function resolveLocalHref(fromFile, href) {
  const clean = href.split("#")[0].split("?")[0];
  const base = clean.startsWith("/")
    ? path.join(outDir, clean)
    : path.resolve(path.dirname(fromFile), clean);
  if (clean === "" || clean.endsWith("/")) return path.join(base, "index.html");
  if (path.extname(base) === "") return path.join(base, "index.html");
  return base;
}

function isInsideOutput(file) {
  const relative = path.relative(outDir, file);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

function assertFile(file, label) {
  if (!fs.existsSync(file)) fail(`missing ${label}`);
}

function assertSameBytes(source, target, label) {
  if (!fs.existsSync(target)) {
    fail(`missing ${label}`);
    return;
  }
  if (sha256File(source) !== sha256File(target))
    fail(`stale copied artifact: ${label}`);
}

function assertContains(file, needle, label) {
  if (!fs.existsSync(file)) {
    fail(`missing ${label}`);
    return;
  }
  if (!fs.readFileSync(file, "utf8").includes(needle)) fail(`missing ${label}`);
}

function assertNotContains(file, needle, label) {
  if (!fs.existsSync(file)) {
    fail(`missing ${label}`);
    return;
  }
  if (fs.readFileSync(file, "utf8").includes(needle)) {
    fail(`unexpected ${label}`);
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readPackages() {
  const packagesByName = new Map(
    trackedPackageFiles().map((file) => {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
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
    if (pkg === undefined) fail(`missing site package metadata: ${name}`);
    return pkg;
  })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function dirtyPublishableInputs() {
  const vectors = trackedFiles("vectors").filter(
    (file) => file.endsWith(".json") || file.endsWith(".md"),
  );
  const inputs = new Set([
    "package.json",
    "wrangler.jsonc",
    "site/README.md",
    ...SCHEMA_FILES,
    ...SPEC_FILES,
    ...CONTRACT_FILES,
    ...PUBLIC_DOC_FILES,
    ...vectors,
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
  return trackedFiles("packages").filter((file) =>
    file.endsWith("package.json"),
  );
}

function sitePackageFiles() {
  const sitePackages = new Set(SITE_PACKAGE_NAMES);
  return trackedPackageFiles().filter((file) =>
    sitePackages.has(readJson(path.join(root, file)).name),
  );
}

function siteSourceInputs() {
  return ["site/src/styles.css", ...SITE_ASSET_FILES];
}

function trackedFiles(relativeDir) {
  const files = new Set([
    ...git(["ls-files", relativeDir]).split(/\r?\n/).filter(Boolean),
    ...listFiles(path.join(root, relativeDir)).map((file) =>
      path.relative(root, file).replaceAll(path.sep, "/"),
    ),
  ]);
  return [...files]
    .filter((file) => fs.existsSync(path.join(root, file)))
    .sort();
}

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return listFiles(full);
      return entry.isFile() ? [full] : [];
    })
    .sort();
}

function sha256File(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

function releaseNpmInstall(version) {
  return PUBLISHABLE_PACKAGES.map((name) => `${name}@${version}`);
}

function fail(message) {
  errors.push(message);
}
