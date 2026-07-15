#!/usr/bin/env node
import assert from "node:assert/strict";

import { encodePaymentRequiredHeader } from "@kaspa-x402/core";
import {
  assertHostedOfferPinned,
  assertHostedSettlementHeadPinned,
} from "./hosted-offer-pins.mjs";

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

const head = {
  headId: "22".repeat(32),
  version: "0",
  currentOutpoint: { txid: "33".repeat(32), index: 0 },
  currentAmount: "100000000",
  scriptPublicKey: `0000aa20${"44".repeat(32)}87`,
  redeemScript: `6320${"55".repeat(32)}ac67b9bfb9c388b9c2048096980094b9bea268`,
  additiveThresholdSompi: "10000000",
};
const additiveRequired = {
  ...required,
  accepts: [
    {
      ...required.accepts[0],
      extra: {
        ...required.accepts[0].extra,
        profile: "additive",
        templateId: "kaspa-x402-kip10-additive-v1",
        paymentOutputIndex: 0,
        payToScriptPublicKey: head.scriptPublicKey,
        headId: head.headId,
        headVersion: head.version,
        expectedHeadOutpoint: head.currentOutpoint,
        headAmount: head.currentAmount,
        headScriptPublicKey: head.scriptPublicKey,
        headRedeemScript: head.redeemScript,
        additiveThresholdSompi: head.additiveThresholdSompi,
        challengeId: "66".repeat(32),
        challengeExpiresAt: "2099-01-01T00:00:00.000Z",
      },
    },
  ],
};
const additiveExpected = { ...expected, profile: "additive", head };
assert.doesNotThrow(() =>
  assertHostedOfferPinned(
    encodePaymentRequiredHeader(additiveRequired),
    additiveExpected,
  ),
);
assert.throws(() =>
  assertHostedOfferPinned(
    encodePaymentRequiredHeader({
      ...additiveRequired,
      accepts: [
        {
          ...additiveRequired.accepts[0],
          extra: {
            ...additiveRequired.accepts[0].extra,
            headId: "77".repeat(32),
          },
        },
      ],
    }),
    additiveExpected,
  ),
);
assert.doesNotThrow(() =>
  assertHostedSettlementHeadPinned(
    {
      exactProfile: "additive",
      headId: head.headId,
      headVersion: head.version,
      headOutpoint: head.currentOutpoint,
    },
    head,
  ),
);
assert.throws(() =>
  assertHostedSettlementHeadPinned(
    {
      exactProfile: "additive",
      headId: head.headId,
      headVersion: "1",
      headOutpoint: head.currentOutpoint,
    },
    head,
  ),
);

console.log("hosted exact offer pins ok");
