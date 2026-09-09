#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { blake2b } from "blakejs";

const EXPECTED_COMPILER_COMMIT =
  "158534d606e9d5541e932c7575ff331e12699fb5";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRelative = "contracts/kaspa-x402-escrow-v4.sil";
const source = path.join(root, sourceRelative);
const fixtureFile = path.join(
  root,
  "contracts/fixtures/kaspa-x402-escrow-v4.json",
);
const generatedFile = path.join(
  root,
  "packages/covenant/src/generated/escrow-v4-template.ts",
);
const silverscriptRoot = path.resolve(
  process.argv[2] ??
    process.env.SILVERSCRIPT_DIR ??
    "/home/luke/projects/silverscript",
);

const compilerCommit = run("git", ["rev-parse", "HEAD"], silverscriptRoot).trim();
if (compilerCommit !== EXPECTED_COMPILER_COMMIT) {
  throw new Error(
    `SilverScript is at ${compilerCommit}; expected ${EXPECTED_COMPILER_COMMIT}`,
  );
}

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
const contract = genesisArtifact.contracts.KaspaX402EscrowV4;
const successorContract = successorArtifact.contracts.KaspaX402EscrowV4;
if (!contract || !successorContract) {
  throw new Error("silverc did not emit KaspaX402EscrowV4");
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
  templateId: "kaspa-x402-escrow-v4",
  source: sourceRelative,
  sourceSha256: sha256(fs.readFileSync(source)),
  domainTag,
  domainTagHash,
  compiler: {
    name: "silverc",
    checkedCommit: compilerCommit,
    compilerVersion: genesisArtifact.compiler_version,
    command:
      "cd <silverscript-checkout> && cargo run --quiet -p silverscript-lang --bin silverc -- <kaspa-x402-root>/contracts/kaspa-x402-escrow-v4.sil --constructor-args <args.json> -c > <out.json>",
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
export const ESCROW_V4_COMPILED_BASE = ${JSON.stringify(genesisRedeemScript)};
export const ESCROW_V4_STATE_LAYOUT = ${JSON.stringify(fixture.stateLayout)} as const;
export const ESCROW_V4_CONSTRUCTOR_SLOTS = ${JSON.stringify(
  Object.fromEntries(slots.map((item) => [item.name, item])),
  null,
  2,
)} as const;
export const ESCROW_V4_SELECTORS = ${JSON.stringify(selectors, null, 2)} as const;
export const ESCROW_V4_GENERATED_DECLARATIONS = ${JSON.stringify(
  fixture.generatedDeclarations,
  null,
  2,
)} as const;
`;

fs.mkdirSync(path.dirname(fixtureFile), { recursive: true });
fs.mkdirSync(path.dirname(generatedFile), { recursive: true });
fs.writeFileSync(fixtureFile, `${JSON.stringify(fixture, null, 2)}\n`);
fs.writeFileSync(generatedFile, generated);
console.log(
  `generated escrow-v4 fixture (${genesisRedeemScript.length / 2} bytes, ${compilerCommit.slice(0, 8)})`,
);

function compile(values) {
  const input = JSON.stringify([
    portableBytes(values.clientPublicKey),
    portableBytes(values.serverPublicKey),
    portableBytes(sha256(Buffer.from(values.network, "utf8"))),
    portableBytes(values.payoutScriptPublicKeyHash),
    portableBytes(values.refundScriptPublicKeyHash),
    portableBytes(int64Le(values.timeoutDaa)),
    { kind: "int", value: Number(values.claimedCumulativeAmount) },
  ]);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kaspa-x402-ctor-"));
  const constructorFile = path.join(tempDir, "args.json");
  try {
    fs.writeFileSync(constructorFile, input);
    const result = spawnSync(
      "cargo",
      [
        "run",
        "--quiet",
        "-p",
        "silverscript-lang",
        "--bin",
        "silverc",
        "--",
        source,
        "--constructor-args",
        constructorFile,
        "-c",
      ],
      { cwd: silverscriptRoot, encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || "silverc failed");
    }
    return JSON.parse(result.stdout);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
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

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${command} failed`);
  }
  return result.stdout;
}
