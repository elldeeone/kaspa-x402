import {
  applyCovenantSelectedChainUpdate,
  sha256Hex,
  type CovenantLineageState,
  type CovenantSelectedChainUpdate,
} from "../src/index.js";

/** One verified top-up per block, used to cross the 64-event compaction edge. */
export function appendCompactionTopUp(
  state: CovenantLineageState,
  index: number,
): CovenantLineageState {
  return applyCovenantSelectedChainUpdate(state, compactionTopUpUpdate(state, index));
}

export function compactionTopUpUpdate(
  state: CovenantLineageState,
  index: number,
): CovenantSelectedChainUpdate {
  const head = state.currentHead;
  if (!head) throw new Error("compaction fixture requires a live covenant head");
  const transactionId = sha256Hex(`compaction-transaction:${index}`);
  const blockHash = sha256Hex(`compaction-block:${index}`);
  const checkpoint = {
    blockHash: "ef".repeat(32),
    blueScore: "1000",
    daaScore: "1000",
  };
  return {
    fromCheckpoint: state.checkpoint,
    checkpoint,
    continuity: "complete",
    removedChainBlockHashes: [],
    addedChainBlocks: [{
      blockHash,
      transitions: [{
        kind: "top-up",
        covenantId: state.manifest.genesis.covenantId,
        templateId: state.manifest.bytecode.templateId,
        consumedOutpoint: head.outpoint,
        transactionId,
        authorizedSuccessorCount: 1,
        successor: {
          covenantId: state.manifest.genesis.covenantId,
          authorizingInput: 0,
          outpoint: { txid: transactionId, index: 0 },
          scriptPublicKey: head.scriptPublicKey,
          value: (BigInt(head.value) + 1n).toString(),
          claimedCumulativeAmount: head.claimedCumulativeAmount,
        },
        terminalOutput: null,
        acceptance: {
          status: "accepted",
          transactionId,
          acceptingBlockHash: blockHash,
          acceptingBlockBlueScore: "971",
          confirmationCount: 30,
          checkpoint,
        },
      }],
    }],
  };
}
