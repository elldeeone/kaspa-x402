import assert from "node:assert/strict";
import test from "node:test";

import { readBoundedResponseText } from "./read-bounded-response.mjs";

const tooLargeMessage = "response too large";

test("rejects an oversized declared response before reading the body", async () => {
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array([1]));
      controller.close();
    },
  });
  const response = new Response(body, {
    headers: { "content-length": "5" },
  });

  await assert.rejects(
    readBoundedResponseText(response, {
      maxBytes: 4,
      tooLargeMessage,
    }),
    new Error(tooLargeMessage),
  );
});

test("cancels a chunked response after it exceeds the byte limit", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.enqueue(new Uint8Array([3, 4]));
    },
    cancel() {
      cancelled = true;
    },
  });

  await assert.rejects(
    readBoundedResponseText(new Response(body), {
      maxBytes: 3,
      tooLargeMessage,
    }),
    new Error(tooLargeMessage),
  );
  assert.equal(cancelled, true);
});

test("decodes split UTF-8 input at the exact byte limit", async () => {
  const encoded = new TextEncoder().encode("A€");
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoded.subarray(0, 2));
      controller.enqueue(encoded.subarray(2));
      controller.close();
    },
  });

  await assert.doesNotReject(async () => {
    assert.equal(
      await readBoundedResponseText(new Response(body), {
        maxBytes: encoded.byteLength,
        tooLargeMessage,
      }),
      "A€",
    );
  });
});

test("returns an empty string for a response without a body", async () => {
  assert.equal(
    await readBoundedResponseText(new Response(null), {
      maxBytes: 1,
      tooLargeMessage,
    }),
    "",
  );
});
