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
  networkHash,
  serializedScriptPublicKey,
  voucherDigest,
  voucherPreimage,
} from "./template.js";
import type { EscrowTemplateParams, ScriptPublicKey } from "./template.js";

export const ESCROW_FIXTURE_COMPILER_NAME = "silverc";
export const ESCROW_FIXTURE_COMPILER_CHECKED_COMMIT = "28a16f0ee194dcb288a5aaf371abd0f4b77f462e";
export const ESCROW_FIXTURE_COMPILER_COMMAND =
  "SILVERSCRIPT_DIR=<silverscript-checkout> cargo run --quiet -p silverscript-lang --bin silverc -- contracts/kaspa-x402-escrow-v3.sil --constructor-args <args.json> -o <out.json>";

export interface EscrowFixture {
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
  constructorLayout: {
    format: string;
    base: string;
    redeemScriptBytes: number;
    slots: Array<{
      name: string;
      source: string;
      encoding: string;
      offsets: number[];
      bytes: number;
    }>;
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
  check(fixture.compiler.name === ESCROW_FIXTURE_COMPILER_NAME, "compiler.name");
  check(fixture.compiler.checkedCommit === ESCROW_FIXTURE_COMPILER_CHECKED_COMMIT, "compiler.checkedCommit");
  check(fixture.compiler.command === ESCROW_FIXTURE_COMPILER_COMMAND, "compiler.command");
  check(fixture.stateLayout.start === 1 && fixture.stateLayout.len === 9, "stateLayout");
  checkEscrowConstructorLayout(fixture, checks);

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
    bytesToHex(withoutEscrowState(genesisRedeemScript, fixture.stateLayout)) ===
      bytesToHex(withoutEscrowState(successorRedeemScript, fixture.stateLayout)),
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
      throw new Error(`escrow-v3 fixture reproducibility check failed: ${label}`);
    }
    checks.push(label);
  }
}

function checkEscrowConstructorLayout(fixture: EscrowFixture, checks: string[]): void {
  const layout = fixture.constructorLayout;
  const script = hexToBytes(fixture.sample.genesis.redeemScript);
  check(layout.format === "fixed-width-byte-patches-v1", "constructorLayout.format");
  check(layout.base === "sample.genesis.redeemScript", "constructorLayout.base");
  check(layout.redeemScriptBytes === script.length, "constructorLayout.redeemScriptBytes");

  const expected = new Map<string, { encoding: string; offsets: number[]; bytes: number; value: Uint8Array }>([
    ["settledTotal", { encoding: "signed-int64-le", offsets: [2], bytes: 8, value: signedInt64Le(BigInt(fixture.sample.params.settledTotal)) }],
    ["serverPublicKey", { encoding: "hex", offsets: [114], bytes: 32, value: hexToBytes(fixture.sample.params.serverPublicKey) }],
    ["networkHash", { encoding: "hex", offsets: [247], bytes: 32, value: networkHash(fixture.sample.params.network) }],
    ["clientPublicKey", { encoding: "hex", offsets: [290, 580, 886], bytes: 32, value: hexToBytes(fixture.sample.params.clientPublicKey) }],
    ["payoutScriptPublicKeyHash", { encoding: "hex", offsets: [372], bytes: 32, value: hexToBytes(fixture.sample.params.payoutScriptPublicKeyHash) }],
    ["refundScriptPublicKeyHash", { encoding: "hex", offsets: [703, 989], bytes: 32, value: hexToBytes(fixture.sample.params.refundScriptPublicKeyHash) }],
    ["timeoutDaa", { encoding: "signed-int64-le", offsets: [855], bytes: 8, value: signedInt64Le(BigInt(fixture.sample.params.timeoutDaa)) }],
  ]);
  check(layout.slots.length === expected.size, "constructorLayout.slots.length");
  for (const slot of layout.slots) {
    const item = expected.get(slot.name);
    check(item !== undefined, `constructorLayout.${slot.name}.known`);
    if (item === undefined) continue;
    check(slot.encoding === item.encoding, `constructorLayout.${slot.name}.encoding`);
    check(slot.bytes === item.bytes, `constructorLayout.${slot.name}.bytes`);
    check(JSON.stringify(slot.offsets) === JSON.stringify(item.offsets), `constructorLayout.${slot.name}.offsets`);
    for (const offset of slot.offsets) {
      check(bytesToHex(script.slice(offset, offset + slot.bytes)) === bytesToHex(item.value), `constructorLayout.${slot.name}.value@${offset}`);
    }
  }

  function check(value: boolean, label: string): void {
    if (!value) throw new Error(`escrow-v3 fixture reproducibility check failed: ${label}`);
    checks.push(label);
  }
}

function signedInt64Le(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  let remaining = value;
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
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

function withoutEscrowState(redeemScript: string, layout: { start: number; len: number }): Uint8Array {
  const bytes = hexToBytes(redeemScript, undefined, "redeemScript");
  if (layout.start < 0 || layout.len <= 0 || layout.start + layout.len > bytes.byteLength) {
    throw new Error("escrow-v3 state layout is outside redeem script");
  }
  return Uint8Array.from([...bytes.subarray(0, layout.start), ...bytes.subarray(layout.start + layout.len)]);
}
