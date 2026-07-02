import { blake3 } from "@noble/hashes/blake3.js";
import { blake2b } from "blakejs";

import {
  CLAIM_COMPUTE_BUDGET,
  CLAIM_SCRIPT_UNITS_ESTIMATE,
  REFUND_COMPUTE_BUDGET,
  REFUND_SCRIPT_UNITS_ESTIMATE,
  buildClaimArgs,
  buildRefundArgs,
  bytesToHex,
  computeBudgetForScriptUnits,
  escrowScriptPubKeyHash,
  hexToBytes,
  scriptUnitAllowance,
  voucherDigest,
} from "./template.js";
import type { FundingOutpoint, NetworkId, ScriptPublicKey } from "./template.js";

export type Uint64Value = bigint | number | string;

export interface TxV1CovenantBinding {
  authorizingInput: number;
  covenantId: string;
}

export interface TxV1OutputPlan {
  amount: Uint64Value;
  scriptPublicKey: string;
}

export interface BatchClaimTxV1Input {
  network: NetworkId;
  activeOutpoint: FundingOutpoint;
  activeAmount: Uint64Value;
  activeScriptPublicKey: string;
  redeemScript: string;
  serverOutputScriptPublicKey: string;
  expectedPayoutScriptPublicKeyHash: string;
  claimAmount: Uint64Value;
  voucherAmount: Uint64Value;
  fee: Uint64Value;
  serverSignature: string | Uint8Array;
  voucherSignature: string | Uint8Array;
  computeBudget: number;
  scriptUnitsEstimate: number;
  mass?: Uint64Value;
  sequence?: Uint64Value;
  lockTime?: Uint64Value;
  subnetworkId?: string;
  gas?: Uint64Value;
  payload?: string;
  outputs?: readonly TxV1OutputPlan[];
}

export interface BatchRefundTxV1Input {
  activeOutpoint: FundingOutpoint;
  activeAmount: Uint64Value;
  activeScriptPublicKey: string;
  redeemScript: string;
  refundOutputScriptPublicKey: string;
  expectedRefundScriptPublicKeyHash: string;
  fee: Uint64Value;
  clientSignature: string | Uint8Array;
  timeoutDaa: Uint64Value;
  lockTimeDaa: Uint64Value;
  inputSequence: Uint64Value;
  computeBudget: number;
  scriptUnitsEstimate: number;
  mass?: Uint64Value;
  subnetworkId?: string;
  gas?: Uint64Value;
  payload?: string;
  outputs?: readonly TxV1OutputPlan[];
}

export interface TxV1ReferenceInput {
  previousOutpoint: FundingOutpoint;
  signatureScript: string;
  sequence: string;
  computeBudget: number;
  utxo: {
    amount: string;
    scriptPublicKey: string;
    blockDaaScore: string;
    isCoinbase: false;
  };
}

export interface TxV1ReferenceOutput {
  amount: string;
  scriptPublicKey: string;
  covenant: TxV1CovenantBinding | null;
}

export interface TxV1ReferenceTransaction {
  version: 1;
  inputs: readonly TxV1ReferenceInput[];
  outputs: readonly TxV1ReferenceOutput[];
  lockTime: string;
  subnetworkId: string;
  gas: string;
  payload: string;
  mass: string;
  estimatedSerializedSize: number;
}

export interface TxV1DigestDebug {
  preimage: string;
  digest: string;
}

export interface TxV1IdDebug {
  payloadDigest: string;
  restPreimage: string;
  restDigest: string;
  digest: string;
}

export interface TxV1SighashDebug extends TxV1DigestDebug {
  inputIndex: number;
  hashType: "all";
}

export interface BatchClaimTxV1Artifact {
  format: "kaspa-x402-tx-v1-reference-v1";
  kind: "batch-claim";
  transaction: TxV1ReferenceTransaction;
  serializedTransaction: string;
  transactionId: string;
  transactionHash: string;
  txid: TxV1IdDebug;
  hash: TxV1DigestDebug;
  sighash: TxV1SighashDebug;
  signatureScript: string;
  voucherDigest: string;
  fee: {
    amount: string;
    source: "server-output";
    claimAmount: string;
    voucherAmount: string;
    serverOutputAmount: string;
    continuationOutputAmount: string;
  };
  continuation: {
    outputIndex: 1;
    amount: string;
    scriptPublicKey: string;
    outpoint: FundingOutpoint;
  };
  compute: {
    computeBudget: number;
    scriptUnitsEstimate: number;
    scriptUnitAllowance: number;
  };
}

export interface BatchRefundTxV1Artifact {
  format: "kaspa-x402-tx-v1-reference-v1";
  kind: "batch-refund";
  transaction: TxV1ReferenceTransaction;
  serializedTransaction: string;
  transactionId: string;
  transactionHash: string;
  txid: TxV1IdDebug;
  hash: TxV1DigestDebug;
  sighash: TxV1SighashDebug;
  signatureScript: string;
  fee: {
    amount: string;
    source: "refund-output";
    refundOutputAmount: string;
  };
  compute: {
    computeBudget: number;
    scriptUnitsEstimate: number;
    scriptUnitAllowance: number;
  };
}

export interface BatchClaimTransactionBuilder {
  buildBatchClaimTxV1(input: BatchClaimTxV1Input): BatchClaimTxV1Artifact;
}

export interface BatchRefundTransactionBuilder {
  buildBatchRefundTxV1(input: BatchRefundTxV1Input): BatchRefundTxV1Artifact;
}

const FORMAT = "kaspa-x402-tx-v1-reference-v1" as const;
const NATIVE_SUBNETWORK_ID = "00".repeat(20);
const SIG_HASH_ALL = 0x01;
const ZERO_HASH = "00".repeat(32);
const STORAGE_MASS_PARAMETER = 1_000_000_000_000n;
const UTXO_CONST_STORAGE = 63n;
const UTXO_COVENANT_STORAGE = 32n;
const UTXO_UNIT_SIZE = 100n;
const U16_MAX = 0xffff;
const U32_MAX = 0xffff_ffff;
const U64_MAX = 0xffff_ffff_ffff_ffffn;

export function buildBatchClaimTxV1Artifact(input: BatchClaimTxV1Input): BatchClaimTxV1Artifact {
  requireComputeBudget(input.computeBudget, CLAIM_COMPUTE_BUDGET, "claim");
  requireScriptUnits(input.scriptUnitsEstimate, CLAIM_SCRIPT_UNITS_ESTIMATE, "claim");

  const activeAmount = normalizeUint64(input.activeAmount, "activeAmount");
  const claimAmount = normalizeUint64(input.claimAmount, "claimAmount");
  const voucherAmount = normalizeUint64(input.voucherAmount, "voucherAmount");
  const fee = normalizeUint64(input.fee, "fee");
  const serverOutputAmount = claimAmount - fee;
  const continuationOutputAmount = activeAmount - claimAmount;

  if (claimAmount > activeAmount) {
    throw new Error("claim amount cannot exceed active input amount");
  }
  if (voucherAmount > activeAmount) {
    throw new Error("voucher amount cannot exceed active input amount");
  }
  if (claimAmount > voucherAmount) {
    throw new Error("claim amount cannot exceed signed voucher amount");
  }
  if (fee >= claimAmount) {
    throw new Error("claim amount must exceed the transaction fee");
  }
  if (continuationOutputAmount === 0n) {
    throw new Error("claim continuation output must be positive");
  }

  const activeScriptPublicKey = normalizeSerializedScriptPublicKey(input.activeScriptPublicKey, "activeScriptPublicKey");
  const serverScriptPublicKey = normalizeSerializedScriptPublicKey(input.serverOutputScriptPublicKey, "serverOutputScriptPublicKey");
  const redeemScript = normalizeHex(input.redeemScript, "redeemScript");
  const expectedOutputs = [
    {
      amount: serverOutputAmount.toString(),
      scriptPublicKey: serverScriptPublicKey,
      covenant: null,
    },
    {
      amount: continuationOutputAmount.toString(),
      scriptPublicKey: activeScriptPublicKey,
      covenant: null,
    },
  ] satisfies TxV1ReferenceOutput[];
  const outputs = normalizeOutputs(input.outputs ?? expectedOutputs);

  if (outputs.length !== 2) {
    throw new Error("claim transaction must have exactly two outputs");
  }
  if (outputs[0]?.amount !== serverOutputAmount.toString()) {
    throw new Error("claim output 0 must be the server output after subtracting fees");
  }
  if (escrowScriptPubKeyHash(parseSerializedScriptPublicKey(outputs[0].scriptPublicKey, "serverOutputScriptPublicKey")) !== normalizeHash32(input.expectedPayoutScriptPublicKeyHash, "expectedPayoutScriptPublicKeyHash")) {
    throw new Error("claim output 0 script public key must match the configured payout hash");
  }
  if (outputs[1]?.amount !== continuationOutputAmount.toString()) {
    throw new Error("claim continuation output must preserve the active escrow remainder; fees must come from the server output");
  }
  if (outputs[1].scriptPublicKey !== activeScriptPublicKey) {
    throw new Error("claim output 1 must be the continuation escrow output");
  }
  const storageMass = resolveStorageMass({
    providedMass: input.mass,
    inputAmount: activeAmount,
    inputScriptPublicKey: activeScriptPublicKey,
    outputs,
  });

  const signatureScript = `${buildClaimArgs({
    serverSignature: input.serverSignature,
    voucherSignature: input.voucherSignature,
    amount: voucherAmount,
  })}${pushDataHex(redeemScript)}`;

  const transaction = buildTransaction({
    previousOutpoint: normalizeOutpoint(input.activeOutpoint),
    inputAmount: activeAmount,
    inputScriptPublicKey: activeScriptPublicKey,
    signatureScript,
    sequence: normalizeUint64(input.sequence ?? "0", "sequence"),
    computeBudget: input.computeBudget,
    outputs,
    lockTime: normalizeUint64(input.lockTime ?? "0", "lockTime"),
    subnetworkId: normalizeNativeSubnetworkId(input.subnetworkId),
    gas: normalizeZeroGas(input.gas),
    payload: normalizeHex(input.payload ?? "", "payload"),
    mass: storageMass,
  });
  const debug = buildDigestDebug(transaction);
  const voucher = voucherDigest({
    network: input.network,
    activeScriptPublicKey,
    outpoint: normalizeOutpoint(input.activeOutpoint),
    amount: voucherAmount,
  });

  return {
    format: FORMAT,
    kind: "batch-claim",
    transaction,
    serializedTransaction: debug.hash.preimage,
    transactionId: debug.txid.digest,
    transactionHash: debug.hash.digest,
    txid: debug.txid,
    hash: debug.hash,
    sighash: debug.sighash,
    signatureScript,
    voucherDigest: voucher,
    fee: {
      amount: fee.toString(),
      source: "server-output",
      claimAmount: claimAmount.toString(),
      voucherAmount: voucherAmount.toString(),
      serverOutputAmount: serverOutputAmount.toString(),
      continuationOutputAmount: continuationOutputAmount.toString(),
    },
    continuation: {
      outputIndex: 1,
      amount: continuationOutputAmount.toString(),
      scriptPublicKey: activeScriptPublicKey,
      outpoint: {
        txid: debug.txid.digest,
        index: 1,
      },
    },
    compute: {
      computeBudget: input.computeBudget,
      scriptUnitsEstimate: input.scriptUnitsEstimate,
      scriptUnitAllowance: scriptUnitAllowance(input.computeBudget),
    },
  };
}

export function buildBatchRefundTxV1Artifact(input: BatchRefundTxV1Input): BatchRefundTxV1Artifact {
  requireComputeBudget(input.computeBudget, REFUND_COMPUTE_BUDGET, "refund");
  requireScriptUnits(input.scriptUnitsEstimate, REFUND_SCRIPT_UNITS_ESTIMATE, "refund");

  const activeAmount = normalizeUint64(input.activeAmount, "activeAmount");
  const fee = normalizeUint64(input.fee, "fee");
  const timeoutDaa = normalizeUint64(input.timeoutDaa, "timeoutDaa");
  const lockTimeDaa = normalizeUint64(input.lockTimeDaa, "lockTimeDaa");
  const inputSequence = normalizeUint64(input.inputSequence, "inputSequence");
  const refundOutputAmount = activeAmount - fee;

  if (fee >= activeAmount) {
    throw new Error("refund amount must exceed the transaction fee");
  }
  if (lockTimeDaa < timeoutDaa) {
    throw new Error("refund lock time must be greater than or equal to timeoutDaa");
  }
  if (inputSequence !== 0n) {
    throw new Error("refund input sequence must be 0");
  }

  const activeScriptPublicKey = normalizeSerializedScriptPublicKey(input.activeScriptPublicKey, "activeScriptPublicKey");
  const refundScriptPublicKey = normalizeSerializedScriptPublicKey(input.refundOutputScriptPublicKey, "refundOutputScriptPublicKey");
  const redeemScript = normalizeHex(input.redeemScript, "redeemScript");
  const expectedOutputs = [
    {
      amount: refundOutputAmount.toString(),
      scriptPublicKey: refundScriptPublicKey,
      covenant: null,
    },
  ] satisfies TxV1ReferenceOutput[];
  const outputs = normalizeOutputs(input.outputs ?? expectedOutputs);

  if (outputs.length !== 1) {
    throw new Error("refund transaction must have exactly one output");
  }
  if (outputs[0]?.amount !== refundOutputAmount.toString()) {
    throw new Error("refund output amount must equal active input minus fee");
  }
  if (escrowScriptPubKeyHash(parseSerializedScriptPublicKey(outputs[0].scriptPublicKey, "refundOutputScriptPublicKey")) !== normalizeHash32(input.expectedRefundScriptPublicKeyHash, "expectedRefundScriptPublicKeyHash")) {
    throw new Error("refund output script public key must match the configured refund hash");
  }
  const storageMass = resolveStorageMass({
    providedMass: input.mass,
    inputAmount: activeAmount,
    inputScriptPublicKey: activeScriptPublicKey,
    outputs,
  });

  const signatureScript = `${buildRefundArgs({ clientSignature: input.clientSignature })}${pushDataHex(redeemScript)}`;
  const transaction = buildTransaction({
    previousOutpoint: normalizeOutpoint(input.activeOutpoint),
    inputAmount: activeAmount,
    inputScriptPublicKey: activeScriptPublicKey,
    signatureScript,
    sequence: inputSequence,
    computeBudget: input.computeBudget,
    outputs,
    lockTime: lockTimeDaa,
    subnetworkId: normalizeNativeSubnetworkId(input.subnetworkId),
    gas: normalizeZeroGas(input.gas),
    payload: normalizeHex(input.payload ?? "", "payload"),
    mass: storageMass,
  });
  const debug = buildDigestDebug(transaction);

  return {
    format: FORMAT,
    kind: "batch-refund",
    transaction,
    serializedTransaction: debug.hash.preimage,
    transactionId: debug.txid.digest,
    transactionHash: debug.hash.digest,
    txid: debug.txid,
    hash: debug.hash,
    sighash: debug.sighash,
    signatureScript,
    fee: {
      amount: fee.toString(),
      source: "refund-output",
      refundOutputAmount: refundOutputAmount.toString(),
    },
    compute: {
      computeBudget: input.computeBudget,
      scriptUnitsEstimate: input.scriptUnitsEstimate,
      scriptUnitAllowance: scriptUnitAllowance(input.computeBudget),
    },
  };
}

export const vectorBackedBatchTransactionBuilder: BatchClaimTransactionBuilder & BatchRefundTransactionBuilder = {
  buildBatchClaimTxV1: buildBatchClaimTxV1Artifact,
  buildBatchRefundTxV1: buildBatchRefundTxV1Artifact,
};

function buildTransaction(input: {
  previousOutpoint: FundingOutpoint;
  inputAmount: bigint;
  inputScriptPublicKey: string;
  signatureScript: string;
  sequence: bigint;
  computeBudget: number;
  outputs: readonly TxV1ReferenceOutput[];
  lockTime: bigint;
  subnetworkId: string;
  gas: bigint;
  payload: string;
  mass: bigint;
}): TxV1ReferenceTransaction {
  const transaction = {
    version: 1,
    inputs: [
      {
        previousOutpoint: input.previousOutpoint,
        signatureScript: input.signatureScript,
        sequence: input.sequence.toString(),
        computeBudget: input.computeBudget,
        utxo: {
          amount: input.inputAmount.toString(),
          scriptPublicKey: input.inputScriptPublicKey,
          blockDaaScore: "0",
          isCoinbase: false,
        },
      },
    ],
    outputs: input.outputs,
    lockTime: input.lockTime.toString(),
    subnetworkId: input.subnetworkId,
    gas: input.gas.toString(),
    payload: input.payload,
    mass: input.mass.toString(),
    estimatedSerializedSize: 0,
  } satisfies TxV1ReferenceTransaction;

  return {
    ...transaction,
    estimatedSerializedSize: estimatedSerializedSize(transaction),
  };
}

function buildDigestDebug(transaction: TxV1ReferenceTransaction): {
  txid: TxV1IdDebug;
  hash: TxV1DigestDebug;
  sighash: TxV1SighashDebug;
} {
  const payloadDigest = blake3Keyed("PayloadDigest", hexToBytes(transaction.payload, undefined, "payload"));
  const restPreimage = writeTransaction(transaction, { signatureScript: false, payload: false, mass: false, computeBudget: false });
  const restDigest = blake3Keyed("TransactionRest", restPreimage);
  const txidInput = concatBytes([hexToBytes(payloadDigest, 32, "payloadDigest"), hexToBytes(restDigest, 32, "restDigest")]);
  const txidDigest = blake3Keyed("TransactionV1Id", txidInput);
  const hashPreimage = writeTransaction(transaction, { signatureScript: true, payload: true, mass: true, computeBudget: true });
  const hashDigest = blake2bKeyed("TransactionHash", hashPreimage);
  const sighashPreimage = writeSighashAllPreimage(transaction, 0);
  const sighashDigest = blake2bKeyed("TransactionSigningHash", sighashPreimage);

  return {
    txid: {
      payloadDigest,
      restPreimage: bytesToHex(restPreimage),
      restDigest,
      digest: txidDigest,
    },
    hash: {
      preimage: bytesToHex(hashPreimage),
      digest: hashDigest,
    },
    sighash: {
      inputIndex: 0,
      hashType: "all",
      preimage: bytesToHex(sighashPreimage),
      digest: sighashDigest,
    },
  };
}

function writeTransaction(
  transaction: TxV1ReferenceTransaction,
  flags: { signatureScript: boolean; payload: boolean; mass: boolean; computeBudget: boolean },
): Uint8Array {
  const writer = new ByteWriter();
  writer.u16(transaction.version).len(transaction.inputs.length);
  for (const input of transaction.inputs) {
    writeOutpoint(writer, input.previousOutpoint);
    writer.varBytes(flags.signatureScript ? input.signatureScript : "");
    writer.u64(input.sequence);
    if (flags.computeBudget) {
      writer.u16(input.computeBudget);
    }
  }
  writer.len(transaction.outputs.length);
  for (const output of transaction.outputs) {
    writeOutput(writer, output, transaction.version);
  }
  writer.u64(transaction.lockTime).bytes(transaction.subnetworkId).u64(transaction.gas).varBytes(flags.payload ? transaction.payload : "");
  if (flags.mass) {
    writer.u64(transaction.mass);
  }
  return writer.finish();
}

function writeSighashAllPreimage(transaction: TxV1ReferenceTransaction, inputIndex: number): Uint8Array {
  const input = transaction.inputs[inputIndex];
  if (!input) {
    throw new Error("sighash input index is out of range");
  }
  const writer = new ByteWriter();
  writer
    .u16(transaction.version)
    .bytes(hashPreviousOutputs(transaction))
    .bytes(hashSequences(transaction));
  writeOutpoint(writer, input.previousOutpoint);
  writeScriptPublicKey(writer, parseSerializedScriptPublicKey(input.utxo.scriptPublicKey, "inputScriptPublicKey"));
  writer
    .u64(input.utxo.amount)
    .u64(input.sequence)
    .bytes(hashOutputs(transaction))
    .u64(transaction.lockTime)
    .bytes(transaction.subnetworkId)
    .u64(transaction.gas)
    .bytes(hashPayload(transaction))
    .u8(SIG_HASH_ALL);
  return writer.finish();
}

function hashPreviousOutputs(transaction: TxV1ReferenceTransaction): string {
  const writer = new ByteWriter();
  for (const input of transaction.inputs) {
    writeOutpoint(writer, input.previousOutpoint);
  }
  return blake2bKeyed("TransactionSigningHash", writer.finish());
}

function hashSequences(transaction: TxV1ReferenceTransaction): string {
  const writer = new ByteWriter();
  for (const input of transaction.inputs) {
    writer.u64(input.sequence);
  }
  return blake2bKeyed("TransactionSigningHash", writer.finish());
}

function hashOutputs(transaction: TxV1ReferenceTransaction): string {
  const writer = new ByteWriter();
  for (const output of transaction.outputs) {
    writeOutput(writer, output, transaction.version);
  }
  return blake2bKeyed("TransactionSigningHash", writer.finish());
}

function hashPayload(transaction: TxV1ReferenceTransaction): string {
  if (transaction.subnetworkId === NATIVE_SUBNETWORK_ID && transaction.payload === "") {
    return ZERO_HASH;
  }
  const writer = new ByteWriter();
  writer.varBytes(transaction.payload);
  return blake2bKeyed("TransactionSigningHash", writer.finish());
}

function writeOutpoint(writer: ByteWriter, outpoint: FundingOutpoint): void {
  writer.bytes(outpoint.txid).u32(outpoint.index);
}

function writeOutput(writer: ByteWriter, output: TxV1ReferenceOutput, version: number): void {
  writer.u64(output.amount);
  writeScriptPublicKey(writer, parseSerializedScriptPublicKey(output.scriptPublicKey, "outputScriptPublicKey"));
  if (version >= 1) {
    writer.bool(output.covenant !== null);
    if (output.covenant !== null) {
      writer.u16(output.covenant.authorizingInput).bytes(output.covenant.covenantId);
    }
  }
}

function writeScriptPublicKey(writer: ByteWriter, scriptPublicKey: ScriptPublicKey): void {
  writer.u16(scriptPublicKey.version).varBytes(scriptPublicKey.script);
}

function estimatedSerializedSize(transaction: TxV1ReferenceTransaction): number {
  const inputSize = transaction.inputs.reduce(
    (sum, input) => sum + 32 + 4 + 8 + hexToBytes(input.signatureScript, undefined, "signatureScript").byteLength + 8 + 2,
    0,
  );
  const outputSize = transaction.outputs.reduce((sum, output) => {
    const script = parseSerializedScriptPublicKey(output.scriptPublicKey, "outputScriptPublicKey").script;
    return sum + 8 + 2 + 8 + hexToBytes(script, undefined, "outputScriptPublicKey.script").byteLength + (output.covenant ? 2 + 32 : 0);
  }, 0);
  return 2 + 8 + inputSize + 8 + outputSize + 8 + 20 + 8 + 32 + 8 + hexToBytes(transaction.payload, undefined, "payload").byteLength;
}

function normalizeOutputs(outputs: readonly TxV1OutputPlan[]): TxV1ReferenceOutput[] {
  return outputs.map((output, index) => ({
    amount: normalizeUint64(output.amount, `outputs[${index}].amount`).toString(),
    scriptPublicKey: normalizeSerializedScriptPublicKey(output.scriptPublicKey, `outputs[${index}].scriptPublicKey`),
    covenant: normalizeNoCovenant((output as { covenant?: TxV1CovenantBinding | null }).covenant ?? null, `outputs[${index}].covenant`),
  }));
}

function resolveStorageMass(input: {
  providedMass?: Uint64Value;
  inputAmount: bigint;
  inputScriptPublicKey: string;
  outputs: readonly TxV1ReferenceOutput[];
}): bigint {
  const computedMass = calculateStorageMass({
    stormParam: STORAGE_MASS_PARAMETER,
    inputs: [
      {
        amount: input.inputAmount,
        scriptPublicKey: input.inputScriptPublicKey,
        hasCovenant: false,
      },
    ],
    outputs: input.outputs.map((output) => ({
      amount: normalizeUint64(output.amount, "output.amount"),
      scriptPublicKey: output.scriptPublicKey,
      hasCovenant: output.covenant !== null,
    })),
  });

  if (input.providedMass !== undefined && normalizeUint64(input.providedMass, "mass") !== computedMass) {
    throw new Error("storage mass must match contextual storage mass");
  }
  return computedMass;
}

function calculateStorageMass(input: {
  stormParam: bigint;
  inputs: readonly TxV1UtxoCellInput[];
  outputs: readonly TxV1UtxoCellInput[];
}): bigint {
  const outputCells = input.outputs.map(toUtxoCell);
  const inputCells = input.inputs.map(toUtxoCell);
  const outsPlurality = outputCells.reduce((sum, cell) => sum + cell.plurality, 0n);
  const harmonicOuts = outputCells.reduce((sum, cell) => sum + (input.stormParam * cell.plurality * cell.plurality) / cell.amount, 0n);
  const insPlurality = inputCells.reduce((sum, cell) => sum + cell.plurality, 0n);
  const relaxedFormulaPath = outsPlurality === 1n || (inputCells.length <= 2 && (insPlurality === 1n || (outsPlurality === 2n && insPlurality === 2n)));

  if (relaxedFormulaPath) {
    const harmonicIns = inputCells.reduce((sum, cell) => sum + (input.stormParam * cell.plurality * cell.plurality) / cell.amount, 0n);
    return harmonicOuts > harmonicIns ? harmonicOuts - harmonicIns : 0n;
  }

  const sumIns = inputCells.reduce((sum, cell) => sum + cell.amount, 0n);
  const meanIns = maxBigInt(sumIns / insPlurality, 1n);
  const arithmeticIns = insPlurality * (input.stormParam / meanIns);
  return harmonicOuts > arithmeticIns ? harmonicOuts - arithmeticIns : 0n;
}

interface TxV1UtxoCellInput {
  amount: bigint;
  scriptPublicKey: string;
  hasCovenant: boolean;
}

interface TxV1UtxoCell {
  amount: bigint;
  plurality: bigint;
}

function toUtxoCell(input: TxV1UtxoCellInput): TxV1UtxoCell {
  if (input.amount === 0n) {
    throw new Error("storage mass cannot be calculated for zero-value UTXO cells");
  }
  return {
    amount: input.amount,
    plurality: utxoPlurality(input.scriptPublicKey, input.hasCovenant),
  };
}

function utxoPlurality(serializedScriptPublicKey: string, hasCovenant: boolean): bigint {
  const scriptLength = BigInt(hexToBytes(parseSerializedScriptPublicKey(serializedScriptPublicKey, "scriptPublicKey").script, undefined, "scriptPublicKey.script").byteLength);
  const covenantSize = hasCovenant ? UTXO_COVENANT_STORAGE : 0n;
  return divCeil(UTXO_CONST_STORAGE + scriptLength + covenantSize, UTXO_UNIT_SIZE);
}

function normalizeNoCovenant(covenant: TxV1CovenantBinding | null, label: string): null {
  if (covenant === null) return null;
  if (!Number.isInteger(covenant.authorizingInput) || covenant.authorizingInput < 0 || covenant.authorizingInput > U16_MAX) {
    throw new Error(`${label}.authorizingInput must fit in uint16`);
  }
  normalizeHash32(covenant.covenantId, `${label}.covenantId`);
  throw new Error("transaction-v1 artifacts do not support output covenant bindings yet");
}

function normalizeOutpoint(outpoint: FundingOutpoint): FundingOutpoint {
  return {
    txid: normalizeHash32(outpoint.txid, "outpoint.txid"),
    index: normalizeUint32(outpoint.index, "outpoint.index"),
  };
}

function normalizeNativeSubnetworkId(subnetworkId = NATIVE_SUBNETWORK_ID): string {
  const normalized = bytesToHex(hexToBytes(subnetworkId, 20, "subnetworkId"));
  if (normalized !== NATIVE_SUBNETWORK_ID) {
    throw new Error("transaction-v1 artifacts must use the native subnetwork");
  }
  return normalized;
}

function normalizeZeroGas(gas: Uint64Value = "0"): bigint {
  const normalized = normalizeUint64(gas, "gas");
  if (normalized !== 0n) {
    throw new Error("transaction-v1 artifacts must use zero gas");
  }
  return normalized;
}

function parseSerializedScriptPublicKey(serialized: string, label: string): ScriptPublicKey {
  const bytes = hexToBytes(serialized, undefined, label);
  if (bytes.byteLength < 2) {
    throw new Error(`${label} must contain a uint16 version and script bytes`);
  }
  return {
    version: bytes[0] | ((bytes[1] ?? 0) << 8),
    script: bytesToHex(bytes.subarray(2)),
  };
}

function normalizeSerializedScriptPublicKey(serialized: string, label: string): string {
  const parsed = parseSerializedScriptPublicKey(serialized, label);
  if (parsed.version < 0 || parsed.version > U16_MAX) {
    throw new Error(`${label} version must fit in uint16`);
  }
  return bytesToHex(concatBytes([u16Le(parsed.version), hexToBytes(parsed.script, undefined, `${label}.script`)]));
}

function normalizeHash32(hex: string, label: string): string {
  return bytesToHex(hexToBytes(hex, 32, label));
}

function normalizeHex(hex: string, label: string): string {
  return bytesToHex(hexToBytes(hex, undefined, label));
}

function normalizeUint32(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > U32_MAX) {
    throw new Error(`${label} must fit in uint32`);
  }
  return value;
}

function normalizeUint64(value: Uint64Value, label: string): bigint {
  const normalized =
    typeof value === "bigint"
      ? value
      : typeof value === "number"
        ? numberToUint64(value, label)
        : stringToUint64(value, label);
  if (normalized < 0n || normalized > U64_MAX) {
    throw new Error(`${label} must fit in uint64`);
  }
  return normalized;
}

function numberToUint64(value: number, label: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return BigInt(value);
}

function stringToUint64(value: string, label: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${label} must be a canonical uint64 decimal string`);
  }
  return BigInt(value);
}

function divCeil(value: bigint, divisor: bigint): bigint {
  return (value + divisor - 1n) / divisor;
}

function maxBigInt(a: bigint, b: bigint): bigint {
  return a >= b ? a : b;
}

function requireComputeBudget(actual: number | undefined, expected: number, label: string): void {
  if (!Number.isInteger(actual)) {
    throw new Error(`${label} compute budget is required`);
  }
  if (actual !== expected) {
    throw new Error(`${label} compute budget must be ${expected}`);
  }
}

function requireScriptUnits(actual: number | undefined, expected: number, label: string): void {
  if (typeof actual !== "number" || !Number.isSafeInteger(actual) || actual < 0) {
    throw new Error(`${label} script-unit estimate is required`);
  }
  if (actual !== expected) {
    throw new Error(`${label} script-unit estimate must be ${expected}`);
  }
  if (computeBudgetForScriptUnits(actual) > U16_MAX) {
    throw new Error(`${label} script-unit estimate exceeds the v1 compute budget range`);
  }
}

function blake2bKeyed(domain: string, input: Uint8Array): string {
  return bytesToHex(Uint8Array.from(blake2b(input, Buffer.from(domain, "utf8"), 32)));
}

function blake3Keyed(domain: string, input: Uint8Array): string {
  const key = new Uint8Array(32);
  key.set(Buffer.from(domain, "utf8"));
  return bytesToHex(blake3(input, { key }));
}

function pushDataHex(hex: string): string {
  const data = hexToBytes(hex, undefined, "pushdata");
  if (data.byteLength <= 75) {
    return bytesToHex(concatBytes([Uint8Array.of(data.byteLength), data]));
  }
  if (data.byteLength <= 0xff) {
    return bytesToHex(concatBytes([Uint8Array.of(0x4c, data.byteLength), data]));
  }
  if (data.byteLength <= 0xffff) {
    return bytesToHex(concatBytes([Uint8Array.of(0x4d, data.byteLength & 0xff, data.byteLength >>> 8), data]));
  }
  throw new Error("pushdata payload is too large");
}

function u16Le(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff);
}

function u32Le(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function u64Le(value: bigint): Uint8Array {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(value);
  return Uint8Array.from(buffer);
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

class ByteWriter {
  readonly #parts: Uint8Array[] = [];

  bytes(hexOrBytes: string | Uint8Array): this {
    this.#parts.push(typeof hexOrBytes === "string" ? hexToBytes(hexOrBytes, undefined, "bytes") : hexOrBytes);
    return this;
  }

  varBytes(hex: string): this {
    const bytes = hexToBytes(hex, undefined, "varBytes");
    this.u64(BigInt(bytes.byteLength));
    this.#parts.push(bytes);
    return this;
  }

  len(value: number): this {
    return this.u64(BigInt(value));
  }

  bool(value: boolean): this {
    return this.u8(value ? 1 : 0);
  }

  u8(value: number): this {
    this.#parts.push(Uint8Array.of(value & 0xff));
    return this;
  }

  u16(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > U16_MAX) {
      throw new Error("value must fit in uint16");
    }
    this.#parts.push(u16Le(value));
    return this;
  }

  u32(value: number): this {
    this.#parts.push(u32Le(normalizeUint32(value, "u32")));
    return this;
  }

  u64(value: Uint64Value): this {
    this.#parts.push(u64Le(normalizeUint64(value, "u64")));
    return this;
  }

  finish(): Uint8Array {
    return concatBytes(this.#parts);
  }
}
