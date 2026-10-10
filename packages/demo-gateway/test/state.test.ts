import { FakeStorage } from "./fake-storage.js";
import { describe, expect, it } from "vitest";
import type {
  BatchCommitmentRecord,
  BatchSettlementAttemptRecord,
  ChannelOperationLeaseRecord,
  ClaimAttemptRecord,
  ExactHeadRecord,
  ExactPaymentRecord,
  ExactSettlementAttemptRecord,
  PaymentIdentifierRecord,
  PaymentIdentifierReservationClaim,
  ServerChannelRecord,
  SettlementCommit,
} from "@kaspa-x402/server";
import {
  buildKip10AdditiveRedeemScript,
  ESCROW_V5_LAUNCH_IDENTITY,
  payToScriptHashScript,
  serializedScriptPublicKey,
} from "@kaspa-x402/covenant";
import {
  applyCovenantSelectedChainUpdate,
  createCovenantLineageState,
  sha256Hex,
  type AcceptedTransactionEvidence,
  type CovenantLineageState,
} from "@kaspa-x402/core";
import { DurableGatewayLockManager, GatewayLedger } from "../src/state.js";

const CHANNEL_ID = "11".repeat(32);
const COVENANT_ID = "10".repeat(32);
const REQUEST = "22".repeat(32);
const REQUIREMENTS = "33".repeat(32);
const PAYLOAD = "44".repeat(32);
const TX = "55".repeat(32);
const OTHER_TX = "66".repeat(32);
const ATTEMPT = "77".repeat(32);
const FUNDING_TX = "88".repeat(32);
const SCRIPT = "0000" + "99".repeat(34);
const KIP10_REDEEM_SCRIPT = buildKip10AdditiveRedeemScript({
  ownerPublicKey: "aa".repeat(32),
  amount: "10000000",
});
const KIP10_SCRIPT_PUBLIC_KEY = serializedScriptPublicKey(
  payToScriptHashScript(KIP10_REDEEM_SCRIPT),
);
const HEAD_ID = "90".repeat(32);

describe("gateway durable ledger", () => {
  it("persists the 64-to-65 covenant compaction across Durable Object restart", async () => {
    // Failure modes: the transaction wrapper rejects the new compact anchor,
    // or restart reloads a stale journal/head after the replacement.
    const first = channel();
    let lineage = first.lineage;
    for (let index = 1; index <= 64; index++)
      lineage = appendCompactionTopUp(lineage, index);
    const at64: ServerChannelRecord = {
      ...first,
      lineage,
      activeOutpoint: lineage.currentHead!.outpoint,
      activeScriptPublicKey: lineage.currentHead!.scriptPublicKey,
      fundingAmount: lineage.currentHead!.value,
    };
    const storage = new FakeStorage();
    let ledger = new GatewayLedger(storage);
    await ledger.registerChannel(at64);
    await ledger.claimChannelOperation(channelOperation(at64, "recovery"));
    const compacted = appendCompactionTopUp(lineage, 65);
    const at65: ServerChannelRecord = {
      ...at64,
      version: "1",
      lineage: compacted,
      activeOutpoint: compacted.currentHead!.outpoint,
      activeScriptPublicKey: compacted.currentHead!.scriptPublicKey,
      fundingAmount: compacted.currentHead!.value,
    };
    await ledger.applyCovenantLineage(at64, at65, ATTEMPT);
    ledger = new GatewayLedger(storage);
    await expect(ledger.loadChannel(at64.channelId)).resolves.toEqual(at65);
    await expect(ledger.loadChannelOperation(at64.channelId)).resolves.toBeUndefined();
  });

  it("keeps bounded discovery checkpoints before a deposit and survives restart", async () => {
    const storage = new FakeStorage();
    let ledger = new GatewayLedger(storage);
    const first = { blockHash: TX, blueScore: "100", daaScore: "300" };
    await ledger.recordPnnCheckpoint(first);
    await ledger.recordPnnCheckpoint({ ...first, blockHash: OTHER_TX, daaScore: "599" });
    ledger = new GatewayLedger(storage);
    await expect(ledger.findPnnCheckpointBefore("450")).resolves.toEqual(first);
    await expect(ledger.findPnnCheckpointBefore("300")).resolves.toBeUndefined();
    for (let index = 2; index <= 130; index++) {
      await ledger.recordPnnCheckpoint({ ...first, daaScore: String(index * 300) });
    }
    await expect(storage.get("pnn-discovery-checkpoints")).resolves.toHaveLength(128);
    await expect(ledger.findPnnCheckpointBefore("450")).resolves.toBeUndefined();
  });

  it("preserves PNN funding receipts across restarts and rejects conflicting origins", async () => {
    const storage = new FakeStorage();
    let ledger = new GatewayLedger(storage);
    const record = { transactionId: TX, checkpoint: { blockHash: OTHER_TX, blueScore: "100", daaScore: "200" },
      origins: [{ outpoint: { txid: FUNDING_TX, index: 0 }, amount: "1000", scriptPublicKey: SCRIPT, covenantId: null }] };
    await ledger.claimExactSettlementWithEvidence(
      exactSettlementAttempt({ profile: "standard-native", head: undefined }), record,
    );
    ledger = new GatewayLedger(storage);
    await expect(ledger.loadPnnEvidence(TX)).resolves.toEqual(record);
    const before = storage.snapshot();
    await expect(ledger.savePnnEvidence({ ...record, origins: [{ ...record.origins[0]!, amount: "2000" }] }))
      .rejects.toThrow("conflicts with its durable funding snapshot");
    expect(storage.snapshot()).toEqual(before);
  });

  it("rolls back the exact claim when its PNN budget write fails", async () => {
    const storage = new FakeStorage();
    const ledger = new GatewayLedger(storage);
    const record = { transactionId: TX, checkpoint: { blockHash: OTHER_TX, blueScore: "100", daaScore: "200" } };
    storage.failWriteForKey("pnn-evidence:budget");
    await expect(ledger.claimExactSettlementWithEvidence(
      exactSettlementAttempt({ profile: "standard-native", head: undefined }), record,
    )).rejects.toThrow("injected storage write failure");
    await expect(ledger.loadPnnEvidence(TX)).resolves.toBeUndefined();
    await expect(ledger.loadExactSettlementAttempt(TX)).resolves.toBeUndefined();
    await expect(storage.get("pnn-evidence:budget")).resolves.toBeUndefined();
  });

  it("rejects a saturated evidence budget before claiming an additive head", async () => {
    const storage = new FakeStorage();
    const ledger = new GatewayLedger(storage);
    await ledger.registerExactHead(exactHead());
    await storage.put("pnn-evidence:budget", { records: 4096, bytes: 0, reservedBytes: 0 });
    const receipt = {
      transactionId: TX,
      checkpoint: { blockHash: OTHER_TX, blueScore: "100", daaScore: "200" },
    };
    await expect(ledger.claimExactSettlementWithEvidence(exactSettlementAttempt(), receipt))
      .rejects.toThrow("capacity exhausted");
    await expect(storage.get("pnn-evidence:budget")).resolves.toEqual({
      records: 4096, bytes: 0, reservedBytes: 0,
    });
    await expect(ledger.loadExactSettlementAttempt(TX)).resolves.toBeUndefined();
    await expect(ledger.loadExactHead(HEAD_ID)).resolves.toMatchObject({
      status: "available", version: "0",
    });
  });

  it("keeps room for accepted evidence when the budget fills at claim time", async () => {
    const storage = new FakeStorage();
    const originalBudget = {
      records: 1_000, bytes: 64 * 1024 * 1024 - 64 * 1024, reservedBytes: 0,
    };
    await storage.put("pnn-evidence:budget", originalBudget);
    const ledger = new GatewayLedger(storage);
    const receipt = {
      transactionId: TX,
      checkpoint: { blockHash: OTHER_TX, blueScore: "100", daaScore: "200" },
    };
    await ledger.claimExactSettlementWithEvidence(
      exactSettlementAttempt({ profile: "standard-native", head: undefined }), receipt,
    );
    await ledger.acceptExactSettlement(TX, "accepted", "2026-07-07T00:00:01.000Z");
    const accepted = {
      ...receipt,
      transaction: { transaction_id: TX, is_accepted: true, inputs: [], outputs: [] },
    };
    await expect(ledger.savePnnEvidence(accepted)).resolves.toBeUndefined();
    await expect(new GatewayLedger(storage).loadPnnEvidence(TX)).resolves.toEqual(accepted);
    const budget = await storage.get<typeof originalBudget>("pnn-evidence:budget");
    expect(budget!.records).toBe(1_001);
    expect(budget!.bytes + budget!.reservedBytes).toBe(64 * 1024 * 1024);
    const acceptedBudget = await storage.get<typeof originalBudget>("pnn-evidence:budget");
    await expect(ledger.claimExactSettlementWithEvidence(
      exactSettlementAttempt({ profile: "standard-native", head: undefined }), receipt,
    )).resolves.toMatchObject({ created: false });
    await expect(ledger.loadPnnEvidence(TX)).resolves.toEqual(accepted);
    await expect(storage.get("pnn-evidence:budget")).resolves.toEqual(acceptedBudget);
    await ledger.beginExactHandler(TX, "2026-07-07T00:00:02.000Z");
    await ledger.recordExactHandlerResult(
      TX, { chargedAmount: "20000000" }, "2026-07-07T00:00:03.000Z",
    );
    await ledger.commitExactPayment({
      payment: exactPayment({ profile: "standard-native", amount: "20000000" }),
    });
    await expect(storage.get<typeof originalBudget>("pnn-evidence:budget"))
      .resolves.toMatchObject({ records: 1_001, reservedBytes: 0 });
  });

  it("releases PNN capacity when an unaccepted settlement is abandoned", async () => {
    const storage = new FakeStorage();
    const ledger = new GatewayLedger(storage);
    const receipt = {
      transactionId: TX,
      checkpoint: { blockHash: OTHER_TX, blueScore: "100", daaScore: "200" },
    };
    await ledger.claimExactSettlementWithEvidence(
      exactSettlementAttempt({ profile: "standard-native", head: undefined }), receipt,
    );
    await ledger.abandonExactSettlement(
      TX, "trusted rejection before broadcast", "2026-07-07T00:00:01.000Z",
    );
    await expect(ledger.loadPnnEvidence(TX)).resolves.toBeUndefined();
    await expect(storage.get("pnn-evidence:budget")).resolves.toEqual({
      records: 0, bytes: 0, reservedBytes: 0,
    });
  });

  it("releases an exact-limit PNN receipt when its settlement is abandoned", async () => {
    const storage = new FakeStorage();
    const ledger = new GatewayLedger(storage);
    const receipt = {
      transactionId: TX,
      checkpoint: { blockHash: OTHER_TX, blueScore: "100", daaScore: "200" },
      transaction: { transaction_id: TX, is_accepted: true, payload: "" },
    };
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if ((64 * 1024 - bytes(receipt)) % 2 !== 0)
      receipt.checkpoint.daaScore = "2000";
    receipt.transaction.payload = "ab".repeat((64 * 1024 - bytes(receipt)) / 2);
    expect(bytes(receipt)).toBe(64 * 1024);

    await ledger.claimExactSettlementWithEvidence(
      exactSettlementAttempt({ profile: "standard-native", head: undefined }), receipt,
    );
    await ledger.abandonExactSettlement(
      TX, "trusted rejection before broadcast", "2026-07-07T00:00:01.000Z",
    );
    await expect(ledger.loadExactSettlementAttempt(TX)).resolves.toBeUndefined();
    await expect(ledger.loadPnnEvidence(TX)).resolves.toBeUndefined();
    await expect(storage.get("pnn-evidence:budget")).resolves.toEqual({
      records: 0, bytes: 0, reservedBytes: 0,
    });
  });

  it("rejects independently provisioned additive heads at max plus one", async () => {
    const ledger = new GatewayLedger(new FakeStorage(), {
      limits: { maxExactHeads: 2 },
    });
    await ledger.registerExactHead(exactHead());
    await ledger.registerExactHead(
      exactHead({
        headId: "92".repeat(32),
        currentOutpoint: { txid: "93".repeat(32), index: 0 },
      }),
    );

    await expect(
      ledger.registerExactHead(
        exactHead({
          headId: "94".repeat(32),
          currentOutpoint: { txid: "95".repeat(32), index: 0 },
        }),
      ),
    ).rejects.toThrow("exact head admission limit");
    await expect(ledger.listExactHeads()).resolves.toHaveLength(2);
  });

  it("atomically binds one covenant lineage to one channel", async () => {
    const ledger = new GatewayLedger(new FakeStorage());
    const first = channel();
    const alias = channel({
      channelId: "12".repeat(32),
      channelConfig: {
        ...first.channelConfig,
        salt: "13".repeat(32),
      },
    });

    await ledger.registerChannel(first);
    await expect(ledger.registerChannel(alias)).rejects.toThrow(
      "covenant lineage is already registered",
    );
    await expect(ledger.loadChannel(first.channelId)).resolves.toEqual(first);
    await expect(ledger.loadChannel(alias.channelId)).resolves.toBeUndefined();
  });

  it("preserves covenant lineage ownership through retirement and restart", async () => {
    const storage = new FakeStorage();
    let ledger = new GatewayLedger(storage);
    const first = channel();
    await ledger.registerChannel(first);
    await ledger.claimChannelOperation(channelOperation(first, "retirement"));
    await ledger.retireChannel(first.channelId, ATTEMPT, first);
    ledger = new GatewayLedger(storage);
    const alias = channel({
      channelId: "12".repeat(32),
      channelConfig: {
        ...first.channelConfig,
        salt: "13".repeat(32),
      },
    });
    await expect(ledger.registerChannel(alias)).rejects.toThrow(
      "covenant lineage is already registered",
    );
    await expect(ledger.loadChannel(alias.channelId)).resolves.toBeUndefined();
  });

  it("does not retire a terminal refunded channel", async () => {
    const first = channel();
    const acceptance = {
      ...acceptedEvidence(OTHER_TX),
      acceptingBlockHash: "ac".repeat(32),
    };
    const lineage = applyCovenantSelectedChainUpdate(first.lineage, {
      fromCheckpoint: first.lineage.checkpoint,
      checkpoint: acceptance.checkpoint,
      continuity: "complete",
      removedChainBlockHashes: [],
      addedChainBlocks: [
        {
          blockHash: acceptance.acceptingBlockHash,
          transitions: [
            {
              kind: "refund",
              covenantId: first.covenantId,
              templateId: first.channelConfig.templateId,
              consumedOutpoint: first.activeOutpoint,
              transactionId: OTHER_TX,
              authorizedSuccessorCount: 0,
              successor: null,
              terminalOutput: {
                index: 0,
                scriptPublicKey: SCRIPT,
                value: first.fundingAmount,
              },
              acceptance,
            },
          ],
        },
      ],
    });
    const refunded: ServerChannelRecord = {
      ...first,
      version: "1",
      status: "refunded",
      lineage,
    };
    const ledger = new GatewayLedger(new FakeStorage());
    await ledger.registerChannel(refunded);
    await ledger.claimChannelOperation(
      channelOperation(refunded, "retirement"),
    );

    await expect(
      ledger.retireChannel(refunded.channelId, ATTEMPT, refunded),
    ).rejects.toThrow("terminal refunded channel cannot be retired");
    await expect(ledger.loadChannel(refunded.channelId)).resolves.toEqual(
      refunded,
    );
  });

  it("selects durable additive heads without consuming unanswered challenges", async () => {
    const storage = new FakeStorage();
    const ledger = new GatewayLedger(storage);
    await ledger.registerExactHead(exactHead());
    await ledger.registerExactHead(
      exactHead({
        headId: "91".repeat(32),
        currentOutpoint: { txid: "92".repeat(32), index: 0 },
      }),
    );
    storage.listRequests.length = 0;

    for (let index = 0; index < 1_000; index += 1) {
      await expect(
        ledger.selectExactHead(
          exactHeadSelection(
            index % 2 === 0 ? "00".repeat(32) : "ff".repeat(32),
          ),
        ),
      ).resolves.toBeDefined();
    }
    expect(storage.listRequests).toHaveLength(1_000);
    expect(storage.listRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          prefix: expect.stringMatching(/^exact-head-select:/),
          limit: 32,
        }),
      ]),
    );
    expect(
      storage.listRequests.some((request) => request.prefix === "exact-head:"),
    ).toBe(false);

    await expect(ledger.listExactHeads()).resolves.toEqual([
      expect.objectContaining({
        headId: HEAD_ID,
        status: "available",
        version: "0",
      }),
      expect.objectContaining({
        headId: "91".repeat(32),
        status: "available",
        version: "0",
      }),
    ]);
    await expect(ledger.exactHeadStats()).resolves.toEqual({
      total: 2,
      available: 2,
      claimed: 0,
      unavailable: 0,
      retired: 0,
    });
  });

  it("applies batch settlement only when the channel snapshot still matches", async () => {
    const ledger = new GatewayLedger(new FakeStorage());
    await ledger.registerChannel({
      ...channel(),
      version: "1",
      chargedCumulativeAmount: "1",
      signedMaxClaimable: "1",
    });

    const stale = settlementCommit(channel(), {
      chargedCumulativeAmount: "100",
    });
    await expect(ledger.commitSettlement(stale)).rejects.toThrow(
      "channel state changed",
    );
    await expect(
      ledger.loadCommitment(stale.commitment.commitmentId),
    ).resolves.toBeUndefined();
  });

  it("persists protected batch work before atomically applying settlement", async () => {
    const ledger = new GatewayLedger(new FakeStorage());
    const previous = channel();
    await ledger.registerChannel(previous);
    const attempt = batchSettlementAttempt(previous);

    await expect(ledger.claimBatchSettlement(attempt)).resolves.toMatchObject({
      created: true,
    });
    await expect(
      ledger.claimBatchSettlement({
        ...attempt,
        createdAt: "2026-07-07T00:00:01.000Z",
      }),
    ).resolves.toMatchObject({ created: false });
    await expect(
      ledger.claimBatchSettlement({
        ...attempt,
        attemptId: OTHER_TX,
        paymentPayloadHash: OTHER_TX,
      }),
    ).rejects.toThrow("pending batch settlement");
    await expect(
      ledger.beginBatchHandler(ATTEMPT, "2026-07-07T00:00:02.000Z"),
    ).resolves.toBe(true);
    await expect(
      ledger.beginBatchHandler(ATTEMPT, "2026-07-07T00:00:03.000Z"),
    ).resolves.toBe(false);
    await ledger.recordBatchHandlerResult(
      ATTEMPT,
      { body: "download", chargedAmount: "100" },
      "2026-07-07T00:00:03.000Z",
    );

    const commit = settlementCommit(previous, {
      chargedCumulativeAmount: "100",
      signedMaxClaimable: "100",
      voucherSignature: "16".repeat(64),
    });
    await ledger.commitSettlement(commit);

    await expect(
      ledger.loadBatchSettlementAttempt(ATTEMPT),
    ).resolves.toMatchObject({
      status: "applied",
      paymentPayloadHash: PAYLOAD,
    });
    await expect(
      ledger.loadBatchSettlementAttempt(ATTEMPT),
    ).resolves.not.toHaveProperty("handlerResult");
    await expect(ledger.loadChannel(CHANNEL_ID)).resolves.toMatchObject({
      covenantId: COVENANT_ID,
      chargedCumulativeAmount: "100",
      signedMaxClaimable: "100",
    });
  });

  it("releases an identified batch attempt after a pre-handler abort across restart", async () => {
    const storage = new FakeStorage();
    const previous = channel();
    let ledger = new GatewayLedger(storage);
    await ledger.registerChannel(previous);
    const claim: PaymentIdentifierReservationClaim = {
      id: "payment-id",
      fingerprint: REQUEST,
      paymentPayloadHash: PAYLOAD,
      paymentScopeId: CHANNEL_ID,
      paymentKind: "batch-settlement",
      ownerId: ATTEMPT,
      payerId: "payer:test",
      channelId: CHANNEL_ID,
    };
    await ledger.claimBatchSettlement(batchSettlementAttempt(previous, {
      paymentIdentifier: claim,
    }));
    const startedAt = "2026-07-07T00:00:02.000Z";
    await expect(ledger.beginBatchHandler(ATTEMPT, startedAt)).resolves.toBe(true);
    ledger = new GatewayLedger(storage);
    await expect(ledger.resetBatchHandlerBeforeExecution(ATTEMPT, startedAt))
      .resolves.toBe(true);
    await expect(ledger.loadPaymentIdentifierReservation(claim.id))
      .resolves.toMatchObject({ status: "reserved" });
    await expect(ledger.loadChannelOperation(CHANNEL_ID))
      .resolves.toMatchObject({ status: "reserved" });
    await expect(ledger.abandonBatchSettlement(
      ATTEMPT, "presentation expired", "2026-07-07T00:00:03.000Z",
    )).resolves.toBeUndefined();
    await expect(ledger.loadPaymentIdentifierReservation(claim.id))
      .resolves.toMatchObject({ status: "safely-released" });
    await expect(ledger.loadChannelOperation(CHANNEL_ID)).resolves.toBeUndefined();
  });

  it("rejects malformed batch settlement attempts before durable state changes", async () => {
    const ledger = new GatewayLedger(new FakeStorage());
    const current = channel();
    await ledger.registerChannel(current);
    const base = batchSettlementAttempt(current);
    const invalid: Array<{
      name: string;
      attempt: BatchSettlementAttemptRecord;
      message: string;
    }> = [
      {
        name: "uppercase attempt id",
        attempt: { ...base, attemptId: "AA".repeat(32) },
        message: "canonical lowercase",
      },
      {
        name: "zero covenant id",
        attempt: {
          ...base,
          covenantId: "00".repeat(32),
          expected: { ...base.expected, covenantId: "00".repeat(32) },
        },
        message: "canonical lowercase",
      },
      {
        name: "uppercase request fingerprint",
        attempt: {
          ...base,
          requestFingerprint: "AB".repeat(32),
        },
        message: "request fingerprint",
      },
      {
        name: "uppercase requirements hash",
        attempt: {
          ...base,
          paymentRequirementsHash: "CD".repeat(32),
        },
        message: "payment requirements hash",
      },
      {
        name: "uppercase payload hash",
        attempt: {
          ...base,
          paymentPayloadHash: "EF".repeat(32),
        },
        message: "payment payload hash",
      },
      {
        name: "uppercase active outpoint transaction id",
        attempt: {
          ...base,
          expected: {
            ...base.expected,
            activeOutpoint: {
              ...base.expected.activeOutpoint,
              txid: "AA".repeat(32),
            },
          },
        },
        message: "active outpoint transaction id",
      },
      {
        name: "noncanonical maximum charge",
        attempt: { ...base, maximumCharge: "01" },
        message: "canonical",
      },
      {
        name: "invalid accounting",
        attempt: {
          ...base,
          expected: {
            ...base.expected,
            chargedCumulativeAmount: "101",
            signedMaxClaimable: "100",
          },
        },
        message: "signed cumulative ceiling",
      },
      {
        name: "invalid date",
        attempt: { ...base, updatedAt: "not-a-date" },
        message: "ISO date string",
      },
    ];

    for (const testCase of invalid) {
      await expect(
        ledger.claimBatchSettlement(testCase.attempt),
        testCase.name,
      ).rejects.toThrow(testCase.message);
    }
    await expect(
      ledger.loadBatchSettlementAttempt(base.attemptId),
    ).resolves.toBeUndefined();
  });

  it("fails a started batch handler closed for explicit recovery", async () => {
    const ledger = new GatewayLedger(new FakeStorage());
    const previous = channel();
    await ledger.registerChannel(previous);
    await ledger.claimBatchSettlement(batchSettlementAttempt(previous));
    await ledger.beginBatchHandler(ATTEMPT, "2026-07-07T00:00:02.000Z");
    await ledger.markBatchHandlerRecoveryRequired(
      ATTEMPT,
      "handler outcome is uncertain",
      "2026-07-07T00:00:03.000Z",
    );

    await expect(
      ledger.loadBatchSettlementAttempt(ATTEMPT),
    ).resolves.toMatchObject({
      status: "pending",
      recoveryReason: "handler outcome is uncertain",
    });
  });

  it("retains identifier ownership across crashes through recovery and commit", async () => {
    const storage = new FakeStorage();
    let ledger = new GatewayLedger(storage);
    const claim = exactIdentifierClaim(TX, TX);
    await ledger.claimExactSettlement(
      exactSettlementAttempt({
        profile: "standard-native",
        head: undefined,
        paymentIdentifier: claim,
      }),
    );
    await expect(
      ledger.loadPaymentIdentifierReservation(claim.id),
    ).resolves.toMatchObject({ status: "reserved", ownerId: TX });

    ledger = new GatewayLedger(storage);
    await ledger.recordExactSettlementBroadcast(
      TX,
      "broadcast",
      "2026-07-07T00:00:01.000Z",
    );
    await expect(
      ledger.loadPaymentIdentifierReservation(claim.id),
    ).resolves.toMatchObject({ status: "pending" });
    await ledger.acceptExactSettlement(
      TX,
      "accepted",
      "2026-07-07T00:00:02.000Z",
    );
    await ledger.beginExactHandler(TX, "2026-07-07T00:00:03.000Z");
    await ledger.markExactHandlerRecoveryRequired(
      TX,
      "crash after protected effect",
      "2026-07-07T00:00:04.000Z",
    );
    await expect(
      ledger.loadPaymentIdentifierReservation(claim.id),
    ).resolves.toMatchObject({ status: "recovery-required" });
    await expect(
      ledger.abandonExactSettlement(
        TX,
        "unsafe release",
        "2026-07-07T00:00:05.000Z",
      ),
    ).rejects.toThrow("accepted exact settlement cannot be abandoned");

    ledger = new GatewayLedger(storage);
    await ledger.recordExactHandlerResult(
      TX,
      { body: "recovered", chargedAmount: "20000000" },
      "2026-07-07T00:00:06.000Z",
    );
    await ledger.commitExactPayment({
      payment: exactPayment({ profile: "standard-native", amount: "20000000" }),
      paymentIdentifier: {
        ...paymentIdentifier({ paymentScopeId: TX }),
        transactionId: TX,
        paymentOutputIndex: 0,
      },
    });
    await expect(
      ledger.loadPaymentIdentifierReservation(claim.id),
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("safely releases only a pre-effect identifier reservation", async () => {
    const storage = new FakeStorage();
    let ledger = new GatewayLedger(storage);
    const claim = exactIdentifierClaim(TX, TX);
    await ledger.claimExactSettlement(
      exactSettlementAttempt({
        profile: "standard-native",
        head: undefined,
        paymentIdentifier: claim,
      }),
    );
    await ledger.abandonExactSettlement(
      TX,
      "trusted rejection before broadcast",
      "2026-07-07T00:00:01.000Z",
    );
    await expect(
      ledger.loadPaymentIdentifierReservation(claim.id),
    ).resolves.toMatchObject({ status: "safely-released" });

    ledger = new GatewayLedger(storage);
    await expect(
      ledger.claimExactSettlement(
        exactSettlementAttempt({
          transactionId: OTHER_TX,
          profile: "standard-native",
          head: undefined,
          paymentIdentifier: exactIdentifierClaim(OTHER_TX, OTHER_TX),
        }),
      ),
    ).resolves.toMatchObject({ created: true });
  });

  it("serializes independent ledgers on one channel and opens its handler once", async () => {
    const storage = new FakeStorage();
    const first = new GatewayLedger(storage);
    const second = new GatewayLedger(storage);
    const current = channel();
    await first.registerChannel(current);
    const claims = await Promise.allSettled([
      first.claimBatchSettlement(batchSettlementAttempt(current)),
      second.claimBatchSettlement(
        batchSettlementAttempt(current, {
          attemptId: OTHER_TX,
          paymentPayloadHash: OTHER_TX,
        }),
      ),
    ]);
    expect(
      claims.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const winner = claims[0]!.status === "fulfilled" ? ATTEMPT : OTHER_TX;
    const starts = await Promise.all([
      first.beginBatchHandler(winner, "2026-07-07T00:00:01.000Z"),
      second.beginBatchHandler(winner, "2026-07-07T00:00:02.000Z"),
    ]);
    expect(starts.sort()).toEqual([false, true]);
  });

  it("uses one durable lease namespace for every channel operation kind", async () => {
    const ledger = new GatewayLedger(new FakeStorage());
    const current = channel();
    await ledger.registerChannel(current);
    const kinds: ChannelOperationLeaseRecord["kind"][] = [
      "payment",
      "deposit",
      "top-up",
      "claim",
      "refund",
      "recovery",
      "retirement",
    ];
    for (const [index, kind] of kinds.entries()) {
      const leaseId = (index + 1).toString(16).padStart(64, "0");
      await expect(
        ledger.claimChannelOperation({
          ...channelOperation(current, kind),
          leaseId,
        }),
      ).resolves.toMatchObject({ created: true, lease: { kind } });
      await expect(
        ledger.loadChannelOperation(current.channelId),
      ).resolves.toMatchObject({ leaseId, kind });
      await ledger.abandonChannelOperation(
        leaseId,
        "pre-effect test release",
        "2026-07-07T00:00:01.000Z",
      );
    }
    await expect(
      ledger.claimChannelOperation({
        ...channelOperation(current, "payment"),
        kind: "invalid" as ChannelOperationLeaseRecord["kind"],
      }),
    ).rejects.toThrow("channel operation kind is invalid");
  });

  it("atomically registers only one competing genesis transition", async () => {
    const storage = new FakeStorage();
    const first = new GatewayLedger(storage);
    const second = new GatewayLedger(storage);
    const leftChannel = channel({
      signedMaxClaimable: "100",
      voucherSignature: "16".repeat(64),
    });
    const rightChannel = channel({
      channelId: "12".repeat(32),
      channelConfig: { ...leftChannel.channelConfig, salt: "13".repeat(32) },
      signedMaxClaimable: "100",
      voucherSignature: "16".repeat(64),
    });
    const claims = await Promise.allSettled([
      first.claimBatchSettlement(
        batchSettlementAttempt(leftChannel, {
          operationKind: "deposit",
          channelTransition: { previous: null, next: leftChannel },
        }),
      ),
      second.claimBatchSettlement(
        batchSettlementAttempt(rightChannel, {
          attemptId: OTHER_TX,
          paymentPayloadHash: OTHER_TX,
          operationKind: "deposit",
          channelTransition: { previous: null, next: rightChannel },
        }),
      ),
    ]);
    expect(
      claims.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    await expect(first.listChannels()).resolves.toHaveLength(1);
  });

  it("rejects impossible same-outpoint deposit transitions atomically", async () => {
    const invalid: Array<{
      previous?: ServerChannelRecord;
      mutation: Partial<ServerChannelRecord>;
      message: string;
    }> = [
      {
        mutation: { fundingAmount: "1001" },
        message: "same-outpoint deposit state is inconsistent",
      },
      {
        mutation: { activeScriptPublicKey: "0000" + "aa".repeat(34) },
        message: "same-outpoint deposit state is inconsistent",
      },
      {
        mutation: { escrowAddress: "kaspatest:other-escrow" },
        message: "same-outpoint deposit state is inconsistent",
      },
      {
        mutation: { status: "retired" },
        message: "deposit transition requires an active channel",
      },
      {
        previous: channel({ status: "retired" }),
        mutation: { status: "active" },
        message: "deposit transition requires an active channel",
      },
    ];

    for (const [index, testCase] of invalid.entries()) {
      const previous = testCase.previous ?? channel();
      const ledger = new GatewayLedger(new FakeStorage());
      await ledger.registerChannel(previous);
      const next = {
        ...previous,
        version: "1",
        ...testCase.mutation,
      };
      const attemptId = (index + 1).toString(16).padStart(64, "0");
      await expect(
        ledger.claimBatchSettlement(
          batchSettlementAttempt(next, {
            attemptId,
            operationKind: "deposit",
            channelTransition: { previous, next },
          }),
        ),
      ).rejects.toThrow(testCase.message);
      await expect(ledger.loadChannel(previous.channelId)).resolves.toEqual(
        previous,
      );
      await expect(
        ledger.loadBatchSettlementAttempt(attemptId),
      ).resolves.toBeUndefined();
      await expect(
        ledger.loadChannelOperation(previous.channelId),
      ).resolves.toBeUndefined();
    }

    const previous = channel();
    const noOpLedger = new GatewayLedger(new FakeStorage());
    await noOpLedger.registerChannel(previous);
    const noOpTopUp = { ...previous, version: "1" };
    await expect(
      noOpLedger.claimBatchSettlement(
        batchSettlementAttempt(noOpTopUp, {
          attemptId: "ff".repeat(32),
          operationKind: "top-up",
          channelTransition: { previous, next: noOpTopUp },
        }),
      ),
    ).rejects.toThrow("top-up must replace the active outpoint");
    await expect(noOpLedger.loadChannel(previous.channelId)).resolves.toEqual(
      previous,
    );

    const invalidGenesis = channel({ status: "retired" });
    const genesisLedger = new GatewayLedger(new FakeStorage());
    await expect(
      genesisLedger.claimBatchSettlement(
        batchSettlementAttempt(invalidGenesis, {
          attemptId: "fe".repeat(32),
          operationKind: "deposit",
          channelTransition: { previous: null, next: invalidGenesis },
        }),
      ),
    ).rejects.toThrow("new channel must begin active");
    await expect(
      genesisLedger.loadChannel(invalidGenesis.channelId),
    ).resolves.toBeUndefined();
  });

  it("preserves valid same-outpoint refreshes and verified top-ups", async () => {
    const previous = channel();
    const refreshLedger = new GatewayLedger(new FakeStorage());
    await refreshLedger.registerChannel(previous);
    const refreshed = channel({
      version: "1",
      signedMaxClaimable: "100",
      voucherSignature: "16".repeat(64),
    });
    await expect(
      refreshLedger.claimBatchSettlement(
        batchSettlementAttempt(refreshed, {
          operationKind: "deposit",
          channelTransition: { previous, next: refreshed },
        }),
      ),
    ).resolves.toMatchObject({ created: true });

    const topUpLedger = new GatewayLedger(new FakeStorage());
    await topUpLedger.registerChannel(previous);
    const topUpAcceptance = acceptedEvidence(OTHER_TX);
    const topUpScript = "0000" + "aa".repeat(34);
    const topUpLineage = applyCovenantSelectedChainUpdate(previous.lineage, {
      fromCheckpoint: previous.lineage.checkpoint,
      checkpoint: topUpAcceptance.checkpoint,
      continuity: "complete",
      removedChainBlockHashes: [],
      addedChainBlocks: [
        {
          blockHash: topUpAcceptance.acceptingBlockHash,
          transitions: [
            {
              kind: "top-up",
              covenantId: previous.covenantId,
              templateId: previous.channelConfig.templateId,
              consumedOutpoint: previous.activeOutpoint,
              transactionId: OTHER_TX,
              authorizedSuccessorCount: 1,
              successor: {
                covenantId: previous.covenantId,
                authorizingInput: 0,
                outpoint: { txid: OTHER_TX, index: 0 },
                scriptPublicKey: topUpScript,
                value: "1001",
                claimedCumulativeAmount: previous.claimedCumulativeAmount,
              },
              terminalOutput: null,
              acceptance: topUpAcceptance,
            },
          ],
        },
      ],
    });
    const toppedUp: ServerChannelRecord = {
      ...previous,
      version: "1",
      activeOutpoint: { txid: OTHER_TX, index: 0 },
      activeScriptPublicKey: topUpScript,
      escrowAddress: "kaspatest:replacement-escrow",
      fundingAmount: "1001",
      lineage: topUpLineage,
    };
    await expect(
      topUpLedger.claimBatchSettlement(
        batchSettlementAttempt(toppedUp, {
          attemptId: OTHER_TX,
          operationKind: "top-up",
          channelTransition: { previous, next: toppedUp },
        }),
      ),
    ).resolves.toMatchObject({ created: true });
  });

  it("bounds open durable records and never expires recovery-required work", async () => {
    let now = 0;
    const ledger = new GatewayLedger(new FakeStorage(), {
      limits: {
        maxRecords: 1,
        maxBytes: 1024 * 1024,
        maxRecordsPerPayer: 1,
        terminalRetentionMs: 100,
      },
      now: () => now,
    });
    await ledger.claimExactSettlement(
      exactSettlementAttempt({ profile: "standard-native", head: undefined }),
    );
    await ledger.acceptExactSettlement(
      TX,
      "accepted",
      "2026-07-07T00:00:01.000Z",
    );
    await ledger.beginExactHandler(TX, "2026-07-07T00:00:02.000Z");
    await ledger.markExactHandlerRecoveryRequired(
      TX,
      "uncertain protected effect",
      "2026-07-07T00:00:03.000Z",
    );
    now = 1_000;
    await expect(
      ledger.claimExactSettlement(
        exactSettlementAttempt({
          transactionId: OTHER_TX,
          profile: "standard-native",
          head: undefined,
        }),
      ),
    ).rejects.toThrow("record limit exceeded");
    await expect(ledger.loadExactSettlementAttempt(TX)).resolves.toMatchObject({
      recoveryReason: "uncertain protected effect",
    });
  });

  it("reserves the complete duplicated terminal response bundle", async () => {
    const ledger = new GatewayLedger(new FakeStorage(), {
      limits: { maxBytes: 300_000 },
    });

    await expect(
      ledger.claimExactSettlement(
        exactSettlementAttempt({ profile: "standard-native", head: undefined }),
      ),
    ).rejects.toThrow("byte limit exceeded");
  });

  it("accounts for safely released identifier records until bounded expiry", async () => {
    let now = 0;
    const storage = new FakeStorage();
    const ledger = new GatewayLedger(storage, {
      limits: {
        maxRecords: 1,
        maxBytes: 1024 * 1024,
        maxRecordsPerPayer: 1,
        terminalRetentionMs: 100,
      },
      now: () => now,
    });
    const firstIdentifier = exactIdentifierClaim(TX, TX);
    await ledger.claimExactSettlement(
      exactSettlementAttempt({
        profile: "standard-native",
        head: undefined,
        paymentIdentifier: firstIdentifier,
      }),
    );
    await ledger.abandonExactSettlement(
      TX,
      "trusted pre-effect rejection",
      "2026-07-07T00:00:01.000Z",
    );

    for (let index = 1; index < 5; index += 1) {
      const transactionId = (100 + index).toString(16).padStart(64, "0");
      await ledger.claimExactSettlement(
        exactSettlementAttempt({
          transactionId,
          profile: "standard-native",
          head: undefined,
          paymentIdentifier: exactIdentifierClaim(transactionId, transactionId),
        }),
      );
      await ledger.abandonExactSettlement(
        transactionId,
        "trusted pre-effect rejection",
        "2026-07-07T00:00:01.000Z",
      );
    }

    await expect(storage.get("durable-budget:meta")).resolves.toMatchObject({
      records: 1,
    });
    expect(
      (await storage.list({ prefix: "durable-budget:terminal:" })).size,
    ).toBe(1);
    const next = exactSettlementAttempt({
      transactionId: OTHER_TX,
      profile: "standard-native",
      head: undefined,
      paymentIdentifier: {
        ...exactIdentifierClaim(OTHER_TX, OTHER_TX),
        id: "pay_8d5d747be160e280504c099d984bcfe1",
      },
    });
    await expect(ledger.claimExactSettlement(next)).rejects.toThrow(
      "record limit exceeded",
    );

    now = 101;
    await expect(ledger.claimExactSettlement(next)).resolves.toMatchObject({
      created: true,
    });
    await expect(
      ledger.loadPaymentIdentifierReservation(firstIdentifier.id),
    ).resolves.toBeUndefined();
  });

  it("retains replay tombstones without exhausting active record capacity", async () => {
    let now = 0;
    const ledger = new GatewayLedger(new FakeStorage(), {
      limits: {
        maxRecords: 1,
        maxBytes: 1024 * 1024,
        maxRecordsPerPayer: 1,
        terminalRetentionMs: 100,
      },
      now: () => now,
    });
    await ledger.claimExactSettlement(
      exactSettlementAttempt({ profile: "standard-native", head: undefined }),
    );
    await ledger.acceptExactSettlement(
      TX,
      "accepted",
      "2026-07-07T00:00:01.000Z",
    );
    await ledger.beginExactHandler(TX, "2026-07-07T00:00:02.000Z");
    await ledger.recordExactHandlerResult(
      TX,
      { chargedAmount: "20000000" },
      "2026-07-07T00:00:03.000Z",
    );
    await ledger.commitExactPayment({
      payment: exactPayment({ profile: "standard-native", amount: "20000000" }),
    });
    now = 101;
    await expect(
      ledger.claimExactSettlement(
        exactSettlementAttempt({
          transactionId: OTHER_TX,
          profile: "standard-native",
          head: undefined,
        }),
      ),
    ).resolves.toMatchObject({ created: true });
    await expect(ledger.loadExactPayment(TX)).resolves.toMatchObject({
      response: {
        status: 409,
        body: { error: "replay_record_retained" },
      },
    });
    await expect(
      ledger.loadExactSettlementAttempt(TX),
    ).resolves.toBeUndefined();
  });

  it("migrates a compacted quota row beyond the first 128 active rows", async () => {
    const storage = new FakeStorage();
    for (let index = 0; index < 128; index += 1) {
      const transactionId = index.toString(16).padStart(64, "0");
      const key = `exact:${transactionId}`;
      await storage.put(`durable-budget:record:${key}`, {
        key,
        kind: "exact",
        attemptId: transactionId,
        payerId: `active-${index}`,
        bytes: 1,
      });
    }
    const legacyTransactionId = "ff".repeat(32);
    const legacyKey = `exact:${legacyTransactionId}`;
    const replay = {
      transactionId: legacyTransactionId,
      response: {
        status: 409,
        headers: {},
        body: { error: "replay_record_retained" },
      },
    };
    await storage.put(`exact:${legacyTransactionId}`, replay);
    await storage.put(`durable-budget:record:${legacyKey}`, {
      key: legacyKey,
      kind: "exact",
      attemptId: legacyTransactionId,
      payerId: "legacy-compacted",
      bytes: 1,
      terminalAt: 0,
      compactedAt: 1,
    });
    await storage.put("durable-budget:meta", {
      records: 129,
      bytes: 129,
      payerCounts: {},
    });
    const ledger = new GatewayLedger(storage, {
      limits: {
        maxRecords: 129,
        maxBytes: 1024 * 1024 * 1024,
        maxRecordsPerPayer: 129,
        terminalRetentionMs: 100,
      },
      now: () => 0,
    });

    await expect(
      ledger.claimExactSettlement(
        exactSettlementAttempt({
          transactionId: OTHER_TX,
          profile: "standard-native",
          head: undefined,
        }),
      ),
    ).resolves.toMatchObject({ created: true });
    await expect(
      storage.get(`durable-budget:record:${legacyKey}`),
    ).resolves.toBeUndefined();
    await expect(storage.get(`exact:${legacyTransactionId}`)).resolves.toEqual(
      replay,
    );
    await expect(storage.get("durable-budget:meta")).resolves.toMatchObject({
      records: 129,
    });
    expect(
      storage.listRequests.some((request) => request.start !== undefined),
    ).toBe(true);
  });

  it("serializes lock ownership with expiring leases", async () => {
    const ledger = new GatewayLedger(new FakeStorage());
    await expect(
      ledger.acquireLock(CHANNEL_ID, "first", 1_000, 1_000),
    ).resolves.toBe(true);
    await expect(
      ledger.acquireLock(CHANNEL_ID, "second", 1_100, 1_000),
    ).resolves.toBe(false);
    await expect(
      ledger.acquireLock(CHANNEL_ID, "second", 2_001, 1_000),
    ).resolves.toBe(true);
    await ledger.releaseLock(CHANNEL_ID, "first");
    await expect(
      ledger.acquireLock(CHANNEL_ID, "third", 2_100, 1_000),
    ).resolves.toBe(false);
    await ledger.releaseLock(CHANNEL_ID, "second");
    await expect(
      ledger.acquireLock(CHANNEL_ID, "third", 2_200, 1_000),
    ).resolves.toBe(true);
  });

  it("renews a gateway lock while protected work is still running", async () => {
    const storage = new FakeStorage();
    const first = new DurableGatewayLockManager(new GatewayLedger(storage), 90);
    const second = new DurableGatewayLockManager(
      new GatewayLedger(storage),
      90,
    );
    const events: string[] = [];
    let releaseFirst!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstRun = first.runExclusive(CHANNEL_ID, async () => {
      events.push("first-start");
      await held;
      events.push("first-end");
    });

    await new Promise((resolve) => setTimeout(resolve, 110));
    const secondRun = second.runExclusive(CHANNEL_ID, async () => {
      events.push("second-start");
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(["first-start"]);

    releaseFirst();
    await Promise.all([firstRun, secondRun]);
    expect(events).toEqual(["first-start", "first-end", "second-start"]);
  });

  it("rate limits by fixed windows", async () => {
    const storage = new FakeStorage();
    const ledger = new GatewayLedger(storage);
    await expect(
      ledger.checkRateLimit("ip:exact", 1_000, 2, 60_000),
    ).resolves.toMatchObject({ allowed: true, count: 1 });
    await expect(
      ledger.checkRateLimit("ip:exact", 1_100, 2, 60_000),
    ).resolves.toMatchObject({ allowed: true, count: 2 });
    await expect(
      ledger.checkRateLimit("ip:exact", 1_200, 2, 60_000),
    ).resolves.toMatchObject({ allowed: false, count: 3 });
    await expect(
      ledger.checkRateLimit("ip:exact", 60_001, 2, 60_000),
    ).resolves.toMatchObject({ allowed: true, count: 1 });
    await expect(
      ledger.checkRateLimit("ip:exact", 180_001, 2, 60_000),
    ).resolves.toMatchObject({ allowed: true, count: 1 });
    const windows = await storage.list({ prefix: "rate-window:" });
    expect([...windows.keys()]).toEqual(["rate-window:active"]);
    expect(JSON.stringify([...windows.values()])).not.toContain("ip:exact");
  });

  it("enforces, renews, releases, and expires deployment-wide admission", async () => {
    const ledger = new GatewayLedger(new FakeStorage());
    const first = "00000000-0000-4000-8000-000000000001";
    const second = "00000000-0000-4000-8000-000000000002";
    const alice = "aa".repeat(32);
    const bob = "bb".repeat(32);

    await expect(
      ledger.acquirePublicAdmission(first, alice, 1_000, 1, 1, 1_000),
    ).resolves.toEqual({ allowed: true, active: 1 });
    await expect(
      ledger.acquirePublicAdmission(first, alice, 1_500, 1, 1, 1_000),
    ).resolves.toEqual({ allowed: true, active: 1 });
    await expect(
      ledger.acquirePublicAdmission(second, bob, 1_600, 1, 1, 1_000),
    ).resolves.toEqual({ allowed: false, active: 1, retryAt: 2_500, reason: "global_concurrency_exceeded" });

    await ledger.releasePublicAdmission(first);
    await expect(
      ledger.acquirePublicAdmission(second, bob, 1_700, 1, 1, 1_000),
    ).resolves.toEqual({ allowed: true, active: 1 });
    await expect(
      ledger.acquirePublicAdmission(first, alice, 2_700, 1, 1, 1_000),
    ).resolves.toEqual({ allowed: true, active: 1 });
  });

  it("admits only one concurrent caller across shared ledger clients", async () => {
    const storage = new FakeStorage();
    const firstLedger = new GatewayLedger(storage);
    const secondLedger = new GatewayLedger(storage);
    const results = await Promise.all([
      firstLedger.acquirePublicAdmission(
        "00000000-0000-4000-8000-000000000001",
        "aa".repeat(32),
        1_000,
        1,
        1,
        1_000,
      ),
      secondLedger.acquirePublicAdmission(
        "00000000-0000-4000-8000-000000000002",
        "bb".repeat(32),
        1_000,
        1,
        1,
        1_000,
      ),
    ]);

    expect(results.filter((result) => result.allowed)).toHaveLength(1);
    expect(results.filter((result) => !result.allowed)).toHaveLength(1);
  });

  it("fails closed when a rate window reaches its bounded scope capacity", async () => {
    const ledger = new GatewayLedger(new FakeStorage());
    for (let index = 0; index < 1_024; index += 1) {
      await expect(
        ledger.checkRateLimit(`ip-${index}:exact`, 1_000, 1, 60_000),
      ).resolves.toMatchObject({ allowed: true, count: 1 });
    }
    await expect(
      ledger.checkRateLimit("overflow:exact", 1_000, 1, 60_000),
    ).resolves.toMatchObject({ allowed: false, count: 2 });
  });

  it("does not reopen a rate window when wall-clock time moves backward", async () => {
    const ledger = new GatewayLedger(new FakeStorage());
    await expect(
      ledger.checkRateLimit("ip:exact", 61_000, 1, 60_000),
    ).resolves.toMatchObject({ allowed: true, count: 1, resetAt: 120_000 });
    await expect(
      ledger.checkRateLimit("ip:exact", 61_001, 1, 60_000),
    ).resolves.toMatchObject({ allowed: false, count: 2, resetAt: 120_000 });
    await expect(
      ledger.checkRateLimit("ip:exact", 59_999, 1, 60_000),
    ).resolves.toMatchObject({ allowed: false, count: 3, resetAt: 120_000 });
    await expect(
      ledger.checkRateLimit("ip:exact", 61_002, 1, 60_000),
    ).resolves.toMatchObject({ allowed: false, count: 4, resetAt: 120_000 });
  });

  it("persists the latest canary report", async () => {
    const ledger = new GatewayLedger(new FakeStorage());
    const report = {
      checkedAt: "2026-07-03T00:00:00.000Z",
      trigger: "scheduled" as const,
      ok: true,
      checks: [
        { name: "exact-offer", status: "ok" as const, detail: "valid offer" },
      ],
    };

    await ledger.saveCanaryReport(report);

    await expect(ledger.loadCanaryReport()).resolves.toEqual(report);
  });

  it("keeps one absolute batch refund timeout until the minimum lead is reached", async () => {
    const ledger = new GatewayLedger(new FakeStorage());

    await expect(
      ledger.resolveBatchRefundTimeoutDaa("1000", "1000", "100"),
    ).resolves.toBe("2000");
    await expect(
      ledger.resolveBatchRefundTimeoutDaa("1500", "1000", "100"),
    ).resolves.toBe("2000");
    await expect(
      ledger.resolveBatchRefundTimeoutDaa("1899", "1000", "100"),
    ).resolves.toBe("2000");
    await expect(
      ledger.resolveBatchRefundTimeoutDaa("1900", "1000", "100"),
    ).resolves.toBe("2900");
    await expect(
      ledger.resolveBatchRefundTimeoutDaa("1901", "1000", "100"),
    ).resolves.toBe("2900");
  });

  it("rejects an invalid persisted batch refund window", async () => {
    const ledger = new GatewayLedger(new FakeStorage());

    await expect(
      ledger.resolveBatchRefundTimeoutDaa("1000", "100", "100"),
    ).rejects.toThrow("must exceed minimum lead");
  });

  it("allows one open claim attempt per channel and applies by snapshot", async () => {
    const ledger = new GatewayLedger(new FakeStorage());
    await ledger.registerChannel(claimableChannel());
    const first = claimAttempt({ attemptId: ATTEMPT });
    await reserveClaim(ledger, first);
    await ledger.saveClaimAttempt(first);

    await expect(
      ledger.saveClaimAttempt(claimAttempt({ attemptId: OTHER_TX })),
    ).rejects.toThrow("already pending");
    const broadcast: ClaimAttemptRecord = {
      ...first,
      status: "broadcast",
      finality: "broadcast",
    };
    const accepted: ClaimAttemptRecord = {
      ...broadcast,
      status: "accepted",
      finality: "confirmed",
      acceptance: acceptedEvidence(broadcast.transactionId),
    };
    await ledger.saveClaimAttempt(broadcast);
    await ledger.saveClaimAttempt(accepted);
    await expect(
      ledger.applyClaimAttempt(
        claimSuccessor(claimableChannel(), first),
        accepted,
      ),
    ).resolves.toBeUndefined();
  });

  it("binds claim attempts to one immutable artifact and monotonic state", async () => {
    const ledger = new GatewayLedger(new FakeStorage());
    await ledger.registerChannel(claimableChannel());
    const pending = claimAttempt({ attemptId: ATTEMPT });
    await reserveClaim(ledger, pending);
    await ledger.saveClaimAttempt(pending);

    await expect(
      ledger.saveClaimAttempt({
        ...pending,
        transactionId: OTHER_TX,
        continuationOutpoint: {
          ...pending.continuationOutpoint!,
          txid: OTHER_TX,
        },
      }),
    ).rejects.toThrow("immutable artifact");
    await expect(
      ledger.saveClaimAttempt({ ...pending, transaction: "cd".repeat(32) }),
    ).rejects.toThrow("immutable artifact");
    await expect(
      ledger.saveClaimAttempt({ ...pending, requiredConfirmations: 31 }),
    ).rejects.toThrow("immutable artifact");
    await expect(
      ledger.saveClaimAttempt({
        ...pending,
        status: "accepted",
        finality: "confirmed",
        acceptance: acceptedEvidence(pending.transactionId),
      }),
    ).rejects.toThrow("status transition");

    const broadcast: ClaimAttemptRecord = {
      ...pending,
      status: "broadcast",
      finality: "broadcast",
    };
    await ledger.saveClaimAttempt(broadcast);
    await expect(ledger.saveClaimAttempt(pending)).rejects.toThrow(
      "status transition",
    );
    await expect(
      ledger.saveClaimAttempt({
        ...broadcast,
        status: "applied",
        finality: "confirmed",
        acceptance: acceptedEvidence(broadcast.transactionId),
      }),
    ).rejects.toThrow("applied atomically");

    const accepted: ClaimAttemptRecord = {
      ...broadcast,
      status: "accepted",
      finality: "confirmed",
      acceptance: acceptedEvidence(broadcast.transactionId),
    };
    await ledger.saveClaimAttempt(accepted);
    await expect(ledger.saveClaimAttempt(accepted)).resolves.toBeUndefined();
    await expect(
      ledger.saveClaimAttempt({
        ...accepted,
        acceptance: {
          ...accepted.acceptance!,
          acceptingBlockHash: "ac".repeat(32),
        },
      }),
    ).rejects.toThrow("same-state update");
    await expect(
      ledger.applyClaimAttempt(claimSuccessor(claimableChannel(), accepted), {
        ...accepted,
        transactionId: OTHER_TX,
        continuationOutpoint: {
          ...accepted.continuationOutpoint!,
          txid: OTHER_TX,
        },
      }),
    ).rejects.toThrow("persisted accepted attempt");
    const changedChannel = {
      ...channel(),
      chargedCumulativeAmount: "1",
      signedMaxClaimable: "1",
    };
    await expect(
      ledger.applyClaimAttempt(claimSuccessor(claimableChannel(), accepted), {
        ...accepted,
        chargedCumulativeAmount: "1",
        signedMaxClaimable: "1",
      }),
    ).rejects.toThrow("persisted accepted attempt");
    await expect(ledger.loadOpenClaimAttempt(CHANNEL_ID)).resolves.toEqual(
      accepted,
    );
    await expect(ledger.loadChannel(CHANNEL_ID)).resolves.toEqual(
      claimableChannel(),
    );
  });
});

function appendCompactionTopUp(
  state: CovenantLineageState,
  index: number,
): CovenantLineageState {
  const head = state.currentHead;
  if (!head) throw new Error("compaction fixture requires a live covenant head");
  const transactionId = sha256Hex(`gateway-compaction-transaction:${index}`);
  const blockHash = sha256Hex(`gateway-compaction-block:${index}`);
  const checkpoint = { blockHash: "ef".repeat(32), blueScore: "1000", daaScore: "1000" };
  return applyCovenantSelectedChainUpdate(state, {
    fromCheckpoint: state.checkpoint,
    checkpoint,
    continuity: "complete",
    removedChainBlockHashes: [],
    addedChainBlocks: [{ blockHash, transitions: [{
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
    }] }],
  });
}

function channel(
  overrides: Partial<ServerChannelRecord> = {},
): ServerChannelRecord {
  const genesisAcceptance = acceptedEvidence(TX);
  const base = {
    channelId: CHANNEL_ID,
    covenantId: COVENANT_ID,
    version: "0",
    genesisEvidence: {
      covenantId: COVENANT_ID,
      authorizingInput: { txid: FUNDING_TX, index: 1 },
      genesisOutpoint: { txid: TX, index: 0 },
      genesisScriptPublicKey: SCRIPT,
      genesisAmount: "1000",
      totalOutputCount: 1,
      authorizedOutputCount: 1,
      acceptance: genesisAcceptance,
    },
    channelConfig: {
      network: "kaspa:testnet-10",
      asset: "KAS",
      templateId: "kaspa-x402-escrow-v5",
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
  };
  const merged = { ...base, ...overrides } as Omit<
    ServerChannelRecord,
    "lineage"
  > & { lineage?: ServerChannelRecord["lineage"] };
  const lineage =
    overrides.lineage ??
    createCovenantLineageState({
      format: "kaspa-x402-covenant-launch-v1",
      network: merged.channelConfig.network,
      compiler: structuredClone(ESCROW_V5_LAUNCH_IDENTITY.compiler),
      source: structuredClone(ESCROW_V5_LAUNCH_IDENTITY.source),
      bytecode: structuredClone(ESCROW_V5_LAUNCH_IDENTITY.bytecode),
      constructorSlots: structuredClone(
        ESCROW_V5_LAUNCH_IDENTITY.constructorSlots,
      ),
      abi: structuredClone(ESCROW_V5_LAUNCH_IDENTITY.abi),
      selectors: structuredClone(ESCROW_V5_LAUNCH_IDENTITY.selectors),
      identitySha256: ESCROW_V5_LAUNCH_IDENTITY.identitySha256,
      genesis: {
        derivation: "kip20-covenant-id-v1",
        covenantId: merged.covenantId,
        authorizingInput: merged.genesisEvidence.authorizingInput,
        transactionId: merged.activeOutpoint.txid,
        outpoint: merged.activeOutpoint,
        scriptPublicKey: merged.activeScriptPublicKey,
        value: merged.fundingAmount,
        claimedCumulativeAmount: merged.claimedCumulativeAmount,
        acceptance: acceptedEvidence(merged.activeOutpoint.txid),
      },
    });
  return { ...merged, lineage };
}

function acceptedEvidence(transactionId: string): AcceptedTransactionEvidence {
  return {
    status: "accepted",
    transactionId,
    acceptingBlockHash: "aa".repeat(32),
    acceptingBlockBlueScore: "971",
    confirmationCount: 30,
    checkpoint: {
      blockHash: "ab".repeat(32),
      blueScore: "1000",
      daaScore: "1000",
    },
  };
}

function claimableChannel(): ServerChannelRecord {
  return channel({
    chargedCumulativeAmount: "100",
    signedMaxClaimable: "100",
    voucherSignature: "16".repeat(64),
  });
}

function channelOperation(
  current: ServerChannelRecord,
  kind: ChannelOperationLeaseRecord["kind"],
): ChannelOperationLeaseRecord {
  return {
    leaseId: ATTEMPT,
    channelId: current.channelId,
    covenantId: current.covenantId,
    kind,
    expected: structuredClone(current),
    status: "reserved",
    createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z",
  };
}

async function reserveClaim(
  ledger: GatewayLedger,
  attempt: ClaimAttemptRecord,
): Promise<void> {
  await ledger.claimChannelOperation(
    channelOperation(attempt.expected, "claim"),
  );
}

function claimSuccessor(
  previous: ServerChannelRecord,
  attempt: ClaimAttemptRecord,
): ServerChannelRecord {
  const acceptance = attempt.acceptance ?? acceptedEvidence(attempt.transactionId);
  const claimedCumulativeAmount = (
    BigInt(previous.claimedCumulativeAmount) + BigInt(attempt.claimAmount)
  ).toString();
  const lineage = applyCovenantSelectedChainUpdate(previous.lineage, {
    fromCheckpoint: previous.lineage.checkpoint,
    checkpoint: acceptance.checkpoint,
    continuity: "complete",
    removedChainBlockHashes: [],
    addedChainBlocks: [
      {
        blockHash: acceptance.acceptingBlockHash,
        transitions: [
          {
            kind: "claim",
            covenantId: previous.covenantId,
            templateId: previous.channelConfig.templateId,
            consumedOutpoint: previous.activeOutpoint,
            transactionId: attempt.transactionId,
            authorizedSuccessorCount: 1,
            successor: {
              covenantId: previous.covenantId,
              authorizingInput: 0,
              outpoint: attempt.continuationOutpoint!,
              scriptPublicKey: attempt.continuationScriptPublicKey!,
              value: attempt.continuationFundingAmount!,
              claimedCumulativeAmount,
            },
            terminalOutput: null,
            acceptance,
          },
        ],
      },
    ],
  });
  return {
    ...previous,
    version: (BigInt(previous.version) + 1n).toString(),
    activeOutpoint: attempt.continuationOutpoint!,
    activeScriptPublicKey: attempt.continuationScriptPublicKey!,
    fundingAmount: attempt.continuationFundingAmount!,
    claimedCumulativeAmount,
    lineage,
  };
}

function settlementCommit(
  previous: ServerChannelRecord,
  next: Partial<ServerChannelRecord>,
): SettlementCommit {
  const updated = {
    ...previous,
    version: (BigInt(previous.version) + 1n).toString(),
    lastCommitmentId: "15".repeat(32),
    ...next,
  };
  const commitment: BatchCommitmentRecord = {
    commitmentId: "15".repeat(32),
    channelId: previous.channelId,
    covenantId: previous.covenantId,
    requestFingerprint: REQUEST,
    paymentRequirementsHash: REQUIREMENTS,
    paymentPayloadHash: PAYLOAD,
    activeOutpoint: previous.activeOutpoint,
    activeScriptPublicKey: previous.activeScriptPublicKey,
    voucher: {
      covenantId: previous.covenantId,
      authorizedCumulativeAmount: "100",
      signature: "16".repeat(64),
    },
    chargedAmount: "100",
    chargedCumulativeBefore: previous.chargedCumulativeAmount,
    chargedCumulativeAfter: updated.chargedCumulativeAmount,
    claimedCumulativeAmount: previous.claimedCumulativeAmount,
    settlement: {
      success: true,
      transaction: "15".repeat(32),
      network: "kaspa:testnet-10",
      amount: "100",
    },
    response: { status: 200, headers: {}, body: "ok" },
  };
  return {
    batchAttemptId: ATTEMPT,
    channel: updated,
    commitment,
    expected: structuredClone(previous),
  };
}

function batchSettlementAttempt(
  previous: ServerChannelRecord,
  overrides: Partial<BatchSettlementAttemptRecord> = {},
): BatchSettlementAttemptRecord {
  return {
    attemptId: ATTEMPT,
    channelId: previous.channelId,
    covenantId: previous.covenantId,
    requestFingerprint: REQUEST,
    paymentRequirementsHash: REQUIREMENTS,
    paymentPayloadHash: PAYLOAD,
    maximumCharge: "100",
    operationKind: "payment",
    payerId: "payer:test",
    expected: structuredClone(previous),
    status: "pending",
    createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z",
    ...overrides,
  };
}

function exactPayment(
  overrides: Partial<ExactPaymentRecord> = {},
): ExactPaymentRecord {
  return {
    profile: "additive",
    transactionId: TX,
    paymentOutputIndex: 0,
    requestFingerprint: REQUEST,
    paymentRequirementsHash: REQUIREMENTS,
    paymentPayloadHash: PAYLOAD,
    requestAuthorizationId: "17".repeat(32),
    amount: "100",
    finality: "accepted",
    settlement: {
      success: true,
      transaction: TX,
      network: "kaspa:testnet-10",
      amount: "100",
    },
    response: { status: 200, headers: {}, body: "ok" },
    ...overrides,
  };
}

function exactHead(overrides: Partial<ExactHeadRecord> = {}): ExactHeadRecord {
  return {
    headId: HEAD_ID,
    network: "kaspa:testnet-10",
    payTo: "kaspatest:head",
    templateId: "kaspa-x402-kip10-additive-v1",
    transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
    currentOutpoint: { txid: FUNDING_TX, index: 0 },
    currentAmount: "100000000",
    scriptPublicKey: KIP10_SCRIPT_PUBLIC_KEY,
    redeemScript: KIP10_REDEEM_SCRIPT,
    additiveThresholdSompi: "10000000",
    version: "0",
    status: "available",
    createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z",
    ...overrides,
  };
}

function exactHeadSelection(selectionKey = "00".repeat(32)) {
  return {
    network: "kaspa:testnet-10" as const,
    amount: "20000000",
    payTo: "kaspatest:head",
    payToScriptPublicKey: KIP10_SCRIPT_PUBLIC_KEY,
    minimumAdditiveThresholdSompi: "10000000",
    selectionKey,
  };
}

function exactSettlementAttempt(
  overrides: Partial<ExactSettlementAttemptRecord> = {},
): ExactSettlementAttemptRecord {
  return {
    transactionId: TX,
    profile: "additive",
    amount: "20000000",
    paymentOutputIndex: 0,
    requestFingerprint: REQUEST,
    paymentRequirementsHash: REQUIREMENTS,
    paymentPayloadHash: PAYLOAD,
    requestAuthorizationId: "17".repeat(32),
    authorizationExpiresAt: "2099-01-01T00:00:00.000Z",
    payToScriptPublicKey: KIP10_SCRIPT_PUBLIC_KEY,
    transaction: "signed-additive-transaction",
    requiredFinality: "accepted",
    payerId: "payer:test",
    status: "pending",
    createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z",
    head: {
      headId: HEAD_ID,
      expectedVersion: "0",
      expectedOutpoint: { txid: FUNDING_TX, index: 0 },
      expectedAmount: "100000000",
      successor: {
        outpoint: { txid: TX, index: 0 },
        amount: "120000000",
        scriptPublicKey: KIP10_SCRIPT_PUBLIC_KEY,
      },
    },
    ...overrides,
  };
}

function exactIdentifierClaim(
  ownerId: string,
  paymentScopeId: string,
): PaymentIdentifierReservationClaim {
  return {
    id: "payment-id",
    fingerprint: REQUEST,
    paymentPayloadHash: PAYLOAD,
    paymentScopeId,
    paymentKind: "exact",
    ownerId,
    payerId: "payer:test",
    transactionId: ownerId,
    paymentOutputIndex: 0,
  };
}

async function stageExactAttemptWithIdentifier(
  ledger: GatewayLedger,
  transactionId: string,
  paymentScopeId: string,
): Promise<void> {
  await ledger.claimExactSettlement(
    exactSettlementAttempt({
      transactionId,
      profile: "standard-native",
      head: undefined,
      paymentIdentifier: exactIdentifierClaim(transactionId, paymentScopeId),
    }),
  );
  await ledger.acceptExactSettlement(
    transactionId,
    "accepted",
    "2026-07-07T00:00:01.000Z",
  );
  await ledger.beginExactHandler(transactionId, "2026-07-07T00:00:02.000Z");
  await ledger.recordExactHandlerResult(
    transactionId,
    { chargedAmount: "20000000" },
    "2026-07-07T00:00:03.000Z",
  );
  await ledger.commitExactPayment({
    payment: exactPayment({
      transactionId,
      profile: "standard-native",
      amount: "20000000",
    }),
    paymentIdentifier: {
      ...paymentIdentifier({ paymentScopeId }),
      transactionId,
      paymentOutputIndex: 0,
    },
  });
}

function paymentIdentifier(
  overrides: Partial<PaymentIdentifierRecord> = {},
): PaymentIdentifierRecord {
  return {
    id: "payment-id",
    fingerprint: REQUEST,
    paymentPayloadHash: PAYLOAD,
    paymentScopeId: TX,
    response: { status: 200, headers: {}, body: "ok" },
    settlement: {
      success: true,
      transaction: TX,
      network: "kaspa:testnet-10",
      amount: "100",
    },
    ...overrides,
  };
}

function claimAttempt(
  overrides: Partial<ClaimAttemptRecord> = {},
): ClaimAttemptRecord {
  const current = claimableChannel();
  return {
    attemptId: ATTEMPT,
    channelId: CHANNEL_ID,
    covenantId: COVENANT_ID,
    activeOutpoint: current.activeOutpoint,
    activeScriptPublicKey: current.activeScriptPublicKey,
    fundingAmount: current.fundingAmount,
    claimAmount: "100",
    chargedCumulativeAmount: current.chargedCumulativeAmount,
    claimedCumulativeAmount: current.claimedCumulativeAmount,
    signedMaxClaimable: current.signedMaxClaimable,
    voucherSignature: current.voucherSignature,
    channelStatus: current.status,
    transaction: "aa",
    transactionId: TX,
    requiredConfirmations: 30,
    operationLeaseId: ATTEMPT,
    expected: structuredClone(current),
    continuationOutpoint: { txid: TX, index: 1 },
    continuationScriptPublicKey: SCRIPT,
    continuationFundingAmount: "900",
    status: "pending",
    ...overrides,
  };
}

function cloneOrUndefined<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}
