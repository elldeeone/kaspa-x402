import { describe, expect, it } from "vitest";
import type {
  BatchCommitmentRecord,
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
    const ledger = new GatewayLedger(new FakeStorage());
    await ledger.registerExactHead(exactHead());
    await ledger.registerExactHead(
      exactHead({
        headId: "91".repeat(32),
        currentOutpoint: { txid: "92".repeat(32), index: 0 },
      }),
    );

    for (let index = 0; index < 1_000; index += 1) {
      await expect(
        ledger.selectExactHead(
          exactHeadSelection(
            index % 2 === 0 ? "00".repeat(32) : "ff".repeat(32),
          ),
        ),
      ).resolves.toBeDefined();
    }

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
    const ledger = new GatewayLedger(new FakeStorage());
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
    await ledger.saveChannel({ ...channel(), chargedCumulativeAmount: "1" });
    await expect(
      ledger.applyClaimAttempt(
        { ...channel(), claimedCumulativeAmount: "100" },
        first,
      ),
    ).rejects.toThrow("channel state changed");
  });
});

class FakeStorage implements GatewayStorage {
  #values = new Map<string, unknown>();

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
    prefix: string;
  }): Promise<Map<string, T>> {
    const result = new Map<string, T>();
    for (const [key, value] of this.#values) {
      if (key.startsWith(options.prefix))
        result.set(key, structuredClone(value) as T);
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
    channelConfig: {
      network: "kaspa:testnet-10",
      asset: "KAS",
      templateId: "kaspa-x402-escrow-v1",
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
    requestFingerprint: REQUEST,
    paymentRequirementsHash: REQUIREMENTS,
    activeOutpoint: previous.activeOutpoint,
    activeScriptPublicKey: previous.activeScriptPublicKey,
    voucher: { amount: "100", signature: "16".repeat(64) },
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
    channel: updated,
    commitment,
    expected: {
      channelId: previous.channelId,
      chargedCumulativeAmount: previous.chargedCumulativeAmount,
      claimedCumulativeAmount: previous.claimedCumulativeAmount,
      signedMaxClaimable: previous.signedMaxClaimable,
      activeOutpoint: previous.activeOutpoint,
      activeScriptPublicKey: previous.activeScriptPublicKey,
      status: previous.status,
    },
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
    activeOutpoint: { txid: TX, index: 0 },
    activeScriptPublicKey: SCRIPT,
    fundingAmount: "1000",
    claimAmount: "100",
    chargedCumulativeAmount: "0",
    claimedCumulativeAmount: "0",
    signedMaxClaimable: "0",
    channelStatus: "active",
    transaction: "aa",
    status: "pending",
    ...overrides,
  };
}

function cloneOrUndefined<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}
