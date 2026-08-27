import { describe, expect, it } from "vitest";

import {
  buildBatchClaimTxV1Artifact,
  buildBatchGenesisTxV1Artifact,
  buildBatchRefundTxV1Artifact,
  buildBatchTopUpTxV1Artifact,
  computeBudgetForScriptUnits,
  escrowScriptPubKeyHash,
  payToScriptHashScript,
  serializedScriptPublicKey,
  TX_V1_P2PK_COMPUTE_BUDGET,
  transactionV1CovenantId,
  transactionV1SchnorrSignatureEvidence,
} from "../src/index.js";

const COVENANT_ID = "11".repeat(32);
const P2PK_A = `000020${"21".repeat(32)}ac`;
const P2PK_B = `000020${"22".repeat(32)}ac`;
const ACTIVE_REDEEM = "51";
const SUCCESSOR_REDEEM = "52";
const ACTIVE_SPK = serializedScriptPublicKey(payToScriptHashScript(ACTIVE_REDEEM));
const SUCCESSOR_SPK = serializedScriptPublicKey(payToScriptHashScript(SUCCESSOR_REDEEM));
const RAW_SIGNATURE = "00".repeat(64);
const TX_SIGNATURE = `${"00".repeat(64)}01`;
const SCRIPT_UNITS = 10_000;
const COMPUTE_BUDGET = computeBudgetForScriptUnits(SCRIPT_UNITS);
const I64_MAX = "9223372036854775807";
const I64_MAX_PLUS_ONE = "9223372036854775808";

function spkHash(serialized: string): string {
  return escrowScriptPubKeyHash({ version: 0, script: serialized.slice(4) });
}

function fundingInput(byte: string, index: number, amount: string, scriptPublicKey = P2PK_A) {
  return {
    previousOutpoint: { txid: byte.repeat(32), index },
    amount,
    scriptPublicKey,
    signature: RAW_SIGNATURE,
    computeBudget: TX_V1_P2PK_COMPUTE_BUDGET,
  };
}

function claimInput() {
  return {
    network: "kaspa:testnet-10" as const,
    activeOutpoint: { txid: "33".repeat(32), index: 0 },
    activeAmount: "1000000",
    activeScriptPublicKey: ACTIVE_SPK,
    activeRedeemScript: ACTIVE_REDEEM,
    covenantId: COVENANT_ID,
    settledTotal: "100000",
    totalAuthorized: "400000",
    claimAmount: "250000",
    successorScriptPublicKey: SUCCESSOR_SPK,
    successorRedeemScript: SUCCESSOR_REDEEM,
    serverOutputScriptPublicKey: P2PK_B,
    expectedPayoutScriptPublicKeyHash: spkHash(P2PK_B),
    fee: "1000",
    serverSignature: TX_SIGNATURE,
    voucherSignature: RAW_SIGNATURE,
    computeBudget: COMPUTE_BUDGET,
    scriptUnitsEstimate: SCRIPT_UNITS,
  };
}

describe("Alpha.11 KIP-20 transaction-v1 builders", () => {
  it("builds one deterministic multi-input singleton genesis head", () => {
    const artifact = buildBatchGenesisTxV1Artifact({
      fundingInputs: [fundingInput("01", 0, "60000000"), fundingInput("02", 1, "30001000", P2PK_B)],
      escrowAmount: "90000000",
      escrowScriptPublicKey: ACTIVE_SPK,
      escrowRedeemScript: ACTIVE_REDEEM,
      initialSettledTotal: "0",
      fee: "1000",
    });

    expect(artifact.format).toBe("kaspa-x402-tx-v1-reference-v2");
    expect(artifact.transaction.version).toBe(1);
    expect(artifact.transaction.inputs).toHaveLength(2);
    expect(artifact.transaction.inputs.every((input) => input.utxo.covenantId === null)).toBe(true);
    expect(artifact.transaction.outputs).toEqual([
      {
        amount: "90000000",
        scriptPublicKey: ACTIVE_SPK,
        covenant: { authorizingInput: 0, covenantId: artifact.covenantId },
      },
    ]);
    expect(artifact.covenantId).toBe(
      transactionV1CovenantId(artifact.transaction.inputs[0]!.previousOutpoint, [
        { index: 0, output: artifact.transaction.outputs[0]! },
      ]),
    );
    // Fixed regression values cover the covenant ID, transaction ID, transaction
    // hash, both sighashes, storage mass, and serialized size.
    expect(artifact.covenantId).toBe("a9b0fd5fdb82b002bd4eea9506ae4f825b5664c67c9ebb10101097cc00f7bd71");
    expect(artifact.transactionId).toBe("3a1ddc72bab04f374d4b98951118e5c513cf15af6ea7621e05b4b449de51ee5d");
    expect(artifact.transactionHash).toBe("f3cf80780a935ac57e2ff9a7223992157f3d52b882402c4235fe9d94d89d0525");
    expect(artifact.transaction.mass).toBe("0");
    expect(artifact.transaction.estimatedSerializedSize).toBe(421);
    expect(artifact.sighashes).toHaveLength(2);
    expect(artifact.sighashes.map(({ digest }) => digest)).toEqual([
      "eeeb32defe27e369beacb14ffcdd2bec19935591b8d5d1aed5e599d623503326",
      "39c9a8f27151811b641130bf470ba432a7085f4bb9a4be9be0dca6deb287dace",
    ]);
    expect(transactionV1SchnorrSignatureEvidence(artifact.transaction, 0).hashType).toBe(1);
  });

  it("rejects non-canonical P2PK budgets, non-exact funding, and every genesis change output", () => {
    const base = {
      fundingInputs: [fundingInput("01", 0, "901000")],
      escrowAmount: "900000",
      escrowScriptPublicKey: ACTIVE_SPK,
      escrowRedeemScript: ACTIVE_REDEEM,
      initialSettledTotal: "0",
      fee: "1000",
    };
    expect(() =>
      buildBatchGenesisTxV1Artifact({
        ...base,
        fundingInputs: [{ ...base.fundingInputs[0]!, computeBudget: 0 }],
      }),
    ).toThrow(`fundingInputs[0].computeBudget must be ${TX_V1_P2PK_COMPUTE_BUDGET}`);
    expect(() =>
      buildBatchGenesisTxV1Artifact({
        ...base,
        fundingInputs: [fundingInput("01", 0, "901001")],
      }),
    ).toThrow("batch genesis funding inputs must equal escrow plus fee");
    for (const covenant of [null, { authorizingInput: 0, covenantId: COVENANT_ID }]) {
      expect(() =>
        buildBatchGenesisTxV1Artifact({
          ...base,
          changeOutputs: [{ amount: "1", scriptPublicKey: P2PK_A, covenant }],
        }),
      ).toThrow("batch genesis must have exactly one output; change outputs are not allowed");
    }
  });

  it("rotates claim state while retaining the stable ID and charging fees to payout", () => {
    const artifact = buildBatchClaimTxV1Artifact(claimInput());

    expect(artifact.transaction.inputs[0]!.utxo.covenantId).toBe(COVENANT_ID);
    expect(artifact.transaction.outputs).toEqual([
      { amount: "249000", scriptPublicKey: P2PK_B, covenant: null },
      {
        amount: "750000",
        scriptPublicKey: SUCCESSOR_SPK,
        covenant: { authorizingInput: 0, covenantId: COVENANT_ID },
      },
    ]);
    expect(artifact.continuation.settledTotal).toBe("350000");
    expect(artifact.fee).toMatchObject({ source: "server-output", amount: "1000", totalAuthorized: "400000" });
    expect(artifact.voucherDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects zero, stale, over-ceiling, terminal, and signed-int overflow claims", () => {
    expect(() => buildBatchClaimTxV1Artifact({ ...claimInput(), claimAmount: "0" })).toThrow("claim amount must be positive");
    expect(() => buildBatchClaimTxV1Artifact({ ...claimInput(), totalAuthorized: "100000" })).toThrow(
      "signed cumulative ceiling must exceed settled total",
    );
    expect(() => buildBatchClaimTxV1Artifact({ ...claimInput(), claimAmount: "300001" })).toThrow(
      "claim amount exceeds the remaining signed cumulative ceiling",
    );
    expect(() => buildBatchClaimTxV1Artifact({ ...claimInput(), claimAmount: "1000000", totalAuthorized: "1100000" })).toThrow(
      "claim continuation output must be positive",
    );
    expect(() => buildBatchClaimTxV1Artifact({ ...claimInput(), totalAuthorized: I64_MAX_PLUS_ONE })).toThrow(
      "totalAuthorized must fit signed int64",
    );
  });

  it("accepts INT64_MAX and rejects INT64_MAX + 1 for every lane-value path", () => {
    const genesis = buildBatchGenesisTxV1Artifact({
      fundingInputs: [fundingInput("01", 0, I64_MAX)],
      escrowAmount: I64_MAX,
      escrowScriptPublicKey: ACTIVE_SPK,
      escrowRedeemScript: ACTIVE_REDEEM,
      initialSettledTotal: "0",
      fee: "0",
    });
    expect(genesis.escrow.amount).toBe(I64_MAX);
    expect(() =>
      buildBatchGenesisTxV1Artifact({
        fundingInputs: [fundingInput("01", 0, I64_MAX)],
        escrowAmount: I64_MAX_PLUS_ONE,
        escrowScriptPublicKey: ACTIVE_SPK,
        escrowRedeemScript: ACTIVE_REDEEM,
        initialSettledTotal: "0",
        fee: "0",
      }),
    ).toThrow("escrowAmount must fit signed int64");

    const claim = buildBatchClaimTxV1Artifact({ ...claimInput(), activeAmount: I64_MAX });
    expect(claim.transaction.inputs[0]!.utxo.amount).toBe(I64_MAX);
    expect(() => buildBatchClaimTxV1Artifact({ ...claimInput(), activeAmount: I64_MAX_PLUS_ONE })).toThrow(
      "activeAmount must fit signed int64",
    );

    const topUpBase = {
      activeOutpoint: { txid: "44".repeat(32), index: 1 },
      activeAmount: "9223372036854774807",
      activeScriptPublicKey: ACTIVE_SPK,
      activeRedeemScript: ACTIVE_REDEEM,
      covenantId: COVENANT_ID,
      settledTotal: "350000",
      successorAmount: I64_MAX,
      successorScriptPublicKey: ACTIVE_SPK,
      successorRedeemScript: ACTIVE_REDEEM,
      clientSignature: TX_SIGNATURE,
      fundingInputs: [fundingInput("05", 0, "1000")],
      expectedRefundScriptPublicKeyHash: spkHash(P2PK_A),
      fee: "0",
      computeBudget: COMPUTE_BUDGET,
      scriptUnitsEstimate: SCRIPT_UNITS,
    };
    expect(buildBatchTopUpTxV1Artifact(topUpBase).continuation.amount).toBe(I64_MAX);
    expect(() =>
      buildBatchTopUpTxV1Artifact({
        ...topUpBase,
        successorAmount: I64_MAX_PLUS_ONE,
      }),
    ).toThrow("successorAmount must fit signed int64");
    expect(() =>
      buildBatchTopUpTxV1Artifact({
        ...topUpBase,
        activeAmount: I64_MAX_PLUS_ONE,
      }),
    ).toThrow("activeAmount must fit signed int64");

    const refundBase = {
      activeOutpoint: { txid: "66".repeat(32), index: 1 },
      activeAmount: I64_MAX,
      activeScriptPublicKey: SUCCESSOR_SPK,
      activeRedeemScript: SUCCESSOR_REDEEM,
      covenantId: COVENANT_ID,
      refundOutputScriptPublicKey: P2PK_A,
      expectedRefundScriptPublicKeyHash: spkHash(P2PK_A),
      fee: "900",
      clientSignature: TX_SIGNATURE,
      timeoutDaa: "123456",
      lockTimeDaa: "123456",
      inputSequence: "0",
      computeBudget: COMPUTE_BUDGET,
      scriptUnitsEstimate: SCRIPT_UNITS,
    };
    expect(buildBatchRefundTxV1Artifact(refundBase).transaction.inputs[0]!.utxo.amount).toBe(I64_MAX);
    expect(() =>
      buildBatchRefundTxV1Artifact({
        ...refundBase,
        activeAmount: I64_MAX_PLUS_ONE,
      }),
    ).toThrow("activeAmount must fit signed int64");
  });

  it("rejects a claim successor that is missing or carries the wrong stable binding", () => {
    const base = claimInput();
    expect(() =>
      buildBatchClaimTxV1Artifact({
        ...base,
        outputs: [{ amount: "249000", scriptPublicKey: P2PK_B, covenant: null }],
      }),
    ).toThrow("claim transaction must have exactly 2 outputs");
    expect(() =>
      buildBatchClaimTxV1Artifact({
        ...base,
        outputs: [
          { amount: "249000", scriptPublicKey: P2PK_B, covenant: null },
          {
            amount: "750000",
            scriptPublicKey: SUCCESSOR_SPK,
            covenant: { authorizingInput: 0, covenantId: "12".repeat(32) },
          },
        ],
      }),
    ).toThrow("claim output 1 does not match the canonical topology");
  });

  it("rejects the reserved zero covenant ID on every spend path", () => {
    expect(() => buildBatchClaimTxV1Artifact({ ...claimInput(), covenantId: "00".repeat(32) })).toThrow(
      "covenantId must not be zero",
    );

    const topUp = {
      activeOutpoint: { txid: "44".repeat(32), index: 1 },
      activeAmount: "1000000",
      activeScriptPublicKey: ACTIVE_SPK,
      activeRedeemScript: ACTIVE_REDEEM,
      covenantId: "00".repeat(32),
      settledTotal: "350000",
      successorAmount: "1300000",
      successorScriptPublicKey: ACTIVE_SPK,
      successorRedeemScript: ACTIVE_REDEEM,
      clientSignature: TX_SIGNATURE,
      fundingInputs: [fundingInput("05", 0, "301000")],
      expectedRefundScriptPublicKeyHash: spkHash(P2PK_A),
      fee: "1000",
      computeBudget: COMPUTE_BUDGET,
      scriptUnitsEstimate: SCRIPT_UNITS,
    };
    expect(() => buildBatchTopUpTxV1Artifact(topUp)).toThrow("covenantId must not be zero");

    expect(() =>
      buildBatchRefundTxV1Artifact({
        activeOutpoint: { txid: "66".repeat(32), index: 1 },
        activeAmount: "750000",
        activeScriptPublicKey: SUCCESSOR_SPK,
        activeRedeemScript: SUCCESSOR_REDEEM,
        covenantId: "00".repeat(32),
        refundOutputScriptPublicKey: P2PK_A,
        expectedRefundScriptPublicKeyHash: spkHash(P2PK_A),
        fee: "900",
        clientSignature: TX_SIGNATURE,
        timeoutDaa: "123456",
        lockTimeDaa: "123456",
        inputSequence: "0",
        computeBudget: COMPUTE_BUDGET,
        scriptUnitsEstimate: SCRIPT_UNITS,
      }),
    ).toThrow("covenantId must not be zero");
  });

  it("builds a client-authorized top-up with the same state and one unbound refund change output", () => {
    const artifact = buildBatchTopUpTxV1Artifact({
      activeOutpoint: { txid: "44".repeat(32), index: 1 },
      activeAmount: "1000000",
      activeScriptPublicKey: ACTIVE_SPK,
      activeRedeemScript: ACTIVE_REDEEM,
      covenantId: COVENANT_ID,
      settledTotal: "350000",
      successorAmount: "1300000",
      successorScriptPublicKey: ACTIVE_SPK,
      successorRedeemScript: ACTIVE_REDEEM,
      clientSignature: TX_SIGNATURE,
      fundingInputs: [fundingInput("05", 0, "400000")],
      changeOutputs: [{ amount: "99000", scriptPublicKey: P2PK_A, covenant: null }],
      expectedRefundScriptPublicKeyHash: spkHash(P2PK_A),
      fee: "1000",
      computeBudget: COMPUTE_BUDGET,
      scriptUnitsEstimate: SCRIPT_UNITS,
    });

    expect(artifact.transaction.inputs).toHaveLength(2);
    expect(artifact.transaction.inputs[0]!.utxo.covenantId).toBe(COVENANT_ID);
    expect(artifact.transaction.inputs[1]!.utxo.covenantId).toBeNull();
    expect(artifact.transaction.outputs[0]!.covenant).toEqual({ authorizingInput: 0, covenantId: COVENANT_ID });
    expect(artifact.transaction.outputs[1]!.covenant).toBeNull();
    expect(artifact.continuation).toMatchObject({ amount: "1300000", settledTotal: "350000" });
    expect(artifact.sighashes).toHaveLength(2);
  });

  it("rejects state-changing, underfunded, or covenant-bound top-ups", () => {
    const base = {
      activeOutpoint: { txid: "44".repeat(32), index: 1 },
      activeAmount: "1000000",
      activeScriptPublicKey: ACTIVE_SPK,
      activeRedeemScript: ACTIVE_REDEEM,
      covenantId: COVENANT_ID,
      settledTotal: "350000",
      successorAmount: "1300000",
      successorScriptPublicKey: ACTIVE_SPK,
      successorRedeemScript: ACTIVE_REDEEM,
      clientSignature: TX_SIGNATURE,
      fundingInputs: [fundingInput("05", 0, "301000")],
      expectedRefundScriptPublicKeyHash: spkHash(P2PK_A),
      fee: "1000",
      computeBudget: COMPUTE_BUDGET,
      scriptUnitsEstimate: SCRIPT_UNITS,
    };
    expect(() => buildBatchTopUpTxV1Artifact({ ...base, successorScriptPublicKey: SUCCESSOR_SPK, successorRedeemScript: SUCCESSOR_REDEEM })).toThrow(
      "top-up must preserve the current covenant state and script",
    );
    expect(() => buildBatchTopUpTxV1Artifact({ ...base, fundingInputs: [fundingInput("05", 0, "300000")] })).toThrow(
      "top-up inputs must equal outputs plus fee",
    );
    expect(() =>
      buildBatchTopUpTxV1Artifact({
        ...base,
        changeOutputs: [{ amount: "1", scriptPublicKey: P2PK_A, covenant: { authorizingInput: 0, covenantId: COVENANT_ID } }],
      }),
    ).toThrow("top-up change outputs must be unbound");
  });

  it("terminates the lineage with one unbound refund output", () => {
    const artifact = buildBatchRefundTxV1Artifact({
      activeOutpoint: { txid: "66".repeat(32), index: 1 },
      activeAmount: "750000",
      activeScriptPublicKey: SUCCESSOR_SPK,
      activeRedeemScript: SUCCESSOR_REDEEM,
      covenantId: COVENANT_ID,
      refundOutputScriptPublicKey: P2PK_A,
      expectedRefundScriptPublicKeyHash: spkHash(P2PK_A),
      fee: "900",
      clientSignature: TX_SIGNATURE,
      timeoutDaa: "123456",
      lockTimeDaa: "123456",
      inputSequence: "0",
      computeBudget: COMPUTE_BUDGET,
      scriptUnitsEstimate: SCRIPT_UNITS,
    });

    expect(artifact.transaction.inputs[0]!.utxo.covenantId).toBe(COVENANT_ID);
    expect(artifact.transaction.outputs).toEqual([{ amount: "749100", scriptPublicKey: P2PK_A, covenant: null }]);
    expect(artifact.covenantId).toBe(COVENANT_ID);
  });
});
