import assert from "node:assert/strict";
import test from "node:test";
import { selectedChainEvidenceRemainsCanonical } from "./live-adapter-reference.mjs";

const oldHash = "11".repeat(32);
const middleHash = "22".repeat(32);
const currentHash = "33".repeat(32);
const evidence = { checkpoint: { blockHash: oldHash, blueScore: "10" } };
function rpcFor(pages) {
  let page = 0;
  return {
    async getBlockDagInfo() { return { sink: currentHash }; },
    async getBlock() { return { header: { hash: currentHash, blueScore: "30", daaScore: "40" } }; },
    async getVirtualChainFromBlock(request) {
      assert.equal(request.includeAcceptedTransactionIds, false);
      assert.equal(request.startHash, page === 0 ? oldHash : middleHash);
      return pages[page++];
    },
    async getVirtualChainFromBlockV2() { throw new Error("continuity must not download full transactions"); },
  };
}
test("checks checkpoint continuity using paginated chain hashes", async () => {
  const rpc = rpcFor([
    { removedChainBlockHashes: [], addedChainBlockHashes: [middleHash] },
    { removedChainBlockHashes: [], addedChainBlockHashes: [currentHash] },
  ]);
  assert.equal(await selectedChainEvidenceRemainsCanonical({ rpc, evidence }), true);
});
test("rejects a rollback on a later page", async () => {
  const rpc = rpcFor([
    { removedChainBlockHashes: [], addedChainBlockHashes: [middleHash] },
    { removedChainBlockHashes: [middleHash], addedChainBlockHashes: [currentHash] },
  ]);
  assert.equal(await selectedChainEvidenceRemainsCanonical({ rpc, evidence }), false);
});
test("fails closed when traversal ends before the current checkpoint", async () => {
  const rpc = rpcFor([{ removedChainBlockHashes: [], addedChainBlockHashes: [] }]);
  await assert.rejects(selectedChainEvidenceRemainsCanonical({ rpc, evidence }), /did not reach/);
});
