import { isLocalEndpointHost } from "../site/src/assets/endpoint-host.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { isPublishableDirtyPath, containedRegularFile } from "./site-inputs.mjs";
import {
  releaseMetadataForHash,
  usesCompleteMetadataHash,
} from "./release-metadata.mjs";
import {
  assertReleaseLocalSchema,
  requiresReleaseLocalSchemas,
} from "./release-schema.mjs";
import {
  decodePreviewPathname,
  parsePreviewRequestUrl,
  previewHostFromArgs,
} from "./site-preview-inputs.mjs";

test("deleted tracked release locks remain publishable dirty inputs", () => {
  const inputs = new Set(["package.json"]);

  assert.equal(
    isPublishableDirtyPath(
      "site/releases/v0.1.0-alpha.8.json",
      inputs,
      "site/releases",
    ),
    true,
  );
  assert.equal(
    isPublishableDirtyPath("docs/private-note.md", inputs, "site/releases"),
    false,
  );
});

test("site preview binds loopback unless a host is explicitly requested", () => {
  assert.equal(previewHostFromArgs([]), "127.0.0.1");
  assert.equal(previewHostFromArgs(["--host", "0.0.0.0"]), "0.0.0.0");
  assert.throws(() => previewHostFromArgs(["--host"]), /requires/);
});

test("release hashes bind every supported metadata field", () => {
  const release = {
    version: "0.1.0-alpha.11",
    sourceState: "locked",
    dirtyInputs: [],
    contentSha256: "old",
  };
  assert.deepEqual(releaseMetadataForHash(release), {
    ...release,
    contentSha256: "<content-sha256>",
  });
  assert.throws(
    () => releaseMetadataForHash({ ...release, unboundField: true }),
    /unknown fields: unboundField/,
  );
});

test("published Alpha.1-10 retain their historical release rules", () => {
  const legacy = {
    version: "0.1.0-alpha.10",
    generatedFrom: "historical",
    commitDate: "2026-01-01T00:00:00Z",
    sourceState: "locked",
    dirtyInputs: [],
    contentLock: "site/releases/v0.1.0-alpha.10.json",
    snapshotScope: "snapshot",
    activeAlphaOnlyRoutes: ["/"],
    unversionedRoutes: "active alpha",
    npmInstall: ["@kaspa-x402/core@alpha"],
    artifacts: [],
    contentSha256: "historical-hash",
  };

  assert.equal(usesCompleteMetadataHash(legacy.version), false);
  assert.equal(requiresReleaseLocalSchemas(legacy.version), false);
  assert.deepEqual(releaseMetadataForHash(legacy), {
    version: legacy.version,
    sourceState: "locked",
    dirtyInputs: [],
    contentLock: legacy.contentLock,
    snapshotScope: legacy.snapshotScope,
    activeAlphaOnlyRoutes: legacy.activeAlphaOnlyRoutes,
    unversionedRoutes: legacy.unversionedRoutes,
    npmInstall: legacy.npmInstall,
    artifacts: legacy.artifacts,
  });
  assert.equal(usesCompleteMetadataHash("0.1.0-alpha.11"), true);
  assert.equal(requiresReleaseLocalSchemas("0.1.0-alpha.11"), true);
  assert.equal(usesCompleteMetadataHash("0.1.0"), true);
  assert.equal(requiresReleaseLocalSchemas("0.1.0"), true);
});

test("release schemas reject cross-version and external references", () => {
  const id =
    "https://kaspa-x402.org/v0.1.0-alpha.11/schemas/example.schema.json";
  assert.doesNotThrow(() =>
    assertReleaseLocalSchema({ $id: id, $ref: "./other.schema.json" }, id),
  );
  for (const reference of [
    "https://kaspa-x402.org/v0.1.0-alpha.10/schemas/other.schema.json",
    "https://example.test/other.schema.json",
    "../../schemas/other.schema.json",
  ]) {
    assert.throws(
      () => assertReleaseLocalSchema({ $id: id, $ref: reference }, id),
      /escapes release-local schemas/,
    );
  }
});

test("preview input parsing rejects malformed hosts and percent escapes", () => {
  assert.equal(parsePreviewRequestUrl("/demo/", "bad host"), undefined);
  assert.equal(decodePreviewPathname("/%zz"), undefined);
  assert.equal(
    parsePreviewRequestUrl("/demo/", "127.0.0.1:4173")?.pathname,
    "/demo/",
  );
  assert.equal(decodePreviewPathname("/docs%20index"), "/docs index");
});

test("private endpoint admission requires an actual private IP or loopback host", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]", "10.0.3.141", "192.168.1.1", "172.16.0.1", "172.31.255.255"])
    assert.equal(isLocalEndpointHost(host), true, host);
  for (const host of ["10.attacker.test", "192.168.evil.test", "172.16.evil.test", "10.0.0.256", "10.1", "172.32.0.1", "8.8.8.8", ""])
    assert.equal(isLocalEndpointHost(host), false, host);
});

test("publication input rejects traversal, escaping links and non-files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "site-input-"));
  try {
    const root = path.join(dir, "root");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "safe"), "safe");
    fs.writeFileSync(path.join(dir, "outside"), "outside");
    fs.symlinkSync(path.join(dir, "outside"), path.join(root, "escape"));
    fs.symlinkSync(path.join(root, "safe"), path.join(root, "inside"));
    assert.equal(fs.readFileSync(containedRegularFile(root, "inside"), "utf8"), "safe");
    for (const file of ["../outside", "escape", "."]) assert.throws(() => containedRegularFile(root, file));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
