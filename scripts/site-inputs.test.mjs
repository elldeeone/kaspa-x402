import assert from "node:assert/strict";
import test from "node:test";

import { isPublishableDirtyPath } from "./site-inputs.mjs";

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
