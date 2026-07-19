import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertBatchInteropCrossLinks } from "./validate-schemas.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vector = JSON.parse(
  fs.readFileSync(path.join(root, "vectors/batch/interop-v1.json"), "utf8"),
);

test("accepts the canonical batch interoperability cross-links", () => {
  assert.doesNotThrow(() =>
    assertBatchInteropCrossLinks("vectors/batch/interop-v1.json", vector, root),
  );
});

test("rejects a payout script unrelated to payTo", () => {
  const mutated = structuredClone(vector);
  mutated.escrow.payoutScriptPublicKey = mutated.escrow.refundScriptPublicKey;
  assert.throws(
    () => assertBatchInteropCrossLinks("mutated-pay-to", mutated, root),
    /payTo script public key mismatch/,
  );
});

test("rejects a voucher signer unrelated to the channel client", () => {
  const mutated = structuredClone(vector);
  mutated.voucher.signerPublicKey = mutated.channel.config.serverPublicKey;
  assert.throws(
    () => assertBatchInteropCrossLinks("mutated-signer", mutated, root),
    /voucher signer mismatch/,
  );
});

test("rejects a commitment unrelated to the channel", () => {
  const mutated = structuredClone(vector);
  mutated.commitment.input.channelId = "00".repeat(32);
  assert.throws(
    () => assertBatchInteropCrossLinks("mutated-channel", mutated, root),
    /commitment channel id mismatch/,
  );
});

test("rejects transaction evidence unrelated to the referenced vector", () => {
  const mutated = structuredClone(vector);
  mutated.transactions.claim.sighash.digest = "00".repeat(32);
  assert.throws(
    () => assertBatchInteropCrossLinks("mutated-claim", mutated, root),
    /claim sighash mismatch/,
  );
});
