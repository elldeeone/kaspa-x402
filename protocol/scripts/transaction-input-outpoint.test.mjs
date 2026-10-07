import assert from "node:assert/strict";
import test from "node:test";

import { transactionInputOutpoint } from "./transaction-input-outpoint.mjs";

test("reads nested SDK input outpoints", () => {
  assert.deepEqual(
    transactionInputOutpoint({
      previousOutpoint: { transactionId: "11".repeat(32), index: 2 },
    }),
    { txid: "11".repeat(32), index: 2 },
  );
  assert.deepEqual(
    transactionInputOutpoint({
      utxo: { outpoint: { transactionId: "22".repeat(32), index: 3 } },
    }),
    { txid: "22".repeat(32), index: 3 },
  );
});

test("reads flattened SilverScript v1 input outpoints", () => {
  assert.deepEqual(
    transactionInputOutpoint({ transactionId: "33".repeat(32), index: 4 }),
    { txid: "33".repeat(32), index: 4 },
  );
});

test("rejects inputs without a complete outpoint", () => {
  assert.equal(transactionInputOutpoint({ index: 0 }), undefined);
  assert.equal(transactionInputOutpoint({ transactionId: "44".repeat(32) }), undefined);
});
