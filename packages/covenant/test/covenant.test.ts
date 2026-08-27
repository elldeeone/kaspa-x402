import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ESCROW_TEMPLATE_ID,
  ESCROW_VOUCHER_DOMAIN,
  ESCROW_VOUCHER_DOMAIN_TAG,
  SCRIPT_INT64_MAX,
  buildClaimArgs,
  buildEscrowRedeemScript,
  buildKip10AdditiveBorrowArgs,
  buildKip10AdditiveBorrowSignatureScript,
  buildKip10AdditiveRedeemScript,
  buildRefundArgs,
  buildTopUpArgs,
  checkEscrowFixtureReproducibility,
  deriveEscrowAddress,
  escrowScriptPubKeyHash,
  escrowScriptPublicKey,
  kip10AdditiveScriptPublicKey,
  parseKip10AdditiveRedeemScript,
  serializedScriptPublicKey,
  voucherDigest,
  voucherPreimage,
} from "../src/index.js";
import type { EscrowFixture } from "../src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function fixture(): EscrowFixture {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, "contracts/fixtures/kaspa-x402-escrow-v3.json"), "utf8")) as EscrowFixture;
}

function withoutState(redeemScript: string, stateLayout: { start: number; len: number }): string {
  const bytes = Buffer.from(redeemScript, "hex");
  return Buffer.concat([bytes.subarray(0, stateLayout.start), bytes.subarray(stateLayout.start + stateLayout.len)]).toString("hex");
}

describe("stateful escrow covenant template", () => {
  it("exposes only the active escrow-v3 template", () => {
    expect(ESCROW_TEMPLATE_ID).toBe("kaspa-x402-escrow-v3");
    expect(ESCROW_VOUCHER_DOMAIN).toBe("kaspa:x402:escrow-voucher:v2");
    expect(crypto.createHash("sha256").update(ESCROW_VOUCHER_DOMAIN).digest("hex")).toBe(ESCROW_VOUCHER_DOMAIN_TAG);
  });

  it("reproduces current silverc genesis and successor bytecode", () => {
    const item = fixture();
    const source = fs.readFileSync(path.join(repoRoot, item.source));

    expect(crypto.createHash("sha256").update(source).digest("hex")).toBe(item.sourceSha256);
    expect(checkEscrowFixtureReproducibility(item, source).ok).toBe(true);
    expect(buildEscrowRedeemScript(item.sample.params)).toBe(item.sample.genesis.redeemScript);

    const successorParams = { ...item.sample.params, settledTotal: item.sample.successor.settledTotal };
    expect(buildEscrowRedeemScript(successorParams)).toBe(item.sample.successor.redeemScript);
    expect(item.sample.genesis.redeemScript).not.toBe(item.sample.successor.redeemScript);
    expect(withoutState(item.sample.genesis.redeemScript, item.stateLayout)).toBe(
      withoutState(item.sample.successor.redeemScript, item.stateLayout),
    );
  });

  it("keeps silverc transition offsets invariant across timeout values", () => {
    const item = fixture();
    const zeroTimeout = buildEscrowRedeemScript({
      ...item.sample.params,
      timeoutDaa: "0",
    });
    const runtimeTimeout = buildEscrowRedeemScript({
      ...item.sample.params,
      timeoutDaa: "123456789",
    });

    for (const instantiated of [zeroTimeout, runtimeTimeout]) {
      expect(instantiated.length / 2).toBe(item.constructorLayout.redeemScriptBytes);
      expect(withoutState(instantiated, item.stateLayout).length).toBe(withoutState(item.sample.genesis.redeemScript, item.stateLayout).length);
    }
  });

  it("treats transition-like constructor bytes as ordinary data", () => {
    const item = fixture();
    const collidingClient = `02b20302a883${"11".repeat(26)}`;
    const instantiated = buildEscrowRedeemScript({
      ...item.sample.params,
      clientPublicKey: collidingClient,
      timeoutDaa: "123456789",
    });

    expect(instantiated).toContain(`20${collidingClient}`);
    expect(instantiated.length / 2).toBe(item.constructorLayout.redeemScriptBytes);
  });

  it("derives state-specific script public keys and addresses", () => {
    const item = fixture();
    const genesis = escrowScriptPublicKey(item.sample.params);
    const successor = escrowScriptPublicKey({ ...item.sample.params, settledTotal: item.sample.successor.settledTotal });

    expect(genesis).toEqual({ version: item.sample.genesis.scriptPublicKey.version, script: item.sample.genesis.scriptPublicKey.script });
    expect(serializedScriptPublicKey(genesis)).toBe(item.sample.genesis.scriptPublicKey.serialized);
    expect(escrowScriptPubKeyHash(genesis)).toBe(item.sample.genesis.scriptPublicKey.hash);
    expect(successor.script).toBe(item.sample.successor.scriptPublicKey.script);
    expect(successor.script).not.toBe(genesis.script);

    const encode = ({ network, scriptPublicKey }: { network: string; scriptPublicKey: { script: string } }) => {
      expect(network).toBe("kaspa:testnet-10");
      expect(scriptPublicKey.script).toBe(genesis.script);
      return "kaspatest:qfixture";
    };
    expect(deriveEscrowAddress(item.sample.params, encode)).toBe("kaspatest:qfixture");
  });

  it("encodes claim, top-up, and refund ABI selectors", () => {
    const item = fixture();
    const claimInput = {
      serverSignature: "ab".repeat(65),
      voucherSignature: "cd".repeat(64),
      totalAuthorized: item.sample.voucher.totalAuthorized,
      claimAmount: item.sample.voucher.claimAmount,
    };

    expect(buildClaimArgs(claimInput)).toBe(item.sample.claimArgsWithDummies);
    expect(item.sample.claimArgsWithDummies.endsWith("0423959b42")).toBe(true);
    expect(buildTopUpArgs({ clientSignature: "ab".repeat(65) })).toBe(item.sample.topUpArgsWithDummySig);
    expect(item.sample.topUpArgsWithDummySig.endsWith("04525888a6")).toBe(true);
    expect(buildRefundArgs({ clientSignature: "ab".repeat(65) })).toBe(item.sample.refundArgsWithDummySig);
    expect(item.sample.refundArgsWithDummySig.endsWith("0417a2027b")).toBe(true);
  });

  it("rejects malformed ABI values and unsigned-64 overflow", () => {
    expect(() =>
      buildClaimArgs({
        serverSignature: "ab".repeat(64),
        voucherSignature: "cd".repeat(64),
        totalAuthorized: "1",
        claimAmount: "1",
      }),
    ).toThrow("serverSignature must be 65 bytes");
    expect(() => buildTopUpArgs({ clientSignature: "ab".repeat(64) })).toThrow("clientSignature must be 65 bytes");
    expect(() => buildRefundArgs({ clientSignature: "ab".repeat(64) })).toThrow("clientSignature must be 65 bytes");
    expect(() =>
      buildClaimArgs({
        serverSignature: "ab".repeat(65),
        voucherSignature: "cd".repeat(64),
        totalAuthorized: SCRIPT_INT64_MAX + 1n,
        claimAmount: "1",
      }),
    ).toThrow("signed 64-bit script number");
    expect(() =>
      buildClaimArgs({
        serverSignature: "ab".repeat(65),
        voucherSignature: "cd".repeat(64),
        totalAuthorized: "1",
        claimAmount: "0",
      }),
    ).toThrow("claimAmount must be positive");
  });

  it("binds vouchers to network, stable covenant ID, and cumulative ceiling", () => {
    const item = fixture();
    const input = {
      network: item.sample.params.network,
      covenantId: item.sample.covenantId,
      totalAuthorized: item.sample.voucher.totalAuthorized,
    };

    expect(voucherPreimage(input)).toBe(item.sample.voucher.preimage);
    expect(voucherDigest(input)).toBe(item.sample.voucher.digest);
    expect(voucherPreimage(input).length / 2).toBe(104);
    expect(voucherDigest({ ...input, network: "kaspa:mainnet" })).not.toBe(item.sample.voucher.digest);
    expect(voucherDigest({ ...input, covenantId: "88".repeat(32) })).not.toBe(item.sample.voucher.digest);
    expect(voucherDigest({ ...input, totalAuthorized: "5000001" })).not.toBe(item.sample.voucher.digest);
    expect(() => voucherDigest({ ...input, covenantId: "77".repeat(31) })).toThrow("covenantId must be 32 bytes");
    expect(() => voucherDigest({ ...input, covenantId: "00".repeat(32) })).toThrow("bound KIP-20 lineage");
    expect(() => voucherDigest({ ...input, totalAuthorized: SCRIPT_INT64_MAX + 1n })).toThrow("signed 64-bit script number");
    expect(() => voucherDigest({ ...input, totalAuthorized: "0" })).toThrow("totalAuthorized must be positive");
  });

  it("encodes state as fixed-width signed int64 and rejects overflow", () => {
    const item = fixture();
    const genesis = Buffer.from(item.sample.genesis.redeemScript, "hex");
    const successor = Buffer.from(item.sample.successor.redeemScript, "hex");

    expect(genesis.subarray(item.stateLayout.start, item.stateLayout.start + item.stateLayout.len).toString("hex")).toBe(
      "080000000000000000",
    );
    expect(successor.subarray(item.stateLayout.start, item.stateLayout.start + item.stateLayout.len).toString("hex")).toBe(
      "08a025260000000000",
    );
    const maxState = Buffer.from(buildEscrowRedeemScript({ ...item.sample.params, settledTotal: SCRIPT_INT64_MAX }), "hex");
    expect(maxState.subarray(item.stateLayout.start, item.stateLayout.start + item.stateLayout.len).toString("hex")).toBe(
      "08ffffffffffffff7f",
    );
    expect(() => buildEscrowRedeemScript({ ...item.sample.params, settledTotal: SCRIPT_INT64_MAX + 1n })).toThrow(
      "settledTotal must fit in signed 64-bit script number",
    );
  });

  it("keeps singleton, payout, change, and termination guards explicit", () => {
    const source = fs.readFileSync(path.join(repoRoot, "contracts/kaspa-x402-escrow-v3.sil"), "utf8");

    expect(source.match(/groups = single/g)).toHaveLength(2);
    expect(source.match(/OpCovInputCount\(covenantId\) == 1/g)).toHaveLength(3);
    expect(source.match(/OpOutputCovenantId\(0\) == ZERO_COVENANT_ID/g)).toHaveLength(2);
    expect(source).toContain("OpOutputCovenantId(1) == ZERO_COVENANT_ID");
    expect(source).toContain("sha256(tx.outputs[0].scriptPubKey) == payoutScriptPublicKeyHash");
    expect(source).toContain("sha256(tx.outputs[1].scriptPubKey) == refundScriptPublicKeyHash");
    expect(source).toContain("sha256(tx.outputs[0].scriptPubKey) == refundScriptPublicKeyHash");
    expect(source).toContain("int available = totalAuthorized - previous.settledTotal");
    expect(source).toContain("settledTotal: previous.settledTotal + claimAmount");
    expect(source).not.toContain("outpointTransactionHash");
  });
});

describe("KIP-10 additive exact template", () => {
  it("builds and parses the canonical native opcode script", () => {
    const ownerPublicKey = "11".repeat(32);
    const redeemScript = buildKip10AdditiveRedeemScript({ ownerPublicKey, amount: "100" });
    expect(redeemScript).toBe(`6320${ownerPublicKey}ac67b9bfb9c388b9c2016494b9bea268`);
    expect(buildKip10AdditiveBorrowArgs()).toBe("00");
    expect(buildKip10AdditiveBorrowSignatureScript(redeemScript)).toBe(`0032${redeemScript}`);
    expect(kip10AdditiveScriptPublicKey({ ownerPublicKey, amount: "100" }).script).toMatch(/^aa20[0-9a-f]{64}87$/);
    expect(parseKip10AdditiveRedeemScript(redeemScript)).toEqual({ ownerPublicKey, amount: "100" });
    expect(parseKip10AdditiveRedeemScript(buildKip10AdditiveRedeemScript({ ownerPublicKey, amount: SCRIPT_INT64_MAX }))).toEqual({
      ownerPublicKey,
      amount: SCRIPT_INT64_MAX.toString(),
    });
    expect(() => buildKip10AdditiveRedeemScript({ ownerPublicKey, amount: SCRIPT_INT64_MAX + 1n })).toThrow(
      "signed 64-bit script number",
    );
    expect(() => parseKip10AdditiveRedeemScript("51")).toThrow("canonical KIP-10 additive template");
  });
});
