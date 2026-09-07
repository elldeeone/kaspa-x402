import { describe, expect, it } from "vitest";
import {
  MemoryChannelLockManager,
  MemoryServerChannelStore,
  type ExactSettlementAttemptRecord,
  type ExactSettlementCommit,
} from "../src/index.js";

const TX = "ab".repeat(32);
const NOW = "2026-09-07T00:00:00.000Z";
function attempt(transactionId = TX): ExactSettlementAttemptRecord {
  return {
    transactionId, profile: "standard-native", amount: "100", paymentOutputIndex: 0,
    requestFingerprint: "11".repeat(32), paymentRequirementsHash: "22".repeat(32),
    paymentPayloadHash: "33".repeat(32), requestAuthorizationId: "44".repeat(32),
    payToScriptPublicKey: "0000abcd", transaction: "signed-transaction",
    requiredFinality: "accepted", status: "pending", createdAt: NOW, updatedAt: NOW,
    paymentIdentifier: "shared_payment_identifier",
  };
}
function commit(transactionId = TX): ExactSettlementCommit {
  const a = attempt(transactionId);
  const response = { status: 200, headers: {}, body: "result" };
  const settlement = { success: true, transaction: transactionId, network: "kaspa:testnet-10" as const, amount: "100" };
  return {
    payment: { profile: a.profile, transactionId, paymentOutputIndex: 0,
      requestFingerprint: a.requestFingerprint, paymentRequirementsHash: a.paymentRequirementsHash,
      paymentPayloadHash: a.paymentPayloadHash, requestAuthorizationId: a.requestAuthorizationId,
      amount: a.amount, finality: "accepted", settlement, response },
    paymentIdentifier: { id: a.paymentIdentifier!, fingerprint: a.requestFingerprint,
      paymentPayloadHash: a.paymentPayloadHash, paymentScopeId: transactionId, settlement, response },
  };
}

// Local store-contract evidence only: replay successful writes into a fresh memory
// store, modeling atomic durable writes and lost acknowledgements, not a real DB.
const writes = [
  (s: MemoryServerChannelStore) => s.claimExactSettlement(attempt()),
  (s: MemoryServerChannelStore) => s.recordExactSettlementBroadcast(TX, "broadcast", NOW),
  (s: MemoryServerChannelStore) => s.acceptExactSettlement(TX, "accepted", NOW),
  (s: MemoryServerChannelStore) => s.beginExactHandler(TX, NOW),
  (s: MemoryServerChannelStore) => s.recordExactHandlerResult(TX, { body: "result", chargedAmount: "100" }, NOW),
  (s: MemoryServerChannelStore) => s.commitExactPayment(commit()),
];

describe("exact state atomic-write fault matrix (local model)", () => {
  for (const failedStep of writes.keys()) for (const timing of ["before", "after"] as const) {
    it(`recovers step ${failedStep} with failure ${timing} write without repeating work`, async () => {
      let store = new MemoryServerChannelStore();
      const journal: number[] = [];
      let handlerCalls = 0;
      for (const step of writes.keys()) {
        if (step === failedStep && timing === "before") break;
        await writes[step]!(store);
        journal.push(step);
        if (step === failedStep && timing === "after") break;
        if (step === 3) handlerCalls++;
      }
      store = new MemoryServerChannelStore();
      for (const step of journal) await writes[step]!(store);
      // An admitted but unfinished operation still owns its identifier after restart.
      if (journal.length && journal.length < writes.length) {
        await expect(store.claimExactSettlement(attempt("cd".repeat(32)))).rejects.toThrow(/reserved/);
      }
      if (!(await store.loadExactSettlementAttempt(TX))) await writes[0]!(store);
      let current = (await store.loadExactSettlementAttempt(TX))!;
      if (current.status !== "accepted" && current.status !== "applied") {
        // This models trusted acceptance reconciliation, not blind rebroadcast.
        await writes[2]!(store);
      }
      current = (await store.loadExactSettlementAttempt(TX))!;
      if (current.status !== "applied") {
        if (await store.beginExactHandler(TX, NOW)) handlerCalls++;
        else if (!current.handlerResult) {
          await store.markExactHandlerRecoveryRequired(TX, "operator must resolve uncertain work", NOW);
          expect(await store.beginExactHandler(TX, NOW)).toBe(false);
        }
        // Explicit operator-confirmed result for the uncertain interval.
        if (!current.handlerResult) await writes[4]!(store);
        await writes[5]!(store);
      }
      await store.commitExactPayment(commit());
      expect(handlerCalls).toBeLessThanOrEqual(1);
      expect(await store.loadExactSettlementAttempt(TX)).toMatchObject({ status: "applied" });
      expect(await store.loadPaymentIdentifier(attempt().paymentIdentifier!)).toMatchObject({ response: { body: "result" } });
      await expect(store.abandonExactSettlement(TX, "late rejected evidence", NOW)).rejects.toThrow(/cannot be abandoned/);
      expect(await store.beginExactHandler(TX, NOW)).toBe(false);
    });
  }

  it("applies a case-insensitive broadcaster transaction ID to the canonical attempt", async () => {
    const store = new MemoryServerChannelStore();
    for (const write of writes.slice(0, 5)) await write(store);
    await store.commitExactPayment(commit(TX.toUpperCase()));
    expect(await store.loadExactPayment(TX)).toBeDefined();
    expect(await store.loadExactSettlementAttempt(TX)).toMatchObject({ status: "applied" });
  });

  for (let seed = 1; seed <= 32; seed++) {
    it(`seed ${seed}: one identifier winner and one handler among 32 concurrent contenders`, async () => {
      const store = new MemoryServerChannelStore();
      const order = Array.from({ length: 32 }, (_, i) => i + 1);
      let random = seed;
      for (let i = order.length - 1; i > 0; i--) {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        const j = random % (i + 1);
        [order[i], order[j]] = [order[j]!, order[i]!];
      }
      const outcomes = await Promise.allSettled(order.map(i => store.claimExactSettlement(attempt(i.toString(16).padStart(64, "0")))));
      expect(outcomes.filter(o => o.status === "fulfilled")).toHaveLength(1);
      const winner = order[0]!.toString(16).padStart(64, "0");
      const retries = await Promise.all(Array.from({ length: 32 }, () => store.claimExactSettlement(attempt(winner))));
      expect(retries.every(r => !r.created)).toBe(true);
      await store.acceptExactSettlement(winner, "accepted", NOW);
      const starts = await Promise.all(Array.from({ length: 32 }, () => store.beginExactHandler(winner, NOW)));
      expect(starts.filter(Boolean)).toHaveLength(1);
      await store.recordExactHandlerResult(winner, { body: "result", chargedAmount: "100" }, NOW);
      await store.commitExactPayment(commit(winner));
      expect(await store.loadExactSettlementAttempt(winner)).toMatchObject({ status: "applied" });
    });
  }

  it("releases a failed lock holder and serialises mixed-case retries", async () => {
    const locks = new MemoryChannelLockManager();
    let active = 0;
    let completed = 0;
    const results = await Promise.allSettled(Array.from({ length: 64 }, (_, i) =>
      locks.runExclusive(i % 2 ? TX : TX.toUpperCase(), async () => {
        active++;
        expect(active).toBe(1);
        await Promise.resolve();
        active--;
        completed++;
        if (i % 7 === 0) throw new Error("injected handler failure");
      }),
    ));
    expect(completed).toBe(64);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(10);
    await expect(locks.runExclusive(TX, async () => "released")).resolves.toBe("released");
  });
});

async function publicExactSetup() {
  const { DirectModeServer, PAYMENT_SIGNATURE_HEADER } = await import("../src/index.js");
  const { sha256Hex, stableStringify, exactAuthorizationExpiresAt, exactRequestAuthorizationDigest,
    exactRequestAuthorizationId, encodePaymentSignatureHeader, paymentIdentifierExtension } = await import("@kaspa-x402/core");
  const store = new MemoryServerChannelStore();
  let broadcasts = 0;
  let calls = 0;
  const makeServer = (overrides: Partial<import("../src/index.js").DirectModeServerConfig> = {}) => new DirectModeServer({
    network: "kaspa:testnet-10", payTo: "kaspatest:payout", serverPublicKey: "11".repeat(32),
    minDepositSompi: "1000", claimReserveSompi: "10", amount: "100", refundTimeoutDaa: "1000",
    store, exactProfile: "standard-native",
    chainProvider: {
      async getUtxo() { return null; }, async getVirtualDaaScore() { return "0"; },
      async estimateClaimFee() { return "10"; },
      async sendTransaction() { broadcasts++; return { transactionId: TX.toUpperCase(), finality: "accepted" }; },
    },
    addressCodec: { scriptPublicKeyForAddress(address) { return `0000${sha256Hex(address)}`; },
      encodeScriptAddress() { return "kaspatest:escrow"; } },
    channelSignatureVerifier: { verifySignature() { return true; } },
    exactTransactionVerifier: { verifyExactPayment(request) {
      return { transactionId: TX, paymentOutput: { amount: request.amount, scriptPublicKey: request.payToScriptPublicKey },
        finality: "mempool", payerAddress: "kaspatest:refund",
        requestAuthorization: { authorizationId: exactRequestAuthorizationId(request.authorization), digest: request.authorization.digest,
          inputIndex: request.authorization.inputIndex, publicKey: "22".repeat(32) } };
    } },
    ...overrides,
  });
  const server = makeServer();
  const url = "https://example.test/data";
  const accepted = server.buildPaymentRequired({ resource: { url }, scheme: "exact" }).accepts[0] as import("@kaspa-x402/core").ExactPaymentRequirements;
  const paymentRequirementsHash = sha256Hex(stableStringify(accepted));
  const requestHash = sha256Hex(stableStringify({ method: "GET", url, body: null, paymentRequirementsHash }));
  const expiresAt = exactAuthorizationExpiresAt(accepted.maxTimeoutSeconds);
  const authorization = { version: "kaspa-x402-exact-request-authorization-v1" as const, inputIndex: 0, expiresAt,
    signature: "ab".repeat(64), digest: exactRequestAuthorizationDigest({
      network: accepted.network, profile: "standard-native", transactionId: TX, paymentOutputIndex: 0,
      amount: accepted.amount, payTo: accepted.payTo, payToScriptPublicKey: accepted.extra.payToScriptPublicKey!,
      paymentRequirementsHash, requestHash, inputIndex: 0, expiresAt,
    }) };
  const payment: import("@kaspa-x402/core").PaymentPayload = { x402Version: 2, accepted,
    extensions: { "payment-identifier": paymentIdentifierExtension({ required: true, id: "uppercase_broadcast_identifier" }) },
    payload: { type: "exact-transaction", profile: "standard-native", payerAddress: "kaspatest:refund", transaction: TX,
      transactionEncoding: "kaspa-sdk-safe-json-v2.0.0", paymentOutputIndex: 0, requestHash, authorization } };
  const request = { url, paymentScheme: "exact" as const, headers: { [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader(payment) } };
  return { server, makeServer, store, request, handler: async () => { calls++; return { body: "result" }; },
    counts: () => ({ calls, broadcasts }) };
}

it("public server completes and replays an uppercase broadcaster transaction ID", async () => {
  const { server, store, request, handler, counts } = await publicExactSetup();
  for (let retry = 0; retry < 3; retry++) {
    const response = await server.handlePaidRequest(request, handler);
    expect(response).toMatchObject({ status: 200, body: "result" });
  }
  expect(counts()).toEqual({ calls: 1, broadcasts: 1 });
  expect(await store.loadExactSettlementAttempt(TX)).toMatchObject({ status: "applied" });
});

for (const override of [{ amount: "200" }, { payTo: "kaspatest:othermerchant" }]) {
  it(`keeps accepted work recoverable after merchant terms change ${JSON.stringify(override)}`, async () => {
    const { server, makeServer, store, request, handler, counts } = await publicExactSetup();
    const original = store.commitExactPayment.bind(store);
    store.commitExactPayment = async () => { throw new Error("injected commit outage"); };
    expect((await server.handlePaidRequest(request, handler)).status).toBe(500);
    expect(await store.loadExactSettlementAttempt(TX)).toMatchObject({ status: "accepted", handlerResult: { body: "result" } });
    store.commitExactPayment = original;
    const restarted = makeServer(override);
    const retried = await restarted.handlePaidRequest(request, handler);
    // Changed terms reject payer retry; operator completion must still use
    // the accepted durable amount/output and never execute protected work again.
    expect(retried.status).toBe(402);
    const completed = await restarted.completeExactSettlement(TX);
    expect(completed).toMatchObject({ status: 200, body: "result" });
    expect(await store.loadExactPayment(TX)).toMatchObject({ amount: "100" });
    expect(counts()).toEqual({ calls: 1, broadcasts: 1 });
  });
}

for (const override of [{ amount: "200" }, { payTo: "kaspatest:othermerchant" }]) {
  it(`reconciles an ambiguous broadcast using admitted terms after ${JSON.stringify(override)}`, async () => {
    const { server, makeServer, store, request, handler, counts } = await publicExactSetup();
    const original = store.recordExactSettlementBroadcast.bind(store);
    store.recordExactSettlementBroadcast = async () => { throw new Error("lost broadcast write"); };
    expect((await server.handlePaidRequest(request, handler)).status).toBe(503);
    store.recordExactSettlementBroadcast = original;
    expect(await store.loadExactSettlementAttempt(TX)).toMatchObject({ status: "pending", amount: "100" });
    let known = false;
    const restarted = makeServer({ ...override, exactSettlementReconciler: {
      reconcileExactSettlement(a) {
        return known ? { status: "accepted", transactionId: a.transactionId, finality: "accepted",
          paymentOutput: { amount: a.amount, scriptPublicKey: a.payToScriptPublicKey } }
          : { status: "unknown", transactionId: a.transactionId };
      },
    } });
    expect((await restarted.handlePaidRequest(request, handler)).status).toBe(402);
    expect(await restarted.reconcileExactSettlement(TX)).toMatchObject({ status: "pending" });
    await expect(restarted.completeExactSettlement(TX, { body: "operator delivered" })).rejects.toThrow(/accepted/);
    known = true;
    expect(await restarted.reconcileExactSettlement(TX)).toMatchObject({ status: "accepted", amount: "100" });
    expect(await restarted.completeExactSettlement(TX, { body: "operator delivered" })).toMatchObject({ status: 200, body: "operator delivered" });
    expect(counts()).toEqual({ calls: 0, broadcasts: 1 });
  });
}
