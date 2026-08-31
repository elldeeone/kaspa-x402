import { describe, expect, it, vi } from "vitest";

import {
  MCP_PAYMENT_META_KEY,
  MCP_PAYMENT_RESPONSE_META_KEY,
  X402_VERSION,
  batchRequestAuthorizationDigest,
  batchPaymentRequirementsHash,
  channelId,
  decodePaymentSignatureHeader,
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  exactAuthorizationExpiresAt,
  exactRequestAuthorizationDigest,
  exactRequestAuthorizationId,
  mcpToolCallFingerprint,
  paymentIdentifierExtension as buildPaymentIdentifierExtension,
  readKaspaSettlementExtension,
  readMcpPaymentRequired,
  readMcpPaymentResponse,
  sha256Hex,
  stableStringify,
  voucherDigest,
  type BatchPaymentRequirements,
  type ChannelConfig,
  type ExactPaymentRequirements,
  type ExactRequestAuthorization,
  type FundingOutpoint,
  type Hash32Hex,
  type NetworkId,
  type PaymentPayload,
  type SettlementResponse,
} from "@kaspa-x402/core";
import {
  buildKip10AdditiveRedeemScript,
  deriveEscrowAddress,
  escrowScriptPublicKey,
  payToScriptHashScript,
  serializedScriptPublicKey,
} from "@kaspa-x402/covenant";
import {
  DirectModeServer,
  MemoryChannelLockManager,
  MemoryServerChannelStore,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  handlePaidMcpToolCall,
  type AddressCodec,
  type BatchSettlementAttemptRecord,
  type ChainUtxo,
  type ClaimAttemptRecord,
  type ClaimReconciliation,
  type DirectModeServerConfig,
  type ExactHeadChallenge,
  type ExactHeadRecord,
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
const COVENANT_ID = "4a".repeat(32);
const TOP_UP_TX = "99".repeat(32);
const CLAIM_TX = "55".repeat(32);
const EXACT_TX_ID = "77".repeat(32);
const EXACT_HEAD_ID = "89".repeat(32);
const MCP_AUDIENCE = "https://mcp.example.test";
const EXACT_TRANSACTION_ARTIFACT = '{"transaction":"signed-kip10-exact"}';
const RESOURCE = { url: "https://api.example.test/data" };

describe("direct-mode server", () => {
  it("returns PAYMENT-REQUIRED for unpaid requests", async () => {
    const { server } = makeServer();

    const response = await server.handlePaidRequest(
      { url: RESOURCE.url },
      async () => ({ body: "secret" }),
    );

    expect(response.status).toBe(402);
    expect(response.headers[PAYMENT_REQUIRED_HEADER]).toBeTruthy();
  });

  it("uses custom per-request amounts on unpaid requests", async () => {
    const { server } = makeServer({ amount: "100" });

    const response = await server.handlePaidRequest(
      { url: RESOURCE.url, paymentAmount: "75" },
      async () => ({ body: "secret" }),
    );

    expect(response.status).toBe(402);
    const required = decodePaymentRequiredHeader(
      response.headers[PAYMENT_REQUIRED_HEADER],
    );
    expect(required.accepts[0]?.amount).toBe("75");
  });

  it("keeps opted-in exact mainnet support while rejecting Alpha.11 batch", async () => {
    expect(() => makeServer({ network: "kaspa:mainnet" })).toThrow(
      "allowMainnet",
    );

    const { server } = makeServer({
      network: "kaspa:mainnet",
      allowMainnet: true,
    });
    expect(server.supportedKinds().map((kind) => kind.scheme)).toEqual([
      "exact",
    ]);
    expect(
      server.buildPaymentRequired({ resource: RESOURCE, scheme: "exact" })
        .accepts[0],
    ).toMatchObject({ scheme: "exact", network: "kaspa:mainnet" });
    expect(() =>
      server.buildPaymentRequired({
        resource: RESOURCE,
        scheme: "batch-settlement",
      }),
    ).toThrow("restricted to kaspa:testnet-10");

    const testnet = makeServer();
    const source = makeDepositPayment(testnet).payload;
    if (source.payload.type !== "deposit-voucher")
      throw new Error("expected deposit payload");
    const accepted = {
      ...source.accepted,
      network: "kaspa:mainnet",
    } as BatchPaymentRequirements;
    const mainnetBatch: PaymentPayload = {
      ...source,
      accepted,
      payload: {
        ...source.payload,
        channelConfig: {
          ...source.payload.channelConfig,
          network: "kaspa:mainnet",
        },
      },
    };
    await expect(
      server.verifyPayment({
        paymentPayload: mainnetBatch,
        paymentRequirements: accepted,
        resource: RESOURCE,
        requestHash: "a0".repeat(32),
      }),
    ).rejects.toThrow();
  });

  it("rejects refund locks that cross Kaspa's lock-time timestamp boundary", () => {
    expect(() => makeServer({ refundTimeoutDaa: "500000000000" })).toThrow(
      "timestamp boundary",
    );
  });

  it("fails closed before advertising a batch channel too close to refund", async () => {
    const setup = makeServer({
      refundTimeoutDaa: "1100",
      minimumRefundLeadDaa: "100",
    });
    setup.chain.daa = "1000";

    const response = await setup.server.handlePaidRequest(
      { url: RESOURCE.url, paymentScheme: "batch-settlement" },
      async () => ({ body: "secret" }),
    );

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: "invalid_payload" });
  });

  it("accepts a rolling absolute timeout only inside the configured DAA window", async () => {
    const config = {
      refundTimeoutDaa: "2000",
      minimumRefundLeadDaa: "100",
      allowRollingRefundTimeoutDaa: true,
      maximumRefundHorizonDaa: "1000",
    } as const;
    const setup = makeServer(config);
    setup.chain.daa = "1000";
    const validAccepted = structuredClone(
      setup.server.buildPaymentRequired({ resource: RESOURCE })
        .accepts[0] as BatchPaymentRequirements,
    );
    validAccepted.extra.refundTimeoutDaa = "1900";
    const validPayment = makeDepositPayment(setup, { accepted: validAccepted });
    let executed = false;

    const valid = await setup.server.handlePaidRequest(
      requestWithPayment(validPayment.payload),
      async () => {
        executed = true;
        return { body: "secret", chargedAmount: "100" };
      },
    );
    expect(valid.status).toBe(200);
    expect(executed).toBe(true);

    const outside = makeServer(config);
    outside.chain.daa = "1000";
    const tooFarAccepted = structuredClone(
      outside.server.buildPaymentRequired({ resource: RESOURCE })
        .accepts[0] as BatchPaymentRequirements,
    );
    tooFarAccepted.extra.refundTimeoutDaa = "2001";
    const tooFar = makeDepositPayment(outside, { accepted: tooFarAccepted });
    let rejectedHandlerExecuted = false;
    const rejected = await outside.server.handlePaidRequest(
      requestWithPayment(tooFar.payload),
      async () => {
        rejectedHandlerExecuted = true;
        return { body: "secret", chargedAmount: "100" };
      },
    );
    expect(rejected.status).toBe(402);
    expect(rejected.body).toEqual({ error: "invalid_payload" });
    expect(rejectedHandlerExecuted).toBe(false);
  });

  it("offers exact requirements for exact paid routes", async () => {
    const { server } = makeServer({ amount: "100" });

    const response = await server.handlePaidRequest(
      { url: RESOURCE.url, paymentAmount: "75", paymentScheme: "exact" },
      async () => ({
        body: "secret",
      }),
    );

    expect(response.status).toBe(402);
    const required = decodePaymentRequiredHeader(
      response.headers[PAYMENT_REQUIRED_HEADER],
    );
    expect(required.accepts[0]?.scheme).toBe("exact");
    expect(required.accepts[0]?.amount).toBe("75");
    expect(required.accepts[0]?.extra.binding).toBe("kaspa-exact-v2");
    expect(required.accepts[0]?.extra.profile).toBe("standard-native");
  });

  it("offers standard-native exact by default without allocating head state", async () => {
    const setup = makeServer({ exactProfile: "standard-native" });

    const response = await setup.server.handlePaidRequest(
      { url: RESOURCE.url, paymentAmount: "20000000", paymentScheme: "exact" },
      async () => ({ body: "secret" }),
    );

    expect(response.status).toBe(402);
    const required = decodePaymentRequiredHeader(
      response.headers[PAYMENT_REQUIRED_HEADER],
    );
    expect(required.accepts[0]).toMatchObject({
      scheme: "exact",
      amount: "20000000",
      extra: {
        binding: "kaspa-exact-v2",
        paymentFlow: "upfront",
        profile: "standard-native",
        finality: "accepted",
        transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
      },
    });
    expect(
      (required.accepts[0] as ExactPaymentRequirements).extra
        .payToScriptPublicKey,
    ).toMatch(/^0000/);
    await expect(setup.store.listExactHeads()).resolves.toEqual([]);
    expect(setup.server.supportedKinds()).toContainEqual(
      expect.objectContaining({
        scheme: "exact",
        extra: expect.objectContaining({
          binding: "kaspa-exact-v2",
          paymentFlow: "upfront",
          profile: "standard-native",
        }),
      }),
    );
  });

  it("rejects zero-value standard-native exact offers", () => {
    const { server } = makeServer({ exactProfile: "standard-native" });
    expect(() =>
      server.buildPaymentRequired({
        resource: RESOURCE,
        scheme: "exact",
        amount: "0",
      }),
    ).toThrow("exact payment amount must be positive");
  });

  it("can advertise exact and batch-settlement requirements from one route", async () => {
    const { server } = makeServer({ amount: "100" });

    const response = await server.handlePaidRequest(
      {
        url: RESOURCE.url,
        paymentAmount: "75",
        paymentSchemes: ["exact", "batch-settlement"],
      },
      async () => ({
        body: "secret",
      }),
    );

    expect(response.status).toBe(402);
    const required = decodePaymentRequiredHeader(
      response.headers[PAYMENT_REQUIRED_HEADER],
    );
    expect(required.accepts.map((requirement) => requirement.scheme)).toEqual([
      "exact",
      "batch-settlement",
    ]);
    expect(required.accepts.map((requirement) => requirement.amount)).toEqual([
      "75",
      "75",
    ]);
    expect(required.accepts[0]?.extra.binding).toBe("kaspa-exact-v2");
    expect(required.accepts[1]?.extra.binding).toBe("kaspa-escrow-v2");
  });

  it("preserves batch fallback when an additive exact head is unavailable", async () => {
    const setup = await makeAdditiveServer(
      {},
      {
        status: "unavailable",
        unavailableReason: "test head unavailable",
      },
    );
    let executed = false;

    const response = await setup.server.handlePaidRequest(
      {
        url: RESOURCE.url,
        resource: RESOURCE,
        paymentSchemes: ["exact", "batch-settlement"],
      },
      async () => {
        executed = true;
        return { body: "secret" };
      },
    );

    expect(response.status).toBe(402);
    expect(executed).toBe(false);
    const required = decodePaymentRequiredHeader(
      response.headers[PAYMENT_REQUIRED_HEADER],
    );
    expect(required.accepts.map((requirement) => requirement.scheme)).toEqual([
      "batch-settlement",
    ]);
    expect(required.accepts[0]?.extra.binding).toBe("kaspa-escrow-v2");
  });

  it("returns MCP payment requirements for unpaid tool calls", async () => {
    const setup = makeServer({ amount: "100" });
    let executed = false;

    const result = await handlePaidMcpToolCall(
      setup.server,
      {
        audience: MCP_AUDIENCE,
        name: "download",
        resource: { url: "mcp://tool/download" },
        amount: "75",
        scheme: "exact",
      },
      { name: "download", arguments: { id: "alpha" } },
      async () => {
        executed = true;
        return { result: { content: [{ type: "text", text: "secret" }] } };
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toBe(
      JSON.stringify(result.structuredContent),
    );
    const required = readMcpPaymentRequired(result);
    expect(result.structuredContent).toEqual(required);
    expect(required?.accepts[0]?.scheme).toBe("exact");
    expect(required?.accepts[0]?.amount).toBe("75");
    expect(executed).toBe(false);
  });

  it("includes reusable KIP-10 head terms without consuming state in unpaid MCP exact challenges", async () => {
    const setup = await makeAdditiveServer();
    let executed = false;

    const result = await handlePaidMcpToolCall(
      setup.server,
      {
        audience: MCP_AUDIENCE,
        name: "download",
        resource: { url: "mcp://tool/download" },
        amount: "20000000",
        scheme: "exact",
      },
      { name: "download", arguments: { id: "alpha" } },
      async () => {
        executed = true;
        return { result: { content: [{ type: "text", text: "secret" }] } };
      },
    );

    const required = readMcpPaymentRequired(result);
    const accepted = required?.accepts[0] as
      ExactPaymentRequirements | undefined;
    expect(result.isError).toBe(true);
    expect(accepted?.scheme).toBe("exact");
    expect(accepted?.extra.templateId).toBe("kaspa-x402-kip10-additive-v1");
    expect(accepted?.extra.binding).toBe("kaspa-exact-v2");
    expect(accepted?.extra.profile).toBe("additive");
    expect(accepted?.extra.headId).toBe(EXACT_HEAD_ID);
    expect(accepted?.extra.challengeId).toMatch(/^[0-9a-f]{64}$/);
    expect(executed).toBe(false);
    await expect(
      setup.store.loadExactHead(EXACT_HEAD_ID),
    ).resolves.toMatchObject({ status: "available", version: "0" });
  });

  it("issues one thousand unanswered additive 402s without leasing or retiring a head", async () => {
    const setup = await makeAdditiveServer();

    for (let index = 0; index < 1_000; index += 1) {
      const response = await setup.server.handlePaidRequest(
        {
          url: `${RESOURCE.url}?offer=${index}`,
          resource: RESOURCE,
          paymentScheme: "exact",
        },
        async () => ({ body: "unreachable" }),
      );
      expect(response.status).toBe(402);
    }

    const heads = await setup.store.listExactHeads();
    expect(heads).toEqual([
      expect.objectContaining({
        headId: EXACT_HEAD_ID,
        status: "available",
        version: "0",
      }),
    ]);
    expect(heads[0]?.claimTransactionId).toBeUndefined();
  });

  it("reconciles only bounded selected heads before an additive offer", async () => {
    let reconciliations = 0;
    const setup = await makeAdditiveServer({
      reconcileExactHeadOnOffer: true,
      exactHeadReconciler: {
        reconcileExactHead() {
          reconciliations += 1;
          return { status: "unknown", reason: "head not found" } as const;
        },
      },
    });
    for (let index = 1; index < 64; index += 1) {
      const id = index.toString(16).padStart(64, "0");
      await setup.store.registerExactHead(
        exactHead({
          headId: id,
          currentOutpoint: { txid: id, index: 0 },
          scriptPublicKey: setup.head.scriptPublicKey,
          redeemScript: setup.head.redeemScript,
        }),
      );
    }

    const response = await setup.server.handlePaidRequest(
      {
        url: `${RESOURCE.url}?bounded-reconciliation=1`,
        resource: RESOURCE,
        paymentScheme: "exact",
      },
      async () => ({ body: "unreachable" }),
    );

    expect(response.status).toBe(503);
    expect(reconciliations).toBe(2);
    expect(
      (await setup.store.listExactHeads()).filter(
        (head) => head.status === "available",
      ),
    ).toHaveLength(62);
  });

  it("allows one conflicting additive head spend and refreshes the losing challenge", async () => {
    const setup = await makeAdditiveServer({
      exactTransactionVerifier: {
        verifyExactPayment(request) {
          const transactionId = request.transaction as Hash32Hex;
          const head = request.head!;
          return {
            transactionId,
            paymentOutput: {
              amount: request.amount,
              scriptPublicKey: request.payToScriptPublicKey,
            },
            continuation: {
              outpoint: { txid: transactionId, index: 0 },
              amount: (
                BigInt(head.headAmount) + BigInt(request.amount)
              ).toString(),
              scriptPublicKey: head.headScriptPublicKey,
            },
            finality: "accepted",
            requestAuthorization: fakeAuthorizationEvidence(
              request.authorization,
            ),
          };
        },
      },
    });
    const unpaid = await setup.server.handlePaidRequest(
      { url: RESOURCE.url, resource: RESOURCE, paymentScheme: "exact" },
      async () => ({ body: "unreachable" }),
    );
    const accepted = decodePaymentRequiredHeader(
      unpaid.headers[PAYMENT_REQUIRED_HEADER],
    ).accepts[0] as ExactPaymentRequirements;
    const first = makeAdditivePayment(accepted, {
      requestHash: "a1".repeat(32),
      transactionId: EXACT_TX_ID,
    });
    const second = makeAdditivePayment(accepted, {
      requestHash: "a2".repeat(32),
      transactionId: CLAIM_TX,
    });
    if (
      first.payload.type !== "exact-transaction" ||
      second.payload.type !== "exact-transaction"
    )
      throw new Error("expected exact payloads");
    first.payload.transaction = EXACT_TX_ID;
    second.payload.transaction = CLAIM_TX;
    let executions = 0;
    const handler = () => {
      executions += 1;
      return { body: "winner" };
    };

    const [left, right] = await Promise.all([
      setup.server.handlePaidRequest(
        requestWithPayment(first, {
          paymentScheme: "exact",
          requestHash: "a1".repeat(32),
        }),
        handler,
      ),
      setup.server.handlePaidRequest(
        requestWithPayment(second, {
          paymentScheme: "exact",
          requestHash: "a2".repeat(32),
        }),
        handler,
      ),
    ]);

    expect([left.status, right.status].sort()).toEqual([200, 402]);
    expect(executions).toBe(1);
    const loser = left.status === 402 ? left : right;
    const refreshed = decodePaymentRequiredHeader(
      loser.headers[PAYMENT_REQUIRED_HEADER],
    ).accepts[0] as ExactPaymentRequirements;
    expect(refreshed.extra.headVersion).toBe("1");
    expect(refreshed.extra.expectedHeadOutpoint?.txid).toBe(
      left.status === 200 ? EXACT_TX_ID : CLAIM_TX,
    );
  });

  it("does not select additive heads below the configured threshold", async () => {
    const setup = await makeAdditiveServer({}, { additiveThresholdSompi: "1" });

    const response = await setup.server.handlePaidRequest(
      { url: RESOURCE.url, resource: RESOURCE, paymentScheme: "exact" },
      async () => ({
        body: "unreachable",
      }),
    );

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: "invalid_payload" });
    await expect(
      setup.store.loadExactHead(EXACT_HEAD_ID),
    ).resolves.toMatchObject({ status: "available" });
  });

  it("rejects explicit additive heads below the configured threshold", () => {
    const setup = makeServer({ exactProfile: "additive" });
    const head = exactHead({
      redeemScript: buildKip10AdditiveRedeemScript({
        ownerPublicKey: "aa".repeat(32),
        amount: "1",
      }),
      additiveThresholdSompi: "1",
    });
    head.scriptPublicKey = serializedScriptPublicKey(
      payToScriptHashScript(head.redeemScript),
    );

    expect(() =>
      setup.server.buildPaymentRequired({
        resource: RESOURCE,
        scheme: "exact",
        amount: "20000000",
        exactHead: exactHeadChallenge(head),
      }),
    ).toThrow("configured head threshold");
  });

  it("rejects invalid MCP payment metadata without executing the tool", async () => {
    const setup = makeServer({ amount: "100" });
    let executed = false;

    const result = await handlePaidMcpToolCall(
      setup.server,
      {
        audience: MCP_AUDIENCE,
        name: "download",
        resource: { url: "mcp://tool/download" },
        amount: "75",
        scheme: "exact",
      },
      {
        name: "download",
        arguments: { id: "alpha" },
        _meta: { [MCP_PAYMENT_META_KEY]: { x402Version: 2 } },
      },
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
    const required = setup.server.buildPaymentRequired({
      resource: { url: "mcp://tool/download" },
      amount: "100",
      scheme: "exact",
    });
    const requestHash = mcpToolCallFingerprint({
      audience: MCP_AUDIENCE,
      toolName: "download",
      arguments: { id: "same" },
      accepted: required.accepts[0] as ExactPaymentRequirements,
    });
    const payment = makeExactPayment(setup, { requestHash });
    let executions = 0;
    const params = {
      name: "download",
      arguments: { id: "same" },
      _meta: { [MCP_PAYMENT_META_KEY]: payment },
    };

    const first = await handlePaidMcpToolCall(
      setup.server,
      {
        audience: MCP_AUDIENCE,
        name: "download",
        resource: { url: "mcp://tool/download" },
        amount: "100",
        scheme: "exact",
      },
      params,
      async () => {
        executions += 1;
        return { result: { content: [{ type: "text", text: "paid" }] } };
      },
    );
    const second = await handlePaidMcpToolCall(
      setup.server,
      {
        audience: MCP_AUDIENCE,
        name: "download",
        resource: { url: "mcp://tool/download" },
        amount: "100",
        scheme: "exact",
      },
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

  it("rejects one exact MCP authorization at another server audience", async () => {
    const serverA = makeServer({ amount: "100" });
    const serverB = makeServer({ amount: "100" });
    const audienceA = "https://mcp-a.example.test";
    const audienceB = "https://mcp-b.example.test";
    const required = serverA.server.buildPaymentRequired({
      resource: { url: "mcp://server-a/download" },
      amount: "100",
      scheme: "exact",
    });
    const requestHash = mcpToolCallFingerprint({
      audience: audienceA,
      toolName: "download",
      arguments: { id: "cross-server" },
      accepted: required.accepts[0] as ExactPaymentRequirements,
    });
    const payment = makeExactPayment(serverA, { requestHash });
    const params = {
      name: "download",
      arguments: { id: "cross-server" },
      _meta: { [MCP_PAYMENT_META_KEY]: payment },
    };
    let executionsA = 0;
    let executionsB = 0;

    const first = await handlePaidMcpToolCall(
      serverA.server,
      {
        audience: audienceA,
        name: "download",
        resource: { url: "mcp://server-a/download" },
        amount: "100",
        scheme: "exact",
      },
      params,
      async () => {
        executionsA += 1;
        return { result: { content: [{ type: "text", text: "paid A" }] } };
      },
    );
    const replay = await handlePaidMcpToolCall(
      serverB.server,
      {
        audience: audienceB,
        name: "download",
        resource: { url: "mcp://server-b/download" },
        amount: "100",
        scheme: "exact",
      },
      params,
      async () => {
        executionsB += 1;
        return { result: { content: [{ type: "text", text: "paid B" }] } };
      },
    );

    expect(first.content?.[0]?.text).toBe("paid A");
    expect(replay.isError).toBe(true);
    expect(readMcpPaymentRequired(replay)).toBeDefined();
    expect(executionsA).toBe(1);
    expect(executionsB).toBe(0);
  });

  it("returns a fresh MCP challenge when payer authorization targets another call", async () => {
    const setup = makeServer({ amount: "100" });
    const firstRequired = setup.server.buildPaymentRequired({
      resource: { url: "mcp://tool/download" },
      amount: "100",
      scheme: "exact",
    });
    const firstHash = mcpToolCallFingerprint({
      audience: MCP_AUDIENCE,
      toolName: "download",
      arguments: { id: "first" },
      accepted: firstRequired.accepts[0] as ExactPaymentRequirements,
    });
    const payment = makeExactPayment(setup, { requestHash: firstHash });

    await handlePaidMcpToolCall(
      setup.server,
      {
        audience: MCP_AUDIENCE,
        name: "download",
        resource: { url: "mcp://tool/download" },
        amount: "100",
        scheme: "exact",
      },
      {
        name: "download",
        arguments: { id: "first" },
        _meta: { [MCP_PAYMENT_META_KEY]: payment },
      },
      async () => ({ result: { content: [{ type: "text", text: "paid" }] } }),
    );

    const replayPayload = structuredClone(payment);
    const replay = await handlePaidMcpToolCall(
      setup.server,
      {
        audience: MCP_AUDIENCE,
        name: "download",
        resource: { url: "mcp://tool/download" },
        amount: "100",
        scheme: "exact",
      },
      {
        name: "download",
        arguments: { id: "second" },
        _meta: { [MCP_PAYMENT_META_KEY]: replayPayload },
      },
      async () => ({ result: { content: [{ type: "text", text: "wrong" }] } }),
    );

    expect(replay.isError).toBe(true);
    expect(readMcpPaymentRequired(replay)).toBeDefined();
    expect(replay.content?.[0]?.text).toContain("invalid_payload");
  });

  it("returns hybrid MCP settlement failures without exposing paid tool output", async () => {
    const setup = makeServer({ amount: "100" });
    const required = setup.server.buildPaymentRequired({
      resource: { url: "mcp://tool/download" },
      amount: "100",
      scheme: "exact",
    });
    const requestHash = mcpToolCallFingerprint({
      audience: MCP_AUDIENCE,
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
      {
        audience: MCP_AUDIENCE,
        name: "download",
        resource: { url: "mcp://tool/download" },
        amount: "100",
        scheme: "exact",
      },
      {
        name: "download",
        arguments: { id: "fail" },
        _meta: { [MCP_PAYMENT_META_KEY]: payment },
      },
      async () => ({
        result: { content: [{ type: "text", text: "protected output" }] },
      }),
    );
    const challenge = readMcpPaymentRequired(result);

    expect(result.isError).toBe(true);
    expect(challenge?.error).toBe("invalid_transaction_state");
    expect(result.structuredContent).toEqual(challenge);
    expect(result.content?.[0]?.text).toBe(
      JSON.stringify(result.structuredContent),
    );
    expect(result.content?.[0]?.text).not.toContain("protected output");
    expect(result.content?.[0]?.text).not.toContain("must not leak");
    expect(readMcpPaymentResponse(result)).toEqual(settlement);
  });

  it("accepts an exact transaction and commits replay state after handler success", async () => {
    const setup = makeServer();
    const payment = makeExactPayment(setup);

    const response = await setup.server.handlePaidRequest(
      requestWithPayment(payment, { paymentScheme: "exact" }),
      async () => ({
        body: "download",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.body).toBe("download");
    const settlement = decodePaymentResponseHeader(
      response.headers[PAYMENT_RESPONSE_HEADER],
    );
    expect(settlement.transaction).toBe(EXACT_TX_ID);
    expect(settlement.amount).toBe("100");
    expect(readKaspaSettlementExtension(settlement)?.paymentOutputIndex).toBe(
      0,
    );
    const stored = await setup.store.loadExactPayment(EXACT_TX_ID);
    expect(stored?.amount).toBe("100");
    expect(stored?.paymentOutputIndex).toBe(0);
    expect(stored?.response.status).toBe(200);
  });

  it("verifies and settles standard-native exact before protected work without head state", async () => {
    const setup = makeServer({ exactProfile: "standard-native" });
    const payment = makeStandardExactPayment(setup);
    let executed = false;

    const response = await setup.server.handlePaidRequest(
      requestWithPayment(payment, { paymentScheme: "exact" }),
      async () => {
        executed = true;
        return { body: "standard", chargedAmount: "100" };
      },
    );

    expect(response.status).toBe(200);
    expect(response.body).toBe("standard");
    expect(executed).toBe(true);
    const stored = await setup.store.loadExactPayment(EXACT_TX_ID);
    expect(stored).toMatchObject({
      profile: "standard-native",
      amount: "100",
      paymentOutputIndex: 0,
    });
    expect(readKaspaSettlementExtension(stored!.settlement)?.exactProfile).toBe(
      "standard-native",
    );
    await expect(setup.store.listExactHeads()).resolves.toEqual([]);
  });

  it("rejects a mismatched standard-native payload profile before protected work", async () => {
    const setup = makeServer({ exactProfile: "standard-native" });
    const payment = makeStandardExactPayment(setup);
    (payment.payload as { profile?: string }).profile = "additive";
    let executed = false;

    const response = await setup.server.handlePaidRequest(
      requestWithRawPaymentPayload(payment, { paymentScheme: "exact" }),
      async () => {
        executed = true;
        return { body: "secret" };
      },
    );

    expect(response.status).toBe(402);
    expect(executed).toBe(false);
    await expect(
      setup.store.loadExactPayment(EXACT_TX_ID),
    ).resolves.toBeUndefined();
  });

  it("accepts an exact transaction selected from a mixed route", async () => {
    const setup = makeServer();
    const payment = makeExactPayment(setup);

    const response = await setup.server.handlePaidRequest(
      requestWithPayment(payment, {
        paymentSchemes: ["exact", "batch-settlement"],
      }),
      async () => ({
        body: "secret",
      }),
    );

    expect(response.status).toBe(200);
    const settlement = decodePaymentResponseHeader(
      response.headers[PAYMENT_RESPONSE_HEADER],
    );
    expect(settlement.success).toBe(true);
    expect(settlement.transaction).toBe(EXACT_TX_ID);
    expect(settlement.amount).toBe("100");
  });

  it("rejects batch payments submitted to exact routes", async () => {
    const setup = makeServer();
    const payment = makeDepositPayment(setup);
    let executed = false;

    const response = await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload, { paymentScheme: "exact" }),
      async () => {
        executed = true;
        return { body: "secret" };
      },
    );

    expect(response.status).toBe(402);
    expect(executed).toBe(false);
    const required = decodePaymentRequiredHeader(
      response.headers[PAYMENT_REQUIRED_HEADER],
    );
    expect(required.accepts[0]?.scheme).toBe("exact");
  });

  it("rejects exact payments submitted to batch routes", async () => {
    const setup = makeServer();
    const payment = makeExactPayment(setup);
    let executed = false;

    const response = await setup.server.handlePaidRequest(
      requestWithPayment(payment, { paymentScheme: "batch-settlement" }),
      async () => {
        executed = true;
        return { body: "secret" };
      },
    );

    expect(response.status).toBe(402);
    expect(executed).toBe(false);
    const required = decodePaymentRequiredHeader(
      response.headers[PAYMENT_REQUIRED_HEADER],
    );
    expect(required.accepts[0]?.scheme).toBe("batch-settlement");
  });

  it("rejects exact payload request hashes that do not match the server fingerprint", async () => {
    const setup = makeServer();
    const payment = makeExactPayment(setup, { requestHash: "12".repeat(32) });
    let executed = false;

    const response = await setup.server.handlePaidRequest(
      requestWithPayment(payment, {
        paymentScheme: "exact",
        requestHash: "13".repeat(32),
      }),
      async () => {
        executed = true;
        return { body: "download" };
      },
    );

    expect(response.status).toBe(402);
    expect(response.body).toEqual({ error: "invalid_payload" });
    expect(executed).toBe(false);
    await expect(
      setup.store.loadExactPayment(EXACT_TX_ID),
    ).resolves.toBeUndefined();
  });

  it("returns the cached response for an identical exact payment retry", async () => {
    const setup = makeServer();
    const requestHash = "12".repeat(32);
    const payment = makeExactPayment(setup, { requestHash });
    await setup.server.handlePaidRequest(
      requestWithPayment(payment, { paymentScheme: "exact", requestHash }),
      async () => ({
        body: "download",
      }),
    );

    let executed = false;
    const replay = await setup.server.handlePaidRequest(
      requestWithPayment(payment, { paymentScheme: "exact", requestHash }),
      async () => {
        executed = true;
        return { body: "second" };
      },
    );

    expect(replay.status).toBe(200);
    expect(replay.body).toBe("download");
    expect(executed).toBe(false);
  });

  it("resumes a durable handler result without re-running protected work after an exact commit failure", async () => {
    const store = new FailingExactCommitStore(1);
    const setup = makeServer({ requirePaymentIdentifier: true, store });
    const requestHash = "12".repeat(32);
    const paymentIdentifier = "pay_7d5d747be160e280504c099d984bcfe0";
    const payment = makeExactPayment(setup, { requestHash, paymentIdentifier });
    const outbox = new Map<string, { body: string }>();
    let handlerInvocations = 0;
    let externalEffects = 0;
    const handler = ({
      paymentIdentifier: id,
      requestFingerprint,
    }: {
      paymentIdentifier?: string;
      requestFingerprint: Hash32Hex;
    }) => {
      handlerInvocations += 1;
      const key = `${id}:${requestFingerprint}`;
      const cached = outbox.get(key);
      if (cached) return cached;
      externalEffects += 1;
      const result = { body: "download" };
      outbox.set(key, result);
      return result;
    };

    const first = await setup.server.handlePaidRequest(
      requestWithPayment(payment, { paymentScheme: "exact", requestHash }),
      handler,
    );
    const second = await setup.server.handlePaidRequest(
      requestWithPayment(payment, { paymentScheme: "exact", requestHash }),
      handler,
    );

    expect(first.status).toBe(500);
    expect(second.status).toBe(200);
    expect(second.body).toBe("download");
    expect(handlerInvocations).toBe(1);
    expect(externalEffects).toBe(1);
    await expect(store.loadExactPayment(EXACT_TX_ID)).resolves.toBeDefined();
    await expect(
      store.loadExactSettlementAttempt(EXACT_TX_ID),
    ).resolves.toMatchObject({
      status: "applied",
      handlerStartedAt: expect.any(String),
      handlerCompletedAt: expect.any(String),
      handlerResult: { body: "download" },
    });
  });

  it("requires explicit recovery after an uncertain exact handler outcome", async () => {
    const setup = makeServer();
    const requestHash = "12".repeat(32);
    const payment = makeExactPayment(setup, { requestHash });
    let handlerInvocations = 0;
    const request = requestWithPayment(payment, {
      paymentScheme: "exact",
      requestHash,
    });

    const first = await setup.server.handlePaidRequest(request, async () => {
      handlerInvocations += 1;
      throw new Error("application outcome unknown");
    });
    const blocked = await setup.server.handlePaidRequest(request, async () => {
      handlerInvocations += 1;
      return { body: "must not run" };
    });

    expect(first.status).toBe(500);
    expect(blocked).toMatchObject({
      status: 503,
      body: { error: "exact_settlement_recovery_required" },
    });
    expect(handlerInvocations).toBe(1);
    await expect(
      setup.server.recoverExactHandler(EXACT_TX_ID, { body: "recovered" }),
    ).resolves.toMatchObject({
      status: "accepted",
      handlerResult: { body: "recovered", chargedAmount: "100" },
    });

    const recovered = await setup.server.handlePaidRequest(
      request,
      async () => {
        handlerInvocations += 1;
        return { body: "must not run" };
      },
    );
    expect(recovered.status).toBe(200);
    expect(recovered.body).toBe("recovered");
    expect(handlerInvocations).toBe(1);
  });

  it("rejects an exact authorization replayed against a different request", async () => {
    const setup = makeServer();
    const payment = makeExactPayment(setup, { requestHash: "12".repeat(32) });
    await setup.server.handlePaidRequest(
      requestWithPayment(payment, {
        paymentScheme: "exact",
        requestHash: "12".repeat(32),
      }),
      async () => ({
        body: "download",
      }),
    );

    let executed = false;
    const replay = await setup.server.handlePaidRequest(
      requestWithPayment(payment, {
        paymentScheme: "exact",
        requestHash: "13".repeat(32),
      }),
      async () => {
        executed = true;
        return { body: "second" };
      },
    );

    expect(replay.status).toBe(402);
    expect(replay.body).toEqual({ error: "invalid_payload" });
    expect(executed).toBe(false);
  });

  it("rejects exact authorization that outlives the advertised timeout before verification", async () => {
    let verifierCalls = 0;
    const setup = makeServer({
      maxTimeoutSeconds: 1,
      exactTransactionVerifier: {
        verifyExactPayment() {
          verifierCalls += 1;
          throw new Error("must not verify an overlong authorization");
        },
      },
    });
    const payment = makeExactPayment(setup);
    if (payment.payload.type !== "exact-transaction") {
      throw new Error("expected exact transaction payload");
    }
    payment.payload.authorization.expiresAt = new Date(
      Date.now() + 2_000,
    ).toISOString();
    let executed = false;

    const response = await setup.server.handlePaidRequest(
      requestWithPayment(payment, { paymentScheme: "exact" }),
      async () => {
        executed = true;
        return { body: "must not run" };
      },
    );

    expect(response).toMatchObject({
      status: 402,
      body: { error: "invalid_payload" },
    });
    expect(verifierCalls).toBe(0);
    expect(executed).toBe(false);
  });

  it("rejects standard-native authorization that expires during verification", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      let verifierEnteredBeforeExpiry = false;
      const setup = makeServer({
        maxTimeoutSeconds: 1,
        exactTransactionVerifier: {
          verifyExactPayment(request) {
            verifierEnteredBeforeExpiry =
              Date.now() < Date.parse(request.authorization.expiresAt);
            vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
            return {
              transactionId: EXACT_TX_ID,
              paymentOutput: {
                amount: request.amount,
                scriptPublicKey: request.payToScriptPublicKey,
              },
              finality: "accepted" as const,
              payerAddress: "kaspatest:refund",
              requestAuthorization: fakeAuthorizationEvidence(
                request.authorization,
              ),
            };
          },
        },
      });
      const payment = makeExactPayment(setup);
      let executed = false;

      const response = await setup.server.handlePaidRequest(
        requestWithPayment(payment, { paymentScheme: "exact" }),
        async () => {
          executed = true;
          return { body: "must not run" };
        },
      );

      expect(verifierEnteredBeforeExpiry).toBe(true);
      expect(response).toMatchObject({
        status: 402,
        body: { error: "invalid_payload" },
      });
      expect(executed).toBe(false);
      await expect(
        setup.store.loadExactPayment(EXACT_TX_ID),
      ).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects additive authorization that expires during verification", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      let verifierEnteredBeforeExpiry = false;
      const setup = await makeAdditiveServer({
        maxTimeoutSeconds: 1,
        exactTransactionVerifier: {
          verifyExactPayment(request) {
            verifierEnteredBeforeExpiry =
              Date.now() < Date.parse(request.authorization.expiresAt);
            vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
            const head = request.head!;
            return {
              transactionId: EXACT_TX_ID,
              paymentOutput: {
                amount: request.amount,
                scriptPublicKey: request.payToScriptPublicKey,
              },
              continuation: {
                outpoint: { txid: EXACT_TX_ID, index: 0 },
                amount: (
                  BigInt(head.headAmount) + BigInt(request.amount)
                ).toString(),
                scriptPublicKey: head.headScriptPublicKey,
              },
              finality: "accepted" as const,
              payerAddress: "kaspatest:refund",
              requestAuthorization: fakeAuthorizationEvidence(
                request.authorization,
              ),
            };
          },
        },
      });
      const unpaid = await setup.server.handlePaidRequest(
        { url: RESOURCE.url, resource: RESOURCE, paymentScheme: "exact" },
        async () => ({ body: "unreachable" }),
      );
      const accepted = decodePaymentRequiredHeader(
        unpaid.headers[PAYMENT_REQUIRED_HEADER],
      ).accepts[0] as ExactPaymentRequirements;
      const payment = makeAdditivePayment(accepted);
      let executed = false;

      const response = await setup.server.handlePaidRequest(
        requestWithPayment(payment, { paymentScheme: "exact" }),
        async () => {
          executed = true;
          return { body: "must not run" };
        },
      );

      expect(verifierEnteredBeforeExpiry).toBe(true);
      expect(response).toMatchObject({
        status: 402,
        body: { error: "invalid_payload" },
      });
      expect(executed).toBe(false);
      await expect(
        setup.store.loadExactPayment(EXACT_TX_ID),
      ).resolves.toBeUndefined();
      await expect(
        setup.store.loadExactHead(EXACT_HEAD_ID),
      ).resolves.toMatchObject({ status: "available", version: "0" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects exact authorization that expires while waiting for the canonical transaction lock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    let releaseCanonicalLock!: () => void;
    try {
      const memoryLockManager = new MemoryChannelLockManager();
      const canonicalLockKey = sha256Hex(
        stableStringify({
          scope: "kaspa:x402:exact-payment-transaction:v1",
          transactionId: EXACT_TX_ID,
        }),
      );
      let canonicalLockEntered!: () => void;
      const canonicalLockReady = new Promise<void>((resolve) => {
        canonicalLockEntered = resolve;
      });
      const canonicalLockRelease = new Promise<void>((resolve) => {
        releaseCanonicalLock = resolve;
      });
      const blocker = memoryLockManager.runExclusive(
        canonicalLockKey,
        async () => {
          canonicalLockEntered();
          await canonicalLockRelease;
        },
      );
      await canonicalLockReady;

      let canonicalLockRequested!: () => void;
      const waitingForCanonicalLock = new Promise<void>((resolve) => {
        canonicalLockRequested = resolve;
      });
      const lockManager = {
        runExclusive<T>(key: Hash32Hex, fn: () => Promise<T>): Promise<T> {
          if (key === canonicalLockKey) canonicalLockRequested();
          return memoryLockManager.runExclusive(key, fn);
        },
      };
      const setup = makeServer({
        maxTimeoutSeconds: 1,
        lockManager,
        exactTransactionVerifier: {
          verifyExactPayment(request) {
            return {
              transactionId: EXACT_TX_ID,
              paymentOutput: {
                amount: request.amount,
                scriptPublicKey: request.payToScriptPublicKey,
              },
              finality: "accepted" as const,
              payerAddress: "kaspatest:refund",
              requestAuthorization: fakeAuthorizationEvidence(
                request.authorization,
              ),
            };
          },
        },
      });
      const payment = makeExactPayment(setup);
      let executed = false;
      const pendingResponse = setup.server.handlePaidRequest(
        requestWithPayment(payment, { paymentScheme: "exact" }),
        async () => {
          executed = true;
          return { body: "must not run" };
        },
      );

      await waitingForCanonicalLock;
      vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
      releaseCanonicalLock();
      await blocker;
      const response = await pendingResponse;

      expect(response).toMatchObject({
        status: 402,
        body: { error: "invalid_payload" },
      });
      expect(executed).toBe(false);
      await expect(
        setup.store.loadExactPayment(EXACT_TX_ID),
      ).resolves.toBeUndefined();
    } finally {
      releaseCanonicalLock?.();
      vi.useRealTimers();
    }
  });

  it("rejects a second exact payment from the same transaction", async () => {
    const setup = makeServer();
    const firstPayment = makeExactPayment(setup, {
      paymentOutputIndex: 1,
      requestHash: "21".repeat(32),
    });
    const secondPayment = makeExactPayment(setup, {
      paymentOutputIndex: 2,
      requestHash: "22".repeat(32),
    });
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
      setup.server.handlePaidRequest(
        requestWithPayment(firstPayment, {
          paymentScheme: "exact",
          requestHash: "21".repeat(32),
        }),
        handler,
      ),
      setup.server.handlePaidRequest(
        requestWithPayment(secondPayment, {
          paymentScheme: "exact",
          requestHash: "22".repeat(32),
        }),
        handler,
      ),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(executions).toBe(1);
    expect(maxActiveHandlers).toBe(1);
    const stored = await setup.store.loadExactPayment(EXACT_TX_ID);
    expect(
      stored?.paymentOutputIndex === 1 || stored?.paymentOutputIndex === 2,
    ).toBe(true);
  });

  it("rejects exact payloads without transaction artifacts", async () => {
    const setup = makeServer();
    const payment = makeExactPayment(setup) as unknown as PaymentPayload;
    if (payment.payload.type !== "exact-transaction")
      throw new Error("expected exact payload");
    delete (payment.payload as Record<string, unknown>).transaction;
    let executed = false;

    const response = await setup.server.handlePaidRequest(
      requestWithRawPaymentPayload(payment, { paymentScheme: "exact" }),
      async () => {
        executed = true;
        return { body: "download" };
      },
    );

    expect(response.status).toBe(402);
    expect(executed).toBe(false);
    await expect(
      setup.store.loadExactPayment(EXACT_TX_ID),
    ).resolves.toBeUndefined();
  });

  it("rejects exact transactions whose verified output does not match the offer", async () => {
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
            requestAuthorization: fakeAuthorizationEvidence(
              request.authorization,
            ),
          };
        },
      },
    });
    const payment = makeExactPayment(setup);
    let executed = false;

    const response = await setup.server.handlePaidRequest(
      requestWithRawPaymentPayload(payment, { paymentScheme: "exact" }),
      async () => {
        executed = true;
        return { body: "download" };
      },
    );

    expect(response.status).toBe(402);
    expect(response.body).toEqual({ error: "invalid_payment_requirements" });
    expect(executed).toBe(false);
    await expect(
      setup.store.loadExactPayment(EXACT_TX_ID),
    ).resolves.toBeUndefined();
  });

  it("does not verify additive accepted evidence below an authenticated confirmed requirement", async () => {
    const requiredFinalities: Array<"accepted" | "confirmed"> = [];
    const setup = await makeAdditiveServer({
      acceptedFinality: "accepted",
      exactTransactionVerifier: {
        verifyExactPayment(request) {
          requiredFinalities.push(request.requiredFinality);
          const head = request.head!;
          return {
            transactionId: EXACT_TX_ID,
            paymentOutput: {
              amount: request.amount,
              scriptPublicKey: request.payToScriptPublicKey,
            },
            continuation: {
              outpoint: { txid: EXACT_TX_ID, index: 0 },
              amount: (
                BigInt(head.headAmount) + BigInt(request.amount)
              ).toString(),
              scriptPublicKey: head.headScriptPublicKey,
            },
            finality: "accepted",
            payerAddress: "kaspatest:refund",
            requestAuthorization: fakeAuthorizationEvidence(
              request.authorization,
            ),
          };
        },
      },
    });
    const unpaid = await setup.server.handlePaidRequest(
      { url: RESOURCE.url, resource: RESOURCE, paymentScheme: "exact" },
      async () => ({ body: "unreachable" }),
    );
    const confirmed = structuredClone(
      decodePaymentRequiredHeader(unpaid.headers[PAYMENT_REQUIRED_HEADER])
        .accepts[0],
    ) as ExactPaymentRequirements;
    confirmed.extra.finality = "confirmed";
    const requestHash = "97".repeat(32) as Hash32Hex;
    const paymentPayload = makeAdditivePayment(confirmed, { requestHash });

    await expect(
      setup.server.verifyPayment({
        paymentPayload,
        paymentRequirements: confirmed,
        resource: RESOURCE,
        requestHash,
      }),
    ).rejects.toThrow("authenticated finality requirement");
    expect(requiredFinalities).toEqual(["confirmed"]);
  });

  it("claims, broadcasts, and advances a reusable KIP-10 head before the handler", async () => {
    const verificationRequests: unknown[] = [];
    const setup = await makeAdditiveServer({
      exactTransactionVerifier: {
        verifyExactPayment(request) {
          verificationRequests.push(request);
          const head = request.head!;
          return {
            transactionId: EXACT_TX_ID,
            paymentOutput: {
              amount: request.amount,
              scriptPublicKey: request.payToScriptPublicKey,
            },
            continuation: {
              outpoint: { txid: EXACT_TX_ID, index: 0 },
              amount: (
                BigInt(head.headAmount) + BigInt(request.amount)
              ).toString(),
              scriptPublicKey: head.headScriptPublicKey,
            },
            payerAddress: "kaspatest:refund",
            requestAuthorization: fakeAuthorizationEvidence(
              request.authorization,
            ),
          };
        },
      },
    });
    setup.chain.sendTransactionId = EXACT_TX_ID;

    const unpaid = await setup.server.handlePaidRequest(
      { url: RESOURCE.url, resource: RESOURCE, paymentScheme: "exact" },
      async () => ({
        body: "unreachable",
      }),
    );
    const required = decodePaymentRequiredHeader(
      unpaid.headers[PAYMENT_REQUIRED_HEADER],
    );
    const accepted = required.accepts[0] as ExactPaymentRequirements;
    expect(accepted.extra.templateId).toBe("kaspa-x402-kip10-additive-v1");
    expect(accepted.extra.transactionEncoding).toBe(
      "kaspa-sdk-safe-json-v2.0.0",
    );
    await expect(
      setup.store.loadExactHead(EXACT_HEAD_ID),
    ).resolves.toMatchObject({ status: "available", version: "0" });

    let handlerSawBroadcast = false;
    const payment = makeAdditivePayment(accepted);
    const response = await setup.server.handlePaidRequest(
      requestWithPayment(payment, { paymentScheme: "exact" }),
      async () => {
        handlerSawBroadcast = setup.chain.sentTransactions.includes(
          EXACT_TRANSACTION_ARTIFACT,
        );
        return { body: "download" };
      },
    );

    expect(response.status).toBe(200);
    expect(handlerSawBroadcast).toBe(true);
    expect(verificationRequests).toHaveLength(1);
    expect(verificationRequests[0]).toMatchObject({
      transaction: EXACT_TRANSACTION_ARTIFACT,
      transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
      head: { headId: EXACT_HEAD_ID, headVersion: "0" },
    });
    const settlement = decodePaymentResponseHeader(
      response.headers[PAYMENT_RESPONSE_HEADER],
    );
    const extra = readKaspaSettlementExtension(settlement)!;
    expect(settlement.transaction).toBe(EXACT_TX_ID);
    expect(extra).toMatchObject({
      paymentOutputIndex: 0,
      finality: "accepted",
      transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
      exactProfile: "additive",
    });
    await expect(
      setup.store.loadExactPayment(EXACT_TX_ID),
    ).resolves.toMatchObject({
      transactionId: EXACT_TX_ID,
      paymentOutputIndex: 0,
    });
    await expect(
      setup.store.loadExactHead(EXACT_HEAD_ID),
    ).resolves.toMatchObject({
      status: "available",
      version: "1",
      currentOutpoint: { txid: EXACT_TX_ID, index: 0 },
      currentAmount: "120000000",
    });
  });

  it("does not rebroadcast exact-transaction payloads already observed by the verifier", async () => {
    const setup = await makeAdditiveServer({
      exactTransactionVerifier: {
        verifyExactPayment(request) {
          const head = request.head!;
          return {
            transactionId: EXACT_TX_ID,
            paymentOutput: {
              amount: request.amount,
              scriptPublicKey: request.payToScriptPublicKey,
            },
            continuation: {
              outpoint: { txid: EXACT_TX_ID, index: 0 },
              amount: (
                BigInt(head.headAmount) + BigInt(request.amount)
              ).toString(),
              scriptPublicKey: head.headScriptPublicKey,
            },
            finality: "accepted",
            payerAddress: "kaspatest:refund",
            requestAuthorization: fakeAuthorizationEvidence(
              request.authorization,
            ),
          };
        },
      },
    });
    setup.chain.sendFailure = new Error("already submitted");

    const unpaid = await setup.server.handlePaidRequest(
      { url: RESOURCE.url, resource: RESOURCE, paymentScheme: "exact" },
      async () => ({
        body: "unreachable",
      }),
    );
    const accepted = decodePaymentRequiredHeader(
      unpaid.headers[PAYMENT_REQUIRED_HEADER],
    ).accepts[0] as ExactPaymentRequirements;
    const payment = makeAdditivePayment(accepted);
    let executions = 0;

    const response = await setup.server.handlePaidRequest(
      requestWithPayment(payment, { paymentScheme: "exact" }),
      async () => {
        executions += 1;
        return { body: "download" };
      },
    );

    expect(response.status).toBe(200);
    expect(response.body).toBe("download");
    expect(executions).toBe(1);
    expect(setup.chain.sentTransactions).toEqual([]);
    const settlement = decodePaymentResponseHeader(
      response.headers[PAYMENT_RESPONSE_HEADER],
    );
    expect(settlement.transaction).toBe(EXACT_TX_ID);
    expect(readKaspaSettlementExtension(settlement)).toMatchObject({
      paymentOutputIndex: 0,
      finality: "accepted",
      exactProfile: "additive",
    });
    await expect(
      setup.store.loadExactHead(EXACT_HEAD_ID),
    ).resolves.toMatchObject({ version: "1", lastTransactionId: EXACT_TX_ID });
  });

  it("rejects exact-transfer payloads for additive head challenges without mutating the head", async () => {
    const verificationRequests: unknown[] = [];
    const setup = await makeAdditiveServer({
      exactTransactionVerifier: {
        verifyExactPayment(request) {
          verificationRequests.push(request);
          return {
            transactionId: EXACT_TX_ID,
            paymentOutput: {
              amount: request.amount,
              scriptPublicKey: request.payToScriptPublicKey,
            },
            finality: "accepted",
            requestAuthorization: fakeAuthorizationEvidence(
              request.authorization,
            ),
          };
        },
      },
    });
    const unpaid = await setup.server.handlePaidRequest(
      { url: RESOURCE.url, resource: RESOURCE, paymentScheme: "exact" },
      async () => ({
        body: "unreachable",
      }),
    );
    const accepted = decodePaymentRequiredHeader(
      unpaid.headers[PAYMENT_REQUIRED_HEADER],
    ).accepts[0] as ExactPaymentRequirements;
    const payment = {
      x402Version: X402_VERSION,
      accepted,
      payload: {
        type: "exact-transfer",
        payerAddress: "kaspatest:refund",
        transactionId: EXACT_TX_ID,
        paymentOutputIndex: 0,
      },
    } as unknown as PaymentPayload;
    let executed = false;

    const response = await setup.server.handlePaidRequest(
      requestWithRawPaymentPayload(payment, { paymentScheme: "exact" }),
      async () => {
        executed = true;
        return { body: "download" };
      },
    );

    expect(response.status).toBe(402);
    expect(response.headers[PAYMENT_REQUIRED_HEADER]).toBeTruthy();
    expect(executed).toBe(false);
    expect(verificationRequests).toHaveLength(0);
    await expect(
      setup.store.loadExactPayment(EXACT_TX_ID),
    ).resolves.toBeUndefined();
    await expect(
      setup.store.loadExactHead(EXACT_HEAD_ID),
    ).resolves.toMatchObject({ status: "available", version: "0" });
  });

  it("does not run exact-transaction handlers when broadcast stays below observable finality", async () => {
    const setup = await makeAdditiveServer({
      exactTransactionVerifier: {
        verifyExactPayment(request) {
          const head = request.head!;
          return {
            transactionId: EXACT_TX_ID,
            paymentOutput: {
              amount: request.amount,
              scriptPublicKey: request.payToScriptPublicKey,
            },
            continuation: {
              outpoint: { txid: EXACT_TX_ID, index: 0 },
              amount: (
                BigInt(head.headAmount) + BigInt(request.amount)
              ).toString(),
              scriptPublicKey: head.headScriptPublicKey,
            },
            requestAuthorization: fakeAuthorizationEvidence(
              request.authorization,
            ),
          };
        },
      },
    });
    setup.chain.sendTransactionId = EXACT_TX_ID;
    setup.chain.finality = "broadcast";

    const unpaid = await setup.server.handlePaidRequest(
      { url: RESOURCE.url, resource: RESOURCE, paymentScheme: "exact" },
      async () => ({
        body: "unreachable",
      }),
    );
    const accepted = decodePaymentRequiredHeader(
      unpaid.headers[PAYMENT_REQUIRED_HEADER],
    ).accepts[0] as ExactPaymentRequirements;
    const payment = makeAdditivePayment(accepted);
    let executed = false;

    const response = await setup.server.handlePaidRequest(
      requestWithPayment(payment, { paymentScheme: "exact" }),
      async () => {
        executed = true;
        return { body: "download" };
      },
    );

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: "exact_settlement_recovery_required",
    });
    expect(executed).toBe(false);
    expect(setup.chain.sentTransactions).toEqual([EXACT_TRANSACTION_ARTIFACT]);
    await expect(
      setup.store.loadExactPayment(EXACT_TX_ID),
    ).resolves.toBeUndefined();
    await expect(
      setup.store.loadExactSettlementAttempt(EXACT_TX_ID),
    ).resolves.toMatchObject({ status: "broadcast", finality: "broadcast" });
    await expect(
      setup.store.loadExactHead(EXACT_HEAD_ID),
    ).resolves.toMatchObject({
      status: "claimed",
      claimTransactionId: EXACT_TX_ID,
    });
  });

  it("refreshes expired additive head challenges without retiring the head", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const setup = await makeAdditiveServer({
        maxTimeoutSeconds: 1,
        exactTransactionVerifier: {
          verifyExactPayment(request) {
            const head = request.head!;
            return {
              transactionId: EXACT_TX_ID,
              paymentOutput: {
                amount: request.amount,
                scriptPublicKey: request.payToScriptPublicKey,
              },
              continuation: {
                outpoint: { txid: EXACT_TX_ID, index: 0 },
                amount: (
                  BigInt(head.headAmount) + BigInt(request.amount)
                ).toString(),
                scriptPublicKey: head.headScriptPublicKey,
              },
              requestAuthorization: fakeAuthorizationEvidence(
                request.authorization,
              ),
            };
          },
        },
      });

      const unpaid = await setup.server.handlePaidRequest(
        { url: RESOURCE.url, resource: RESOURCE, paymentScheme: "exact" },
        async () => ({
          body: "unreachable",
        }),
      );
      const accepted = decodePaymentRequiredHeader(
        unpaid.headers[PAYMENT_REQUIRED_HEADER],
      ).accepts[0] as ExactPaymentRequirements;
      const payment = makeAdditivePayment(accepted);
      vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));

      const response = await setup.server.handlePaidRequest(
        requestWithPayment(payment, { paymentScheme: "exact" }),
        async () => ({
          body: "unreachable",
        }),
      );

      expect(response.status).toBe(402);
      expect(setup.chain.sentTransactions).toEqual([]);
      const corrective = decodePaymentRequiredHeader(
        response.headers[PAYMENT_REQUIRED_HEADER],
      );
      const refreshed = corrective.accepts[0] as ExactPaymentRequirements;
      expect(refreshed.extra.headId).toBe(EXACT_HEAD_ID);
      expect(refreshed.extra.challengeId).not.toBe(accepted.extra.challengeId);
      await expect(
        setup.store.loadExactHead(EXACT_HEAD_ID),
      ).resolves.toMatchObject({ status: "available", version: "0" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns cached idempotent responses for exact-transaction retries", async () => {
    const setup = await makeAdditiveServer({
      requirePaymentIdentifier: true,
      exactTransactionVerifier: {
        verifyExactPayment(request) {
          const head = request.head!;
          return {
            transactionId: EXACT_TX_ID,
            paymentOutput: {
              amount: request.amount,
              scriptPublicKey: request.payToScriptPublicKey,
            },
            continuation: {
              outpoint: { txid: EXACT_TX_ID, index: 0 },
              amount: (
                BigInt(head.headAmount) + BigInt(request.amount)
              ).toString(),
              scriptPublicKey: head.headScriptPublicKey,
            },
            payerAddress: "kaspatest:refund",
            requestAuthorization: fakeAuthorizationEvidence(
              request.authorization,
            ),
          };
        },
      },
    });
    setup.chain.sendTransactionId = EXACT_TX_ID;
    const paymentIdentifier = "pay_7d5d747be160e280504c099d984bcfe0";
    const requestHash = "aa".repeat(32);
    const unpaid = await setup.server.handlePaidRequest(
      { url: RESOURCE.url, resource: RESOURCE, paymentScheme: "exact" },
      async () => ({
        body: "unreachable",
      }),
    );
    const accepted = decodePaymentRequiredHeader(
      unpaid.headers[PAYMENT_REQUIRED_HEADER],
    ).accepts[0] as ExactPaymentRequirements;
    const payment: PaymentPayload = {
      ...makeAdditivePayment(accepted, { requestHash }),
      ...paymentIdentifierExtension(paymentIdentifier),
    };
    let executions = 0;

    const first = await setup.server.handlePaidRequest(
      requestWithPayment(payment, { paymentScheme: "exact", requestHash }),
      async () => {
        executions += 1;
        return { body: "cached" };
      },
    );
    const second = await setup.server.handlePaidRequest(
      requestWithPayment(payment, { paymentScheme: "exact", requestHash }),
      async () => {
        executions += 1;
        return { body: "wrong" };
      },
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toBe("cached");
    expect(executions).toBe(1);
    expect(setup.chain.sentTransactions).toEqual([EXACT_TRANSACTION_ARTIFACT]);
  });

  it("returns cached accepted exact replays after challenge expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const setup = await makeAdditiveServer({ maxTimeoutSeconds: 1 });
      const requestHash = "ab".repeat(32);
      const unpaid = await setup.server.handlePaidRequest(
        { url: RESOURCE.url, resource: RESOURCE, paymentScheme: "exact" },
        async () => ({
          body: "unreachable",
        }),
      );
      const accepted = decodePaymentRequiredHeader(
        unpaid.headers[PAYMENT_REQUIRED_HEADER],
      ).accepts[0] as ExactPaymentRequirements;
      const payment = makeAdditivePayment(accepted, { requestHash });
      let executions = 0;

      const first = await setup.server.handlePaidRequest(
        requestWithPayment(payment, { paymentScheme: "exact", requestHash }),
        async () => {
          executions += 1;
          return { body: "cached" };
        },
      );
      vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
      const second = await setup.server.handlePaidRequest(
        requestWithPayment(payment, { paymentScheme: "exact", requestHash }),
        async () => {
          executions += 1;
          return { body: "wrong" };
        },
      );

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body).toBe("cached");
      expect(executions).toBe(1);
      expect(setup.chain.sentTransactions).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not recover an ambiguous exact settlement below its durable finality threshold", async () => {
    let reconciledFinality: "accepted" | "confirmed" = "accepted";
    const setup = await makeAdditiveServer({
      acceptedFinality: "confirmed",
      exactSettlementReconciler: {
        reconcileExactSettlement(attempt) {
          return {
            status: "accepted",
            transactionId: attempt.transactionId,
            finality: reconciledFinality,
            paymentOutput: {
              amount: attempt.amount,
              scriptPublicKey: attempt.payToScriptPublicKey,
            },
            continuation: attempt.head!.successor,
          };
        },
      },
      exactTransactionVerifier: {
        verifyExactPayment(request) {
          const head = request.head!;
          return {
            transactionId: EXACT_TX_ID,
            paymentOutput: {
              amount: request.amount,
              scriptPublicKey: request.payToScriptPublicKey,
            },
            continuation: {
              outpoint: { txid: EXACT_TX_ID, index: 0 },
              amount: (
                BigInt(head.headAmount) + BigInt(request.amount)
              ).toString(),
              scriptPublicKey: head.headScriptPublicKey,
            },
            requestAuthorization: fakeAuthorizationEvidence(
              request.authorization,
            ),
          };
        },
      },
    });
    setup.chain.sendFailure = new Error("ambiguous transport failure");
    const requestHash = "ac".repeat(32);
    const unpaid = await setup.server.handlePaidRequest(
      { url: RESOURCE.url, resource: RESOURCE, paymentScheme: "exact" },
      async () => ({
        body: "unreachable",
      }),
    );
    const accepted = decodePaymentRequiredHeader(
      unpaid.headers[PAYMENT_REQUIRED_HEADER],
    ).accepts[0] as ExactPaymentRequirements;
    const payment = makeAdditivePayment(accepted, { requestHash });
    let handlerInvocations = 0;
    const handler = () => {
      handlerInvocations += 1;
      return { body: "recovered" };
    };

    const first = await setup.server.handlePaidRequest(
      requestWithPayment(payment, { paymentScheme: "exact", requestHash }),
      handler,
    );
    const second = await setup.server.handlePaidRequest(
      requestWithPayment(payment, { paymentScheme: "exact", requestHash }),
      handler,
    );

    expect(first).toMatchObject({
      status: 503,
      body: { error: "exact_settlement_recovery_required" },
    });
    expect(second).toMatchObject({
      status: 503,
      body: { error: "exact_settlement_recovery_required" },
    });
    expect(handlerInvocations).toBe(0);
    expect(setup.chain.sentTransactions).toEqual([EXACT_TRANSACTION_ARTIFACT]);
    await expect(
      setup.store.loadExactPayment(EXACT_TX_ID),
    ).resolves.toBeUndefined();
    await expect(
      setup.store.loadExactSettlementAttempt(EXACT_TX_ID),
    ).resolves.toMatchObject({ status: "pending" });
    await expect(
      setup.store.loadExactHead(EXACT_HEAD_ID),
    ).resolves.toMatchObject({
      status: "claimed",
      claimTransactionId: EXACT_TX_ID,
    });

    await expect(
      setup.server.reconcileExactSettlement(EXACT_TX_ID),
    ).rejects.toThrow("stored finality requirement");
    await expect(
      setup.store.loadExactSettlementAttempt(EXACT_TX_ID),
    ).resolves.toMatchObject({
      status: "pending",
      requiredFinality: "confirmed",
    });
    reconciledFinality = "confirmed";
    await expect(
      setup.server.reconcileExactSettlement(EXACT_TX_ID),
    ).resolves.toMatchObject({ status: "accepted", finality: "confirmed" });
    const recovered = await setup.server.handlePaidRequest(
      requestWithPayment(payment, { paymentScheme: "exact", requestHash }),
      handler,
    );
    expect(recovered).toMatchObject({ status: 200, body: "recovered" });
    expect(handlerInvocations).toBe(1);
    expect(setup.chain.sentTransactions).toEqual([EXACT_TRANSACTION_ARTIFACT]);
    await expect(
      setup.store.loadExactHead(EXACT_HEAD_ID),
    ).resolves.toMatchObject({ status: "available", version: "1" });
  });

  it("follows only a complete trusted external head lineage and fails closed after reorg uncertainty", async () => {
    let reconciliation = 0;
    const setup = await makeAdditiveServer({
      exactHeadReconciler: {
        reconcileExactHead(head, candidates) {
          reconciliation += 1;
          if (reconciliation > 1) {
            return {
              status: "unknown",
              reason: "accepted successor disappeared from the trusted view",
            };
          }
          expect(candidates).toEqual([EXACT_TX_ID, CLAIM_TX]);
          return {
            status: "advanced",
            steps: [
              {
                transactionId: EXACT_TX_ID,
                spentOutpoint: head.currentOutpoint,
                successor: {
                  outpoint: { txid: EXACT_TX_ID, index: 0 },
                  amount: "110000000",
                  scriptPublicKey: head.scriptPublicKey,
                },
                finality: "accepted",
              },
              {
                transactionId: CLAIM_TX,
                spentOutpoint: { txid: EXACT_TX_ID, index: 0 },
                successor: {
                  outpoint: { txid: CLAIM_TX, index: 0 },
                  amount: "125000000",
                  scriptPublicKey: head.scriptPublicKey,
                },
                finality: "confirmed",
              },
            ],
          };
        },
      },
    });

    await expect(
      setup.server.reconcileExactHead(EXACT_HEAD_ID, [EXACT_TX_ID, CLAIM_TX]),
    ).resolves.toMatchObject({
      status: "available",
      version: "2",
      currentOutpoint: { txid: CLAIM_TX, index: 0 },
      currentAmount: "125000000",
      lastTransactionId: CLAIM_TX,
    });

    await expect(
      setup.server.reconcileExactHead(EXACT_HEAD_ID),
    ).resolves.toMatchObject({
      status: "unavailable",
      unavailableReason: "accepted successor disappeared from the trusted view",
    });
  });

  it("never adopts an attacker-created same-address output without the expected input lineage", async () => {
    const setup = await makeAdditiveServer({
      exactHeadReconciler: {
        reconcileExactHead(head) {
          return {
            status: "advanced",
            steps: [
              {
                transactionId: EXACT_TX_ID,
                spentOutpoint: { txid: TOP_UP_TX, index: 0 },
                successor: {
                  outpoint: { txid: EXACT_TX_ID, index: 0 },
                  amount: "120000000",
                  scriptPublicKey: head.scriptPublicKey,
                },
                finality: "accepted",
              },
            ],
          };
        },
      },
    });

    await expect(
      setup.server.reconcileExactHead(EXACT_HEAD_ID),
    ).rejects.toThrow("valid KIP-10 successor lineage");
    await expect(
      setup.store.loadExactHead(EXACT_HEAD_ID),
    ).resolves.toMatchObject({
      status: "unavailable",
      unavailableReason:
        "trusted external-head evidence failed lineage validation",
    });
  });

  it("rejects a hostile adapter finality outside accepted or confirmed", async () => {
    const setup = await makeAdditiveServer({
      exactHeadReconciler: {
        reconcileExactHead(head) {
          return {
            status: "advanced",
            steps: [
              {
                transactionId: EXACT_TX_ID,
                spentOutpoint: head.currentOutpoint,
                successor: {
                  outpoint: { txid: EXACT_TX_ID, index: 0 },
                  amount: "110000000",
                  scriptPublicKey: head.scriptPublicKey,
                },
                finality: "mempool" as never,
              },
            ],
          };
        },
      },
    });

    await expect(
      setup.server.reconcileExactHead(EXACT_HEAD_ID),
    ).rejects.toThrow("valid KIP-10 successor lineage");
    await expect(
      setup.store.loadExactHead(EXACT_HEAD_ID),
    ).resolves.toMatchObject({ status: "unavailable" });
  });

  it("contains top-up grief to the additive head and leaves standard-native available", async () => {
    const additive = await makeAdditiveServer({
      exactHeadReconciler: {
        reconcileExactHead() {
          return {
            status: "unknown",
            reason: "current outpoint spent without trusted successor proof",
          };
        },
      },
    });
    await additive.server.reconcileExactHead(EXACT_HEAD_ID);

    const additiveOffer = await additive.server.handlePaidRequest(
      { url: RESOURCE.url, resource: RESOURCE, paymentScheme: "exact" },
      async () => ({ body: "unreachable" }),
    );
    expect(additiveOffer.status).toBe(503);

    const standard = makeServer({ exactProfile: "standard-native" });
    const standardOffer = await standard.server.handlePaidRequest(
      { url: RESOURCE.url, resource: RESOURCE, paymentScheme: "exact" },
      async () => ({ body: "unreachable" }),
    );
    expect(standardOffer.status).toBe(402);
    const accepted = decodePaymentRequiredHeader(
      standardOffer.headers[PAYMENT_REQUIRED_HEADER],
    ).accepts[0] as ExactPaymentRequirements;
    expect(accepted.extra.profile).toBe("standard-native");
  });

  it("bounds external head reconciliation candidates before calling adapters", async () => {
    let calls = 0;
    const setup = await makeAdditiveServer({
      exactHeadReconciler: {
        reconcileExactHead() {
          calls += 1;
          return { status: "unknown", reason: "unreachable" };
        },
      },
    });
    const candidates = Array.from({ length: 65 }, (_, index) =>
      index.toString(16).padStart(64, "0"),
    );

    await expect(
      setup.server.reconcileExactHead(EXACT_HEAD_ID, candidates),
    ).rejects.toThrow("candidates are invalid");
    expect(calls).toBe(0);
  });

  it("returns a controlled 402 when request fingerprinting needs an explicit hash", async () => {
    const setup = makeServer();
    const payment = makeExactPayment(setup);

    const response = await setup.server.handlePaidRequest(
      requestWithPayment(payment, {
        paymentScheme: "exact",
        body: new URLSearchParams([["a", "b"]]),
      }),
      async () => ({ body: "wrong" }),
    );

    expect(response.status).toBe(402);
    expect(response.headers[PAYMENT_REQUIRED_HEADER]).toBeTruthy();
  });

  it("accepts an initial deposit-voucher and commits channel state after handler success", async () => {
    const setup = makeServer();
    const payment = makeDepositPayment(setup);

    const response = await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload),
      async () => ({
        body: "secret",
        chargedAmount: "70",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.body).toBe("secret");
    expect(response.headers[PAYMENT_RESPONSE_HEADER]).toBeTruthy();
    const stored = await setup.store.loadChannel(payment.channelId);
    expect(stored?.chargedCumulativeAmount).toBe("70");
    expect(stored?.signedMaxClaimable).toBe("100");
    expect(stored?.lastCommitmentId).toMatch(/^[0-9a-f]{64}$/);
    const commitment = await setup.store.loadCommitment(
      stored!.lastCommitmentId!,
    );
    expect(commitment?.chargedAmount).toBe("70");
    expect(commitment?.chargedCumulativeAfter).toBe("70");
    expect(commitment?.response.status).toBe(200);
  });

  it("rejects a signed batch authorization replayed for another request", async () => {
    const setup = makeServer();
    const payment = makeDepositPayment(setup);
    let executed = false;

    const response = await setup.server.handlePaidRequest(
      requestWithRawPaymentPayload(payment.payload, {
        requestHash: "aa".repeat(32),
      }),
      async () => {
        executed = true;
        return { chargedAmount: "100" };
      },
    );

    expect(response.status).toBe(402);
    expect(executed).toBe(false);
    await expect(
      setup.store.loadChannel(payment.channelId),
    ).resolves.toBeUndefined();
  });

  it("rejects a salted channel alias for an already registered covenant", async () => {
    const setup = makeServer();
    const first = makeDepositPayment(setup, { salt: "31".repeat(32) });
    const alias = makeDepositPayment(setup, { salt: "32".repeat(32) });
    let handlerCalls = 0;
    const handler = async () => {
      handlerCalls += 1;
      return { body: "secret", chargedAmount: "100" };
    };

    const accepted = await setup.server.handlePaidRequest(
      requestWithPayment(first.payload),
      handler,
    );
    const rejected = await setup.server.handlePaidRequest(
      requestWithPayment(alias.payload),
      handler,
    );

    expect(first.channelId).not.toBe(alias.channelId);
    expect(accepted.status).toBe(200);
    expect(rejected.status).toBe(503);
    expect(handlerCalls).toBe(1);
    await expect(
      setup.store.loadChannel(first.channelId),
    ).resolves.toBeDefined();
    await expect(
      setup.store.loadChannel(alias.channelId),
    ).resolves.toBeUndefined();
  });

  it("allows only one concurrent salted alias to register a covenant", async () => {
    const setup = makeServer();
    const first = makeDepositPayment(setup, { salt: "33".repeat(32) });
    const alias = makeDepositPayment(setup, { salt: "34".repeat(32) });
    let handlerCalls = 0;
    const handler = async () => {
      handlerCalls += 1;
      return { body: "secret", chargedAmount: "100" };
    };

    const responses = await Promise.all([
      setup.server.handlePaidRequest(
        requestWithPayment(first.payload),
        handler,
      ),
      setup.server.handlePaidRequest(
        requestWithPayment(alias.payload),
        handler,
      ),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 503,
    ]);
    expect(handlerCalls).toBe(1);
    const channels = await setup.store.listChannels();
    expect(channels).toHaveLength(1);
    expect([first.channelId, alias.channelId]).toContain(
      channels[0]?.channelId,
    );
  });

  it("accepts a voucher-only retry on an existing channel", async () => {
    const setup = makeServer();
    const deposit = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(
      requestWithPayment(deposit.payload),
      async () => ({ chargedAmount: "100" }),
    );
    const channel = await requireChannel(setup.store, deposit.channelId);
    const voucher = makeVoucherPayment(setup, channel);

    const response = await setup.server.handlePaidRequest(
      requestWithPayment(voucher),
      async () => ({ body: "next", chargedAmount: "80" }),
    );

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
          if (
            previous.channelId !== next.channelId ||
            next.activeOutpoint.txid !== TOP_UP_TX
          )
            return null;
          return {
            covenantId: previous.covenantId,
            spentOutpoint: previous.activeOutpoint,
            successorOutpoint: next.activeOutpoint,
            successorScriptPublicKey: next.activeScriptPublicKey,
            successorAmount: next.fundingAmount,
            authorizedSuccessorCount: 1,
          };
        },
      },
    });
    const deposit = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(
      requestWithPayment(deposit.payload),
      async () => ({ chargedAmount: "100" }),
    );
    const topUp = makeDepositPayment(setup, {
      fundingTx: TOP_UP_TX,
      fundingAmount: "1200",
      voucherAmount: "200",
    });

    const response = await setup.server.handlePaidRequest(
      requestWithPayment(topUp.payload),
      async () => ({ body: "topped", chargedAmount: "80" }),
    );

    expect(response.status).toBe(200);
    expect(response.body).toBe("topped");
    const stored = await requireChannel(setup.store, deposit.channelId);
    expect(stored.activeOutpoint.txid).toBe(TOP_UP_TX);
    expect(stored.fundingAmount).toBe("1200");
    expect(stored.chargedCumulativeAmount).toBe("180");
    expect(stored.signedMaxClaimable).toBe("200");
  });

  it.each(["1000", "900"])(
    "rejects a top-up successor funding value of %s without changing the durable head",
    async (fundingAmount) => {
      const setup = makeServer({
        topUpVerifier: {
          async verifyTopUp({ previous, next }) {
            return {
              covenantId: previous.covenantId,
              spentOutpoint: previous.activeOutpoint,
              successorOutpoint: next.activeOutpoint,
              successorScriptPublicKey: next.activeScriptPublicKey,
              successorAmount: next.fundingAmount,
              authorizedSuccessorCount: 1,
            };
          },
        },
      });
      const deposit = makeDepositPayment(setup);
      await setup.server.handlePaidRequest(
        requestWithPayment(deposit.payload),
        async () => ({ chargedAmount: "100" }),
      );
      const prior = await requireChannel(setup.store, deposit.channelId);
      const topUp = makeDepositPayment(setup, {
        fundingTx: TOP_UP_TX,
        fundingAmount,
        voucherAmount: "200",
      });
      let executed = false;

      const response = await setup.server.handlePaidRequest(
        requestWithPayment(topUp.payload),
        async () => {
          executed = true;
          return { chargedAmount: "100" };
        },
      );

      expect(response.status).toBe(402);
      expect(executed).toBe(false);
      await expect(setup.store.loadChannel(deposit.channelId)).resolves.toEqual(
        prior,
      );
    },
  );

  it("rejects underpaid vouchers without executing the handler", async () => {
    const setup = makeServer();
    const deposit = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(
      requestWithPayment(deposit.payload),
      async () => ({ chargedAmount: "100" }),
    );
    const channel = await requireChannel(setup.store, deposit.channelId);
    const underpaid = makeVoucherPayment(setup, channel, {
      voucherAmount: "150",
    });
    let executed = false;

    const response = await setup.server.handlePaidRequest(
      requestWithPayment(underpaid),
      async () => {
        executed = true;
        return {};
      },
    );

    expect(response.status).toBe(402);
    expect(executed).toBe(false);
    const stored = await requireChannel(setup.store, deposit.channelId);
    expect(stored.chargedCumulativeAmount).toBe("100");
  });

  it("rejects bad voucher signatures", async () => {
    const setup = makeServer();
    const payment = makeDepositPayment(setup, { badSignature: true });
    let executed = false;

    const response = await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload),
      async () => {
        executed = true;
        return {};
      },
    );

    expect(response.status).toBe(402);
    expect(executed).toBe(false);
    await expect(
      setup.store.loadChannel(payment.channelId),
    ).resolves.toBeUndefined();
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

    const response = await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload),
      async () => ({ body: "secret" }),
    );

    expect(response.status).toBe(402);
    await expect(
      setup.store.loadChannel(payment.channelId),
    ).resolves.toBeUndefined();
  });

  it("does not advance channel state when the handler fails", async () => {
    const setup = makeServer();
    const payment = makeDepositPayment(setup);

    const response = await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload),
      async () => {
        throw new Error("handler failed");
      },
    );

    expect(response.status).toBe(500);
    const stored = await requireChannel(setup.store, payment.channelId);
    expect(stored.chargedCumulativeAmount).toBe("0");
    expect(stored.signedMaxClaimable).toBe("100");
    expect(stored.voucherSignature).toBeTruthy();
  });

  it("preserves accepted deposit state when handler returns a non-canonical charge", async () => {
    const setup = makeServer();
    const payment = makeDepositPayment(setup);

    const response = await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload),
      async () => ({ chargedAmount: "1.5" }),
    );

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: "batch_settlement_recovery_required",
    });
    const stored = await requireChannel(setup.store, payment.channelId);
    expect(stored.chargedCumulativeAmount).toBe("0");
    expect(stored.signedMaxClaimable).toBe("100");
    expect(stored.voucherSignature).toBeTruthy();
  });

  it("returns cached idempotent responses without double executing", async () => {
    const setup = makeServer({ requirePaymentIdentifier: true });
    const payment = makeDepositPayment(setup, {
      paymentIdentifier: "pay_7d5d747be160e280504c099d984bcfe0",
    });
    let executions = 0;

    const first = await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload, { requestHash: "aa".repeat(32) }),
      async () => {
        executions += 1;
        return { body: "cached", chargedAmount: "50" };
      },
    );
    const second = await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload, { requestHash: "aa".repeat(32) }),
      async () => {
        executions += 1;
        return { body: "wrong" };
      },
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toBe("cached");
    expect(executions).toBe(1);
  });

  it("returns cached deposit-voucher responses without a payment identifier", async () => {
    const setup = makeServer();
    const payment = makeDepositPayment(setup);
    let executions = 0;

    const first = await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload, { requestHash: "aa".repeat(32) }),
      async () => {
        executions += 1;
        return { body: "cached", chargedAmount: "50" };
      },
    );
    const second = await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload, { requestHash: "aa".repeat(32) }),
      async () => {
        executions += 1;
        return { body: "wrong" };
      },
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toBe("cached");
    expect(second.headers[PAYMENT_RESPONSE_HEADER]).toBe(
      first.headers[PAYMENT_RESPONSE_HEADER],
    );
    expect(executions).toBe(1);
    const stored = await requireChannel(setup.store, payment.channelId);
    expect(stored.chargedCumulativeAmount).toBe("50");
    expect(stored.signedMaxClaimable).toBe("100");
  });

  it.each([
    ["with a payment identifier", true],
    ["without a payment identifier", false],
  ])(
    "rejects expired cached batch responses %s",
    async (_label, withIdentifier) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      try {
        const setup = makeServer({ requirePaymentIdentifier: withIdentifier });
        const payment = makeDepositPayment(setup, {
          ...(withIdentifier
            ? { paymentIdentifier: "pay_7d5d747be160e280504c099d984bcfe0" }
            : {}),
        });
        const request = requestWithPayment(payment.payload, {
          requestHash: "aa".repeat(32),
        });
        let executions = 0;
        const handler = async () => {
          executions += 1;
          return { body: "cached", chargedAmount: "50" };
        };

        await expect(
          setup.server.handlePaidRequest(request, handler),
        ).resolves.toMatchObject({ status: 200 });
        vi.setSystemTime(new Date("2026-01-01T00:00:31.000Z"));
        const expired = await setup.server.handlePaidRequest(request, handler);

        expect(expired).toMatchObject({
          status: 402,
          body: { error: "invalid_payload" },
        });
        expect(executions).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    ["with a payment identifier", true],
    ["without a payment identifier", false],
  ])(
    "does not authenticate cached batch responses with changed authorization %s",
    async (_label, withIdentifier) => {
      const setup = makeServer({ requirePaymentIdentifier: withIdentifier });
      const payment = makeDepositPayment(setup, {
        ...(withIdentifier
          ? { paymentIdentifier: "pay_7d5d747be160e280504c099d984bcfe0" }
          : {}),
      });
      const requestHash = "aa".repeat(32) as Hash32Hex;
      const request = requestWithPayment(payment.payload, { requestHash });
      let executions = 0;
      const handler = async () => {
        executions += 1;
        return { body: "cached", chargedAmount: "50" };
      };
      await expect(
        setup.server.handlePaidRequest(request, handler),
      ).resolves.toMatchObject({ status: 200 });
      const changed = decodePaymentSignatureHeader(
        request.headers[PAYMENT_SIGNATURE_HEADER],
      );
      if (
        changed.payload.type !== "deposit-voucher" &&
        changed.payload.type !== "voucher"
      )
        throw new Error("expected voucher payload");
      changed.payload.authorization.signature = "ff".repeat(64);

      const rejected = await setup.server.handlePaidRequest(
        requestWithRawPaymentPayload(changed, { requestHash }),
        handler,
      );

      expect(rejected.status).not.toBe(200);
      expect(executions).toBe(1);
    },
  );

  it("keeps stale batch vouchers corrective after a later commitment", async () => {
    const setup = makeServer();
    const deposit = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(
      requestWithPayment(deposit.payload, { requestHash: "aa".repeat(32) }),
      async () => ({
        chargedAmount: "50",
      }),
    );
    const channel = await requireChannel(setup.store, deposit.channelId);
    const voucher = makeVoucherPayment(setup, channel);
    await setup.server.handlePaidRequest(
      requestWithPayment(voucher, { requestHash: "bb".repeat(32) }),
      async () => ({
        chargedAmount: "50",
      }),
    );
    let executed = false;

    const stale = await setup.server.handlePaidRequest(
      requestWithPayment(deposit.payload, { requestHash: "aa".repeat(32) }),
      async () => {
        executed = true;
        return { body: "wrong" };
      },
    );

    expect(stale.status).toBe(402);
    expect(stale.body).toEqual({ error: "invalid_payment_requirements" });
    expect(executed).toBe(false);
  });

  it("rejects changed payment payloads for reused payment identifiers", async () => {
    const setup = makeServer({ requirePaymentIdentifier: true });
    const paymentIdentifier = "pay_7d5d747be160e280504c099d984bcfe0";
    const deposit = makeDepositPayment(setup, { paymentIdentifier });
    let executions = 0;

    const first = await setup.server.handlePaidRequest(
      requestWithPayment(deposit.payload, { requestHash: "aa".repeat(32) }),
      async () => {
        executions += 1;
        return { body: "cached", chargedAmount: "50" };
      },
    );
    const channel = await requireChannel(setup.store, deposit.channelId);
    const refreshed = makeVoucherPayment(setup, channel, { paymentIdentifier });
    const second = await setup.server.handlePaidRequest(
      requestWithPayment(refreshed, { requestHash: "aa".repeat(32) }),
      async () => {
        executions += 1;
        return { body: "wrong" };
      },
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: "invalid_transaction_state" });
    expect(executions).toBe(1);
    const stored = await requireChannel(setup.store, deposit.channelId);
    expect(stored.chargedCumulativeAmount).toBe("50");
  });

  it("does not return cached content for a different payment payload", async () => {
    const setup = makeServer({ requirePaymentIdentifier: true });
    const payment = makeDepositPayment(setup, {
      paymentIdentifier: "pay_7d5d747be160e280504c099d984bcfe0",
    });
    await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload, { requestHash: "aa".repeat(32) }),
      async () => ({
        body: "cached",
        chargedAmount: "50",
      }),
    );
    const tampered = structuredClone(payment.payload);
    if (tampered.payload.type !== "deposit-voucher")
      throw new Error("expected deposit-voucher");
    tampered.payload.voucher.signature = "ff".repeat(64);
    let executed = false;

    const response = await setup.server.handlePaidRequest(
      requestWithPayment(tampered, { requestHash: "aa".repeat(32) }),
      async () => {
        executed = true;
        return { body: "wrong" };
      },
    );

    expect(response.status).toBe(409);
    expect(executed).toBe(false);
  });

  it("preserves the verified head without committing charge or idempotency when settlement persistence fails", async () => {
    const store = new FailingCommitStore();
    const setup = makeServer({ requirePaymentIdentifier: true, store });
    const paymentIdentifier = "pay_7d5d747be160e280504c099d984bcfe0";
    const payment = makeDepositPayment(setup, { paymentIdentifier });

    const response = await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload, { requestHash: "aa".repeat(32) }),
      async () => ({
        body: "cached",
        chargedAmount: "50",
      }),
    );

    expect(response.status).toBe(500);
    await expect(
      setup.store.loadChannel(payment.channelId),
    ).resolves.toMatchObject({
      covenantId: COVENANT_ID,
      chargedCumulativeAmount: "0",
      signedMaxClaimable: "100",
    });
    await expect(
      setup.store.loadPaymentIdentifier(paymentIdentifier),
    ).resolves.toBeUndefined();
  });

  it("resumes a durable batch handler result after its authorization expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const store = new FailingBatchCommitStore(1);
      const setup = makeServer({ store });
      const payment = makeDepositPayment(setup);
      const request = requestWithPayment(payment.payload, {
        requestHash: "aa".repeat(32),
      });
      let executions = 0;
      const run = () =>
        setup.server.handlePaidRequest(request, async () => {
          executions += 1;
          return { body: "durable", chargedAmount: "50" };
        });

      await expect(run()).resolves.toMatchObject({ status: 500 });
      vi.setSystemTime(new Date("2026-01-01T00:00:31.000Z"));
      const recovered = await run();

      expect(recovered.status).toBe(200);
      expect(recovered.body).toBe("durable");
      expect(executions).toBe(1);
      await expect(
        setup.store.loadChannel(payment.channelId),
      ).resolves.toMatchObject({
        chargedCumulativeAmount: "50",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a fresh batch authorization adopt an expired staged result", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const store = new FailingBatchCommitStore(1);
      const setup = makeServer({ store });
      const payment = makeDepositPayment(setup);
      const originalRequest = requestWithPayment(payment.payload, {
        requestHash: "aa".repeat(32),
      });
      let executions = 0;
      const handler = async () => {
        executions += 1;
        return { body: "durable", chargedAmount: "50" };
      };

      await expect(
        setup.server.handlePaidRequest(originalRequest, handler),
      ).resolves.toMatchObject({ status: 500 });
      vi.setSystemTime(new Date("2026-01-01T00:00:31.000Z"));
      const freshRequest = requestWithPayment(payment.payload, {
        requestHash: "aa".repeat(32),
      });
      const conflicted = await setup.server.handlePaidRequest(
        freshRequest,
        handler,
      );

      expect(conflicted).toMatchObject({
        status: 503,
        body: { error: "batch_settlement_recovery_required" },
      });
      expect(executions).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start batch work for an expired authorization without a staged result", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const setup = makeServer();
      const payment = makeDepositPayment(setup);
      const request = requestWithPayment(payment.payload);
      vi.setSystemTime(new Date("2026-01-01T00:00:31.000Z"));
      let executions = 0;

      const response = await setup.server.handlePaidRequest(
        request,
        async () => {
          executions += 1;
          return { body: "must not run", chargedAmount: "50" };
        },
      );

      expect(response).toMatchObject({
        status: 402,
        body: { error: "invalid_payload" },
      });
      expect(executions).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not preserve unclaimed genesis evidence after atomic adoption fails", async () => {
    const store = new FailingBatchClaimStore();
    const setup = makeServer({ store });
    const payment = makeDepositPayment(setup);
    let executions = 0;

    const first = await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload),
      async () => {
        executions += 1;
        return { chargedAmount: "100" };
      },
    );
    expect(first.status).toBe(503);
    expect(executions).toBe(0);
    setup.chain.genesisAvailable = false;

    const retried = await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload),
      async () => {
        executions += 1;
        return { chargedAmount: "100" };
      },
    );

    expect(retried.status).toBe(402);
    expect(executions).toBe(0);
    expect(setup.chain.genesisVerificationCount).toBe(2);
  });

  it("rejects covenant genesis evidence with an extra unauthorized output", async () => {
    const setup = makeServer();
    setup.chain.genesisTotalOutputCount = 2;
    const payment = makeDepositPayment(setup);
    let executed = false;

    const response = await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload),
      async () => {
        executed = true;
        return { chargedAmount: "100" };
      },
    );

    expect(response.status).toBe(402);
    expect(executed).toBe(false);
    await expect(
      setup.store.loadChannel(payment.channelId),
    ).resolves.toBeUndefined();
  });

  it("rejects reused payment identifiers with a different fingerprint", async () => {
    const setup = makeServer({ requirePaymentIdentifier: true });
    const payment = makeDepositPayment(setup, {
      paymentIdentifier: "pay_7d5d747be160e280504c099d984bcfe0",
    });
    await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload, { requestHash: "aa".repeat(32) }),
      async () => ({
        chargedAmount: "50",
      }),
    );

    const conflict = await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload, { requestHash: "bb".repeat(32) }),
      async () => ({
        body: "wrong",
      }),
    );

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
      setup.server.handlePaidRequest(
        requestWithPayment(first.payload, { requestHash: "aa".repeat(32) }),
        async () => {
          executions += 1;
          return { chargedAmount: "50" };
        },
      ),
      setup.server.handlePaidRequest(
        requestWithPayment(second.payload, { requestHash: "aa".repeat(32) }),
        async () => {
          executions += 1;
          return { chargedAmount: "50" };
        },
      ),
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
    await setup.server.handlePaidRequest(
      requestWithPayment(first.payload, { requestHash: "aa".repeat(32) }),
      async () => ({
        chargedAmount: "50",
      }),
    );

    const conflict = await setup.server.handlePaidRequest(
      requestWithPayment(second.payload, { requestHash: "aa".repeat(32) }),
      async () => ({
        body: "wrong",
      }),
    );

    expect(conflict.status).toBe(409);
  });

  it("offers a fresh rolling channel after the stored refund window expires", async () => {
    const store = new MemoryServerChannelStore();
    const rolling = {
      minimumRefundLeadDaa: "100",
      allowRollingRefundTimeoutDaa: true,
      maximumRefundHorizonDaa: "1000",
    } as const;
    const initial = makeServer({ ...rolling, store, refundTimeoutDaa: "2000" });
    initial.chain.daa = "1000";
    const deposit = makeDepositPayment(initial);
    await initial.server.handlePaidRequest(
      requestWithPayment(deposit.payload),
      async () => ({ chargedAmount: "100" }),
    );
    const channel = await requireChannel(store, deposit.channelId);
    const accepted = initial.server.buildPaymentRequired({
      resource: RESOURCE,
      scheme: "batch-settlement",
      channel,
    }).accepts[0] as BatchPaymentRequirements;

    const refreshed = makeServer({
      ...rolling,
      store,
      refundTimeoutDaa: "2900",
    });
    refreshed.chain.daa = "1900";
    refreshed.chain.setUtxo({
      outpoint: channel.activeOutpoint,
      amount: channel.fundingAmount,
      scriptPublicKey: channel.activeScriptPublicKey,
      finality: "accepted",
    });
    const voucher = makeVoucherPayment(refreshed, channel, {
      accepted,
      voucherAmount: "200",
    });
    let executed = false;

    const response = await refreshed.server.handlePaidRequest(
      requestWithPayment(voucher),
      async () => {
        executed = true;
        return { body: "wrong" };
      },
    );

    expect(response.status).toBe(402);
    expect(executed).toBe(false);
    const corrective = decodePaymentRequiredHeader(
      response.headers[PAYMENT_REQUIRED_HEADER],
    );
    const next = corrective.accepts[0] as BatchPaymentRequirements;
    expect(next.extra.refundTimeoutDaa).toBe("2900");
    expect(next.extra.channelState).toBeUndefined();
    expect(next.extra.voucherState).toBeUndefined();
    await expect(store.loadChannel(channel.channelId)).resolves.toMatchObject({
      status: "active",
    });
  });

  it("accepts a retry that selected a corrective channel-state offer", async () => {
    const setup = makeServer();
    const deposit = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(
      requestWithPayment(deposit.payload),
      async () => ({ chargedAmount: "100" }),
    );
    const channel = await requireChannel(setup.store, deposit.channelId);
    const underpaid = makeVoucherPayment(setup, channel, {
      voucherAmount: "150",
    });

    const corrective = await setup.server.handlePaidRequest(
      requestWithPayment(underpaid),
      async () => ({ body: "wrong" }),
    );
    expect(corrective.status).toBe(402);
    const required = decodePaymentRequiredHeader(
      corrective.headers[PAYMENT_REQUIRED_HEADER],
    );
    const accepted = required.accepts[0] as BatchPaymentRequirements;
    const retry = makeVoucherPayment(setup, channel, {
      accepted,
      voucherAmount: "200",
    });

    const response = await setup.server.handlePaidRequest(
      requestWithPayment(retry),
      async () => ({ chargedAmount: "25" }),
    );

    expect(response.status).toBe(200);
    const updated = await requireChannel(setup.store, deposit.channelId);
    expect(updated.chargedCumulativeAmount).toBe("125");
  });

  it("accepts custom per-request payment amounts emitted by the server", async () => {
    const setup = makeServer({ amount: "100" });
    const required = setup.server.buildPaymentRequired({
      resource: RESOURCE,
      amount: "75",
    });
    const accepted = required.accepts[0] as BatchPaymentRequirements;
    const payment = makeDepositPayment(setup, {
      accepted,
      voucherAmount: "75",
    });

    const response = await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload, { paymentAmount: "75" }),
      async () => ({
        body: "custom",
        chargedAmount: "75",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.body).toBe("custom");
    const stored = await requireChannel(setup.store, payment.channelId);
    expect(stored.chargedCumulativeAmount).toBe("75");
  });

  it("rejects custom amount retries that do not declare the expected payment amount", async () => {
    const setup = makeServer({ amount: "100" });
    const required = setup.server.buildPaymentRequired({
      resource: RESOURCE,
      amount: "75",
    });
    const accepted = required.accepts[0] as BatchPaymentRequirements;
    const payment = makeDepositPayment(setup, {
      accepted,
      voucherAmount: "75",
    });

    const response = await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload),
      async () => ({ body: "wrong" }),
    );

    expect(response.status).toBe(402);
    await expect(
      setup.store.loadChannel(payment.channelId),
    ).resolves.toBeUndefined();
  });

  it("preserves custom per-request amounts in corrective responses", async () => {
    const setup = makeServer({ amount: "100" });
    const required = setup.server.buildPaymentRequired({
      resource: RESOURCE,
      amount: "75",
    });
    const accepted = required.accepts[0] as BatchPaymentRequirements;
    const payment = makeDepositPayment(setup, {
      accepted,
      voucherAmount: "74",
    });

    const response = await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload, { paymentAmount: "75" }),
      async () => ({
        body: "wrong",
      }),
    );

    expect(response.status).toBe(402);
    const corrective = decodePaymentRequiredHeader(
      response.headers[PAYMENT_REQUIRED_HEADER],
    );
    expect(corrective.accepts[0]?.amount).toBe("75");
  });

  it("rejects voucher-only payments when stored channel terms no longer match the server", async () => {
    const store = new MemoryServerChannelStore();
    const firstServer = makeServer({ store });
    const deposit = makeDepositPayment(firstServer);
    await firstServer.server.handlePaidRequest(
      requestWithPayment(deposit.payload),
      async () => ({ chargedAmount: "100" }),
    );
    const channel = await requireChannel(store, deposit.channelId);
    const changedServer = makeServer({
      store,
      payTo: "kaspatest:changed-payout",
    });
    const voucher = makeVoucherPayment(changedServer, channel);
    let executed = false;

    const response = await changedServer.server.handlePaidRequest(
      requestWithPayment(voucher),
      async () => {
        executed = true;
        return { body: "wrong" };
      },
    );

    expect(response.status).toBe(402);
    expect(executed).toBe(false);
  });

  it("rejects deposits below the advertised minimum", async () => {
    const setup = makeServer({ amount: "10", minDepositSompi: "100" });
    const payment = makeDepositPayment(setup, {
      fundingAmount: "50",
      voucherAmount: "10",
    });

    const response = await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload),
      async () => ({ body: "wrong" }),
    );

    expect(response.status).toBe(402);
    await expect(
      setup.store.loadChannel(payment.channelId),
    ).resolves.toBeUndefined();
  });

  it("does not reactivate non-active channels from a deposit payload", async () => {
    const setup = makeServer();
    const deposit = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(
      requestWithPayment(deposit.payload),
      async () => ({ chargedAmount: "70" }),
    );
    const retired = await requireChannel(setup.store, deposit.channelId);
    await setup.store.saveChannel({ ...retired, status: "retired" });
    const retry = makeDepositPayment(setup, { voucherAmount: "170" });

    const response = await setup.server.handlePaidRequest(
      requestWithPayment(retry.payload),
      async () => ({ body: "wrong" }),
    );

    expect(response.status).toBe(402);
    const stored = await requireChannel(setup.store, deposit.channelId);
    expect(stored.status).toBe("retired");
  });

  it("omits corrective channel state for non-active channels", async () => {
    const setup = makeServer();
    const deposit = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(
      requestWithPayment(deposit.payload),
      async () => ({ chargedAmount: "70" }),
    );
    const channel = await requireChannel(setup.store, deposit.channelId);
    await setup.store.saveChannel({ ...channel, status: "retired" });
    const voucher = makeVoucherPayment(setup, channel);

    const response = await setup.server.handlePaidRequest(
      requestWithPayment(voucher),
      async () => ({ body: "wrong" }),
    );

    expect(response.status).toBe(402);
    const required = decodePaymentRequiredHeader(
      response.headers[PAYMENT_REQUIRED_HEADER],
    );
    const accepted = required.accepts[0] as BatchPaymentRequirements;
    expect(accepted.extra.channelState).toBeUndefined();
    expect(accepted.extra.voucherState).toBeUndefined();
  });

  it("preserves accepted deposit state when post-handler settlement validation fails", async () => {
    const setup = makeServer();
    const payment = makeDepositPayment(setup);

    const response = await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload),
      async () => ({ chargedAmount: "101" }),
    );

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: "batch_settlement_recovery_required",
    });
    const stored = await requireChannel(setup.store, payment.channelId);
    expect(stored.chargedCumulativeAmount).toBe("0");
    expect(stored.signedMaxClaimable).toBe("100");
    expect(stored.voucherSignature).toBeTruthy();
  });

  it("returns a controlled 402 for malformed exact payload evidence", async () => {
    const setup = makeServer();
    const payload = {
      x402Version: X402_VERSION,
      accepted: {
        scheme: "exact",
        network: "kaspa:testnet-10",
        amount: "100",
        asset: "KAS",
        payTo: "kaspatest:payout",
        maxTimeoutSeconds: 60,
        extra: {
          binding: "kaspa-exact-v2",
          paymentFlow: "upfront",
          profile: "standard-native",
          finality: "accepted",
          transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
          payToScriptPublicKey:
            new FakeAddressCodec().scriptPublicKeyForAddress(
              "kaspatest:payout",
              "kaspa:testnet-10",
            ),
        },
      },
      payload: {
        type: "exact-transfer",
        profile: "standard-native",
        transactionId: "ab",
        paymentOutputIndex: 0,
      },
    };

    const response = await setup.server.handlePaidRequest(
      requestWithRawPaymentPayload(payload),
      async () => ({ body: "wrong" }),
    );

    expect(response.status).toBe(402);
    expect(response.headers[PAYMENT_REQUIRED_HEADER]).toBeTruthy();
  });

  it("previews claimable channels and rejects uneconomical claims", async () => {
    const setup = makeServer();
    const payment = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload),
      async () => ({ chargedAmount: "100" }),
    );

    await expect(setup.server.listClaimableChannels()).resolves.toHaveLength(1);
    const preview = await setup.server.previewClaim(payment.channelId);
    expect(preview.claimable).toBe(true);
    expect(preview.claimAmount).toBe("100");
    await expect(
      setup.server.previewClaim(payment.channelId, "0"),
    ).resolves.toMatchObject({
      claimable: false,
      reason: "claim amount must be positive",
    });
    await expect(
      setup.server.previewClaim(payment.channelId, "101"),
    ).resolves.toMatchObject({
      claimable: false,
      reason: "claim amount cannot exceed unsettled actual charges",
    });

    setup.chain.claimFee = "100";
    const dust = await setup.server.previewClaim(payment.channelId);
    expect(dust.claimable).toBe(false);
  });

  it("rejects vouchers that consume the required claim reserve", async () => {
    const setup = makeServer({ minDepositSompi: "1000", amount: "995" });
    setup.chain.claimFee = "10";
    const advertised = setup.server.buildPaymentRequired({ resource: RESOURCE })
      .accepts[0] as BatchPaymentRequirements;
    expect(advertised.extra.minDepositSompi).toBe("1005");
    const payment = makeDepositPayment(setup, {
      fundingAmount: "1000",
      voucherAmount: "995",
    });
    let executed = false;

    const response = await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload),
      async () => {
        executed = true;
        return { body: "wrong" };
      },
    );

    expect(response.status).toBe(402);
    expect(executed).toBe(false);
    await expect(
      setup.store.loadChannel(payment.channelId),
    ).resolves.toBeUndefined();
  });

  it("does not treat claim timing policy as active funding reserve", async () => {
    const setup = makeServer({
      minDepositSompi: "1000",
      amount: "990",
      claimPolicy: { claimWhenUnclaimedAmountExceeds: "500" },
    });
    setup.chain.claimFee = "10";
    const payment = makeDepositPayment(setup, { voucherAmount: "990" });

    const response = await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload),
      async () => ({ chargedAmount: "990" }),
    );

    expect(response.status).toBe(200);
    const stored = await requireChannel(setup.store, payment.channelId);
    expect(stored.chargedCumulativeAmount).toBe("990");
  });

  it("uses the advertised reserve rather than a hidden live fee for voucher acceptance", async () => {
    const setup = makeServer({
      minDepositSompi: "1000",
      claimReserveSompi: "10",
      amount: "990",
    });
    setup.chain.claimFee = "500";
    const payment = makeDepositPayment(setup, { voucherAmount: "990" });

    const response = await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload),
      async () => ({ chargedAmount: "990" }),
    );

    expect(response.status).toBe(200);
    await expect(
      setup.server.previewClaim(payment.channelId),
    ).resolves.toMatchObject({ claimable: true, estimatedFee: "500" });
  });

  it("rejects claim previews for non-active channels", async () => {
    const setup = makeServer();
    const payment = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload),
      async () => ({ chargedAmount: "100" }),
    );
    const channel = await requireChannel(setup.store, payment.channelId);
    await setup.store.saveChannel({ ...channel, status: "retired" });

    await expect(setup.server.previewClaim(payment.channelId)).rejects.toThrow(
      "channel is not active",
    );
  });

  it("executes accepted claim hooks and moves to a continuation outpoint", async () => {
    const setup = makeServer({
      claimBuilder: {
        async buildClaimTransaction({ claimAmount }) {
          return {
            transaction: "ab".repeat(32),
            transactionId: CLAIM_TX,
            claimAmount,
            continuationOutpoint: { txid: CLAIM_TX, index: 1 },
            continuationScriptPublicKey: "0000" + "77".repeat(34),
            continuationFundingAmount: "900",
          };
        },
      },
    });
    const payment = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload),
      async () => ({ chargedAmount: "100" }),
    );
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
    expect(claim.channel.signedMaxClaimable).toBe("100");
    expect(claim.channel.voucherSignature).toBeTruthy();
    expect(claim.channel.escrowAddress).toBe(
      deriveEscrow(claim.channel.channelConfig, "100").escrowAddress,
    );
    await expect(
      setup.store.loadOpenClaimAttempt(payment.channelId),
    ).resolves.toBeUndefined();
  });

  it("executes consecutive partial claims without resetting lifetime authorization", async () => {
    const secondClaimTx = "66".repeat(32);
    const claimTransactionIds = [CLAIM_TX, secondClaimTx];
    let claimIndex = 0;
    const setup = makeServer({
      amount: "300",
      claimBuilder: {
        async buildClaimTransaction({ channel, claimAmount }) {
          const transactionId = claimTransactionIds[claimIndex++]!;
          const settledTotal = (
            BigInt(channel.claimedCumulativeAmount) + BigInt(claimAmount)
          ).toString();
          return {
            transaction: transactionId,
            transactionId,
            claimAmount,
            continuationOutpoint: { txid: transactionId, index: 1 },
            continuationScriptPublicKey: deriveEscrow(
              channel.channelConfig,
              settledTotal,
            ).activeScriptPublicKey,
            continuationFundingAmount: (
              BigInt(channel.fundingAmount) - BigInt(claimAmount)
            ).toString(),
          };
        },
      },
    });
    const payment = makeDepositPayment(setup, { voucherAmount: "300" });
    await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload),
      async () => ({ chargedAmount: "300" }),
    );
    const opened = await requireChannel(setup.store, payment.channelId);

    const firstScript = deriveEscrow(
      opened.channelConfig,
      "100",
    ).activeScriptPublicKey;
    setup.chain.sendTransactionId = CLAIM_TX;
    setup.chain.setUtxo({
      outpoint: { txid: CLAIM_TX, index: 1 },
      amount: "900",
      scriptPublicKey: firstScript,
      finality: "accepted",
    });
    const first = await setup.server.executeClaim(payment.channelId, "100");

    const secondScript = deriveEscrow(
      opened.channelConfig,
      "200",
    ).activeScriptPublicKey;
    setup.chain.sendTransactionId = secondClaimTx;
    setup.chain.setUtxo({
      outpoint: { txid: secondClaimTx, index: 1 },
      amount: "800",
      scriptPublicKey: secondScript,
      finality: "accepted",
    });
    const second = await setup.server.executeClaim(payment.channelId, "100");

    expect(first.channel.claimedCumulativeAmount).toBe("100");
    expect(second.channel.claimedCumulativeAmount).toBe("200");
    expect(second.channel.chargedCumulativeAmount).toBe("300");
    expect(second.channel.signedMaxClaimable).toBe(opened.signedMaxClaimable);
    expect(second.channel.voucherSignature).toBe(opened.voucherSignature);
    expect(second.channel.covenantId).toBe(opened.covenantId);
    expect(second.channel.fundingAmount).toBe("800");
    expect(first.channel.escrowAddress).toBe(
      deriveEscrow(opened.channelConfig, "100").escrowAddress,
    );
    expect(second.channel.escrowAddress).toBe(
      deriveEscrow(opened.channelConfig, "200").escrowAddress,
    );
  });

  it("rejects a claim builder that deducts fees from the covenant continuation", async () => {
    const setup = makeServer({
      claimBuilder: {
        async buildClaimTransaction({ claimAmount }) {
          return {
            transaction: "ab".repeat(32),
            transactionId: CLAIM_TX,
            claimAmount,
            continuationOutpoint: { txid: CLAIM_TX, index: 1 },
            continuationScriptPublicKey: "0000" + "77".repeat(34),
            continuationFundingAmount: "899",
          };
        },
      },
    });
    const payment = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload),
      async () => ({
        chargedAmount: "100",
      }),
    );

    await expect(setup.server.executeClaim(payment.channelId)).rejects.toThrow(
      "continuation amount must equal funding minus the authorized claim",
    );
    await expect(
      setup.store.loadOpenClaimAttempt(payment.channelId),
    ).resolves.toBeUndefined();
    expect(setup.chain.sentTransactions).toHaveLength(0);
  });

  it("does not mutate claim state when atomic claim apply fails", async () => {
    const store = new FailingApplyClaimStore();
    const setup = makeServer({
      store,
      claimBuilder: {
        async buildClaimTransaction({ claimAmount }) {
          return {
            transaction: "ab".repeat(32),
            transactionId: CLAIM_TX,
            claimAmount,
            continuationOutpoint: { txid: CLAIM_TX, index: 1 },
            continuationScriptPublicKey: "0000" + "77".repeat(34),
            continuationFundingAmount: "900",
          };
        },
      },
    });
    const payment = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload),
      async () => ({ chargedAmount: "100" }),
    );
    setup.chain.setUtxo({
      outpoint: { txid: CLAIM_TX, index: 1 },
      amount: "900",
      scriptPublicKey: "0000" + "77".repeat(34),
      finality: "accepted",
    });

    await expect(setup.server.executeClaim(payment.channelId)).rejects.toThrow(
      "claim apply unavailable",
    );
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
            transactionId: CLAIM_TX,
            claimAmount,
            continuationOutpoint: { txid: CLAIM_TX, index: 1 },
            continuationScriptPublicKey: "0000" + "77".repeat(34),
            continuationFundingAmount: "900",
          };
        },
      },
    });
    const payment = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload),
      async () => ({ chargedAmount: "100" }),
    );

    await expect(setup.server.executeClaim(payment.channelId)).rejects.toThrow(
      "funding outpoint",
    );
    const stored = await requireChannel(setup.store, payment.channelId);
    expect(stored.claimedCumulativeAmount).toBe("0");
    const attempt = await setup.store.loadOpenClaimAttempt(payment.channelId);
    expect(attempt?.status).toBe("broadcast");
    expect(attempt?.finality).toBe("accepted");
    expect(attempt?.transactionId).toBe(CLAIM_TX);
    expect(attempt?.continuationOutpoint).toEqual({ txid: CLAIM_TX, index: 1 });
    await expect(setup.server.executeClaim(payment.channelId)).rejects.toThrow(
      "claim attempt is already pending",
    );
    setup.chain.setUtxo({
      outpoint: { txid: CLAIM_TX, index: 1 },
      amount: "900",
      scriptPublicKey: "0000" + "77".repeat(34),
      finality: "accepted",
    });

    const recovered = await setup.server.recoverAcceptedClaim(
      payment.channelId,
    );

    expect(recovered.accepted).toBe(true);
    expect(recovered.channel.claimedCumulativeAmount).toBe("100");
    expect(recovered.channel.escrowAddress).toBe(
      deriveEscrow(recovered.channel.channelConfig, "100").escrowAddress,
    );
    await expect(
      setup.store.loadOpenClaimAttempt(payment.channelId),
    ).resolves.toBeUndefined();
  });

  it("blocks new payments while an accepted claim waits for recovery", async () => {
    const setup = makeServer({
      claimBuilder: {
        async buildClaimTransaction({ claimAmount }) {
          return {
            transaction: "ab".repeat(32),
            transactionId: CLAIM_TX,
            claimAmount,
            continuationOutpoint: { txid: CLAIM_TX, index: 1 },
            continuationScriptPublicKey: "0000" + "77".repeat(34),
            continuationFundingAmount: "900",
          };
        },
      },
    });
    const payment = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload),
      async () => ({ chargedAmount: "100" }),
    );
    await expect(setup.server.executeClaim(payment.channelId)).rejects.toThrow(
      "funding outpoint",
    );
    const channel = await requireChannel(setup.store, payment.channelId);
    const voucher = makeVoucherPayment(setup, channel);

    const paid = await setup.server.handlePaidRequest(
      requestWithPayment(voucher),
      async () => ({ body: "wrong" }),
    );

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
            transactionId: CLAIM_TX,
            claimAmount,
            continuationOutpoint: { txid: CLAIM_TX, index: 1 },
            continuationScriptPublicKey: "0000" + "77".repeat(34),
            continuationFundingAmount: "900",
          };
        },
      },
    });
    const payment = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload),
      async () => ({ chargedAmount: "100" }),
    );
    await expect(setup.server.executeClaim(payment.channelId)).rejects.toThrow(
      "funding outpoint",
    );
    const channel = await requireChannel(setup.store, payment.channelId);
    await setup.store.saveChannel({
      ...channel,
      chargedCumulativeAmount: "150",
      signedMaxClaimable: "150",
    });
    setup.chain.setUtxo({
      outpoint: { txid: CLAIM_TX, index: 1 },
      amount: "900",
      scriptPublicKey: "0000" + "77".repeat(34),
      finality: "accepted",
    });

    await expect(
      setup.server.recoverAcceptedClaim(payment.channelId),
    ).rejects.toThrow("channel state changed after claim attempt");
  });

  it("rejects accepted claim recovery when signed channel state changed", async () => {
    const setup = makeServer({
      claimBuilder: {
        async buildClaimTransaction({ claimAmount }) {
          return {
            transaction: "ab".repeat(32),
            transactionId: CLAIM_TX,
            claimAmount,
            continuationOutpoint: { txid: CLAIM_TX, index: 1 },
            continuationScriptPublicKey: "0000" + "77".repeat(34),
            continuationFundingAmount: "900",
          };
        },
      },
    });
    const payment = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload),
      async () => ({ chargedAmount: "100" }),
    );
    await expect(setup.server.executeClaim(payment.channelId)).rejects.toThrow(
      "funding outpoint",
    );
    const channel = await requireChannel(setup.store, payment.channelId);
    await setup.store.saveChannel({ ...channel, signedMaxClaimable: "101" });
    setup.chain.setUtxo({
      outpoint: { txid: CLAIM_TX, index: 1 },
      amount: "900",
      scriptPublicKey: "0000" + "77".repeat(34),
      finality: "accepted",
    });

    await expect(
      setup.server.recoverAcceptedClaim(payment.channelId),
    ).rejects.toThrow("channel state changed after claim attempt");
  });

  it("records a pending claim attempt before broadcast errors", async () => {
    const setup = makeServer({
      claimBuilder: {
        async buildClaimTransaction({ claimAmount }) {
          return {
            transaction: "ab".repeat(32),
            transactionId: CLAIM_TX,
            claimAmount,
            continuationOutpoint: { txid: CLAIM_TX, index: 1 },
            continuationScriptPublicKey: "0000" + "77".repeat(34),
            continuationFundingAmount: "900",
          };
        },
      },
    });
    const payment = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload),
      async () => ({ chargedAmount: "100" }),
    );
    setup.chain.sendFailure = new Error("node unavailable");

    await expect(setup.server.executeClaim(payment.channelId)).rejects.toThrow(
      "node unavailable",
    );
    const attempt = await setup.store.loadOpenClaimAttempt(payment.channelId);
    expect(attempt?.status).toBe("pending");
    expect(attempt?.transactionId).toBe(CLAIM_TX);
    expect(attempt?.continuationOutpoint).toEqual({ txid: CLAIM_TX, index: 1 });
    expect(setup.chain.sendCount).toBe(1);
    const channel = await requireChannel(setup.store, payment.channelId);
    const voucher = makeVoucherPayment(setup, channel);
    const paid = await setup.server.handlePaidRequest(
      requestWithPayment(voucher),
      async () => ({ body: "wrong" }),
    );

    expect(paid.status).toBe(402);
    await expect(setup.server.executeClaim(payment.channelId)).rejects.toThrow(
      "claim attempt is already pending",
    );
    expect(setup.chain.sendCount).toBe(1);
  });

  it("recovers a pending claim after ambiguous broadcast failure with external evidence", async () => {
    const setup = makeServer({
      claimBuilder: {
        async buildClaimTransaction({ claimAmount }) {
          return {
            transaction: "ab".repeat(32),
            transactionId: CLAIM_TX,
            claimAmount,
            continuationOutpoint: { txid: CLAIM_TX, index: 1 },
            continuationScriptPublicKey: "0000" + "77".repeat(34),
            continuationFundingAmount: "900",
          };
        },
      },
    });
    const payment = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload),
      async () => ({ chargedAmount: "100" }),
    );
    setup.chain.sendFailure = new Error("node unavailable");
    await expect(setup.server.executeClaim(payment.channelId)).rejects.toThrow(
      "node unavailable",
    );
    setup.chain.setUtxo({
      outpoint: { txid: CLAIM_TX, index: 1 },
      amount: "900",
      scriptPublicKey: "0000" + "77".repeat(34),
      finality: "accepted",
    });

    const recovered = await setup.server.recoverAcceptedClaim(
      payment.channelId,
      {
        transactionId: CLAIM_TX,
        finality: "accepted",
      },
    );

    expect(recovered.accepted).toBe(true);
    expect(recovered.channel.claimedCumulativeAmount).toBe("100");
    await expect(
      setup.store.loadOpenClaimAttempt(payment.channelId),
    ).resolves.toBeUndefined();
  });

  it("reports verified continuation finality during claim recovery", async () => {
    const setup = makeServer({
      acceptedFinality: "confirmed",
      claimBuilder: {
        async buildClaimTransaction({ claimAmount }) {
          return {
            transaction: "ab".repeat(32),
            transactionId: CLAIM_TX,
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
    if (deposit.type !== "deposit-voucher")
      throw new Error("expected deposit payload");
    setup.chain.setUtxo({
      outpoint: deposit.fundingOutpoint,
      amount: deposit.fundingAmountSompi,
      scriptPublicKey: deposit.activeScriptPublicKey,
      finality: "confirmed",
    });
    await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload),
      async () => ({ chargedAmount: "100" }),
    );
    const broadcast = await setup.server.executeClaim(payment.channelId);
    expect(broadcast.accepted).toBe(false);
    setup.chain.setUtxo({
      outpoint: { txid: CLAIM_TX, index: 1 },
      amount: "900",
      scriptPublicKey: "0000" + "77".repeat(34),
      finality: "confirmed",
    });

    const recovered = await setup.server.recoverAcceptedClaim(
      payment.channelId,
      {
        transactionId: CLAIM_TX,
        finality: "accepted",
      },
    );

    expect(recovered.accepted).toBe(true);
    expect(recovered.finality).toBe("confirmed");
    expect(recovered.channel.claimedCumulativeAmount).toBe("100");
  });

  it("keeps a persisted confirmed claim threshold after restart under accepted policy", async () => {
    const store = new MemoryServerChannelStore();
    const initial = makeServer({
      store,
      acceptedFinality: "confirmed",
      claimBuilder: {
        async buildClaimTransaction({ claimAmount }) {
          return {
            transaction: "ab".repeat(32),
            transactionId: CLAIM_TX,
            claimAmount,
            continuationOutpoint: { txid: CLAIM_TX, index: 1 },
            continuationScriptPublicKey: "0000" + "77".repeat(34),
            continuationFundingAmount: "900",
          };
        },
      },
    });
    const payment = makeDepositPayment(initial);
    const deposit = payment.payload.payload;
    if (deposit.type !== "deposit-voucher")
      throw new Error("expected deposit payload");
    initial.chain.setUtxo({
      outpoint: deposit.fundingOutpoint,
      amount: deposit.fundingAmountSompi,
      scriptPublicKey: deposit.activeScriptPublicKey,
      finality: "confirmed",
    });
    await initial.server.handlePaidRequest(
      requestWithPayment(payment.payload),
      async () => ({ chargedAmount: "100" }),
    );

    const broadcast = await initial.server.executeClaim(payment.channelId);
    expect(broadcast.accepted).toBe(false);
    await expect(
      store.loadOpenClaimAttempt(payment.channelId),
    ).resolves.toMatchObject({
      requiredFinality: "confirmed",
      status: "broadcast",
      finality: "accepted",
    });

    const restarted = makeServer({ store, acceptedFinality: "accepted" });
    restarted.chain.setUtxo({
      outpoint: { txid: CLAIM_TX, index: 1 },
      amount: "900",
      scriptPublicKey: "0000" + "77".repeat(34),
      finality: "accepted",
    });
    await expect(
      restarted.server.recoverAcceptedClaim(payment.channelId),
    ).rejects.toThrow("has not reached required finality");
    await expect(
      store.loadOpenClaimAttempt(payment.channelId),
    ).resolves.toMatchObject({ status: "broadcast" });

    restarted.chain.setUtxo({
      outpoint: { txid: CLAIM_TX, index: 1 },
      amount: "900",
      scriptPublicKey: "0000" + "77".repeat(34),
      finality: "confirmed",
    });
    const recovered = await restarted.server.recoverAcceptedClaim(
      payment.channelId,
    );
    expect(recovered.finality).toBe("confirmed");
    expect(recovered.channel.claimedCumulativeAmount).toBe("100");
  });

  it("tightens a persisted accepted claim threshold after restart under confirmed policy", async () => {
    const store = new MemoryServerChannelStore();
    const initial = makeServer({
      store,
      acceptedFinality: "accepted",
      claimBuilder: {
        async buildClaimTransaction({ claimAmount }) {
          return {
            transaction: "ab".repeat(32),
            transactionId: CLAIM_TX,
            claimAmount,
            continuationOutpoint: { txid: CLAIM_TX, index: 1 },
            continuationScriptPublicKey: "0000" + "77".repeat(34),
            continuationFundingAmount: "900",
          };
        },
      },
    });
    const payment = makeDepositPayment(initial);
    await initial.server.handlePaidRequest(
      requestWithPayment(payment.payload),
      async () => ({ chargedAmount: "100" }),
    );
    await expect(
      initial.server.executeClaim(payment.channelId),
    ).rejects.toThrow("funding outpoint");
    await expect(
      store.loadOpenClaimAttempt(payment.channelId),
    ).resolves.toMatchObject({
      requiredFinality: "accepted",
      status: "broadcast",
      finality: "accepted",
    });

    const restarted = makeServer({ store, acceptedFinality: "confirmed" });
    restarted.chain.setUtxo({
      outpoint: { txid: CLAIM_TX, index: 1 },
      amount: "900",
      scriptPublicKey: "0000" + "77".repeat(34),
      finality: "accepted",
    });
    await expect(
      restarted.server.recoverAcceptedClaim(payment.channelId),
    ).rejects.toThrow("has not reached required finality");
    await expect(
      store.loadOpenClaimAttempt(payment.channelId),
    ).resolves.toMatchObject({ status: "broadcast" });

    restarted.chain.setUtxo({
      outpoint: { txid: CLAIM_TX, index: 1 },
      amount: "900",
      scriptPublicKey: "0000" + "77".repeat(34),
      finality: "confirmed",
    });
    const recovered = await restarted.server.recoverAcceptedClaim(
      payment.channelId,
    );
    expect(recovered.finality).toBe("confirmed");
    expect(recovered.channel.claimedCumulativeAmount).toBe("100");
  });

  it("requires trusted exact-txid rejection before abandoning an open claim", async () => {
    let reconciliation: ClaimReconciliation = {
      status: "unknown",
      transactionId: CLAIM_TX,
      reason: "indexing lag",
    };
    const setup = makeServer({
      claimReconciler: {
        async reconcileClaim() {
          return reconciliation;
        },
      },
      claimBuilder: {
        async buildClaimTransaction({ claimAmount }) {
          return {
            transaction: "ab".repeat(32),
            transactionId: CLAIM_TX,
            claimAmount,
            continuationOutpoint: { txid: CLAIM_TX, index: 1 },
            continuationScriptPublicKey: "0000" + "77".repeat(34),
            continuationFundingAmount: "900",
          };
        },
      },
    });
    const payment = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload),
      async () => ({ chargedAmount: "100" }),
    );
    setup.chain.sendFailure = new Error("node unavailable");

    await expect(setup.server.executeClaim(payment.channelId)).rejects.toThrow(
      "node unavailable",
    );
    await expect(
      setup.server.abandonClaimAttempt(payment.channelId),
    ).rejects.toThrow("remains unknown");
    reconciliation = {
      status: "rejected",
      transactionId: "66".repeat(32),
      reason: "not accepted",
    };
    await expect(
      setup.server.abandonClaimAttempt(payment.channelId),
    ).rejects.toThrow("does not match the persisted signed transaction");
    reconciliation = {
      status: "accepted",
      transactionId: CLAIM_TX,
      finality: "accepted",
    };
    await expect(
      setup.server.abandonClaimAttempt(payment.channelId),
    ).rejects.toThrow("must be recovered");
    reconciliation = {
      status: "rejected",
      transactionId: CLAIM_TX,
      reason: "authoritative node rejection",
    };
    await setup.server.abandonClaimAttempt(payment.channelId);
    await expect(
      setup.store.loadOpenClaimAttempt(payment.channelId),
    ).resolves.toBeUndefined();
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

  it("forbids blind claim abandonment without a trusted reconciler", async () => {
    const setup = makeServer({
      claimBuilder: {
        async buildClaimTransaction({ claimAmount }) {
          return {
            transaction: "ab".repeat(32),
            transactionId: CLAIM_TX,
            claimAmount,
            continuationOutpoint: { txid: CLAIM_TX, index: 1 },
            continuationScriptPublicKey: "0000" + "77".repeat(34),
            continuationFundingAmount: "900",
          };
        },
      },
    });
    const payment = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload),
      async () => ({ chargedAmount: "100" }),
    );
    setup.chain.sendFailure = new Error("node unavailable");
    await expect(setup.server.executeClaim(payment.channelId)).rejects.toThrow(
      "node unavailable",
    );

    await expect(
      setup.server.abandonClaimAttempt(payment.channelId),
    ).rejects.toThrow("trusted claim reconciler is required");
    await expect(
      setup.store.loadOpenClaimAttempt(payment.channelId),
    ).resolves.toMatchObject({ transactionId: CLAIM_TX, status: "pending" });
  });

  it("keeps the persisted deterministic claim when the broadcaster returns another id", async () => {
    const setup = makeServer({
      claimBuilder: {
        async buildClaimTransaction({ claimAmount }) {
          return {
            transaction: "ab".repeat(32),
            transactionId: CLAIM_TX,
            claimAmount,
            continuationOutpoint: { txid: CLAIM_TX, index: 1 },
            continuationScriptPublicKey: "0000" + "77".repeat(34),
            continuationFundingAmount: "900",
          };
        },
      },
    });
    const payment = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload),
      async () => ({ chargedAmount: "100" }),
    );
    setup.chain.sendTransactionId = "66".repeat(32);

    await expect(setup.server.executeClaim(payment.channelId)).rejects.toThrow(
      "does not match the persisted signed transaction",
    );
    await expect(
      setup.store.loadOpenClaimAttempt(payment.channelId),
    ).resolves.toMatchObject({ transactionId: CLAIM_TX, status: "pending" });
  });

  it("recovers a broadcast claim after external acceptance evidence", async () => {
    const setup = makeServer({
      claimBuilder: {
        async buildClaimTransaction({ claimAmount }) {
          return {
            transaction: "ab".repeat(32),
            transactionId: CLAIM_TX,
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
    await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload),
      async () => ({ chargedAmount: "100" }),
    );
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
    ).rejects.toThrow(
      "accepted claim recovery needs accepted transaction evidence",
    );

    const recovered = await setup.server.recoverAcceptedClaim(
      payment.channelId,
      {
        transactionId: CLAIM_TX,
        finality: "accepted",
      },
    );

    expect(recovered.accepted).toBe(true);
    expect(recovered.channel.claimedCumulativeAmount).toBe("100");
    await expect(
      setup.store.loadOpenClaimAttempt(payment.channelId),
    ).resolves.toBeUndefined();
  });

  it("rejects recovery transaction ids that conflict with a stored broadcast id", async () => {
    const otherTx = "66".repeat(32);
    const setup = makeServer({
      claimBuilder: {
        async buildClaimTransaction({ claimAmount }) {
          return {
            transaction: "ab".repeat(32),
            transactionId: CLAIM_TX,
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
    await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload),
      async () => ({ chargedAmount: "100" }),
    );
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

  it("requires continuation outpoint txid to match the prepared claim transaction", async () => {
    const otherTx = "66".repeat(32);
    const setup = makeServer({
      claimBuilder: {
        async buildClaimTransaction({ claimAmount }) {
          return {
            transaction: "ab".repeat(32),
            transactionId: CLAIM_TX,
            claimAmount,
            continuationOutpoint: { txid: otherTx, index: 1 },
            continuationScriptPublicKey: "0000" + "77".repeat(34),
            continuationFundingAmount: "900",
          };
        },
      },
    });
    const payment = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload),
      async () => ({ chargedAmount: "100" }),
    );
    setup.chain.setUtxo({
      outpoint: { txid: otherTx, index: 1 },
      amount: "900",
      scriptPublicKey: "0000" + "77".repeat(34),
      finality: "accepted",
    });

    await expect(setup.server.executeClaim(payment.channelId)).rejects.toThrow(
      "prepared claim transaction",
    );
    const stored = await requireChannel(setup.store, payment.channelId);
    expect(stored.claimedCumulativeAmount).toBe("0");
    await expect(
      setup.store.loadOpenClaimAttempt(payment.channelId),
    ).resolves.toBeUndefined();
    expect(setup.chain.sendCount).toBe(0);
  });
});

function makeServer(overrides: Partial<DirectModeServerConfig> = {}) {
  const {
    exactTransactionVerifier: suppliedExactVerifier,
    ...serverOverrides
  } = overrides;
  const store = overrides.store ?? new MemoryServerChannelStore();
  const chain = new FakeChainProvider();
  const rawExactVerifier = suppliedExactVerifier ?? {
    verifyExactPayment(
      request: Parameters<
        NonNullable<
          DirectModeServerConfig["exactTransactionVerifier"]
        >["verifyExactPayment"]
      >[0],
    ) {
      return {
        transactionId: /^[0-9a-fA-F]{64}$/.test(request.transaction)
          ? request.transaction
          : EXACT_TX_ID,
        paymentOutput: {
          amount: request.amount,
          scriptPublicKey: request.payToScriptPublicKey,
        },
        finality: "accepted" as const,
        payerAddress: "kaspatest:refund",
        requestAuthorization: fakeAuthorizationEvidence(request.authorization),
      };
    },
  };
  const server = new DirectModeServer({
    network: "kaspa:testnet-10",
    payTo: "kaspatest:payout",
    serverPublicKey: SERVER_KEY,
    minDepositSompi: "1000",
    claimReserveSompi: "10",
    amount: "100",
    refundTimeoutDaa: "1000",
    minimumRefundLeadDaa: "0",
    store,
    chainProvider: chain,
    addressCodec: new FakeAddressCodec(),
    channelSignatureVerifier: {
      verifySignature({ digest, signature }) {
        return signature === `${digest}${digest}`;
      },
    },
    exactProfile: "standard-native",
    ...serverOverrides,
    exactTransactionVerifier: {
      async verifyExactPayment(request) {
        const result = await rawExactVerifier.verifyExactPayment(request);
        return {
          ...result,
          requestAuthorization:
            result.requestAuthorization ??
            fakeAuthorizationEvidence(request.authorization),
        };
      },
    },
  });
  return {
    server,
    store,
    chain,
    voucherVerifier: {
      verifyVoucher({
        digest,
        voucher,
      }: {
        digest: string;
        voucher: { signature: string };
      }) {
        return voucher.signature === `${digest}${digest}`;
      },
    },
  };
}

async function makeAdditiveServer(
  overrides: Partial<DirectModeServerConfig> = {},
  headOverrides: Partial<ExactHeadRecord> = {},
) {
  const threshold = headOverrides.additiveThresholdSompi ?? "10000000";
  const redeemScript =
    headOverrides.redeemScript ??
    buildKip10AdditiveRedeemScript({
      ownerPublicKey: "aa".repeat(32),
      amount: threshold,
    });
  const scriptPublicKey =
    headOverrides.scriptPublicKey ??
    serializedScriptPublicKey(payToScriptHashScript(redeemScript));
  const fallbackCodec = new FakeAddressCodec();
  const addressCodec: AddressCodec = {
    scriptPublicKeyForAddress(address, network) {
      return address === "kaspatest:payout"
        ? scriptPublicKey
        : fallbackCodec.scriptPublicKeyForAddress(address, network);
    },
    encodeScriptAddress(input) {
      return fallbackCodec.encodeScriptAddress(input);
    },
  };
  const defaultVerifier = {
    verifyExactPayment(
      request: Parameters<
        NonNullable<
          DirectModeServerConfig["exactTransactionVerifier"]
        >["verifyExactPayment"]
      >[0],
    ) {
      const head = request.head!;
      return {
        transactionId: EXACT_TX_ID,
        paymentOutput: {
          amount: request.amount,
          scriptPublicKey: request.payToScriptPublicKey,
        },
        continuation: {
          outpoint: { txid: EXACT_TX_ID, index: 0 },
          amount: (BigInt(head.headAmount) + BigInt(request.amount)).toString(),
          scriptPublicKey: head.headScriptPublicKey,
        },
        finality: "accepted" as const,
        payerAddress: "kaspatest:refund",
        requestAuthorization: fakeAuthorizationEvidence(request.authorization),
      };
    },
  };
  const setup = makeServer({
    ...overrides,
    amount: overrides.amount ?? "20000000",
    exactProfile: "additive",
    addressCodec,
    exactTransactionVerifier:
      overrides.exactTransactionVerifier ?? defaultVerifier,
  });
  const head = exactHead({
    scriptPublicKey,
    redeemScript,
    additiveThresholdSompi: threshold,
    ...headOverrides,
  });
  await setup.store.registerExactHead(head);
  return { ...setup, head };
}

function exactHead(overrides: Partial<ExactHeadRecord> = {}): ExactHeadRecord {
  const redeemScript = buildKip10AdditiveRedeemScript({
    ownerPublicKey: "aa".repeat(32),
    amount: "10000000",
  });
  return {
    headId: EXACT_HEAD_ID,
    network: "kaspa:testnet-10",
    payTo: "kaspatest:payout",
    templateId: "kaspa-x402-kip10-additive-v1",
    transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
    currentOutpoint: { txid: FUNDING_TX, index: 0 },
    currentAmount: "100000000",
    scriptPublicKey: serializedScriptPublicKey(
      payToScriptHashScript(redeemScript),
    ),
    redeemScript,
    additiveThresholdSompi: "10000000",
    version: "0",
    status: "available",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function exactHeadChallenge(
  record: ExactHeadRecord,
  amount = "20000000",
): ExactHeadChallenge {
  const expiresAt = "2099-01-01T00:00:00.000Z";
  const unsigned: Omit<ExactHeadChallenge, "challengeId"> = {
    headId: record.headId,
    headVersion: record.version,
    templateId: record.templateId,
    transactionEncoding: record.transactionEncoding,
    expectedHeadOutpoint: record.currentOutpoint,
    headAmount: record.currentAmount,
    headScriptPublicKey: record.scriptPublicKey,
    headRedeemScript: record.redeemScript,
    additiveThresholdSompi: record.additiveThresholdSompi,
    paymentOutputIndex: 0,
    expiresAt,
  };
  return {
    ...unsigned,
    challengeId: sha256Hex(
      stableStringify({
        scope: "kaspa:x402:additive-head-challenge:v1",
        network: record.network,
        payTo: record.payTo,
        amount,
        ...unsigned,
      }),
    ),
  };
}

function makeAdditivePayment(
  accepted: ExactPaymentRequirements,
  options: { requestHash?: Hash32Hex; transactionId?: Hash32Hex } = {},
): PaymentPayload {
  const requestHash = options.requestHash ?? testRequestFingerprint(accepted);
  const transactionId = options.transactionId ?? EXACT_TX_ID;
  return {
    x402Version: X402_VERSION,
    accepted,
    payload: {
      type: "exact-transaction",
      profile: "additive",
      challengeId: accepted.extra.challengeId,
      transaction: options.transactionId ?? EXACT_TRANSACTION_ARTIFACT,
      transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
      paymentOutputIndex: 0,
      requestHash,
      authorization: fakeExactAuthorization({
        accepted,
        profile: "additive",
        transactionId,
        requestHash,
        inputIndex: 1,
      }),
    },
  };
}

function makeExactPayment(
  setup: ReturnType<typeof makeServer>,
  options: {
    paymentIdentifier?: string;
    transactionId?: Hash32Hex;
    paymentOutputIndex?: number;
    requestHash?: Hash32Hex;
  } = {},
): PaymentPayload {
  const paymentOutputIndex = options.paymentOutputIndex ?? 0;
  const required = setup.server.buildPaymentRequired({
    resource: RESOURCE,
    scheme: "exact",
  });
  const accepted = required.accepts[0] as ExactPaymentRequirements;
  const requestHash = options.requestHash ?? testRequestFingerprint(accepted);
  const transaction = options.transactionId ?? EXACT_TRANSACTION_ARTIFACT;
  const transactionId = /^[0-9a-fA-F]{64}$/.test(transaction)
    ? transaction
    : EXACT_TX_ID;
  return {
    x402Version: X402_VERSION,
    accepted,
    payload: {
      type: "exact-transaction",
      profile: "standard-native",
      payerAddress: "kaspatest:refund",
      transaction,
      transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
      paymentOutputIndex,
      requestHash,
      authorization: fakeExactAuthorization({
        accepted,
        profile: "standard-native",
        transactionId,
        requestHash,
        inputIndex: 0,
        paymentOutputIndex,
      }),
    },
    ...(options.paymentIdentifier
      ? paymentIdentifierExtension(options.paymentIdentifier)
      : {}),
  };
}

function makeStandardExactPayment(
  setup: ReturnType<typeof makeServer>,
): PaymentPayload {
  const required = setup.server.buildPaymentRequired({
    resource: RESOURCE,
    scheme: "exact",
  });
  const accepted = required.accepts[0] as ExactPaymentRequirements;
  const requestHash = testRequestFingerprint(accepted);
  return {
    x402Version: X402_VERSION,
    accepted,
    payload: {
      type: "exact-transaction",
      profile: "standard-native",
      payerAddress: "kaspatest:refund",
      transaction: EXACT_TX_ID,
      transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
      paymentOutputIndex: 0,
      requestHash,
      authorization: fakeExactAuthorization({
        accepted,
        profile: "standard-native",
        transactionId: EXACT_TX_ID,
        requestHash,
        inputIndex: 0,
      }),
    },
  };
}

function testRequestFingerprint(accepted: ExactPaymentRequirements): Hash32Hex {
  return sha256Hex(
    stableStringify({
      method: "GET",
      url: RESOURCE.url,
      body: null,
      paymentRequirementsHash: sha256Hex(stableStringify(accepted)),
    }),
  );
}

function fakeExactAuthorization(input: {
  accepted: ExactPaymentRequirements;
  profile: "standard-native" | "additive";
  transactionId: Hash32Hex;
  requestHash: Hash32Hex;
  inputIndex: number;
  paymentOutputIndex?: number;
}) {
  const expiresAt = exactAuthorizationExpiresAt(
    input.accepted.maxTimeoutSeconds,
    input.profile === "additive"
      ? input.accepted.extra.challengeExpiresAt
      : undefined,
  );
  const paymentOutputIndex = input.paymentOutputIndex ?? 0;
  const digest = exactRequestAuthorizationDigest({
    network: input.accepted.network,
    profile: input.profile,
    transactionId: input.transactionId,
    paymentOutputIndex,
    amount: input.accepted.amount,
    payTo: input.accepted.payTo,
    payToScriptPublicKey: input.accepted.extra.payToScriptPublicKey!,
    paymentRequirementsHash: sha256Hex(stableStringify(input.accepted)),
    requestHash: input.requestHash,
    challengeId: input.accepted.extra.challengeId,
    inputIndex: input.inputIndex,
    expiresAt,
  });
  return {
    version: "kaspa-x402-exact-request-authorization-v1" as const,
    inputIndex: input.inputIndex,
    expiresAt,
    digest,
    signature: "ab".repeat(64),
  };
}

function fakeAuthorizationEvidence(authorization: ExactRequestAuthorization) {
  return {
    authorizationId: exactRequestAuthorizationId(authorization),
    digest: authorization.digest,
    inputIndex: authorization.inputIndex,
    publicKey: CLIENT_KEY,
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
  const accepted =
    options.accepted ?? (required.accepts[0] as BatchPaymentRequirements);
  const channelConfig: ChannelConfig = {
    network: accepted.network,
    asset: "KAS",
    templateId: "kaspa-x402-escrow-v3",
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
    covenantId: COVENANT_ID,
    amount: fundingAmount,
    scriptPublicKey: derived.activeScriptPublicKey,
    finality: "accepted",
  });
  const voucher = signVoucher({
    network: accepted.network,
    covenantId: COVENANT_ID,
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
        authorization: fakeBatchRequestAuthorization(
          accepted,
          id,
          voucher.covenantId,
          voucher.amount,
        ),
      },
      ...(options.paymentIdentifier
        ? paymentIdentifierExtension(options.paymentIdentifier)
        : {}),
    },
  };
}

function makeVoucherPayment(
  setup: ReturnType<typeof makeServer>,
  channel: ServerChannelRecord,
  options: {
    voucherAmount?: string;
    accepted?: BatchPaymentRequirements;
    paymentIdentifier?: string;
  } = {},
): PaymentPayload {
  const required = setup.server.buildPaymentRequired({ resource: RESOURCE });
  const accepted =
    options.accepted ?? (required.accepts[0] as BatchPaymentRequirements);
  const requiredAmount = (
    BigInt(channel.chargedCumulativeAmount) + BigInt(accepted.amount)
  ).toString();
  const amount =
    options.voucherAmount ??
    (BigInt(channel.signedMaxClaimable) > BigInt(requiredAmount)
      ? channel.signedMaxClaimable
      : requiredAmount);
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
        covenantId: channel.covenantId,
        amount,
      }),
      authorization: fakeBatchRequestAuthorization(
        accepted,
        channel.channelId,
        channel.covenantId,
        amount,
      ),
    },
    ...(options.paymentIdentifier
      ? paymentIdentifierExtension(options.paymentIdentifier)
      : {}),
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
  let payloadWithAuthorization = paymentPayload;
  try {
    const requestHash =
      options.requestHash ??
      sha256Hex(
        stableStringify({
          method: "GET",
          url: RESOURCE.url,
          body: options.body ?? null,
          paymentRequirementsHash: sha256Hex(
            stableStringify(paymentPayload.accepted),
          ),
        }),
      );
    payloadWithAuthorization = addBatchRequestAuthorization(
      paymentPayload,
      requestHash,
    );
  } catch {
    // Preserve the payload so the server owns malformed-body rejection.
  }
  return {
    url: RESOURCE.url,
    resource: RESOURCE,
    body: options.body,
    paymentAmount: options.paymentAmount,
    paymentScheme: options.paymentScheme,
    paymentSchemes: options.paymentSchemes,
    requestHash: options.requestHash,
    headers: {
      [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader(
        payloadWithAuthorization,
      ),
    },
  };
}

function fakeBatchRequestAuthorization(
  accepted: BatchPaymentRequirements,
  channelId: Hash32Hex,
  covenantId: Hash32Hex,
  amount: string,
  requestHash = sha256Hex(
    stableStringify({
      method: "GET",
      url: RESOURCE.url,
      body: null,
      paymentRequirementsHash: sha256Hex(stableStringify(accepted)),
    }),
  ),
) {
  const expiresAt = new Date(
    Math.floor(Date.now() / 10_000) * 10_000 +
      Math.min(accepted.maxTimeoutSeconds, 30) * 1000,
  ).toISOString();
  const nonce = "97".repeat(32);
  const digest = batchRequestAuthorizationDigest({
    network: accepted.network,
    channelId,
    covenantId,
    amount,
    paymentRequirementsHash: batchPaymentRequirementsHash(accepted),
    requestHash,
    audience: RESOURCE.url,
    expiresAt,
    nonce,
  });
  return {
    version: "kaspa-x402-batch-request-authorization-v1" as const,
    expiresAt,
    nonce,
    digest,
    signature: `${digest}${digest}`,
  };
}

function addBatchRequestAuthorization(
  paymentPayload: PaymentPayload,
  requestHash: Hash32Hex,
): PaymentPayload {
  if (
    paymentPayload.payload.type !== "deposit-voucher" &&
    paymentPayload.payload.type !== "voucher"
  ) {
    return paymentPayload;
  }
  const authorization = fakeBatchRequestAuthorization(
    paymentPayload.accepted as BatchPaymentRequirements,
    paymentPayload.payload.channelId,
    paymentPayload.payload.voucher.covenantId,
    paymentPayload.payload.voucher.amount,
    requestHash,
  );
  return {
    ...paymentPayload,
    payload: {
      ...paymentPayload.payload,
      authorization,
    },
  };
}

function requestWithRawPaymentPayload(
  paymentPayload: unknown,
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
      [PAYMENT_SIGNATURE_HEADER]: Buffer.from(
        JSON.stringify(paymentPayload),
        "utf8",
      ).toString("base64"),
    },
  };
}

async function requireChannel(
  store: ServerChannelStore,
  channelId: Hash32Hex,
): Promise<ServerChannelRecord> {
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

function deriveEscrow(
  channelConfig: ChannelConfig,
  settledTotal = "0",
): {
  escrowAddress: string;
  activeScriptPublicKey: string;
} {
  const addressCodec = new FakeAddressCodec();
  const payoutScriptPublicKeyHash = sha256Hex(
    hexBytes(
      addressCodec.scriptPublicKeyForAddress(
        channelConfig.payTo,
        channelConfig.network,
      ),
    ),
  );
  const refundScriptPublicKeyHash = sha256Hex(
    hexBytes(
      addressCodec.scriptPublicKeyForAddress(
        channelConfig.refundAddress,
        channelConfig.network,
      ),
    ),
  );
  const params = {
    clientPublicKey: channelConfig.clientPublicKey,
    serverPublicKey: channelConfig.serverPublicKey,
    network: channelConfig.network,
    payoutScriptPublicKeyHash,
    refundScriptPublicKeyHash,
    timeoutDaa: channelConfig.refundTimeoutDaa,
    settledTotal,
  };
  const script = escrowScriptPublicKey(params);
  return {
    escrowAddress: deriveEscrowAddress(params, (input) =>
      addressCodec.encodeScriptAddress(input),
    ),
    activeScriptPublicKey: serializedScriptPublicKey(script),
  };
}

function signVoucher(input: {
  network: NetworkId;
  covenantId: Hash32Hex;
  amount: string;
  badSignature?: boolean;
}) {
  const digest = voucherDigest(input);
  return {
    covenantId: input.covenantId,
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
  daa = "0";
  finality: SettlementFinality = "accepted";
  sendCount = 0;
  sendTransactionId = CLAIM_TX;
  readonly sentTransactions: string[] = [];
  sendFailure?: Error;
  genesisAvailable = true;
  genesisVerificationCount = 0;
  genesisTotalOutputCount = 1;

  setUtxo(utxo: ChainUtxo): void {
    this.utxos.set(
      outpointKey(utxo.outpoint),
      structuredClone({ covenantId: COVENANT_ID, ...utxo }),
    );
  }

  async getUtxo(outpoint: FundingOutpoint): Promise<ChainUtxo | null> {
    return this.utxos.get(outpointKey(outpoint)) ?? null;
  }

  async getVirtualDaaScore(): Promise<string> {
    return this.daa;
  }

  async verifyCovenantGenesis(request: {
    utxo: ChainUtxo;
    payment: PaymentPayload;
  }) {
    this.genesisVerificationCount += 1;
    if (!this.genesisAvailable) return null;
    return {
      covenantId: request.utxo.covenantId!,
      authorizingInput: { txid: "4b".repeat(32), index: 0 },
      genesisOutpoint: request.utxo.outpoint,
      genesisScriptPublicKey: request.utxo.scriptPublicKey,
      genesisAmount: request.utxo.amount,
      totalOutputCount: this.genesisTotalOutputCount,
      authorizedOutputCount: 1,
    };
  }

  async estimateClaimFee(): Promise<string> {
    return this.claimFee;
  }

  async sendTransaction(
    transaction: string,
  ): Promise<{ transactionId: string; finality: SettlementFinality }> {
    this.sendCount += 1;
    this.sentTransactions.push(transaction);
    if (this.sendFailure) throw this.sendFailure;
    return { transactionId: this.sendTransactionId, finality: this.finality };
  }
}

class FailingCommitStore extends MemoryServerChannelStore {
  async commitSettlement(_record: SettlementCommit): Promise<void> {
    throw new Error("settlement store unavailable");
  }
}

class FailingBatchCommitStore extends MemoryServerChannelStore {
  #remainingFailures: number;

  constructor(remainingFailures: number) {
    super();
    this.#remainingFailures = remainingFailures;
  }

  async commitSettlement(record: SettlementCommit): Promise<void> {
    if (this.#remainingFailures > 0) {
      this.#remainingFailures -= 1;
      throw new Error("batch store unavailable");
    }
    await super.commitSettlement(record);
  }
}

class FailingBatchClaimStore extends MemoryServerChannelStore {
  #fail = true;

  async claimBatchSettlement(record: BatchSettlementAttemptRecord) {
    if (this.#fail) {
      this.#fail = false;
      throw new Error("batch claim store unavailable");
    }
    return super.claimBatchSettlement(record);
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
  async applyClaimAttempt(
    _channel: ServerChannelRecord,
    _attempt: ClaimAttemptRecord,
  ): Promise<void> {
    throw new Error("claim apply unavailable");
  }
}

function outpointKey(outpoint: FundingOutpoint): string {
  return `${outpoint.txid}:${outpoint.index}`;
}
