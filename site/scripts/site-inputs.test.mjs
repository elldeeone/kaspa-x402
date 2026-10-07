import assert from "node:assert/strict";
import test from "node:test";

import {
  decodePreviewPathname,
  parsePreviewRequestUrl,
} from "./site-preview-inputs.mjs";

test("preview input parsing rejects malformed hosts and percent escapes", () => {
  assert.equal(parsePreviewRequestUrl("/demo/", "bad host"), undefined);
  assert.equal(decodePreviewPathname("/%zz"), undefined);
  assert.equal(
    parsePreviewRequestUrl("/demo/", "127.0.0.1:4173")?.pathname,
    "/demo/",
  );
  assert.equal(decodePreviewPathname("/docs%20index"), "/docs index");
});
