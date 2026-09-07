import { describe, expect, it } from "vitest";
import type { SettlementResponse } from "@kaspa-x402/core";
import { MemoryServerChannelStore, type BatchCommitmentRecord, type BatchSettlementAttemptRecord,
  type ClaimAttemptRecord, type ServerChannelRecord, type SettlementCommit, type ServerResponse } from "../src/index.js";
const CHANNEL_ID = "11".repeat(32), COVENANT_ID = "1a".repeat(32), REQUEST = "22".repeat(32),
  REQUIREMENTS = "33".repeat(32), PAYLOAD = "44".repeat(32), TX = "55".repeat(32),
  ATTEMPT = "77".repeat(32), SCRIPT = "0000" + "99".repeat(34);
const NOW = "2026-09-07T00:00:00.000Z";
// Fixture terms mirror the existing state-store contract. No node/network evidence.
function batchSettlementAttempt(
  current: ServerChannelRecord,
  overrides: Partial<BatchSettlementAttemptRecord> = {},
): BatchSettlementAttemptRecord {
  return {
    attemptId: ATTEMPT,
    channelId: current.channelId,
    covenantId: current.covenantId,
    requestFingerprint: REQUEST,
    paymentRequirementsHash: REQUIREMENTS,
    paymentEvidenceHash: PAYLOAD,
    requestAuthorizationId: "17".repeat(32),
    maximumCharge: "100",
    adoptedChannel: current,
    prior: expectedChannelState(current),
    expected: {
      channelId: current.channelId,
      covenantId: current.covenantId,
      fundingAmount: current.fundingAmount,
      chargedCumulativeAmount: current.chargedCumulativeAmount,
      claimedCumulativeAmount: current.claimedCumulativeAmount,
      signedMaxClaimable: current.signedMaxClaimable,
      ...(current.voucherSignature
        ? { voucherSignature: current.voucherSignature }
        : {}),
      activeOutpoint: current.activeOutpoint,
      activeScriptPublicKey: current.activeScriptPublicKey,
      status: current.status,
    },
    status: "pending",
    createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z",
    ...overrides,
  };
}

function expectedChannelState(current: ServerChannelRecord) {
  return {
    channelId: current.channelId,
    covenantId: current.covenantId,
    fundingAmount: current.fundingAmount,
    chargedCumulativeAmount: current.chargedCumulativeAmount,
    claimedCumulativeAmount: current.claimedCumulativeAmount,
    signedMaxClaimable: current.signedMaxClaimable,
    ...(current.voucherSignature
      ? { voucherSignature: current.voucherSignature }
      : {}),
    activeOutpoint: current.activeOutpoint,
    activeScriptPublicKey: current.activeScriptPublicKey,
    status: current.status,
  };
}

function channel(
  overrides: Partial<ServerChannelRecord> = {},
): ServerChannelRecord {
  return {
    channelId: CHANNEL_ID,
    covenantId: COVENANT_ID,
    genesisEvidence: {
      covenantId: COVENANT_ID,
      authorizingInput: { txid: "1b".repeat(32), index: 0 },
      genesisOutpoint: { txid: TX, index: 0 },
      genesisScriptPublicKey: SCRIPT,
      genesisAmount: "1000",
      totalOutputCount: 1,
      authorizedOutputCount: 1,
    },
    channelConfig: {
      network: "kaspa:testnet-10",
      asset: "KAS",
      templateId: "kaspa-x402-escrow-v3",
      clientPublicKey: "12".repeat(32),
      serverPublicKey: "13".repeat(32),
      payTo: "kaspatest:payout",
      refundAddress: "kaspatest:refund",
      refundTimeoutDaa: "2000",
      salt: "14".repeat(32),
    },
    escrowAddress: "kaspatest:escrow",
    activeOutpoint: { txid: TX, index: 0 },
    activeScriptPublicKey: SCRIPT,
    fundingAmount: "1000",
    chargedCumulativeAmount: "0",
    claimedCumulativeAmount: "0",
    signedMaxClaimable: "0",
    status: "active",
    ...overrides,
  };
}

function settlementCommit(
  previous: ServerChannelRecord,
  next: Partial<ServerChannelRecord>,
): SettlementCommit {
  const updated = { ...previous, ...next };
  const commitment: BatchCommitmentRecord = {
    commitmentId: "15".repeat(32),
    channelId: previous.channelId,
    covenantId: previous.covenantId,
    requestFingerprint: REQUEST,
    paymentRequirementsHash: REQUIREMENTS,
    paymentEvidenceHash: PAYLOAD,
    requestAuthorizationId: "17".repeat(32),
    activeOutpoint: previous.activeOutpoint,
    activeScriptPublicKey: previous.activeScriptPublicKey,
    voucher: {
      covenantId: previous.covenantId,
      amount: "100",
      signature: "16".repeat(64),
    },
    chargedAmount: "100",
    chargedCumulativeBefore: previous.chargedCumulativeAmount,
    chargedCumulativeAfter: updated.chargedCumulativeAmount,
    claimedCumulativeAmount: previous.claimedCumulativeAmount,
    settlement: settlement(),
    response: response(),
  };
  return {
    batchAttemptId: ATTEMPT,
    channel: updated,
    commitment,
    expected: {
      channelId: previous.channelId,
      covenantId: previous.covenantId,
      fundingAmount: previous.fundingAmount,
      chargedCumulativeAmount: previous.chargedCumulativeAmount,
      claimedCumulativeAmount: previous.claimedCumulativeAmount,
      signedMaxClaimable: previous.signedMaxClaimable,
      ...(previous.voucherSignature
        ? { voucherSignature: previous.voucherSignature }
        : {}),
      activeOutpoint: previous.activeOutpoint,
      activeScriptPublicKey: previous.activeScriptPublicKey,
      status: previous.status,
    },
  };
}

function claimAttempt(input: { attemptId: string }): ClaimAttemptRecord {
  const current = channel();
  return {
    attemptId: input.attemptId,
    attemptEpoch: "11111111-1111-4111-8111-111111111111",
    channelId: current.channelId,
    covenantId: current.covenantId,
    activeOutpoint: current.activeOutpoint,
    activeScriptPublicKey: current.activeScriptPublicKey,
    fundingAmount: current.fundingAmount,
    claimAmount: "100",
    chargedCumulativeAmount: current.chargedCumulativeAmount,
    claimedCumulativeAmount: current.claimedCumulativeAmount,
    signedMaxClaimable: current.signedMaxClaimable,
    channelStatus: current.status,
    transaction: "ab".repeat(32),
    transactionId: TX,
    requiredFinality: "accepted",
    status: "pending",
  };
}

function settlement(): SettlementResponse {
  return {
    success: true,
    transaction: TX,
    network: "kaspa:testnet-10",
    amount: "100",
  };
}

function response(): ServerResponse {
  return {
    status: 200,
    headers: {},
    body: "ok",
  };
}

describe("batch fault/reordering matrix (local atomic-write model)", () => {
  for (const charge of ["0", "100"]) for (let boundary = 0; boundary < 4; boundary++) for (const timing of ["before", "after"]) {
    it(`charge ${charge}: lost ${timing} write ${boundary} acknowledgement never repeats handler`, async () => {
      const current = channel();
      const a = batchSettlementAttempt(current, { paymentIdentifier: "batch_fault_identifier" });
      const c = settlementCommit(current, { chargedCumulativeAmount: charge, signedMaxClaimable: "100", voucherSignature: "16".repeat(64) });
      c.commitment.chargedAmount = charge;
      c.paymentIdentifier = { id: a.paymentIdentifier!, fingerprint: REQUEST, paymentPayloadHash: PAYLOAD,
        paymentScopeId: CHANNEL_ID, response: response(), settlement: settlement() };
      const operations = [
        (s: MemoryServerChannelStore) => s.claimBatchSettlement(a),
        (s: MemoryServerChannelStore) => s.beginBatchHandler(ATTEMPT, NOW),
        (s: MemoryServerChannelStore) => s.recordBatchHandlerResult(ATTEMPT, { body: "result", chargedAmount: charge }, NOW),
        (s: MemoryServerChannelStore) => s.commitSettlement(c),
      ];
      let store = new MemoryServerChannelStore([current]);
      const journal: number[] = [];
      let executions = 0;
      for (let step = 0; step < operations.length; step++) {
        if (step === boundary && timing === "before") break;
        await operations[step]!(store);
        journal.push(step);
        if (step === boundary && timing === "after") break;
        if (step === 1) executions++;
      }
      store = new MemoryServerChannelStore([current]);
      for (const step of journal) await operations[step]!(store);
      if (!(await store.loadBatchSettlementAttempt(ATTEMPT))) await operations[0]!(store);
      const saved = (await store.loadBatchSettlementAttempt(ATTEMPT))!;
      if (saved.status !== "applied") {
        // A pending zero-charge result still excludes other lane and claim work.
        await expect(store.claimBatchSettlement({ ...a, attemptId: "88".repeat(32), paymentIdentifier: "other_batch_identifier" })).rejects.toThrow(/pending/);
        await expect(store.saveClaimAttempt(claimAttempt({ attemptId: "99".repeat(32) }))).rejects.toThrow(/pending/);
        if (await store.beginBatchHandler(ATTEMPT, NOW)) executions++;
        else if (!saved.handlerResult) {
          await store.markBatchHandlerRecoveryRequired(ATTEMPT, "operator must resolve uncertain outcome", NOW);
          expect(await store.beginBatchHandler(ATTEMPT, NOW)).toBe(false);
        }
        // Explicit operator-confirmed outcome; this is not automatic replay.
        if (!saved.handlerResult) await operations[2]!(store);
        await operations[3]!(store);
      }
      expect(executions).toBeLessThanOrEqual(1);
      expect(await store.loadChannel(CHANNEL_ID)).toMatchObject({ chargedCumulativeAmount: charge });
      expect(await store.loadBatchSettlementAttempt(ATTEMPT)).toMatchObject({ status: "applied" });
      expect(await store.beginBatchHandler(ATTEMPT, NOW)).toBe(false);
      const next = (await store.loadChannel(CHANNEL_ID))!;
      await expect(store.claimBatchSettlement(batchSettlementAttempt(next, { attemptId: "aa".repeat(32) }))).resolves.toMatchObject({ created: true });
    });
  }

  for (const order of [["claim", "topup", "voucher"], ["claim", "voucher", "topup"],
    ["topup", "claim", "voucher"], ["topup", "voucher", "claim"],
    ["voucher", "claim", "topup"], ["voucher", "topup", "claim"]]) {
    it(`${order.join(" → ")}: only one concurrent lane admission succeeds`, async () => {
      const current = channel();
      const store = new MemoryServerChannelStore([current]);
      const topped = { ...current, activeOutpoint: { txid: "ee".repeat(32), index: 0 }, fundingAmount: "2000" };
      const ops = {
        claim: () => store.saveClaimAttempt(claimAttempt({ attemptId: "aa".repeat(32) })),
        topup: () => store.claimBatchSettlement(batchSettlementAttempt(topped, { attemptId: "bb".repeat(32), prior: expectedChannelState(current) })),
        voucher: () => store.claimBatchSettlement(batchSettlementAttempt(current)),
      };
      const results = await Promise.allSettled(order.map(key => ops[key as keyof typeof ops]()));
      expect(results.map(r => r.status)).toEqual(["fulfilled", "rejected", "rejected"]);
      expect((await store.loadChannel(CHANNEL_ID))?.fundingAmount).toBe(order[0] === "topup" ? "2000" : "1000");
    });
  }

  it("retirement after staged work prevents a stale settlement from reviving the channel", async () => {
    const current = channel();
    const store = new MemoryServerChannelStore([current]);
    await store.claimBatchSettlement(batchSettlementAttempt(current));
    await store.beginBatchHandler(ATTEMPT, NOW);
    await store.recordBatchHandlerResult(ATTEMPT, { chargedAmount: "100" }, NOW);
    await store.retireChannel(CHANNEL_ID);
    await expect(store.commitSettlement(settlementCommit(current, { chargedCumulativeAmount: "100", signedMaxClaimable: "100" }))).rejects.toThrow(/changed/);
    expect(await store.loadChannel(CHANNEL_ID)).toMatchObject({ status: "retired", chargedCumulativeAmount: "0" });
    expect(await store.loadCommitment("15".repeat(32))).toBeUndefined();
    expect(await store.loadBatchSettlementAttempt(ATTEMPT)).toMatchObject({ status: "pending" });
  });
});
