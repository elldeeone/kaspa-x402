import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CLAIM_COMPUTE_BUDGET,
  CLAIM_SCRIPT_UNITS_ESTIMATE,
  ESCROW_VOUCHER_DOMAIN,
  ESCROW_VOUCHER_DOMAIN_TAG,
  REFUND_COMPUTE_BUDGET,
  REFUND_SCRIPT_UNITS_ESTIMATE,
  UPTO_AUTHORIZATION_DOMAIN,
  UPTO_AUTHORIZATION_DOMAIN_TAG,
  UPTO_REFUND_COMPUTE_BUDGET,
  UPTO_REFUND_SCRIPT_UNITS_ESTIMATE,
  UPTO_SETTLE_COMPUTE_BUDGET,
  UPTO_SETTLE_SCRIPT_UNITS_ESTIMATE,
  buildBatchClaimTxV1Artifact,
  buildBatchRefundTxV1Artifact,
  buildClaimArgs,
  buildEscrowRedeemScript,
  buildRefundArgs,
  buildUptoRedeemScript,
  buildUptoRefundArgs,
  buildUptoSettleArgs,
  checkEscrowFixtureReproducibility,
  checkUptoFixtureReproducibility,
  computeBudgetForScriptUnits,
  deriveEscrowAddress,
  deriveUptoAddress,
  escrowScriptPubKeyHash,
  escrowScriptPublicKey,
  scriptUnitAllowance,
  serializedScriptPublicKey,
  uptoAuthorizationDigest,
  uptoAuthorizationPreimage,
  uptoScriptPubKeyHash,
  uptoScriptPublicKey,
  validateClaimOutputPlan,
  validateRefundOutputPlan,
  validateUptoRefundOutputPlan,
  validateUptoSettlementOutputPlan,
  vectorBackedBatchTransactionBuilder,
  voucherDigest,
  voucherPreimage,
} from "../src/index.js";
import type {
  BatchClaimTxV1Artifact,
  BatchClaimTxV1Input,
  BatchRefundTxV1Artifact,
  BatchRefundTxV1Input,
  EscrowTemplateParams,
  UptoTemplateParams,
} from "../src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

type Fixture = {
  templateId: string;
  source: string;
  sourceSha256: string;
  domainTag: string;
  domainTagHash: string;
  compiler: {
    checkedCommit: string;
  };
  computeBudget: {
    claim: number;
    refund: number;
  };
  scriptUnitsEstimate: {
    claim: number;
    refund: number;
  };
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

type UptoFixture = {
  templateId: string;
  source: string;
  sourceSha256: string;
  domainTag: string;
  domainTagHash: string;
  compiler: {
    checkedCommit: string;
  };
  computeBudget: {
    settle: number;
    refund: number;
  };
  scriptUnitsEstimate: {
    settle: number;
    refund: number;
  };
  sample: {
    params: UptoTemplateParams;
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
    settleArgsWithDummies: string;
    refundArgsWithDummySig: string;
    authorization: {
      outpoint: {
        txid: string;
        index: number;
      };
      preimage: string;
      digest: string;
    };
  };
};

function fixture(): Fixture {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, "contracts/fixtures/kaspa-x402-escrow-v1.json"), "utf8")) as Fixture;
}

function uptoFixture(): UptoFixture {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, "contracts/fixtures/kaspa-x402-upto-v1.json"), "utf8")) as UptoFixture;
}

function vector<TInput, TExpected>(relativePath: string): { input: TInput; expected: TExpected } {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8")) as { input: TInput; expected: TExpected };
}

describe("escrow covenant template", () => {
  it("keeps fixture source and domain hashes reproducible", () => {
    const item = fixture();
    const source = fs.readFileSync(path.join(repoRoot, item.source));
    expect(crypto.createHash("sha256").update(source).digest("hex")).toBe(item.sourceSha256);
    expect(crypto.createHash("sha256").update(ESCROW_VOUCHER_DOMAIN).digest("hex")).toBe(ESCROW_VOUCHER_DOMAIN_TAG);
    expect(item.domainTag).toBe(ESCROW_VOUCHER_DOMAIN);
    expect(item.domainTagHash).toBe(ESCROW_VOUCHER_DOMAIN_TAG);
    expect(checkEscrowFixtureReproducibility(item, source).ok).toBe(true);
  });

  it("keeps Toccata compute budgets aligned with script-unit estimates", () => {
    const item = fixture();
    expect(computeBudgetForScriptUnits(CLAIM_SCRIPT_UNITS_ESTIMATE)).toBe(20);
    expect(computeBudgetForScriptUnits(REFUND_SCRIPT_UNITS_ESTIMATE)).toBe(10);
    expect(CLAIM_COMPUTE_BUDGET).toBe(20);
    expect(REFUND_COMPUTE_BUDGET).toBe(10);
    expect(scriptUnitAllowance(CLAIM_COMPUTE_BUDGET)).toBeGreaterThanOrEqual(CLAIM_SCRIPT_UNITS_ESTIMATE);
    expect(scriptUnitAllowance(REFUND_COMPUTE_BUDGET)).toBeGreaterThanOrEqual(REFUND_SCRIPT_UNITS_ESTIMATE);
    expect(item.computeBudget).toEqual({ claim: CLAIM_COMPUTE_BUDGET, refund: REFUND_COMPUTE_BUDGET });
    expect(item.scriptUnitsEstimate).toEqual({ claim: CLAIM_SCRIPT_UNITS_ESTIMATE, refund: REFUND_SCRIPT_UNITS_ESTIMATE });
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

  it("keeps upto fixture source and authorization domain hashes reproducible", () => {
    const item = uptoFixture();
    const source = fs.readFileSync(path.join(repoRoot, item.source));
    expect(crypto.createHash("sha256").update(source).digest("hex")).toBe(item.sourceSha256);
    expect(crypto.createHash("sha256").update(UPTO_AUTHORIZATION_DOMAIN).digest("hex")).toBe(UPTO_AUTHORIZATION_DOMAIN_TAG);
    expect(item.domainTag).toBe(UPTO_AUTHORIZATION_DOMAIN);
    expect(item.domainTagHash).toBe(UPTO_AUTHORIZATION_DOMAIN_TAG);
    expect(checkUptoFixtureReproducibility(item, source).ok).toBe(true);
  });

  it("keeps upto compute budgets aligned with script-unit estimates", () => {
    const item = uptoFixture();
    expect(computeBudgetForScriptUnits(UPTO_SETTLE_SCRIPT_UNITS_ESTIMATE)).toBe(26);
    expect(computeBudgetForScriptUnits(UPTO_REFUND_SCRIPT_UNITS_ESTIMATE)).toBe(10);
    expect(UPTO_SETTLE_COMPUTE_BUDGET).toBe(26);
    expect(UPTO_REFUND_COMPUTE_BUDGET).toBe(10);
    expect(scriptUnitAllowance(UPTO_SETTLE_COMPUTE_BUDGET)).toBeGreaterThanOrEqual(UPTO_SETTLE_SCRIPT_UNITS_ESTIMATE);
    expect(scriptUnitAllowance(UPTO_REFUND_COMPUTE_BUDGET)).toBeGreaterThanOrEqual(UPTO_REFUND_SCRIPT_UNITS_ESTIMATE);
    expect(item.computeBudget).toEqual({ settle: UPTO_SETTLE_COMPUTE_BUDGET, refund: UPTO_REFUND_COMPUTE_BUDGET });
    expect(item.scriptUnitsEstimate).toEqual({ settle: UPTO_SETTLE_SCRIPT_UNITS_ESTIMATE, refund: UPTO_REFUND_SCRIPT_UNITS_ESTIMATE });
  });

  it("builds the upto redeem script and address deterministically", () => {
    const item = uptoFixture();
    expect(buildUptoRedeemScript(item.sample.params)).toBe(item.sample.redeemScript);
    const spk = uptoScriptPublicKey(item.sample.params);
    expect(spk).toEqual({
      version: item.sample.scriptPublicKey.version,
      script: item.sample.scriptPublicKey.script,
    });
    expect(serializedScriptPublicKey(spk)).toBe(item.sample.scriptPublicKey.serialized);
    expect(uptoScriptPubKeyHash(spk)).toBe(item.sample.scriptPublicKey.hash);
    const address = deriveUptoAddress(item.sample.params, ({ network, scriptPublicKey }) => {
      expect(network).toBe("kaspa:testnet-10");
      expect(scriptPublicKey.script).toBe(item.sample.scriptPublicKey.script);
      return "kaspatest:qupto";
    });
    expect(address).toBe("kaspatest:qupto");
  });

  it("builds upto settle and refund argument blobs", () => {
    const item = uptoFixture();
    expect(
      buildUptoSettleArgs({
        serverSignature: "ab".repeat(65),
        clientAuthorization: "cd".repeat(64),
      }),
    ).toBe(item.sample.settleArgsWithDummies);
    expect(buildUptoRefundArgs({ clientSignature: "ab".repeat(65) })).toBe(item.sample.refundArgsWithDummySig);
    expect(() =>
      buildUptoSettleArgs({
        serverSignature: "ab".repeat(64),
        clientAuthorization: "cd".repeat(64),
      }),
    ).toThrow("serverSignature must be 65 bytes");
    expect(() =>
      buildUptoSettleArgs({
        serverSignature: "ab".repeat(65),
        clientAuthorization: "cd".repeat(63),
      }),
    ).toThrow("clientAuthorization must be 64 bytes");
  });

  it("computes upto authorization preimages bound to script, outpoint, request, and nonce", () => {
    const item = uptoFixture();
    const input = {
      network: item.sample.params.network,
      activeScriptPublicKey: item.sample.scriptPublicKey.serialized,
      outpoint: item.sample.authorization.outpoint,
      requestHash: item.sample.params.requestHash,
      nonce: item.sample.params.nonce,
    };

    expect(uptoAuthorizationPreimage(input)).toBe(item.sample.authorization.preimage);
    expect(uptoAuthorizationDigest(input)).toBe(item.sample.authorization.digest);
    expect(uptoAuthorizationPreimage(input).length / 2).toBe(196);
    expect(uptoAuthorizationDigest({ ...input, outpoint: { ...input.outpoint, index: 8 } })).not.toBe(item.sample.authorization.digest);
    expect(uptoAuthorizationDigest({ ...input, requestHash: "99".repeat(32) })).not.toBe(item.sample.authorization.digest);
    expect(uptoAuthorizationDigest({ ...input, nonce: "99".repeat(32) })).not.toBe(item.sample.authorization.digest);
    expect(uptoAuthorizationDigest({ ...input, activeScriptPublicKey: `0000${"00".repeat(35)}` })).not.toBe(item.sample.authorization.digest);
    expect(() => uptoAuthorizationDigest({ ...input, activeScriptPublicKey: input.activeScriptPublicKey.slice(4) })).toThrow(
      "activeScriptPublicKey version must be 0",
    );
  });

  it("validates offline upto settlement and refund invariants", () => {
    const item = uptoFixture();
    expect(
      validateUptoSettlementOutputPlan({
        inputAmount: "300000",
        maxAmountSompi: "250000",
        chargeAmount: "100000",
        settlementFeeReserveSompi: "2000",
        paymentOutputAmount: "100000",
        paymentOutputScriptPublicKey: item.sample.payoutScriptPublicKey.serialized,
        expectedPayoutScriptPublicKeyHash: item.sample.payoutScriptPublicKey.hash,
        refundOutputAmount: "198000",
        refundOutputScriptPublicKey: item.sample.refundScriptPublicKey.serialized,
        expectedRefundScriptPublicKeyHash: item.sample.refundScriptPublicKey.hash,
      }),
    ).toBe(true);
    expect(
      validateUptoRefundOutputPlan({
        inputSequence: "0",
        refundOutputScriptPublicKey: item.sample.refundScriptPublicKey.serialized,
        expectedRefundScriptPublicKeyHash: item.sample.refundScriptPublicKey.hash,
      }),
    ).toBe(true);
    expect(() =>
      validateUptoSettlementOutputPlan({
        inputAmount: "300000",
        maxAmountSompi: "250000",
        chargeAmount: "250001",
        settlementFeeReserveSompi: "2000",
        paymentOutputAmount: "250001",
        paymentOutputScriptPublicKey: item.sample.payoutScriptPublicKey.serialized,
        expectedPayoutScriptPublicKeyHash: item.sample.payoutScriptPublicKey.hash,
        refundOutputAmount: "47999",
        refundOutputScriptPublicKey: item.sample.refundScriptPublicKey.serialized,
        expectedRefundScriptPublicKeyHash: item.sample.refundScriptPublicKey.hash,
      }),
    ).toThrow("upto settlement charge cannot exceed max amount");
    expect(() =>
      validateUptoSettlementOutputPlan({
        inputAmount: "300000",
        maxAmountSompi: "250000",
        chargeAmount: "100000",
        settlementFeeReserveSompi: "2000",
        paymentOutputAmount: "100000",
        paymentOutputScriptPublicKey: item.sample.payoutScriptPublicKey.serialized,
        expectedPayoutScriptPublicKeyHash: item.sample.payoutScriptPublicKey.hash,
        refundOutputAmount: "197999",
        refundOutputScriptPublicKey: item.sample.refundScriptPublicKey.serialized,
        expectedRefundScriptPublicKeyHash: item.sample.refundScriptPublicKey.hash,
      }),
    ).toThrow("upto settlement fee cannot exceed the signed reserve");
    expect(() =>
      validateUptoSettlementOutputPlan({
        inputAmount: "252000",
        maxAmountSompi: "250000",
        chargeAmount: "250000",
        settlementFeeReserveSompi: "2000",
        paymentOutputAmount: "250000",
        paymentOutputScriptPublicKey: item.sample.payoutScriptPublicKey.serialized,
        expectedPayoutScriptPublicKeyHash: item.sample.payoutScriptPublicKey.hash,
        refundOutputAmount: "0",
        refundOutputScriptPublicKey: item.sample.refundScriptPublicKey.serialized,
        expectedRefundScriptPublicKeyHash: item.sample.refundScriptPublicKey.hash,
      }),
    ).toThrow("upto settlement refund output must be positive");
    expect(() =>
      validateUptoRefundOutputPlan({
        inputSequence: "1",
        refundOutputScriptPublicKey: item.sample.refundScriptPublicKey.serialized,
        expectedRefundScriptPublicKeyHash: item.sample.refundScriptPublicKey.hash,
      }),
    ).toThrow("upto refund input sequence must be 0");
  });

  it("reproduces the batch claim transaction-v1 vector", () => {
    const item = vector<BatchClaimTxV1Input, BatchClaimTxV1Artifact>("vectors/tx-v1/batch-claim.json");
    expect(buildBatchClaimTxV1Artifact(item.input)).toEqual(item.expected);
    expect(vectorBackedBatchTransactionBuilder.buildBatchClaimTxV1(item.input)).toEqual(item.expected);
    expect(item.expected.fee.source).toBe("server-output");
    expect(item.expected.fee.serverOutputAmount).toBe("24999000");
    expect(item.expected.fee.continuationOutputAmount).toBe("65000000");
    expect(item.expected.transaction.inputs[0]?.computeBudget).toBe(CLAIM_COMPUTE_BUDGET);
    expect(item.expected.transaction.mass).toBe("44274");
    expect(item.expected.transaction.estimatedSerializedSize).toBe(734);
  });

  it("rejects malformed batch claim transaction-v1 plans", () => {
    const item = vector<BatchClaimTxV1Input, BatchClaimTxV1Artifact>("vectors/tx-v1/batch-claim.json");
    const outputs = item.expected.transaction.outputs;

    expect(() =>
      buildBatchClaimTxV1Artifact({
        ...item.input,
        outputs: [outputs[1]!, outputs[0]!],
      }),
    ).toThrow("claim output 0 must be the server output");
    expect(() =>
      buildBatchClaimTxV1Artifact({
        ...item.input,
        outputs: [
          outputs[0]!,
          {
            ...outputs[1]!,
            scriptPublicKey: fixture().sample.refundScriptPublicKey.serialized,
          },
        ],
      }),
    ).toThrow("claim output 1 must be the continuation escrow output");
    expect(() =>
      buildBatchClaimTxV1Artifact({
        ...item.input,
        outputs: [
          outputs[0]!,
          {
            ...outputs[1]!,
            amount: "64999000",
          },
        ],
      }),
    ).toThrow("fees must come from the server output");
    expect(() =>
      buildBatchClaimTxV1Artifact({
        ...item.input,
        computeBudget: undefined,
      } as unknown as BatchClaimTxV1Input),
    ).toThrow("claim compute budget is required");
    expect(() => buildBatchClaimTxV1Artifact({ ...item.input, claimAmount: item.input.activeAmount, voucherAmount: item.input.activeAmount })).toThrow(
      "claim continuation output must be positive",
    );
    expect(() => buildBatchClaimTxV1Artifact({ ...item.input, voucherAmount: "90000001" })).toThrow(
      "voucher amount cannot exceed active input amount",
    );
    expect(() => buildBatchClaimTxV1Artifact({ ...item.input, mass: "734" })).toThrow("storage mass must match contextual storage mass");
    expect(() => buildBatchClaimTxV1Artifact({ ...item.input, gas: "1" })).toThrow("batch transaction-v1 artifacts must use zero gas");
    expect(() => buildBatchClaimTxV1Artifact({ ...item.input, subnetworkId: "11".repeat(20) })).toThrow(
      "batch transaction-v1 artifacts must use the native subnetwork",
    );
    expect(() =>
      buildBatchClaimTxV1Artifact({
        ...item.input,
        outputs: [
          item.expected.transaction.outputs[0]!,
          {
            ...item.expected.transaction.outputs[1]!,
            covenant: {
              authorizingInput: 0,
              covenantId: "11".repeat(32),
            },
          },
        ],
      }),
    ).toThrow("batch transaction-v1 artifacts do not support output covenant bindings yet");
  });

  it("reproduces the batch refund transaction-v1 vector", () => {
    const item = vector<BatchRefundTxV1Input, BatchRefundTxV1Artifact>("vectors/tx-v1/batch-refund.json");
    expect(buildBatchRefundTxV1Artifact(item.input)).toEqual(item.expected);
    expect(vectorBackedBatchTransactionBuilder.buildBatchRefundTxV1(item.input)).toEqual(item.expected);
    expect(item.expected.fee.source).toBe("refund-output");
    expect(item.expected.fee.refundOutputAmount).toBe("64999100");
    expect(item.expected.transaction.inputs[0]?.computeBudget).toBe(REFUND_COMPUTE_BUDGET);
    expect(item.expected.transaction.mass).toBe("0");
    expect(item.expected.transaction.estimatedSerializedSize).toBe(607);
  });

  it("rejects malformed batch refund transaction-v1 plans", () => {
    const item = vector<BatchRefundTxV1Input, BatchRefundTxV1Artifact>("vectors/tx-v1/batch-refund.json");

    expect(() => buildBatchRefundTxV1Artifact({ ...item.input, lockTimeDaa: "123455" })).toThrow(
      "refund lock time must be greater than or equal to timeoutDaa",
    );
    expect(() => buildBatchRefundTxV1Artifact({ ...item.input, inputSequence: "1" })).toThrow("refund input sequence must be 0");
    expect(() =>
      buildBatchRefundTxV1Artifact({
        ...item.input,
        computeBudget: undefined,
      } as unknown as BatchRefundTxV1Input),
    ).toThrow("refund compute budget is required");
    expect(() =>
      buildBatchRefundTxV1Artifact({
        ...item.input,
        outputs: [
          {
            ...item.expected.transaction.outputs[0]!,
            scriptPublicKey: fixture().sample.payoutScriptPublicKey.serialized,
          },
        ],
      }),
    ).toThrow("refund output script public key must match");
    expect(() => buildBatchRefundTxV1Artifact({ ...item.input, mass: "607" })).toThrow("storage mass must match contextual storage mass");
    expect(() => buildBatchRefundTxV1Artifact({ ...item.input, gas: "1" })).toThrow("batch transaction-v1 artifacts must use zero gas");
    expect(() => buildBatchRefundTxV1Artifact({ ...item.input, subnetworkId: "11".repeat(20) })).toThrow(
      "batch transaction-v1 artifacts must use the native subnetwork",
    );
    expect(() =>
      buildBatchRefundTxV1Artifact({
        ...item.input,
        outputs: [
          {
            ...item.expected.transaction.outputs[0]!,
            covenant: {
              authorizingInput: 0,
              covenantId: "11".repeat(32),
            },
          },
        ],
      }),
    ).toThrow("batch transaction-v1 artifacts do not support output covenant bindings yet");
  });
});
