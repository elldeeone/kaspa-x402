import assert from "node:assert/strict";
import test from "node:test";

import { isPublishableDirtyPath } from "./site-inputs.mjs";
import { releaseMetadataForHash } from "./release-metadata.mjs";
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

test("preview input parsing rejects malformed hosts and percent escapes", () => {
  assert.equal(parsePreviewRequestUrl("/demo/", "bad host"), undefined);
  assert.equal(decodePreviewPathname("/%zz"), undefined);
  assert.equal(
    parsePreviewRequestUrl("/demo/", "127.0.0.1:4173")?.pathname,
    "/demo/",
  );
  assert.equal(decodePreviewPathname("/docs%20index"), "/docs index");
});
