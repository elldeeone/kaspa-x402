import { describe, expect, it } from "vitest";
import type {
  BatchCommitmentRecord,
  ClaimAttemptRecord,
  ExactBorrowReservationRequest,
  ExactPaymentRecord,
  ExactReservationRecord,
  PaymentIdentifierRecord,
  ServerChannelRecord,
  SettlementCommit,
} from "@kaspa-x402/server";
import { buildKip10AdditiveRedeemScript, payToScriptHashScript, serializedScriptPublicKey } from "@kaspa-x402/covenant";
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
const KIP10_REDEEM_SCRIPT = buildKip10AdditiveRedeemScript({ ownerPublicKey: "aa".repeat(32), amount: "10000000" });
const KIP10_SCRIPT_PUBLIC_KEY = serializedScriptPublicKey(payToScriptHashScript(KIP10_REDEEM_SCRIPT));

describe("gateway durable ledger", () => {
  it("commits exact transaction ids once while allowing identical retries", async () => {
    const ledger = new GatewayLedger(new FakeStorage());
    const first = exactPayment({ paymentOutputIndex: 1 });

    await ledger.commitExactPayment({ payment: first });
    await ledger.commitExactPayment({ payment: first });

    await expect(ledger.loadExactPayment(TX)).resolves.toMatchObject({ transactionId: TX, paymentOutputIndex: 1 });
    await expect(ledger.commitExactPayment({ payment: exactPayment({ paymentOutputIndex: 2 }) })).rejects.toThrow("already committed");
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

  it("stores and consumes exact KIP-10 reservations idempotently", async () => {
    const ledger = new GatewayLedger(new FakeStorage());
    const first = exactReservation();
    await ledger.saveExactReservation(first);
    await ledger.saveExactReservation(first);
    await ledger.saveExactReservation(exactReservation({ reservedAt: "2026-07-07T00:01:00.000Z" }));

    await expect(ledger.loadExactReservation(TX)).resolves.toMatchObject({
      reservationId: TX,
      status: "reserved",
      borrowOutpoint: { txid: FUNDING_TX, index: 0 },
    });
    await expect(ledger.saveExactReservation(exactReservation({ borrowAmount: "200" }))).rejects.toThrow("different terms");
    await ledger.consumeExactReservation(TX, OTHER_TX);
    await ledger.consumeExactReservation(TX, OTHER_TX);
    await expect(ledger.loadExactReservation(TX)).resolves.toMatchObject({
      status: "consumed",
      transactionId: OTHER_TX,
    });
    await expect(ledger.consumeExactReservation(TX, "aa".repeat(32))).rejects.toThrow("different transaction");
    await expect(ledger.saveExactReservation(first)).rejects.toThrow("already consumed");
  });

  it("leases exact inventory and retires expired unpaid reservations", async () => {
    const ledger = new GatewayLedger(new FakeStorage());
    await expect(ledger.registerExactInventory(exactInventory({ additiveThresholdSompi: "1" }))).rejects.toThrow("additive threshold");
    await expect(
      ledger.registerExactInventory(
        exactInventory({ borrowRedeemScript: "51", borrowScriptPublicKey: serializedScriptPublicKey(payToScriptHashScript("51")) }),
      ),
    ).rejects.toThrow("canonical KIP-10 additive template");
    await expect(ledger.registerExactInventory(exactInventory({ borrowScriptPublicKey: SCRIPT }))).rejects.toThrow(
      "redeem script must match borrowScriptPublicKey",
    );
    await ledger.registerExactInventory(exactInventory());
    await ledger.registerExactInventory(exactInventory());

    await expect(ledger.exactInventoryStats("2026-07-07T00:00:00.000Z")).resolves.toMatchObject({
      total: 1,
      available: 1,
      reserved: 0,
    });

    const reservation = await ledger.reserveExactInventory(exactReservationRequest({ maxTimeoutSeconds: 1 }), "2026-07-07T00:00:00.000Z");
    expect(reservation).toMatchObject({
      templateId: "kaspa-x402-kip10-additive-v1",
      transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
      borrowOutpoint: { txid: FUNDING_TX, index: 0 },
      paymentOutputIndex: 0,
      expiresAt: "2026-07-07T00:00:01.000Z",
    });
    await expect(ledger.reserveExactInventory(exactReservationRequest(), "2026-07-07T00:00:00.500Z")).resolves.toBeUndefined();
    await expect(ledger.exactInventoryStats("2026-07-07T00:00:02.000Z")).resolves.toMatchObject({
      available: 0,
      reserved: 0,
      retired: 1,
      expiredRetired: 1,
    });
    await expect(ledger.reserveExactInventory(exactReservationRequest(), "2026-07-07T00:00:02.000Z")).resolves.toBeUndefined();
    await expect(ledger.listExactInventory()).resolves.toMatchObject([{ status: "retired", reservationId: reservation!.reservationId }]);
  });

  it("registers exact inventory batches atomically", async () => {
    const ledger = new GatewayLedger(new FakeStorage());

    await expect(
      ledger.registerExactInventoryBatch([
        exactInventory(),
        exactInventory({ borrowOutpoint: { txid: OTHER_TX, index: 0 }, additiveThresholdSompi: "1" }),
      ]),
    ).rejects.toThrow("additive threshold");
    await expect(ledger.exactInventoryStats()).resolves.toMatchObject({ total: 0, available: 0 });

    await expect(
      ledger.registerExactInventoryBatch([exactInventory(), exactInventory({ borrowOutpoint: { txid: OTHER_TX, index: 0 } })]),
    ).resolves.toHaveLength(2);
    await expect(ledger.exactInventoryStats()).resolves.toMatchObject({ total: 2, available: 2 });
  });

  it("marks leased exact inventory consumed with its settlement", async () => {
    const ledger = new GatewayLedger(new FakeStorage());
    await ledger.registerExactInventory(exactInventory());
    const reservation = await ledger.reserveExactInventory(exactReservationRequest(), "2026-07-07T00:00:00.000Z");
    expect(reservation).toBeDefined();

    await ledger.saveExactReservation({ ...reservation!, status: "reserved", reservedAt: "2026-07-07T00:00:00.000Z" });
    await ledger.consumeExactReservation(reservation!.reservationId, TX, {
      outpoint: { txid: TX, index: 0 },
      amount: "110000000",
      scriptPublicKey: reservation!.borrowScriptPublicKey,
    });

    await expect(ledger.listExactInventory()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          inventoryId: `${FUNDING_TX}:0`,
          status: "consumed",
          transactionId: TX,
        }),
        expect.objectContaining({
          inventoryId: `${TX}:0`,
          status: "available",
          borrowAmount: "110000000",
        }),
      ]),
    );
    await expect(ledger.exactInventoryStats("2026-07-07T00:00:01.000Z")).resolves.toMatchObject({
      available: 1,
      consumed: 1,
    });
  });

  it("applies batch settlement only when the channel snapshot still matches", async () => {
    const ledger = new GatewayLedger(new FakeStorage());
    await ledger.saveChannel(channel());
    await ledger.saveChannel({ ...channel(), chargedCumulativeAmount: "1" });

    const stale = settlementCommit(channel(), { chargedCumulativeAmount: "100" });
    await expect(ledger.commitSettlement(stale)).rejects.toThrow("channel state changed");
    await expect(ledger.loadCommitment(stale.commitment.commitmentId)).resolves.toBeUndefined();
  });

  it("serializes lock ownership with expiring leases", async () => {
    const ledger = new GatewayLedger(new FakeStorage());
    await expect(ledger.acquireLock(CHANNEL_ID, "first", 1_000, 1_000)).resolves.toBe(true);
    await expect(ledger.acquireLock(CHANNEL_ID, "second", 1_100, 1_000)).resolves.toBe(false);
    await expect(ledger.acquireLock(CHANNEL_ID, "second", 2_001, 1_000)).resolves.toBe(true);
    await ledger.releaseLock(CHANNEL_ID, "first");
    await expect(ledger.acquireLock(CHANNEL_ID, "third", 2_100, 1_000)).resolves.toBe(false);
    await ledger.releaseLock(CHANNEL_ID, "second");
    await expect(ledger.acquireLock(CHANNEL_ID, "third", 2_200, 1_000)).resolves.toBe(true);
  });

  it("rate limits by fixed windows", async () => {
    const ledger = new GatewayLedger(new FakeStorage());
    await expect(ledger.checkRateLimit("ip:exact", 1_000, 2, 60_000)).resolves.toMatchObject({ allowed: true, count: 1 });
    await expect(ledger.checkRateLimit("ip:exact", 1_100, 2, 60_000)).resolves.toMatchObject({ allowed: true, count: 2 });
    await expect(ledger.checkRateLimit("ip:exact", 1_200, 2, 60_000)).resolves.toMatchObject({ allowed: false, count: 3 });
    await expect(ledger.checkRateLimit("ip:exact", 60_001, 2, 60_000)).resolves.toMatchObject({ allowed: true, count: 1 });
  });

  it("persists the latest canary report", async () => {
    const ledger = new GatewayLedger(new FakeStorage());
    const report = {
      checkedAt: "2026-07-03T00:00:00.000Z",
      trigger: "scheduled" as const,
      ok: true,
      checks: [{ name: "exact-offer", status: "ok" as const, detail: "valid offer" }],
    };

    await ledger.saveCanaryReport(report);

    await expect(ledger.loadCanaryReport()).resolves.toEqual(report);
  });

  it("allows one open claim attempt per channel and applies by snapshot", async () => {
    const ledger = new GatewayLedger(new FakeStorage());
    await ledger.saveChannel(channel());
    const first = claimAttempt({ attemptId: ATTEMPT });
    await ledger.saveClaimAttempt(first);

    await expect(ledger.saveClaimAttempt(claimAttempt({ attemptId: OTHER_TX }))).rejects.toThrow("already pending");
    await ledger.saveChannel({ ...channel(), chargedCumulativeAmount: "1" });
    await expect(ledger.applyClaimAttempt({ ...channel(), claimedCumulativeAmount: "100" }, first)).rejects.toThrow("channel state changed");
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

  async list<T = unknown>(options: { prefix: string }): Promise<Map<string, T>> {
    const result = new Map<string, T>();
    for (const [key, value] of this.#values) {
      if (key.startsWith(options.prefix)) result.set(key, structuredClone(value) as T);
    }
    return result;
  }

  async transaction<T>(closure: (txn: GatewayStorage) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(Array.from(this.#values.entries()));
    try {
      return await closure(this);
    } catch (error) {
      this.#values = new Map(snapshot);
      throw error;
    }
  }
}

function channel(overrides: Partial<ServerChannelRecord> = {}): ServerChannelRecord {
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

function settlementCommit(previous: ServerChannelRecord, next: Partial<ServerChannelRecord>): SettlementCommit {
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
    settlement: { success: true, transaction: "15".repeat(32), network: "kaspa:testnet-10", amount: "100" },
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

function exactPayment(overrides: Partial<ExactPaymentRecord> = {}): ExactPaymentRecord {
  return {
    transactionId: TX,
    paymentOutputIndex: 0,
    requestFingerprint: REQUEST,
    paymentRequirementsHash: REQUIREMENTS,
    paymentPayloadHash: PAYLOAD,
    amount: "100",
    finality: "accepted",
    settlement: { success: true, transaction: TX, network: "kaspa:testnet-10", amount: "100" },
    response: { status: 200, headers: {}, body: "ok" },
    ...overrides,
  };
}

function exactReservation(overrides: Partial<ExactReservationRecord> = {}): ExactReservationRecord {
  return {
    reservationId: TX,
    templateId: "kaspa-x402-kip10-additive-v1",
    transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
    borrowOutpoint: { txid: FUNDING_TX, index: 0 },
    borrowAmount: "100000000",
    borrowScriptPublicKey: KIP10_SCRIPT_PUBLIC_KEY,
    borrowRedeemScript: KIP10_REDEEM_SCRIPT,
    additiveThresholdSompi: "10000000",
    paymentOutputIndex: 0,
    status: "reserved",
    reservedAt: "2026-07-07T00:00:00.000Z",
    ...overrides,
  };
}

function exactInventory(overrides: Partial<Parameters<GatewayLedger["registerExactInventory"]>[0]> = {}): Parameters<GatewayLedger["registerExactInventory"]>[0] {
  return {
    network: "kaspa:testnet-10",
    templateId: "kaspa-x402-kip10-additive-v1",
    transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
    borrowOutpoint: { txid: FUNDING_TX, index: 0 },
    borrowAmount: "100000000",
    borrowScriptPublicKey: KIP10_SCRIPT_PUBLIC_KEY,
    borrowRedeemScript: KIP10_REDEEM_SCRIPT,
    additiveThresholdSompi: "10000000",
    paymentOutputIndex: 0,
    ...overrides,
  };
}

function exactReservationRequest(overrides: Partial<ExactBorrowReservationRequest> = {}): ExactBorrowReservationRequest {
  return {
    network: "kaspa:testnet-10",
    amount: "20000000",
    payTo: "kaspatest:payout",
    payToScriptPublicKey: SCRIPT,
    maxTimeoutSeconds: 60,
    resource: { url: "https://demo.kaspa-x402.org/exact/report" },
    minimumAdditiveThresholdSompi: "10000000",
    ...overrides,
  };
}

function paymentIdentifier(overrides: Partial<PaymentIdentifierRecord> = {}): PaymentIdentifierRecord {
  return {
    id: "payment-id",
    fingerprint: REQUEST,
    paymentPayloadHash: PAYLOAD,
    paymentScopeId: TX,
    response: { status: 200, headers: {}, body: "ok" },
    settlement: { success: true, transaction: TX, network: "kaspa:testnet-10", amount: "100" },
    ...overrides,
  };
}

function claimAttempt(overrides: Partial<ClaimAttemptRecord> = {}): ClaimAttemptRecord {
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
