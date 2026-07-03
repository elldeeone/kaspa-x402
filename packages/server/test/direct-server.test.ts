import { describe, expect, it } from "vitest";

import {
  MCP_PAYMENT_META_KEY,
  MCP_PAYMENT_RESPONSE_META_KEY,
  X402_VERSION,
  channelId,
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  mcpToolCallFingerprint,
  paymentIdentifierExtension as buildPaymentIdentifierExtension,
  readKaspaSettlementExtension,
  readMcpPaymentRequired,
  readMcpPaymentResponse,
  sha256Hex,
  voucherDigest,
  type BatchPaymentRequirements,
  type ChannelConfig,
  type ExactPaymentRequirements,
  type FundingOutpoint,
  type Hash32Hex,
  type NetworkId,
  type PaymentPayload,
  type SettlementResponse,
} from "@kaspa-x402/core";
import { deriveEscrowAddress, escrowScriptPublicKey, serializedScriptPublicKey } from "@kaspa-x402/covenant";
import {
  DirectModeServer,
  MemoryServerChannelStore,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  handlePaidMcpToolCall,
  type AddressCodec,
  type ChainUtxo,
  type ClaimAttemptRecord,
  type DirectModeServerConfig,
  type ExactSettlementCommit,
  type ServerChainProvider,
  type ServerChannelRecord,
  type ServerChannelStore,
  type SettlementCommit,
  type SettlementFinality,
} from "../src/index.js";

const SERVER_KEY = "11".repeat(32);
const CLIENT_KEY = "22".repeat(32);
const SALT = "33".repeat(32);
const FUNDING_TX = "44".repeat(32);
const TOP_UP_TX = "99".repeat(32);
const CLAIM_TX = "55".repeat(32);
const EXACT_TX_ID = "77".repeat(32);
const EXACT_TX = "aa".repeat(96);
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

  it("rejects mainnet server configs unless explicitly enabled", () => {
    expect(() => makeServer({ network: "kaspa:mainnet" })).toThrow("allowMainnet");

    const { server } = makeServer({ network: "kaspa:mainnet", allowMainnet: true });
    expect(server.supportedKinds().every((kind) => kind.network === "kaspa:mainnet")).toBe(true);
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

  it("can advertise exact and batch-settlement requirements from one route", async () => {
    const { server } = makeServer({ amount: "100" });

    const response = await server.handlePaidRequest({ url: RESOURCE.url, paymentAmount: "75", paymentSchemes: ["exact", "batch-settlement"] }, async () => ({
      body: "secret",
    }));

    expect(response.status).toBe(402);
    const required = decodePaymentRequiredHeader(response.headers[PAYMENT_REQUIRED_HEADER]);
    expect(required.accepts.map((requirement) => requirement.scheme)).toEqual(["exact", "batch-settlement"]);
    expect(required.accepts.map((requirement) => requirement.amount)).toEqual(["75", "75"]);
    expect(required.accepts[0]?.extra.binding).toBe("kaspa-exact-v1");
    expect(required.accepts[1]?.extra.binding).toBe("kaspa-escrow-v1");
  });

  it("returns MCP payment requirements for unpaid tool calls", async () => {
    const setup = makeServer({ amount: "100" });
    let executed = false;

    const result = await handlePaidMcpToolCall(
      setup.server,
      { name: "download", resource: { url: "mcp://tool/download" }, amount: "75", scheme: "exact" },
      { name: "download", arguments: { id: "alpha" } },
      async () => {
        executed = true;
        return { result: { content: [{ type: "text", text: "secret" }] } };
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toBe(JSON.stringify(result.structuredContent));
    const required = readMcpPaymentRequired(result);
    expect(result.structuredContent).toEqual(required);
    expect(required?.accepts[0]?.scheme).toBe("exact");
    expect(required?.accepts[0]?.amount).toBe("75");
    expect(executed).toBe(false);
  });

  it("rejects invalid MCP payment metadata without executing the tool", async () => {
    const setup = makeServer({ amount: "100" });
    let executed = false;

    const result = await handlePaidMcpToolCall(
      setup.server,
      { name: "download", resource: { url: "mcp://tool/download" }, amount: "75", scheme: "exact" },
      { name: "download", arguments: { id: "alpha" }, _meta: { [MCP_PAYMENT_META_KEY]: { x402Version: 2 } } },
      async () => {
        executed = true;
        return { result: { content: [{ type: "text", text: "secret" }] } };
      },
    );

    expect(result.isError).toBe(true);
    const required = readMcpPaymentRequired(result);
    expect(result.structuredContent).toEqual(required);
    expect(required?.accepts[0]?.scheme).toBe("exact");
    expect(executed).toBe(false);
  });

  it("returns cached MCP paid results for idempotent retries", async () => {
    const setup = makeServer({ amount: "100" });
    const required = setup.server.buildPaymentRequired({ resource: { url: "mcp://tool/download" }, amount: "100", scheme: "exact" });
    const requestHash = mcpToolCallFingerprint({
      toolName: "download",
      arguments: { id: "same" },
      accepted: required.accepts[0] as ExactPaymentRequirements,
    });
    const payment = makeExactPayment(setup, { requestHash });
    let executions = 0;
    const params = { name: "download", arguments: { id: "same" }, _meta: { [MCP_PAYMENT_META_KEY]: payment } };

    const first = await handlePaidMcpToolCall(
      setup.server,
      { name: "download", resource: { url: "mcp://tool/download" }, amount: "100", scheme: "exact" },
      params,
      async () => {
        executions += 1;
        return { result: { content: [{ type: "text", text: "paid" }] } };
      },
    );
    const second = await handlePaidMcpToolCall(
      setup.server,
      { name: "download", resource: { url: "mcp://tool/download" }, amount: "100", scheme: "exact" },
      params,
      async () => {
        executions += 1;
        return { result: { content: [{ type: "text", text: "wrong" }] } };
      },
    );

    expect(first.content?.[0]?.text).toBe("paid");
    expect(second.content?.[0]?.text).toBe("paid");
    expect(executions).toBe(1);
  });

  it("returns terminal MCP errors without a new payment challenge", async () => {
    const setup = makeServer({ amount: "100" });
    const firstRequired = setup.server.buildPaymentRequired({ resource: { url: "mcp://tool/download" }, amount: "100", scheme: "exact" });
    const firstHash = mcpToolCallFingerprint({
      toolName: "download",
      arguments: { id: "first" },
      accepted: firstRequired.accepts[0] as ExactPaymentRequirements,
    });
    const payment = makeExactPayment(setup, { requestHash: firstHash });

    await handlePaidMcpToolCall(
      setup.server,
      { name: "download", resource: { url: "mcp://tool/download" }, amount: "100", scheme: "exact" },
      { name: "download", arguments: { id: "first" }, _meta: { [MCP_PAYMENT_META_KEY]: payment } },
      async () => ({ result: { content: [{ type: "text", text: "paid" }] } }),
    );

    const replayPayload = structuredClone(payment);
    delete replayPayload.payload.requestHash;
    const replay = await handlePaidMcpToolCall(
      setup.server,
      { name: "download", resource: { url: "mcp://tool/download" }, amount: "100", scheme: "exact" },
      { name: "download", arguments: { id: "second" }, _meta: { [MCP_PAYMENT_META_KEY]: replayPayload } },
      async () => ({ result: { content: [{ type: "text", text: "wrong" }] } }),
    );

    expect(replay.isError).toBe(true);
    expect(readMcpPaymentRequired(replay)).toBeUndefined();
    expect(replay.structuredContent).toBeUndefined();
    expect(replay.content?.[0]?.text).toBe("invalid_transaction_state");
  });

  it("returns hybrid MCP settlement failures without exposing paid tool output", async () => {
    const setup = makeServer({ amount: "100" });
    const required = setup.server.buildPaymentRequired({ resource: { url: "mcp://tool/download" }, amount: "100", scheme: "exact" });
    const requestHash = mcpToolCallFingerprint({
      toolName: "download",
      arguments: { id: "fail" },
      accepted: required.accepts[0] as ExactPaymentRequirements,
    });
    const payment = makeExactPayment(setup, { requestHash });
    const settlement: SettlementResponse = {
      success: false,
      transaction: "",
      network: "kaspa:testnet-10",
      errorReason: "invalid_transaction_state",
    };
    const fakeServer = {
      buildPaymentRequired: () => required,
      handlePaidRequest: async () => ({
        status: 500,
        headers: {
          [PAYMENT_RESPONSE_HEADER]: encodePaymentResponseHeader(settlement),
        },
        body: { secret: "must not leak" },
      }),
    } as unknown as DirectModeServer;

    const result = await handlePaidMcpToolCall(
      fakeServer,
      { name: "download", resource: { url: "mcp://tool/download" }, amount: "100", scheme: "exact" },
      { name: "download", arguments: { id: "fail" }, _meta: { [MCP_PAYMENT_META_KEY]: payment } },
      async () => ({ result: { content: [{ type: "text", text: "protected output" }] } }),
    );
    const challenge = readMcpPaymentRequired(result);

    expect(result.isError).toBe(true);
    expect(challenge?.error).toBe("invalid_transaction_state");
    expect(result.structuredContent).toEqual(challenge);
    expect(result.content?.[0]?.text).toBe(JSON.stringify(result.structuredContent));
    expect(result.content?.[0]?.text).not.toContain("protected output");
    expect(result.content?.[0]?.text).not.toContain("must not leak");
    expect(readMcpPaymentResponse(result)).toEqual(settlement);
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
    expect(readKaspaSettlementExtension(settlement)?.paymentOutputIndex).toBe(1);
    const stored = await setup.store.loadExactPayment(EXACT_TX_ID);
    expect(stored?.amount).toBe("100");
    expect(stored?.paymentOutputIndex).toBe(1);
    expect(stored?.response.status).toBe(200);
  });

  it("accepts an exact transfer selected from a mixed route", async () => {
    const setup = makeServer();
    const payment = makeExactPayment(setup);

    const response = await setup.server.handlePaidRequest(requestWithPayment(payment, { paymentSchemes: ["exact", "batch-settlement"] }), async () => ({
      body: "secret",
    }));

    expect(response.status).toBe(200);
    const settlement = decodePaymentResponseHeader(response.headers[PAYMENT_RESPONSE_HEADER]);
    expect(settlement.success).toBe(true);
    expect(settlement.transaction).toBe(EXACT_TX_ID);
    expect(settlement.amount).toBe("100");
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
    expect(response.body).toEqual({ error: "invalid_payload" });
    expect(executed).toBe(false);
    await expect(setup.store.loadExactPayment(EXACT_TX_ID)).resolves.toBeUndefined();
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

  it("lets application outbox state prevent duplicate exact side effects after commit failure", async () => {
    const store = new FailingExactCommitStore(1);
    const setup = makeServer({ requirePaymentIdentifier: true, store });
    const requestHash = "12".repeat(32);
    const paymentIdentifier = "pay_7d5d747be160e280504c099d984bcfe0";
    const payment = makeExactPayment(setup, { requestHash, paymentIdentifier });
    const outbox = new Map<string, { body: string }>();
    let handlerInvocations = 0;
    let externalEffects = 0;
    const handler = ({ paymentIdentifier: id, requestFingerprint }: { paymentIdentifier?: string; requestFingerprint: Hash32Hex }) => {
      handlerInvocations += 1;
      const key = `${id}:${requestFingerprint}`;
      const cached = outbox.get(key);
      if (cached) return cached;
      externalEffects += 1;
      const result = { body: "download" };
      outbox.set(key, result);
      return result;
    };

    const first = await setup.server.handlePaidRequest(requestWithPayment(payment, { paymentScheme: "exact", requestHash }), handler);
    const second = await setup.server.handlePaidRequest(requestWithPayment(payment, { paymentScheme: "exact", requestHash }), handler);

    expect(first.status).toBe(500);
    expect(second.status).toBe(200);
    expect(second.body).toBe("download");
    expect(handlerInvocations).toBe(2);
    expect(externalEffects).toBe(1);
    await expect(store.loadExactPayment(EXACT_TX_ID)).resolves.toBeTruthy();
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
    expect(replay.body).toEqual({ error: "invalid_transaction_state" });
    expect(executed).toBe(false);
  });

  it("rejects a second exact payment from the same transaction", async () => {
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

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(executions).toBe(1);
    expect(maxActiveHandlers).toBe(1);
    const stored = await setup.store.loadExactPayment(EXACT_TX_ID);
    expect(stored?.paymentOutputIndex === 1 || stored?.paymentOutputIndex === 2).toBe(true);
  });

  it("does not double execute mixed hinted and non-hinted exact retries", async () => {
    const setup = makeServer();
    const hinted = makeExactPayment(setup, { requestHash: "21".repeat(32) });
    const noHint = structuredClone(hinted);
    if (noHint.payload.type !== "exact-transfer") throw new Error("expected exact payload");
    delete noHint.payload.transactionId;
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
      setup.server.handlePaidRequest(requestWithPayment(hinted, { paymentScheme: "exact", requestHash: "21".repeat(32) }), handler),
      setup.server.handlePaidRequest(requestWithPayment(noHint, { paymentScheme: "exact", requestHash: "21".repeat(32) }), handler),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body).toBe("download-1");
    expect(second.body).toBe("download-1");
    expect(executions).toBe(1);
    expect(maxActiveHandlers).toBe(1);
  });

  it("rejects mixed hinted and non-hinted exact replay against another request", async () => {
    const setup = makeServer();
    const hinted = makeExactPayment(setup);
    const noHint = structuredClone(hinted);
    if (noHint.payload.type !== "exact-transfer") throw new Error("expected exact payload");
    delete noHint.payload.transactionId;
    let executions = 0;

    const [first, second] = await Promise.all([
      setup.server.handlePaidRequest(requestWithPayment(hinted, { paymentScheme: "exact", requestHash: "21".repeat(32) }), async () => {
        executions += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { body: "first" };
      }),
      setup.server.handlePaidRequest(requestWithPayment(noHint, { paymentScheme: "exact", requestHash: "22".repeat(32) }), async () => {
        executions += 1;
        return { body: "second" };
      }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(executions).toBe(1);
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
    expect(response.body).toEqual({ error: "invalid_payment_requirements" });
    expect(executed).toBe(false);
    await expect(setup.store.loadExactPayment(EXACT_TX_ID)).resolves.toBeUndefined();
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

  it("returns cached deposit-voucher responses without a payment identifier", async () => {
    const setup = makeServer();
    const payment = makeDepositPayment(setup);
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
    expect(second.headers[PAYMENT_RESPONSE_HEADER]).toBe(first.headers[PAYMENT_RESPONSE_HEADER]);
    expect(executions).toBe(1);
    const stored = await requireChannel(setup.store, payment.channelId);
    expect(stored.chargedCumulativeAmount).toBe("50");
    expect(stored.signedMaxClaimable).toBe("100");
  });

  it("keeps stale batch vouchers corrective after a later commitment", async () => {
    const setup = makeServer();
    const deposit = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(requestWithPayment(deposit.payload, { requestHash: "aa".repeat(32) }), async () => ({
      chargedAmount: "50",
    }));
    const channel = await requireChannel(setup.store, deposit.channelId);
    const voucher = makeVoucherPayment(setup, channel);
    await setup.server.handlePaidRequest(requestWithPayment(voucher, { requestHash: "bb".repeat(32) }), async () => ({
      chargedAmount: "50",
    }));
    let executed = false;

    const stale = await setup.server.handlePaidRequest(requestWithPayment(deposit.payload, { requestHash: "aa".repeat(32) }), async () => {
      executed = true;
      return { body: "wrong" };
    });

    expect(stale.status).toBe(402);
    expect(stale.body).toEqual({ error: "invalid_payment_requirements" });
    expect(executed).toBe(false);
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
    expect(second.body).toEqual({ error: "invalid_transaction_state" });
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
    expect(conflict.body).toEqual({ error: "invalid_transaction_state" });
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
  options: {
    requestHash?: Hash32Hex;
    paymentAmount?: string;
    paymentScheme?: "exact" | "batch-settlement";
    paymentSchemes?: readonly ("exact" | "batch-settlement")[];
    body?: unknown;
  } = {},
) {
  return {
    url: RESOURCE.url,
    resource: RESOURCE,
    body: options.body,
    paymentAmount: options.paymentAmount,
    paymentScheme: options.paymentScheme,
    paymentSchemes: options.paymentSchemes,
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
      "payment-identifier": buildPaymentIdentifierExtension({
          required: true,
          id,
      }),
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
    return { transactionId: CLAIM_TX, finality: this.finality };
  }
}

class FailingCommitStore extends MemoryServerChannelStore {
  async commitSettlement(_record: SettlementCommit): Promise<void> {
    throw new Error("settlement store unavailable");
  }
}

class FailingExactCommitStore extends MemoryServerChannelStore {
  #remainingFailures: number;

  constructor(remainingFailures = Number.POSITIVE_INFINITY) {
    super();
    this.#remainingFailures = remainingFailures;
  }

  async commitExactPayment(record: ExactSettlementCommit): Promise<void> {
    if (this.#remainingFailures > 0) {
      this.#remainingFailures -= 1;
      throw new Error("exact store unavailable");
    }
    await super.commitExactPayment(record);
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
