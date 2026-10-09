import { describe, expect, it } from "vitest";
import {
  buildKip10AdditiveRedeemScript,
  payToScriptHashScript,
  serializedScriptPublicKey,
} from "@kaspa-x402/covenant";

const REQUEST = "22".repeat(32);
const REQUIREMENTS = "33".repeat(32);
const PAYLOAD = "44".repeat(32);
const TX = "55".repeat(32);
const OTHER_TX = "66".repeat(32);
const FUNDING_TX = "88".repeat(32);
const HEAD_ID = "90".repeat(32);
const HEAD_REDEEM_SCRIPT = buildKip10AdditiveRedeemScript({
  ownerPublicKey: "91".repeat(32),
  amount: "10000000",
});
const HEAD_SCRIPT_PUBLIC_KEY = serializedScriptPublicKey(
  payToScriptHashScript(HEAD_REDEEM_SCRIPT),
);
const AT = "2026-07-07T00:00:01.000Z";

/** Scenarios exercise the existing store interface, across independent implementations. */
export function defineExactStoreContract(name, create, options = {}) {
  describe(`exact state store contract: ${name}`, () => {
    const factory = { create: async () => (await create()).store };
    it("consumes exact transaction ids once while allowing identical retries", async () => {
      const store = await factory.create();
      const first = exactPayment({ paymentOutputIndex: 1 });
      await store.commitExactPayment({ payment: first });
      await store.commitExactPayment({ payment: first });

      await expect(store.loadExactPayment(TX)).resolves.toMatchObject({
        transactionId: TX,
        paymentOutputIndex: 1,
      });
      if ("restart" in store) {
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
      const input = {
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

      if ("restart" in store) {
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
      const staleSnapshot = {
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
              ...attempt.head,
              successor: {
                ...attempt.head.successor,
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
        payment: exactPayment({
          transactionId: TX,
          paymentOutputIndex: 0,
          amount: "20000000",
        }),
      });
      await expect(store.loadExactSettlementAttempt(TX)).resolves.toMatchObject(
        {
          status: "applied",
          handlerStartedAt: "2026-07-07T00:00:04.000Z",
        },
      );
      await expect(
        store.loadExactSettlementAttempt(TX),
      ).resolves.not.toHaveProperty("handlerResult");

      if ("restart" in store) {
        store = await store.restart();
        await expect(store.loadExactHead(HEAD_ID)).resolves.toMatchObject({
          version: "1",
          currentOutpoint: { txid: TX, index: 0 },
        });
        await expect(
          store.loadExactSettlementAttempt(TX),
        ).resolves.toMatchObject({ status: "applied" });
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
      await expect(
        store.loadExactSettlementAttempt(TX),
      ).resolves.toBeUndefined();
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

    it("admits one competing head claim without leaving loser ownership or quota", async () => {
      const { store, peer, stats } = await create({
        limits: { maxRecords: 1 },
      });
      await store.registerExactHead(exactHead());
      const first = exactSettlementAttempt({
        paymentIdentifier: exactIdentifierClaim(TX, TX),
      });
      const second = exactSettlementAttempt({
        transactionId: OTHER_TX,
        paymentIdentifier: {
          ...exactIdentifierClaim(OTHER_TX, OTHER_TX),
          id: "pay_second",
        },
        head: {
          ...first.head,
          successor: {
            ...first.head.successor,
            outpoint: { txid: OTHER_TX, index: 0 },
          },
        },
      });
      const results = await Promise.allSettled([
        store.claimExactSettlement(first),
        peer().claimExactSettlement(second),
      ]);
      expect(
        results.filter((item) => item.status === "fulfilled"),
      ).toHaveLength(1);
      const winner = results[0].status === "fulfilled" ? first : second;
      const loser = winner === first ? second : first;
      await expect(
        store.loadExactSettlementAttempt(loser.transactionId),
      ).resolves.toBeUndefined();
      await expect(
        store.loadPaymentIdentifierReservation(loser.paymentIdentifier.id),
      ).resolves.toBeUndefined();
      expect(await stats()).toMatchObject({ records: 1 });
      await store.abandonExactSettlement(
        winner.transactionId,
        "trusted rejection",
        AT,
      );
      // Reclaim the same released identifier so the one-record quota still applies.
      loser.paymentIdentifier.id = winner.paymentIdentifier.id;
      await expect(peer().claimExactSettlement(loser)).resolves.toMatchObject({
        created: true,
      });
    });

    it("snapshots submitted inputs before async storage can yield", async () => {
      const { store } = await create();
      const existing = exactHead();
      await store.registerExactHead(existing);
      const newId = "92".repeat(32);
      const submitted = exactHead({
        headId: newId,
        currentOutpoint: { txid: "93".repeat(32), index: 0 },
      });
      const expected = structuredClone(submitted);
      const registration = store.registerExactHead(submitted);
      await Promise.resolve();
      submitted.headId = existing.headId;
      await registration;
      await expect(store.loadExactHead(existing.headId)).resolves.toEqual(
        existing,
      );
      await expect(store.loadExactHead(newId)).resolves.toEqual(expected);

      const attempt = exactSettlementAttempt({
        paymentIdentifier: exactIdentifierClaim(TX, TX),
      });
      const claim = store.claimExactSettlement(attempt);
      attempt.transactionId = OTHER_TX;
      attempt.head.headId = newId;
      attempt.paymentIdentifier.id = "pay_mutated";
      await claim;
      await expect(store.loadExactSettlementAttempt(TX)).resolves.toMatchObject(
        { transactionId: TX },
      );
      await expect(
        store.loadExactSettlementAttempt(OTHER_TX),
      ).resolves.toBeUndefined();
      await expect(
        store.loadPaymentIdentifierReservation("pay_mutated"),
      ).resolves.toBeUndefined();
      await expect(store.loadExactHead(HEAD_ID)).resolves.toMatchObject({
        status: "claimed",
        claimTransactionId: TX,
      });
      await expect(store.loadExactHead(newId)).resolves.toEqual(expected);
    });

    it("admits concurrent identical retries and protected work once", async () => {
      const { store, peer } = await create();
      const attempt = nativeAttempt();
      const claims = await Promise.all([
        store.claimExactSettlement(attempt),
        peer().claimExactSettlement(attempt),
      ]);
      expect(claims.map((item) => item.created).sort()).toEqual([false, true]);
      await store.acceptExactSettlement(TX, "accepted", AT);
      const admitted = await Promise.all([
        store.beginExactHandler(TX, AT),
        peer().beginExactHandler(TX, AT),
      ]);
      expect(admitted.sort()).toEqual([false, true]);
    });

    it("retains every completed phase through adapter reopen", async () => {
      const harness = await create();
      let store = harness.store;
      const reopen = () => {
        store = harness.reopen?.() ?? store;
      };
      await store.registerExactHead(exactHead());
      const attempt = exactSettlementAttempt({
        paymentIdentifier: exactIdentifierClaim(TX, TX),
      });
      await store.claimExactSettlement(attempt);
      reopen();
      await expect(store.loadExactHead(HEAD_ID)).resolves.toMatchObject({
        status: "claimed",
        claimTransactionId: TX,
      });
      await expect(
        store.loadPaymentIdentifierReservation(attempt.paymentIdentifier.id),
      ).resolves.toMatchObject({ status: "reserved" });
      await store.recordExactSettlementBroadcast(TX, "broadcast", AT);
      reopen();
      await expect(store.loadExactSettlementAttempt(TX)).resolves.toMatchObject(
        { status: "broadcast" },
      );
      await expect(
        store.loadPaymentIdentifierReservation(attempt.paymentIdentifier.id),
      ).resolves.toMatchObject({ status: "pending" });
      await store.acceptExactSettlement(TX, "accepted", AT);
      reopen();
      await store.acceptExactSettlement(TX, "confirmed", AT);
      await store.recordExactSettlementBroadcast(TX, "broadcast", AT);
      await expect(store.loadExactHead(HEAD_ID)).resolves.toMatchObject({
        version: "1",
        currentOutpoint: { txid: TX, index: 0 },
      });
      await expect(store.loadExactSettlementAttempt(TX)).resolves.toMatchObject(
        { status: "accepted", finality: "confirmed" },
      );
      await store.beginExactHandler(TX, AT);
      reopen();
      await expect(store.beginExactHandler(TX, AT)).resolves.toBe(false);
      await store.markExactHandlerRecoveryRequired(
        TX,
        "interrupted effect",
        AT,
      );
      reopen();
      await expect(
        store.loadPaymentIdentifierReservation(attempt.paymentIdentifier.id),
      ).resolves.toMatchObject({ status: "recovery-required" });
      await store.recordExactHandlerResult(
        TX,
        { body: "saved", chargedAmount: attempt.amount },
        AT,
      );
      reopen();
      await expect(store.loadExactSettlementAttempt(TX)).resolves.toMatchObject(
        { handlerResult: { body: "saved" }, recoveryReason: undefined },
      );
      await store.commitExactPayment(completedExact(attempt));
      reopen();
      await expect(store.loadExactSettlementAttempt(TX)).resolves.toMatchObject(
        { status: "applied", transaction: "", handlerStartedAt: AT },
      );
      await expect(
        store.loadExactSettlementAttempt(TX),
      ).resolves.not.toHaveProperty("handlerResult");
      await expect(
        store.loadPaymentIdentifierReservation(attempt.paymentIdentifier.id),
      ).resolves.toMatchObject({
        status: "completed",
        recoveryReason: undefined,
      });
      await expect(
        store.loadPaymentIdentifier(attempt.paymentIdentifier.id),
      ).resolves.toBeDefined();
      await expect(store.beginExactHandler(TX, AT)).resolves.toBe(false);
    });

    it("keeps uncertain work owned and accepts only an identical retained result", async () => {
      const { store } = await create();
      const attempt = nativeAttempt();
      await store.claimExactSettlement(attempt);
      await expect(
        store.commitExactPayment(completedExact(attempt)),
      ).rejects.toThrow("not ready");
      await store.acceptExactSettlement(TX, "accepted", AT);
      await store.beginExactHandler(TX, AT);
      await store.markExactHandlerRecoveryRequired(
        TX,
        "uncertain handler effect",
        AT,
      );
      const before = await observableState(store);
      await expect(
        store.abandonExactSettlement(TX, "release", AT),
      ).rejects.toThrow("cannot be abandoned");
      expect(await observableState(store)).toEqual(before);
      const result = { body: "saved", chargedAmount: attempt.amount };
      await store.recordExactHandlerResult(TX, result, AT);
      await store.recordExactHandlerResult(TX, structuredClone(result), AT);
      const retained = await observableState(store);
      await expect(
        store.recordExactHandlerResult(
          TX,
          { ...result, body: "different" },
          AT,
        ),
      ).rejects.toThrow("conflicts");
      await expect(
        store.markExactHandlerRecoveryRequired(TX, "uncertain again", AT),
      ).rejects.toThrow("not awaiting recovery");
      expect(await observableState(store)).toEqual(retained);
    });

    it("preserves a released identifier and its quota when replacement admission fails", async () => {
      const harness = await create({
        limits: { maxRecords: 10, maxRecordsPerPayer: 1 },
      });
      const { store, stats } = harness;
      const released = nativeAttempt({
        payerId: "payer:a",
        paymentIdentifier: {
          ...exactIdentifierClaim(TX, TX),
          payerId: "payer:a",
        },
      });
      await store.claimExactSettlement(released);
      await store.abandonExactSettlement(TX, "trusted rejection", AT);
      await store.claimExactSettlement(
        nativeAttempt({
          transactionId: OTHER_TX,
          payerId: "payer:b",
          paymentIdentifier: undefined,
        }),
      );
      const candidateId = "cc".repeat(32);
      const candidate = nativeAttempt({
        transactionId: candidateId,
        payerId: "payer:b",
        paymentIdentifier: {
          ...exactIdentifierClaim(candidateId, candidateId),
          payerId: "payer:b",
        },
      });
      const before = await observableState(store);
      const quota = await stats();
      await expect(store.claimExactSettlement(candidate)).rejects.toThrow(
        "per-payer limit exceeded",
      );
      expect(await observableState(store)).toEqual(before);
      expect(await stats()).toEqual(quota);
      await expect(
        store.loadExactSettlementAttempt(candidateId),
      ).resolves.toBeUndefined();
      await store.abandonExactSettlement(OTHER_TX, "trusted rejection", AT);
      await expect(
        store.claimExactSettlement(candidate),
      ).resolves.toMatchObject({ created: true });
      await expect(
        store.loadPaymentIdentifierReservation(candidate.paymentIdentifier.id),
      ).resolves.toMatchObject({ ownerId: candidateId, status: "reserved" });
    });

    it("reclaims expired payer quotas beyond the first cleanup page across retries", async () => {
      let now = 1_000;
      const harness = await create({
        limits: { maxRecordsPerPayer: 1, terminalRetentionMs: 1_000 },
        now: () => now,
      });
      let store = harness.store;
      for (let index = 0; index < 129; index += 1) {
        const attempt = nativeAttempt({
          transactionId: (index + 1).toString(16).padStart(64, "0"),
          payerId: index === 128 ? "payer:target" : `payer:${index}`,
          paymentIdentifier: undefined,
        });
        await stageResult(store, attempt);
        await store.commitExactPayment(completedExact(attempt));
        now += 1;
      }
      now += 1_001;
      const transactionId = "ff".repeat(32);
      const candidate = nativeAttempt({
        transactionId,
        payerId: "payer:target",
        paymentIdentifier: {
          ...exactIdentifierClaim(transactionId, transactionId),
          id: "pay_after_retention",
          payerId: "payer:target",
        },
      });
      try {
        await store.claimExactSettlement(candidate);
      } catch (error) {
        expect(error.message).toBe(
          "durable protected-payment per-payer limit exceeded",
        );
        expect(await harness.stats()).toMatchObject({ records: 1 });
        await expect(
          store.loadExactSettlementAttempt(transactionId),
        ).resolves.toBeUndefined();
        await expect(
          store.loadPaymentIdentifierReservation(candidate.paymentIdentifier.id),
        ).resolves.toBeUndefined();
        store = harness.reopen?.() ?? store;
        await expect(
          store.claimExactSettlement(candidate),
        ).resolves.toMatchObject({ created: true });
      }
      expect(await harness.stats()).toMatchObject({ records: 1 });
      await expect(
        store.loadExactSettlementAttempt(transactionId),
      ).resolves.toMatchObject({ status: "pending" });
      await expect(
        store.loadExactPayment("1".padStart(64, "0")),
      ).resolves.toMatchObject({
        transactionId: "1".padStart(64, "0"),
        response: { status: 409, body: { error: "replay_record_retained" } },
      });
    });

    it("keeps a retained result recoverable after terminal quota failure", async () => {
      const { store, stats } = await create();
      const attempt = nativeAttempt();
      await stageResult(store, attempt);
      const before = await observableState(store);
      const quota = await stats();
      const oversized = completedExact(attempt);
      oversized.payment.response.body = "x".repeat(1024 * 1024);
      await expect(store.commitExactPayment(oversized)).rejects.toThrow(
        "reserved byte quota",
      );
      expect(await observableState(store)).toEqual(before);
      expect(await stats()).toEqual(quota);
      await store.commitExactPayment(completedExact(attempt));
      await expect(
        store.loadPaymentIdentifierReservation(attempt.paymentIdentifier.id),
      ).resolves.toMatchObject({ status: "completed" });
    });

    it("retains replay ownership after terminal payload expiry", async () => {
      let now = 1_000;
      const { store } = await create({
        limits: { terminalRetentionMs: 100 },
        now: () => now,
      });
      const attempt = nativeAttempt();
      await stageResult(store, attempt);
      await store.commitExactPayment(completedExact(attempt));
      now += 101;
      await store.claimExactSettlement(
        nativeAttempt({
          transactionId: OTHER_TX,
          paymentIdentifier: {
            ...exactIdentifierClaim(OTHER_TX, OTHER_TX),
            id: "pay_new",
          },
        }),
      );
      await expect(store.loadExactPayment(TX)).resolves.toMatchObject({
        transactionId: TX,
        requestFingerprint: REQUEST,
      });
      await expect(
        store.loadPaymentIdentifierReservation(attempt.paymentIdentifier.id),
      ).resolves.toMatchObject({ status: "completed", ownerId: TX });
      await expect(
        store.claimExactSettlement(
          nativeAttempt({
            transactionId: "dd".repeat(32),
            paymentIdentifier: exactIdentifierClaim(
              "dd".repeat(32),
              "dd".repeat(32),
            ),
          }),
        ),
      ).rejects.toThrow("already owned");
      await expect(
        store.commitExactPayment({
          payment: exactPayment({ paymentPayloadHash: "ee".repeat(32) }),
        }),
      ).rejects.toThrow("already committed");
    });

    if (options.checkWriteFailures) {
      for (const kind of [
        "register",
        "claim",
        "broadcast",
        "accept",
        "begin",
        "result",
        "recovery",
        "abandon",
        "commit",
        "unavailable",
        "lineage",
      ]) {
        it(`rolls back every failed ${kind} write and permits a retry`, async () => {
          let checkedWrites = 0;
          for (let index = 1; index < 32; index += 1) {
            const harness = await create();
            const { store, snapshot, failWriteAt } = harness;
            const mutation = await failureScenario(store, kind);
            const before = snapshot();
            failWriteAt(index);
            try {
              await mutation();
            } catch (error) {
              expect(error.message).toBe("injected storage write failure");
              expect(snapshot()).toEqual(before);
              const reopened = harness.reopen();
              expect(await observableState(reopened)).toEqual(
                await observableState(store),
              );
              await mutation();
              checkedWrites += 1;
              continue;
            }
            expect(checkedWrites).toBeGreaterThan(0);
            return;
          }
          throw new Error(
            "write failure scenario exceeded its bounded write count",
          );
        });
      }
    }
  });
}

function exactPayment(overrides = {}) {
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

function exactHead(overrides = {}) {
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
    network: "kaspa:testnet-10",
    amount: "20000000",
    payTo: "kaspatest:head",
    payToScriptPublicKey: HEAD_SCRIPT_PUBLIC_KEY,
    minimumAdditiveThresholdSompi: "10000000",
    selectionKey,
  };
}

function exactSettlementAttempt(overrides = {}) {
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

function exactIdentifierClaim(ownerId, paymentScopeId) {
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

async function stageExactAttemptWithIdentifier(
  store,
  transactionId,
  paymentScopeId,
) {
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
  await store.beginExactHandler(transactionId, "2026-07-07T00:00:02.000Z");
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

function paymentIdentifier(overrides = {}) {
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

function settlement() {
  return {
    success: true,
    transaction: TX,
    network: "kaspa:testnet-10",
    amount: "100",
  };
}

function response() {
  return {
    status: 200,
    headers: {},
    body: "ok",
  };
}

function nativeAttempt(overrides = {}) {
  return exactSettlementAttempt({
    profile: "standard-native",
    head: undefined,
    paymentIdentifier: exactIdentifierClaim(TX, TX),
    ...overrides,
  });
}
function completedExact(attempt) {
  const payment = exactPayment({
    profile: attempt.profile,
    transactionId: attempt.transactionId,
    paymentOutputIndex: attempt.paymentOutputIndex,
    amount: attempt.amount,
    settlement: {
      ...settlement(),
      transaction: attempt.transactionId,
      amount: attempt.amount,
    },
  });
  const claim = attempt.paymentIdentifier;
  return {
    payment,
    paymentIdentifier: claim
      ? {
          id: claim.id,
          fingerprint: claim.fingerprint,
          paymentPayloadHash: claim.paymentPayloadHash,
          paymentScopeId: claim.paymentScopeId,
          transactionId: claim.transactionId,
          paymentOutputIndex: claim.paymentOutputIndex,
          response: response(),
          settlement: payment.settlement,
        }
      : undefined,
  };
}
async function stageResult(store, attempt) {
  await store.claimExactSettlement(attempt);
  await store.acceptExactSettlement(attempt.transactionId, "accepted", AT);
  await store.beginExactHandler(attempt.transactionId, AT);
  await store.recordExactHandlerResult(
    attempt.transactionId,
    { body: "saved", chargedAmount: attempt.amount },
    AT,
  );
}
async function observableState(store) {
  return {
    heads: await store.listExactHeads(),
    attempt: await store.loadExactSettlementAttempt(TX),
    otherAttempt: await store.loadExactSettlementAttempt(OTHER_TX),
    payment: await store.loadExactPayment(TX),
    identifier: await store.loadPaymentIdentifier(
      "pay_7d5d747be160e280504c099d984bcfe0",
    ),
    reservation: await store.loadPaymentIdentifierReservation(
      "pay_7d5d747be160e280504c099d984bcfe0",
    ),
  };
}
async function failureScenario(store, kind) {
  if (kind === "register") return () => store.registerExactHead(exactHead());
  await store.registerExactHead(exactHead());
  if (kind === "unavailable")
    return () =>
      store.markExactHeadUnavailable({
        headId: HEAD_ID,
        expectedVersion: "0",
        expectedOutpoint: { txid: FUNDING_TX, index: 0 },
        expectedAmount: "100000000",
        expectedStatus: "available",
        reason: "missing lineage",
        observedAt: AT,
      });
  if (kind === "lineage")
    return () =>
      store.applyExactHeadLineage({
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
              amount: "120000000",
              scriptPublicKey: HEAD_SCRIPT_PUBLIC_KEY,
            },
            finality: "accepted",
          },
        ],
        observedAt: AT,
      });
  const attempt = exactSettlementAttempt({
    paymentIdentifier: exactIdentifierClaim(TX, TX),
  });
  if (kind === "claim") {
    // Prime independent retention maintenance before injecting admission writes.
    await store.claimExactSettlement(
      nativeAttempt({ transactionId: OTHER_TX, paymentIdentifier: undefined }),
    );
    await store.abandonExactSettlement(OTHER_TX, "trusted rejection", AT);
    return () => store.claimExactSettlement(attempt);
  }
  await store.claimExactSettlement(attempt);
  if (kind === "broadcast")
    return () => store.recordExactSettlementBroadcast(TX, "broadcast", AT);
  if (kind === "abandon")
    return () => store.abandonExactSettlement(TX, "trusted rejection", AT);
  if (kind === "accept")
    return () => store.acceptExactSettlement(TX, "accepted", AT);
  await store.acceptExactSettlement(TX, "accepted", AT);
  if (kind === "begin") return () => store.beginExactHandler(TX, AT);
  await store.beginExactHandler(TX, AT);
  if (kind === "recovery")
    return () =>
      store.markExactHandlerRecoveryRequired(TX, "interrupted effect", AT);
  if (kind === "result")
    return () =>
      store.recordExactHandlerResult(
        TX,
        { body: "saved", chargedAmount: attempt.amount },
        AT,
      );
  await store.recordExactHandlerResult(
    TX,
    { body: "saved", chargedAmount: attempt.amount },
    AT,
  );
  return () => store.commitExactPayment(completedExact(attempt));
}
