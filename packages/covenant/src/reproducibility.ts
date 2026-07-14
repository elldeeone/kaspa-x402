import crypto from "node:crypto";

import {
  CLAIM_COMPUTE_BUDGET,
  CLAIM_SCRIPT_UNITS_ESTIMATE,
  ESCROW_TEMPLATE_ID,
  ESCROW_VOUCHER_DOMAIN,
  ESCROW_VOUCHER_DOMAIN_TAG,
  REFUND_COMPUTE_BUDGET,
  REFUND_SCRIPT_UNITS_ESTIMATE,
  buildClaimArgs,
  buildEscrowRedeemScript,
  buildRefundArgs,
  bytesToHex,
  escrowScriptPubKeyHash,
  escrowScriptPublicKey,
  hexToBytes,
  serializedScriptPublicKey,
  voucherDigest,
  voucherPreimage,
} from "./template.js";
import type { EscrowTemplateParams, FundingOutpoint, ScriptPublicKey } from "./template.js";

export const ESCROW_FIXTURE_COMPILER_NAME = "silverc";
export const ESCROW_FIXTURE_COMPILER_CHECKED_COMMIT = "956868ea63a2af4176889f1331449b5f4f9e1df8";
export const ESCROW_FIXTURE_COMPILER_COMMAND =
  "SILVERSCRIPT_DIR=<silverscript-checkout> cargo run --quiet -p silverscript-lang --bin silverc -- contracts/kaspa-x402-escrow-v1.sil --constructor-args <args.json> -o <out.json>";

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

function scriptHash(serialized: string): string {
  return escrowScriptPubKeyHash(parseSerializedScriptPublicKey(serialized));
}

function parseSerializedScriptPublicKey(serialized: string): ScriptPublicKey {
  const bytes = hexToBytes(serialized, undefined, "scriptPublicKey");
  if (bytes.byteLength < 2) {
    throw new Error("scriptPublicKey must contain a uint16 version and script bytes");
  }
  return {
    version: (bytes[0] << 8) | bytes[1],
    script: bytesToHex(bytes.subarray(2)),
  };
}

function sha256Hex(value: Uint8Array): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
