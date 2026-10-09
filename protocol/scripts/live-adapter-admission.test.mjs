import assert from "node:assert/strict";
import test from "node:test";

import { MemoryPublicBoundaryController } from "@kaspa-x402/server";
import { trustedLoopbackProofRequest } from "./live-adapter-reference.mjs";

test("the live loopback proof keeps one trusted caller through repeated public requests", () => {
  // Failure modes: the eighth-request aggregate cap interrupts the proof,
  // or a request's own admission key replaces the host-controlled value.
  const boundary = new MemoryPublicBoundaryController();
  let trustedKey;
  for (let index = 0; index < 9; index++) {
    const request = trustedLoopbackProofRequest({
      routeAccess: "public",
      url: `http://127.0.0.1/exact/${index}`,
      admissionKey: "00".repeat(32),
    });
    assert.match(request.admissionKey, /^[0-9a-f]{64}$/);
    assert.notEqual(request.admissionKey, "00".repeat(32));
    trustedKey ??= request.admissionKey;
    assert.equal(request.admissionKey, trustedKey);
    boundary.enterRequest(undefined, request.admissionKey).release();
  }
});
