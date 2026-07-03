import { describe, expect, it } from "vitest";
import { MIN_STANDARD_OUTPUT_SOMPI, readGatewayConfig, type GatewayEnv } from "../src/config.js";

const BASE_ENV: GatewayEnv = {
  GATEWAY_STATE: {} as DurableObjectNamespace,
  KASPA_X402_NETWORK: "kaspa:testnet-10",
  KASPA_X402_CHAIN_API_BASE: "https://api-tn10.kaspa.org",
  KASPA_X402_PAY_TO: "kaspatest:qzlws9lm7uyt0tftzffshnyeu2zcqk4kf7hw5ghk6v0zh093vnkljcy2fl0fh",
  KASPA_X402_SERVER_PUBLIC_KEY: "bee817fbf708b7ad2b12530bcc99e285805ab64faeea22f6d31e2bbcb164edf9",
};

describe("gateway config", () => {
  it("rejects exact offers below the Kaspa storage-mass floor", () => {
    expect(() =>
      readGatewayConfig({
        ...BASE_ENV,
        KASPA_X402_EXACT_AMOUNT: "9999999",
        KASPA_X402_MIN_DEPOSIT_SOMPI: String(MIN_STANDARD_OUTPUT_SOMPI),
      }),
    ).toThrow("KASPA_X402_EXACT_AMOUNT is below Kaspa storage-mass floor 10000000");
  });

  it("rejects batch deposits below the Kaspa storage-mass floor", () => {
    expect(() =>
      readGatewayConfig({
        ...BASE_ENV,
        KASPA_X402_EXACT_AMOUNT: String(MIN_STANDARD_OUTPUT_SOMPI),
        KASPA_X402_MIN_DEPOSIT_SOMPI: "9999999",
      }),
    ).toThrow("KASPA_X402_MIN_DEPOSIT_SOMPI is below Kaspa storage-mass floor 10000000");
  });

  it("accepts payable exact and batch deposit values", () => {
    expect(
      readGatewayConfig({
        ...BASE_ENV,
        KASPA_X402_EXACT_AMOUNT: "20000000",
        KASPA_X402_MIN_DEPOSIT_SOMPI: "20000000",
      }),
    ).toMatchObject({
      exactAmount: "20000000",
      minDepositSompi: "20000000",
    });
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
    });
  });

  it("rejects invalid operator switch values", () => {
    expect(() =>
      readGatewayConfig({
        ...BASE_ENV,
        KASPA_X402_GATEWAY_ENABLED: "maybe",
      }),
    ).toThrow("KASPA_X402_GATEWAY_ENABLED must be true or false");
  });
});
