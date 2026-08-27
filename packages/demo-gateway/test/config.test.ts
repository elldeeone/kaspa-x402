import { describe, expect, it } from "vitest";
import {
  MIN_REFERENCE_ONCHAIN_OUTPUT_SOMPI,
  readGatewayConfig,
  type GatewayEnv,
} from "../src/config.js";

const BASE_ENV: GatewayEnv = {
  GATEWAY_STATE: {} as GatewayEnv["GATEWAY_STATE"],
  KASPA_X402_NETWORK: "kaspa:testnet-10",
  KASPA_X402_CHAIN_API_BASE: "https://api-tn10.kaspa.org",
  KASPA_X402_PAY_TO:
    "kaspatest:qzlws9lm7uyt0tftzffshnyeu2zcqk4kf7hw5ghk6v0zh093vnkljcy2fl0fh",
  KASPA_X402_SERVER_PUBLIC_KEY:
    "bee817fbf708b7ad2b12530bcc99e285805ab64faeea22f6d31e2bbcb164edf9",
};

describe("gateway config", () => {
  it("rejects exact offers below the reference on-chain output policy", () => {
    expect(() =>
      readGatewayConfig({
        ...BASE_ENV,
        KASPA_X402_EXACT_AMOUNT: "9999999",
        KASPA_X402_MIN_DEPOSIT_SOMPI: String(
          MIN_REFERENCE_ONCHAIN_OUTPUT_SOMPI,
        ),
      }),
    ).toThrow(
      "KASPA_X402_EXACT_AMOUNT is below reference on-chain output policy 10000000",
    );
  });

  it("rejects batch deposits below the reference on-chain output policy", () => {
    expect(() =>
      readGatewayConfig({
        ...BASE_ENV,
        KASPA_X402_EXACT_AMOUNT: String(MIN_REFERENCE_ONCHAIN_OUTPUT_SOMPI),
        KASPA_X402_MIN_DEPOSIT_SOMPI: "9999999",
      }),
    ).toThrow(
      "KASPA_X402_MIN_DEPOSIT_SOMPI is below reference on-chain output policy 10000000",
    );
  });

  it("rejects batch claim reserves below the reference on-chain output policy", () => {
    expect(() =>
      readGatewayConfig({
        ...BASE_ENV,
        KASPA_X402_CLAIM_RESERVE_SOMPI: "9999999",
      }),
    ).toThrow(
      "KASPA_X402_CLAIM_RESERVE_SOMPI is below reference on-chain output policy 10000000",
    );
  });

  it("accepts payable exact and batch deposit values", () => {
    expect(
      readGatewayConfig({
        ...BASE_ENV,
        KASPA_X402_EXACT_AMOUNT: "20000000",
        KASPA_X402_MIN_DEPOSIT_SOMPI: "20000000",
      }),
    ).toMatchObject({
      enabled: false,
      exactAmount: "20000000",
      exactProfile: "standard-native",
      batchAmount: "500",
      minDepositSompi: "20000000",
      claimReserveSompi: "10000000",
      refundTimeoutDaaDelta: "36000",
      minimumRefundLeadDaa: "1000",
    });
  });

  it("requires the batch deposit to cover one route charge plus the advertised claim reserve", () => {
    expect(() =>
      readGatewayConfig({
        ...BASE_ENV,
        KASPA_X402_EXACT_AMOUNT: String(MIN_REFERENCE_ONCHAIN_OUTPUT_SOMPI),
        KASPA_X402_BATCH_AMOUNT: "9000000",
        KASPA_X402_MIN_DEPOSIT_SOMPI: String(
          MIN_REFERENCE_ONCHAIN_OUTPUT_SOMPI,
        ),
        KASPA_X402_CLAIM_RESERVE_SOMPI: "10000000",
      }),
    ).toThrow(
      "KASPA_X402_MIN_DEPOSIT_SOMPI must cover KASPA_X402_BATCH_AMOUNT plus KASPA_X402_CLAIM_RESERVE_SOMPI",
    );
  });

  it("parses and validates the exact profile", () => {
    expect(
      readGatewayConfig({ ...BASE_ENV, KASPA_X402_EXACT_PROFILE: "additive" }),
    ).toMatchObject({ exactProfile: "additive" });
    expect(() =>
      readGatewayConfig({ ...BASE_ENV, KASPA_X402_EXACT_PROFILE: "legacy" }),
    ).toThrow("KASPA_X402_EXACT_PROFILE must be standard-native or additive");
  });

  it("requires an absolute refund timeout delta beyond the server safety lead", () => {
    expect(() =>
      readGatewayConfig({
        ...BASE_ENV,
        KASPA_X402_REFUND_TIMEOUT_DAA_DELTA: "1000",
        KASPA_X402_MINIMUM_REFUND_LEAD_DAA: "1000",
      }),
    ).toThrow(
      "KASPA_X402_REFUND_TIMEOUT_DAA_DELTA must exceed KASPA_X402_MINIMUM_REFUND_LEAD_DAA",
    );
  });

  it("parses the operator switch and canary base urls", () => {
    expect(
      readGatewayConfig({
        ...BASE_ENV,
        KASPA_X402_GATEWAY_ENABLED: "false",
        KASPA_X402_SITE_BASE_URL: "https://kaspa-x402.org/",
        KASPA_X402_GATEWAY_BASE_URL: "https://demo.kaspa-x402.org/",
      }),
    ).toMatchObject({
      enabled: false,
      siteBaseUrl: "https://kaspa-x402.org",
      gatewayBaseUrl: "https://demo.kaspa-x402.org",
      releaseVersion: "0.1.0-alpha.11",
    });
  });

  it("rejects an invalid release canary version", () => {
    expect(() =>
      readGatewayConfig({ ...BASE_ENV, KASPA_X402_RELEASE_VERSION: "latest" }),
    ).toThrow("KASPA_X402_RELEASE_VERSION must be an alpha release version");
  });

  it("rejects invalid operator switch values", () => {
    expect(() =>
      readGatewayConfig({
        ...BASE_ENV,
        KASPA_X402_GATEWAY_ENABLED: "maybe",
      }),
    ).toThrow("KASPA_X402_GATEWAY_ENABLED must be true or false");
  });

  it("parses PNN broadcast settings", () => {
    expect(
      readGatewayConfig({
        ...BASE_ENV,
        KASPA_X402_CHAIN_BROADCAST_MODE: "pnn",
        KASPA_X402_PNN_ENDPOINTS:
          "wss://vector-10.kaspa.green/kaspa/testnet-10/wrpc/json, ws://127.0.0.1:17210",
        KASPA_X402_PNN_TIMEOUT_MS: "20000",
        KASPA_X402_PNN_ATTEMPTS: "3",
      }),
    ).toMatchObject({
      chainBroadcastMode: "pnn",
      pnnEndpoints: [
        "wss://vector-10.kaspa.green/kaspa/testnet-10/wrpc/json",
        "ws://127.0.0.1:17210",
      ],
      pnnTimeoutMs: 20000,
      pnnAttempts: 3,
    });
  });

  it("requires endpoints when PNN broadcast mode is selected", () => {
    expect(() =>
      readGatewayConfig({
        ...BASE_ENV,
        KASPA_X402_CHAIN_BROADCAST_MODE: "pnn",
      }),
    ).toThrow(
      "KASPA_X402_PNN_ENDPOINTS is required when KASPA_X402_CHAIN_BROADCAST_MODE=pnn",
    );
  });

  it("rejects non-local cleartext PNN endpoints", () => {
    expect(() =>
      readGatewayConfig({
        ...BASE_ENV,
        KASPA_X402_CHAIN_BROADCAST_MODE: "pnn",
        KASPA_X402_PNN_ENDPOINTS:
          "ws://example.test/kaspa/testnet-10/wrpc/json",
      }),
    ).toThrow("KASPA_X402_PNN_ENDPOINTS must use wss except for localhost");
  });

  it("rejects credential-bearing and fragmented PNN endpoints", () => {
    for (const endpoint of [
      "wss://user:secret@pnn.example.test/wrpc/json",
      "wss://pnn.example.test/wrpc/json#secret",
    ]) {
      expect(() =>
        readGatewayConfig({
          ...BASE_ENV,
          KASPA_X402_CHAIN_BROADCAST_MODE: "pnn",
          KASPA_X402_PNN_ENDPOINTS: endpoint,
        }),
      ).toThrow("must not contain credentials or fragments");
    }
  });

  it("rejects credentials in HTTP service URLs", () => {
    expect(() =>
      readGatewayConfig({
        ...BASE_ENV,
        KASPA_X402_CHAIN_API_BASE: "https://user:secret@api.example.test",
      }),
    ).toThrow("KASPA_X402_CHAIN_API_BASE must not contain credentials");
  });
});
