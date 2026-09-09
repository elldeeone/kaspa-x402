import { describe, expect, it, vi } from "vitest";

import {
  MCP_PAYMENT_META_KEY,
  MCP_PAYMENT_RESPONSE_META_KEY,
  X402_VERSION,
  batchPaymentRequirementsHash,
  batchPresentationDigest,
  bindRequestHashToTrustedContext,
  channelId,
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
  trustedSecurityContextHash,
  voucherDigest,
  type AcceptedTransactionEvidence,
  type BatchPaymentRequirements,
  type ChannelConfig,
  type ExactPaymentRequirements,
  type ExactRequestAuthorization,
  type FundingOutpoint,
  type Hash32Hex,
  type NetworkId,
  type PaymentPayload,
  type SettlementResponse,
  type TrustedSecurityContext,
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
  type ClaimRecoveryInput,
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
const CONFIRMATION_THRESHOLD = 30;

function acceptedChainEvidence(
  transactionId: string,
  confirmationCount = CONFIRMATION_THRESHOLD,
): AcceptedTransactionEvidence {
  const checkpointBlueScore = 1_000n;
  return {
    status: "accepted",
    transactionId: transactionId.toLowerCase(),
    acceptingBlockHash: sha256Hex(
      `accepting-block:${transactionId.toLowerCase()}`,
    ),
    acceptingBlockBlueScore: (
      checkpointBlueScore - BigInt(confirmationCount) + 1n
    ).toString(),
    confirmationCount,
    checkpoint: {
      blockHash: "ee".repeat(32),
      blueScore: checkpointBlueScore.toString(),
      daaScore: "1000",
    },
  };
}

function unknownChainEvidence(
  transactionId: string,
  reason: string,
): ClaimReconciliation["evidence"] {
  return {
    status: "unknown",
    transactionId: transactionId.toLowerCase(),
    reason,
  };
}

function absentChainEvidence(
  transactionId: string,
  reason: string,
): ClaimReconciliation["evidence"] {
  return {
    status: "absent",
    transactionId: transactionId.toLowerCase(),
    reason,
    proof: {
      kind: "consensus-rejection",
      rejectedTransactionId: transactionId.toLowerCase(),
      rejectionCode: "TX_REJECTED",
      checkpoint: {
        blockHash: "ee".repeat(32),
        blueScore: "1000",
        daaScore: "1000",
      },
    },
  };
}

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

  it("derives batch challenge context from host-trusted claims", async () => {
    const setup = makeServer();
    const trustedSecurityContext = {
      principal: "user:alpha",
      tenant: "tenant:one",
      authorizationScopes: ["download"],
      handlerState: { policyVersion: 3 },
    } satisfies TrustedSecurityContext;
    const response = await setup.server.handlePaidRequest(
      {
        url: RESOURCE.url,
        resource: RESOURCE,
        trustedSecurityContext,
      },
      async () => ({ body: "unreachable" }),
    );
    const required = decodePaymentRequiredHeader(
      response.headers[PAYMENT_REQUIRED_HEADER]!,
    );
    const accepted = required.accepts[0] as BatchPaymentRequirements;
    expect(accepted.extra.securityContextHash).toBe(
      trustedSecurityContextHash(trustedSecurityContext),
    );
  });

  it("accepts a deposit bound to host-trusted claims", async () => {
    const setup = makeServer();
    const trustedSecurityContext = {
      principal: "user:alpha",
      tenant: "tenant:one",
      authorizationScopes: ["download"],
    } satisfies TrustedSecurityContext;
    const required = setup.server.buildPaymentRequired({
      resource: RESOURCE,
      trustedSecurityContext,
    });
    const payment = makeDepositPayment(setup, {
      accepted: required.accepts[0] as BatchPaymentRequirements,
    });

    const response = await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload, { trustedSecurityContext }),
      async () => ({ body: "context-bound", chargedAmount: "100" }),
    );

    expect(response.status).toBe(200);
    expect(response.body).toBe("context-bound");
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
    expect(required.accepts[1]?.extra.binding).toBe("kaspa-escrow-v3");
  });

  it("suppresses additive exact without a trusted settlement reconciler", async () => {
    const setup = makeServer({ exactProfile: "additive" });

    expect(setup.server.supportedKinds().map((kind) => kind.scheme)).toEqual([
      "batch-settlement",
    ]);
    expect(() =>
      setup.server.buildPaymentRequired({
        resource: RESOURCE,
        scheme: "exact",
        exactHead: exactHeadChallenge(exactHead()),
      }),
    ).toThrow("trusted settlement reconciler");
    expect(
      setup.server.buildPaymentRequired({
        resource: RESOURCE,
        schemes: ["exact", "batch-settlement"],
      }).accepts.map((accepted) => accepted.scheme),
    ).toEqual(["batch-settlement"]);

    const exactOnly = await setup.server.handlePaidRequest(
      { url: RESOURCE.url, resource: RESOURCE, paymentScheme: "exact" },
      async () => ({ body: "unreachable" }),
    );
    expect(exactOnly.status).toBe(503);
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
    expect(required.accepts[0]?.extra.binding).toBe("kaspa-escrow-v3");
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
    const setup = makeServer({
      exactProfile: "additive",
      exactSettlementReconciler: {
        reconcileExactSettlement(attempt) {
          return { status: "unknown", transactionId: attempt.transactionId };
        },
      },
    });
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
      resource: required.resource,
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
      resource: required.resource,
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

  it("rejects one exact MCP authorization at another custom resource", async () => {
    const setup = makeServer({ amount: "100" });
    const resourceA = {
      url: "mcp://custom/download",
      tenantResource: "tenant-a",
    };
    const resourceB = {
      url: "mcp://custom/download",
      tenantResource: "tenant-b",
    };
    const required = setup.server.buildPaymentRequired({
      resource: resourceA,
      amount: "100",
      scheme: "exact",
    });
    const requestHash = mcpToolCallFingerprint({
      audience: MCP_AUDIENCE,
      toolName: "download",
      arguments: { id: "same" },
      accepted: required.accepts[0] as ExactPaymentRequirements,
      resource: resourceA,
    });
    const payment = makeExactPayment(setup, { requestHash });
    const params = {
      name: "download",
      arguments: { id: "same" },
      _meta: { [MCP_PAYMENT_META_KEY]: payment },
    };
    let executions = 0;

    const accepted = await handlePaidMcpToolCall(
      setup.server,
      {
        audience: MCP_AUDIENCE,
        name: "download",
        resource: resourceA,
        amount: "100",
        scheme: "exact",
      },
      params,
      async () => {
        executions += 1;
        return { result: { content: [{ type: "text", text: "paid A" }] } };
      },
    );
    const substituted = await handlePaidMcpToolCall(
      setup.server,
      {
        audience: MCP_AUDIENCE,
        name: "download",
        resource: resourceB,
        amount: "100",
        scheme: "exact",
      },
      params,
      async () => {
        executions += 1;
        return { result: { content: [{ type: "text", text: "wrong" }] } };
      },
    );

    expect(accepted.content?.[0]?.text).toBe("paid A");
    expect(substituted.isError).toBe(true);
    expect(readMcpPaymentRequired(substituted)).toBeUndefined();
    expect(substituted.content?.[0]?.text).toContain("invalid_transaction_state");
    expect(executions).toBe(1);
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
      resource: firstRequired.resource,
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
    expect(readMcpPaymentRequired(replay)).toBeUndefined();
    expect(replay.content?.[0]?.text).toContain("invalid_transaction_state");
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
      resource: required.resource,
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

  it("requires a payment identifier for every exact attempt", async () => {
    let verifierCalls = 0;
    const setup = makeServer({
      exactTransactionVerifier: {
        verifyExactPayment(request) {
          verifierCalls += 1;
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
    const payment = makeExactPayment(setup, { paymentIdentifier: null });
    let executed = false;

    const response = await setup.server.handlePaidRequest(
      requestWithPayment(payment, { paymentScheme: "exact" }),
      async () => {
        executed = true;
        return { body: "wrong" };
      },
    );

    expect(response.status).toBe(402);
    expect(verifierCalls).toBe(0);
    expect(executed).toBe(false);
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

  it("never returns an exact cached response across trusted principals", async () => {
    const setup = makeServer();
    const principalA = {
      principal: "user:a",
      tenant: "tenant:one",
      authorizationScopes: ["download"],
    } satisfies TrustedSecurityContext;
    const principalB = { ...principalA, principal: "user:b" };
    const accepted = makeExactPayment(setup)
      .accepted as ExactPaymentRequirements;
    const requestHash = bindRequestHashToTrustedContext(
      testRequestFingerprint(accepted),
      principalA,
    );
    const payment = makeExactPayment(setup, { requestHash });
    const first = await setup.server.handlePaidRequest(
      requestWithPayment(payment, { trustedSecurityContext: principalA }),
      async () => ({ body: "principal A secret" }),
    );
    let executed = false;
    const crossPrincipal = await setup.server.handlePaidRequest(
      requestWithPayment(payment, { trustedSecurityContext: principalB }),
      async () => {
        executed = true;
        return { body: "wrong" };
      },
    );

    expect(first.status).toBe(200);
    expect(crossPrincipal.status).toBe(409);
    expect(crossPrincipal.body).not.toBe("principal A secret");
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
    });
    await expect(
      store.loadExactSettlementAttempt(EXACT_TX_ID),
    ).resolves.not.toHaveProperty("handlerResult");
    await expect(store.loadExactPayment(EXACT_TX_ID)).resolves.toMatchObject({
      response: { body: "download" },
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

  it("enforces exact per-payer quotas by authenticated signer public key", async () => {
    const store = new MemoryServerChannelStore([], {
      limits: {
        maxRecords: 10,
        maxBytes: 8 * 1024 * 1024,
        maxRecordsPerPayer: 1,
      },
    });
    const setup = makeServer({
      store,
      exactTransactionVerifier: {
        verifyExactPayment(request) {
          return {
            transactionId: request.transaction,
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
    const firstPayment = makeExactPayment(setup, {
      transactionId: "a1".repeat(32),
    });
    const secondPayment = makeExactPayment(setup, {
      transactionId: "a2".repeat(32),
    });
    let executions = 0;

    const first = await setup.server.handlePaidRequest(
      requestWithPayment(firstPayment),
      async () => {
        executions += 1;
        return { body: "first" };
      },
    );
    const second = await setup.server.handlePaidRequest(
      requestWithPayment(secondPayment),
      async () => {
        executions += 1;
        return { body: "must not run" };
      },
    );

    expect(first.status).toBe(200);
    expect(second.status).not.toBe(200);
    expect(executions).toBe(1);
    expect(store.durableStateStats().payerRecords).toEqual({
      [CLIENT_KEY]: 1,
    });
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

    expect(replay.status).toBe(409);
    expect(replay.body).toEqual({ error: "invalid_transaction_state" });
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
        coordinationScope: memoryLockManager.coordinationScope,
        coordinationDomain: memoryLockManager.coordinationDomain,
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
    if (payment.payload.type !== "exact-transaction") {
      throw new Error("expected exact payment");
    }
    const transactionArtifact = {
      id: EXACT_TX_ID,
      version: 1,
      inputs: [
        {
          previousOutpoint: { transactionId: "71".repeat(32), index: 0 },
          sequence: "0",
          sigOpCount: 0,
          computeBudget: 0,
          signatureScript: "00",
          utxo: { amount: "100", scriptPublicKey: "000000" },
        },
        {
          previousOutpoint: { transactionId: "72".repeat(32), index: 1 },
          sequence: "0",
          sigOpCount: 0,
          computeBudget: 10,
          signatureScript: "00",
          utxo: { amount: "100", scriptPublicKey: "000000" },
        },
      ],
      outputs: [
        { value: "100", scriptPublicKey: "000000", covenant: null },
      ],
      lockTime: "0",
      subnetworkId: "00".repeat(20),
      gas: "0",
      payload: "",
      storageMass: "0",
    };
    payment.payload.transaction = JSON.stringify(transactionArtifact);
    const representationVariant = structuredClone(payment);
    if (representationVariant.payload.type !== "exact-transaction") {
      throw new Error("expected exact payment");
    }
    representationVariant.payload.transaction = JSON.stringify(
      { ignored: true, ...transactionArtifact },
      null,
      2,
    );
    representationVariant.payload.payerAddress =
      "kaspatest:receipt-only-variant";
    let executions = 0;

    const first = await setup.server.handlePaidRequest(
      requestWithPayment(payment, { paymentScheme: "exact", requestHash }),
      async () => {
        executions += 1;
        return { body: "cached" };
      },
    );
    const second = await setup.server.handlePaidRequest(
      requestWithPayment(representationVariant, {
        paymentScheme: "exact",
        requestHash,
      }),
      async () => {
        executions += 1;
        return { body: "wrong" };
      },
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toBe("cached");
    expect(executions).toBe(1);
    expect(setup.chain.sentTransactions).toEqual([
      JSON.stringify(transactionArtifact),
    ]);
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

  it("resumes one immutable accepted exact attempt after expiry without rebroadcast", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const setup = makeServer({
        maxTimeoutSeconds: 1,
        exactTransactionVerifier: {
          verifyExactPayment(request) {
            return {
              transactionId: EXACT_TX_ID,
              paymentOutput: {
                amount: request.amount,
                scriptPublicKey: request.payToScriptPublicKey,
              },
              requestAuthorization: fakeAuthorizationEvidence(
                request.authorization,
              ),
            };
          },
        },
      });
      setup.chain.sendTransactionId = EXACT_TX_ID;
      const requestHash = "bd".repeat(32);
      const payment = makeExactPayment(setup, { requestHash });
      const request = requestWithPayment(payment, {
        paymentScheme: "exact",
        requestHash,
      });
      let handlerCalls = 0;

      const first = await setup.server.handlePaidRequest(request, async () => {
        handlerCalls += 1;
        throw new Error("response lost after protected effect");
      });
      expect(first.status).toBe(500);
      expect(setup.chain.sentTransactions).toEqual([
        EXACT_TRANSACTION_ARTIFACT,
      ]);
      await expect(
        setup.store.loadExactSettlementAttempt(EXACT_TX_ID),
      ).resolves.toMatchObject({ status: "accepted" });
      await setup.server.recoverExactHandler(EXACT_TX_ID, {
        body: "recovered",
        chargedAmount: "100",
      });
      vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));

      const recovered = await setup.server.handlePaidRequest(
        request,
        async () => {
          handlerCalls += 1;
          return { body: "must not run" };
        },
      );

      expect(recovered).toMatchObject({ status: 200, body: "recovered" });
      expect(handlerCalls).toBe(1);
      expect(setup.chain.sentTransactions).toEqual([
        EXACT_TRANSACTION_ARTIFACT,
      ]);
      await expect(
        setup.store.loadExactSettlementAttempt(EXACT_TX_ID),
      ).resolves.toMatchObject({ status: "applied" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects changed exact bindings through the expiry recovery exception", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const setup = makeServer({
        maxTimeoutSeconds: 1,
        exactTransactionVerifier: {
          verifyExactPayment(request) {
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
      const requestHash = "be".repeat(32);
      const payment = makeExactPayment(setup, { requestHash });
      const request = requestWithPayment(payment, {
        paymentScheme: "exact",
        requestHash,
      });
      await setup.server.handlePaidRequest(request, async () => {
        throw new Error("leave accepted attempt for recovery");
      });
      const changed = structuredClone(payment);
      Object.assign(
        changed,
        paymentIdentifierExtension("changed_exact_identifier_0001"),
      );
      vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
      let executed = false;

      const rejected = await setup.server.handlePaidRequest(
        requestWithPayment(changed, {
          paymentScheme: "exact",
          requestHash,
        }),
        async () => {
          executed = true;
          return { body: "wrong" };
        },
      );

      expect(rejected.status).toBe(402);
      expect(executed).toBe(false);
      await expect(
        setup.store.loadExactSettlementAttempt(EXACT_TX_ID),
      ).resolves.toMatchObject({ status: "accepted" });
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

  it("returns a controlled 400 for a non-JSON direct request body", async () => {
    const setup = makeServer();
    const payment = makeExactPayment(setup);

    const response = await setup.server.handlePaidRequest(
      requestWithPayment(payment, {
        paymentScheme: "exact",
        body: new URLSearchParams([["a", "b"]]),
      }),
      async () => ({ body: "wrong" }),
    );

    expect(response.status).toBe(400);
    expect(response.headers[PAYMENT_REQUIRED_HEADER]).toBeUndefined();
  });

  it("accepts an initial deposit-voucher and commits channel state after handler success", async () => {
    const setup = makeServer();
    const payment = makeDepositPayment(setup);

    const response = await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload),
      async () => ({
        body: "secret",
        chargedAmount: "100",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.body).toBe("secret");
    expect(response.headers[PAYMENT_RESPONSE_HEADER]).toBeTruthy();
    const stored = await setup.store.loadChannel(payment.channelId);
    expect(stored?.chargedCumulativeAmount).toBe("100");
    expect(stored?.signedMaxClaimable).toBe("100");
    expect(stored?.lastCommitmentId).toMatch(/^[0-9a-f]{64}$/);
    const commitment = await setup.store.loadCommitment(
      stored!.lastCommitmentId!,
    );
    expect(commitment?.chargedAmount).toBe("100");
    expect(commitment?.chargedCumulativeAfter).toBe("100");
    expect(commitment?.response.status).toBe(200);
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

  it("runs one protected effect across two server instances sharing one store", async () => {
    const store = new MemoryServerChannelStore();
    const lockManager = new MemoryChannelLockManager();
    const first = makeServer({ store, lockManager });
    const second = makeServer({ store, lockManager });
    const payment = makeDepositPayment(first);
    const deposit = payment.payload.payload;
    if (deposit.type !== "deposit-voucher")
      throw new Error("expected deposit voucher");
    second.chain.setUtxo({
      outpoint: deposit.fundingOutpoint,
      amount: deposit.fundingAmountSompi,
      scriptPublicKey: deposit.activeScriptPublicKey,
      finality: "accepted",
    });
    let handlerCalls = 0;
    const handler = async () => {
      handlerCalls += 1;
      return { body: "shared", chargedAmount: "100" };
    };

    const responses = await Promise.all([
      first.server.handlePaidRequest(
        requestWithPayment(payment.payload),
        handler,
      ),
      second.server.handlePaidRequest(
        requestWithPayment(payment.payload),
        handler,
      ),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(responses.map((response) => response.body)).toEqual([
      "shared",
      "shared",
    ]);
    expect(handlerCalls).toBe(1);
  });

  it("lets one exact-or-batch request own an identifier across two instances", async () => {
    const store = new MemoryServerChannelStore();
    const lockManager = new MemoryChannelLockManager();
    const exact = makeServer({
      store,
      lockManager,
      requirePaymentIdentifier: true,
    });
    const batch = makeServer({
      store,
      lockManager,
      requirePaymentIdentifier: true,
    });
    const paymentIdentifier = "pay_7d5d747be160e280504c099d984bcfe0";
    const exactPayment = makeExactPayment(exact, { paymentIdentifier });
    const batchPayment = makeDepositPayment(batch, { paymentIdentifier });
    let handlerCalls = 0;
    const handler = async () => {
      handlerCalls += 1;
      return { body: "winner", chargedAmount: "100" };
    };

    const responses = await Promise.all([
      exact.server.handlePaidRequest(requestWithPayment(exactPayment), handler),
      batch.server.handlePaidRequest(
        requestWithPayment(batchPayment.payload),
        handler,
      ),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    expect(handlerCalls).toBe(1);
    await expect(
      store.loadPaymentIdentifierReservation(paymentIdentifier),
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("rejects shared-store servers that use independent local locks", () => {
    const store = new MemoryServerChannelStore();
    makeServer({ store });
    expect(() => makeServer({ store })).toThrow(
      "shared store cannot be used by multiple server instances",
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
      async () => ({ body: "next", chargedAmount: "100" }),
    );

    expect(response.status).toBe(200);
    expect(response.body).toBe("next");
    const stored = await requireChannel(setup.store, deposit.channelId);
    expect(stored.chargedCumulativeAmount).toBe("200");
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
            authorizingInput: 0,
            acceptance: acceptedChainEvidence(next.activeOutpoint.txid),
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
      async () => ({ body: "topped", chargedAmount: "100" }),
    );

    expect(response.status).toBe(200);
    expect(response.body).toBe("topped");
    const stored = await requireChannel(setup.store, deposit.channelId);
    expect(stored.activeOutpoint.txid).toBe(TOP_UP_TX);
    expect(stored.fundingAmount).toBe("1200");
    expect(stored.chargedCumulativeAmount).toBe("200");
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
              authorizingInput: 0,
              acceptance: acceptedChainEvidence(next.activeOutpoint.txid),
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
    const corrective = decodePaymentRequiredHeader(
      response.headers[PAYMENT_REQUIRED_HEADER],
    );
    const accepted = corrective.accepts[0] as BatchPaymentRequirements;
    expect(accepted.extra.channelState).toBeUndefined();
    expect(accepted.extra.voucherState).toBeUndefined();
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

  it("rejects a captured batch presentation replayed against a different request", async () => {
    const setup = makeServer();
    const payment = makeDepositPayment(setup);
    const request = requestWithPayment(payment.payload, {
      body: { operation: "first" },
    });
    request.body = { operation: "second" };
    let executed = false;

    const response = await setup.server.handlePaidRequest(request, async () => {
      executed = true;
      return { chargedAmount: "100" };
    });

    expect(response.status).toBe(402);
    expect(executed).toBe(false);
    await expect(
      setup.store.loadChannel(payment.channelId),
    ).resolves.toBeUndefined();
  });

  it("rejects expired batch presentations", async () => {
    const setup = makeServer();
    const payment = makeDepositPayment(setup);
    if (payment.payload.payload.type !== "deposit-voucher") {
      throw new Error("expected deposit-voucher");
    }
    payment.payload.payload.presentation.expiresAt =
      "2026-01-01T00:00:00.000Z";
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

  it("rejects bad batch presentation signatures", async () => {
    const setup = makeServer();
    const payment = makeDepositPayment(setup);
    const request = requestWithPayment(payment.payload);
    const encoded = request.headers[PAYMENT_SIGNATURE_HEADER];
    const captured = JSON.parse(
      Buffer.from(encoded, "base64").toString("utf8"),
    ) as PaymentPayload;
    if (
      captured.payload.type !== "deposit-voucher" &&
      captured.payload.type !== "voucher"
    ) {
      throw new Error("expected voucher payment");
    }
    captured.payload.presentation.signature = "ff".repeat(64);
    request.headers[PAYMENT_SIGNATURE_HEADER] =
      encodePaymentSignatureHeader(captured);
    let executed = false;

    const response = await setup.server.handlePaidRequest(request, async () => {
      executed = true;
      return { chargedAmount: "100" };
    });

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
        return { body: "cached", chargedAmount: "100" };
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
        return { body: "cached", chargedAmount: "100" };
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
    expect(stored.chargedCumulativeAmount).toBe("100");
    expect(stored.signedMaxClaimable).toBe("100");
  });

  it("returns one cached response for batch representation variants", async () => {
    const setup = makeServer();
    const payment = makeDepositPayment(setup);
    let executions = 0;
    const first = await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload, { requestHash: "aa".repeat(32) }),
      async () => {
        executions += 1;
        return { body: "cached", chargedAmount: "100" };
      },
    );
    const variant = structuredClone(payment.payload);
    if (variant.payload.type !== "deposit-voucher") {
      throw new Error("expected deposit voucher");
    }
    variant.payload.activeScriptPublicKey =
      variant.payload.activeScriptPublicKey.toUpperCase();
    variant.payload.untrusted = { ignored: true };
    variant.untrusted = "ignored";
    variant.extensions = { untrusted: { ignored: true } };
    const replay = await setup.server.handlePaidRequest(
      requestWithPayment(variant, { requestHash: "aa".repeat(32) }),
      async () => {
        executions += 1;
        return { body: "wrong" };
      },
    );

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body).toBe("cached");
    expect(executions).toBe(1);
  });

  it("keeps stale batch vouchers corrective after a later commitment", async () => {
    const setup = makeServer();
    const deposit = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(
      requestWithPayment(deposit.payload, { requestHash: "aa".repeat(32) }),
      async () => ({
        chargedAmount: "100",
      }),
    );
    const channel = await requireChannel(setup.store, deposit.channelId);
    const voucher = makeVoucherPayment(setup, channel);
    await setup.server.handlePaidRequest(
      requestWithPayment(voucher, { requestHash: "bb".repeat(32) }),
      async () => ({
        chargedAmount: "100",
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
    const corrective = decodePaymentRequiredHeader(
      stale.headers[PAYMENT_REQUIRED_HEADER],
    );
    const accepted = corrective.accepts[0] as BatchPaymentRequirements;
    expect(accepted.extra.channelState).toBeUndefined();
    expect(accepted.extra.voucherState).toBeUndefined();
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
        return { body: "cached", chargedAmount: "100" };
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
    expect(stored.chargedCumulativeAmount).toBe("100");
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
        chargedAmount: "100",
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
        chargedAmount: "100",
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

  it("resumes a durable batch handler result without rerunning protected work after commit failure", async () => {
    const store = new FailingBatchCommitStore(1);
    const setup = makeServer({ store });
    const payment = makeDepositPayment(setup);
    let executions = 0;
    const run = () =>
      setup.server.handlePaidRequest(
        requestWithPayment(payment.payload, { requestHash: "aa".repeat(32) }),
        async () => {
          executions += 1;
          return { body: "durable", chargedAmount: "100" };
        },
      );

    await expect(run()).resolves.toMatchObject({ status: 500 });
    const recovered = await run();

    expect(recovered.status).toBe(200);
    expect(recovered.body).toBe("durable");
    expect(executions).toBe(1);
    await expect(
      setup.store.loadChannel(payment.channelId),
    ).resolves.toMatchObject({
      chargedCumulativeAmount: "100",
    });
  });

  it("allows operator recovery after a crash before the batch recovery marker", async () => {
    const store = new UnmarkedBatchRecoveryStore();
    const setup = makeServer({ store });
    const payment = makeDepositPayment(setup);
    const request = requestWithPayment(payment.payload, {
      requestHash: "aa".repeat(32),
    });
    let executions = 0;

    const failed = await setup.server.handlePaidRequest(request, async () => {
      executions += 1;
      throw new Error("process exited after protected work");
    });

    expect(failed.status).toBe(500);
    expect(store.attemptId).toBeDefined();
    await expect(
      store.loadBatchSettlementAttempt(store.attemptId!),
    ).resolves.toMatchObject({ handlerStartedAt: expect.any(String) });
    await expect(
      store.loadBatchSettlementAttempt(store.attemptId!),
    ).resolves.not.toHaveProperty("recoveryReason");

    await expect(
      setup.server.recoverBatchHandler(store.attemptId!, {
        body: "undercharged",
        chargedAmount: "0",
      }),
    ).rejects.toThrow("accepted fixed charge");
    await expect(
      setup.server.recoverBatchHandler(store.attemptId!, { body: "recovered" }),
    ).resolves.toMatchObject({
      handlerResult: { body: "recovered", chargedAmount: "100" },
    });
    const recovered = await setup.server.handlePaidRequest(request, async () => {
      executions += 1;
      return { body: "must not run", chargedAmount: "100" };
    });

    expect(recovered).toMatchObject({ status: 200, body: "recovered" });
    expect(executions).toBe(1);
  });

  it("does not register genesis state when atomic attempt admission fails", async () => {
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
    await expect(setup.store.loadChannel(payment.channelId)).resolves.toBeUndefined();
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
        chargedAmount: "100",
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
          return { chargedAmount: "100" };
        },
      ),
      setup.server.handlePaidRequest(
        requestWithPayment(second.payload, { requestHash: "aa".repeat(32) }),
        async () => {
          executions += 1;
          return { chargedAmount: "100" };
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
        chargedAmount: "100",
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
    const lockManager = new MemoryChannelLockManager();
    const rolling = {
      minimumRefundLeadDaa: "100",
      allowRollingRefundTimeoutDaa: true,
      maximumRefundHorizonDaa: "1000",
    } as const;
    const initial = makeServer({
      ...rolling,
      store,
      lockManager,
      refundTimeoutDaa: "2000",
    });
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
      lockManager,
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

  it("accepts a retry that selected fresh corrective terms", async () => {
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
    expect(accepted.extra.channelState).toBeUndefined();
    expect(accepted.extra.voucherState).toBeUndefined();
    const retry = makeVoucherPayment(setup, channel, {
      accepted,
      voucherAmount: "200",
    });

    const response = await setup.server.handlePaidRequest(
      requestWithPayment(retry),
      async () => ({ chargedAmount: "100" }),
    );

    expect(response.status).toBe(200);
    const updated = await requireChannel(setup.store, deposit.channelId);
    expect(updated.chargedCumulativeAmount).toBe("200");
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

  it("preserves host-trusted context in corrective batch offers", async () => {
    const setup = makeServer();
    const trustedSecurityContext = {
      principal: "user:alpha",
      tenant: "tenant:one",
      authorizationScopes: ["download"],
    } satisfies TrustedSecurityContext;
    const payment = makeDepositPayment(setup, { voucherAmount: "99" });

    const response = await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload, { trustedSecurityContext }),
      async () => ({ body: "wrong" }),
    );

    expect(response.status).toBe(402);
    const corrective = decodePaymentRequiredHeader(
      response.headers[PAYMENT_REQUIRED_HEADER],
    );
    const accepted = corrective.accepts[0] as BatchPaymentRequirements;
    expect(accepted.extra.securityContextHash).toBe(
      trustedSecurityContextHash(trustedSecurityContext),
    );
  });

  it("rejects voucher-only payments when stored channel terms no longer match the server", async () => {
    const store = new MemoryServerChannelStore();
    const lockManager = new MemoryChannelLockManager();
    const firstServer = makeServer({ store, lockManager });
    const deposit = makeDepositPayment(firstServer);
    await firstServer.server.handlePaidRequest(
      requestWithPayment(deposit.payload),
      async () => ({ chargedAmount: "100" }),
    );
    const channel = await requireChannel(store, deposit.channelId);
    const changedServer = makeServer({
      store,
      lockManager,
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
      async () => ({ chargedAmount: "100" }),
    );
    const retired = await requireChannel(setup.store, deposit.channelId);
    await retireChannelForTest(setup.store, retired);
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
      async () => ({ chargedAmount: "100" }),
    );
    const channel = await requireChannel(setup.store, deposit.channelId);
    await retireChannelForTest(setup.store, channel);
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
    await retireChannelForTest(setup.store, channel);

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

  it("rolls a removed claim back to the predecessor as refund-only recovery", async () => {
    const setup = makeServer({
      claimBuilder: {
        async buildClaimTransaction({ channel, claimAmount }) {
          return {
            transaction: "ab".repeat(32),
            transactionId: CLAIM_TX,
            claimAmount,
            continuationOutpoint: { txid: CLAIM_TX, index: 1 },
            continuationScriptPublicKey: deriveEscrow(
              channel.channelConfig,
              "100",
            ).activeScriptPublicKey,
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
    const beforeClaim = await requireChannel(setup.store, payment.channelId);
    setup.chain.setUtxo({
      outpoint: { txid: CLAIM_TX, index: 1 },
      amount: "900",
      scriptPublicKey: deriveEscrow(
        beforeClaim.channelConfig,
        "100",
      ).activeScriptPublicKey,
      finality: "confirmed",
    });
    const claimed = await setup.server.executeClaim(payment.channelId);
    const acceptedClaim = claimed.channel.lineage.journal.find(
      (event) => event.event === "accepted",
    );
    if (!acceptedClaim || acceptedClaim.event !== "accepted") {
      throw new Error("missing accepted claim lineage event");
    }
    setup.chain.lineageDiscovery = (request) => ({
      fromCheckpoint: request.lineage.checkpoint,
      checkpoint: request.lineage.checkpoint,
      continuity: "complete",
      removedChainBlockHashes: [
        acceptedClaim.transition.acceptance.acceptingBlockHash,
      ],
      addedChainBlocks: [],
    });

    const rolledBack = await setup.server.reconcileChannel(payment.channelId);

    expect(rolledBack).toMatchObject({
      activeOutpoint: beforeClaim.activeOutpoint,
      fundingAmount: "1000",
      claimedCumulativeAmount: "0",
      chargedCumulativeAmount: "100",
      signedMaxClaimable: "100",
      status: "suspicious",
    });
    expect(rolledBack.lineage.journal.map((event) => event.event)).toEqual([
      "accepted",
      "removed",
    ]);
  });

  it("keeps a channel unavailable after its covenant genesis is removed", async () => {
    const setup = makeServer();
    const payment = makeDepositPayment(setup);
    await setup.server.handlePaidRequest(
      requestWithPayment(payment.payload),
      async () => ({ chargedAmount: "100" }),
    );
    const channel = await requireChannel(setup.store, payment.channelId);
    setup.chain.lineageDiscovery = (request) => ({
      fromCheckpoint: request.lineage.checkpoint,
      checkpoint: request.lineage.checkpoint,
      continuity: "complete",
      removedChainBlockHashes: [
        channel.genesisEvidence.acceptance.acceptingBlockHash,
      ],
      addedChainBlocks: [],
    });

    await expect(
      setup.server.reconcileChannel(payment.channelId),
    ).rejects.toThrow("covenant genesis was removed");
    await expect(setup.store.loadChannel(payment.channelId)).resolves.toEqual(
      channel,
    );
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
          const claimedCumulativeAmount = (
            BigInt(channel.claimedCumulativeAmount) + BigInt(claimAmount)
          ).toString();
          return {
            transaction: transactionId,
            transactionId,
            claimAmount,
            continuationOutpoint: { txid: transactionId, index: 1 },
            continuationScriptPublicKey: deriveEscrow(
              channel.channelConfig,
              claimedCumulativeAmount,
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
    expect(attempt?.finality).toBe("confirmed");
    expect(attempt?.transactionId).toBe(CLAIM_TX);
    expect(attempt?.continuationOutpoint).toEqual({ txid: CLAIM_TX, index: 1 });
    await expect(setup.server.executeClaim(payment.channelId)).rejects.toThrow(
      "channel has an open claim attempt",
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
    const store = new SnapshotSkewStore();
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
    await expect(setup.server.executeClaim(payment.channelId)).rejects.toThrow(
      "funding outpoint",
    );
    const channel = await requireChannel(setup.store, payment.channelId);
    store.skewChannel({
      ...channel,
      version: (BigInt(channel.version) + 1n).toString(),
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
    const store = new SnapshotSkewStore();
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
    await expect(setup.server.executeClaim(payment.channelId)).rejects.toThrow(
      "funding outpoint",
    );
    const channel = await requireChannel(setup.store, payment.channelId);
    store.skewChannel({ ...channel, signedMaxClaimable: "101" });
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
      "channel has an open claim attempt",
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
    setup.chain.finality = "broadcast";
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
      },
    );

    expect(recovered.accepted).toBe(true);
    expect(recovered.finality).toBe("confirmed");
    expect(recovered.channel.claimedCumulativeAmount).toBe("100");
  });

  it("keeps a persisted stronger claim threshold after restart", async () => {
    const store = new MemoryServerChannelStore();
    const lockManager = new MemoryChannelLockManager();
    const initial = makeServer({
      store,
      lockManager,
      confirmationThreshold: 31,
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
      acceptance: acceptedChainEvidence(deposit.fundingOutpoint.txid, 31),
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
      requiredConfirmations: 31,
      status: "broadcast",
      finality: "accepted",
    });

    const restarted = makeServer({
      store,
      lockManager,
      confirmationThreshold: 30,
    });
    restarted.chain.setUtxo({
      outpoint: { txid: CLAIM_TX, index: 1 },
      amount: "900",
      scriptPublicKey: "0000" + "77".repeat(34),
      finality: "accepted",
    });
    await expect(
      restarted.server.recoverAcceptedClaim(payment.channelId),
    ).rejects.toThrow("configured confirmation threshold");
    await expect(
      store.loadOpenClaimAttempt(payment.channelId),
    ).resolves.toMatchObject({ status: "broadcast" });

    restarted.chain.setUtxo({
      outpoint: { txid: CLAIM_TX, index: 1 },
      amount: "900",
      scriptPublicKey: "0000" + "77".repeat(34),
      finality: "confirmed",
      acceptance: acceptedChainEvidence(CLAIM_TX, 31),
    });
    const recovered = await restarted.server.recoverAcceptedClaim(
      payment.channelId,
    );
    expect(recovered.finality).toBe("confirmed");
    expect(recovered.channel.claimedCumulativeAmount).toBe("100");
  });

  it("does not tighten a persisted claim threshold after restart", async () => {
    const store = new MemoryServerChannelStore();
    const lockManager = new MemoryChannelLockManager();
    const initial = makeServer({
      store,
      lockManager,
      confirmationThreshold: 30,
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
    initial.chain.finality = "broadcast";
    await expect(initial.server.executeClaim(payment.channelId)).resolves.toMatchObject({
      accepted: false,
      finality: "broadcast",
    });
    await expect(
      store.loadOpenClaimAttempt(payment.channelId),
    ).resolves.toMatchObject({
      requiredConfirmations: 30,
      status: "broadcast",
      finality: "broadcast",
    });

    const restarted = makeServer({
      store,
      lockManager,
      confirmationThreshold: 31,
    });
    restarted.chain.setUtxo({
      outpoint: { txid: CLAIM_TX, index: 1 },
      amount: "900",
      scriptPublicKey: "0000" + "77".repeat(34),
      finality: "accepted",
    });
    const recovered = await restarted.server.recoverAcceptedClaim(
      payment.channelId,
    );
    expect(recovered.finality).toBe("confirmed");
    expect(recovered.channel.claimedCumulativeAmount).toBe("100");
  });

  it("requires trusted exact-txid rejection before abandoning an open claim", async () => {
    let reconciliation: ClaimReconciliation = {
      transactionId: CLAIM_TX,
      evidence: unknownChainEvidence(CLAIM_TX, "indexing lag"),
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
      transactionId: "66".repeat(32),
      evidence: absentChainEvidence("66".repeat(32), "not accepted"),
    };
    await expect(
      setup.server.abandonClaimAttempt(payment.channelId),
    ).rejects.toThrow("does not match the persisted signed transaction");
    reconciliation = {
      transactionId: CLAIM_TX,
      evidence: acceptedChainEvidence(CLAIM_TX),
    };
    await expect(
      setup.server.abandonClaimAttempt(payment.channelId),
    ).rejects.toThrow("must be recovered");
    reconciliation = {
      transactionId: CLAIM_TX,
      evidence: {
        status: "absent",
        transactionId: CLAIM_TX,
        reason: "an unrelated outpoint was spent",
        proof: {
          kind: "confirmed-conflicting-spend",
          spentOutpoint: { txid: "67".repeat(32), index: 7 },
          conflictingTransaction: acceptedChainEvidence("68".repeat(32)),
        },
      },
    };
    await expect(
      setup.server.abandonClaimAttempt(payment.channelId),
    ).rejects.toThrow("remains unknown");
    await expect(
      setup.store.loadOpenClaimAttempt(payment.channelId),
    ).resolves.toBeDefined();
    reconciliation = {
      transactionId: CLAIM_TX,
      evidence: absentChainEvidence(
        CLAIM_TX,
        "authoritative node rejection",
      ),
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

  it("fails closed when claim broadcast evidence is missing", async () => {
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
    setup.chain.useSendEvidenceOverride = true;
    setup.chain.sendEvidenceOverride = undefined;

    await expect(setup.server.executeClaim(payment.channelId)).rejects.toThrow(
      "broadcast claim evidence does not match the persisted transaction",
    );
    await expect(
      setup.store.loadOpenClaimAttempt(payment.channelId),
    ).resolves.toMatchObject({ transactionId: CLAIM_TX, status: "pending" });
  });

  it("ignores caller claim evidence and recovers only from the trusted UTXO", async () => {
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
      acceptance: acceptedChainEvidence(CLAIM_TX, 29),
    });
    await expect(
      setup.server.recoverAcceptedClaim(payment.channelId, {
        transactionId: CLAIM_TX,
        evidence: acceptedChainEvidence(CLAIM_TX),
      } as unknown as ClaimRecoveryInput),
    ).rejects.toThrow("configured confirmation threshold");

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
    confirmationThreshold: CONFIRMATION_THRESHOLD,
    store,
    chainProvider: chain,
    addressCodec: new FakeAddressCodec(),
    voucherVerifier: {
      verifyVoucher({ digest, voucher }) {
        return voucher.signature === `${digest}${digest}`;
      },
    },
    batchPresentationVerifier: {
      verifyPresentation({ digest, signature }) {
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
    exactSettlementReconciler:
      overrides.exactSettlementReconciler ?? {
        reconcileExactSettlement(attempt) {
          return {
            status: "unknown" as const,
            transactionId: attempt.transactionId,
          };
        },
      },
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
  options: {
    requestHash?: Hash32Hex;
    transactionId?: Hash32Hex;
    paymentIdentifier?: string | null;
  } = {},
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
    ...(options.paymentIdentifier === null
      ? {}
      : paymentIdentifierExtension(
          options.paymentIdentifier ?? `exact_${requestHash}`,
        )),
  };
}

function makeExactPayment(
  setup: ReturnType<typeof makeServer>,
  options: {
    paymentIdentifier?: string | null;
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
    ...(options.paymentIdentifier === null
      ? {}
      : paymentIdentifierExtension(
          options.paymentIdentifier ?? `exact_${requestHash}`,
        )),
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
    ...paymentIdentifierExtension(`exact_${requestHash}`),
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
    templateId: "kaspa-x402-escrow-v4",
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
        presentation: signBatchPresentation({
          accepted,
          channelId: id,
          covenantId: voucher.covenantId,
          voucher,
          requestFingerprint: testBatchRequestFingerprint(accepted),
          paymentIdentifier: options.paymentIdentifier ?? null,
        }),
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
  const voucher = signVoucher({
    network: accepted.network,
    covenantId: channel.covenantId,
    amount,
  });
  return {
    x402Version: X402_VERSION,
    accepted,
    payload: {
      type: "voucher",
      channelId: channel.channelId,
      clientPublicKey: channel.channelConfig.clientPublicKey,
      fundingOutpoint: channel.activeOutpoint,
      activeScriptPublicKey: channel.activeScriptPublicKey,
      voucher,
      presentation: signBatchPresentation({
        accepted,
        channelId: channel.channelId,
        covenantId: channel.covenantId,
        voucher,
        requestFingerprint: testBatchRequestFingerprint(accepted),
        paymentIdentifier: options.paymentIdentifier ?? null,
      }),
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
    trustedSecurityContext?: TrustedSecurityContext;
  } = {},
) {
  let requestPayment = paymentPayload;
  if (
    paymentPayload.accepted.scheme === "batch-settlement" &&
    (paymentPayload.payload.type === "deposit-voucher" ||
      paymentPayload.payload.type === "voucher")
  ) {
    requestPayment = structuredClone(paymentPayload);
    if (
      requestPayment.payload.type !== "deposit-voucher" &&
      requestPayment.payload.type !== "voucher"
    ) {
      throw new Error("expected voucher payment");
    }
    const unsigned = {
      ...requestPayment.payload.presentation,
      requestFingerprint:
        bindRequestHashToTrustedContext(
          options.requestHash ??
            testBatchRequestFingerprint(
              requestPayment.accepted as BatchPaymentRequirements,
              options.body,
            ),
          options.trustedSecurityContext,
        ),
      paymentIdentifier: testPaymentIdentifier(requestPayment),
    };
    const digest = batchPresentationDigest(unsigned);
    requestPayment.payload.presentation = {
      ...unsigned,
      digest,
      signature: `${digest}${digest}`,
    };
  }
  return {
    url: RESOURCE.url,
    resource: RESOURCE,
    body: options.body,
    paymentAmount: options.paymentAmount,
    paymentScheme: options.paymentScheme,
    paymentSchemes: options.paymentSchemes,
    requestHash: options.requestHash,
    trustedSecurityContext: options.trustedSecurityContext,
    headers: {
      [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader(requestPayment),
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

async function retireChannelForTest(
  store: ServerChannelStore,
  channel: ServerChannelRecord,
): Promise<void> {
  const leaseId = sha256Hex(
    stableStringify({
      scope: "kaspa-x402:test:retirement",
      channelId: channel.channelId,
      version: channel.version,
    }),
  );
  await store.claimChannelOperation({
    leaseId,
    channelId: channel.channelId,
    covenantId: channel.covenantId,
    kind: "retirement",
    expected: channel,
    status: "reserved",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  await store.retireChannel(channel.channelId, leaseId, channel);
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
  claimedCumulativeAmount = "0",
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
    claimedCumulativeAmount,
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
  const digest = voucherDigest({
    network: input.network,
    covenantId: input.covenantId,
    authorizedCumulativeAmount: input.amount,
  });
  return {
    covenantId: input.covenantId,
    authorizedCumulativeAmount: input.amount,
    signature: input.badSignature ? "ff".repeat(64) : `${digest}${digest}`,
  };
}

function testBatchRequestFingerprint(
  accepted: BatchPaymentRequirements,
  body?: unknown,
): Hash32Hex {
  return sha256Hex(
    stableStringify({
      method: "GET",
      url: RESOURCE.url,
      body: body ?? null,
      paymentRequirementsHash: sha256Hex(stableStringify(accepted)),
    }),
  );
}

function testPaymentIdentifier(paymentPayload: PaymentPayload): string | null {
  const extension = paymentPayload.extensions?.["payment-identifier"] as
    | { info?: { id?: unknown } }
    | undefined;
  return typeof extension?.info?.id === "string" ? extension.info.id : null;
}

function signBatchPresentation(input: {
  accepted: BatchPaymentRequirements;
  channelId: Hash32Hex;
  covenantId: Hash32Hex;
  voucher: { authorizedCumulativeAmount: string; signature: string };
  requestFingerprint: Hash32Hex;
  paymentIdentifier: string | null;
}) {
  const unsigned = {
    version: "kaspa-x402-batch-presentation-v1" as const,
    requestFingerprint: input.requestFingerprint,
    acceptedRequirementsHash: batchPaymentRequirementsHash(input.accepted),
    securityContextHash: input.accepted.extra.securityContextHash,
    channelId: input.channelId,
    covenantId: input.covenantId,
    voucherDigest: voucherDigest({
      network: input.accepted.network,
      covenantId: input.covenantId,
      authorizedCumulativeAmount: input.voucher.authorizedCumulativeAmount,
    }),
    paymentIdentifier: input.paymentIdentifier,
    nonce: SALT,
    expiresAt: new Date(
      Date.now() + input.accepted.maxTimeoutSeconds * 1_000 - 1_000,
    ).toISOString(),
  };
  const digest = batchPresentationDigest(unsigned);
  return { ...unsigned, digest, signature: `${digest}${digest}` };
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
  useSendEvidenceOverride = false;
  sendEvidenceOverride: unknown;
  readonly sentTransactions: string[] = [];
  sendFailure?: Error;
  genesisAvailable = true;
  genesisVerificationCount = 0;
  genesisTotalOutputCount = 1;
  lineageDiscovery?: (
    request: Parameters<ServerChainProvider["discoverCovenantLineage"]>[0],
  ) => ReturnType<ServerChainProvider["discoverCovenantLineage"]> extends Promise<infer T>
    ? T
    : never;

  setUtxo(
    utxo: Omit<ChainUtxo, "acceptance"> &
      Partial<Pick<ChainUtxo, "acceptance">>,
  ): void {
    this.utxos.set(
      outpointKey(utxo.outpoint),
      structuredClone({
        covenantId: COVENANT_ID,
        ...utxo,
        acceptance:
          utxo.acceptance ??
          acceptedChainEvidence(
            utxo.outpoint.txid,
            utxo.finality === "broadcast" ? 1 : CONFIRMATION_THRESHOLD,
          ),
      }),
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
      acceptance: request.utxo.acceptance,
    };
  }

  async discoverCovenantLineage(request: Parameters<
    ServerChainProvider["discoverCovenantLineage"]
  >[0]) {
    if (this.lineageDiscovery) return this.lineageDiscovery(request);
    return {
      fromCheckpoint: request.lineage.checkpoint,
      checkpoint: request.lineage.checkpoint,
      continuity: "complete" as const,
      removedChainBlockHashes: [],
      addedChainBlocks: [],
    };
  }

  async estimateClaimFee(): Promise<string> {
    return this.claimFee;
  }

  async sendTransaction(
    transaction: string,
  ) {
    this.sendCount += 1;
    this.sentTransactions.push(transaction);
    if (this.sendFailure) throw this.sendFailure;
    const defaultEvidence =
      this.finality === "broadcast"
        ? {
            status: "unknown" as const,
            transactionId: this.sendTransactionId,
            reason: "not yet indexed",
          }
        : acceptedChainEvidence(this.sendTransactionId);
    return {
      transactionId: this.sendTransactionId,
      finality: this.finality,
      evidence: (this.useSendEvidenceOverride
        ? this.sendEvidenceOverride
        : defaultEvidence) as never,
    };
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

class UnmarkedBatchRecoveryStore extends MemoryServerChannelStore {
  attemptId?: Hash32Hex;

  async claimBatchSettlement(record: BatchSettlementAttemptRecord) {
    this.attemptId = record.attemptId;
    return super.claimBatchSettlement(record);
  }

  async markBatchHandlerRecoveryRequired(
    _attemptId: Hash32Hex,
    _reason: string,
    _observedAt: string,
  ): Promise<void> {
    throw new Error("transport failed before recovery marker persistence");
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

class SnapshotSkewStore extends MemoryServerChannelStore {
  readonly #skewedChannels = new Map<Hash32Hex, ServerChannelRecord>();

  skewChannel(channel: ServerChannelRecord): void {
    this.#skewedChannels.set(channel.channelId, structuredClone(channel));
  }

  async loadChannel(
    channelId: Hash32Hex,
  ): Promise<ServerChannelRecord | undefined> {
    const skewed = this.#skewedChannels.get(channelId);
    return skewed ? structuredClone(skewed) : super.loadChannel(channelId);
  }
}

function outpointKey(outpoint: FundingOutpoint): string {
  return `${outpoint.txid}:${outpoint.index}`;
}
