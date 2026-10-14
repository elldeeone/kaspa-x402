#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { blake2b } from "blakejs";
import { withPinnedSilverScript } from "./silverscript-compiler.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRelative = "contracts/kaspa-x402-escrow-v5.sil";
const source = path.join(root, sourceRelative);
const fixtureFile = path.join(
  root,
  "contracts/fixtures/kaspa-x402-escrow-v5.json",
);
const generatedFile = path.join(
  root,
  "packages/covenant/src/generated/escrow-v5-template.ts",
);
export function generateEscrowFixture(compiler, { check = false } = {}) {
  const compilerCommit = compiler.commit;
  const params = {
    clientPublicKey:
      "11111111111111111111111111111111111111111111111111111111111111aa",
    serverPublicKey:
      "22222222222222222222222222222222222222222222222222222222222222bb",
    network: "kaspa:testnet-10",
    payoutScriptPublicKeyHash:
      "b99ac42fd048ced7f710abe60dfcf6c7dfcd0772cfba99716574c9d47bf6962f",
    refundScriptPublicKeyHash:
      "8a77bf0e98c7ed79147a8f0302b0da331b6d3db5a6543e97da53ad6e6cc5f6c2",
    timeoutDaa: "123456",
    claimedCumulativeAmount: "0",
  };
  const successorClaimed = "2500000";
  const genesisArtifact = compile(params);
  const successorArtifact = compile({
    ...params,
    claimedCumulativeAmount: successorClaimed,
  });
  const contract = genesisArtifact.contracts.KaspaX402EscrowV5;
  const successorContract = successorArtifact.contracts.KaspaX402EscrowV5;
  if (!contract || !successorContract) {
    throw new Error("silverc did not emit KaspaX402EscrowV5");
  }

  const genesisRedeemScript = hex(contract.compiled.bytecode);
  const successorRedeemScript = hex(successorContract.compiled.bytecode);
  const stateLayout = contract.compiled.state_span;
  const selectors = {
    claim: contract.entries.__covenant_entrypoint_auth_claim.dispatch_tag,
    topUp: contract.entries.__covenant_entrypoint_auth_topUp.dispatch_tag,
    refund: contract.entries.refund.dispatch_tag,
  };
  const networkHash = sha256(Buffer.from(params.network, "utf8"));
  const slots = [
    {
      name: "claimedCumulativeAmount",
      source: "sample.params.claimedCumulativeAmount",
      encoding: "signed-int64-le",
      offsets: [stateLayout.offset + 1],
      bytes: 8,
    },
    slot(
      "serverPublicKey",
      "sample.params.serverPublicKey",
      params.serverPublicKey,
    ),
    slot(
      "networkHash",
      "sha256(utf8(sample.params.network))",
      networkHash,
    ),
    slot(
      "clientPublicKey",
      "sample.params.clientPublicKey",
      params.clientPublicKey,
    ),
    slot(
      "payoutScriptPublicKeyHash",
      "sample.params.payoutScriptPublicKeyHash",
      params.payoutScriptPublicKeyHash,
    ),
    slot(
      "refundScriptPublicKeyHash",
      "sample.params.refundScriptPublicKeyHash",
      params.refundScriptPublicKeyHash,
    ),
    {
      name: "timeoutDaa",
      source: "sample.params.timeoutDaa",
      encoding: "signed-int64-le",
      offsets: allOffsets(genesisRedeemScript, int64Le(params.timeoutDaa)),
      bytes: 8,
    },
  ];
  for (const item of slots) {
    if (item.offsets.length === 0) {
      throw new Error(`constructor slot ${item.name} was not found`);
    }
  }

  // The independent compiler, rather than another copy of the patching helper,
  // establishes that every constructor slot and the fixed-width state work.
  for (const changes of [
    { clientPublicKey: "33".repeat(32) },
    { serverPublicKey: "44".repeat(32) },
    { network: "kaspa:mainnet" },
    { payoutScriptPublicKeyHash: "77".repeat(32) },
    { refundScriptPublicKeyHash: "88".repeat(32) },
    { timeoutDaa: "123457" },
    { claimedCumulativeAmount: "9007199254740991" },
  ]) {
    const variant = { ...params, ...changes };
    const expected = Buffer.from(genesisRedeemScript, "hex");
    for (const item of slots) {
      const value = item.name === "networkHash" ? sha256(Buffer.from(variant.network, "utf8"))
        : item.encoding === "signed-int64-le" ? int64Le(variant[item.name]) : variant[item.name];
      for (const offset of item.offsets) Buffer.from(value, "hex").copy(expected, offset);
    }
    const actual = compile(variant).contracts.KaspaX402EscrowV5;
    if (!actual || !expected.equals(Buffer.from(actual.compiled.bytecode)) ||
        actual.compiled.state_span.offset !== stateLayout.offset || actual.compiled.state_span.len !== stateLayout.len)
      throw new Error(`Escrow constructor variant ${Object.keys(changes)[0]} does not reproduce pinned bytecode.`);
  }

  const payoutSerialized =
    "0000205555555555555555555555555555555555555555555555555555555555555555ac";
  const refundSerialized =
    "0000206666666666666666666666666666666666666666666666666666666666666666ac";
  const covenantId = "77".repeat(32);
  const authorizedCumulativeAmount = "5000000";
  const claimAmount = successorClaimed;
  const domainTag = "kaspa:x402:escrow-voucher:v3";
  const domainTagHash = sha256(Buffer.from(domainTag, "utf8"));
  const voucherPreimage = Buffer.concat([
    Buffer.from(domainTagHash, "hex"),
    Buffer.from(networkHash, "hex"),
    Buffer.from(covenantId, "hex"),
    Buffer.from(int64Le(authorizedCumulativeAmount), "hex"),
  ]).toString("hex");
  const genesisSpk = scriptPublicKey(genesisRedeemScript);
  const successorSpk = scriptPublicKey(successorRedeemScript);
  const fixture = {
    format: "kaspa-x402-covenant-fixture-v4",
    templateId: "kaspa-x402-escrow-v5",
    source: sourceRelative,
    sourceSha256: compiler.sourceSha256(source),
    domainTag,
    domainTagHash,
    compiler: {
      name: "silverc",
      checkedCommit: compilerCommit,
      compilerVersion: genesisArtifact.compiler_version,
      command:
        "cd <silverscript-checkout> && cargo run --quiet -p silverscript-lang --bin silverc -- <kaspa-x402-root>/contracts/kaspa-x402-escrow-v5.sil --constructor-args <args.json> -c > <out.json>",
    },
    generatedDeclarations: {
      runtimeState: contract.runtime_state,
      covenantDeclarations: contract.cov_decl_to_abi,
      entries: contract.entries,
      templateHash: hex(contract.compiled.template_hash),
    },
    stateLayout: {
      start: stateLayout.offset,
      len: stateLayout.len,
    },
    constructorLayout: {
      format: "fixed-width-byte-patches-v1",
      base: "sample.genesis.redeemScript",
      redeemScriptBytes: genesisRedeemScript.length / 2,
      slots,
    },
    sample: {
      params,
      genesis: {
        redeemScript: genesisRedeemScript,
        bytecodeSha256: sha256(Buffer.from(genesisRedeemScript, "hex")),
        scriptPublicKey: genesisSpk,
      },
      successor: {
        claimedCumulativeAmount: successorClaimed,
        redeemScript: successorRedeemScript,
        bytecodeSha256: sha256(Buffer.from(successorRedeemScript, "hex")),
        scriptPublicKey: successorSpk,
        sameTemplate: withoutState(genesisRedeemScript).equals(
          withoutState(successorRedeemScript),
        ),
      },
      payoutScriptPublicKey: {
        serialized: payoutSerialized,
        hash: sha256(Buffer.from(payoutSerialized, "hex")),
      },
      refundScriptPublicKey: {
        serialized: refundSerialized,
        hash: sha256(Buffer.from(refundSerialized, "hex")),
      },
      covenantId,
      claimArgsWithDummies: [
        pushData("ab".repeat(65)),
        pushData("cd".repeat(64)),
        pushData(int64Le(authorizedCumulativeAmount)),
        pushData(int64Le(claimAmount)),
        pushData(selectors.claim),
      ].join(""),
      topUpArgsWithDummySignatures: [
        pushData("ab".repeat(65)),
        pushData("ef".repeat(65)),
        pushData(selectors.topUp),
      ].join(""),
      refundArgsWithDummySig: [
        pushData("ab".repeat(65)),
        pushData(selectors.refund),
      ].join(""),
      voucher: {
        authorizedCumulativeAmount,
        claimAmount,
        preimage: voucherPreimage,
        digest: sha256(Buffer.from(voucherPreimage, "hex")),
      },
    },
  };

  const generated = `// Generated by scripts/generate-covenant-fixture.mjs. Do not edit.
export const ESCROW_V5_COMPILED_BASE = ${JSON.stringify(genesisRedeemScript)};
export const ESCROW_V5_STATE_LAYOUT = ${JSON.stringify(fixture.stateLayout)} as const;
export const ESCROW_V5_CONSTRUCTOR_SLOTS = ${JSON.stringify(
  Object.fromEntries(slots.map((item) => [item.name, item])),
  null,
  2,
)} as const;
export const ESCROW_V5_SELECTORS = ${JSON.stringify(selectors, null, 2)} as const;
export const ESCROW_V5_GENERATED_DECLARATIONS = ${JSON.stringify(
  fixture.generatedDeclarations,
  null,
  2,
)} as const;
`;

  writeOrCheck(fixtureFile, `${JSON.stringify(fixture, null, 2)}\n`);
  writeOrCheck(generatedFile, generated);
  return { templateId: fixture.templateId, check, fixtureSha256: sha256(Buffer.from(`${JSON.stringify(fixture, null, 2)}\n`)), generatedSha256: sha256(Buffer.from(generated)) };

  function compile(values) {
    return compiler.compile(source, [
      portableBytes(values.clientPublicKey), portableBytes(values.serverPublicKey),
      portableBytes(sha256(Buffer.from(values.network, "utf8"))),
      portableBytes(values.payoutScriptPublicKeyHash), portableBytes(values.refundScriptPublicKeyHash),
      portableBytes(int64Le(values.timeoutDaa)), { kind: "int", value: Number(values.claimedCumulativeAmount) },
    ]);
  }
  function writeOrCheck(file, content) {
    if (check) {
      if (!fs.existsSync(file) || !fs.lstatSync(file).isFile() || fs.readFileSync(file, "utf8") !== content)
        throw new Error(`${path.relative(root, file)} differs from pinned SilverScript compilation.`);
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
    }
  }

  function portableBytes(value) {
    return { kind: "bytes", value: [...Buffer.from(value, "hex")] };
  }

  function slot(name, sourceName, value) {
    return {
      name,
      source: sourceName,
      encoding: "hex",
      offsets: allOffsets(genesisRedeemScript, value),
      bytes: value.length / 2,
    };
  }

  function allOffsets(haystack, needle) {
    const offsets = [];
    let from = 0;
    for (;;) {
      const index = haystack.indexOf(needle, from);
      if (index < 0) return offsets;
      if (index % 2 === 0) offsets.push(index / 2);
      from = index + 2;
    }
  }

  function int64Le(value) {
    const buffer = Buffer.alloc(8);
    buffer.writeBigInt64LE(BigInt(value));
    return buffer.toString("hex");
  }

  function scriptPublicKey(redeemScript) {
    const script = Buffer.concat([
      Buffer.from([0xaa, 0x20]),
      Buffer.from(blake2b(Buffer.from(redeemScript, "hex"), undefined, 32)),
      Buffer.from([0x87]),
    ]).toString("hex");
    const serialized = `0000${script}`;
    return {
      version: 0,
      script,
      serialized,
      hash: sha256(Buffer.from(serialized, "hex")),
    };
  }

  function pushData(value) {
    const length = value.length / 2;
    if (length > 75) throw new Error("fixture push exceeds direct-push range");
    return `${length.toString(16).padStart(2, "0")}${value}`;
  }

  function withoutState(redeemScript) {
    const bytes = Buffer.from(redeemScript, "hex");
    return Buffer.concat([
      bytes.subarray(0, stateLayout.offset),
      bytes.subarray(stateLayout.offset + stateLayout.len),
    ]);
  }

  function hex(value) {
    return Buffer.from(value).toString("hex");
  }

  function sha256(value) {
    return crypto.createHash("sha256").update(value).digest("hex");
  }

}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const positional = args.filter((arg) => arg !== "--check");
  if (args.filter((arg) => arg === "--check").length > 1 || positional.length > 1 || positional.some((arg) => arg.startsWith("--")))
    throw new Error("usage: generate-covenant-fixture.mjs [pinned-checkout] [--check]");
  withPinnedSilverScript(positional[0] ?? process.env.SILVERSCRIPT_DIR, (compiler) => {
    const result = generateEscrowFixture(compiler, { check });
    console.log(JSON.stringify({ ...result, compilerProvenance: compiler.provenance() }));
  });
}
