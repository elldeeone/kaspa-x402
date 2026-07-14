import { describe, expect, it } from "vitest";

import type { SettlementResponse } from "@kaspa-x402/core";
import {
  buildKip10AdditiveRedeemScript,
  payToScriptHashScript,
  serializedScriptPublicKey,
} from "@kaspa-x402/covenant";
import {
  MemoryServerChannelStore,
  exactHeadManifest,
  type BatchCommitmentRecord,
  type ClaimAttemptRecord,
  type ExactPaymentRecord,
  type ExactSettlementCommit,
  type ExactHeadRecord,
  type ExactHeadLineageApply,
  type ExactSettlementAttemptRecord,
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
const HEAD_ID = "90".repeat(32);
const HEAD_REDEEM_SCRIPT = buildKip10AdditiveRedeemScript({
  ownerPublicKey: "91".repeat(32),
  amount: "10000000",
});
const HEAD_SCRIPT_PUBLIC_KEY = serializedScriptPublicKey(
  payToScriptHashScript(HEAD_REDEEM_SCRIPT),
);

type StoreFactory = {
  name: string;
  create: (
    channels?: readonly ServerChannelRecord[],
  ) => Promise<ServerStateStore> | ServerStateStore;
};

const storeFactories: StoreFactory[] = [
  {
    name: "memory",
    create: (channels = []) => new MemoryServerChannelStore(channels),
  },
  {
    name: "durable mock",
    create: (channels = []) =>
      DurableMockServerChannelStore.create(new DurableMockJournal(channels)),
  },
];

for (const factory of storeFactories) {
  describe(`server state store contract: ${factory.name}`, () => {
    defineStoreContract(factory);
  });
}

describe("exact head manifest", () => {
  it("exports an independently auditable public lineage without custody material", () => {
    const manifest = exactHeadManifest(exactHead());
    expect(manifest).toMatchObject({
      format: "kaspa-x402-exact-head-manifest-v1",
      headId: HEAD_ID,
      ownerPublicKey: "91".repeat(32),
      additiveThresholdSompi: "10000000",
      currentOutpoint: { txid: FUNDING_TX, index: 0 },
      currentAmount: "100000000",
      version: "0",
    });
    expect(JSON.stringify(manifest)).not.toContain("private");
  });
});

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
      await expect(
        (await store.restart()).loadExactPayment(TX),
      ).resolves.toMatchObject({
        transactionId: TX,
        paymentOutputIndex: 1,
      });
    }
    await expect(
      store.commitExactPayment({
        payment: exactPayment({ paymentOutputIndex: 2 }),
      }),
    ).rejects.toThrow("already committed");
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

  it("selects reusable additive heads without consuming unanswered challenges", async () => {
    const store = await factory.create();
    await store.registerExactHead(exactHead());
    await store.registerExactHead(
      exactHead({
        headId: "92".repeat(32),
        currentOutpoint: { txid: "93".repeat(32), index: 0 },
      }),
    );

    for (let index = 0; index < 1_000; index += 1) {
      await expect(
        store.selectExactHead(
          exactHeadSelection(
            index % 2 === 0 ? "00".repeat(32) : "ff".repeat(32),
          ),
        ),
      ).resolves.toBeDefined();
    }
    await expect(store.listExactHeads()).resolves.toEqual([
      expect.objectContaining({
        headId: HEAD_ID,
        status: "available",
        version: "0",
      }),
      expect.objectContaining({
        headId: "92".repeat(32),
        status: "available",
        version: "0",
      }),
    ]);
  });

  it("applies external head lineage atomically and persists it across restart", async () => {
    let store = await factory.create();
    await store.registerExactHead(exactHead());
    const input: ExactHeadLineageApply = {
      headId: HEAD_ID,
      expectedVersion: "0",
      expectedOutpoint: { txid: FUNDING_TX, index: 0 },
      expectedAmount: "100000000",
      steps: [
        {
          transactionId: TX,
          spentOutpoint: { txid: FUNDING_TX, index: 0 },
          successor: {
            outpoint: { txid: TX, index: 0 },
            amount: "110000000",
            scriptPublicKey: HEAD_SCRIPT_PUBLIC_KEY,
          },
          finality: "accepted",
        },
        {
          transactionId: OTHER_TX,
          spentOutpoint: { txid: TX, index: 0 },
          successor: {
            outpoint: { txid: OTHER_TX, index: 0 },
            amount: "125000000",
            scriptPublicKey: HEAD_SCRIPT_PUBLIC_KEY,
          },
          finality: "confirmed",
        },
      ],
      observedAt: "2026-07-07T00:00:03.000Z",
    };

    await expect(store.applyExactHeadLineage(input)).resolves.toMatchObject({
      version: "2",
      currentOutpoint: { txid: OTHER_TX, index: 0 },
      currentAmount: "125000000",
      lastTransactionId: OTHER_TX,
      status: "available",
    });
    await expect(store.applyExactHeadLineage(input)).rejects.toThrow(
      "head changed",
    );

    if (store instanceof DurableMockServerChannelStore) {
      store = await store.restart();
      await expect(store.loadExactHead(HEAD_ID)).resolves.toMatchObject({
        version: "2",
        currentOutpoint: { txid: OTHER_TX, index: 0 },
        currentAmount: "125000000",
      });
    }
  });

  it("claims one additive head winner, advances by compare-and-swap, and prevents handler replay", async () => {
    let store = await factory.create();
    await store.registerExactHead(exactHead());
    const attempt = exactSettlementAttempt();

    await expect(store.claimExactSettlement(attempt)).resolves.toMatchObject({
      created: true,
    });
    await expect(
      store.claimExactSettlement({
        ...attempt,
        createdAt: "2026-07-07T00:00:01.000Z",
      }),
    ).resolves.toMatchObject({
      created: false,
    });
    await expect(
      store.claimExactSettlement(
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
      store.selectExactHead(exactHeadSelection()),
    ).resolves.toBeUndefined();

    await store.recordExactSettlementBroadcast(
      TX,
      "broadcast",
      "2026-07-07T00:00:02.000Z",
    );
    await store.acceptExactSettlement(
      TX,
      "accepted",
      "2026-07-07T00:00:03.000Z",
    );
    await expect(store.loadExactHead(HEAD_ID)).resolves.toMatchObject({
      status: "available",
      version: "1",
      currentOutpoint: { txid: TX, index: 0 },
      currentAmount: "120000000",
      lastTransactionId: TX,
    });
    await expect(
      store.beginExactHandler(TX, "2026-07-07T00:00:04.000Z"),
    ).resolves.toBe(true);
    await expect(
      store.beginExactHandler(TX, "2026-07-07T00:00:05.000Z"),
    ).resolves.toBe(false);
    await store.commitExactPayment({
      payment: exactPayment({ transactionId: TX, paymentOutputIndex: 0 }),
    });
    await expect(store.loadExactSettlementAttempt(TX)).resolves.toMatchObject({
      status: "applied",
      handlerStartedAt: "2026-07-07T00:00:04.000Z",
    });

    if (store instanceof DurableMockServerChannelStore) {
      store = await store.restart();
      await expect(store.loadExactHead(HEAD_ID)).resolves.toMatchObject({
        version: "1",
        currentOutpoint: { txid: TX, index: 0 },
      });
      await expect(store.loadExactSettlementAttempt(TX)).resolves.toMatchObject(
        { status: "applied" },
      );
    }
  });

  it("releases only unaccepted attempts and can fail a head closed", async () => {
    const store = await factory.create();
    await store.registerExactHead(exactHead());
    await store.claimExactSettlement(exactSettlementAttempt());
    await store.abandonExactSettlement(
      TX,
      "trusted node rejected transaction",
      "2026-07-07T00:00:02.000Z",
    );
    await expect(store.loadExactSettlementAttempt(TX)).resolves.toBeUndefined();
    await expect(store.loadExactHead(HEAD_ID)).resolves.toMatchObject({
      status: "available",
      claimTransactionId: undefined,
    });

    await store.markExactHeadUnavailable(
      HEAD_ID,
      "successor lineage unavailable",
      "2026-07-07T00:00:03.000Z",
    );
    await expect(store.loadExactHead(HEAD_ID)).resolves.toMatchObject({
      status: "unavailable",
      unavailableReason: "successor lineage unavailable",
    });
    await expect(
      store.selectExactHead(exactHeadSelection()),
    ).resolves.toBeUndefined();
  });

  it("applies batch settlement only when the channel snapshot still matches", async () => {
    const store = await factory.create([channel()]);
    const staleCommit = settlementCommit(channel(), {
      chargedCumulativeAmount: "100",
    });
    await store.saveChannel({ ...channel(), chargedCumulativeAmount: "1" });

    await expect(store.commitSettlement(staleCommit)).rejects.toThrow(
      "channel state changed",
    );
    await expect(
      store.loadCommitment(staleCommit.commitment.commitmentId),
    ).resolves.toBeUndefined();
  });

  it("rejects conflicting batch payment identifiers atomically", async () => {
    const store = await factory.create([channel()]);
    await store.commitExactPayment({
      payment: exactPayment({ transactionId: TX }),
      paymentIdentifier: paymentIdentifier({ paymentScopeId: TX }),
    });
    const conflicting = settlementCommit(channel(), {
      chargedCumulativeAmount: "100",
    });

    await expect(
      store.commitSettlement({
        ...conflicting,
        paymentIdentifier: paymentIdentifier({ paymentScopeId: CHANNEL_ID }),
      }),
    ).rejects.toThrow("payment identifier");
    await expect(
      store.loadCommitment(conflicting.commitment.commitmentId),
    ).resolves.toBeUndefined();
    await expect(store.loadChannel(CHANNEL_ID)).resolves.toMatchObject({
      chargedCumulativeAmount: "0",
    });
  });

  it("allows one open claim attempt per channel and applies by snapshot", async () => {
    const store = await factory.create([channel()]);
    const first = claimAttempt({ attemptId: ATTEMPT });
    await store.saveClaimAttempt(first);
    await expect(
      store.saveClaimAttempt(claimAttempt({ attemptId: OTHER_TX })),
    ).rejects.toThrow("already pending");

    await store.saveChannel({ ...channel(), chargedCumulativeAmount: "1" });
    await expect(
      store.applyClaimAttempt(
        { ...channel(), claimedCumulativeAmount: "100" },
        first,
      ),
    ).rejects.toThrow("channel state changed");
  });
}

type DurableMockOperation =
  | { type: "saveChannel"; channel: ServerChannelRecord }
  | { type: "retireChannel"; channelId: string; reason?: string }
  | { type: "commitSettlement"; record: SettlementCommit }
  | { type: "commitExactPayment"; record: ExactSettlementCommit }
  | { type: "registerExactHead"; record: ExactHeadRecord }
  | { type: "claimExactSettlement"; record: ExactSettlementAttemptRecord }
  | {
      type: "recordExactSettlementBroadcast";
      transactionId: string;
      finality: "broadcast" | "accepted" | "confirmed";
      observedAt: string;
    }
  | {
      type: "acceptExactSettlement";
      transactionId: string;
      finality: "accepted" | "confirmed";
      observedAt: string;
    }
  | { type: "beginExactHandler"; transactionId: string; startedAt: string }
  | {
      type: "abandonExactSettlement";
      transactionId: string;
      reason: string;
      observedAt: string;
    }
  | {
      type: "markExactHeadUnavailable";
      headId: string;
      reason: string;
      observedAt: string;
    }
  | { type: "applyExactHeadLineage"; input: ExactHeadLineageApply }
  | { type: "saveClaimAttempt"; record: ClaimAttemptRecord }
  | {
      type: "applyClaimAttempt";
      channel: ServerChannelRecord;
      attempt: ClaimAttemptRecord;
    }
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

  static async create(
    journal: DurableMockJournal,
  ): Promise<DurableMockServerChannelStore> {
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
    await this.#write({ type: "saveChannel", channel }, () =>
      super.saveChannel(channel),
    );
  }

  async retireChannel(channelId: string, reason?: string): Promise<void> {
    await this.#write({ type: "retireChannel", channelId, reason }, () =>
      super.retireChannel(channelId, reason),
    );
  }

  async commitSettlement(record: SettlementCommit): Promise<void> {
    await this.#write({ type: "commitSettlement", record }, () =>
      super.commitSettlement(record),
    );
  }

  async commitExactPayment(record: ExactSettlementCommit): Promise<void> {
    await this.#write({ type: "commitExactPayment", record }, () =>
      super.commitExactPayment(record),
    );
  }

  async registerExactHead(record: ExactHeadRecord): Promise<ExactHeadRecord> {
    const registered = await super.registerExactHead(record);
    if (!this.#hydrating)
      this.#journal.operations.push(
        clone({ type: "registerExactHead", record }),
      );
    return registered;
  }

  async claimExactSettlement(record: ExactSettlementAttemptRecord) {
    const result = await super.claimExactSettlement(record);
    if (!this.#hydrating && result.created)
      this.#journal.operations.push(
        clone({ type: "claimExactSettlement", record }),
      );
    return result;
  }

  async recordExactSettlementBroadcast(
    transactionId: string,
    finality: "broadcast" | "accepted" | "confirmed",
    observedAt: string,
  ): Promise<void> {
    await this.#write(
      {
        type: "recordExactSettlementBroadcast",
        transactionId,
        finality,
        observedAt,
      },
      () =>
        super.recordExactSettlementBroadcast(
          transactionId,
          finality,
          observedAt,
        ),
    );
  }

  async acceptExactSettlement(
    transactionId: string,
    finality: "accepted" | "confirmed",
    observedAt: string,
  ): Promise<void> {
    await this.#write(
      { type: "acceptExactSettlement", transactionId, finality, observedAt },
      () => super.acceptExactSettlement(transactionId, finality, observedAt),
    );
  }

  async beginExactHandler(
    transactionId: string,
    startedAt: string,
  ): Promise<boolean> {
    const started = await super.beginExactHandler(transactionId, startedAt);
    if (!this.#hydrating && started)
      this.#journal.operations.push(
        clone({ type: "beginExactHandler", transactionId, startedAt }),
      );
    return started;
  }

  async abandonExactSettlement(
    transactionId: string,
    reason: string,
    observedAt: string,
  ): Promise<void> {
    await this.#write(
      { type: "abandonExactSettlement", transactionId, reason, observedAt },
      () => super.abandonExactSettlement(transactionId, reason, observedAt),
    );
  }

  async markExactHeadUnavailable(
    headId: string,
    reason: string,
    observedAt: string,
  ): Promise<void> {
    await this.#write(
      { type: "markExactHeadUnavailable", headId, reason, observedAt },
      () => super.markExactHeadUnavailable(headId, reason, observedAt),
    );
  }

  async applyExactHeadLineage(
    input: ExactHeadLineageApply,
  ): Promise<ExactHeadRecord> {
    const advanced = await super.applyExactHeadLineage(input);
    if (!this.#hydrating)
      this.#journal.operations.push(
        clone({ type: "applyExactHeadLineage", input }),
      );
    return advanced;
  }

  async saveClaimAttempt(record: ClaimAttemptRecord): Promise<void> {
    await this.#write({ type: "saveClaimAttempt", record }, () =>
      super.saveClaimAttempt(record),
    );
  }

  async applyClaimAttempt(
    channel: ServerChannelRecord,
    attempt: ClaimAttemptRecord,
  ): Promise<void> {
    await this.#write({ type: "applyClaimAttempt", channel, attempt }, () =>
      super.applyClaimAttempt(channel, attempt),
    );
  }

  async abandonClaimAttempt(attemptId: string, reason?: string): Promise<void> {
    await this.#write({ type: "abandonClaimAttempt", attemptId, reason }, () =>
      super.abandonClaimAttempt(attemptId, reason),
    );
  }

  async #write(
    operation: DurableMockOperation,
    fn: () => Promise<void>,
  ): Promise<void> {
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
      case "registerExactHead":
        await super.registerExactHead(operation.record);
        return;
      case "claimExactSettlement":
        await super.claimExactSettlement(operation.record);
        return;
      case "recordExactSettlementBroadcast":
        await super.recordExactSettlementBroadcast(
          operation.transactionId,
          operation.finality,
          operation.observedAt,
        );
        return;
      case "acceptExactSettlement":
        await super.acceptExactSettlement(
          operation.transactionId,
          operation.finality,
          operation.observedAt,
        );
        return;
      case "beginExactHandler":
        await super.beginExactHandler(
          operation.transactionId,
          operation.startedAt,
        );
        return;
      case "abandonExactSettlement":
        await super.abandonExactSettlement(
          operation.transactionId,
          operation.reason,
          operation.observedAt,
        );
        return;
      case "markExactHeadUnavailable":
        await super.markExactHeadUnavailable(
          operation.headId,
          operation.reason,
          operation.observedAt,
        );
        return;
      case "applyExactHeadLineage":
        await super.applyExactHeadLineage(operation.input);
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

function exactPayment(
  overrides: Partial<ExactPaymentRecord> = {},
): ExactPaymentRecord {
  return {
    profile: "additive",
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

function exactHead(overrides: Partial<ExactHeadRecord> = {}): ExactHeadRecord {
  return {
    headId: HEAD_ID,
    network: "kaspa:testnet-10",
    payTo: "kaspatest:head",
    templateId: "kaspa-x402-kip10-additive-v1",
    transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
    currentOutpoint: { txid: FUNDING_TX, index: 0 },
    currentAmount: "100000000",
    scriptPublicKey: HEAD_SCRIPT_PUBLIC_KEY,
    redeemScript: HEAD_REDEEM_SCRIPT,
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
    payToScriptPublicKey: HEAD_SCRIPT_PUBLIC_KEY,
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
    payToScriptPublicKey: HEAD_SCRIPT_PUBLIC_KEY,
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
        scriptPublicKey: HEAD_SCRIPT_PUBLIC_KEY,
      },
    },
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

function paymentIdentifier(
  overrides: Partial<PaymentIdentifierRecord> = {},
): PaymentIdentifierRecord {
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
