import { describe, expect, it } from "vitest";

import type { SettlementResponse } from "@kaspa-x402/core";
import {
  MemoryServerChannelStore,
  type BatchCommitmentRecord,
  type ClaimAttemptRecord,
  type ExactPaymentRecord,
  type ExactReservationRecord,
  type ExactSettlementCommit,
  type PaymentIdentifierRecord,
  type ServerChannelRecord,
  type ServerStateStore,
  type SettlementCommit,
  type ServerResponse,
} from "../src/index.js";

const CHANNEL_ID = "11".repeat(32);
const REQUEST = "22".repeat(32);
const REQUIREMENTS = "33".repeat(32);
const PAYLOAD = "44".repeat(32);
const TX = "55".repeat(32);
const OTHER_TX = "66".repeat(32);
const ATTEMPT = "77".repeat(32);
const FUNDING_TX = "88".repeat(32);
const SCRIPT = "0000" + "99".repeat(34);

type StoreFactory = {
  name: string;
  create: (channels?: readonly ServerChannelRecord[]) => Promise<ServerStateStore> | ServerStateStore;
};

const storeFactories: StoreFactory[] = [
  {
    name: "memory",
    create: (channels = []) => new MemoryServerChannelStore(channels),
  },
  {
    name: "durable mock",
    create: (channels = []) => DurableMockServerChannelStore.create(new DurableMockJournal(channels)),
  },
];

for (const factory of storeFactories) {
  describe(`server state store contract: ${factory.name}`, () => {
    defineStoreContract(factory);
  });
}

function defineStoreContract(factory: StoreFactory): void {
  it("consumes exact transaction ids once while allowing identical retries", async () => {
    const store = await factory.create();
    const first = exactPayment({ paymentOutputIndex: 1 });
    await store.commitExactPayment({ payment: first });
    await store.commitExactPayment({ payment: first });

    await expect(store.loadExactPayment(TX)).resolves.toMatchObject({
      transactionId: TX,
      paymentOutputIndex: 1,
    });
    if (store instanceof DurableMockServerChannelStore) {
      await expect((await store.restart()).loadExactPayment(TX)).resolves.toMatchObject({
        transactionId: TX,
        paymentOutputIndex: 1,
      });
    }
    await expect(store.commitExactPayment({ payment: exactPayment({ paymentOutputIndex: 2 }) })).rejects.toThrow(
      "already committed",
    );
  });

  it("rejects conflicting payment identifier commits atomically", async () => {
    const store = await factory.create();
    await store.commitExactPayment({
      payment: exactPayment({ transactionId: TX }),
      paymentIdentifier: paymentIdentifier({ paymentScopeId: TX }),
    });

    await expect(
      store.commitExactPayment({
        payment: exactPayment({ transactionId: OTHER_TX }),
        paymentIdentifier: paymentIdentifier({ paymentScopeId: OTHER_TX }),
      }),
    ).rejects.toThrow("payment identifier");
    await expect(store.loadExactPayment(OTHER_TX)).resolves.toBeUndefined();
  });

  it("stores and consumes exact KIP-10 reservations idempotently", async () => {
    const store = await factory.create();
    const first = exactReservation();
    await store.saveExactReservation(first);
    await store.saveExactReservation(first);
    await store.saveExactReservation(exactReservation({ reservedAt: "2026-07-07T00:01:00.000Z" }));

    await expect(store.loadExactReservation(TX)).resolves.toMatchObject({
      reservationId: TX,
      status: "reserved",
      borrowOutpoint: { txid: FUNDING_TX, index: 0 },
    });
    if (store instanceof DurableMockServerChannelStore) {
      await expect((await store.restart()).loadExactReservation(TX)).resolves.toMatchObject({
        reservationId: TX,
        status: "reserved",
      });
    }

    await expect(store.saveExactReservation(exactReservation({ borrowAmount: "200" }))).rejects.toThrow("different terms");
    await store.consumeExactReservation(TX, OTHER_TX);
    await store.consumeExactReservation(TX, OTHER_TX);
    await expect(store.loadExactReservation(TX)).resolves.toMatchObject({
      status: "consumed",
      transactionId: OTHER_TX,
    });
    await expect(store.consumeExactReservation(TX, "aa".repeat(32))).rejects.toThrow("different transaction");
    await expect(store.saveExactReservation(first)).rejects.toThrow("already consumed");
  });

  it("applies batch settlement only when the channel snapshot still matches", async () => {
    const store = await factory.create([channel()]);
    const staleCommit = settlementCommit(channel(), { chargedCumulativeAmount: "100" });
    await store.saveChannel({ ...channel(), chargedCumulativeAmount: "1" });

    await expect(store.commitSettlement(staleCommit)).rejects.toThrow("channel state changed");
    await expect(store.loadCommitment(staleCommit.commitment.commitmentId)).resolves.toBeUndefined();
  });

  it("rejects conflicting batch payment identifiers atomically", async () => {
    const store = await factory.create([channel()]);
    await store.commitExactPayment({
      payment: exactPayment({ transactionId: TX }),
      paymentIdentifier: paymentIdentifier({ paymentScopeId: TX }),
    });
    const conflicting = settlementCommit(channel(), { chargedCumulativeAmount: "100" });

    await expect(
      store.commitSettlement({
        ...conflicting,
        paymentIdentifier: paymentIdentifier({ paymentScopeId: CHANNEL_ID }),
      }),
    ).rejects.toThrow("payment identifier");
    await expect(store.loadCommitment(conflicting.commitment.commitmentId)).resolves.toBeUndefined();
    await expect(store.loadChannel(CHANNEL_ID)).resolves.toMatchObject({ chargedCumulativeAmount: "0" });
  });

  it("allows one open claim attempt per channel and applies by snapshot", async () => {
    const store = await factory.create([channel()]);
    const first = claimAttempt({ attemptId: ATTEMPT });
    await store.saveClaimAttempt(first);
    await expect(store.saveClaimAttempt(claimAttempt({ attemptId: OTHER_TX }))).rejects.toThrow("already pending");

    await store.saveChannel({ ...channel(), chargedCumulativeAmount: "1" });
    await expect(store.applyClaimAttempt({ ...channel(), claimedCumulativeAmount: "100" }, first)).rejects.toThrow("channel state changed");
  });
}

type DurableMockOperation =
  | { type: "saveChannel"; channel: ServerChannelRecord }
  | { type: "retireChannel"; channelId: string; reason?: string }
  | { type: "commitSettlement"; record: SettlementCommit }
  | { type: "commitExactPayment"; record: ExactSettlementCommit }
  | { type: "saveExactReservation"; record: ExactReservationRecord }
  | { type: "consumeExactReservation"; reservationId: string; transactionId: string }
  | { type: "saveClaimAttempt"; record: ClaimAttemptRecord }
  | { type: "applyClaimAttempt"; channel: ServerChannelRecord; attempt: ClaimAttemptRecord }
  | { type: "abandonClaimAttempt"; attemptId: string; reason?: string };

class DurableMockJournal {
  readonly channels: ServerChannelRecord[];
  readonly operations: DurableMockOperation[] = [];

  constructor(channels: readonly ServerChannelRecord[] = []) {
    this.channels = clone(channels);
  }
}

class DurableMockServerChannelStore extends MemoryServerChannelStore {
  readonly #journal: DurableMockJournal;
  #hydrating = false;

  private constructor(journal: DurableMockJournal) {
    super(journal.channels);
    this.#journal = journal;
  }

  static async create(journal: DurableMockJournal): Promise<DurableMockServerChannelStore> {
    const store = new DurableMockServerChannelStore(journal);
    store.#hydrating = true;
    try {
      for (const operation of journal.operations) await store.#apply(operation);
    } finally {
      store.#hydrating = false;
    }
    return store;
  }

  async restart(): Promise<DurableMockServerChannelStore> {
    return DurableMockServerChannelStore.create(this.#journal);
  }

  async saveChannel(channel: ServerChannelRecord): Promise<void> {
    await this.#write({ type: "saveChannel", channel }, () => super.saveChannel(channel));
  }

  async retireChannel(channelId: string, reason?: string): Promise<void> {
    await this.#write({ type: "retireChannel", channelId, reason }, () => super.retireChannel(channelId, reason));
  }

  async commitSettlement(record: SettlementCommit): Promise<void> {
    await this.#write({ type: "commitSettlement", record }, () => super.commitSettlement(record));
  }

  async commitExactPayment(record: ExactSettlementCommit): Promise<void> {
    await this.#write({ type: "commitExactPayment", record }, () => super.commitExactPayment(record));
  }

  async saveExactReservation(record: ExactReservationRecord): Promise<void> {
    await this.#write({ type: "saveExactReservation", record }, () => super.saveExactReservation(record));
  }

  async consumeExactReservation(reservationId: string, transactionId: string): Promise<void> {
    await this.#write({ type: "consumeExactReservation", reservationId, transactionId }, () =>
      super.consumeExactReservation(reservationId, transactionId),
    );
  }

  async saveClaimAttempt(record: ClaimAttemptRecord): Promise<void> {
    await this.#write({ type: "saveClaimAttempt", record }, () => super.saveClaimAttempt(record));
  }

  async applyClaimAttempt(channel: ServerChannelRecord, attempt: ClaimAttemptRecord): Promise<void> {
    await this.#write({ type: "applyClaimAttempt", channel, attempt }, () => super.applyClaimAttempt(channel, attempt));
  }

  async abandonClaimAttempt(attemptId: string, reason?: string): Promise<void> {
    await this.#write({ type: "abandonClaimAttempt", attemptId, reason }, () => super.abandonClaimAttempt(attemptId, reason));
  }

  async #write(operation: DurableMockOperation, fn: () => Promise<void>): Promise<void> {
    await fn();
    if (!this.#hydrating) this.#journal.operations.push(clone(operation));
  }

  async #apply(operation: DurableMockOperation): Promise<void> {
    switch (operation.type) {
      case "saveChannel":
        await super.saveChannel(operation.channel);
        return;
      case "retireChannel":
        await super.retireChannel(operation.channelId, operation.reason);
        return;
      case "commitSettlement":
        await super.commitSettlement(operation.record);
        return;
      case "commitExactPayment":
        await super.commitExactPayment(operation.record);
        return;
      case "saveExactReservation":
        await super.saveExactReservation(operation.record);
        return;
      case "consumeExactReservation":
        await super.consumeExactReservation(operation.reservationId, operation.transactionId);
        return;
      case "saveClaimAttempt":
        await super.saveClaimAttempt(operation.record);
        return;
      case "applyClaimAttempt":
        await super.applyClaimAttempt(operation.channel, operation.attempt);
        return;
      case "abandonClaimAttempt":
        await super.abandonClaimAttempt(operation.attemptId, operation.reason);
        return;
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

function exactReservation(overrides: Partial<ExactReservationRecord> = {}): ExactReservationRecord {
  return {
    reservationId: TX,
    templateId: "kaspa-x402-kip10-additive-v1",
    transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
    borrowOutpoint: { txid: FUNDING_TX, index: 0 },
    borrowAmount: "100",
    borrowScriptPublicKey: SCRIPT,
    borrowRedeemScript: "51",
    additiveThresholdSompi: "10000000",
    paymentOutputIndex: 0,
    status: "reserved",
    reservedAt: "2026-07-07T00:00:00.000Z",
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
    settlement: settlement(),
    response: response(),
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
    paymentOutputIndex: 1,
    requestFingerprint: REQUEST,
    paymentRequirementsHash: REQUIREMENTS,
    paymentPayloadHash: PAYLOAD,
    amount: "100",
    finality: "accepted",
    settlement: settlement(),
    response: response(),
    ...overrides,
  };
}

function claimAttempt(input: { attemptId: string }): ClaimAttemptRecord {
  const current = channel();
  return {
    attemptId: input.attemptId,
    channelId: current.channelId,
    activeOutpoint: current.activeOutpoint,
    activeScriptPublicKey: current.activeScriptPublicKey,
    fundingAmount: current.fundingAmount,
    claimAmount: "100",
    chargedCumulativeAmount: current.chargedCumulativeAmount,
    claimedCumulativeAmount: current.claimedCumulativeAmount,
    signedMaxClaimable: current.signedMaxClaimable,
    channelStatus: current.status,
    transaction: "ab".repeat(32),
    status: "pending",
  };
}

function paymentIdentifier(overrides: Partial<PaymentIdentifierRecord> = {}): PaymentIdentifierRecord {
  return {
    id: "pay_7d5d747be160e280504c099d984bcfe0",
    fingerprint: REQUEST,
    paymentPayloadHash: PAYLOAD,
    response: response(),
    settlement: settlement(),
    paymentScopeId: TX,
    ...overrides,
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

function clone<T>(value: T): T {
  return structuredClone(value);
}
