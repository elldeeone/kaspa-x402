#!/usr/bin/env node
import assert from "node:assert/strict";

import { encodePaymentRequiredHeader } from "@kaspa-x402/core";
import { assertHostedOfferPinned } from "./hosted-offer-pins.mjs";

const exactUrl = "https://demo.kaspa-x402.org/exact";
const payTo =
  "kaspatest:qzlws9lm7uyt0tftzffshnyeu2zcqk4kf7hw5ghk6v0zh093vnkljcy2fl0fh";
const required = {
  x402Version: 2,
  resource: { url: exactUrl },
  accepts: [
    {
      scheme: "exact",
      network: "kaspa:testnet-10",
      amount: "20000000",
      asset: "KAS",
      payTo,
      maxTimeoutSeconds: 60,
      extra: {
        binding: "kaspa-exact-v2",
        profile: "standard-native",
        finality: "accepted",
        transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
        payToScriptPublicKey: `000020${"11".repeat(32)}`,
        assetKind: "native",
        assetDecimals: 8,
      },
    },
  ],
};
const expected = {
  exactUrl,
  gatewayOrigin: "https://demo.kaspa-x402.org",
  profile: "standard-native",
  amount: "20000000",
  payTo,
  network: "kaspa:testnet-10",
};

assert.doesNotThrow(() =>
  assertHostedOfferPinned(encodePaymentRequiredHeader(required), expected),
);
for (const mutation of [
  { amount: "20000001" },
  { payTo: `${payTo.slice(0, -1)}q` },
  { network: "kaspa:mainnet" },
  { extra: { ...required.accepts[0].extra, profile: "additive" } },
]) {
  const changed = {
    ...required,
    accepts: [{ ...required.accepts[0], ...mutation }],
  };
  assert.throws(() =>
    assertHostedOfferPinned(encodePaymentRequiredHeader(changed), expected),
  );
}

console.log("hosted exact offer pins ok");
