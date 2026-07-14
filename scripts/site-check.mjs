import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isPublishableDirtyPath } from "./site-inputs.mjs";
import { fileURLToPath } from "node:url";

import {
  PRIVATE_SITE_PATTERNS,
  PUBLIC_DOC_FILES,
  PUBLISHABLE_PACKAGES,
  RELEASE_DOC_FILES,
  RELEASE_LOCK_DIR,
  RELEASE_SNAPSHOT_DIR,
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
  "scripts/site-check.mjs",
  "scripts/site-config.mjs",
  "scripts/site-serve.mjs",
];
const releaseSnapshotScope =
  "schemas, specs, selected docs, vectors, package metadata, and release metadata";
const activeAlphaOnlyRoutes = [
  "/",
  "/demo/",
  "/assets/",
  "/vendor/",
  "/site-manifest.json",
  "/releases/",
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
    ...PUBLIC_DOC_FILES,
    ...vectors,
  ];
  const releaseFiles = [
    ...SCHEMA_FILES,
    ...SPEC_FILES,
    ...RELEASE_DOC_FILES,
    ...vectors,
  ];
  const releasePath = readJson(
    path.join(outDir, "site-manifest.json"),
  ).releasePath;
  for (const source of activeFiles) {
    assertSameBytes(path.join(root, source), path.join(outDir, source), source);
  }
  for (const source of releaseFiles) {
    assertSameBytes(
      path.join(root, source),
      path.join(outDir, releasePath, source),
      `${releasePath}/${source}`,
    );
  }
}

function checkMetadataFreshness() {
  const manifest = readJson(path.join(outDir, "site-manifest.json"));
  const release = readJson(
    path.join(outDir, manifest.releasePath, "release.json"),
  );
  const packages = readPackages();
  const releasePackages = { releaseVersion: manifest.releaseVersion, packages };
  const dirtyInputs = dirtyPublishableInputs();
  const expectedReleaseHash = releaseContentHash(
    manifest.releasePath,
    lockedReleaseMetadata(release),
  );
  const headersPath = path.join(outDir, "_headers");

  assertFile(path.join(outDir, "404.html"), "404 page");
  if (manifest.generatedFrom !== git(["rev-parse", "HEAD"]))
    fail("site-manifest generatedFrom does not match HEAD");
  if (
    dirtyInputs.length > 0 &&
    release.generatedFrom !== manifest.generatedFrom
  )
    fail("dirty release generatedFrom does not match site-manifest");
  if (dirtyInputs.length === 0 && "generatedFrom" in release)
    fail("locked release should not vary by build commit");
  if (release.version !== manifest.releaseVersion)
    fail("release version does not match site-manifest");
  if (manifest.releaseSnapshotScope !== releaseSnapshotScope)
    fail("site-manifest release snapshot scope is stale");
  if (release.snapshotScope !== releaseSnapshotScope)
    fail("release snapshot scope is stale");
  if (
    JSON.stringify(manifest.activeAlphaOnlyRoutes) !==
    JSON.stringify(activeAlphaOnlyRoutes)
  )
    fail("site-manifest active-alpha routes are stale");
  if (
    JSON.stringify(release.activeAlphaOnlyRoutes) !==
    JSON.stringify(activeAlphaOnlyRoutes)
  )
    fail("release active-alpha routes are stale");
  if (
    JSON.stringify(release.npmInstall) !== JSON.stringify(releaseNpmInstall())
  )
    fail("release npm install metadata is stale");
  if (JSON.stringify(manifest.packages) !== JSON.stringify(packages))
    fail("site-manifest package metadata is stale");
  if (
    JSON.stringify(readJson(path.join(outDir, "packages.json")).packages) !==
    JSON.stringify(packages)
  )
    fail("packages.json is stale");
  const versionedPackages = readJson(
    path.join(outDir, manifest.releasePath, "packages.json"),
  );
  if ("generatedFrom" in versionedPackages || "commitDate" in versionedPackages)
    fail("release packages.json should not vary by build commit");
  if (JSON.stringify(versionedPackages) !== JSON.stringify(releasePackages)) {
    fail("release packages.json is stale");
  }
  if (JSON.stringify(manifest.dirtyInputs) !== JSON.stringify(dirtyInputs))
    fail("site-manifest dirtyInputs is stale");
  if (JSON.stringify(release.dirtyInputs) !== JSON.stringify(dirtyInputs))
    fail("release dirtyInputs is stale");
  if (release.contentSha256 !== expectedReleaseHash)
    fail("release content hash is stale");
  if (requireClean && dirtyInputs.length > 0)
    fail(`publishable inputs are dirty: ${dirtyInputs.join(", ")}`);
  checkReleaseSnapshots(manifest, dirtyInputs, headersPath);
}

function checkReleaseSnapshots(manifest, dirtyInputs, headersPath) {
  const releaseLocks = readReleaseLocks();
  const expectedReleases = releaseLocks.map((entry) => ({
    version: entry.version,
    path: `/v${entry.version}/`,
    metadata: `/v${entry.version}/release.json`,
    contentSha256: entry.contentSha256,
  }));
  if (JSON.stringify(manifest.releases) !== JSON.stringify(expectedReleases))
    fail("site-manifest release list is stale");

  const currentLock = releaseLocks.find(
    (entry) => entry.version === manifest.releaseVersion,
  );
  if (!currentLock && (requireClean || dirtyInputs.length === 0))
    fail(`release ${manifest.releaseVersion} is missing a content lock`);

  for (const lock of releaseLocks) {
    const releasePath = `v${lock.version}`;
    const releaseJson = path.join(outDir, releasePath, "release.json");
    assertFile(releaseJson, `${releasePath}/release.json`);
    if (!fs.existsSync(releaseJson)) continue;

    const release = readJson(releaseJson);
    const expectedHash = releaseContentHash(
      releasePath,
      lockedReleaseMetadata(release),
    );
    if (release.version !== lock.version)
      fail(`${releasePath}/release.json version is stale`);
    if (release.contentSha256 !== lock.contentSha256)
      fail(`release content differs from ${lock.path}`);
    if (release.contentLock !== lock.path)
      fail(`${releasePath}/release.json content lock path is stale`);
    if (expectedHash !== lock.contentSha256)
      fail(`${releasePath} bytes differ from ${lock.path}`);

    for (const route of [
      `/${releasePath}/`,
      `/${releasePath}/index.html`,
      `/${releasePath}/schemas/*.json`,
      `/${releasePath}/spec/*`,
      `/${releasePath}/docs/*`,
      `/${releasePath}/vectors/*`,
      `/${releasePath}/release.json`,
      `/${releasePath}/packages.json`,
      `/${releasePath}/vectors/index.json`,
    ]) {
      assertContains(headersPath, route, `immutable release header ${route}`);
    }

    checkActiveAlphaExclusions(releasePath);
    if (releasePath !== manifest.releasePath || dirtyInputs.length === 0) {
      assertSameTree(
        path.join(root, RELEASE_SNAPSHOT_DIR, releasePath),
        path.join(outDir, releasePath),
        `${releasePath} stored snapshot`,
      );
    }
  }
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

function checkActiveAlphaExclusions(releasePath) {
  for (const route of activeAlphaOnlyRoutes) {
    if (route === "/") continue;
    const relative = route.replace(/^\/|\/$/g, "");
    if (!relative) continue;
    const candidate = path.join(outDir, releasePath, relative);
    if (fs.existsSync(candidate))
      fail(
        `active-alpha route included in release snapshot: ${releasePath}/${relative}`,
      );
  }
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
    if (internalPhase.test(text)) fail(`internal phase label in ${relative}`);
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

  const activeTextFiles = textFiles.filter((file) => {
    const relative = path.relative(outDir, file).replaceAll(path.sep, "/");
    return !/^v0\.1\.0-alpha\.[0-6]\//.test(relative);
  });
  const staleCurrentClaims = [
    /standard-output storage-mass floor(?:,|\s*\()/i,
    /must (?:clear|sit at or above)[^.]*storage-mass/i,
    /Alpha\.6 focuses on preferred KIP-10/i,
    /For real paid requests, use the hosted gateway/i,
  ];
  for (const file of activeTextFiles) {
    const relative = path.relative(outDir, file).replaceAll(path.sep, "/");
    const text = fs.readFileSync(file, "utf8");
    for (const pattern of staleCurrentClaims) {
      if (pattern.test(text))
        fail(`stale active-alpha claim in ${relative}: ${pattern}`);
    }
  }

  for (const relative of [
    "index.html",
    "demo/index.html",
    "docs/testnet-gateway.md",
    "docs/demo-interop-checklist.md",
  ]) {
    assertContains(
      path.join(outDir, relative),
      "paid-canary",
      `${relative} current-alpha paid-canary evidence`,
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

function assertSameTree(sourceDir, targetDir, label) {
  if (!fs.existsSync(sourceDir)) {
    fail(
      `missing ${label}: ${path.relative(root, sourceDir).replaceAll(path.sep, "/")}`,
    );
    return;
  }
  if (!fs.existsSync(targetDir)) {
    fail(
      `missing ${label}: ${path.relative(outDir, targetDir).replaceAll(path.sep, "/")}`,
    );
    return;
  }
  const sourceFiles = listRelativeFiles(sourceDir);
  const targetFiles = listRelativeFiles(targetDir);
  if (JSON.stringify(sourceFiles) !== JSON.stringify(targetFiles)) {
    fail(`stored release snapshot file list differs: ${label}`);
    return;
  }
  for (const file of sourceFiles) {
    if (
      sha256File(path.join(sourceDir, file)) !==
      sha256File(path.join(targetDir, file))
    ) {
      fail(`stored release snapshot differs: ${label}/${file}`);
    }
  }
}

function assertContains(file, needle, label) {
  if (!fs.existsSync(file)) {
    fail(`missing ${label}`);
    return;
  }
  if (!fs.readFileSync(file, "utf8").includes(needle)) fail(`missing ${label}`);
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
    ...PUBLIC_DOC_FILES,
    ...vectors,
    ...sitePackageFiles(),
    ...siteScriptFiles,
    ...siteSourceInputs(),
    ...listFiles(path.join(root, RELEASE_LOCK_DIR)).map((file) =>
      path.relative(root, file).replaceAll(path.sep, "/"),
    ),
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
    sitePackages.has(readJson(path.join(root, file)).name),
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
  return listFiles(path.join(root, RELEASE_LOCK_DIR))
    .map((file) => path.relative(root, file).replaceAll(path.sep, "/"))
    .filter((file) => /^site\/releases\/v[^/]+\.json$/.test(file))
    .map((file) => ({ ...readJson(path.join(root, file)), path: file }))
    .sort((a, b) => compareVersions(a.version, b.version));
}

function compareVersions(left, right) {
  return String(left).localeCompare(String(right), "en", { numeric: true });
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

function listRelativeFiles(dir) {
  return listFiles(dir)
    .map((file) => path.relative(dir, file).replaceAll(path.sep, "/"))
    .sort();
}

function sha256File(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

function releaseNpmInstall() {
  return PUBLISHABLE_PACKAGES.map((name) => `${name}@alpha`);
}

function lockedReleaseMetadata(release) {
  return {
    version: release.version,
    sourceState: "locked",
    dirtyInputs: [],
    contentLock: release.contentLock,
    snapshotScope: release.snapshotScope,
    activeAlphaOnlyRoutes: release.activeAlphaOnlyRoutes,
    unversionedRoutes: release.unversionedRoutes,
    npmInstall: release.npmInstall,
    artifacts: release.artifacts,
  };
}

function releaseContentHash(releasePath, lockedRelease) {
  const records = listFiles(path.join(outDir, releasePath))
    .map((file) => ({
      file,
      target: path.relative(outDir, file).replaceAll(path.sep, "/"),
    }))
    .filter(({ target }) => target !== `${releasePath}/release.json`)
    .map(({ file, target }) => fileRecord(target, file));
  records.push(
    contentRecord(`${releasePath}/release.json`, jsonText(lockedRelease)),
  );
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify(records.sort((a, b) => a.target.localeCompare(b.target))),
    )
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

function fail(message) {
  errors.push(message);
}
