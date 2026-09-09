import { describe, expect, it } from "vitest";

import {
  CovenantChainObserver,
  TESTNET_10_CONFIRMATION_THRESHOLD,
  applyCovenantSelectedChainUpdate,
  assertCovenantLineageConfirmed,
  canonicalCovenantTransitions,
  createCovenantLineageState,
  decideChainEvidence,
  sha256Hex,
  stableStringify,
  type AcceptedTransactionEvidence,
  type ChainCheckpoint,
  type CovenantLaunchManifest,
  type CovenantLineageState,
  type CovenantLineageTransition,
} from "../src/index.js";

const GENESIS_TX = "11".repeat(32);
const CLAIM_TX = "22".repeat(32);
const REPLACEMENT_TX = "33".repeat(32);
const COVENANT_ID = "44".repeat(32);
const GENESIS_BLOCK = "aa".repeat(32);
const CLAIM_BLOCK = "bb".repeat(32);
const REPLACEMENT_BLOCK = "cc".repeat(32);

describe("trusted chain evidence policy", () => {
  it.each([29, 30, 31])(
    "derives confirmation policy from the numeric count at %s confirmations",
    (confirmationCount) => {
      const evidence = acceptedEvidence({
        transactionId: CLAIM_TX,
        acceptingBlockHash: CLAIM_BLOCK,
        acceptingBlockBlueScore: "100",
        checkpoint: checkpoint(
          "dd".repeat(32),
          String(99 + confirmationCount),
        ),
        confirmationCount,
      });
      expect(
        decideChainEvidence(
          { ...evidence, finality: "confirmed" } as never,
          TESTNET_10_CONFIRMATION_THRESHOLD,
        ).status,
      ).toBe(confirmationCount >= 30 ? "confirmed" : "accepted");
    },
  );

  it("does not derive selected-chain depth from blue-score delta", () => {
    expect(
      decideChainEvidence(
        acceptedEvidence({
          transactionId: CLAIM_TX,
          acceptingBlockHash: CLAIM_BLOCK,
          acceptingBlockBlueScore: "100",
          checkpoint: checkpoint("dd".repeat(32), "999"),
          confirmationCount: 30,
        }),
        30,
      ).status,
    ).toBe("confirmed");
  });

  it("accepts permanent absence only with objective proof", () => {
    const conflicting = acceptedEvidence({
      transactionId: REPLACEMENT_TX,
      acceptingBlockHash: REPLACEMENT_BLOCK,
      acceptingBlockBlueScore: "101",
      checkpoint: checkpoint("dd".repeat(32), "130"),
      confirmationCount: 30,
    });
    expect(
      decideChainEvidence(
        {
          status: "absent",
          transactionId: CLAIM_TX,
          reason: "the captured head was spent by a confirmed replacement",
          proof: {
            kind: "confirmed-conflicting-spend",
            spentOutpoint: { txid: GENESIS_TX, index: 0 },
            conflictingTransaction: conflicting,
          },
        },
        30,
      ).status,
    ).toBe("absent");
  });
});

describe("covenant selected-chain state", () => {
  it("appends verified lineage and derives the unique current head", () => {
    const initial = createCovenantLineageState(manifest());
    const afterClaim = applyCovenantSelectedChainUpdate(initial, {
      fromCheckpoint: initial.checkpoint,
      checkpoint: checkpoint("dd".repeat(32), "130"),
      continuity: "complete",
      removedChainBlockHashes: [],
      addedChainBlocks: [
        { blockHash: CLAIM_BLOCK, transitions: [claimTransition()] },
      ],
    });

    expect(initial.journal).toHaveLength(0);
    expect(afterClaim.journal).toHaveLength(1);
    expect(afterClaim.currentHead).toEqual({
      outpoint: { txid: CLAIM_TX, index: 1 },
      scriptPublicKey: "0000bb",
      value: "900",
      claimedCumulativeAmount: "100",
    });
    expect(canonicalCovenantTransitions(afterClaim)).toHaveLength(1);
    expect(() => assertCovenantLineageConfirmed(afterClaim, 30)).not.toThrow();
  });

  it("rolls removed blocks back before applying replacement blocks", () => {
    const afterClaim = withClaim();
    const replacement = topUpTransition({
      transactionId: REPLACEMENT_TX,
      acceptingBlockHash: REPLACEMENT_BLOCK,
      consumedOutpoint: { txid: GENESIS_TX, index: 0 },
      value: "1200",
    });
    const updated = applyCovenantSelectedChainUpdate(afterClaim, {
      fromCheckpoint: afterClaim.checkpoint,
      checkpoint: checkpoint("ee".repeat(32), "160"),
      continuity: "complete",
      removedChainBlockHashes: [CLAIM_BLOCK],
      addedChainBlocks: [
        { blockHash: REPLACEMENT_BLOCK, transitions: [replacement] },
      ],
    });

    expect(updated.journal.map((event) => event.event)).toEqual([
      "accepted",
      "removed",
      "accepted",
    ]);
    expect(updated.currentHead?.outpoint.txid).toBe(REPLACEMENT_TX);
    expect(canonicalCovenantTransitions(updated)).toEqual([replacement]);
  });

  it("invalidates a removed genesis until authoritative reacceptance", () => {
    const initial = createCovenantLineageState(manifest());
    const removed = applyCovenantSelectedChainUpdate(initial, {
      fromCheckpoint: initial.checkpoint,
      checkpoint: checkpoint("de".repeat(32), "130"),
      continuity: "complete",
      removedChainBlockHashes: [GENESIS_BLOCK],
      addedChainBlocks: [],
    });

    expect(removed.availability).toBe("unknown");
    expect(removed.currentHead).toBeNull();
    expect(() => assertCovenantLineageConfirmed(removed, 30)).toThrow(
      "removed from the selected chain",
    );

    const acceptance = acceptedEvidence({
      transactionId: GENESIS_TX,
      acceptingBlockHash: REPLACEMENT_BLOCK,
      acceptingBlockBlueScore: "131",
      checkpoint: checkpoint("ef".repeat(32), "160"),
      confirmationCount: 30,
    });
    const reaccepted = applyCovenantSelectedChainUpdate(removed, {
      fromCheckpoint: removed.checkpoint,
      checkpoint: acceptance.checkpoint,
      continuity: "complete",
      removedChainBlockHashes: [],
      addedChainBlocks: [
        {
          blockHash: REPLACEMENT_BLOCK,
          genesisAcceptance: acceptance,
          transitions: [],
        },
      ],
    });
    expect(reaccepted.availability).toBe("available");
    expect(reaccepted.currentHead?.outpoint).toEqual({
      txid: GENESIS_TX,
      index: 0,
    });
  });

  it("rejects missing, branching, wrong-covenant, and inconsistent successors", () => {
    const initial = createCovenantLineageState(manifest());
    const valid = claimTransition();
    const apply = (transitions: CovenantLineageTransition[]) =>
      applyCovenantSelectedChainUpdate(initial, {
        fromCheckpoint: initial.checkpoint,
        checkpoint: checkpoint("dd".repeat(32), "130"),
        continuity: "complete",
        removedChainBlockHashes: [],
        addedChainBlocks: [{ blockHash: CLAIM_BLOCK, transitions }],
      });

    expect(() =>
      apply([
        {
          ...valid,
          consumedOutpoint: { txid: "99".repeat(32), index: 0 },
        },
      ]),
    ).toThrow("missing a unique predecessor");
    expect(() => apply([valid, valid])).toThrow("branching covenant spends");
    expect(() =>
      apply([{ ...valid, covenantId: "77".repeat(32) }]),
    ).toThrow("wrong covenant or template");
    expect(() =>
      apply([
        {
          ...valid,
          successor: { ...valid.successor!, value: "950" },
        },
      ]),
    ).toThrow("inconsistent value or covenant state");
    expect(() =>
      apply([
        {
          ...valid,
          acceptance: {
            ...valid.acceptance,
            checkpoint: checkpoint("ee".repeat(32), "130"),
          },
        },
      ]),
    ).toThrow("checkpoint is inconsistent");
    expect(() =>
      apply([
        {
          ...valid,
          successor: {
            ...valid.successor!,
            authorizingInput: 0x1_0000_0000,
          },
        },
      ]),
    ).toThrow("successor binding is inconsistent");
  });

  it("rejects lineage outpoint indexes outside the consensus uint32 range", () => {
    const invalid = manifest();
    invalid.genesis.outpoint.index = 0x1_0000_0000;
    expect(() => createCovenantLineageState(invalid)).toThrow(
      "genesis outpoint index is invalid",
    );
  });

  it("requires complete launch ABI and selector identity", () => {
    const missingAbi = manifest();
    missingAbi.abi = {};
    expect(() => createCovenantLineageState(missingAbi)).toThrow(
      "template identity is incomplete",
    );
  });

  it("rejects a terminal refund output exceeding the consumed value", () => {
    const initial = createCovenantLineageState(manifest());
    const acceptance = acceptedEvidence({
      transactionId: CLAIM_TX,
      acceptingBlockHash: CLAIM_BLOCK,
      acceptingBlockBlueScore: "101",
      checkpoint: checkpoint("dd".repeat(32), "130"),
      confirmationCount: 30,
    });
    expect(() =>
      applyCovenantSelectedChainUpdate(initial, {
        fromCheckpoint: initial.checkpoint,
        checkpoint: acceptance.checkpoint,
        continuity: "complete",
        removedChainBlockHashes: [],
        addedChainBlocks: [
          {
            blockHash: acceptance.acceptingBlockHash,
            transitions: [
              {
                kind: "refund",
                covenantId: COVENANT_ID,
                templateId: "kaspa-x402-escrow-v4",
                consumedOutpoint: initial.currentHead!.outpoint,
                transactionId: CLAIM_TX,
                authorizedSuccessorCount: 0,
                successor: null,
                terminalOutput: {
                  index: 0,
                  scriptPublicKey: "0000bb",
                  value: "1001",
                },
                acceptance,
              },
            ],
          },
        ],
      }),
    ).toThrow("exceeds the consumed value");
  });

  it("fails closed without advancing the checkpoint when pruning breaks continuity", () => {
    const current = withClaim();
    const result = applyCovenantSelectedChainUpdate(current, {
      fromCheckpoint: current.checkpoint,
      checkpoint: checkpoint("ee".repeat(32), "160"),
      continuity: "pruned",
      removedChainBlockHashes: [],
      addedChainBlocks: [],
    });
    expect(result.availability).toBe("unknown");
    expect(result.checkpoint).toEqual(current.checkpoint);
    expect(() => assertCovenantLineageConfirmed(result, 30)).toThrow(
      "pruning horizon",
    );
  });

  it("resumes observers from the durable checkpoint and saves by checkpoint CAS", async () => {
    let durable = createCovenantLineageState(manifest());
    const requested: ChainCheckpoint[] = [];
    const observer = new CovenantChainObserver({
      requiredConfirmations: 30,
      store: {
        async loadCovenantLineage() {
          return structuredClone(durable);
        },
        async saveCovenantLineage(expected, state) {
          expect(expected).toEqual(durable.checkpoint);
          durable = structuredClone(state);
        },
      },
      source: {
        async selectedChainFrom({ checkpoint: from }) {
          requested.push(from);
          return {
            fromCheckpoint: from,
            checkpoint: checkpoint("dd".repeat(32), "130"),
            continuity: "complete",
            removedChainBlockHashes: [],
            addedChainBlocks: [
              { blockHash: CLAIM_BLOCK, transitions: [claimTransition()] },
            ],
          };
        },
      },
    });

    const synchronized = await observer.synchronize();
    expect(requested).toEqual([manifest().genesis.acceptance.checkpoint]);
    expect(durable).toEqual(synchronized);
    expect(durable.currentHead?.outpoint.txid).toBe(CLAIM_TX);
  });
});

function withClaim(): CovenantLineageState {
  const initial = createCovenantLineageState(manifest());
  return applyCovenantSelectedChainUpdate(initial, {
    fromCheckpoint: initial.checkpoint,
    checkpoint: checkpoint("dd".repeat(32), "130"),
    continuity: "complete",
    removedChainBlockHashes: [],
    addedChainBlocks: [
      { blockHash: CLAIM_BLOCK, transitions: [claimTransition()] },
    ],
  });
}

function manifest(): CovenantLaunchManifest {
  const acceptance = acceptedEvidence({
    transactionId: GENESIS_TX,
    acceptingBlockHash: GENESIS_BLOCK,
    acceptingBlockBlueScore: "71",
    checkpoint: checkpoint("a9".repeat(32), "100"),
    confirmationCount: 30,
  });
  const identity = {
    compiler: {
      name: "silverc",
      checkedCommit: "55".repeat(20),
      command: "silverc contract.sil",
    },
    source: {
      path: "contracts/kaspa-x402-escrow-v4.sil",
      sha256: "66".repeat(32),
    },
    bytecode: {
      templateId: "kaspa-x402-escrow-v4",
      compiledBaseSha256: "77".repeat(32),
    },
    constructorSlots: { claimedCumulativeAmount: { offsets: [2], bytes: 8 } },
    abi: { claim: ["serverSig", "voucher"] },
    selectors: { claim: "23959b42", topUp: "ae09679c", refund: "17a2027b" },
  };
  return {
    format: "kaspa-x402-covenant-launch-v1",
    network: "kaspa:testnet-10",
    ...identity,
    identitySha256: sha256Hex(stableStringify(identity)),
    genesis: {
      derivation: "kip20-covenant-id-v1",
      covenantId: COVENANT_ID,
      authorizingInput: { txid: "88".repeat(32), index: 0 },
      transactionId: GENESIS_TX,
      outpoint: { txid: GENESIS_TX, index: 0 },
      scriptPublicKey: "0000aa",
      value: "1000",
      claimedCumulativeAmount: "0",
      acceptance,
    },
  };
}

function claimTransition(): CovenantLineageTransition {
  return {
    kind: "claim",
    covenantId: COVENANT_ID,
    templateId: "kaspa-x402-escrow-v4",
    consumedOutpoint: { txid: GENESIS_TX, index: 0 },
    transactionId: CLAIM_TX,
    authorizedSuccessorCount: 1,
    successor: {
      outpoint: { txid: CLAIM_TX, index: 1 },
      covenantId: COVENANT_ID,
      authorizingInput: 0,
      scriptPublicKey: "0000bb",
      value: "900",
      claimedCumulativeAmount: "100",
    },
    terminalOutput: null,
    acceptance: acceptedEvidence({
      transactionId: CLAIM_TX,
      acceptingBlockHash: CLAIM_BLOCK,
      acceptingBlockBlueScore: "101",
      checkpoint: checkpoint("dd".repeat(32), "130"),
      confirmationCount: 30,
    }),
  };
}

function topUpTransition(input: {
  transactionId: string;
  acceptingBlockHash: string;
  consumedOutpoint: { txid: string; index: number };
  value: string;
}): CovenantLineageTransition {
  return {
    kind: "top-up",
    covenantId: COVENANT_ID,
    templateId: "kaspa-x402-escrow-v4",
    consumedOutpoint: input.consumedOutpoint,
    transactionId: input.transactionId,
    authorizedSuccessorCount: 1,
    successor: {
      outpoint: { txid: input.transactionId, index: 0 },
      covenantId: COVENANT_ID,
      authorizingInput: 0,
      scriptPublicKey: "0000aa",
      value: input.value,
      claimedCumulativeAmount: "0",
    },
    terminalOutput: null,
    acceptance: acceptedEvidence({
      transactionId: input.transactionId,
      acceptingBlockHash: input.acceptingBlockHash,
      acceptingBlockBlueScore: "131",
      checkpoint: checkpoint("ee".repeat(32), "160"),
      confirmationCount: 30,
    }),
  };
}

function checkpoint(blockHash: string, score: string): ChainCheckpoint {
  return { blockHash, blueScore: score, daaScore: score };
}

function acceptedEvidence(
  input: Omit<AcceptedTransactionEvidence, "status">,
): AcceptedTransactionEvidence {
  return { status: "accepted", ...input };
}
