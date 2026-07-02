import { describe, expect, it, vi } from "vitest";

import {
  X402_VERSION,
  channelId,
  readKaspaSettlementExtension,
  sha256Hex,
  voucherDigest,
  type BatchPaymentRequirements,
  type ChannelConfig,
  type DepositVoucherPayload,
  type ExactPaymentRequirements,
  type FundingOutpoint,
  type Hash32Hex,
  type NetworkId,
  type PaymentPayload,
} from "@kaspa-x402/core";
import { deriveEscrowAddress, escrowScriptPublicKey, serializedScriptPublicKey } from "@kaspa-x402/covenant";
import {
  DirectModeServer,
  MemoryServerChannelStore,
  type AddressCodec,
  type ChainUtxo,
  type DirectModeServerConfig,
  type ServerChainProvider,
  type ServerChannelRecord,
  type SettlementFinality,
} from "@kaspa-x402/server";
import { DirectModeFacilitator, handleFacilitatorRequest } from "../src/index.js";

const SERVER_KEY = "11".repeat(32);
const CLIENT_KEY = "22".repeat(32);
const SALT = "33".repeat(32);
const FUNDING_TX = "44".repeat(32);
const EXACT_TX_ID = "77".repeat(32);
const EXACT_TX = "aa".repeat(96);
const RESOURCE = { url: "https://api.example.test/data" };
const REQUEST_HASH = "99".repeat(32);
const OTHER_REQUEST_HASH = "98".repeat(32);

describe("direct-mode facilitator", () => {
  it("returns supported x402 kinds without hardcoded signer identity", async () => {
    const { facilitator } = makeFacilitator();

    const response = await handleFacilitatorRequest(facilitator, { method: "GET", path: "/supported" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      kinds: [
        { x402Version: X402_VERSION, scheme: "exact", network: "kaspa:testnet-10" },
        { x402Version: X402_VERSION, scheme: "batch-settlement", network: "kaspa:testnet-10" },
      ],
      extensions: [],
      signers: {},
    });
  });

  it("advertises only action modes configured on the facilitator", () => {
    const { server } = makeFacilitator({
      claimBuilder: {
        async buildClaimTransaction({ claimAmount }) {
          return {
            transaction: "ab".repeat(32),
            claimAmount,
          };
        },
      },
    });
    const facilitator = new DirectModeFacilitator({ server });

    const batch = facilitator.supported().kinds.find((kind) => kind.scheme === "batch-settlement");

    expect(batch?.extra?.modes).toEqual(["verify", "settle"]);
  });

  it("does not advertise exact when the required server adapter is absent", () => {
    const { facilitator } = makeFacilitator({
      exactTransactionVerifier: undefined,
    });

    expect(facilitator.supported().kinds.map((kind) => kind.scheme)).toEqual(["batch-settlement"]);
  });

  it("rejects mainnet facilitator configs unless explicitly enabled", () => {
    expect(() => makeFacilitator({ network: "kaspa:mainnet", allowMainnet: true })).toThrow("allowMainnet");

    const { facilitator } = makeFacilitator({ network: "kaspa:mainnet", allowMainnet: true }, { allowMainnet: true });
    expect(facilitator.supported().kinds.every((kind) => kind.network === "kaspa:mainnet")).toBe(true);
  });

  it("verifies exact payments with the same payer and metadata as direct verification", async () => {
    const { server, facilitator } = makeFacilitator();
    const paymentPayload = makeExactPayment(server);
    const paymentRequirements = paymentPayload.accepted;

    const direct = await server.verifyPayment({ paymentPayload, paymentRequirements, resource: RESOURCE, requestHash: REQUEST_HASH });
    const verify = await facilitator.verify({ x402Version: X402_VERSION, paymentPayload, paymentRequirements, resource: RESOURCE, requestHash: REQUEST_HASH });

    expect(verify).toEqual({
      isValid: true,
      payer: direct.payer,
      extra: direct.extra,
    });
  });

  it("returns invalid verify responses without mutating settlement state", async () => {
    const { facilitator } = makeFacilitator();
    const paymentPayload = makeExactPayment(makeFacilitator().server);
    const paymentRequirements = { ...paymentPayload.accepted, amount: "101" } as ExactPaymentRequirements;

    const verify = await facilitator.verify({ x402Version: X402_VERSION, paymentPayload, paymentRequirements, resource: RESOURCE });

    expect(verify.isValid).toBe(false);
    expect(verify.invalidReason).toBe("invalid_payment_requirements");
  });

  it("settles exact payments through the shared direct-mode commit path", async () => {
    const { facilitator } = makeFacilitator();
    const paymentPayload = makeExactPayment(makeFacilitator().server);
    const paymentRequirements = paymentPayload.accepted;

    const settlement = await facilitator.settle({
      x402Version: X402_VERSION,
      paymentPayload,
      paymentRequirements,
      resource: RESOURCE,
      requestHash: REQUEST_HASH,
    });

    expect(settlement).toMatchObject({
      success: true,
      transaction: EXACT_TX_ID,
      network: "kaspa:testnet-10",
      amount: "100",
      payer: "kaspatest:refund",
    });
  });

  it("settles batch deposit vouchers with actual charge below the signed ceiling", async () => {
    const { facilitator, server, chain } = makeFacilitator();
    const paymentPayload = makeDepositPayment(server, chain);
    const paymentRequirements = { ...paymentPayload.accepted, amount: "70" } as BatchPaymentRequirements;

    const settlement = await facilitator.settle({
      x402Version: X402_VERSION,
      paymentPayload,
      paymentRequirements,
      resource: RESOURCE,
      requestHash: REQUEST_HASH,
    });

    expect(settlement.success).toBe(true);
    const settlementExtra = readKaspaSettlementExtension(settlement);
    expect(settlement.transaction).toBe(settlementExtra?.commitmentId);
    expect(settlement.amount).toBe("70");
    expect(settlementExtra?.chargedAmount).toBe("70");
    expect(settlementExtra?.fundingAmount).toBe("1000");
    expect(settlementExtra?.channelState).toMatchObject({
      chargedCumulativeAmount: "70",
      signedMaxClaimable: "100",
    });
  });

  it("rejects malformed facilitator requests at the HTTP adapter boundary", async () => {
    const { facilitator } = makeFacilitator();

    const response = await handleFacilitatorRequest(facilitator, { method: "POST", path: "/verify", body: { x402Version: X402_VERSION } });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ isValid: false, invalidReason: "invalid_payload" });
  });

  it("returns settlement failures for shallow but unusable settlement payloads", async () => {
    const { facilitator } = makeFacilitator();

    const response = await handleFacilitatorRequest(facilitator, {
      method: "POST",
      path: "/settle",
      body: {
        x402Version: X402_VERSION,
        paymentPayload: {},
        paymentRequirements: {
          scheme: "exact",
          network: "kaspa:testnet-10",
        },
      },
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: false,
      errorReason: "invalid_payload",
      transaction: "",
      network: "kaspa:testnet-10",
    });
  });

  it("rejects settlement modes omitted from a custom supported kind", async () => {
    const { server } = makeFacilitator();
    const paymentPayload = makeExactPayment(server);
    const facilitator = new DirectModeFacilitator({
      server,
      supportedKinds: [
        {
          x402Version: X402_VERSION,
          scheme: "exact",
          network: "kaspa:testnet-10",
          extra: {
            binding: "kaspa-exact-v1",
            modes: ["verify"],
          },
        },
      ],
    });

    const settlement = await facilitator.settle({
      x402Version: X402_VERSION,
      paymentPayload,
      paymentRequirements: paymentPayload.accepted,
      resource: RESOURCE,
    });

    expect(settlement).toMatchObject({
      success: false,
      errorReason: "unsupported_scheme",
      transaction: "",
    });
  });

  it("rejects execution when a custom supported kind omits modes", async () => {
    const { server } = makeFacilitator();
    const paymentPayload = makeExactPayment(server);
    const facilitator = new DirectModeFacilitator({
      server,
      supportedKinds: [
        {
          x402Version: X402_VERSION,
          scheme: "exact",
          network: "kaspa:testnet-10",
          extra: {
            binding: "kaspa-exact-v1",
          },
        },
      ],
    });

    const verification = await facilitator.verify({
      x402Version: X402_VERSION,
      paymentPayload,
      paymentRequirements: paymentPayload.accepted,
      resource: RESOURCE,
    });
    const settlement = await facilitator.settle({
      x402Version: X402_VERSION,
      paymentPayload,
      paymentRequirements: paymentPayload.accepted,
      resource: RESOURCE,
    });

    expect(facilitator.supported().kinds).toEqual([]);
    expect(verification).toEqual({ isValid: false, invalidReason: "unsupported_scheme" });
    expect(settlement).toMatchObject({
      success: false,
      errorReason: "unsupported_scheme",
      transaction: "",
    });
  });

  it("does not advertise custom supported kinds with invalid modes", () => {
    const { server } = makeFacilitator();
    const facilitator = new DirectModeFacilitator({
      server,
      supportedKinds: [
        {
          x402Version: X402_VERSION,
          scheme: "exact",
          network: "kaspa:testnet-10",
          extra: {
            binding: "kaspa-exact-v1",
            modes: ["verify", "withdraw"],
          },
        },
      ],
    });

    expect(facilitator.supported().kinds).toEqual([]);
  });

  it("does not let custom supported kinds expand direct server capabilities", () => {
    const { server } = makeFacilitator({
      exactTransactionVerifier: undefined,
    });
    const facilitator = new DirectModeFacilitator({
      server,
      supportedKinds: [
        {
          x402Version: X402_VERSION,
          scheme: "exact",
          network: "kaspa:testnet-10",
          extra: {
            binding: "kaspa-exact-v1",
            modes: ["verify", "settle"],
          },
        },
        {
          x402Version: X402_VERSION,
          scheme: "batch-settlement",
          network: "kaspa:testnet-10",
          extra: {
            binding: "kaspa-escrow-v1",
            modes: ["verify", "settle"],
          },
        },
      ],
    });

    expect(facilitator.supported().kinds.map((kind) => kind.scheme)).toEqual(["batch-settlement"]);
  });

  it("does not advertise action modes on non-batch custom supported kinds", () => {
    const { server } = makeFacilitator();
    const facilitator = new DirectModeFacilitator({
      server,
      supportedKinds: [
        {
          x402Version: X402_VERSION,
          scheme: "exact",
          network: "kaspa:testnet-10",
          extra: {
            binding: "kaspa-exact-v1",
            modes: ["verify", "claim", "refund"],
          },
        },
      ],
      claimSettler: vi.fn(),
      refundSettler: vi.fn(),
    });

    expect(facilitator.supported().kinds[0]?.extra?.modes).toEqual(["verify"]);
  });

  it("uses wrapped server metadata for custom supported kinds", () => {
    const { facilitator } = makeFacilitator();
    const canonical = facilitator.supported().kinds.find((kind) => kind.scheme === "exact");
    const custom = new DirectModeFacilitator({
      server: makeFacilitator().server,
      supportedKinds: [
        {
          x402Version: X402_VERSION,
          scheme: "exact",
          network: "kaspa:testnet-10",
          extra: {
            asset: "BAD",
            binding: "wrong-binding",
            modes: ["verify"],
          },
        },
      ],
    });

    const exact = custom.supported().kinds[0];

    expect(exact).toEqual({
      ...canonical,
      extra: {
        ...canonical?.extra,
        modes: ["verify"],
      },
    });
  });

  it("validates action payloads before invoking claim or refund settlers", async () => {
    const { server, chain } = makeFacilitator();
    const deposit = makeDepositPayment(server, chain);
    const claimSettler = vi.fn();
    const refundSettler = vi.fn();
    const facilitator = new DirectModeFacilitator({
      server,
      supportedKinds: [
        {
          x402Version: X402_VERSION,
          scheme: "batch-settlement",
          network: "kaspa:testnet-10",
          extra: {
            binding: "kaspa-escrow-v1",
            modes: ["claim", "refund"],
          },
        },
      ],
      claimSettler,
      refundSettler,
    });

    for (const type of ["claim", "refund"] as const) {
      const settlement = await facilitator.settle({
        x402Version: X402_VERSION,
        paymentPayload: {
          x402Version: X402_VERSION,
          accepted: deposit.accepted,
          payload: { type },
        } as PaymentPayload,
        paymentRequirements: deposit.accepted,
        resource: RESOURCE,
      });

      expect(settlement).toMatchObject({
        success: false,
        errorReason: "invalid_payload",
        transaction: "",
      });
    }
    expect(claimSettler).not.toHaveBeenCalled();
    expect(refundSettler).not.toHaveBeenCalled();
  });

  it("validates optional action resources before invoking action settlers", async () => {
    const { server, chain } = makeFacilitator();
    const deposit = makeDepositPayment(server, chain);
    const depositPayload = deposit.payload as DepositVoucherPayload;
    const claimSettler = vi.fn();
    const facilitator = new DirectModeFacilitator({
      server,
      supportedKinds: [
        {
          x402Version: X402_VERSION,
          scheme: "batch-settlement",
          network: "kaspa:testnet-10",
          extra: {
            binding: "kaspa-escrow-v1",
            modes: ["claim"],
          },
        },
      ],
      claimSettler,
    });

    const settlement = await facilitator.settle({
      x402Version: X402_VERSION,
      paymentPayload: {
        x402Version: X402_VERSION,
        accepted: deposit.accepted,
        payload: {
          type: "claim",
          channelId: depositPayload.channelId,
          fundingOutpoint: depositPayload.fundingOutpoint,
          activeScriptPublicKey: depositPayload.activeScriptPublicKey,
          claimAmount: depositPayload.voucher.amount,
          voucher: depositPayload.voucher,
        },
      } as PaymentPayload,
      paymentRequirements: deposit.accepted,
      resource: {} as never,
    });

    expect(settlement).toMatchObject({
      success: false,
      errorReason: "invalid_payload",
      transaction: "",
    });
    expect(claimSettler).not.toHaveBeenCalled();
  });

  it("validates action accepted requirements before invoking action settlers", async () => {
    const { server, chain } = makeFacilitator();
    const deposit = makeDepositPayment(server, chain);
    const claimSettler = vi.fn();
    const facilitator = new DirectModeFacilitator({
      server,
      supportedKinds: [
        {
          x402Version: X402_VERSION,
          scheme: "batch-settlement",
          network: "kaspa:testnet-10",
          extra: {
            binding: "kaspa-escrow-v1",
            modes: ["claim"],
          },
        },
      ],
      claimSettler,
    });
    const depositPayload = deposit.payload as DepositVoucherPayload;
    const claimPayload = {
      x402Version: X402_VERSION,
      accepted: deposit.accepted,
      payload: {
        type: "claim",
        channelId: depositPayload.channelId,
        fundingOutpoint: depositPayload.fundingOutpoint,
        activeScriptPublicKey: depositPayload.activeScriptPublicKey,
        claimAmount: depositPayload.voucher.amount,
        voucher: depositPayload.voucher,
      },
    } as PaymentPayload;

    const settlement = await facilitator.settle({
      x402Version: X402_VERSION,
      paymentPayload: claimPayload,
      paymentRequirements: { ...deposit.accepted, amount: "101" },
      resource: RESOURCE,
    });

    expect(settlement).toMatchObject({
      success: false,
      errorReason: "invalid_payment_requirements",
      transaction: "",
    });
    expect(claimSettler).not.toHaveBeenCalled();
  });

  it("validates refund accepted requirements before invoking refund settlers", async () => {
    const { server, chain } = makeFacilitator();
    const deposit = makeDepositPayment(server, chain);
    const depositPayload = deposit.payload as DepositVoucherPayload;
    const refundSettler = vi.fn();
    const facilitator = new DirectModeFacilitator({
      server,
      supportedKinds: [
        {
          x402Version: X402_VERSION,
          scheme: "batch-settlement",
          network: "kaspa:testnet-10",
          extra: {
            binding: "kaspa-escrow-v1",
            modes: ["refund"],
          },
        },
      ],
      refundSettler,
    });

    const settlement = await facilitator.settle({
      x402Version: X402_VERSION,
      paymentPayload: {
        x402Version: X402_VERSION,
        accepted: deposit.accepted,
        payload: {
          type: "refund",
          channelId: depositPayload.channelId,
          fundingOutpoint: depositPayload.fundingOutpoint,
          activeScriptPublicKey: depositPayload.activeScriptPublicKey,
          refundAddress: depositPayload.channelConfig.refundAddress,
          refundAmount: depositPayload.voucher.amount,
          clientSignature: "12".repeat(65),
        },
      } as PaymentPayload,
      paymentRequirements: { ...deposit.accepted, amount: "101" },
      resource: RESOURCE,
    });

    expect(settlement).toMatchObject({
      success: false,
      errorReason: "invalid_payment_requirements",
      transaction: "",
    });
    expect(refundSettler).not.toHaveBeenCalled();
  });

  it("reports exact replay during verify after settlement", async () => {
    const { facilitator, server } = makeFacilitator();
    const paymentPayload = makeExactPayment(server);
    delete paymentPayload.payload.requestHash;

    const settlement = await facilitator.settle({
      x402Version: X402_VERSION,
      paymentPayload,
      paymentRequirements: paymentPayload.accepted,
      resource: RESOURCE,
      requestHash: REQUEST_HASH,
    });
    const replay = await facilitator.verify({
      x402Version: X402_VERSION,
      paymentPayload,
      paymentRequirements: paymentPayload.accepted,
      resource: RESOURCE,
      requestHash: OTHER_REQUEST_HASH,
    });

    expect(settlement.success).toBe(true);
    expect(replay).toEqual({ isValid: false, invalidReason: "invalid_transaction_state" });
  });

  it("checks exact replay before invoking the exact verifier when transaction id is present", async () => {
    const initial = makeFacilitator();
    const paymentPayload = makeExactPayment(initial.server);
    const settlement = await initial.facilitator.settle({
      x402Version: X402_VERSION,
      paymentPayload,
      paymentRequirements: paymentPayload.accepted,
      resource: RESOURCE,
      requestHash: REQUEST_HASH,
    });
    const verifier = vi.fn(() => {
      throw new Error("verifier should not be called");
    });
    const replaySetup = makeFacilitator({
      store: initial.store,
      exactTransactionVerifier: {
        verifyExactPayment: verifier,
      },
    });

    const replay = await replaySetup.facilitator.verify({
      x402Version: X402_VERSION,
      paymentPayload,
      paymentRequirements: paymentPayload.accepted,
      resource: RESOURCE,
      requestHash: OTHER_REQUEST_HASH,
    });

    expect(settlement.success).toBe(true);
    expect(replay).toEqual({ isValid: false, invalidReason: "invalid_transaction_state" });
    expect(verifier).not.toHaveBeenCalled();
  });

  it("rejects malformed top-level request hashes at the HTTP adapter boundary", async () => {
    const { facilitator, server } = makeFacilitator();
    const paymentPayload = makeExactPayment(server);

    const response = await handleFacilitatorRequest(facilitator, {
      method: "POST",
      path: "/verify",
      body: {
        x402Version: X402_VERSION,
        paymentPayload,
        paymentRequirements: paymentPayload.accepted,
        requestHash: "not-a-hash",
      },
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ isValid: false, invalidReason: "invalid_payload" });
  });

  it("returns settlement failures for unsupported networks", async () => {
    const { facilitator, server } = makeFacilitator();
    const paymentPayload = makeExactPayment(server);
    const paymentRequirements = {
      ...paymentPayload.accepted,
      network: "kaspa:testnet-12",
    } as unknown as ExactPaymentRequirements;

    const response = await handleFacilitatorRequest(facilitator, {
      method: "POST",
      path: "/settle",
      body: { x402Version: X402_VERSION, paymentPayload: { ...paymentPayload, accepted: paymentRequirements }, paymentRequirements },
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: false,
      errorReason: "invalid_network",
      transaction: "",
    });
    expect(response.body).not.toHaveProperty("network");
  });

  it("does not coerce malformed facilitator settlement networks to testnet", async () => {
    const { facilitator, server } = makeFacilitator();
    const paymentPayload = makeExactPayment(server);
    const paymentRequirements = {
      ...paymentPayload.accepted,
      network: "testnet-10",
    } as unknown as ExactPaymentRequirements;

    const response = await handleFacilitatorRequest(facilitator, {
      method: "POST",
      path: "/settle",
      body: { x402Version: X402_VERSION, paymentPayload: { ...paymentPayload, accepted: paymentRequirements }, paymentRequirements },
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: false,
      errorReason: "invalid_network",
      transaction: "",
    });
    expect(response.body).not.toHaveProperty("network");
  });

  it("preserves safe mainnet network labels in facilitator settlement failures", async () => {
    const { facilitator, server } = makeFacilitator();
    const paymentPayload = makeExactPayment(server);
    const paymentRequirements = {
      ...paymentPayload.accepted,
      network: "kaspa:mainnet",
    } as ExactPaymentRequirements;

    const response = await handleFacilitatorRequest(facilitator, {
      method: "POST",
      path: "/settle",
      body: { x402Version: X402_VERSION, paymentPayload: { ...paymentPayload, accepted: paymentRequirements }, paymentRequirements },
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: false,
      errorReason: "invalid_network",
      transaction: "",
      network: "kaspa:mainnet",
    });
  });
});

function makeFacilitator(overrides: Partial<DirectModeServerConfig> = {}, facilitatorOptions: { allowMainnet?: boolean } = {}) {
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
  (server as unknown as { __testChain?: FakeChainProvider }).__testChain = chain;
  return {
    server,
    facilitator: new DirectModeFacilitator({ server, allowMainnet: facilitatorOptions.allowMainnet }),
    chain,
    store,
  };
}

function makeExactPayment(server: DirectModeServer): PaymentPayload {
  const required = server.buildPaymentRequired({ resource: RESOURCE, scheme: "exact" });
  const accepted = required.accepts[0] as ExactPaymentRequirements;
  return {
    x402Version: X402_VERSION,
    accepted,
    payload: {
      type: "exact-transfer",
      payerAddress: "kaspatest:refund",
      transaction: EXACT_TX,
      transactionId: EXACT_TX_ID,
      paymentOutputIndex: 1,
      requestHash: REQUEST_HASH,
    },
  };
}

function makeDepositPayment(server: DirectModeServer, chain: FakeChainProvider): PaymentPayload {
  const required = server.buildPaymentRequired({ resource: RESOURCE, scheme: "batch-settlement" });
  const accepted = required.accepts[0] as BatchPaymentRequirements;
  const channelConfig: ChannelConfig = {
    network: accepted.network,
    asset: "KAS",
    templateId: "kaspa-x402-escrow-v1",
    clientPublicKey: CLIENT_KEY,
    serverPublicKey: SERVER_KEY,
    payTo: accepted.payTo,
    refundAddress: "kaspatest:refund",
    refundTimeoutDaa: accepted.extra.refundTimeoutDaa,
    salt: SALT,
  };
  const derived = deriveEscrow(channelConfig);
  const fundingOutpoint = { txid: FUNDING_TX, index: 0 };
  chain.setUtxo({
    outpoint: fundingOutpoint,
    amount: accepted.extra.minDepositSompi,
    scriptPublicKey: derived.activeScriptPublicKey,
    finality: "accepted",
  });
  return {
    x402Version: X402_VERSION,
    accepted,
    payload: {
      type: "deposit-voucher",
      channelConfig,
      channelId: channelId(channelConfig),
      escrowAddress: derived.escrowAddress,
      fundingOutpoint,
      fundingAmountSompi: accepted.extra.minDepositSompi,
      activeScriptPublicKey: derived.activeScriptPublicKey,
      voucher: signVoucher({
        network: accepted.network,
        activeScriptPublicKey: derived.activeScriptPublicKey,
        outpoint: fundingOutpoint,
        amount: accepted.amount,
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

function signVoucher(input: { network: NetworkId; activeScriptPublicKey: string; outpoint: FundingOutpoint; amount: string }) {
  const digest = voucherDigest(input);
  return {
    amount: input.amount,
    signature: `${digest}${digest}`,
  };
}

class FakeAddressCodec implements AddressCodec {
  scriptPublicKeyForAddress(address: string, _network?: NetworkId): string {
    return `0000${sha256Hex(address)}`;
  }

  encodeScriptAddress(input: { serializedScriptPublicKey: string }): string {
    return `kaspatest:${sha256Hex(input.serializedScriptPublicKey).slice(0, 32)}`;
  }
}

class FakeChainProvider implements ServerChainProvider {
  readonly utxos = new Map<string, ChainUtxo>();
  daa = "1000";

  setUtxo(utxo: ChainUtxo): void {
    this.utxos.set(outpointKey(utxo.outpoint), structuredClone(utxo));
  }

  async getUtxo(outpoint: FundingOutpoint, _network: NetworkId) {
    return this.utxos.get(outpointKey(outpoint)) ?? null;
  }

  async getVirtualDaaScore() {
    return this.daa;
  }

  async estimateClaimFee(_channel: ServerChannelRecord) {
    return "10";
  }

  async sendTransaction(_transaction: string): Promise<{ transactionId: Hash32Hex; finality: SettlementFinality }> {
    return { transactionId: EXACT_TX_ID, finality: "accepted" };
  }
}

function outpointKey(outpoint: FundingOutpoint): string {
  return `${outpoint.txid.toLowerCase()}:${outpoint.index}`;
}

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}
