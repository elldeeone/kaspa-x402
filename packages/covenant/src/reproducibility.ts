import crypto from "node:crypto";

import {
  CLAIM_COMPUTE_BUDGET,
  CLAIM_SCRIPT_UNITS_ESTIMATE,
  ESCROW_TEMPLATE_ID,
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
  UPTO_TEMPLATE_ID,
  buildClaimArgs,
  buildEscrowRedeemScript,
  buildRefundArgs,
  buildUptoRedeemScript,
  buildUptoRefundArgs,
  buildUptoSettleArgs,
  bytesToHex,
  escrowScriptPubKeyHash,
  escrowScriptPublicKey,
  hexToBytes,
  serializedScriptPublicKey,
  uptoAuthorizationDigest,
  uptoAuthorizationPreimage,
  uptoScriptPubKeyHash,
  uptoScriptPublicKey,
  voucherDigest,
  voucherPreimage,
} from "./template.js";
import type { EscrowTemplateParams, FundingOutpoint, ScriptPublicKey, UptoTemplateParams } from "./template.js";

export const ESCROW_FIXTURE_COMPILER_NAME = "silverc";
export const ESCROW_FIXTURE_COMPILER_CHECKED_COMMIT = "bf04c35b7ec74b0dce12815d78075af1c42ae2dd";
export const UPTO_FIXTURE_COMPILER_CHECKED_COMMIT = "c46e0e20150c5c9d9921fd4c813e4e727ae918ef";
export const ESCROW_FIXTURE_COMPILER_COMMAND =
  "SILVERSCRIPT_DIR=<silverscript-checkout> cargo run --quiet -p silverscript-lang --bin silverc -- contracts/kaspa-x402-escrow-v1.sil --constructor-args <args.json> -o <out.json>";
export const UPTO_FIXTURE_COMPILER_COMMAND =
  "SILVERSCRIPT_DIR=<silverscript-checkout> cargo run --quiet -p silverscript-lang --bin silverc -- contracts/kaspa-x402-upto-v1.sil --constructor-args <args.json> -o <out.json>";

export interface EscrowFixture {
  templateId: string;
  sourceSha256: string;
  domainTag: string;
  domainTagHash: string;
  compiler?: {
    name?: string;
    checkedCommit?: string;
    command?: string;
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
      outpoint: FundingOutpoint;
      amount: string;
      preimage: string;
      digest: string;
    };
  };
}

export interface EscrowFixtureReproducibilityReport {
  ok: true;
  checks: readonly string[];
}

export interface UptoFixture {
  templateId: string;
  sourceSha256: string;
  domainTag: string;
  domainTagHash: string;
  compiler?: {
    name?: string;
    checkedCommit?: string;
    command?: string;
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
      outpoint: FundingOutpoint;
      preimage: string;
      digest: string;
    };
  };
}

export interface UptoFixtureReproducibilityReport {
  ok: true;
  checks: readonly string[];
}

export function checkEscrowFixtureReproducibility(
  fixture: EscrowFixture,
  source: string | Uint8Array,
): EscrowFixtureReproducibilityReport {
  const checks: string[] = [];

  check(fixture.templateId === ESCROW_TEMPLATE_ID, "templateId");
  check(sha256Hex(typeof source === "string" ? Buffer.from(source, "utf8") : source) === fixture.sourceSha256, "sourceSha256");
  check(fixture.domainTag === ESCROW_VOUCHER_DOMAIN, "domainTag");
  check(fixture.domainTagHash === ESCROW_VOUCHER_DOMAIN_TAG, "domainTagHash");
  check(fixture.compiler?.name === ESCROW_FIXTURE_COMPILER_NAME, "compiler.name");
  check(fixture.compiler?.checkedCommit === ESCROW_FIXTURE_COMPILER_CHECKED_COMMIT, "compiler.checkedCommit");
  check(fixture.compiler?.command === ESCROW_FIXTURE_COMPILER_COMMAND, "compiler.command");
  check(fixture.computeBudget.claim === CLAIM_COMPUTE_BUDGET, "computeBudget.claim");
  check(fixture.computeBudget.refund === REFUND_COMPUTE_BUDGET, "computeBudget.refund");
  check(fixture.scriptUnitsEstimate.claim === CLAIM_SCRIPT_UNITS_ESTIMATE, "scriptUnitsEstimate.claim");
  check(fixture.scriptUnitsEstimate.refund === REFUND_SCRIPT_UNITS_ESTIMATE, "scriptUnitsEstimate.refund");

  const redeemScript = buildEscrowRedeemScript(fixture.sample.params);
  const scriptPublicKey = escrowScriptPublicKey(fixture.sample.params);
  check(redeemScript === fixture.sample.redeemScript, "sample.redeemScript");
  check(scriptPublicKey.version === fixture.sample.scriptPublicKey.version, "sample.scriptPublicKey.version");
  check(scriptPublicKey.script === fixture.sample.scriptPublicKey.script, "sample.scriptPublicKey.script");
  check(serializedScriptPublicKey(scriptPublicKey) === fixture.sample.scriptPublicKey.serialized, "sample.scriptPublicKey.serialized");
  check(escrowScriptPubKeyHash(scriptPublicKey) === fixture.sample.scriptPublicKey.hash, "sample.scriptPublicKey.hash");
  check(scriptHash(fixture.sample.payoutScriptPublicKey.serialized) === fixture.sample.payoutScriptPublicKey.hash, "sample.payoutScriptPublicKey.hash");
  check(scriptHash(fixture.sample.refundScriptPublicKey.serialized) === fixture.sample.refundScriptPublicKey.hash, "sample.refundScriptPublicKey.hash");
  check(
    buildClaimArgs({
      serverSignature: "ab".repeat(65),
      voucherSignature: "cd".repeat(64),
      amount: fixture.sample.voucher.amount,
    }) === fixture.sample.claimArgsWithDummies,
    "sample.claimArgsWithDummies",
  );
  check(buildRefundArgs({ clientSignature: "ab".repeat(65) }) === fixture.sample.refundArgsWithDummySig, "sample.refundArgsWithDummySig");

  const voucherInput = {
    network: fixture.sample.params.network,
    activeScriptPublicKey: fixture.sample.scriptPublicKey.serialized,
    outpoint: fixture.sample.voucher.outpoint,
    amount: fixture.sample.voucher.amount,
  };
  check(voucherPreimage(voucherInput) === fixture.sample.voucher.preimage, "sample.voucher.preimage");
  check(voucherDigest(voucherInput) === fixture.sample.voucher.digest, "sample.voucher.digest");

  return {
    ok: true,
    checks,
  };

  function check(value: boolean, label: string): void {
    if (!value) {
      throw new Error(`escrow fixture reproducibility check failed: ${label}`);
    }
    checks.push(label);
  }
}

export function checkUptoFixtureReproducibility(fixture: UptoFixture, source: string | Uint8Array): UptoFixtureReproducibilityReport {
  const checks: string[] = [];

  check(fixture.templateId === UPTO_TEMPLATE_ID, "templateId");
  check(sha256Hex(typeof source === "string" ? Buffer.from(source, "utf8") : source) === fixture.sourceSha256, "sourceSha256");
  check(fixture.domainTag === UPTO_AUTHORIZATION_DOMAIN, "domainTag");
  check(fixture.domainTagHash === UPTO_AUTHORIZATION_DOMAIN_TAG, "domainTagHash");
  check(fixture.compiler?.name === ESCROW_FIXTURE_COMPILER_NAME, "compiler.name");
  check(fixture.compiler?.checkedCommit === UPTO_FIXTURE_COMPILER_CHECKED_COMMIT, "compiler.checkedCommit");
  check(fixture.compiler?.command === UPTO_FIXTURE_COMPILER_COMMAND, "compiler.command");
  check(fixture.computeBudget.settle === UPTO_SETTLE_COMPUTE_BUDGET, "computeBudget.settle");
  check(fixture.computeBudget.refund === UPTO_REFUND_COMPUTE_BUDGET, "computeBudget.refund");
  check(fixture.scriptUnitsEstimate.settle === UPTO_SETTLE_SCRIPT_UNITS_ESTIMATE, "scriptUnitsEstimate.settle");
  check(fixture.scriptUnitsEstimate.refund === UPTO_REFUND_SCRIPT_UNITS_ESTIMATE, "scriptUnitsEstimate.refund");

  const redeemScript = buildUptoRedeemScript(fixture.sample.params);
  const scriptPublicKey = uptoScriptPublicKey(fixture.sample.params);
  check(redeemScript === fixture.sample.redeemScript, "sample.redeemScript");
  check(scriptPublicKey.version === fixture.sample.scriptPublicKey.version, "sample.scriptPublicKey.version");
  check(scriptPublicKey.script === fixture.sample.scriptPublicKey.script, "sample.scriptPublicKey.script");
  check(serializedScriptPublicKey(scriptPublicKey) === fixture.sample.scriptPublicKey.serialized, "sample.scriptPublicKey.serialized");
  check(uptoScriptPubKeyHash(scriptPublicKey) === fixture.sample.scriptPublicKey.hash, "sample.scriptPublicKey.hash");
  check(scriptHash(fixture.sample.payoutScriptPublicKey.serialized) === fixture.sample.payoutScriptPublicKey.hash, "sample.payoutScriptPublicKey.hash");
  check(scriptHash(fixture.sample.refundScriptPublicKey.serialized) === fixture.sample.refundScriptPublicKey.hash, "sample.refundScriptPublicKey.hash");
  check(
    buildUptoSettleArgs({
      serverSignature: "ab".repeat(65),
      clientAuthorization: "cd".repeat(64),
    }) === fixture.sample.settleArgsWithDummies,
    "sample.settleArgsWithDummies",
  );
  check(buildUptoRefundArgs({ clientSignature: "ab".repeat(65) }) === fixture.sample.refundArgsWithDummySig, "sample.refundArgsWithDummySig");

  const authorizationInput = {
    network: fixture.sample.params.network,
    activeScriptPublicKey: fixture.sample.scriptPublicKey.serialized,
    outpoint: fixture.sample.authorization.outpoint,
    requestHash: fixture.sample.params.requestHash,
    nonce: fixture.sample.params.nonce,
  };
  check(uptoAuthorizationPreimage(authorizationInput) === fixture.sample.authorization.preimage, "sample.authorization.preimage");
  check(uptoAuthorizationDigest(authorizationInput) === fixture.sample.authorization.digest, "sample.authorization.digest");

  return {
    ok: true,
    checks,
  };

  function check(value: boolean, label: string): void {
    if (!value) {
      throw new Error(`upto fixture reproducibility check failed: ${label}`);
    }
    checks.push(label);
  }
}

function scriptHash(serialized: string): string {
  return escrowScriptPubKeyHash(parseSerializedScriptPublicKey(serialized));
}

function parseSerializedScriptPublicKey(serialized: string): ScriptPublicKey {
  const bytes = hexToBytes(serialized, undefined, "scriptPublicKey");
  if (bytes.byteLength < 2) {
    throw new Error("scriptPublicKey must contain a uint16 version and script bytes");
  }
  return {
    version: bytes[0] | ((bytes[1] ?? 0) << 8),
    script: bytesToHex(bytes.subarray(2)),
  };
}

function sha256Hex(value: Uint8Array): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
