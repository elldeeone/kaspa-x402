import assert from "node:assert/strict";
import test from "node:test";
import { selectedChainEvidenceRemainsCanonical } from "./live-adapter-reference.mjs";

const oldHash = "11".repeat(32);
const tipHash = "22".repeat(32);
const evidence = { checkpoint: { blockHash: oldHash, blueScore: "10" } };
function rpcFor(response, expectedStart = oldHash) {
  return {
    async getBlockDagInfo() { throw new Error("continuity must use one RPC snapshot"); },
    async getVirtualChainFromBlock(request) {
      assert.equal(request.includeAcceptedTransactionIds, false);
      assert.equal(request.startHash, expectedStart);
      return response;
    },
    async getVirtualChainFromBlockV2() { throw new Error("continuity must not download full transactions"); },
  };
}
test("checks checkpoint membership at one node snapshot without walking to a moving tip", async () => {
  const rpc = rpcFor({ removedChainBlockHashes: [], addedChainBlockHashes: [tipHash] });
  assert.equal(await selectedChainEvidenceRemainsCanonical({ rpc, evidence }), true);
});
test("accepts a checkpoint that is still the current tip", async () => {
  const rpc = rpcFor({ removedChainBlockHashes: [], addedChainBlockHashes: [] });
  assert.equal(await selectedChainEvidenceRemainsCanonical({ rpc, evidence }), true);
});
test("rejects a removed checkpoint", async () => {
  const rpc = rpcFor({ removedChainBlockHashes: [oldHash], addedChainBlockHashes: [tipHash] });
  assert.equal(await selectedChainEvidenceRemainsCanonical({ rpc, evidence }), false);
});
test("checks the accepting block even when its later checkpoint tip has changed", async () => {
  const rpc = rpcFor({ removedChainBlockHashes: [], addedChainBlockHashes: [tipHash] });
  assert.equal(await selectedChainEvidenceRemainsCanonical({ rpc, evidence: {
    acceptingBlockHash: oldHash, acceptingBlockBlueScore: "10",
    checkpoint: { blockHash: tipHash, blueScore: "20" },
  } }), true);
});
test("rejects incomplete continuity evidence", async () => {
  const rpc = rpcFor({ removedChainBlockHashes: [], addedChainBlockHashes: [] });
  await assert.rejects(selectedChainEvidenceRemainsCanonical({ rpc, evidence: {
    ...evidence, acceptingBlockHash: "invalid", acceptingBlockBlueScore: "10",
  } }), /invalid/);
  await assert.rejects(selectedChainEvidenceRemainsCanonical({ rpc: rpcFor({ addedChainBlockHashes: [] }), evidence }), /incomplete/);
});
