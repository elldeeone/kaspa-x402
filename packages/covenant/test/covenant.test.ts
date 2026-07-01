import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ESCROW_VOUCHER_DOMAIN,
  ESCROW_VOUCHER_DOMAIN_TAG,
  buildClaimArgs,
  buildEscrowRedeemScript,
  buildRefundArgs,
  deriveEscrowAddress,
  escrowScriptPubKeyHash,
  escrowScriptPublicKey,
  serializedScriptPublicKey,
  validateClaimOutputPlan,
  validateRefundOutputPlan,
  voucherDigest,
  voucherPreimage,
} from "../src/index.js";
import type { EscrowTemplateParams } from "../src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

type Fixture = {
  templateId: string;
  source: string;
  sourceSha256: string;
  domainTag: string;
  domainTagHash: string;
  sample: {
    params: EscrowTemplateParams;
    redeemScript: string;
    scriptPublicKey: {
      version: number;
      script: string;
      serialized: string;
      hash: string;
    };
    payoutScriptPublicKey: {
      serialized: string;
      hash: string;
    };
    refundScriptPublicKey: {
      serialized: string;
      hash: string;
    };
    claimArgsWithDummies: string;
    refundArgsWithDummySig: string;
    voucher: {
      outpoint: {
        txid: string;
        index: number;
      };
      amount: string;
      preimage: string;
      digest: string;
    };
  };
};

function fixture(): Fixture {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, "contracts/fixtures/kaspa-x402-escrow-v1.json"), "utf8")) as Fixture;
}

describe("escrow covenant template", () => {
  it("keeps fixture source and domain hashes reproducible", () => {
    const item = fixture();
    const source = fs.readFileSync(path.join(repoRoot, item.source));
    expect(crypto.createHash("sha256").update(source).digest("hex")).toBe(item.sourceSha256);
    expect(crypto.createHash("sha256").update(ESCROW_VOUCHER_DOMAIN).digest("hex")).toBe(ESCROW_VOUCHER_DOMAIN_TAG);
    expect(item.domainTag).toBe(ESCROW_VOUCHER_DOMAIN);
    expect(item.domainTagHash).toBe(ESCROW_VOUCHER_DOMAIN_TAG);
  });

  it("builds the fixture redeem script deterministically", () => {
    const item = fixture();
    expect(buildEscrowRedeemScript(item.sample.params)).toBe(item.sample.redeemScript);
  });

  it("derives the standard script public key and serialized hash", () => {
    const item = fixture();
    const spk = escrowScriptPublicKey(item.sample.params);
    expect(spk).toEqual({
      version: item.sample.scriptPublicKey.version,
      script: item.sample.scriptPublicKey.script,
    });
    expect(serializedScriptPublicKey(spk)).toBe(item.sample.scriptPublicKey.serialized);
    expect(escrowScriptPubKeyHash(spk)).toBe(item.sample.scriptPublicKey.hash);
  });

  it("derives addresses through an explicit Kaspa address codec", () => {
    const item = fixture();
    const address = deriveEscrowAddress(item.sample.params, ({ network, scriptPublicKey }) => {
      expect(network).toBe("kaspa:testnet-10");
      expect(scriptPublicKey.script).toBe(item.sample.scriptPublicKey.script);
      return "kaspatest:qfixture";
    });
    expect(address).toBe("kaspatest:qfixture");
  });

  it("builds claim and refund argument blobs", () => {
    const item = fixture();
    expect(
      buildClaimArgs({
        serverSignature: "ab".repeat(65),
        voucherSignature: "cd".repeat(64),
        amount: "17216961135462248174",
      }),
    ).toBe(item.sample.claimArgsWithDummies);
    expect(buildRefundArgs({ clientSignature: "ab".repeat(65) })).toBe(item.sample.refundArgsWithDummySig);
  });

  it("rejects malformed argument lengths", () => {
    expect(() =>
      buildClaimArgs({
        serverSignature: "ab".repeat(64),
        voucherSignature: "cd".repeat(64),
        amount: "1",
      }),
    ).toThrow("serverSignature must be 65 bytes");
    expect(() => buildRefundArgs({ clientSignature: "ab".repeat(64) })).toThrow("clientSignature must be 65 bytes");
  });

  it("computes voucher preimages bound to network, script, and full outpoint", () => {
    const item = fixture();
    const input = {
      network: item.sample.params.network,
      activeScriptPublicKey: item.sample.scriptPublicKey.serialized,
      outpoint: item.sample.voucher.outpoint,
      amount: item.sample.voucher.amount,
    };

    expect(voucherPreimage(input)).toBe(item.sample.voucher.preimage);
    expect(voucherDigest(input)).toBe(item.sample.voucher.digest);
    expect(voucherPreimage(input).length / 2).toBe(140);
    expect(voucherDigest({ ...input, outpoint: { ...input.outpoint, index: 1 } })).not.toBe(item.sample.voucher.digest);
    expect(voucherDigest({ ...input, network: "kaspa:mainnet" })).not.toBe(item.sample.voucher.digest);
    expect(voucherDigest({ ...input, activeScriptPublicKey: `0000${"00".repeat(35)}` })).not.toBe(item.sample.voucher.digest);
    expect(() => voucherDigest({ ...input, activeScriptPublicKey: input.activeScriptPublicKey.slice(4) })).toThrow(
      "activeScriptPublicKey version must be 0",
    );
  });

  it("validates offline claim output invariants", () => {
    const item = fixture();
    const script = item.sample.scriptPublicKey.serialized;
    const payout = item.sample.payoutScriptPublicKey.serialized;
    const payoutHash = item.sample.payoutScriptPublicKey.hash;
    expect(
      validateClaimOutputPlan({
        inputAmount: "1000",
        voucherAmount: "250",
        serverOutputAmount: "200",
        serverOutputScriptPublicKey: payout,
        expectedPayoutScriptPublicKeyHash: payoutHash,
        continuationOutputAmount: "750",
        continuationScriptPublicKey: script,
        expectedContinuationScriptPublicKey: script,
      }),
    ).toBe(true);
    expect(() =>
      validateClaimOutputPlan({
        inputAmount: "1000",
        voucherAmount: "1001",
        serverOutputAmount: "200",
        serverOutputScriptPublicKey: payout,
        expectedPayoutScriptPublicKeyHash: payoutHash,
        continuationOutputAmount: "800",
        continuationScriptPublicKey: script,
        expectedContinuationScriptPublicKey: script,
      }),
    ).toThrow("voucher amount cannot exceed input amount");
    expect(() =>
      validateClaimOutputPlan({
        inputAmount: "1000",
        voucherAmount: "250",
        serverOutputAmount: "251",
        serverOutputScriptPublicKey: payout,
        expectedPayoutScriptPublicKeyHash: payoutHash,
        continuationOutputAmount: "749",
        continuationScriptPublicKey: script,
        expectedContinuationScriptPublicKey: script,
      }),
    ).toThrow("server output cannot exceed voucher amount");
    expect(() =>
      validateClaimOutputPlan({
        inputAmount: "1000",
        voucherAmount: "250",
        serverOutputAmount: "200",
        serverOutputScriptPublicKey: `0000${"00".repeat(35)}`,
        expectedPayoutScriptPublicKeyHash: payoutHash,
        continuationOutputAmount: "750",
        continuationScriptPublicKey: script,
        expectedContinuationScriptPublicKey: script,
      }),
    ).toThrow("server output script public key must match");
    expect(() =>
      validateClaimOutputPlan({
        inputAmount: "1000",
        voucherAmount: "250",
        serverOutputAmount: "200",
        serverOutputScriptPublicKey: payout,
        expectedPayoutScriptPublicKeyHash: payoutHash,
        continuationOutputAmount: "750",
        continuationScriptPublicKey: `0000${"00".repeat(35)}`,
        expectedContinuationScriptPublicKey: script,
      }),
    ).toThrow("continuation script public key must match");
  });

  it("validates offline refund output invariants", () => {
    const item = fixture();
    expect(
      validateRefundOutputPlan({
        inputSequence: "0",
        refundOutputScriptPublicKey: item.sample.refundScriptPublicKey.serialized,
        expectedRefundScriptPublicKeyHash: item.sample.refundScriptPublicKey.hash,
      }),
    ).toBe(true);
    expect(() =>
      validateRefundOutputPlan({
        inputSequence: "0",
        refundOutputScriptPublicKey: `0000${"00".repeat(35)}`,
        expectedRefundScriptPublicKeyHash: item.sample.refundScriptPublicKey.hash,
      }),
    ).toThrow("refund output script public key must match");
    expect(() =>
      validateRefundOutputPlan({
        inputSequence: "1",
        refundOutputScriptPublicKey: item.sample.refundScriptPublicKey.serialized,
        expectedRefundScriptPublicKeyHash: item.sample.refundScriptPublicKey.hash,
      }),
    ).toThrow("refund input sequence must be 0");
  });
});
