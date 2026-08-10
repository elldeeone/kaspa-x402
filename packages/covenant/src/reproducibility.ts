import crypto from "node:crypto";

import {
  ESCROW_TEMPLATE_ID,
  ESCROW_VOUCHER_DOMAIN,
  ESCROW_VOUCHER_DOMAIN_TAG,
  buildClaimArgs,
  buildEscrowRedeemScript,
  buildRefundArgs,
  buildTopUpArgs,
  bytesToHex,
  escrowScriptPubKeyHash,
  escrowScriptPublicKey,
  hexToBytes,
  serializedScriptPublicKey,
  voucherDigest,
  voucherPreimage,
} from "./template.js";
import type { EscrowTemplateParams, ScriptPublicKey } from "./template.js";

export const ESCROW_FIXTURE_COMPILER_NAME = "silverc";
export const ESCROW_FIXTURE_COMPILER_CHECKED_COMMIT = "6f9e078b1d8b5389212755183b592704de99fea5";
export const ESCROW_FIXTURE_COMPILER_COMMAND =
  "SILVERSCRIPT_DIR=<silverscript-checkout> cargo run --quiet -p silverscript-lang --bin silverc -- contracts/kaspa-x402-escrow-v2.sil --constructor-args <args.json> -o <out.json>";
export const ESCROW_V2_FIXTURE_COMPILER_NAME = ESCROW_FIXTURE_COMPILER_NAME;
export const ESCROW_V2_FIXTURE_COMPILER_CHECKED_COMMIT = ESCROW_FIXTURE_COMPILER_CHECKED_COMMIT;
export const ESCROW_V2_FIXTURE_COMPILER_COMMAND = ESCROW_FIXTURE_COMPILER_COMMAND;

export interface EscrowV2Fixture {
  format: string;
  templateId: string;
  source: string;
  sourceSha256: string;
  domainTag: string;
  domainTagHash: string;
  compiler: {
    name: string;
    checkedCommit: string;
    command: string;
  };
  stateLayout: {
    start: number;
    len: number;
  };
  sample: {
    params: EscrowTemplateParams;
    genesis: {
      redeemScript: string;
      bytecodeSha256: string;
      scriptPublicKey: {
        version: number;
        script: string;
        serialized: string;
        hash: string;
      };
    };
    successor: {
      settledTotal: string;
      redeemScript: string;
      bytecodeSha256: string;
      scriptPublicKey: {
        version: number;
        script: string;
        serialized: string;
        hash: string;
      };
      sameTemplate: boolean;
    };
    payoutScriptPublicKey: {
      serialized: string;
      hash: string;
    };
    refundScriptPublicKey: {
      serialized: string;
      hash: string;
    };
    covenantId: string;
    claimArgsWithDummies: string;
    topUpArgsWithDummySig: string;
    refundArgsWithDummySig: string;
    voucher: {
      totalAuthorized: string;
      claimAmount: string;
      preimage: string;
      digest: string;
    };
  };
}

export type EscrowFixture = EscrowV2Fixture;

export interface EscrowFixtureReproducibilityReport {
  ok: true;
  checks: readonly string[];
}

export function checkEscrowV2FixtureReproducibility(
  fixture: EscrowV2Fixture,
  source: string | Uint8Array,
): EscrowFixtureReproducibilityReport {
  const checks: string[] = [];

  check(fixture.templateId === ESCROW_TEMPLATE_ID, "templateId");
  check(sha256Hex(typeof source === "string" ? Buffer.from(source, "utf8") : source) === fixture.sourceSha256, "sourceSha256");
  check(fixture.domainTag === ESCROW_VOUCHER_DOMAIN, "domainTag");
  check(fixture.domainTagHash === ESCROW_VOUCHER_DOMAIN_TAG, "domainTagHash");
  check(fixture.compiler.name === ESCROW_FIXTURE_COMPILER_NAME, "compiler.name");
  check(fixture.compiler.checkedCommit === ESCROW_FIXTURE_COMPILER_CHECKED_COMMIT, "compiler.checkedCommit");
  check(fixture.compiler.command === ESCROW_FIXTURE_COMPILER_COMMAND, "compiler.command");
  check(fixture.stateLayout.start === 1 && fixture.stateLayout.len === 9, "stateLayout");

  const genesisRedeemScript = buildEscrowRedeemScript(fixture.sample.params);
  const genesisScriptPublicKey = escrowScriptPublicKey(fixture.sample.params);
  check(genesisRedeemScript === fixture.sample.genesis.redeemScript, "sample.genesis.redeemScript");
  check(sha256Hex(hexToBytes(genesisRedeemScript)) === fixture.sample.genesis.bytecodeSha256, "sample.genesis.bytecodeSha256");
  check(genesisScriptPublicKey.version === fixture.sample.genesis.scriptPublicKey.version, "sample.genesis.scriptPublicKey.version");
  check(genesisScriptPublicKey.script === fixture.sample.genesis.scriptPublicKey.script, "sample.genesis.scriptPublicKey.script");
  check(
    serializedScriptPublicKey(genesisScriptPublicKey) === fixture.sample.genesis.scriptPublicKey.serialized,
    "sample.genesis.scriptPublicKey.serialized",
  );
  check(escrowScriptPubKeyHash(genesisScriptPublicKey) === fixture.sample.genesis.scriptPublicKey.hash, "sample.genesis.scriptPublicKey.hash");

  const successorParams = { ...fixture.sample.params, settledTotal: fixture.sample.successor.settledTotal };
  const successorRedeemScript = buildEscrowRedeemScript(successorParams);
  const successorScriptPublicKey = escrowScriptPublicKey(successorParams);
  check(successorRedeemScript === fixture.sample.successor.redeemScript, "sample.successor.redeemScript");
  check(sha256Hex(hexToBytes(successorRedeemScript)) === fixture.sample.successor.bytecodeSha256, "sample.successor.bytecodeSha256");
  check(successorScriptPublicKey.version === fixture.sample.successor.scriptPublicKey.version, "sample.successor.scriptPublicKey.version");
  check(successorScriptPublicKey.script === fixture.sample.successor.scriptPublicKey.script, "sample.successor.scriptPublicKey.script");
  check(
    serializedScriptPublicKey(successorScriptPublicKey) === fixture.sample.successor.scriptPublicKey.serialized,
    "sample.successor.scriptPublicKey.serialized",
  );
  check(escrowScriptPubKeyHash(successorScriptPublicKey) === fixture.sample.successor.scriptPublicKey.hash, "sample.successor.scriptPublicKey.hash");
  check(genesisRedeemScript !== successorRedeemScript, "sample.successor.stateChangesScript");
  check(
    bytesToHex(withoutEscrowV2State(genesisRedeemScript, fixture.stateLayout)) ===
      bytesToHex(withoutEscrowV2State(successorRedeemScript, fixture.stateLayout)),
    "sample.successor.sameTemplate",
  );
  check(fixture.sample.successor.sameTemplate, "sample.successor.sameTemplateFlag");

  check(scriptHash(fixture.sample.payoutScriptPublicKey.serialized) === fixture.sample.payoutScriptPublicKey.hash, "sample.payoutScriptPublicKey.hash");
  check(scriptHash(fixture.sample.refundScriptPublicKey.serialized) === fixture.sample.refundScriptPublicKey.hash, "sample.refundScriptPublicKey.hash");
  check(fixture.sample.params.payoutScriptPublicKeyHash === fixture.sample.payoutScriptPublicKey.hash, "sample.params.payoutScriptPublicKeyHash");
  check(fixture.sample.params.refundScriptPublicKeyHash === fixture.sample.refundScriptPublicKey.hash, "sample.params.refundScriptPublicKeyHash");
  check(
    buildClaimArgs({
      serverSignature: "ab".repeat(65),
      voucherSignature: "cd".repeat(64),
      totalAuthorized: fixture.sample.voucher.totalAuthorized,
      claimAmount: fixture.sample.voucher.claimAmount,
    }) === fixture.sample.claimArgsWithDummies,
    "sample.claimArgsWithDummies",
  );
  check(buildTopUpArgs({ clientSignature: "ab".repeat(65) }) === fixture.sample.topUpArgsWithDummySig, "sample.topUpArgsWithDummySig");
  check(buildRefundArgs({ clientSignature: "ab".repeat(65) }) === fixture.sample.refundArgsWithDummySig, "sample.refundArgsWithDummySig");

  const voucherInput = {
    network: fixture.sample.params.network,
    covenantId: fixture.sample.covenantId,
    totalAuthorized: fixture.sample.voucher.totalAuthorized,
  };
  check(voucherPreimage(voucherInput) === fixture.sample.voucher.preimage, "sample.voucher.preimage");
  check(voucherDigest(voucherInput) === fixture.sample.voucher.digest, "sample.voucher.digest");

  return { ok: true, checks };

  function check(value: boolean, label: string): void {
    if (!value) {
      throw new Error(`escrow-v2 fixture reproducibility check failed: ${label}`);
    }
    checks.push(label);
  }
}

export function checkEscrowFixtureReproducibility(
  fixture: EscrowFixture,
  source: string | Uint8Array,
): EscrowFixtureReproducibilityReport {
  return checkEscrowV2FixtureReproducibility(fixture, source);
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

function withoutEscrowV2State(redeemScript: string, layout: { start: number; len: number }): Uint8Array {
  const bytes = hexToBytes(redeemScript, undefined, "redeemScript");
  if (layout.start < 0 || layout.len <= 0 || layout.start + layout.len > bytes.byteLength) {
    throw new Error("escrow-v2 state layout is outside redeem script");
  }
  return Uint8Array.from([...bytes.subarray(0, layout.start), ...bytes.subarray(layout.start + layout.len)]);
}
