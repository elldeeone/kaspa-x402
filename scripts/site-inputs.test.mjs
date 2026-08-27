import assert from "node:assert/strict";
import test from "node:test";

import { isPublishableDirtyPath } from "./site-inputs.mjs";
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
