import { describe, expect, it } from "vitest";

import {
  MCP_PAYMENT_RESPONSE_META_KEY,
  X402_VERSION,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  mcpToolCallFingerprint,
  readMcpPaymentRequired,
  readMcpPaymentResponse,
  type ExactPaymentRequirements,
  type PaymentRequired,
  type SettlementResponse,
} from "@kaspa-x402/core";
import {
  DirectModeClient,
  MemoryChannelStore,
  paidMcpToolCall,
  type AddressCodec,
  type ChannelSigner,
  type FundingProvider,
} from "@kaspa-x402/client";
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  handlePaidMcpToolCall,
} from "@kaspa-x402/server";

describe("MCP hybrid settlement failure E2E", () => {
  it("round-trips through client retry handling and server MCP conversion", async () => {
    const required = makeExactRequired();
    const settlementFailure: SettlementResponse = {
      success: false,
      transaction: "",
      network: "kaspa:testnet-10",
      errorReason: "invalid_transaction_state",
    };
    let serverCalls = 0;
    let protectedExecutions = 0;
    const server = {
      buildPaymentRequired: () => required,
      async handlePaidRequest(
        request: { headers?: Record<string, string> },
        handler: () => Promise<unknown>,
      ) {
        serverCalls += 1;
        if (!request.headers?.["PAYMENT-SIGNATURE"]) {
          return {
            status: 402,
            headers: {
              [PAYMENT_REQUIRED_HEADER]: encodePaymentRequiredHeader(required),
            },
            body: { error: "payment required" },
          };
        }

        protectedExecutions += 1;
        await handler();
        return {
          status: 500,
          headers: {
            [PAYMENT_RESPONSE_HEADER]:
              encodePaymentResponseHeader(settlementFailure),
          },
          body: { protected: "must not leak" },
        };
      },
    };
    const client = new DirectModeClient({
      fundingProvider: exactFundingProvider(),
      store: new MemoryChannelStore(),
      signer: unusedChannelSigner(),
      addressCodec: unusedAddressCodec(),
    });

    const result = await paidMcpToolCall(
      client,
      (params) =>
        handlePaidMcpToolCall(
          server as never,
          {
            name: "download",
            resource: { url: "mcp://tool/download" },
            amount: "100",
            scheme: "exact",
          },
          params,
          async () => ({
            result: {
              content: [{ type: "text" as const, text: "protected output" }],
            },
          }),
        ),
      { name: "download", arguments: { id: "hybrid-fail" } },
    );
    const challenge = readMcpPaymentRequired(result.result);
    const settlement = readMcpPaymentResponse(result.result);
    const expectedRequestHash = mcpToolCallFingerprint({
      toolName: "download",
      arguments: { id: "hybrid-fail" },
      accepted: required.accepts[0] as ExactPaymentRequirements,
    });
    const serializedResult = JSON.stringify(result.result);

    expect(serverCalls).toBe(2);
    expect(protectedExecutions).toBe(1);
    expect(result.result.isError).toBe(true);
    expect(challenge?.error).toBe("invalid_transaction_state");
    expect(result.result.content?.[0]?.text).toBe(
      JSON.stringify(result.result.structuredContent),
    );
    expect(result.result._meta?.[MCP_PAYMENT_RESPONSE_META_KEY]).toBeTruthy();
    expect(settlement?.success).toBe(false);
    expect(result.settlement?.chargedAmount).toBe("0");
    expect(result.payment?.accepted.scheme).toBe("exact");
    expect(result.payment?.paymentPayload.payload.requestHash).toBe(
      expectedRequestHash,
    );
    expect(serializedResult).not.toContain("protected output");
    expect(serializedResult).not.toContain("must not leak");
  });
});

function makeExactRequired(): PaymentRequired {
  return {
    x402Version: X402_VERSION,
    resource: { url: "mcp://tool/download" },
    accepts: [
      {
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
          payToScriptPublicKey: "000051",
          paymentOutputIndex: 0,
        },
      },
    ],
  };
}

function exactFundingProvider(): FundingProvider {
  return {
    networkId: "kaspa:testnet-10",
    sourceKind: "hot-wallet",
    async getPublicIdentity() {
      return { address: "kaspatest:refund" };
    },
    async fundEscrowDeposit() {
      throw new Error("not used");
    },
    async payExactTransaction(request) {
      return {
        transaction: '{"transaction":"signed-kip10-exact"}',
        transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
        transactionId: "77".repeat(32),
        paymentOutputIndex: request.paymentOutputIndex ?? 0,
        payerAddress: "kaspatest:refund",
      };
    },
    async getUtxos() {
      return [];
    },
    async getVirtualDaaScore() {
      return "0";
    },
    async sendTransaction() {
      throw new Error("not used");
    },
    async estimateFees() {
      return { feeSompi: "0" };
    },
  };
}

function unusedChannelSigner(): ChannelSigner {
  return {
    async generateChannelKey() {
      throw new Error("not used");
    },
    async randomSalt() {
      throw new Error("not used");
    },
    async signVoucher() {
      throw new Error("not used");
    },
  };
}

function unusedAddressCodec(): AddressCodec {
  return {
    scriptPublicKeyForAddress() {
      return "000051";
    },
    encodeScriptAddress() {
      return "kaspatest:escrow";
    },
  };
}
