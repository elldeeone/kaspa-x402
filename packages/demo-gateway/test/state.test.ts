import { describe, expect, it } from "vitest";
import type {
  BatchCommitmentRecord,
  BatchSettlementAttemptRecord,
  ClaimAttemptRecord,
  ExactHeadRecord,
  ExactPaymentRecord,
  ExactSettlementAttemptRecord,
  PaymentIdentifierRecord,
  ServerChannelRecord,
  SettlementCommit,
} from "@kaspa-x402/server";
import {
  buildKip10AdditiveRedeemScript,
  payToScriptHashScript,
  serializedScriptPublicKey,
} from "@kaspa-x402/covenant";
import { GatewayLedger, type GatewayStorage } from "../src/state.js";

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

    await ledger.saveChannel(first);
    await expect(ledger.saveChannel(alias)).rejects.toThrow(
      "covenant lineage is already registered",
    );
    await expect(ledger.loadChannel(first.channelId)).resolves.toEqual(first);
    await expect(ledger.loadChannel(alias.channelId)).resolves.toBeUndefined();
  });

  it("commits exact transaction ids once while allowing identical retries", async () => {
    const ledger = new GatewayLedger(new FakeStorage());
    const first = exactPayment({ paymentOutputIndex: 1 });

    await ledger.commitExactPayment({ payment: first });
    await ledger.commitExactPayment({ payment: first });

    await expect(ledger.loadExactPayment(TX)).resolves.toMatchObject({
      transactionId: TX,
      paymentOutputIndex: 1,
    });
    await expect(
      ledger.commitExactPayment({
        payment: exactPayment({ paymentOutputIndex: 2 }),
      }),
    ).rejects.toThrow("already committed");
  });

  it("keeps conflicting payment identifiers atomic", async () => {
    const ledger = new GatewayLedger(new FakeStorage());
    await ledger.commitExactPayment({
      payment: exactPayment({ transactionId: TX }),
      paymentIdentifier: paymentIdentifier({ paymentScopeId: TX }),
    });

    await expect(
      ledger.commitExactPayment({
        payment: exactPayment({ transactionId: OTHER_TX }),
        paymentIdentifier: paymentIdentifier({ paymentScopeId: OTHER_TX }),
      }),
    ).rejects.toThrow("payment identifier");
    await expect(ledger.loadExactPayment(OTHER_TX)).resolves.toBeUndefined();
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

  it("atomically persists a verified external head lineage", async () => {
    const ledger = new GatewayLedger(new FakeStorage());
    await ledger.registerExactHead(exactHead());

    await expect(
      ledger.applyExactHeadLineage({
        headId: HEAD_ID,
        expectedVersion: "0",
        expectedOutpoint: { txid: FUNDING_TX, index: 0 },
        expectedAmount: "100000000",
        steps: [
          {
            transactionId: OTHER_TX,
            spentOutpoint: { txid: FUNDING_TX, index: 0 },
            successor: {
              outpoint: { txid: OTHER_TX, index: 0 },
              amount: "110000000",
              scriptPublicKey: KIP10_SCRIPT_PUBLIC_KEY,
            },
            finality: "accepted",
          },
        ],
        observedAt: "2026-07-07T00:00:01.000Z",
      }),
    ).resolves.toMatchObject({
      version: "1",
      currentOutpoint: { txid: OTHER_TX, index: 0 },
      currentAmount: "110000000",
      status: "available",
    });
  });

  it("atomically advances one additive head winner and opens its handler once", async () => {
    const ledger = new GatewayLedger(new FakeStorage());
    await ledger.registerExactHead(exactHead());
    const attempt = exactSettlementAttempt();

    await expect(ledger.claimExactSettlement(attempt)).resolves.toMatchObject({
      created: true,
    });
    await expect(
      ledger.claimExactSettlement({
        ...attempt,
        createdAt: "2026-07-07T00:00:01.000Z",
      }),
    ).resolves.toMatchObject({
      created: false,
    });
    await expect(
      ledger.claimExactSettlement(
        exactSettlementAttempt({
          transactionId: OTHER_TX,
          head: {
            ...attempt.head!,
            successor: {
              ...attempt.head!.successor,
              outpoint: { txid: OTHER_TX, index: 0 },
            },
          },
        }),
      ),
    ).rejects.toThrow("head changed");
    await expect(
      ledger.selectExactHead(exactHeadSelection()),
    ).resolves.toBeUndefined();

    await ledger.recordExactSettlementBroadcast(
      TX,
      "broadcast",
      "2026-07-07T00:00:02.000Z",
    );
    await ledger.acceptExactSettlement(
      TX,
      "accepted",
      "2026-07-07T00:00:03.000Z",
    );
    await expect(ledger.loadExactHead(HEAD_ID)).resolves.toMatchObject({
      status: "available",
      version: "1",
      currentOutpoint: { txid: TX, index: 0 },
      currentAmount: "120000000",
      lastTransactionId: TX,
    });
    await expect(
      ledger.beginExactHandler(TX, "2026-07-07T00:00:04.000Z"),
    ).resolves.toBe(true);
    await expect(
      ledger.beginExactHandler(TX, "2026-07-07T00:00:05.000Z"),
    ).resolves.toBe(false);
    await ledger.recordExactHandlerResult(
      TX,
      { body: "download", chargedAmount: "20000000" },
      "2026-07-07T00:00:05.000Z",
    );
    await ledger.commitExactPayment({
      payment: exactPayment({
        transactionId: TX,
        paymentOutputIndex: 0,
        amount: "20000000",
      }),
    });
    await expect(ledger.loadExactSettlementAttempt(TX)).resolves.toMatchObject({
      status: "applied",
      handlerStartedAt: "2026-07-07T00:00:04.000Z",
      handlerResult: { body: "download", chargedAmount: "20000000" },
    });
  });

  it("releases rejected attempts and fails uncertain heads closed", async () => {
    const ledger = new GatewayLedger(new FakeStorage());
    await ledger.registerExactHead(exactHead());
    await ledger.claimExactSettlement(exactSettlementAttempt());
    await ledger.abandonExactSettlement(
      TX,
      "trusted node rejected transaction",
      "2026-07-07T00:00:02.000Z",
    );

    await expect(
      ledger.loadExactSettlementAttempt(TX),
    ).resolves.toBeUndefined();
    await expect(ledger.loadExactHead(HEAD_ID)).resolves.toMatchObject({
      status: "available",
      claimTransactionId: undefined,
    });
    await expect(
      ledger.markExactHeadUnavailable({
        headId: HEAD_ID,
        expectedVersion: "0",
        expectedOutpoint: { txid: FUNDING_TX, index: 0 },
        expectedAmount: "100000000",
        expectedStatus: "available",
        reason: "successor lineage unavailable",
        observedAt: "2026-07-07T00:00:03.000Z",
      }),
    ).resolves.toMatchObject({ applied: true });
    await expect(ledger.loadExactHead(HEAD_ID)).resolves.toMatchObject({
      status: "unavailable",
      unavailableReason: "successor lineage unavailable",
    });
    await expect(
      ledger.selectExactHead(exactHeadSelection()),
    ).resolves.toBeUndefined();
  });

  it("applies batch settlement only when the channel snapshot still matches", async () => {
    const ledger = new GatewayLedger(new FakeStorage());
    await ledger.saveChannel(channel());
    await ledger.saveChannel({ ...channel(), chargedCumulativeAmount: "1" });

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
    await ledger.saveChannel(previous);
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
      handlerResult: { body: "download", chargedAmount: "100" },
    });
    await expect(ledger.loadChannel(CHANNEL_ID)).resolves.toMatchObject({
      covenantId: COVENANT_ID,
      chargedCumulativeAmount: "100",
      signedMaxClaimable: "100",
    });
  });

  it("rejects malformed batch settlement attempts before durable state changes", async () => {
    const ledger = new GatewayLedger(new FakeStorage());
    const current = channel();
    await ledger.saveChannel(current);
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
    await ledger.saveChannel(previous);
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
    await ledger.saveChannel(channel());
    const first = claimAttempt({ attemptId: ATTEMPT });
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
      finality: "accepted",
    };
    await ledger.saveClaimAttempt(broadcast);
    await ledger.saveClaimAttempt(accepted);
    await ledger.saveChannel({ ...channel(), chargedCumulativeAmount: "1" });
    await expect(
      ledger.applyClaimAttempt(
        { ...channel(), claimedCumulativeAmount: "100" },
        accepted,
      ),
    ).rejects.toThrow("channel state changed");
  });

  it("binds claim attempts to one immutable artifact and monotonic state", async () => {
    const ledger = new GatewayLedger(new FakeStorage());
    await ledger.saveChannel(channel());
    const pending = claimAttempt({ attemptId: ATTEMPT });
    await ledger.saveClaimAttempt(pending);

    await expect(
      ledger.saveClaimAttempt({ ...pending, transactionId: OTHER_TX }),
    ).rejects.toThrow("immutable artifact");
    await expect(
      ledger.saveClaimAttempt({ ...pending, transaction: "cd".repeat(32) }),
    ).rejects.toThrow("immutable artifact");
    await expect(
      ledger.saveClaimAttempt({ ...pending, requiredFinality: "confirmed" }),
    ).rejects.toThrow("immutable artifact");
    await expect(
      ledger.saveClaimAttempt({
        ...pending,
        status: "accepted",
        finality: "accepted",
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
        finality: "accepted",
      }),
    ).rejects.toThrow("applied atomically");

    const accepted: ClaimAttemptRecord = {
      ...broadcast,
      status: "accepted",
      finality: "accepted",
    };
    await ledger.saveClaimAttempt(accepted);
    await expect(
      ledger.saveClaimAttempt({ ...accepted, finality: "confirmed" }),
    ).rejects.toThrow("same-state update");
    await expect(
      ledger.applyClaimAttempt(
        { ...channel(), claimedCumulativeAmount: "100" },
        { ...accepted, transactionId: OTHER_TX },
      ),
    ).rejects.toThrow("persisted accepted attempt");
    const changedChannel = {
      ...channel(),
      chargedCumulativeAmount: "1",
      signedMaxClaimable: "1",
    };
    await ledger.saveChannel(changedChannel);
    await expect(
      ledger.applyClaimAttempt(
        { ...changedChannel, claimedCumulativeAmount: "100" },
        {
          ...accepted,
          chargedCumulativeAmount: "1",
          signedMaxClaimable: "1",
        },
      ),
    ).rejects.toThrow("persisted accepted attempt");
    await expect(ledger.loadOpenClaimAttempt(CHANNEL_ID)).resolves.toEqual(
      accepted,
    );
    await expect(ledger.loadChannel(CHANNEL_ID)).resolves.toEqual(
      changedChannel,
    );
  });
});

class FakeStorage implements GatewayStorage {
  #values = new Map<string, unknown>();
  readonly listRequests: Array<{
    prefix?: string;
    start?: string;
    end?: string;
    limit?: number;
  }> = [];

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return cloneOrUndefined(this.#values.get(key) as T | undefined);
  }

  async put<T = unknown>(key: string, value: T): Promise<void> {
    this.#values.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.#values.delete(key);
  }

  async list<T = unknown>(options: {
    prefix?: string;
    start?: string;
    end?: string;
    limit?: number;
  }): Promise<Map<string, T>> {
    this.listRequests.push({ ...options });
    const result = new Map<string, T>();
    const entries = Array.from(this.#values.entries()).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    for (const [key, value] of entries) {
      if (options.prefix && !key.startsWith(options.prefix)) continue;
      if (options.start && key < options.start) continue;
      if (options.end && key >= options.end) continue;
      result.set(key, structuredClone(value) as T);
      if (options.limit !== undefined && result.size >= options.limit) break;
    }
    return result;
  }

  async transaction<T>(
    closure: (txn: GatewayStorage) => Promise<T>,
  ): Promise<T> {
    const snapshot = structuredClone(Array.from(this.#values.entries()));
    try {
      return await closure(this);
    } catch (error) {
      this.#values = new Map(snapshot);
      throw error;
    }
  }
}

function channel(
  overrides: Partial<ServerChannelRecord> = {},
): ServerChannelRecord {
  return {
    channelId: CHANNEL_ID,
    covenantId: COVENANT_ID,
    genesisEvidence: {
      covenantId: COVENANT_ID,
      authorizingInput: { txid: FUNDING_TX, index: 1 },
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
    paymentPayloadHash: PAYLOAD,
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
    expected: {
      channelId: previous.channelId,
      covenantId: previous.covenantId,
      fundingAmount: previous.fundingAmount,
      chargedCumulativeAmount: previous.chargedCumulativeAmount,
      claimedCumulativeAmount: previous.claimedCumulativeAmount,
      signedMaxClaimable: previous.signedMaxClaimable,
      voucherSignature: previous.voucherSignature,
      activeOutpoint: previous.activeOutpoint,
      activeScriptPublicKey: previous.activeScriptPublicKey,
      status: previous.status,
    },
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
    expected: {
      channelId: previous.channelId,
      covenantId: previous.covenantId,
      fundingAmount: previous.fundingAmount,
      chargedCumulativeAmount: previous.chargedCumulativeAmount,
      claimedCumulativeAmount: previous.claimedCumulativeAmount,
      signedMaxClaimable: previous.signedMaxClaimable,
      voucherSignature: previous.voucherSignature,
      activeOutpoint: previous.activeOutpoint,
      activeScriptPublicKey: previous.activeScriptPublicKey,
      status: previous.status,
    },
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
    payToScriptPublicKey: KIP10_SCRIPT_PUBLIC_KEY,
    transaction: "signed-additive-transaction",
    requiredFinality: "accepted",
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
  return {
    attemptId: ATTEMPT,
    channelId: CHANNEL_ID,
    covenantId: COVENANT_ID,
    activeOutpoint: { txid: TX, index: 0 },
    activeScriptPublicKey: SCRIPT,
    fundingAmount: "1000",
    claimAmount: "100",
    chargedCumulativeAmount: "0",
    claimedCumulativeAmount: "0",
    signedMaxClaimable: "0",
    channelStatus: "active",
    transaction: "aa",
    transactionId: TX,
    requiredFinality: "accepted",
    status: "pending",
    ...overrides,
  };
}

function cloneOrUndefined<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}
