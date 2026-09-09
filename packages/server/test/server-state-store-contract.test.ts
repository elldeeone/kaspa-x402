import { describe, expect, it } from "vitest";

import {
  applyCovenantSelectedChainUpdate,
  createCovenantLineageState,
  type AcceptedTransactionEvidence,
  type SettlementResponse,
} from "@kaspa-x402/core";
import {
  ESCROW_V4_LAUNCH_IDENTITY,
  buildKip10AdditiveRedeemScript,
  payToScriptHashScript,
  serializedScriptPublicKey,
} from "@kaspa-x402/covenant";
import {
  MemoryServerChannelStore,
  exactHeadManifest,
  type BatchCommitmentRecord,
  type BatchSettlementAttemptRecord,
  type ClaimAttemptRecord,
  type ChannelOperationLeaseRecord,
  type ExactPaymentRecord,
  type ExactSettlementCommit,
  type ExactHeadRecord,
  type ExactHeadLineageApply,
  type ExactHeadUnavailableApply,
  type ExactHeadUnavailableResult,
  type ExactSettlementAttemptRecord,
  type PaymentIdentifierRecord,
  type PaymentIdentifierReservationClaim,
  type ProtectedHandlerResult,
  type ServerChannelRecord,
  type ServerStateStore,
  type SettlementCommit,
  type ServerResponse,
} from "../src/index.js";

const CHANNEL_ID = "11".repeat(32);
const COVENANT_ID = "1a".repeat(32);
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

describe("durable crash checkpoints", () => {
  it("survives restart after exact reservation, broadcast, handler, and commit writes", async () => {
    let store = await DurableMockServerChannelStore.create(
      new DurableMockJournal(),
    );
    const claim = exactIdentifierClaim(TX, TX);
    await store.claimExactSettlement(
      exactSettlementAttempt({
        profile: "standard-native",
        head: undefined,
        paymentIdentifier: claim,
      }),
    );
    store = await store.restart();
    await expect(store.loadExactSettlementAttempt(TX)).resolves.toMatchObject({
      status: "pending",
    });
    await expect(
      store.loadPaymentIdentifierReservation(claim.id),
    ).resolves.toMatchObject({ status: "reserved" });

    await store.recordExactSettlementBroadcast(
      TX,
      "broadcast",
      "2026-07-07T00:00:01.000Z",
    );
    store = await store.restart();
    await expect(store.loadExactSettlementAttempt(TX)).resolves.toMatchObject({
      status: "broadcast",
    });
    await expect(
      store.loadPaymentIdentifierReservation(claim.id),
    ).resolves.toMatchObject({ status: "pending" });

    await store.acceptExactSettlement(
      TX,
      "accepted",
      "2026-07-07T00:00:02.000Z",
    );
    await store.beginExactHandler(TX, "2026-07-07T00:00:03.000Z");
    store = await store.restart();
    await expect(store.loadExactSettlementAttempt(TX)).resolves.toMatchObject({
      status: "accepted",
      handlerStartedAt: "2026-07-07T00:00:03.000Z",
    });

    await store.recordExactHandlerResult(
      TX,
      { body: "durable", chargedAmount: "20000000" },
      "2026-07-07T00:00:04.000Z",
    );
    store = await store.restart();
    await expect(store.loadExactSettlementAttempt(TX)).resolves.toMatchObject({
      handlerResult: { body: "durable", chargedAmount: "20000000" },
    });

    await store.commitExactPayment({
      payment: exactPayment({
        profile: "standard-native",
        amount: "20000000",
        paymentOutputIndex: 0,
      }),
      paymentIdentifier: {
        id: claim.id,
        fingerprint: claim.fingerprint,
        paymentPayloadHash: claim.paymentPayloadHash,
        response: response(),
        settlement: settlement(),
        paymentScopeId: claim.paymentScopeId,
        transactionId: TX,
        paymentOutputIndex: 0,
      },
    });
    store = await store.restart();
    await expect(store.loadExactPayment(TX)).resolves.toBeDefined();
    await expect(store.loadExactSettlementAttempt(TX)).resolves.toMatchObject({
      status: "applied",
    });
    await expect(store.loadExactSettlementAttempt(TX)).resolves.not.toHaveProperty(
      "handlerResult",
    );
    await expect(
      store.loadPaymentIdentifierReservation(claim.id),
    ).resolves.toMatchObject({ status: "completed" });
  });
});

describe("memory durable-state limits", () => {
  for (const candidateKind of ["exact", "batch"] as const) {
    it(`preserves safely released identifiers when ${candidateKind} replacement admission fails`, async () => {
      const current = channel();
      const store = new MemoryServerChannelStore([current], {
        limits: {
          maxRecords: 10,
          maxBytes: 4 * 1024 * 1024,
          maxRecordsPerPayer: 1,
        },
      });
      const releasedOwner = "aa".repeat(32);
      const blockerId = "bb".repeat(32);
      const candidateId = "cc".repeat(32);
      const releasedClaim = {
        ...exactIdentifierClaim(releasedOwner, releasedOwner),
        payerId: "payer:a",
      };
      await store.claimExactSettlement(
        exactSettlementAttempt({
          transactionId: releasedOwner,
          profile: "standard-native",
          head: undefined,
          payerId: "payer:a",
          paymentIdentifier: releasedClaim,
        }),
      );
      await store.abandonExactSettlement(
        releasedOwner,
        "trusted pre-effect rejection",
        "2026-07-07T00:00:01.000Z",
      );
      await store.claimExactSettlement(
        exactSettlementAttempt({
          transactionId: blockerId,
          profile: "standard-native",
          head: undefined,
          payerId: "payer:b",
        }),
      );

      const reservationBefore = await store.loadPaymentIdentifierReservation(
        releasedClaim.id,
      );
      const statsBefore = store.durableStateStats();
      const candidate =
        candidateKind === "exact"
          ? exactSettlementAttempt({
              transactionId: candidateId,
              profile: "standard-native",
              head: undefined,
              payerId: "payer:b",
              paymentIdentifier: {
                ...exactIdentifierClaim(candidateId, candidateId),
                id: releasedClaim.id,
                payerId: "payer:b",
              },
            })
          : batchSettlementAttempt(current, {
              attemptId: candidateId,
              payerId: "payer:b",
              paymentIdentifier: {
                ...batchIdentifierClaim(candidateId, current.channelId),
                id: releasedClaim.id,
                payerId: "payer:b",
              },
            });
      const claimCandidate = () =>
        candidateKind === "exact"
          ? store.claimExactSettlement(
              candidate as ExactSettlementAttemptRecord,
            )
          : store.claimBatchSettlement(
              candidate as BatchSettlementAttemptRecord,
            );

      await expect(claimCandidate()).rejects.toThrow("per-payer limit exceeded");
      await expect(
        store.loadPaymentIdentifierReservation(releasedClaim.id),
      ).resolves.toEqual(reservationBefore);
      expect(store.durableStateStats()).toEqual(statsBefore);
      if (candidateKind === "exact") {
        await expect(
          store.loadExactSettlementAttempt(candidateId),
        ).resolves.toBeUndefined();
      } else {
        await expect(
          store.loadBatchSettlementAttempt(candidateId),
        ).resolves.toBeUndefined();
        await expect(
          store.loadChannelOperation(current.channelId),
        ).resolves.toBeUndefined();
      }

      await store.abandonExactSettlement(
        blockerId,
        "trusted pre-effect rejection",
        "2026-07-07T00:00:02.000Z",
      );
      await expect(claimCandidate()).resolves.toMatchObject({ created: true });
    });
  }

  it("replaces a safely released record when its durable key is reused", async () => {
    const store = new MemoryServerChannelStore([], {
      limits: { maxRecords: 1, maxRecordsPerPayer: 1 },
    });
    const claim = exactIdentifierClaim(TX, TX);
    const attempt = exactSettlementAttempt({
      profile: "standard-native",
      head: undefined,
      paymentIdentifier: claim,
    });
    await store.claimExactSettlement(attempt);
    await store.abandonExactSettlement(
      TX,
      "trusted pre-effect rejection",
      "2026-07-07T00:00:01.000Z",
    );

    await expect(store.claimExactSettlement(attempt)).resolves.toMatchObject({
      created: true,
    });
    await expect(
      store.loadPaymentIdentifierReservation(claim.id),
    ).resolves.toMatchObject({ status: "reserved", ownerId: TX });
    expect(store.durableStateStats()).toMatchObject({
      records: 1,
      openRecords: 1,
      payerRecords: { "payer:test": 1 },
    });
  });

  it("retains two thousand compact terminal batch attempts within hard limits", async () => {
    const base = channel();
    const initial = channel({
      fundingAmount: "1000000",
      genesisEvidence: { ...base.genesisEvidence, genesisAmount: "1000000" },
    });
    const store = new MemoryServerChannelStore([initial], {
      limits: { maxRecords: 2_000, maxRecordsPerPayer: 2_001 },
    });
    let current = initial;

    for (let index = 0; index < 2_000; index += 1) {
      const attemptId = (index + 1).toString(16).padStart(64, "0");
      const requestFingerprint = (10_000 + index)
        .toString(16)
        .padStart(64, "0");
      const payloadHash = (20_000 + index)
        .toString(16)
        .padStart(64, "0");
      const commitmentId = (30_000 + index)
        .toString(16)
        .padStart(64, "0");
      const nextCharge = (BigInt(current.chargedCumulativeAmount) + 1n).toString();
      const attempt = batchSettlementAttempt(current, {
        attemptId,
        requestFingerprint,
        paymentPayloadHash: payloadHash,
        maximumCharge: "1",
      });
      await store.claimBatchSettlement(attempt);
      await store.beginBatchHandler(
        attemptId,
        "2026-07-07T00:00:01.000Z",
      );
      await store.recordBatchHandlerResult(
        attemptId,
        { chargedAmount: "1" },
        "2026-07-07T00:00:02.000Z",
      );
      const next: ServerChannelRecord = {
        ...current,
        version: (BigInt(current.version) + 1n).toString(),
        chargedCumulativeAmount: nextCharge,
        signedMaxClaimable: nextCharge,
        voucherSignature: "16".repeat(64),
        lastCommitmentId: commitmentId,
      };
      await store.commitSettlement({
        batchAttemptId: attemptId,
        expected: current,
        channel: next,
        commitment: {
          commitmentId,
          channelId: current.channelId,
          covenantId: current.covenantId,
          requestFingerprint,
          paymentRequirementsHash: REQUIREMENTS,
          paymentPayloadHash: payloadHash,
          activeOutpoint: current.activeOutpoint,
          activeScriptPublicKey: current.activeScriptPublicKey,
          voucher: {
            covenantId: current.covenantId,
            amount: nextCharge,
            signature: "16".repeat(64),
          },
          chargedAmount: "1",
          chargedCumulativeBefore: current.chargedCumulativeAmount,
          chargedCumulativeAfter: nextCharge,
          claimedCumulativeAmount: current.claimedCumulativeAmount,
          settlement: settlement(),
          response: response(),
        },
      });
      current = next;
    }

    expect(store.durableStateStats()).toMatchObject({
      records: 2_000,
      openRecords: 0,
    });
    await expect(store.loadBatchSettlementAttempt("1".padStart(64, "0")))
      .resolves.toMatchObject({ status: "applied" });
    await expect(
      store.claimBatchSettlement(
        batchSettlementAttempt(current, {
          attemptId: "7fff".padStart(64, "0"),
          requestFingerprint: "7ffe".padStart(64, "0"),
          paymentPayloadHash: "7ffd".padStart(64, "0"),
          maximumCharge: "1",
        }),
      ),
    ).rejects.toThrow("record limit exceeded");
  });

  it("reserves the complete duplicated terminal response bundle", async () => {
    const store = new MemoryServerChannelStore([], {
      limits: { maxBytes: 300_000 },
    });

    await expect(
      store.claimExactSettlement(
        exactSettlementAttempt({ profile: "standard-native", head: undefined }),
      ),
    ).rejects.toThrow("byte limit exceeded");
    expect(store.durableStateStats()).toMatchObject({ records: 0, bytes: 0 });
  });

  it("accounts for safely released identifier records until bounded expiry", async () => {
    let now = 0;
    const store = new MemoryServerChannelStore([], {
      limits: {
        maxRecords: 1,
        maxBytes: 1024 * 1024,
        maxRecordsPerPayer: 1,
        terminalRetentionMs: 100,
      },
      now: () => now,
    });
    const firstIdentifier = exactIdentifierClaim(TX, TX);
    await store.claimExactSettlement(
      exactSettlementAttempt({
        profile: "standard-native",
        head: undefined,
        paymentIdentifier: firstIdentifier,
      }),
    );
    await store.abandonExactSettlement(
      TX,
      "trusted pre-effect rejection",
      "2026-07-07T00:00:01.000Z",
    );

    for (let index = 1; index < 5; index += 1) {
      const transactionId = (100 + index).toString(16).padStart(64, "0");
      await store.claimExactSettlement(
        exactSettlementAttempt({
          transactionId,
          profile: "standard-native",
          head: undefined,
          paymentIdentifier: exactIdentifierClaim(transactionId, transactionId),
        }),
      );
      await store.abandonExactSettlement(
        transactionId,
        "trusted pre-effect rejection",
        "2026-07-07T00:00:01.000Z",
      );
    }

    expect(store.durableStateStats()).toMatchObject({
      records: 1,
      openRecords: 0,
    });
    expect(store.durableStateStats().bytes).toBeGreaterThan(0);
    const next = exactSettlementAttempt({
      transactionId: OTHER_TX,
      profile: "standard-native",
      head: undefined,
      paymentIdentifier: {
        ...exactIdentifierClaim(OTHER_TX, OTHER_TX),
        id: "pay_8d5d747be160e280504c099d984bcfe1",
      },
    });
    await expect(store.claimExactSettlement(next)).rejects.toThrow(
      "record limit exceeded",
    );

    now = 101;
    await expect(store.claimExactSettlement(next)).resolves.toMatchObject({
      created: true,
    });
    await expect(
      store.loadPaymentIdentifierReservation(firstIdentifier.id),
    ).resolves.toBeUndefined();
  });

  it("compacts terminal responses but retains replay ownership", async () => {
    let now = 0;
    const store = new MemoryServerChannelStore([], {
      limits: {
        maxRecords: 1,
        maxBytes: 1024 * 1024,
        maxRecordsPerPayer: 1,
        terminalRetentionMs: 100,
      },
      now: () => now,
    });
    await store.claimExactSettlement(
      exactSettlementAttempt({ profile: "standard-native", head: undefined }),
    );
    await store.acceptExactSettlement(
      TX,
      "accepted",
      "2026-07-07T00:00:01.000Z",
    );
    await store.beginExactHandler(TX, "2026-07-07T00:00:02.000Z");
    await store.recordExactHandlerResult(
      TX,
      { chargedAmount: "20000000" },
      "2026-07-07T00:00:03.000Z",
    );
    await store.commitExactPayment({
      payment: exactPayment({
        profile: "standard-native",
        amount: "20000000",
        paymentOutputIndex: 0,
      }),
    });
    now = 101;
    await expect(
      store.claimExactSettlement(
        exactSettlementAttempt({
          transactionId: OTHER_TX,
          profile: "standard-native",
          head: undefined,
        }),
      ),
    ).rejects.toThrow("record limit exceeded");
    await expect(store.loadExactPayment(TX)).resolves.toMatchObject({
      response: {
        status: 409,
        body: { error: "replay_record_retained" },
      },
    });
    expect(store.durableStateStats()).toMatchObject({
      records: 1,
      openRecords: 0,
    });
  });
});

function defineStoreContract(factory: StoreFactory): void {
  it("rejects channels detached from their immutable launch manifest", async () => {
    const wrongEvidence = channel();
    wrongEvidence.lineage.manifest.genesis.acceptance = {
      ...acceptedEvidence(TX),
      acceptingBlockHash: "ac".repeat(32),
    };
    const refundedWithLiveHead = { ...channel(), status: "refunded" as const };
    const wrongSource = channel();
    wrongSource.lineage.manifest.source.sha256 = "ad".repeat(32);

    await expect(
      Promise.resolve().then(() => factory.create([wrongEvidence])),
    ).rejects.toThrow("immutable covenant launch manifest");
    await expect(
      Promise.resolve().then(() => factory.create([refundedWithLiveHead])),
    ).rejects.toThrow("still has a derived covenant head");
    await expect(
      Promise.resolve().then(() => factory.create([wrongSource])),
    ).rejects.toThrow("covenant launch identity hash is inconsistent");
  });

  it("atomically binds one covenant lineage to one channel", async () => {
    const store = await factory.create();
    const first = channel();
    const alias = channel({
      channelId: "1c".repeat(32),
      channelConfig: {
        ...first.channelConfig,
        salt: "1d".repeat(32),
      },
    });

    await store.registerChannel(first);
    await expect(store.registerChannel(alias)).rejects.toThrow(
      "covenant lineage is already registered",
    );
    await expect(store.loadChannel(first.channelId)).resolves.toEqual(first);
    await expect(store.loadChannel(alias.channelId)).resolves.toBeUndefined();
    await expect(
      store.registerChannel({ ...first, covenantId: "1e".repeat(32) }),
    ).rejects.toThrow("cannot be replaced");
  });

  it("preserves covenant lineage ownership through settlement and retirement", async () => {
    const first = channel();
    let store = await factory.create([first]);
    await store.claimChannelOperation(
      channelOperation(first, "retirement", ATTEMPT),
    );
    await store.retireChannel(first.channelId, ATTEMPT, first);
    if (store instanceof DurableMockServerChannelStore) {
      store = await store.restart();
    }
    const alias = channel({
      channelId: "1c".repeat(32),
      channelConfig: {
        ...first.channelConfig,
        salt: "1d".repeat(32),
      },
    });
    await expect(store.registerChannel(alias)).rejects.toThrow(
      "covenant lineage is already registered",
    );
    await expect(store.loadChannel(alias.channelId)).resolves.toBeUndefined();
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
    const store = await factory.create([refunded]);
    await store.claimChannelOperation(
      channelOperation(refunded, "retirement", ATTEMPT),
    );

    await expect(
      store.retireChannel(refunded.channelId, ATTEMPT, refunded),
    ).rejects.toThrow("terminal refunded channel cannot be retired");
    await expect(store.loadChannel(refunded.channelId)).resolves.toEqual(
      refunded,
    );
  });

  it("atomically persists the covenant journal and derived head across restart", async () => {
    const first = channel();
    let store = await factory.create([first]);
    const acceptance = acceptedEvidence(OTHER_TX);
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
              kind: "claim",
              covenantId: first.covenantId,
              templateId: first.channelConfig.templateId,
              consumedOutpoint: first.activeOutpoint,
              transactionId: OTHER_TX,
              authorizedSuccessorCount: 1,
              successor: {
                covenantId: first.covenantId,
                authorizingInput: 0,
                outpoint: { txid: OTHER_TX, index: 0 },
                scriptPublicKey: SCRIPT,
                value: "900",
                claimedCumulativeAmount: "100",
              },
              terminalOutput: null,
              acceptance,
            },
          ],
        },
      ],
    });
    const advanced: ServerChannelRecord = {
      ...first,
      version: "1",
      activeOutpoint: { txid: OTHER_TX, index: 0 },
      fundingAmount: "900",
      claimedCumulativeAmount: "100",
      lineage,
    };

    for (const invalid of [
      { ...advanced, chargedCumulativeAmount: "1" },
      {
        ...advanced,
        channelConfig: { ...advanced.channelConfig, payTo: "kaspatest:other" },
      },
      { ...advanced, status: "suspicious" as const },
      { ...advanced, version: "2" },
    ]) {
      await expect(
        store.applyCovenantLineage(first, invalid),
      ).rejects.toThrow();
      await expect(store.loadChannel(first.channelId)).resolves.toEqual(first);
    }

    await store.applyCovenantLineage(first, advanced);
    if (store instanceof DurableMockServerChannelStore) {
      store = await store.restart();
    }
    await expect(store.loadChannel(first.channelId)).resolves.toEqual(advanced);

    const rolledBack = { ...first, version: "2" };
    await expect(store.applyCovenantLineage(advanced, rolledBack)).rejects.toThrow(
      "journal is not append-only",
    );
    await expect(store.loadChannel(first.channelId)).resolves.toEqual(advanced);
  });

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
    await stageExactAttemptWithIdentifier(store, TX, TX);

    await expect(
      store.claimExactSettlement(
        exactSettlementAttempt({
          transactionId: OTHER_TX,
          profile: "standard-native",
          head: undefined,
          paymentIdentifier: exactIdentifierClaim(OTHER_TX, OTHER_TX),
        }),
      ),
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

  it("does not let delayed unavailable evidence downgrade an advanced head", async () => {
    const store = await factory.create();
    await store.registerExactHead(exactHead());
    const staleSnapshot: ExactHeadUnavailableApply = {
      headId: HEAD_ID,
      expectedVersion: "0",
      expectedOutpoint: { txid: FUNDING_TX, index: 0 },
      expectedAmount: "100000000",
      expectedStatus: "available",
      reason: "delayed unknown response",
      observedAt: "2026-07-07T00:00:04.000Z",
    };
    await store.applyExactHeadLineage({
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
      ],
      observedAt: "2026-07-07T00:00:03.000Z",
    });

    await expect(
      store.markExactHeadUnavailable(staleSnapshot),
    ).resolves.toMatchObject({
      applied: false,
      head: {
        status: "available",
        version: "1",
        currentOutpoint: { txid: TX, index: 0 },
      },
    });
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
    await store.recordExactHandlerResult(
      TX,
      { body: "download", chargedAmount: "20000000" },
      "2026-07-07T00:00:05.000Z",
    );
    await store.commitExactPayment({
      payment: exactPayment({ transactionId: TX, paymentOutputIndex: 0 }),
    });
    await expect(store.loadExactSettlementAttempt(TX)).resolves.toMatchObject({
      status: "applied",
      handlerStartedAt: "2026-07-07T00:00:04.000Z",
    });
    await expect(store.loadExactSettlementAttempt(TX)).resolves.not.toHaveProperty(
      "handlerResult",
    );

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
    const paymentIdentifier = exactIdentifierClaim(TX, TX);
    await store.registerExactHead(exactHead());
    await store.claimExactSettlement(
      exactSettlementAttempt({ paymentIdentifier }),
    );
    await store.recordExactSettlementBroadcast(
      TX,
      "broadcast",
      "2026-07-07T00:00:01.000Z",
    );
    await store.abandonExactSettlement(
      TX,
      "trusted node rejected transaction",
      "2026-07-07T00:00:02.000Z",
    );
    await expect(store.loadExactSettlementAttempt(TX)).resolves.toBeUndefined();
    await expect(
      store.loadPaymentIdentifierReservation(paymentIdentifier.id),
    ).resolves.toMatchObject({ status: "safely-released" });
    await expect(store.loadExactHead(HEAD_ID)).resolves.toMatchObject({
      status: "available",
      claimTransactionId: undefined,
    });

    await expect(
      store.markExactHeadUnavailable({
        headId: HEAD_ID,
        expectedVersion: "0",
        expectedOutpoint: { txid: FUNDING_TX, index: 0 },
        expectedAmount: "100000000",
        expectedStatus: "available",
        reason: "successor lineage unavailable",
        observedAt: "2026-07-07T00:00:03.000Z",
      }),
    ).resolves.toMatchObject({ applied: true });
    await expect(store.loadExactHead(HEAD_ID)).resolves.toMatchObject({
      status: "unavailable",
      unavailableReason: "successor lineage unavailable",
    });
    await expect(
      store.selectExactHead(exactHeadSelection()),
    ).resolves.toBeUndefined();
  });

  it("bounds durable exact handler results", async () => {
    const store = await factory.create();
    await store.claimExactSettlement(
      exactSettlementAttempt({ profile: "standard-native", head: undefined }),
    );
    await store.acceptExactSettlement(
      TX,
      "accepted",
      "2026-07-07T00:00:03.000Z",
    );
    await store.beginExactHandler(TX, "2026-07-07T00:00:04.000Z");

    await expect(
      store.recordExactHandlerResult(
        TX,
        { body: "x".repeat(256 * 1024) },
        "2026-07-07T00:00:05.000Z",
      ),
    ).rejects.toThrow("durable size limit");
    const attempt = await store.loadExactSettlementAttempt(TX);
    expect(attempt).toMatchObject({ status: "accepted" });
    expect(attempt).not.toHaveProperty("handlerResult");
  });

  it("applies batch settlement only when the channel snapshot still matches", async () => {
    const store = await factory.create([
      {
        ...channel(),
        version: "1",
        chargedCumulativeAmount: "1",
        signedMaxClaimable: "1",
      },
    ]);
    const staleCommit = settlementCommit(channel(), {
      chargedCumulativeAmount: "100",
    });

    await expect(stageBatchAttempt(store, staleCommit)).rejects.toThrow(
      "channel state changed",
    );
    await expect(
      store.loadCommitment(staleCommit.commitment.commitmentId),
    ).resolves.toBeUndefined();
  });

  it("persists a batch handler result before commit and resumes it after restart", async () => {
    let store = await factory.create([channel()]);
    const commit = settlementCommit(channel(), {
      chargedCumulativeAmount: "100",
      signedMaxClaimable: "100",
      voucherSignature: "16".repeat(64),
    });
    await stageBatchAttempt(store, commit);
    if ("restart" in store && typeof store.restart === "function") {
      store = await store.restart();
    }

    await store.commitSettlement(commit);

    await expect(store.loadChannel(CHANNEL_ID)).resolves.toMatchObject({
      chargedCumulativeAmount: "100",
    });
    await expect(
      store.loadBatchSettlementAttempt(commit.batchAttemptId),
    ).resolves.toMatchObject({
      status: "applied",
    });
    await expect(
      store.loadBatchSettlementAttempt(commit.batchAttemptId),
    ).resolves.not.toHaveProperty("handlerResult");
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
      const store = await factory.create([previous]);
      const next = {
        ...previous,
        version: "1",
        ...testCase.mutation,
      };
      const attemptId = (index + 1).toString(16).padStart(64, "0");
      await expect(
        store.claimBatchSettlement(
          batchSettlementAttempt(next, {
            attemptId,
            operationKind: "deposit",
            channelTransition: { previous, next },
          }),
        ),
      ).rejects.toThrow(testCase.message);
      await expect(store.loadChannel(previous.channelId)).resolves.toEqual(
        previous,
      );
      await expect(
        store.loadBatchSettlementAttempt(attemptId),
      ).resolves.toBeUndefined();
      await expect(
        store.loadChannelOperation(previous.channelId),
      ).resolves.toBeUndefined();
    }

    const previous = channel();
    const store = await factory.create([previous]);
    const noOpTopUp = { ...previous, version: "1" };
    await expect(
      store.claimBatchSettlement(
        batchSettlementAttempt(noOpTopUp, {
          attemptId: "ff".repeat(32),
          operationKind: "top-up",
          channelTransition: { previous, next: noOpTopUp },
        }),
      ),
    ).rejects.toThrow("top-up must replace the active outpoint");
    await expect(store.loadChannel(previous.channelId)).resolves.toEqual(
      previous,
    );

    const invalidGenesis = channel({ status: "retired" });
    const genesisStore = await factory.create();
    await expect(
      genesisStore.claimBatchSettlement(
        batchSettlementAttempt(invalidGenesis, {
          attemptId: "fe".repeat(32),
          operationKind: "deposit",
          channelTransition: { previous: null, next: invalidGenesis },
        }),
      ),
    ).rejects.toThrow("new channel must begin active");
    await expect(
      genesisStore.loadChannel(invalidGenesis.channelId),
    ).resolves.toBeUndefined();
  });

  it("rejects malformed batch settlement attempts before durable state changes", async () => {
    const current = channel();
    const store = await factory.create([current]);
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
        store.claimBatchSettlement(testCase.attempt),
        testCase.name,
      ).rejects.toThrow(testCase.message);
    }
    await expect(
      store.loadBatchSettlementAttempt(base.attemptId),
    ).resolves.toBeUndefined();
  });

  it("rejects conflicting batch payment identifiers atomically", async () => {
    const store = await factory.create([channel()]);
    await stageExactAttemptWithIdentifier(store, TX, TX);

    await expect(
      store.claimBatchSettlement({
        ...batchSettlementAttempt(channel()),
        paymentIdentifier: batchIdentifierClaim(ATTEMPT, CHANNEL_ID),
      }),
    ).rejects.toThrow("payment identifier");
    await expect(
      store.loadCommitment("15".repeat(32)),
    ).resolves.toBeUndefined();
    await expect(store.loadChannel(CHANNEL_ID)).resolves.toMatchObject({
      chargedCumulativeAmount: "0",
    });
  });

  it("allows one open claim attempt per channel and applies by snapshot", async () => {
    const store = await factory.create([claimableChannel()]);
    const first = claimAttempt({ attemptId: ATTEMPT });
    await reserveClaim(store, first);
    await store.saveClaimAttempt(first);
    await expect(
      store.saveClaimAttempt(claimAttempt({ attemptId: OTHER_TX })),
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
      acceptance: acceptedEvidence(first.transactionId),
    };
    await store.saveClaimAttempt(broadcast);
    await store.saveClaimAttempt(accepted);

    await expect(
      store.applyClaimAttempt(
        claimSuccessor(claimableChannel(), first),
        accepted,
      ),
    ).resolves.toBeUndefined();
    await expect(store.loadChannel(CHANNEL_ID)).resolves.toMatchObject({
      version: "1",
      claimedCumulativeAmount: "100",
      fundingAmount: "900",
    });
  });

  it("binds claim attempts to one immutable artifact and monotonic state", async () => {
    const store = await factory.create([claimableChannel()]);
    const pending = claimAttempt({ attemptId: ATTEMPT });
    await reserveClaim(store, pending);
    await store.saveClaimAttempt(pending);

    await expect(
      store.saveClaimAttempt({
        ...pending,
        transactionId: OTHER_TX,
        continuationOutpoint: { ...pending.continuationOutpoint!, txid: OTHER_TX },
      }),
    ).rejects.toThrow("immutable artifact");
    await expect(
      store.saveClaimAttempt({ ...pending, transaction: "cd".repeat(32) }),
    ).rejects.toThrow("immutable artifact");
    await expect(
      store.saveClaimAttempt({ ...pending, requiredConfirmations: 31 }),
    ).rejects.toThrow("immutable artifact");
    await expect(
      store.saveClaimAttempt({
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
    await store.saveClaimAttempt(broadcast);
    await expect(store.saveClaimAttempt(pending)).rejects.toThrow(
      "status transition",
    );
    await expect(
      store.saveClaimAttempt({
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
    await store.saveClaimAttempt(accepted);
    await expect(store.saveClaimAttempt(accepted)).resolves.toBeUndefined();
    await expect(
      store.saveClaimAttempt({
        ...accepted,
        acceptance: {
          ...accepted.acceptance!,
          acceptingBlockHash: "ac".repeat(32),
        },
      }),
    ).rejects.toThrow("same-state update");
    await expect(
      store.applyClaimAttempt(
        claimSuccessor(claimableChannel(), accepted),
        {
          ...accepted,
          transactionId: OTHER_TX,
          continuationOutpoint: {
            ...accepted.continuationOutpoint!,
            txid: OTHER_TX,
          },
        },
      ),
    ).rejects.toThrow("persisted accepted attempt");
    await expect(
      store.applyClaimAttempt(
        claimSuccessor(claimableChannel(), accepted),
        {
          ...accepted,
          chargedCumulativeAmount: "1",
          signedMaxClaimable: "1",
        },
      ),
    ).rejects.toThrow("persisted accepted attempt");
    await expect(store.loadOpenClaimAttempt(CHANNEL_ID)).resolves.toEqual(
      accepted,
    );
    await expect(store.loadChannel(CHANNEL_ID)).resolves.toEqual(
      claimableChannel(),
    );
  });

  it("persists the claim confirmation threshold and rejects weaker acceptance", async () => {
    let store = await factory.create([claimableChannel()]);
    const pending: ClaimAttemptRecord = {
      ...claimAttempt({ attemptId: ATTEMPT }),
      requiredConfirmations: 30,
    };
    await reserveClaim(store, pending);
    await store.saveClaimAttempt(pending);
    if (store instanceof DurableMockServerChannelStore) {
      store = await store.restart();
    }
    await expect(store.loadOpenClaimAttempt(CHANNEL_ID)).resolves.toMatchObject(
      {
        requiredConfirmations: 30,
        status: "pending",
      },
    );

    const broadcast: ClaimAttemptRecord = {
      ...pending,
      status: "broadcast",
      finality: "accepted",
      acceptance: {
        ...acceptedEvidence(pending.transactionId),
        acceptingBlockBlueScore: "972",
        confirmationCount: 29,
      },
    };
    await store.saveClaimAttempt(broadcast);
    await expect(
      store.saveClaimAttempt({
        ...broadcast,
        status: "accepted",
      }),
    ).rejects.toThrow("lacks confirmed chain evidence");
    await store.saveClaimAttempt({
      ...broadcast,
      status: "accepted",
      finality: "confirmed",
      acceptance: acceptedEvidence(pending.transactionId),
    });
  });
}

async function stageBatchAttempt(
  store: ServerStateStore,
  commit: SettlementCommit,
): Promise<void> {
  const now = "2026-07-07T00:00:00.000Z";
  await store.claimBatchSettlement({
    attemptId: commit.batchAttemptId,
    channelId: commit.channel.channelId,
    covenantId: commit.channel.covenantId,
    requestFingerprint: commit.commitment.requestFingerprint,
    paymentRequirementsHash: commit.commitment.paymentRequirementsHash,
    paymentPayloadHash: commit.commitment.paymentPayloadHash,
    maximumCharge: commit.commitment.chargedAmount,
    expected: commit.expected,
    operationKind: "payment",
    payerId: "payer:test",
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });
  await store.beginBatchHandler(
    commit.batchAttemptId,
    "2026-07-07T00:00:01.000Z",
  );
  await store.recordBatchHandlerResult(
    commit.batchAttemptId,
    { chargedAmount: commit.commitment.chargedAmount },
    "2026-07-07T00:00:02.000Z",
  );
}

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
    paymentPayloadHash: PAYLOAD,
    maximumCharge: "100",
    operationKind: "payment",
    payerId: "payer:test",
    expected: clone(current),
    status: "pending",
    createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z",
    ...overrides,
  };
}

type DurableMockOperation =
  | { type: "registerChannel"; channel: ServerChannelRecord }
  | {
      type: "applyCovenantLineage";
      expected: ServerChannelRecord;
      channel: ServerChannelRecord;
    }
  | { type: "claimChannelOperation"; record: ChannelOperationLeaseRecord }
  | {
      type: "retireChannel";
      channelId: string;
      leaseId: string;
      expected: ServerChannelRecord;
    }
  | { type: "commitSettlement"; record: SettlementCommit }
  | { type: "claimBatchSettlement"; record: BatchSettlementAttemptRecord }
  | { type: "beginBatchHandler"; attemptId: string; startedAt: string }
  | {
      type: "recordBatchHandlerResult";
      attemptId: string;
      result: ProtectedHandlerResult;
      completedAt: string;
    }
  | {
      type: "markBatchHandlerRecoveryRequired";
      attemptId: string;
      reason: string;
      observedAt: string;
    }
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
      type: "recordExactHandlerResult";
      transactionId: string;
      result: ProtectedHandlerResult;
      completedAt: string;
    }
  | {
      type: "markExactHandlerRecoveryRequired";
      transactionId: string;
      reason: string;
      observedAt: string;
    }
  | {
      type: "abandonExactSettlement";
      transactionId: string;
      reason: string;
      observedAt: string;
    }
  | {
      type: "markExactHeadUnavailable";
      input: ExactHeadUnavailableApply;
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
  readonly channels: readonly ServerChannelRecord[];
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

  async registerChannel(channel: ServerChannelRecord): Promise<void> {
    await this.#write({ type: "registerChannel", channel }, () =>
      super.registerChannel(channel),
    );
  }

  async applyCovenantLineage(
    expected: ServerChannelRecord,
    channel: ServerChannelRecord,
  ): Promise<void> {
    await this.#write({ type: "applyCovenantLineage", expected, channel }, () =>
      super.applyCovenantLineage(expected, channel),
    );
  }

  async claimChannelOperation(record: ChannelOperationLeaseRecord) {
    const result = await super.claimChannelOperation(record);
    if (!this.#hydrating && result.created)
      this.#journal.operations.push(
        clone({ type: "claimChannelOperation", record }),
      );
    return result;
  }

  async retireChannel(
    channelId: string,
    leaseId: string,
    expected: ServerChannelRecord,
  ): Promise<void> {
    await this.#write(
      { type: "retireChannel", channelId, leaseId, expected },
      () => super.retireChannel(channelId, leaseId, expected),
    );
  }

  async commitSettlement(record: SettlementCommit): Promise<void> {
    await this.#write({ type: "commitSettlement", record }, () =>
      super.commitSettlement(record),
    );
  }

  async claimBatchSettlement(record: BatchSettlementAttemptRecord) {
    const result = await super.claimBatchSettlement(record);
    if (!this.#hydrating && result.created)
      this.#journal.operations.push(
        clone({ type: "claimBatchSettlement", record }),
      );
    return result;
  }

  async beginBatchHandler(
    attemptId: string,
    startedAt: string,
  ): Promise<boolean> {
    const started = await super.beginBatchHandler(attemptId, startedAt);
    if (!this.#hydrating && started)
      this.#journal.operations.push(
        clone({ type: "beginBatchHandler", attemptId, startedAt }),
      );
    return started;
  }

  async recordBatchHandlerResult(
    attemptId: string,
    result: ProtectedHandlerResult,
    completedAt: string,
  ): Promise<void> {
    await this.#write(
      { type: "recordBatchHandlerResult", attemptId, result, completedAt },
      () => super.recordBatchHandlerResult(attemptId, result, completedAt),
    );
  }

  async markBatchHandlerRecoveryRequired(
    attemptId: string,
    reason: string,
    observedAt: string,
  ): Promise<void> {
    await this.#write(
      {
        type: "markBatchHandlerRecoveryRequired",
        attemptId,
        reason,
        observedAt,
      },
      () =>
        super.markBatchHandlerRecoveryRequired(attemptId, reason, observedAt),
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

  async recordExactHandlerResult(
    transactionId: string,
    result: ProtectedHandlerResult,
    completedAt: string,
  ): Promise<void> {
    await this.#write(
      {
        type: "recordExactHandlerResult",
        transactionId,
        result,
        completedAt,
      },
      () => super.recordExactHandlerResult(transactionId, result, completedAt),
    );
  }

  async markExactHandlerRecoveryRequired(
    transactionId: string,
    reason: string,
    observedAt: string,
  ): Promise<void> {
    await this.#write(
      {
        type: "markExactHandlerRecoveryRequired",
        transactionId,
        reason,
        observedAt,
      },
      () =>
        super.markExactHandlerRecoveryRequired(
          transactionId,
          reason,
          observedAt,
        ),
    );
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
    input: ExactHeadUnavailableApply,
  ): Promise<ExactHeadUnavailableResult> {
    const result = await super.markExactHeadUnavailable(input);
    await this.#write(
      { type: "markExactHeadUnavailable", input },
      async () => undefined,
    );
    return result;
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
      super.abandonClaimAttempt(attemptId),
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
      case "registerChannel":
        await super.registerChannel(operation.channel);
        return;
      case "applyCovenantLineage":
        await super.applyCovenantLineage(
          operation.expected,
          operation.channel,
        );
        return;
      case "claimChannelOperation":
        await super.claimChannelOperation(operation.record);
        return;
      case "retireChannel":
        await super.retireChannel(
          operation.channelId,
          operation.leaseId,
          operation.expected,
        );
        return;
      case "commitSettlement":
        await super.commitSettlement(operation.record);
        return;
      case "claimBatchSettlement":
        await super.claimBatchSettlement(operation.record);
        return;
      case "beginBatchHandler":
        await super.beginBatchHandler(operation.attemptId, operation.startedAt);
        return;
      case "recordBatchHandlerResult":
        await super.recordBatchHandlerResult(
          operation.attemptId,
          operation.result,
          operation.completedAt,
        );
        return;
      case "markBatchHandlerRecoveryRequired":
        await super.markBatchHandlerRecoveryRequired(
          operation.attemptId,
          operation.reason,
          operation.observedAt,
        );
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
      case "recordExactHandlerResult":
        await super.recordExactHandlerResult(
          operation.transactionId,
          operation.result,
          operation.completedAt,
        );
        return;
      case "markExactHandlerRecoveryRequired":
        await super.markExactHandlerRecoveryRequired(
          operation.transactionId,
          operation.reason,
          operation.observedAt,
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
        await super.markExactHeadUnavailable(operation.input);
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
        await super.abandonClaimAttempt(operation.attemptId);
        return;
    }
  }
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
      authorizingInput: { txid: "1b".repeat(32), index: 0 },
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
      templateId: "kaspa-x402-escrow-v4",
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
  const lineage = overrides.lineage ?? createCovenantLineageState({
    format: "kaspa-x402-covenant-launch-v1",
    network: merged.channelConfig.network,
    compiler: structuredClone(ESCROW_V4_LAUNCH_IDENTITY.compiler),
    source: structuredClone(ESCROW_V4_LAUNCH_IDENTITY.source),
    bytecode: structuredClone(ESCROW_V4_LAUNCH_IDENTITY.bytecode),
    constructorSlots: structuredClone(ESCROW_V4_LAUNCH_IDENTITY.constructorSlots),
    abi: structuredClone(ESCROW_V4_LAUNCH_IDENTITY.abi),
    selectors: structuredClone(ESCROW_V4_LAUNCH_IDENTITY.selectors),
    identitySha256: ESCROW_V4_LAUNCH_IDENTITY.identitySha256,
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
    expected: clone(previous),
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
    requestAuthorizationId: "17".repeat(32),
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
    requestAuthorizationId: "17".repeat(32),
    payToScriptPublicKey: HEAD_SCRIPT_PUBLIC_KEY,
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
        scriptPublicKey: HEAD_SCRIPT_PUBLIC_KEY,
      },
    },
    ...overrides,
  };
}

function claimAttempt(input: { attemptId: string }): ClaimAttemptRecord {
  const current = claimableChannel();
  return {
    attemptId: input.attemptId,
    channelId: current.channelId,
    covenantId: current.covenantId,
    activeOutpoint: current.activeOutpoint,
    activeScriptPublicKey: current.activeScriptPublicKey,
    fundingAmount: current.fundingAmount,
    claimAmount: "100",
    chargedCumulativeAmount: current.chargedCumulativeAmount,
    claimedCumulativeAmount: current.claimedCumulativeAmount,
    signedMaxClaimable: current.signedMaxClaimable,
    voucherSignature: current.voucherSignature,
    channelStatus: current.status,
    transaction: "ab".repeat(32),
    transactionId: TX,
    requiredConfirmations: 30,
    operationLeaseId: input.attemptId,
    expected: clone(current),
    continuationOutpoint: { txid: TX, index: 1 },
    continuationScriptPublicKey: SCRIPT,
    continuationFundingAmount: "900",
    status: "pending",
  };
}

function channelOperation(
  current: ServerChannelRecord,
  kind: ChannelOperationLeaseRecord["kind"],
  leaseId: string,
): ChannelOperationLeaseRecord {
  return {
    leaseId,
    channelId: current.channelId,
    covenantId: current.covenantId,
    kind,
    expected: clone(current),
    status: "reserved",
    createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z",
  };
}

async function reserveClaim(
  store: ServerStateStore,
  attempt: ClaimAttemptRecord,
): Promise<void> {
  await store.claimChannelOperation(
    channelOperation(attempt.expected, "claim", attempt.operationLeaseId),
  );
}

function claimSuccessor(
  current: ServerChannelRecord,
  attempt: ClaimAttemptRecord,
): ServerChannelRecord {
  const claimedCumulativeAmount = (
    BigInt(current.claimedCumulativeAmount) + BigInt(attempt.claimAmount)
  ).toString();
  const acceptance =
    attempt.acceptance ?? acceptedEvidence(attempt.transactionId);
  return {
    ...current,
    version: (BigInt(current.version) + 1n).toString(),
    activeOutpoint: attempt.continuationOutpoint!,
    activeScriptPublicKey: attempt.continuationScriptPublicKey!,
    fundingAmount: attempt.continuationFundingAmount!,
    claimedCumulativeAmount,
    lineage: applyCovenantSelectedChainUpdate(current.lineage, {
      fromCheckpoint: current.lineage.checkpoint,
      checkpoint: acceptance.checkpoint,
      continuity: "complete",
      removedChainBlockHashes: [],
      addedChainBlocks: [
        {
          blockHash: acceptance.acceptingBlockHash,
          transitions: [
            {
              kind: "claim",
              covenantId: current.covenantId,
              templateId: current.channelConfig.templateId,
              consumedOutpoint: current.activeOutpoint,
              transactionId: attempt.transactionId,
              authorizedSuccessorCount: 1,
              successor: {
                outpoint: attempt.continuationOutpoint!,
                covenantId: current.covenantId,
                authorizingInput: 0,
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
    }),
  };
}

function exactIdentifierClaim(
  ownerId: string,
  paymentScopeId: string,
): PaymentIdentifierReservationClaim {
  return {
    id: "pay_7d5d747be160e280504c099d984bcfe0",
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

function batchIdentifierClaim(
  ownerId: string,
  paymentScopeId: string,
): PaymentIdentifierReservationClaim {
  return {
    id: "pay_7d5d747be160e280504c099d984bcfe0",
    fingerprint: REQUEST,
    paymentPayloadHash: PAYLOAD,
    paymentScopeId,
    paymentKind: "batch-settlement",
    ownerId,
    payerId: "payer:test",
    channelId: paymentScopeId,
  };
}

async function stageExactAttemptWithIdentifier(
  store: ServerStateStore,
  transactionId: string,
  paymentScopeId: string,
): Promise<void> {
  const claim = exactIdentifierClaim(transactionId, paymentScopeId);
  await store.claimExactSettlement(
    exactSettlementAttempt({
      transactionId,
      profile: "standard-native",
      head: undefined,
      paymentIdentifier: claim,
    }),
  );
  await store.acceptExactSettlement(
    transactionId,
    "accepted",
    "2026-07-07T00:00:01.000Z",
  );
  await store.beginExactHandler(
    transactionId,
    "2026-07-07T00:00:02.000Z",
  );
  await store.recordExactHandlerResult(
    transactionId,
    { chargedAmount: "20000000" },
    "2026-07-07T00:00:03.000Z",
  );
  await store.commitExactPayment({
    payment: exactPayment({
      transactionId,
      profile: "standard-native",
      paymentOutputIndex: 0,
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
