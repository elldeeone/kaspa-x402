import { describe, expect, it } from "vitest";

import {
  X402_VERSION,
  channelId,
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  sha256Hex,
  uptoAuthorizationDigest,
  voucherDigest,
  type BatchPaymentRequirements,
  type ChannelConfig,
  type ExactPaymentRequirements,
  type FundingOutpoint,
  type Hash32Hex,
  type NetworkId,
  type PaymentPayload,
  type UptoPaymentRequirements,
} from "@kaspa-x402/core";
import { deriveEscrowAddress, escrowScriptPublicKey, serializedScriptPublicKey } from "@kaspa-x402/covenant";
import {
  DirectModeServer,
  MemoryServerChannelStore,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  type AddressCodec,
  type ChainUtxo,
  type ClaimAttemptRecord,
  type DirectModeServerConfig,
  type ServerChainProvider,
  type ServerChannelRecord,
  type ServerChannelStore,
  type SettlementCommit,
  type SettlementFinality,
  type UptoPendingAuthorizationRecord,
  type UptoSettlementCommit,
} from "../src/index.js";

const SERVER_KEY = "11".repeat(32);
const CLIENT_KEY = "22".repeat(32);
const SALT = "33".repeat(32);
const FUNDING_TX = "44".repeat(32);
const TOP_UP_TX = "99".repeat(32);
const CLAIM_TX = "55".repeat(32);
const EXACT_TX_ID = "77".repeat(32);
const EXACT_TX = "aa".repeat(96);
const UPTO_TX_ID = "88".repeat(32);
const UPTO_SCRIPT = "0000" + "12".repeat(34);
const RESOURCE = { url: "https://api.example.test/data" };

describe("direct-mode server", () => {
  it("returns PAYMENT-REQUIRED for unpaid requests", async () => {
    const { server } = makeServer();

    const response = await server.handlePaidRequest({ url: RESOURCE.url }, async () => ({ body: "secret" }));

    expect(response.status).toBe(402);
    expect(response.headers[PAYMENT_REQUIRED_HEADER]).toBeTruthy();
  });

  it("uses custom per-request amounts on unpaid requests", async () => {
    const { server } = makeServer({ amount: "100" });

    const response = await server.handlePaidRequest({ url: RESOURCE.url, paymentAmount: "75" }, async () => ({ body: "secret" }));

    expect(response.status).toBe(402);
    const required = decodePaymentRequiredHeader(response.headers[PAYMENT_REQUIRED_HEADER]);
    expect(required.accepts[0]?.amount).toBe("75");
  });

  it("offers exact requirements for exact paid routes", async () => {
    const { server } = makeServer({ amount: "100" });

    const response = await server.handlePaidRequest({ url: RESOURCE.url, paymentAmount: "75", paymentScheme: "exact" }, async () => ({
      body: "secret",
    }));

    expect(response.status).toBe(402);
    const required = decodePaymentRequiredHeader(response.headers[PAYMENT_REQUIRED_HEADER]);
    expect(required.accepts[0]?.scheme).toBe("exact");
    expect(required.accepts[0]?.amount).toBe("75");
    expect(required.accepts[0]?.extra.binding).toBe("kaspa-exact-v1");
  });

  it("offers upto requirements for capped variable paid routes", async () => {
    const { server } = makeServer({ amount: "100", authorizationTimeoutDaa: "1500" });

    const response = await server.handlePaidRequest({ url: RESOURCE.url, paymentAmount: "75", paymentScheme: "upto" }, async () => ({
      body: "secret",
    }));

    expect(response.status).toBe(402);
    const required = decodePaymentRequiredHeader(response.headers[PAYMENT_REQUIRED_HEADER]);
    expect(required.accepts[0]?.scheme).toBe("upto");
    expect(required.accepts[0]?.amount).toBe("75");
    expect(required.accepts[0]?.extra).toMatchObject({
      binding: "kaspa-upto-v1",
      authorizationTemplateId: "kaspa-x402-upto-v1",
      serverPublicKey: SERVER_KEY,
      authorizationTimeoutDaa: "1500",
    });
  });

  it("accepts an exact transfer and commits replay state after handler success", async () => {
    const setup = makeServer();
    const payment = makeExactPayment(setup);

    const response = await setup.server.handlePaidRequest(requestWithPayment(payment, { paymentScheme: "exact" }), async () => ({
      body: "download",
    }));

    expect(response.status).toBe(200);
    expect(response.body).toBe("download");
    const settlement = decodePaymentResponseHeader(response.headers[PAYMENT_RESPONSE_HEADER]);
    expect(settlement.transaction).toBe(EXACT_TX_ID);
    expect(settlement.amount).toBe("100");
    expect(settlement.extra?.paymentOutputIndex).toBe(1);
    const stored = await setup.store.loadExactPayment(EXACT_TX_ID, 1);
    expect(stored?.amount).toBe("100");
    expect(stored?.paymentOutputIndex).toBe(1);
    expect(stored?.response.status).toBe(200);
  });

  it("rejects batch payments submitted to exact routes", async () => {
    const setup = makeServer();
    const payment = makeDepositPayment(setup);
    let executed = false;

    const response = await setup.server.handlePaidRequest(requestWithPayment(payment.payload, { paymentScheme: "exact" }), async () => {
      executed = true;
      return { body: "secret" };
    });

    expect(response.status).toBe(402);
    expect(executed).toBe(false);
    const required = decodePaymentRequiredHeader(response.headers[PAYMENT_REQUIRED_HEADER]);
    expect(required.accepts[0]?.scheme).toBe("exact");
  });

  it("rejects exact payments submitted to batch routes", async () => {
    const setup = makeServer();
    const payment = makeExactPayment(setup);
    let executed = false;

    const response = await setup.server.handlePaidRequest(requestWithPayment(payment, { paymentScheme: "batch-settlement" }), async () => {
      executed = true;
      return { body: "secret" };
    });

    expect(response.status).toBe(402);
    expect(executed).toBe(false);
    const required = decodePaymentRequiredHeader(response.headers[PAYMENT_REQUIRED_HEADER]);
    expect(required.accepts[0]?.scheme).toBe("batch-settlement");
  });

  it("rejects exact payload request hashes that do not match the server fingerprint", async () => {
    const setup = makeServer();
    const payment = makeExactPayment(setup, { requestHash: "12".repeat(32) });
    let executed = false;

    const response = await setup.server.handlePaidRequest(requestWithPayment(payment, { paymentScheme: "exact", requestHash: "13".repeat(32) }), async () => {
      executed = true;
      return { body: "download" };
    });

    expect(response.status).toBe(402);
    expect(response.body).toEqual({ error: "invalid_kaspa_x402_payload" });
    expect(executed).toBe(false);
    await expect(setup.store.loadExactPayment(EXACT_TX_ID, 1)).resolves.toBeUndefined();
  });

  it("returns the cached response for an identical exact payment retry", async () => {
    const setup = makeServer();
    const payment = makeExactPayment(setup);
    const requestHash = "12".repeat(32);
    await setup.server.handlePaidRequest(requestWithPayment(payment, { paymentScheme: "exact", requestHash }), async () => ({
      body: "download",
    }));

    let executed = false;
    const replay = await setup.server.handlePaidRequest(requestWithPayment(payment, { paymentScheme: "exact", requestHash }), async () => {
      executed = true;
      return { body: "second" };
    });

    expect(replay.status).toBe(200);
    expect(replay.body).toBe("download");
    expect(executed).toBe(false);
  });

  it("rejects exact transaction replay against a different request", async () => {
    const setup = makeServer();
    const payment = makeExactPayment(setup);
    await setup.server.handlePaidRequest(requestWithPayment(payment, { paymentScheme: "exact", requestHash: "12".repeat(32) }), async () => ({
      body: "download",
    }));

    let executed = false;
    const replay = await setup.server.handlePaidRequest(requestWithPayment(payment, { paymentScheme: "exact", requestHash: "13".repeat(32) }), async () => {
      executed = true;
      return { body: "second" };
    });

    expect(replay.status).toBe(409);
    expect(replay.body).toEqual({ error: "exact_payment_replay" });
    expect(executed).toBe(false);
  });

  it("serializes concurrent exact requests that share one transaction", async () => {
    const setup = makeServer();
    const firstPayment = makeExactPayment(setup, { paymentOutputIndex: 1 });
    const secondPayment = makeExactPayment(setup, { paymentOutputIndex: 2 });
    let activeHandlers = 0;
    let maxActiveHandlers = 0;
    let executions = 0;
    const handler = async () => {
      activeHandlers += 1;
      maxActiveHandlers = Math.max(maxActiveHandlers, activeHandlers);
      await new Promise((resolve) => setTimeout(resolve, 10));
      executions += 1;
      activeHandlers -= 1;
      return { body: `download-${executions}` };
    };

    const [first, second] = await Promise.all([
      setup.server.handlePaidRequest(requestWithPayment(firstPayment, { paymentScheme: "exact", requestHash: "21".repeat(32) }), handler),
      setup.server.handlePaidRequest(requestWithPayment(secondPayment, { paymentScheme: "exact", requestHash: "22".repeat(32) }), handler),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(executions).toBe(2);
    expect(maxActiveHandlers).toBe(1);
    await expect(setup.store.loadExactPayment(EXACT_TX_ID, 1)).resolves.toBeTruthy();
    await expect(setup.store.loadExactPayment(EXACT_TX_ID, 2)).resolves.toBeTruthy();
  });

  it("rejects exact transfers whose verified output does not match the offer", async () => {
    const setup = makeServer({
      exactTransactionVerifier: {
        verifyExactPayment(request) {
          return {
            transactionId: EXACT_TX_ID,
            paymentOutput: {
              amount: "99",
              scriptPublicKey: request.payToScriptPublicKey,
            },
            finality: "accepted",
          };
        },
      },
    });
    const payment = makeExactPayment(setup);
    let executed = false;

    const response = await setup.server.handlePaidRequest(requestWithPayment(payment, { paymentScheme: "exact" }), async () => {
      executed = true;
      return { body: "download" };
    });

    expect(response.status).toBe(402);
    expect(response.body).toEqual({ error: "invalid_kaspa_x402_amount" });
    expect(executed).toBe(false);
    await expect(setup.store.loadExactPayment(EXACT_TX_ID, 1)).resolves.toBeUndefined();
  });

  it("accepts an upto authorization and commits nonzero settlement after handler success", async () => {
    const setup = makeServer({ authorizationTimeoutDaa: "1500" });
    const payment = makeUptoPayment(setup, { amount: "100", requestHash: "12".repeat(32) });

    const response = await setup.server.handlePaidRequest(requestWithPayment(payment, { paymentScheme: "upto", requestHash: "12".repeat(32) }), async () => ({
      body: "variable",
      chargedAmount: "70",
    }));

    expect(response.status).toBe(200);
    expect(response.body).toBe("variable");
    const settlement = decodePaymentResponseHeader(response.headers[PAYMENT_RESPONSE_HEADER]);
    expect(settlement.transaction).toBe(UPTO_TX_ID);
    expect(settlement.amount).toBe("70");
    expect(settlement.extra?.authorizationOutpoint).toEqual({ txid: UPTO_TX_ID, index: 0 });
    expect(settlement.extra?.maxAmountSompi).toBe("100");
    const stored = await setup.store.loadUptoAuthorization(authorizationScopeId({ txid: UPTO_TX_ID, index: 0 }));
    expect(stored?.chargedAmount).toBe("70");
    expect(stored?.response.status).toBe(200);
    expect(setup.chain.sendCount).toBe(1);
  });

  it("commits zero-charge upto consumption without broadcasting", async () => {
    const setup = makeServer({ authorizationTimeoutDaa: "1500" });
    const payment = makeUptoPayment(setup, { amount: "100", requestHash: "12".repeat(32) });

    const response = await setup.server.handlePaidRequest(requestWithPayment(payment, { paymentScheme: "upto", requestHash: "12".repeat(32) }), async () => ({
      body: "free",
      chargedAmount: "0",
    }));

    expect(response.status).toBe(200);
    const settlement = decodePaymentResponseHeader(response.headers[PAYMENT_RESPONSE_HEADER]);
    expect(settlement.transaction).toBe("");
    expect(settlement.amount).toBeUndefined();
    expect(settlement.extra?.chargedAmount).toBe("0");
    expect(setup.chain.sendCount).toBe(0);
    const stored = await setup.store.loadUptoAuthorization(authorizationScopeId({ txid: UPTO_TX_ID, index: 0 }));
    expect(stored?.chargedAmount).toBe("0");
  });

  it("rejects invalid upto signatures without executing the handler", async () => {
    const setup = makeServer({ authorizationTimeoutDaa: "1500" });
    const payment = makeUptoPayment(setup, { amount: "100", requestHash: "12".repeat(32), badSignature: true });
    let executed = false;

    const response = await setup.server.handlePaidRequest(requestWithPayment(payment, { paymentScheme: "upto", requestHash: "12".repeat(32) }), async () => {
      executed = true;
      return { body: "wrong" };
    });

    expect(response.status).toBe(402);
    expect(response.body).toEqual({ error: "invalid_kaspa_signature" });
    expect(executed).toBe(false);
    await expect(setup.store.loadUptoAuthorization(authorizationScopeId({ txid: UPTO_TX_ID, index: 0 }))).resolves.toBeUndefined();
  });

  it("rejects expired upto authorizations", async () => {
    const setup = makeServer({ authorizationTimeoutDaa: "1500" });
    setup.chain.daa = "1501";
    const payment = makeUptoPayment(setup, { amount: "100", requestHash: "12".repeat(32) });
    let executed = false;

    const response = await setup.server.handlePaidRequest(requestWithPayment(payment, { paymentScheme: "upto", requestHash: "12".repeat(32) }), async () => {
      executed = true;
      return {};
    });

    expect(response.status).toBe(402);
    expect(response.body).toEqual({ error: "invalid_kaspa_upto_expired" });
    expect(executed).toBe(false);
  });

  it("rejects upto recipient, server-key, and max-amount mismatches", async () => {
    const setup = makeServer({ authorizationTimeoutDaa: "1500" });
    const recipient = makeUptoPayment(setup, { amount: "100", requestHash: "12".repeat(32), payTo: "kaspatest:wrong" });
    const wrongRecipient = await setup.server.handlePaidRequest(requestWithPayment(recipient, { paymentScheme: "upto", requestHash: "12".repeat(32) }), async () => ({
      body: "wrong",
    }));
    expect(wrongRecipient.status).toBe(402);
    expect(wrongRecipient.body).toEqual({ error: "invalid_kaspa_upto_recipient" });

    const serverKey = makeUptoPayment(setup, { amount: "100", requestHash: "13".repeat(32), serverPublicKey: "aa".repeat(32), index: 1 });
    const wrongServerKey = await setup.server.handlePaidRequest(requestWithPayment(serverKey, { paymentScheme: "upto", requestHash: "13".repeat(32) }), async () => ({
      body: "wrong",
    }));
    expect(wrongServerKey.status).toBe(402);
    expect(wrongServerKey.body).toEqual({ error: "invalid_kaspa_public_key" });

    const maxAmount = makeUptoPayment(setup, { amount: "100", requestHash: "14".repeat(32), maxAmount: "99", index: 2 });
    const wrongMax = await setup.server.handlePaidRequest(requestWithPayment(maxAmount, { paymentScheme: "upto", requestHash: "14".repeat(32) }), async () => ({
      body: "wrong",
    }));
    expect(wrongMax.status).toBe(402);
    expect(wrongMax.body).toEqual({ error: "invalid_kaspa_upto_max_amount" });
  });

  it("rejects reused upto outpoints for different requests", async () => {
    const setup = makeServer({ authorizationTimeoutDaa: "1500" });
    const payment = makeUptoPayment(setup, { amount: "100", requestHash: "12".repeat(32) });
    await setup.server.handlePaidRequest(requestWithPayment(payment, { paymentScheme: "upto", requestHash: "12".repeat(32) }), async () => ({
      body: "first",
      chargedAmount: "70",
    }));

    let executed = false;
    const replay = await setup.server.handlePaidRequest(requestWithPayment(payment, { paymentScheme: "upto", requestHash: "13".repeat(32) }), async () => {
      executed = true;
      return { body: "wrong" };
    });

    expect(replay.status).toBe(409);
    expect(replay.body).toEqual({ error: "upto_authorization_replay" });
    expect(executed).toBe(false);
  });

  it("rejects reused upto nonces on different outpoints", async () => {
    const setup = makeServer({ authorizationTimeoutDaa: "1500" });
    const first = makeUptoPayment(setup, { amount: "100", requestHash: "12".repeat(32), index: 0, nonce: SALT });
    const second = makeUptoPayment(setup, { amount: "100", requestHash: "13".repeat(32), index: 1, nonce: SALT });
    await setup.server.handlePaidRequest(requestWithPayment(first, { paymentScheme: "upto", requestHash: "12".repeat(32) }), async () => ({
      chargedAmount: "70",
    }));

    let executed = false;
    const replay = await setup.server.handlePaidRequest(requestWithPayment(second, { paymentScheme: "upto", requestHash: "13".repeat(32) }), async () => {
      executed = true;
      return {};
    });

    expect(replay.status).toBe(409);
    expect(executed).toBe(false);
  });

  it("does not consume upto authorization when the handler fails", async () => {
    const setup = makeServer({ authorizationTimeoutDaa: "1500" });
    const payment = makeUptoPayment(setup, { amount: "100", requestHash: "12".repeat(32) });

    const response = await setup.server.handlePaidRequest(requestWithPayment(payment, { paymentScheme: "upto", requestHash: "12".repeat(32) }), async () => {
      throw new Error("handler failed");
    });

    expect(response.status).toBe(500);
    await expect(setup.store.loadUptoAuthorization(authorizationScopeId({ txid: UPTO_TX_ID, index: 0 }))).resolves.toBeUndefined();
  });

  it("returns cached idempotent upto responses without double executing", async () => {
    const setup = makeServer({ requirePaymentIdentifier: true, authorizationTimeoutDaa: "1500" });
    const payment = makeUptoPayment(setup, {
      amount: "100",
      requestHash: "12".repeat(32),
      paymentIdentifier: "pay_7d5d747be160e280504c099d984bcfe0",
    });
    let executions = 0;

    const first = await setup.server.handlePaidRequest(requestWithPayment(payment, { paymentScheme: "upto", requestHash: "12".repeat(32) }), async () => {
      executions += 1;
      return { body: "cached", chargedAmount: "70" };
    });
    const second = await setup.server.handlePaidRequest(requestWithPayment(payment, { paymentScheme: "upto", requestHash: "12".repeat(32) }), async () => {
      executions += 1;
      return { body: "wrong" };
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toBe("cached");
    expect(executions).toBe(1);
  });

  it("does not broadcast nonzero upto settlement when reservation persistence fails", async () => {
    const store = new FailingUptoReserveStore();
    const setup = makeServer({ store, authorizationTimeoutDaa: "1500" });
    const payment = makeUptoPayment(setup, { amount: "100", requestHash: "12".repeat(32) });

    const response = await setup.server.handlePaidRequest(requestWithPayment(payment, { paymentScheme: "upto", requestHash: "12".repeat(32) }), async () => ({
      body: "charged",
      chargedAmount: "70",
    }));

    expect(response.status).toBe(500);
    expect(setup.chain.sendCount).toBe(0);
    await expect(store.loadUptoAuthorization(authorizationScopeId({ txid: UPTO_TX_ID, index: 0 }))).resolves.toBeUndefined();
  });

  it("keeps a recoverable upto reservation when broadcast fails", async () => {
    const setup = makeServer({ authorizationTimeoutDaa: "1500" });
    setup.chain.sendFailure = new Error("node unavailable");
    const payment = makeUptoPayment(setup, { amount: "100", requestHash: "12".repeat(32) });
    let executions = 0;

    const response = await setup.server.handlePaidRequest(requestWithPayment(payment, { paymentScheme: "upto", requestHash: "12".repeat(32) }), async () => {
      executions += 1;
      return {
        body: "charged",
        chargedAmount: "70",
      };
    });

    expect(response.status).toBe(500);
    expect(setup.chain.sendCount).toBe(1);
    const pending = await setup.store.loadUptoAuthorization(authorizationScopeId({ txid: UPTO_TX_ID, index: 0 }));
    expect(pending?.status).toBe("pending");
    expect(pending?.response.status).toBe(200);

    const stillPending = await setup.server.handlePaidRequest(requestWithPayment(payment, { paymentScheme: "upto", requestHash: "12".repeat(32) }), async () => {
      executions += 1;
      return { body: "wrong" };
    });
    expect(stillPending.status).toBe(202);
    expect(stillPending.body).toEqual({ error: "upto_authorization_pending" });
    const stillPendingSettlement = decodePaymentResponseHeader(stillPending.headers[PAYMENT_RESPONSE_HEADER]);
    expect(stillPendingSettlement.success).toBe(false);
    expect(stillPendingSettlement.errorReason).toBe("upto_authorization_pending");
    expect(stillPendingSettlement.transaction).toBe(UPTO_TX_ID);
    expect(stillPendingSettlement.amount).toBe("70");
    expect(stillPendingSettlement.extra?.finality).toBe("mempool");
    expect(executions).toBe(1);
    expect(setup.chain.sendCount).toBe(2);

    setup.chain.sendFailure = undefined;
    const recovered = await setup.server.handlePaidRequest(requestWithPayment(payment, { paymentScheme: "upto", requestHash: "12".repeat(32) }), async () => {
      executions += 1;
      return { body: "wrong" };
    });
    expect(recovered.status).toBe(200);
    expect(recovered.body).toBe("charged");
    expect(executions).toBe(1);
    expect(setup.chain.sendCount).toBe(3);
  });

  it("keeps a recoverable upto broadcast when broadcast finality is insufficient", async () => {
    const setup = makeServer({ authorizationTimeoutDaa: "1500" });
    setup.chain.finality = "broadcast";
    const payment = makeUptoPayment(setup, { amount: "100", requestHash: "12".repeat(32) });
    let executions = 0;

    const response = await setup.server.handlePaidRequest(requestWithPayment(payment, { paymentScheme: "upto", requestHash: "12".repeat(32) }), async () => {
      executions += 1;
      return {
        body: "charged",
        chargedAmount: "70",
      };
    });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ error: "upto_authorization_pending" });
    const pendingSettlement = decodePaymentResponseHeader(response.headers[PAYMENT_RESPONSE_HEADER]);
    expect(pendingSettlement.success).toBe(false);
    expect(pendingSettlement.errorReason).toBe("upto_authorization_pending");
    expect(pendingSettlement.transaction).toBe(UPTO_TX_ID);
    expect(pendingSettlement.extra?.finality).toBe("mempool");
    expect(setup.chain.sendCount).toBe(1);
    const broadcast = await setup.store.loadUptoAuthorization(authorizationScopeId({ txid: UPTO_TX_ID, index: 0 }));
    expect(broadcast?.status).toBe("broadcast");
    expect(broadcast?.finality).toBe("broadcast");

    setup.chain.finality = "accepted";
    const recovered = await setup.server.handlePaidRequest(requestWithPayment(payment, { paymentScheme: "upto", requestHash: "12".repeat(32) }), async () => {
      executions += 1;
      return { body: "wrong" };
    });
    expect(recovered.status).toBe(200);
    expect(recovered.body).toBe("charged");
    expect(executions).toBe(1);
    expect(setup.chain.sendCount).toBe(2);
  });

  it("uses pending upto payment identifiers to block fresh authorization retries", async () => {
    const setup = makeServer({ requirePaymentIdentifier: true, authorizationTimeoutDaa: "1500" });
    setup.chain.finality = "broadcast";
    const paymentIdentifier = "pay_7d5d747be160e280504c099d984bcfe0";
    const first = makeUptoPayment(setup, {
      amount: "100",
      requestHash: "12".repeat(32),
      paymentIdentifier,
      index: 0,
      nonce: "33".repeat(32),
    });
    const second = makeUptoPayment(setup, {
      amount: "100",
      requestHash: "12".repeat(32),
      paymentIdentifier,
      index: 1,
      nonce: "34".repeat(32),
    });
    let executions = 0;

    const pending = await setup.server.handlePaidRequest(requestWithPayment(first, { paymentScheme: "upto", requestHash: "12".repeat(32) }), async () => {
      executions += 1;
      return { body: "charged", chargedAmount: "70" };
    });
    const retry = await setup.server.handlePaidRequest(requestWithPayment(second, { paymentScheme: "upto", requestHash: "12".repeat(32) }), async () => {
      executions += 1;
      return { body: "wrong" };
    });

    expect(pending.status).toBe(202);
    expect(retry.status).toBe(202);
    expect(retry.body).toEqual({ error: "upto_authorization_pending" });
    expect(executions).toBe(1);
    expect(setup.chain.sendCount).toBe(2);
  });

  it("does not release recovered upto content to a mismatched same-id retry", async () => {
    const setup = makeServer({ requirePaymentIdentifier: true, authorizationTimeoutDaa: "1500" });
    setup.chain.finality = "broadcast";
    const paymentIdentifier = "pay_7d5d747be160e280504c099d984bcfe2";
    const first = makeUptoPayment(setup, {
      amount: "100",
      requestHash: "12".repeat(32),
      paymentIdentifier,
      index: 0,
      nonce: "33".repeat(32),
    });
    const second = makeUptoPayment(setup, {
      amount: "100",
      requestHash: "12".repeat(32),
      paymentIdentifier,
      index: 1,
      nonce: "34".repeat(32),
    });
    let executions = 0;

    const pending = await setup.server.handlePaidRequest(requestWithPayment(first, { paymentScheme: "upto", requestHash: "12".repeat(32) }), async () => {
      executions += 1;
      return { body: "charged", chargedAmount: "70" };
    });
    setup.chain.finality = "accepted";
    const retry = await setup.server.handlePaidRequest(requestWithPayment(second, { paymentScheme: "upto", requestHash: "12".repeat(32) }), async () => {
      executions += 1;
      return { body: "wrong" };
    });

    expect(pending.status).toBe(202);
    expect(retry.status).toBe(409);
    expect(retry.body).toEqual({ error: "payment_identifier_conflict" });
    expect(executions).toBe(1);
    expect(setup.chain.sendCount).toBe(2);
    const settled = await setup.store.loadUptoAuthorization(authorizationScopeId({ txid: UPTO_TX_ID, index: 0 }));
    expect(settled?.status).toBe("settled");
  });

  it("recovers pending upto identifiers with the original finality requirement", async () => {
    const setup = makeServer({ requirePaymentIdentifier: true, acceptedFinality: "confirmed", authorizationTimeoutDaa: "1500" });
    setup.chain.finality = "accepted";
    const paymentIdentifier = "pay_7d5d747be160e280504c099d984bcfe1";
    const first = makeUptoPayment(setup, {
      amount: "100",
      requestHash: "12".repeat(32),
      paymentIdentifier,
      index: 0,
      nonce: "33".repeat(32),
    });
    setup.chain.setUtxo({
      outpoint: { txid: UPTO_TX_ID, index: 0 },
      amount: "100",
      scriptPublicKey: UPTO_SCRIPT,
      finality: "confirmed",
    });
    const retry = makeUptoPayment(setup, {
      amount: "100",
      requestHash: "12".repeat(32),
      paymentIdentifier,
      index: 1,
      nonce: "34".repeat(32),
    });
    (retry.accepted as UptoPaymentRequirements).extra.finality = "accepted";
    let executions = 0;

    const pending = await setup.server.handlePaidRequest(requestWithPayment(first, { paymentScheme: "upto", requestHash: "12".repeat(32) }), async () => {
      executions += 1;
      return { body: "charged", chargedAmount: "70" };
    });
    const loweredRetry = await setup.server.handlePaidRequest(requestWithPayment(retry, { paymentScheme: "upto", requestHash: "12".repeat(32) }), async () => {
      executions += 1;
      return { body: "wrong" };
    });

    expect(pending.status).toBe(202);
    expect(loweredRetry.status).toBe(202);
    expect(loweredRetry.body).toEqual({ error: "upto_authorization_pending" });
    expect(executions).toBe(1);
    expect(setup.chain.sendCount).toBe(2);
  });

  it("leaves a recoverable upto broadcast when final settlement persistence fails after broadcast", async () => {
    const store = new FailingUptoCommitStore();
    const setup = makeServer({ store, authorizationTimeoutDaa: "1500" });
    const payment = makeUptoPayment(setup, { amount: "100", requestHash: "12".repeat(32) });

    const response = await setup.server.handlePaidRequest(requestWithPayment(payment, { paymentScheme: "upto", requestHash: "12".repeat(32) }), async () => ({
      body: "charged",
      chargedAmount: "70",
    }));

    expect(response.status).toBe(500);
    expect(setup.chain.sendCount).toBe(1);
    const broadcast = await store.loadUptoAuthorization(authorizationScopeId({ txid: UPTO_TX_ID, index: 0 }));
    expect(broadcast?.status).toBe("broadcast");
    expect(broadcast?.chargedAmount).toBe("70");
    expect(broadcast?.response.status).toBe(200);
  });

  it("recovers a broadcast upto settlement on retry without re-executing the handler", async () => {
    const store = new FailingUptoCommitStore(1);
    const setup = makeServer({ store, authorizationTimeoutDaa: "1500" });
    const payment = makeUptoPayment(setup, { amount: "100", requestHash: "12".repeat(32) });
    let executions = 0;

    const first = await setup.server.handlePaidRequest(requestWithPayment(payment, { paymentScheme: "upto", requestHash: "12".repeat(32) }), async () => {
      executions += 1;
      return {
        body: "charged",
        chargedAmount: "70",
      };
    });
    const second = await setup.server.handlePaidRequest(requestWithPayment(payment, { paymentScheme: "upto", requestHash: "12".repeat(32) }), async () => {
      executions += 1;
      return { body: "wrong" };
    });

    expect(first.status).toBe(500);
    expect(second.status).toBe(200);
    expect(second.body).toBe("charged");
    expect(executions).toBe(1);
    expect(setup.chain.sendCount).toBe(1);
    const settled = await store.loadUptoAuthorization(authorizationScopeId({ txid: UPTO_TX_ID, index: 0 }));
    expect(settled?.status).toBe("settled");
  });

  it("rejects upto settlement transactions whose verified output does not pay the accepted recipient", async () => {
    const setup = makeServer({
      authorizationTimeoutDaa: "1500",
      uptoSettlementVerifier: {
        verifyUptoSettlementTransaction({ chargeAmount, payload }) {
          return {
            transactionId: UPTO_TX_ID,
            inputAmount: payload.authorizationAmountSompi,
            chargeAmount,
            feeAmount: "0",
            outputCount: 2,
            authorizationOutpoint: payload.authorizationOutpoint,
            paymentOutput: {
              outputIndex: 0,
              amount: chargeAmount,
              scriptPublicKey: "0000" + "88".repeat(32),
            },
            refundOutput: {
              outputIndex: 1,
              amount: "30",
              scriptPublicKey: "0000" + "99".repeat(32),
            },
          };
        },
      },
    });
    const payment = makeUptoPayment(setup, { amount: "100", requestHash: "12".repeat(32) });

    const response = await setup.server.handlePaidRequest(requestWithPayment(payment, { paymentScheme: "upto", requestHash: "12".repeat(32) }), async () => ({
      body: "wrong",
      chargedAmount: "70",
    }));

    expect(response.status).toBe(402);
    expect(response.body).toEqual({ error: "invalid_kaspa_transaction" });
    expect(setup.chain.sendCount).toBe(0);
  });

  it("rejects upto settlement transactions that reuse an output for payment and refund", async () => {
    const setup = makeServer({
      authorizationTimeoutDaa: "1500",
      uptoSettlementVerifier: {
        verifyUptoSettlementTransaction({ chargeAmount, payload, payToScriptPublicKey, refundScriptPublicKey }) {
          return {
            transactionId: UPTO_TX_ID,
            inputAmount: payload.authorizationAmountSompi,
            chargeAmount,
            feeAmount: "0",
            outputCount: 2,
            authorizationOutpoint: payload.authorizationOutpoint,
            paymentOutput: {
              outputIndex: 0,
              amount: chargeAmount,
              scriptPublicKey: payToScriptPublicKey,
            },
            refundOutput: {
              outputIndex: 0,
              amount: "30",
              scriptPublicKey: refundScriptPublicKey,
            },
            paymentOutputIndex: 0,
            refundOutputIndex: 0,
          };
        },
      },
    });
    const payment = makeUptoPayment(setup, { amount: "100", requestHash: "12".repeat(32) });

    const response = await setup.server.handlePaidRequest(requestWithPayment(payment, { paymentScheme: "upto", requestHash: "12".repeat(32) }), async () => ({
      body: "wrong",
      chargedAmount: "70",
    }));

    expect(response.status).toBe(402);
    expect(response.body).toEqual({ error: "invalid_kaspa_transaction" });
    expect(setup.chain.sendCount).toBe(0);
  });

  it("rejects upto settlement transactions with inconsistent flat output indexes", async () => {
    const setup = makeServer({
      authorizationTimeoutDaa: "1500",
      uptoSettlementVerifier: {
        verifyUptoSettlementTransaction({ chargeAmount, payload, payToScriptPublicKey, refundScriptPublicKey }) {
          return {
            transactionId: UPTO_TX_ID,
            inputAmount: payload.authorizationAmountSompi,
            chargeAmount,
            feeAmount: "0",
            outputCount: 2,
            authorizationOutpoint: payload.authorizationOutpoint,
            paymentOutput: {
              outputIndex: 0,
              amount: chargeAmount,
              scriptPublicKey: payToScriptPublicKey,
            },
            refundOutput: {
              outputIndex: 1,
              amount: "30",
              scriptPublicKey: refundScriptPublicKey,
            },
            paymentOutputIndex: 1,
            refundOutputIndex: 0,
          };
        },
      },
    });
    const payment = makeUptoPayment(setup, { amount: "100", requestHash: "12".repeat(32) });

    const response = await setup.server.handlePaidRequest(requestWithPayment(payment, { paymentScheme: "upto", requestHash: "12".repeat(32) }), async () => ({
      body: "wrong",
      chargedAmount: "70",
    }));

    expect(response.status).toBe(402);
    expect(response.body).toEqual({ error: "invalid_kaspa_transaction" });
    expect(setup.chain.sendCount).toBe(0);
  });

  it("returns a controlled 402 when request fingerprinting needs an explicit hash", async () => {
    const setup = makeServer();
    const payment = makeExactPayment(setup);

    const response = await setup.server.handlePaidRequest(
      requestWithPayment(payment, { paymentScheme: "exact", body: new URLSearchParams([["a", "b"]]) }),
      async () => ({ body: "wrong" }),
    );

    expect(response.status).toBe(402);
    expect(response.headers[PAYMENT_REQUIRED_HEADER]).toBeTruthy();
  });

  it("accepts an initial deposit-voucher and commits channel state after handler success", async () => {
    const setup = makeServer();
    const payment = makeDepositPayment(setup);

    const response = await setup.server.handlePaidRequest(requestWithPayment(payment.payload), async () => ({
      body: "secret",
      chargedAmount: "70",
    }));

    expect(response.status).toBe(200);
    expect(response.body).toBe("secret");
    expect(response.headers[PAYMENT_RESPONSE_HEADER]).toBeTruthy();
    const stored = await setup.store.loadChannel(payment.channelId);
    expect(stored?.chargedCumulativeAmount).toBe("70");
    expect(stored?.signedMaxClaimable).toBe("100");
    expect(stored?.lastCommitmentId).toMatch(/^[0-9a-f]{64}$/);
    const commitment = await setup.store.loadCommitment(stored!.lastCommitmentId!);
    expect(commitment?.chargedAmount).toBe("70");
    expect(commitment?.chargedCumulativeAfter).toBe("70");
    expect(commitment?.response.status).toBe(200);
  });

  it("accepts a voucher-only retry on an existing channel", async () => {
    const setup = makeServer();
    const deposit = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(requestWithPayment(deposit.payload), async () => ({ chargedAmount: "100" }));
    const channel = await requireChannel(setup.store, deposit.channelId);
    const voucher = makeVoucherPayment(setup, channel);

    const response = await setup.server.handlePaidRequest(requestWithPayment(voucher), async () => ({ body: "next", chargedAmount: "80" }));

    expect(response.status).toBe(200);
    expect(response.body).toBe("next");
    const stored = await requireChannel(setup.store, deposit.channelId);
    expect(stored.chargedCumulativeAmount).toBe("180");
    expect(stored.signedMaxClaimable).toBe("200");
  });

  it("accepts a deposit-voucher top-up into a new active outpoint", async () => {
    const setup = makeServer({
      topUpVerifier: {
        async verifyTopUp({ previous, next }) {
          return previous.channelId === next.channelId && next.activeOutpoint.txid === TOP_UP_TX;
        },
      },
    });
    const deposit = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(requestWithPayment(deposit.payload), async () => ({ chargedAmount: "100" }));
    const topUp = makeDepositPayment(setup, {
      fundingTx: TOP_UP_TX,
      fundingAmount: "1200",
      voucherAmount: "200",
    });

    const response = await setup.server.handlePaidRequest(requestWithPayment(topUp.payload), async () => ({ body: "topped", chargedAmount: "80" }));

    expect(response.status).toBe(200);
    expect(response.body).toBe("topped");
    const stored = await requireChannel(setup.store, deposit.channelId);
    expect(stored.activeOutpoint.txid).toBe(TOP_UP_TX);
    expect(stored.fundingAmount).toBe("1200");
    expect(stored.chargedCumulativeAmount).toBe("180");
    expect(stored.signedMaxClaimable).toBe("200");
  });

  it("rejects underpaid vouchers without executing the handler", async () => {
    const setup = makeServer();
    const deposit = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(requestWithPayment(deposit.payload), async () => ({ chargedAmount: "100" }));
    const channel = await requireChannel(setup.store, deposit.channelId);
    const underpaid = makeVoucherPayment(setup, channel, { voucherAmount: "150" });
    let executed = false;

    const response = await setup.server.handlePaidRequest(requestWithPayment(underpaid), async () => {
      executed = true;
      return {};
    });

    expect(response.status).toBe(402);
    expect(executed).toBe(false);
    const stored = await requireChannel(setup.store, deposit.channelId);
    expect(stored.chargedCumulativeAmount).toBe("100");
  });

  it("rejects bad voucher signatures", async () => {
    const setup = makeServer();
    const payment = makeDepositPayment(setup, { badSignature: true });
    let executed = false;

    const response = await setup.server.handlePaidRequest(requestWithPayment(payment.payload), async () => {
      executed = true;
      return {};
    });

    expect(response.status).toBe(402);
    expect(executed).toBe(false);
    await expect(setup.store.loadChannel(payment.channelId)).resolves.toBeUndefined();
  });

  it("rejects payments for the wrong funding outpoint", async () => {
    const setup = makeServer();
    const payment = makeDepositPayment(setup);
    payment.payload.payload = {
      ...payment.payload.payload,
      fundingOutpoint: {
        txid: "66".repeat(32),
        index: 0,
      },
    };

    const response = await setup.server.handlePaidRequest(requestWithPayment(payment.payload), async () => ({ body: "secret" }));

    expect(response.status).toBe(402);
    await expect(setup.store.loadChannel(payment.channelId)).resolves.toBeUndefined();
  });

  it("does not advance channel state when the handler fails", async () => {
    const setup = makeServer();
    const payment = makeDepositPayment(setup);

    const response = await setup.server.handlePaidRequest(requestWithPayment(payment.payload), async () => {
      throw new Error("handler failed");
    });

    expect(response.status).toBe(500);
    const stored = await requireChannel(setup.store, payment.channelId);
    expect(stored.chargedCumulativeAmount).toBe("0");
    expect(stored.signedMaxClaimable).toBe("100");
    expect(stored.voucherSignature).toBeTruthy();
  });

  it("preserves accepted deposit state when handler returns a non-canonical charge", async () => {
    const setup = makeServer();
    const payment = makeDepositPayment(setup);

    const response = await setup.server.handlePaidRequest(requestWithPayment(payment.payload), async () => ({ chargedAmount: "1.5" }));

    expect(response.status).toBe(402);
    const stored = await requireChannel(setup.store, payment.channelId);
    expect(stored.chargedCumulativeAmount).toBe("0");
    expect(stored.signedMaxClaimable).toBe("100");
    expect(stored.voucherSignature).toBeTruthy();
  });

  it("returns cached idempotent responses without double executing", async () => {
    const setup = makeServer({ requirePaymentIdentifier: true });
    const payment = makeDepositPayment(setup, { paymentIdentifier: "pay_7d5d747be160e280504c099d984bcfe0" });
    let executions = 0;

    const first = await setup.server.handlePaidRequest(requestWithPayment(payment.payload, { requestHash: "aa".repeat(32) }), async () => {
      executions += 1;
      return { body: "cached", chargedAmount: "50" };
    });
    const second = await setup.server.handlePaidRequest(requestWithPayment(payment.payload, { requestHash: "aa".repeat(32) }), async () => {
      executions += 1;
      return { body: "wrong" };
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toBe("cached");
    expect(executions).toBe(1);
  });

  it("rejects changed payment payloads for reused payment identifiers", async () => {
    const setup = makeServer({ requirePaymentIdentifier: true });
    const paymentIdentifier = "pay_7d5d747be160e280504c099d984bcfe0";
    const deposit = makeDepositPayment(setup, { paymentIdentifier });
    let executions = 0;

    const first = await setup.server.handlePaidRequest(requestWithPayment(deposit.payload, { requestHash: "aa".repeat(32) }), async () => {
      executions += 1;
      return { body: "cached", chargedAmount: "50" };
    });
    const channel = await requireChannel(setup.store, deposit.channelId);
    const refreshed = makeVoucherPayment(setup, channel, { paymentIdentifier });
    const second = await setup.server.handlePaidRequest(requestWithPayment(refreshed, { requestHash: "aa".repeat(32) }), async () => {
      executions += 1;
      return { body: "wrong" };
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: "payment_identifier_conflict" });
    expect(executions).toBe(1);
    const stored = await requireChannel(setup.store, deposit.channelId);
    expect(stored.chargedCumulativeAmount).toBe("50");
  });

  it("does not return cached content for a different payment payload", async () => {
    const setup = makeServer({ requirePaymentIdentifier: true });
    const payment = makeDepositPayment(setup, { paymentIdentifier: "pay_7d5d747be160e280504c099d984bcfe0" });
    await setup.server.handlePaidRequest(requestWithPayment(payment.payload, { requestHash: "aa".repeat(32) }), async () => ({
      body: "cached",
      chargedAmount: "50",
    }));
    const tampered = structuredClone(payment.payload);
    if (tampered.payload.type !== "deposit-voucher") throw new Error("expected deposit-voucher");
    tampered.payload.voucher.signature = "ff".repeat(64);
    let executed = false;

    const response = await setup.server.handlePaidRequest(requestWithPayment(tampered, { requestHash: "aa".repeat(32) }), async () => {
      executed = true;
      return { body: "wrong" };
    });

    expect(response.status).toBe(409);
    expect(executed).toBe(false);
  });

  it("does not commit charge or idempotency when atomic settlement persistence fails", async () => {
    const store = new FailingCommitStore();
    const setup = makeServer({ requirePaymentIdentifier: true, store });
    const paymentIdentifier = "pay_7d5d747be160e280504c099d984bcfe0";
    const payment = makeDepositPayment(setup, { paymentIdentifier });

    const response = await setup.server.handlePaidRequest(requestWithPayment(payment.payload, { requestHash: "aa".repeat(32) }), async () => ({
      body: "cached",
      chargedAmount: "50",
    }));

    expect(response.status).toBe(500);
    await expect(setup.store.loadChannel(payment.channelId)).resolves.toBeUndefined();
    await expect(setup.store.loadPaymentIdentifier(paymentIdentifier)).resolves.toBeUndefined();
  });

  it("rejects reused payment identifiers with a different fingerprint", async () => {
    const setup = makeServer({ requirePaymentIdentifier: true });
    const payment = makeDepositPayment(setup, { paymentIdentifier: "pay_7d5d747be160e280504c099d984bcfe0" });
    await setup.server.handlePaidRequest(requestWithPayment(payment.payload, { requestHash: "aa".repeat(32) }), async () => ({
      chargedAmount: "50",
    }));

    const conflict = await setup.server.handlePaidRequest(requestWithPayment(payment.payload, { requestHash: "bb".repeat(32) }), async () => ({
      body: "wrong",
    }));

    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({ error: "payment_identifier_conflict" });
  });

  it("serializes same identifier retries across channels", async () => {
    const setup = makeServer({ requirePaymentIdentifier: true });
    const first = makeDepositPayment(setup, {
      paymentIdentifier: "pay_7d5d747be160e280504c099d984bcfe0",
      salt: "33".repeat(32),
    });
    const second = makeDepositPayment(setup, {
      paymentIdentifier: "pay_7d5d747be160e280504c099d984bcfe0",
      salt: "34".repeat(32),
      fundingTx: "88".repeat(32),
    });
    let executions = 0;

    const [a, b] = await Promise.all([
      setup.server.handlePaidRequest(requestWithPayment(first.payload, { requestHash: "aa".repeat(32) }), async () => {
        executions += 1;
        return { chargedAmount: "50" };
      }),
      setup.server.handlePaidRequest(requestWithPayment(second.payload, { requestHash: "aa".repeat(32) }), async () => {
        executions += 1;
        return { chargedAmount: "50" };
      }),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(executions).toBe(1);
  });

  it("rejects reused payment identifiers on a different channel", async () => {
    const setup = makeServer({ requirePaymentIdentifier: true });
    const first = makeDepositPayment(setup, {
      paymentIdentifier: "pay_7d5d747be160e280504c099d984bcfe0",
      salt: "33".repeat(32),
    });
    const second = makeDepositPayment(setup, {
      paymentIdentifier: "pay_7d5d747be160e280504c099d984bcfe0",
      salt: "34".repeat(32),
      fundingTx: "88".repeat(32),
    });
    await setup.server.handlePaidRequest(requestWithPayment(first.payload, { requestHash: "aa".repeat(32) }), async () => ({
      chargedAmount: "50",
    }));

    const conflict = await setup.server.handlePaidRequest(requestWithPayment(second.payload, { requestHash: "aa".repeat(32) }), async () => ({
      body: "wrong",
    }));

    expect(conflict.status).toBe(409);
  });

  it("accepts a retry that selected a corrective channel-state offer", async () => {
    const setup = makeServer();
    const deposit = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(requestWithPayment(deposit.payload), async () => ({ chargedAmount: "100" }));
    const channel = await requireChannel(setup.store, deposit.channelId);
    const underpaid = makeVoucherPayment(setup, channel, { voucherAmount: "150" });

    const corrective = await setup.server.handlePaidRequest(requestWithPayment(underpaid), async () => ({ body: "wrong" }));
    expect(corrective.status).toBe(402);
    const required = decodePaymentRequiredHeader(corrective.headers[PAYMENT_REQUIRED_HEADER]);
    const accepted = required.accepts[0] as BatchPaymentRequirements;
    const retry = makeVoucherPayment(setup, channel, { accepted, voucherAmount: "200" });

    const response = await setup.server.handlePaidRequest(requestWithPayment(retry), async () => ({ chargedAmount: "25" }));

    expect(response.status).toBe(200);
    const updated = await requireChannel(setup.store, deposit.channelId);
    expect(updated.chargedCumulativeAmount).toBe("125");
  });

  it("accepts custom per-request payment amounts emitted by the server", async () => {
    const setup = makeServer({ amount: "100" });
    const required = setup.server.buildPaymentRequired({ resource: RESOURCE, amount: "75" });
    const accepted = required.accepts[0] as BatchPaymentRequirements;
    const payment = makeDepositPayment(setup, { accepted, voucherAmount: "75" });

    const response = await setup.server.handlePaidRequest(requestWithPayment(payment.payload, { paymentAmount: "75" }), async () => ({
      body: "custom",
      chargedAmount: "75",
    }));

    expect(response.status).toBe(200);
    expect(response.body).toBe("custom");
    const stored = await requireChannel(setup.store, payment.channelId);
    expect(stored.chargedCumulativeAmount).toBe("75");
  });

  it("rejects custom amount retries that do not declare the expected payment amount", async () => {
    const setup = makeServer({ amount: "100" });
    const required = setup.server.buildPaymentRequired({ resource: RESOURCE, amount: "75" });
    const accepted = required.accepts[0] as BatchPaymentRequirements;
    const payment = makeDepositPayment(setup, { accepted, voucherAmount: "75" });

    const response = await setup.server.handlePaidRequest(requestWithPayment(payment.payload), async () => ({ body: "wrong" }));

    expect(response.status).toBe(402);
    await expect(setup.store.loadChannel(payment.channelId)).resolves.toBeUndefined();
  });

  it("preserves custom per-request amounts in corrective responses", async () => {
    const setup = makeServer({ amount: "100" });
    const required = setup.server.buildPaymentRequired({ resource: RESOURCE, amount: "75" });
    const accepted = required.accepts[0] as BatchPaymentRequirements;
    const payment = makeDepositPayment(setup, { accepted, voucherAmount: "74" });

    const response = await setup.server.handlePaidRequest(requestWithPayment(payment.payload, { paymentAmount: "75" }), async () => ({
      body: "wrong",
    }));

    expect(response.status).toBe(402);
    const corrective = decodePaymentRequiredHeader(response.headers[PAYMENT_REQUIRED_HEADER]);
    expect(corrective.accepts[0]?.amount).toBe("75");
  });

  it("rejects voucher-only payments when stored channel terms no longer match the server", async () => {
    const store = new MemoryServerChannelStore();
    const firstServer = makeServer({ store });
    const deposit = makeDepositPayment(firstServer);
    await firstServer.server.handlePaidRequest(requestWithPayment(deposit.payload), async () => ({ chargedAmount: "100" }));
    const channel = await requireChannel(store, deposit.channelId);
    const changedServer = makeServer({ store, payTo: "kaspatest:changed-payout" });
    const voucher = makeVoucherPayment(changedServer, channel);
    let executed = false;

    const response = await changedServer.server.handlePaidRequest(requestWithPayment(voucher), async () => {
      executed = true;
      return { body: "wrong" };
    });

    expect(response.status).toBe(402);
    expect(executed).toBe(false);
  });

  it("rejects deposits below the advertised minimum", async () => {
    const setup = makeServer({ amount: "10", minDepositSompi: "100" });
    const payment = makeDepositPayment(setup, { fundingAmount: "50", voucherAmount: "10" });

    const response = await setup.server.handlePaidRequest(requestWithPayment(payment.payload), async () => ({ body: "wrong" }));

    expect(response.status).toBe(402);
    await expect(setup.store.loadChannel(payment.channelId)).resolves.toBeUndefined();
  });

  it("does not reactivate non-active channels from a deposit payload", async () => {
    const setup = makeServer();
    const deposit = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(requestWithPayment(deposit.payload), async () => ({ chargedAmount: "70" }));
    const retired = await requireChannel(setup.store, deposit.channelId);
    await setup.store.saveChannel({ ...retired, status: "retired" });
    const retry = makeDepositPayment(setup, { voucherAmount: "170" });

    const response = await setup.server.handlePaidRequest(requestWithPayment(retry.payload), async () => ({ body: "wrong" }));

    expect(response.status).toBe(402);
    const stored = await requireChannel(setup.store, deposit.channelId);
    expect(stored.status).toBe("retired");
  });

  it("omits corrective channel state for non-active channels", async () => {
    const setup = makeServer();
    const deposit = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(requestWithPayment(deposit.payload), async () => ({ chargedAmount: "70" }));
    const channel = await requireChannel(setup.store, deposit.channelId);
    await setup.store.saveChannel({ ...channel, status: "retired" });
    const voucher = makeVoucherPayment(setup, channel);

    const response = await setup.server.handlePaidRequest(requestWithPayment(voucher), async () => ({ body: "wrong" }));

    expect(response.status).toBe(402);
    const required = decodePaymentRequiredHeader(response.headers[PAYMENT_REQUIRED_HEADER]);
    const accepted = required.accepts[0] as BatchPaymentRequirements;
    expect(accepted.extra.channelState).toBeUndefined();
    expect(accepted.extra.voucherState).toBeUndefined();
  });

  it("preserves accepted deposit state when post-handler settlement validation fails", async () => {
    const setup = makeServer();
    const payment = makeDepositPayment(setup);

    const response = await setup.server.handlePaidRequest(requestWithPayment(payment.payload), async () => ({ chargedAmount: "101" }));

    expect(response.status).toBe(402);
    const stored = await requireChannel(setup.store, payment.channelId);
    expect(stored.chargedCumulativeAmount).toBe("0");
    expect(stored.signedMaxClaimable).toBe("100");
    expect(stored.voucherSignature).toBeTruthy();
  });

  it("returns a controlled 402 for schema-valid payloads without channel ids", async () => {
    const setup = makeServer();
    const payload: PaymentPayload = {
      x402Version: X402_VERSION,
      accepted: {
        scheme: "exact",
        network: "kaspa:testnet-10",
        amount: "100",
        asset: "KAS",
        payTo: "kaspatest:payout",
        maxTimeoutSeconds: 60,
        extra: {
          binding: "kaspa-exact-v1",
        },
      },
      payload: {
        type: "exact-transfer",
        transaction: "ab".repeat(32),
        paymentOutputIndex: 0,
      },
    };

    const response = await setup.server.handlePaidRequest(requestWithPayment(payload), async () => ({ body: "wrong" }));

    expect(response.status).toBe(402);
    expect(response.headers[PAYMENT_REQUIRED_HEADER]).toBeTruthy();
  });

  it("previews claimable channels and rejects uneconomical claims", async () => {
    const setup = makeServer();
    const payment = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(requestWithPayment(payment.payload), async () => ({ chargedAmount: "100" }));

    await expect(setup.server.listClaimableChannels()).resolves.toHaveLength(1);
    const preview = await setup.server.previewClaim(payment.channelId);
    expect(preview.claimable).toBe(true);
    expect(preview.claimAmount).toBe("100");

    setup.chain.claimFee = "100";
    const dust = await setup.server.previewClaim(payment.channelId);
    expect(dust.claimable).toBe(false);
  });

  it("rejects vouchers that consume the required claim reserve", async () => {
    const setup = makeServer({ minDepositSompi: "1000", amount: "995" });
    setup.chain.claimFee = "10";
    const payment = makeDepositPayment(setup, { voucherAmount: "995" });
    let executed = false;

    const response = await setup.server.handlePaidRequest(requestWithPayment(payment.payload), async () => {
      executed = true;
      return { body: "wrong" };
    });

    expect(response.status).toBe(402);
    expect(executed).toBe(false);
    await expect(setup.store.loadChannel(payment.channelId)).resolves.toBeUndefined();
  });

  it("does not treat claim timing policy as active funding reserve", async () => {
    const setup = makeServer({
      minDepositSompi: "1000",
      amount: "990",
      claimPolicy: { claimWhenUnclaimedAmountExceeds: "500" },
    });
    setup.chain.claimFee = "10";
    const payment = makeDepositPayment(setup, { voucherAmount: "990" });

    const response = await setup.server.handlePaidRequest(requestWithPayment(payment.payload), async () => ({ chargedAmount: "990" }));

    expect(response.status).toBe(200);
    const stored = await requireChannel(setup.store, payment.channelId);
    expect(stored.chargedCumulativeAmount).toBe("990");
  });

  it("rejects claim previews for non-active channels", async () => {
    const setup = makeServer();
    const payment = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(requestWithPayment(payment.payload), async () => ({ chargedAmount: "100" }));
    const channel = await requireChannel(setup.store, payment.channelId);
    await setup.store.saveChannel({ ...channel, status: "retired" });

    await expect(setup.server.previewClaim(payment.channelId)).rejects.toThrow("channel is not active");
  });

  it("executes accepted claim hooks and moves to a continuation outpoint", async () => {
    const setup = makeServer({
      claimBuilder: {
        async buildClaimTransaction({ claimAmount }) {
          return {
            transaction: "ab".repeat(32),
            claimAmount,
            continuationOutpoint: { txid: CLAIM_TX, index: 1 },
            continuationScriptPublicKey: "0000" + "77".repeat(34),
            continuationFundingAmount: "900",
          };
        },
      },
    });
    const payment = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(requestWithPayment(payment.payload), async () => ({ chargedAmount: "100" }));
    setup.chain.setUtxo({
      outpoint: { txid: CLAIM_TX, index: 1 },
      amount: "900",
      scriptPublicKey: "0000" + "77".repeat(34),
      finality: "confirmed",
    });

    const claim = await setup.server.executeClaim(payment.channelId);

    expect(claim.accepted).toBe(true);
    expect(claim.transactionId).toBe(CLAIM_TX);
    expect(claim.finality).toBe("confirmed");
    expect(claim.channel.claimedCumulativeAmount).toBe("100");
    expect(claim.channel.signedMaxClaimable).toBe("0");
    await expect(setup.store.loadOpenClaimAttempt(payment.channelId)).resolves.toBeUndefined();
  });

  it("does not mutate claim state when atomic claim apply fails", async () => {
    const store = new FailingApplyClaimStore();
    const setup = makeServer({
      store,
      claimBuilder: {
        async buildClaimTransaction({ claimAmount }) {
          return {
            transaction: "ab".repeat(32),
            claimAmount,
            continuationOutpoint: { txid: CLAIM_TX, index: 1 },
            continuationScriptPublicKey: "0000" + "77".repeat(34),
            continuationFundingAmount: "900",
          };
        },
      },
    });
    const payment = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(requestWithPayment(payment.payload), async () => ({ chargedAmount: "100" }));
    setup.chain.setUtxo({
      outpoint: { txid: CLAIM_TX, index: 1 },
      amount: "900",
      scriptPublicKey: "0000" + "77".repeat(34),
      finality: "accepted",
    });

    await expect(setup.server.executeClaim(payment.channelId)).rejects.toThrow("claim apply unavailable");
    const stored = await requireChannel(setup.store, payment.channelId);
    expect(stored.claimedCumulativeAmount).toBe("0");
    const attempt = await setup.store.loadOpenClaimAttempt(payment.channelId);
    expect(attempt?.status).toBe("accepted");
  });

  it("does not mutate claim state when continuation UTXO verification fails", async () => {
    const setup = makeServer({
      claimBuilder: {
        async buildClaimTransaction({ claimAmount }) {
          return {
            transaction: "ab".repeat(32),
            claimAmount,
            continuationOutpoint: { txid: CLAIM_TX, index: 1 },
            continuationScriptPublicKey: "0000" + "77".repeat(34),
            continuationFundingAmount: "900",
          };
        },
      },
    });
    const payment = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(requestWithPayment(payment.payload), async () => ({ chargedAmount: "100" }));

    await expect(setup.server.executeClaim(payment.channelId)).rejects.toThrow("funding outpoint");
    const stored = await requireChannel(setup.store, payment.channelId);
    expect(stored.claimedCumulativeAmount).toBe("0");
    const attempt = await setup.store.loadOpenClaimAttempt(payment.channelId);
    expect(attempt?.status).toBe("broadcast");
    expect(attempt?.finality).toBe("accepted");
    expect(attempt?.transactionId).toBe(CLAIM_TX);
    expect(attempt?.continuationOutpoint).toEqual({ txid: CLAIM_TX, index: 1 });
    await expect(setup.server.executeClaim(payment.channelId)).rejects.toThrow("claim attempt is already pending");
    setup.chain.setUtxo({
      outpoint: { txid: CLAIM_TX, index: 1 },
      amount: "900",
      scriptPublicKey: "0000" + "77".repeat(34),
      finality: "accepted",
    });

    const recovered = await setup.server.recoverAcceptedClaim(payment.channelId);

    expect(recovered.accepted).toBe(true);
    expect(recovered.channel.claimedCumulativeAmount).toBe("100");
    await expect(setup.store.loadOpenClaimAttempt(payment.channelId)).resolves.toBeUndefined();
  });

  it("blocks new payments while an accepted claim waits for recovery", async () => {
    const setup = makeServer({
      claimBuilder: {
        async buildClaimTransaction({ claimAmount }) {
          return {
            transaction: "ab".repeat(32),
            claimAmount,
            continuationOutpoint: { txid: CLAIM_TX, index: 1 },
            continuationScriptPublicKey: "0000" + "77".repeat(34),
            continuationFundingAmount: "900",
          };
        },
      },
    });
    const payment = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(requestWithPayment(payment.payload), async () => ({ chargedAmount: "100" }));
    await expect(setup.server.executeClaim(payment.channelId)).rejects.toThrow("funding outpoint");
    const channel = await requireChannel(setup.store, payment.channelId);
    const voucher = makeVoucherPayment(setup, channel);

    const paid = await setup.server.handlePaidRequest(requestWithPayment(voucher), async () => ({ body: "wrong" }));

    expect(paid.status).toBe(402);
    const stored = await requireChannel(setup.store, payment.channelId);
    expect(stored.chargedCumulativeAmount).toBe("100");
  });

  it("rejects accepted claim recovery when the channel epoch changed", async () => {
    const setup = makeServer({
      claimBuilder: {
        async buildClaimTransaction({ claimAmount }) {
          return {
            transaction: "ab".repeat(32),
            claimAmount,
            continuationOutpoint: { txid: CLAIM_TX, index: 1 },
            continuationScriptPublicKey: "0000" + "77".repeat(34),
            continuationFundingAmount: "900",
          };
        },
      },
    });
    const payment = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(requestWithPayment(payment.payload), async () => ({ chargedAmount: "100" }));
    await expect(setup.server.executeClaim(payment.channelId)).rejects.toThrow("funding outpoint");
    const channel = await requireChannel(setup.store, payment.channelId);
    await setup.store.saveChannel({ ...channel, chargedCumulativeAmount: "150", signedMaxClaimable: "150" });
    setup.chain.setUtxo({
      outpoint: { txid: CLAIM_TX, index: 1 },
      amount: "900",
      scriptPublicKey: "0000" + "77".repeat(34),
      finality: "accepted",
    });

    await expect(setup.server.recoverAcceptedClaim(payment.channelId)).rejects.toThrow("channel state changed after claim attempt");
  });

  it("rejects accepted claim recovery when signed channel state changed", async () => {
    const setup = makeServer({
      claimBuilder: {
        async buildClaimTransaction({ claimAmount }) {
          return {
            transaction: "ab".repeat(32),
            claimAmount,
            continuationOutpoint: { txid: CLAIM_TX, index: 1 },
            continuationScriptPublicKey: "0000" + "77".repeat(34),
            continuationFundingAmount: "900",
          };
        },
      },
    });
    const payment = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(requestWithPayment(payment.payload), async () => ({ chargedAmount: "100" }));
    await expect(setup.server.executeClaim(payment.channelId)).rejects.toThrow("funding outpoint");
    const channel = await requireChannel(setup.store, payment.channelId);
    await setup.store.saveChannel({ ...channel, signedMaxClaimable: "101" });
    setup.chain.setUtxo({
      outpoint: { txid: CLAIM_TX, index: 1 },
      amount: "900",
      scriptPublicKey: "0000" + "77".repeat(34),
      finality: "accepted",
    });

    await expect(setup.server.recoverAcceptedClaim(payment.channelId)).rejects.toThrow("channel state changed before claim apply");
  });

  it("records a pending claim attempt before broadcast errors", async () => {
    const setup = makeServer({
      claimBuilder: {
        async buildClaimTransaction({ claimAmount }) {
          return {
            transaction: "ab".repeat(32),
            claimAmount,
            continuationOutpoint: { txid: CLAIM_TX, index: 1 },
            continuationScriptPublicKey: "0000" + "77".repeat(34),
            continuationFundingAmount: "900",
          };
        },
      },
    });
    const payment = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(requestWithPayment(payment.payload), async () => ({ chargedAmount: "100" }));
    setup.chain.sendFailure = new Error("node unavailable");

    await expect(setup.server.executeClaim(payment.channelId)).rejects.toThrow("node unavailable");
    const attempt = await setup.store.loadOpenClaimAttempt(payment.channelId);
    expect(attempt?.status).toBe("pending");
    expect(attempt?.continuationOutpoint).toEqual({ txid: CLAIM_TX, index: 1 });
    expect(setup.chain.sendCount).toBe(1);
    const channel = await requireChannel(setup.store, payment.channelId);
    const voucher = makeVoucherPayment(setup, channel);
    const paid = await setup.server.handlePaidRequest(requestWithPayment(voucher), async () => ({ body: "wrong" }));

    expect(paid.status).toBe(402);
    await expect(setup.server.executeClaim(payment.channelId)).rejects.toThrow("claim attempt is already pending");
    expect(setup.chain.sendCount).toBe(1);
  });

  it("recovers a pending claim after ambiguous broadcast failure with external evidence", async () => {
    const setup = makeServer({
      claimBuilder: {
        async buildClaimTransaction({ claimAmount }) {
          return {
            transaction: "ab".repeat(32),
            claimAmount,
            continuationOutpoint: { txid: CLAIM_TX, index: 1 },
            continuationScriptPublicKey: "0000" + "77".repeat(34),
            continuationFundingAmount: "900",
          };
        },
      },
    });
    const payment = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(requestWithPayment(payment.payload), async () => ({ chargedAmount: "100" }));
    setup.chain.sendFailure = new Error("node unavailable");
    await expect(setup.server.executeClaim(payment.channelId)).rejects.toThrow("node unavailable");
    setup.chain.setUtxo({
      outpoint: { txid: CLAIM_TX, index: 1 },
      amount: "900",
      scriptPublicKey: "0000" + "77".repeat(34),
      finality: "accepted",
    });

    const recovered = await setup.server.recoverAcceptedClaim(payment.channelId, {
      transactionId: CLAIM_TX,
      finality: "accepted",
    });

    expect(recovered.accepted).toBe(true);
    expect(recovered.channel.claimedCumulativeAmount).toBe("100");
    await expect(setup.store.loadOpenClaimAttempt(payment.channelId)).resolves.toBeUndefined();
  });

  it("reports verified continuation finality during claim recovery", async () => {
    const setup = makeServer({
      acceptedFinality: "confirmed",
      claimBuilder: {
        async buildClaimTransaction({ claimAmount }) {
          return {
            transaction: "ab".repeat(32),
            claimAmount,
            continuationOutpoint: { txid: CLAIM_TX, index: 1 },
            continuationScriptPublicKey: "0000" + "77".repeat(34),
            continuationFundingAmount: "900",
          };
        },
      },
    });
    const payment = makeDepositPayment(setup);
    const deposit = payment.payload.payload;
    if (deposit.type !== "deposit-voucher") throw new Error("expected deposit payload");
    setup.chain.setUtxo({
      outpoint: deposit.fundingOutpoint,
      amount: deposit.fundingAmountSompi,
      scriptPublicKey: deposit.activeScriptPublicKey,
      finality: "confirmed",
    });
    await setup.server.handlePaidRequest(requestWithPayment(payment.payload), async () => ({ chargedAmount: "100" }));
    const broadcast = await setup.server.executeClaim(payment.channelId);
    expect(broadcast.accepted).toBe(false);
    setup.chain.setUtxo({
      outpoint: { txid: CLAIM_TX, index: 1 },
      amount: "900",
      scriptPublicKey: "0000" + "77".repeat(34),
      finality: "confirmed",
    });

    const recovered = await setup.server.recoverAcceptedClaim(payment.channelId, {
      transactionId: CLAIM_TX,
      finality: "accepted",
    });

    expect(recovered.accepted).toBe(true);
    expect(recovered.finality).toBe("confirmed");
    expect(recovered.channel.claimedCumulativeAmount).toBe("100");
  });

  it("allows operators to abandon a reconciled open claim attempt before retrying", async () => {
    const setup = makeServer({
      claimBuilder: {
        async buildClaimTransaction({ claimAmount }) {
          return {
            transaction: "ab".repeat(32),
            claimAmount,
            continuationOutpoint: { txid: CLAIM_TX, index: 1 },
            continuationScriptPublicKey: "0000" + "77".repeat(34),
            continuationFundingAmount: "900",
          };
        },
      },
    });
    const payment = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(requestWithPayment(payment.payload), async () => ({ chargedAmount: "100" }));
    setup.chain.sendFailure = new Error("node unavailable");

    await expect(setup.server.executeClaim(payment.channelId)).rejects.toThrow("node unavailable");
    await setup.server.abandonClaimAttempt(payment.channelId, "operator reconciled no broadcast");
    await expect(setup.store.loadOpenClaimAttempt(payment.channelId)).resolves.toBeUndefined();
    setup.chain.sendFailure = undefined;
    setup.chain.setUtxo({
      outpoint: { txid: CLAIM_TX, index: 1 },
      amount: "900",
      scriptPublicKey: "0000" + "77".repeat(34),
      finality: "accepted",
    });

    const claim = await setup.server.executeClaim(payment.channelId);

    expect(claim.accepted).toBe(true);
    expect(setup.chain.sendCount).toBe(2);
  });

  it("recovers a broadcast claim after external acceptance evidence", async () => {
    const setup = makeServer({
      claimBuilder: {
        async buildClaimTransaction({ claimAmount }) {
          return {
            transaction: "ab".repeat(32),
            claimAmount,
            continuationOutpoint: { txid: CLAIM_TX, index: 1 },
            continuationScriptPublicKey: "0000" + "77".repeat(34),
            continuationFundingAmount: "900",
          };
        },
      },
    });
    setup.chain.finality = "broadcast";
    const payment = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(requestWithPayment(payment.payload), async () => ({ chargedAmount: "100" }));
    const broadcast = await setup.server.executeClaim(payment.channelId);
    expect(broadcast.accepted).toBe(false);
    setup.chain.setUtxo({
      outpoint: { txid: CLAIM_TX, index: 1 },
      amount: "900",
      scriptPublicKey: "0000" + "77".repeat(34),
      finality: "accepted",
    });
    await expect(
      setup.server.recoverAcceptedClaim(payment.channelId, {
        transactionId: CLAIM_TX,
        finality: "broadcast" as never,
      }),
    ).rejects.toThrow("accepted claim recovery needs accepted transaction evidence");

    const recovered = await setup.server.recoverAcceptedClaim(payment.channelId, {
      transactionId: CLAIM_TX,
      finality: "accepted",
    });

    expect(recovered.accepted).toBe(true);
    expect(recovered.channel.claimedCumulativeAmount).toBe("100");
    await expect(setup.store.loadOpenClaimAttempt(payment.channelId)).resolves.toBeUndefined();
  });

  it("rejects recovery transaction ids that conflict with a stored broadcast id", async () => {
    const otherTx = "66".repeat(32);
    const setup = makeServer({
      claimBuilder: {
        async buildClaimTransaction({ claimAmount }) {
          return {
            transaction: "ab".repeat(32),
            claimAmount,
            continuationOutpoint: { txid: CLAIM_TX, index: 1 },
            continuationScriptPublicKey: "0000" + "77".repeat(34),
            continuationFundingAmount: "900",
          };
        },
      },
    });
    setup.chain.finality = "broadcast";
    const payment = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(requestWithPayment(payment.payload), async () => ({ chargedAmount: "100" }));
    const broadcast = await setup.server.executeClaim(payment.channelId);
    expect(broadcast.transactionId).toBe(CLAIM_TX);
    setup.chain.setUtxo({
      outpoint: { txid: otherTx, index: 1 },
      amount: "900",
      scriptPublicKey: "0000" + "77".repeat(34),
      finality: "accepted",
    });

    await expect(
      setup.server.recoverAcceptedClaim(payment.channelId, {
        transactionId: otherTx,
        finality: "accepted",
      }),
    ).rejects.toThrow("does not match recorded broadcast");
  });

  it("requires continuation outpoint txid to match the accepted claim transaction", async () => {
    const otherTx = "66".repeat(32);
    const setup = makeServer({
      claimBuilder: {
        async buildClaimTransaction({ claimAmount }) {
          return {
            transaction: "ab".repeat(32),
            claimAmount,
            continuationOutpoint: { txid: otherTx, index: 1 },
            continuationScriptPublicKey: "0000" + "77".repeat(34),
            continuationFundingAmount: "900",
          };
        },
      },
    });
    const payment = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(requestWithPayment(payment.payload), async () => ({ chargedAmount: "100" }));
    setup.chain.setUtxo({
      outpoint: { txid: otherTx, index: 1 },
      amount: "900",
      scriptPublicKey: "0000" + "77".repeat(34),
      finality: "accepted",
    });

    await expect(setup.server.executeClaim(payment.channelId)).rejects.toThrow("accepted claim transaction");
    const stored = await requireChannel(setup.store, payment.channelId);
    expect(stored.claimedCumulativeAmount).toBe("0");
    const attempt = await setup.store.loadOpenClaimAttempt(payment.channelId);
    expect(attempt?.status).toBe("broadcast");
    expect(attempt?.transactionId).toBe(CLAIM_TX);
    expect(attempt?.continuationOutpoint).toEqual({ txid: otherTx, index: 1 });
    await expect(setup.server.executeClaim(payment.channelId)).rejects.toThrow("claim attempt is already pending");
    await expect(setup.server.recoverAcceptedClaim(payment.channelId)).rejects.toThrow("continuation outpoint");
    await setup.server.abandonClaimAttempt(payment.channelId, "operator rejected invalid continuation");
    await expect(setup.store.loadOpenClaimAttempt(payment.channelId)).resolves.toBeUndefined();
  });
});

function makeServer(overrides: Partial<DirectModeServerConfig> = {}) {
  const store = overrides.store ?? new MemoryServerChannelStore();
  const chain = new FakeChainProvider();
  const server = new DirectModeServer({
    network: "kaspa:testnet-10",
    payTo: "kaspatest:payout",
    serverPublicKey: SERVER_KEY,
    minDepositSompi: "1000",
    amount: "100",
    refundTimeoutDaa: "1000",
    store,
    chainProvider: chain,
    addressCodec: new FakeAddressCodec(),
    voucherVerifier: {
      verifyVoucher({ digest, voucher }) {
        return voucher.signature === `${digest}${digest}`;
      },
    },
    exactTransactionVerifier: {
      verifyExactPayment(request) {
        return {
          transactionId: request.transactionId ?? EXACT_TX_ID,
          paymentOutput: {
            amount: request.amount,
            scriptPublicKey: request.payToScriptPublicKey,
          },
          finality: "accepted",
          payerAddress: "kaspatest:refund",
        };
      },
    },
    uptoScriptDeriver: {
      deriveAuthorizationScript() {
        return UPTO_SCRIPT;
      },
    },
    uptoAuthorizationVerifier: {
      verifyUptoAuthorization({ digest, payload }) {
        return payload.authorization.signature === `${digest}${digest}`;
      },
    },
    uptoSettlementBuilder: {
      async buildUptoSettlementTransaction() {
        return {
          transaction: "cd".repeat(32),
        };
      },
    },
    uptoSettlementVerifier: {
      verifyUptoSettlementTransaction({ chargeAmount, payload, payToScriptPublicKey, refundScriptPublicKey }) {
        const refundAmount = (BigInt(payload.authorizationAmountSompi) - BigInt(chargeAmount)).toString();
        return {
          transactionId: UPTO_TX_ID,
          inputAmount: payload.authorizationAmountSompi,
          chargeAmount,
          feeAmount: "0",
          outputCount: refundAmount === "0" ? 1 : 2,
          authorizationOutpoint: payload.authorizationOutpoint,
          paymentOutput: {
            outputIndex: 0,
            amount: chargeAmount,
            scriptPublicKey: payToScriptPublicKey,
          },
          ...(refundAmount !== "0"
            ? {
                refundOutput: {
                  outputIndex: 1,
                  amount: refundAmount,
                  scriptPublicKey: refundScriptPublicKey,
                },
              }
            : {}),
          paymentOutputIndex: 0,
          refundOutputIndex: 1,
        };
      },
    },
    ...overrides,
  });
  return {
    server,
    store,
    chain,
    voucherVerifier: {
      verifyVoucher({ digest, voucher }: { digest: string; voucher: { signature: string } }) {
        return voucher.signature === `${digest}${digest}`;
      },
    },
  };
}

function makeExactPayment(
  setup: ReturnType<typeof makeServer>,
  options: { paymentIdentifier?: string; transactionId?: Hash32Hex; paymentOutputIndex?: number; requestHash?: Hash32Hex } = {},
): PaymentPayload {
  const required = setup.server.buildPaymentRequired({ resource: RESOURCE, scheme: "exact" });
  const accepted = required.accepts[0] as ExactPaymentRequirements;
  return {
    x402Version: X402_VERSION,
    accepted,
    payload: {
      type: "exact-transfer",
      payerAddress: "kaspatest:refund",
      transaction: EXACT_TX,
      transactionId: options.transactionId ?? EXACT_TX_ID,
      paymentOutputIndex: options.paymentOutputIndex ?? 1,
      ...(options.requestHash ? { requestHash: options.requestHash } : {}),
    },
    ...(options.paymentIdentifier ? paymentIdentifierExtension(options.paymentIdentifier) : {}),
  };
}

function makeUptoPayment(
  setup: ReturnType<typeof makeServer>,
  options: {
    amount: string;
    requestHash: Hash32Hex;
    paymentIdentifier?: string;
    index?: number;
    nonce?: Hash32Hex;
    payTo?: string;
    serverPublicKey?: string;
    maxAmount?: string;
    badSignature?: boolean;
  },
): PaymentPayload {
  const required = setup.server.buildPaymentRequired({ resource: RESOURCE, scheme: "upto", amount: options.amount });
  const accepted = structuredClone(required.accepts[0]) as UptoPaymentRequirements;
  const index = options.index ?? 0;
  const nonce = options.nonce ?? SALT;
  const outpoint = { txid: UPTO_TX_ID, index };
  const authorization = {
    maxAmountSompi: options.maxAmount ?? accepted.amount,
    payTo: options.payTo ?? accepted.payTo,
    validAfterDaa: "900",
    validBeforeDaa: accepted.extra.authorizationTimeoutDaa,
    nonce,
    serverPublicKey: options.serverPublicKey ?? accepted.extra.serverPublicKey,
    requestHash: options.requestHash,
  };
  const digest = uptoAuthorizationDigest({
    network: accepted.network,
    payTo: authorization.payTo,
    refundAddress: "kaspatest:refund",
    clientPublicKey: CLIENT_KEY,
    serverPublicKey: authorization.serverPublicKey,
    authorizationOutpoint: outpoint,
    maxAmountSompi: authorization.maxAmountSompi,
    validAfterDaa: authorization.validAfterDaa,
    validBeforeDaa: authorization.validBeforeDaa,
    nonce,
    requestHash: options.requestHash,
  });
  setup.chain.setUtxo({
    outpoint,
    amount: accepted.amount,
    scriptPublicKey: UPTO_SCRIPT,
    finality: "accepted",
  });
  return {
    x402Version: X402_VERSION,
    accepted,
    payload: {
      type: "upto-authorization",
      clientPublicKey: CLIENT_KEY,
      authorizationOutpoint: outpoint,
      authorizationScriptPublicKey: UPTO_SCRIPT,
      authorizationAmountSompi: accepted.amount,
      refundAddress: "kaspatest:refund",
      authorization: {
        ...authorization,
        signature: options.badSignature ? "ff".repeat(64) : `${digest}${digest}`,
      },
    },
    ...(options.paymentIdentifier ? paymentIdentifierExtension(options.paymentIdentifier) : {}),
  };
}

function makeDepositPayment(
  setup: ReturnType<typeof makeServer>,
  options: {
    badSignature?: boolean;
    paymentIdentifier?: string;
    accepted?: BatchPaymentRequirements;
    salt?: Hash32Hex;
    fundingTx?: Hash32Hex;
    fundingAmount?: string;
    voucherAmount?: string;
  } = {},
): { payload: PaymentPayload; channelId: Hash32Hex } {
  const required = setup.server.buildPaymentRequired({ resource: RESOURCE });
  const accepted = options.accepted ?? (required.accepts[0] as BatchPaymentRequirements);
  const channelConfig: ChannelConfig = {
    network: accepted.network,
    asset: "KAS",
    templateId: "kaspa-x402-escrow-v1",
    clientPublicKey: CLIENT_KEY,
    serverPublicKey: SERVER_KEY,
    payTo: accepted.payTo,
    refundAddress: "kaspatest:refund",
    refundTimeoutDaa: accepted.extra.refundTimeoutDaa,
    salt: options.salt ?? SALT,
  };
  const derived = deriveEscrow(channelConfig);
  const id = channelId(channelConfig);
  const fundingOutpoint = { txid: options.fundingTx ?? FUNDING_TX, index: 0 };
  const fundingAmount = options.fundingAmount ?? accepted.extra.minDepositSompi;
  setup.chain.setUtxo({
    outpoint: fundingOutpoint,
    amount: fundingAmount,
    scriptPublicKey: derived.activeScriptPublicKey,
    finality: "accepted",
  });
  const voucher = signVoucher({
    network: accepted.network,
    activeScriptPublicKey: derived.activeScriptPublicKey,
    outpoint: fundingOutpoint,
    amount: options.voucherAmount ?? accepted.amount,
    badSignature: options.badSignature,
  });
  return {
    channelId: id,
    payload: {
      x402Version: X402_VERSION,
      accepted,
      payload: {
        type: "deposit-voucher",
        channelConfig,
        channelId: id,
        escrowAddress: derived.escrowAddress,
        fundingOutpoint,
        fundingAmountSompi: fundingAmount,
        activeScriptPublicKey: derived.activeScriptPublicKey,
        voucher,
      },
      ...(options.paymentIdentifier ? paymentIdentifierExtension(options.paymentIdentifier) : {}),
    },
  };
}

function makeVoucherPayment(
  setup: ReturnType<typeof makeServer>,
  channel: ServerChannelRecord,
  options: { voucherAmount?: string; accepted?: BatchPaymentRequirements; paymentIdentifier?: string } = {},
): PaymentPayload {
  const required = setup.server.buildPaymentRequired({ resource: RESOURCE });
  const accepted = options.accepted ?? (required.accepts[0] as BatchPaymentRequirements);
  const amount = options.voucherAmount ?? (BigInt(channel.chargedCumulativeAmount) - BigInt(channel.claimedCumulativeAmount) + BigInt(accepted.amount)).toString();
  return {
    x402Version: X402_VERSION,
    accepted,
    payload: {
      type: "voucher",
      channelId: channel.channelId,
      clientPublicKey: channel.channelConfig.clientPublicKey,
      fundingOutpoint: channel.activeOutpoint,
      activeScriptPublicKey: channel.activeScriptPublicKey,
      voucher: signVoucher({
        network: accepted.network,
        activeScriptPublicKey: channel.activeScriptPublicKey,
        outpoint: channel.activeOutpoint,
        amount,
      }),
    },
    ...(options.paymentIdentifier ? paymentIdentifierExtension(options.paymentIdentifier) : {}),
  };
}

function requestWithPayment(
  paymentPayload: PaymentPayload,
  options: { requestHash?: Hash32Hex; paymentAmount?: string; paymentScheme?: "exact" | "upto" | "batch-settlement"; body?: unknown } = {},
) {
  return {
    url: RESOURCE.url,
    resource: RESOURCE,
    body: options.body,
    paymentAmount: options.paymentAmount,
    paymentScheme: options.paymentScheme,
    requestHash: options.requestHash,
    headers: {
      [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader(paymentPayload),
    },
  };
}

async function requireChannel(store: ServerChannelStore, channelId: Hash32Hex): Promise<ServerChannelRecord> {
  const channel = await store.loadChannel(channelId);
  if (!channel) throw new Error("missing channel");
  return channel;
}

function paymentIdentifierExtension(id: string) {
  return {
    extensions: {
      "payment-identifier": {
        info: {
          required: true,
          id,
        },
      },
    },
  };
}

function deriveEscrow(channelConfig: ChannelConfig): { escrowAddress: string; activeScriptPublicKey: string } {
  const addressCodec = new FakeAddressCodec();
  const payoutScriptPublicKeyHash = sha256Hex(hexBytes(addressCodec.scriptPublicKeyForAddress(channelConfig.payTo, channelConfig.network)));
  const refundScriptPublicKeyHash = sha256Hex(hexBytes(addressCodec.scriptPublicKeyForAddress(channelConfig.refundAddress, channelConfig.network)));
  const params = {
    clientPublicKey: channelConfig.clientPublicKey,
    serverPublicKey: channelConfig.serverPublicKey,
    network: channelConfig.network,
    payoutScriptPublicKeyHash,
    refundScriptPublicKeyHash,
    timeoutDaa: channelConfig.refundTimeoutDaa,
  };
  const script = escrowScriptPublicKey(params);
  return {
    escrowAddress: deriveEscrowAddress(params, (input) => addressCodec.encodeScriptAddress(input)),
    activeScriptPublicKey: serializedScriptPublicKey(script),
  };
}

function signVoucher(input: {
  network: NetworkId;
  activeScriptPublicKey: string;
  outpoint: FundingOutpoint;
  amount: string;
  badSignature?: boolean;
}) {
  const digest = voucherDigest(input);
  return {
    amount: input.amount,
    signature: input.badSignature ? "ff".repeat(64) : `${digest}${digest}`,
  };
}

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

class FakeAddressCodec implements AddressCodec {
  scriptPublicKeyForAddress(address: string, _network: NetworkId): string {
    return `0000${sha256Hex(address)}`;
  }

  encodeScriptAddress(input: { serializedScriptPublicKey: string }): string {
    return `kaspatest:${sha256Hex(input.serializedScriptPublicKey).slice(0, 32)}`;
  }
}

class FakeChainProvider implements ServerChainProvider {
  readonly utxos = new Map<string, ChainUtxo>();
  claimFee = "10";
  daa = "1000";
  finality: SettlementFinality = "accepted";
  sendCount = 0;
  sendFailure?: Error;

  setUtxo(utxo: ChainUtxo): void {
    this.utxos.set(outpointKey(utxo.outpoint), structuredClone(utxo));
  }

  async getUtxo(outpoint: FundingOutpoint): Promise<ChainUtxo | null> {
    return this.utxos.get(outpointKey(outpoint)) ?? null;
  }

  async getVirtualDaaScore(): Promise<string> {
    return this.daa;
  }

  async estimateClaimFee(): Promise<string> {
    return this.claimFee;
  }

  async sendTransaction(transaction: string): Promise<{ transactionId: string; finality: SettlementFinality }> {
    this.sendCount += 1;
    if (this.sendFailure) throw this.sendFailure;
    return { transactionId: transaction === "cd".repeat(32) ? UPTO_TX_ID : CLAIM_TX, finality: this.finality };
  }
}

class FailingCommitStore extends MemoryServerChannelStore {
  async commitSettlement(_record: SettlementCommit): Promise<void> {
    throw new Error("settlement store unavailable");
  }
}

class FailingUptoReserveStore extends MemoryServerChannelStore {
  async reserveUptoAuthorization(_record: UptoPendingAuthorizationRecord): Promise<void> {
    throw new Error("upto reservation unavailable");
  }
}

class FailingUptoCommitStore extends MemoryServerChannelStore {
  #remainingFailures: number;

  constructor(remainingFailures = Number.POSITIVE_INFINITY) {
    super();
    this.#remainingFailures = remainingFailures;
  }

  async commitUptoSettlement(_record: UptoSettlementCommit): Promise<void> {
    if (this.#remainingFailures > 0) {
      this.#remainingFailures -= 1;
      throw new Error("upto commit unavailable");
    }
    await super.commitUptoSettlement(_record);
  }
}

class FailingApplyClaimStore extends MemoryServerChannelStore {
  async applyClaimAttempt(_channel: ServerChannelRecord, _attempt: ClaimAttemptRecord): Promise<void> {
    throw new Error("claim apply unavailable");
  }
}

function outpointKey(outpoint: FundingOutpoint): string {
  return `${outpoint.txid}:${outpoint.index}`;
}

function authorizationScopeId(outpoint: FundingOutpoint): Hash32Hex {
  return sha256Hex(
    JSON.stringify({
      index: outpoint.index,
      scope: "kaspa:x402:upto-authorization-outpoint:v1",
      txid: outpoint.txid.toLowerCase(),
    }),
  );
}
