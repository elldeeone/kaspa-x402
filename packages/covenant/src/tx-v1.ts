import { blake3 } from "@noble/hashes/blake3.js";
import { blake2b } from "blakejs";

import {
  buildClaimV2Args,
  buildRefundV2Args,
  buildTopUpV2Args,
  bytesToHex,
  computeBudgetForScriptUnits,
  escrowV2ScriptPubKeyHash,
  hexToBytes,
  payToScriptHashScript,
  scriptUnitAllowance,
  serializedScriptPublicKey,
  voucherV2Digest,
} from "./template.js";
import type { FundingOutpoint, NetworkId, ScriptPublicKey } from "./template.js";
import { calculateKaspaStorageMass } from "./storage-mass.js";

export type Uint64Value = bigint | number | string;

export interface TxV1CovenantBinding {
  authorizingInput: number;
  covenantId: string;
}

export interface TxV1OutputPlan {
  amount: Uint64Value;
  scriptPublicKey: string;
  covenant?: TxV1CovenantBinding | null;
}

/** An ordinary Schnorr P2PK UTXO used to fund a version-1 transaction. */
export interface TxV1FundingInputPlan {
  previousOutpoint: FundingOutpoint;
  amount: Uint64Value;
  scriptPublicKey: string;
  /** Raw 64-byte Schnorr signature. SIGHASH_ALL is appended canonically. */
  signature: string | Uint8Array;
  sequence?: Uint64Value;
  computeBudget: number;
}

export interface BatchGenesisTxV1Input {
  fundingInputs: readonly TxV1FundingInputPlan[];
  escrowAmount: Uint64Value;
  escrowScriptPublicKey: string;
  escrowRedeemScript: string;
  initialSettledTotal: Uint64Value;
  /** Genesis is singleton-only. Any non-empty value is rejected. */
  changeOutputs?: readonly TxV1OutputPlan[];
  fee: Uint64Value;
  mass?: Uint64Value;
  lockTime?: Uint64Value;
  subnetworkId?: string;
  gas?: Uint64Value;
  payload?: string;
}

export interface BatchClaimTxV1Input {
  network: NetworkId;
  activeOutpoint: FundingOutpoint;
  activeAmount: Uint64Value;
  activeScriptPublicKey: string;
  activeRedeemScript: string;
  covenantId: string;
  settledTotal: Uint64Value;
  totalAuthorized: Uint64Value;
  claimAmount: Uint64Value;
  successorScriptPublicKey: string;
  successorRedeemScript: string;
  serverOutputScriptPublicKey: string;
  expectedPayoutScriptPublicKeyHash: string;
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

export interface BatchTopUpTxV1Input {
  activeOutpoint: FundingOutpoint;
  activeAmount: Uint64Value;
  activeScriptPublicKey: string;
  activeRedeemScript: string;
  covenantId: string;
  settledTotal: Uint64Value;
  successorAmount: Uint64Value;
  successorScriptPublicKey: string;
  successorRedeemScript: string;
  clientSignature: string | Uint8Array;
  fundingInputs: readonly TxV1FundingInputPlan[];
  changeOutputs?: readonly TxV1OutputPlan[];
  expectedRefundScriptPublicKeyHash: string;
  fee: Uint64Value;
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
  activeRedeemScript: string;
  covenantId: string;
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
    covenantId: string | null;
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

export interface TxV1SignatureEvidence {
  publicKey: string;
  signature: string;
  hashType: 1;
  digest: string;
}

interface TxV1ArtifactBase {
  format: "kaspa-x402-tx-v1-reference-v2";
  transaction: TxV1ReferenceTransaction;
  serializedTransaction: string;
  transactionId: string;
  transactionHash: string;
  txid: TxV1IdDebug;
  hash: TxV1DigestDebug;
  sighashes: readonly TxV1SighashDebug[];
}

export interface BatchGenesisTxV1Artifact extends TxV1ArtifactBase {
  kind: "batch-genesis";
  covenantId: string;
  fee: { amount: string; source: "funding-inputs" };
  escrow: {
    outputIndex: 0;
    amount: string;
    scriptPublicKey: string;
    redeemScript: string;
    settledTotal: "0";
    outpoint: FundingOutpoint;
  };
}

export interface BatchClaimTxV1Artifact extends TxV1ArtifactBase {
  kind: "batch-claim";
  signatureScript: string;
  voucherDigest: string;
  fee: {
    amount: string;
    source: "server-output";
    claimAmount: string;
    totalAuthorized: string;
    serverOutputAmount: string;
    continuationOutputAmount: string;
  };
  continuation: {
    outputIndex: 1;
    amount: string;
    scriptPublicKey: string;
    redeemScript: string;
    covenantId: string;
    settledTotal: string;
    outpoint: FundingOutpoint;
  };
  compute: TxV1ComputeEvidence;
}

export interface BatchTopUpTxV1Artifact extends TxV1ArtifactBase {
  kind: "batch-top-up";
  signatureScript: string;
  fee: { amount: string; source: "funding-inputs" };
  continuation: {
    outputIndex: 0;
    amount: string;
    scriptPublicKey: string;
    redeemScript: string;
    covenantId: string;
    settledTotal: string;
    outpoint: FundingOutpoint;
  };
  compute: TxV1ComputeEvidence;
}

export interface BatchRefundTxV1Artifact extends TxV1ArtifactBase {
  kind: "batch-refund";
  signatureScript: string;
  covenantId: string;
  fee: {
    amount: string;
    source: "refund-output";
    refundOutputAmount: string;
  };
  compute: TxV1ComputeEvidence;
}

export interface TxV1ComputeEvidence {
  computeBudget: number;
  scriptUnitsEstimate: number;
  scriptUnitAllowance: number;
}

export interface BatchGenesisTransactionBuilder {
  buildBatchGenesisTxV1(input: BatchGenesisTxV1Input): BatchGenesisTxV1Artifact;
}

export interface BatchClaimTransactionBuilder {
  buildBatchClaimTxV1(input: BatchClaimTxV1Input): BatchClaimTxV1Artifact;
}

export interface BatchTopUpTransactionBuilder {
  buildBatchTopUpTxV1(input: BatchTopUpTxV1Input): BatchTopUpTxV1Artifact;
}

export interface BatchRefundTransactionBuilder {
  buildBatchRefundTxV1(input: BatchRefundTxV1Input): BatchRefundTxV1Artifact;
}

const FORMAT = "kaspa-x402-tx-v1-reference-v2" as const;
const NATIVE_SUBNETWORK_ID = "00".repeat(20);
const SIG_HASH_ALL = 0x01;
const ZERO_HASH = "00".repeat(32);
const U16_MAX = 0xffff;
const U32_MAX = 0xffff_ffff;
const U64_MAX = 0xffff_ffff_ffff_ffffn;
const I64_MAX = 0x7fff_ffff_ffff_ffffn;

/** Canonical v1 budget used by Rusty Kaspa's Schnorr P2PK signer. */
export const TX_V1_P2PK_COMPUTE_BUDGET = 10;

/** Recomputes Rusty Kaspa's version-1 transaction ID. */
export function transactionV1Id(transaction: TxV1ReferenceTransaction): string {
  return buildDigestDebug(transaction).txid.digest;
}

/** Recomputes one version-1 SIGHASH_ALL preimage without assuming its script type. */
export function transactionV1Sighash(transaction: TxV1ReferenceTransaction, inputIndex: number): TxV1SighashDebug {
  if (!transaction.inputs[inputIndex]) throw new Error("sighash input index is out of range");
  const preimage = writeSighashAllPreimage(transaction, inputIndex);
  return {
    inputIndex,
    hashType: "all",
    preimage: bytesToHex(preimage),
    digest: blake2bKeyed("TransactionSigningHash", preimage),
  };
}

/** Recomputes the version-1 Schnorr SIGHASH_ALL evidence for a P2PK input. */
export function transactionV1SchnorrSignatureEvidence(
  transaction: TxV1ReferenceTransaction,
  inputIndex: number,
): TxV1SignatureEvidence {
  const input = transaction.inputs[inputIndex];
  if (!input) throw new Error("sighash input index is out of range");
  const signatureScript = hexToBytes(input.signatureScript, undefined, "signatureScript");
  if (signatureScript.byteLength !== 66 || signatureScript[0] !== 65 || signatureScript[65] !== SIG_HASH_ALL) {
    throw new Error("transaction-v1 P2PK input must use a canonical 65-byte Schnorr SIGHASH_ALL push");
  }
  const publicKey = p2pkPublicKey(input.utxo.scriptPublicKey, "inputScriptPublicKey");
  return {
    publicKey,
    signature: bytesToHex(signatureScript.slice(1, 65)),
    hashType: SIG_HASH_ALL,
    digest: transactionV1Sighash(transaction, inputIndex).digest,
  };
}

/** Canonically pushes a raw 64-byte Schnorr signature with SIGHASH_ALL. */
export function buildTxV1P2pkSignatureScript(signature: string | Uint8Array): string {
  const raw = bytesFromHexOrBytes(signature, 64, "signature");
  return bytesToHex(concatBytes([Uint8Array.of(65), raw, Uint8Array.of(SIG_HASH_ALL)]));
}

/**
 * Mirrors rusty-kaspa's KIP-20 `covenant_id` calculation. Covenant bindings
 * themselves are excluded to avoid self-reference.
 */
export function transactionV1CovenantId(
  genesisOutpoint: FundingOutpoint,
  authorizedOutputs: readonly { index: number; output: TxV1OutputPlan | TxV1ReferenceOutput }[],
): string {
  if (authorizedOutputs.length === 0) throw new Error("genesis covenant group must contain at least one output");
  const outpoint = normalizeOutpoint(genesisOutpoint);
  const writer = new ByteWriter().bytes(outpoint.txid).u32(outpoint.index).len(authorizedOutputs.length);
  let prior = -1;
  for (const item of authorizedOutputs) {
    const index = normalizeUint32(item.index, "authorized output index");
    if (index <= prior) throw new Error("genesis covenant output indices must be strictly increasing");
    prior = index;
    const amount = normalizeUint64(item.output.amount, `authorizedOutputs[${index}].amount`);
    const script = parseSerializedScriptPublicKey(item.output.scriptPublicKey, `authorizedOutputs[${index}].scriptPublicKey`);
    writer.u32(index).u64(amount).u16(script.version).varBytes(script.script);
  }
  const covenantId = blake2bKeyed("CovenantID", writer.finish());
  if (covenantId === ZERO_HASH) throw new Error("derived covenantId must not be zero");
  return covenantId;
}

export function buildBatchGenesisTxV1Artifact(input: BatchGenesisTxV1Input): BatchGenesisTxV1Artifact {
  if (input.fundingInputs.length === 0) throw new Error("batch genesis requires at least one funding input");
  const initialSettledTotal = normalizeNonNegativeInt64(input.initialSettledTotal, "initialSettledTotal");
  if (initialSettledTotal !== 0n) throw new Error("batch genesis settled total must be 0");

  const escrowAmount = normalizePositiveInt64(input.escrowAmount, "escrowAmount");
  const fee = normalizeUint64(input.fee, "fee");
  const escrowScriptPublicKey = normalizeSerializedScriptPublicKey(input.escrowScriptPublicKey, "escrowScriptPublicKey");
  const escrowRedeemScript = normalizeHex(input.escrowRedeemScript, "escrowRedeemScript");
  assertRedeemScriptPublicKey(escrowRedeemScript, escrowScriptPublicKey, "escrow");

  const inputs = input.fundingInputs.map((funding, index) => normalizeFundingInput(funding, index));
  const changeOutputs = normalizeOutputs(input.changeOutputs ?? []);
  if (changeOutputs.length !== 0) {
    throw new Error("batch genesis must have exactly one output; change outputs are not allowed");
  }
  const inputTotal = sumUint64(inputs.map((item) => BigInt(item.utxo.amount)), "genesis input total");
  if (inputTotal !== escrowAmount + fee) {
    throw new Error("batch genesis funding inputs must equal escrow plus fee");
  }

  const unboundEscrow = {
    amount: escrowAmount.toString(),
    scriptPublicKey: escrowScriptPublicKey,
    covenant: null,
  } satisfies TxV1ReferenceOutput;
  const covenantId = transactionV1CovenantId(inputs[0]!.previousOutpoint, [{ index: 0, output: unboundEscrow }]);
  const outputs = [
    {
      ...unboundEscrow,
      covenant: { authorizingInput: 0, covenantId },
    },
  ] satisfies TxV1ReferenceOutput[];
  const mass = resolveStorageMass({ providedMass: input.mass, inputs, outputs });
  const transaction = buildTransaction({
    inputs,
    outputs,
    lockTime: normalizeUint64(input.lockTime ?? "0", "lockTime"),
    subnetworkId: normalizeNativeSubnetworkId(input.subnetworkId),
    gas: normalizeZeroGas(input.gas),
    payload: normalizeHex(input.payload ?? "", "payload"),
    mass,
  });
  const debug = buildDigestDebug(transaction);

  return {
    format: FORMAT,
    kind: "batch-genesis",
    transaction,
    serializedTransaction: debug.hash.preimage,
    transactionId: debug.txid.digest,
    transactionHash: debug.hash.digest,
    txid: debug.txid,
    hash: debug.hash,
    sighashes: debug.sighashes,
    covenantId,
    fee: { amount: fee.toString(), source: "funding-inputs" },
    escrow: {
      outputIndex: 0,
      amount: escrowAmount.toString(),
      scriptPublicKey: escrowScriptPublicKey,
      redeemScript: escrowRedeemScript,
      settledTotal: "0",
      outpoint: { txid: debug.txid.digest, index: 0 },
    },
  };
}

export function buildBatchClaimTxV1Artifact(input: BatchClaimTxV1Input): BatchClaimTxV1Artifact {
  const compute = normalizeComputeEvidence(input.computeBudget, input.scriptUnitsEstimate, "claim");
  const activeAmount = normalizePositiveInt64(input.activeAmount, "activeAmount");
  const settledTotal = normalizeNonNegativeInt64(input.settledTotal, "settledTotal");
  const totalAuthorized = normalizeNonNegativeInt64(input.totalAuthorized, "totalAuthorized");
  const claimAmount = normalizeNonNegativeInt64(input.claimAmount, "claimAmount");
  const fee = normalizeUint64(input.fee, "fee");
  const covenantId = normalizeNonzeroHash32(input.covenantId, "covenantId");

  if (totalAuthorized <= settledTotal) throw new Error("signed cumulative ceiling must exceed settled total");
  if (claimAmount === 0n) throw new Error("claim amount must be positive");
  if (claimAmount > totalAuthorized - settledTotal) {
    throw new Error("claim amount exceeds the remaining signed cumulative ceiling");
  }
  const successorSettledTotal = settledTotal + claimAmount;
  if (successorSettledTotal > I64_MAX) throw new Error("successor settled total must fit signed int64");
  if (claimAmount >= activeAmount) throw new Error("claim continuation output must be positive");
  if (fee >= claimAmount) throw new Error("claim amount must exceed the transaction fee");

  const activeScriptPublicKey = normalizeSerializedScriptPublicKey(input.activeScriptPublicKey, "activeScriptPublicKey");
  const activeRedeemScript = normalizeHex(input.activeRedeemScript, "activeRedeemScript");
  const successorScriptPublicKey = normalizeSerializedScriptPublicKey(input.successorScriptPublicKey, "successorScriptPublicKey");
  const successorRedeemScript = normalizeHex(input.successorRedeemScript, "successorRedeemScript");
  const serverScriptPublicKey = normalizeSerializedScriptPublicKey(input.serverOutputScriptPublicKey, "serverOutputScriptPublicKey");
  assertRedeemScriptPublicKey(activeRedeemScript, activeScriptPublicKey, "active");
  assertRedeemScriptPublicKey(successorRedeemScript, successorScriptPublicKey, "successor");
  if (
    escrowV2ScriptPubKeyHash(parseSerializedScriptPublicKey(serverScriptPublicKey, "serverOutputScriptPublicKey")) !==
    normalizeHash32(input.expectedPayoutScriptPublicKeyHash, "expectedPayoutScriptPublicKeyHash")
  ) {
    throw new Error("claim output 0 script public key must match the configured payout hash");
  }

  const serverOutputAmount = claimAmount - fee;
  const continuationOutputAmount = activeAmount - claimAmount;
  const expectedOutputs = [
    { amount: serverOutputAmount.toString(), scriptPublicKey: serverScriptPublicKey, covenant: null },
    {
      amount: continuationOutputAmount.toString(),
      scriptPublicKey: successorScriptPublicKey,
      covenant: { authorizingInput: 0, covenantId },
    },
  ] satisfies TxV1ReferenceOutput[];
  const outputs = normalizeOutputs(input.outputs ?? expectedOutputs);
  assertExactOutputs(outputs, expectedOutputs, "claim");

  const signatureScript = `${buildClaimV2Args({
    serverSignature: input.serverSignature,
    voucherSignature: input.voucherSignature,
    totalAuthorized,
    claimAmount,
  })}${pushDataHex(activeRedeemScript)}`;
  const inputs = [
    buildReferenceInput({
      previousOutpoint: input.activeOutpoint,
      amount: activeAmount,
      scriptPublicKey: activeScriptPublicKey,
      signatureScript,
      sequence: input.sequence ?? "0",
      computeBudget: input.computeBudget,
      covenantId,
    }),
  ];
  const mass = resolveStorageMass({ providedMass: input.mass, inputs, outputs });
  const transaction = buildTransaction({
    inputs,
    outputs,
    lockTime: normalizeUint64(input.lockTime ?? "0", "lockTime"),
    subnetworkId: normalizeNativeSubnetworkId(input.subnetworkId),
    gas: normalizeZeroGas(input.gas),
    payload: normalizeHex(input.payload ?? "", "payload"),
    mass,
  });
  const debug = buildDigestDebug(transaction);
  const voucher = voucherV2Digest({ network: input.network, covenantId, totalAuthorized });

  return {
    format: FORMAT,
    kind: "batch-claim",
    transaction,
    serializedTransaction: debug.hash.preimage,
    transactionId: debug.txid.digest,
    transactionHash: debug.hash.digest,
    txid: debug.txid,
    hash: debug.hash,
    sighashes: debug.sighashes,
    signatureScript,
    voucherDigest: voucher,
    fee: {
      amount: fee.toString(),
      source: "server-output",
      claimAmount: claimAmount.toString(),
      totalAuthorized: totalAuthorized.toString(),
      serverOutputAmount: serverOutputAmount.toString(),
      continuationOutputAmount: continuationOutputAmount.toString(),
    },
    continuation: {
      outputIndex: 1,
      amount: continuationOutputAmount.toString(),
      scriptPublicKey: successorScriptPublicKey,
      redeemScript: successorRedeemScript,
      covenantId,
      settledTotal: successorSettledTotal.toString(),
      outpoint: { txid: debug.txid.digest, index: 1 },
    },
    compute,
  };
}

export function buildBatchTopUpTxV1Artifact(input: BatchTopUpTxV1Input): BatchTopUpTxV1Artifact {
  if (input.fundingInputs.length === 0) throw new Error("batch top-up requires at least one P2PK funding input");
  const compute = normalizeComputeEvidence(input.computeBudget, input.scriptUnitsEstimate, "top-up");
  const activeAmount = normalizePositiveInt64(input.activeAmount, "activeAmount");
  const successorAmount = normalizePositiveInt64(input.successorAmount, "successorAmount");
  const settledTotal = normalizeNonNegativeInt64(input.settledTotal, "settledTotal");
  const fee = normalizeUint64(input.fee, "fee");
  const covenantId = normalizeNonzeroHash32(input.covenantId, "covenantId");
  if (successorAmount <= activeAmount) throw new Error("top-up successor amount must exceed the active amount");

  const activeScriptPublicKey = normalizeSerializedScriptPublicKey(input.activeScriptPublicKey, "activeScriptPublicKey");
  const activeRedeemScript = normalizeHex(input.activeRedeemScript, "activeRedeemScript");
  const successorScriptPublicKey = normalizeSerializedScriptPublicKey(input.successorScriptPublicKey, "successorScriptPublicKey");
  const successorRedeemScript = normalizeHex(input.successorRedeemScript, "successorRedeemScript");
  assertRedeemScriptPublicKey(activeRedeemScript, activeScriptPublicKey, "active");
  assertRedeemScriptPublicKey(successorRedeemScript, successorScriptPublicKey, "successor");
  if (successorScriptPublicKey !== activeScriptPublicKey || successorRedeemScript !== activeRedeemScript) {
    throw new Error("top-up must preserve the current covenant state and script");
  }

  const changeOutputs = normalizeOutputs(input.changeOutputs ?? []);
  if (changeOutputs.length > 1) throw new Error("top-up supports at most one client change output");
  if (changeOutputs.some((output) => output.covenant !== null)) throw new Error("top-up change outputs must be unbound");
  if (
    changeOutputs[0] &&
    escrowV2ScriptPubKeyHash(parseSerializedScriptPublicKey(changeOutputs[0].scriptPublicKey, "topUpChangeScriptPublicKey")) !==
      normalizeHash32(input.expectedRefundScriptPublicKeyHash, "expectedRefundScriptPublicKeyHash")
  ) {
    throw new Error("top-up change output must match the configured refund hash");
  }
  const expectedOutputs = [
    {
      amount: successorAmount.toString(),
      scriptPublicKey: successorScriptPublicKey,
      covenant: { authorizingInput: 0, covenantId },
    },
    ...changeOutputs,
  ] satisfies TxV1ReferenceOutput[];
  const outputs = normalizeOutputs(input.outputs ?? expectedOutputs);
  assertExactOutputs(outputs, expectedOutputs, "top-up");

  const signatureScript = `${buildTopUpV2Args({ clientSignature: input.clientSignature })}${pushDataHex(activeRedeemScript)}`;
  const inputs = [
    buildReferenceInput({
      previousOutpoint: input.activeOutpoint,
      amount: activeAmount,
      scriptPublicKey: activeScriptPublicKey,
      signatureScript,
      sequence: input.sequence ?? "0",
      computeBudget: input.computeBudget,
      covenantId,
    }),
    ...input.fundingInputs.map((funding, index) => normalizeFundingInput(funding, index)),
  ];
  const inputTotal = sumUint64(inputs.map((item) => BigInt(item.utxo.amount)), "top-up input total");
  const outputTotal = sumUint64(outputs.map((item) => BigInt(item.amount)), "top-up output total");
  if (inputTotal !== outputTotal + fee) throw new Error("top-up inputs must equal outputs plus fee");

  const mass = resolveStorageMass({ providedMass: input.mass, inputs, outputs });
  const transaction = buildTransaction({
    inputs,
    outputs,
    lockTime: normalizeUint64(input.lockTime ?? "0", "lockTime"),
    subnetworkId: normalizeNativeSubnetworkId(input.subnetworkId),
    gas: normalizeZeroGas(input.gas),
    payload: normalizeHex(input.payload ?? "", "payload"),
    mass,
  });
  const debug = buildDigestDebug(transaction);

  return {
    format: FORMAT,
    kind: "batch-top-up",
    transaction,
    serializedTransaction: debug.hash.preimage,
    transactionId: debug.txid.digest,
    transactionHash: debug.hash.digest,
    txid: debug.txid,
    hash: debug.hash,
    sighashes: debug.sighashes,
    signatureScript,
    fee: { amount: fee.toString(), source: "funding-inputs" },
    continuation: {
      outputIndex: 0,
      amount: successorAmount.toString(),
      scriptPublicKey: successorScriptPublicKey,
      redeemScript: successorRedeemScript,
      covenantId,
      settledTotal: settledTotal.toString(),
      outpoint: { txid: debug.txid.digest, index: 0 },
    },
    compute,
  };
}

export function buildBatchRefundTxV1Artifact(input: BatchRefundTxV1Input): BatchRefundTxV1Artifact {
  const compute = normalizeComputeEvidence(input.computeBudget, input.scriptUnitsEstimate, "refund");
  const activeAmount = normalizePositiveInt64(input.activeAmount, "activeAmount");
  const fee = normalizeUint64(input.fee, "fee");
  const timeoutDaa = normalizeUint64(input.timeoutDaa, "timeoutDaa");
  const lockTimeDaa = normalizeUint64(input.lockTimeDaa, "lockTimeDaa");
  const inputSequence = normalizeUint64(input.inputSequence, "inputSequence");
  const covenantId = normalizeNonzeroHash32(input.covenantId, "covenantId");
  if (timeoutDaa >= 500_000_000_000n || lockTimeDaa >= 500_000_000_000n) {
    throw new Error("refund DAA lock times must remain below the consensus timestamp boundary");
  }
  if (fee >= activeAmount) throw new Error("refund amount must exceed the transaction fee");
  if (lockTimeDaa < timeoutDaa) throw new Error("refund lock time must be greater than or equal to timeoutDaa");
  if (inputSequence !== 0n) throw new Error("refund input sequence must be 0");

  const activeScriptPublicKey = normalizeSerializedScriptPublicKey(input.activeScriptPublicKey, "activeScriptPublicKey");
  const activeRedeemScript = normalizeHex(input.activeRedeemScript, "activeRedeemScript");
  const refundScriptPublicKey = normalizeSerializedScriptPublicKey(input.refundOutputScriptPublicKey, "refundOutputScriptPublicKey");
  assertRedeemScriptPublicKey(activeRedeemScript, activeScriptPublicKey, "active");
  if (
    escrowV2ScriptPubKeyHash(parseSerializedScriptPublicKey(refundScriptPublicKey, "refundOutputScriptPublicKey")) !==
    normalizeHash32(input.expectedRefundScriptPublicKeyHash, "expectedRefundScriptPublicKeyHash")
  ) {
    throw new Error("refund output script public key must match the configured refund hash");
  }

  const refundOutputAmount = activeAmount - fee;
  const expectedOutputs = [{ amount: refundOutputAmount.toString(), scriptPublicKey: refundScriptPublicKey, covenant: null }];
  const outputs = normalizeOutputs(input.outputs ?? expectedOutputs);
  assertExactOutputs(outputs, expectedOutputs, "refund");
  const signatureScript = `${buildRefundV2Args({ clientSignature: input.clientSignature })}${pushDataHex(activeRedeemScript)}`;
  const inputs = [
    buildReferenceInput({
      previousOutpoint: input.activeOutpoint,
      amount: activeAmount,
      scriptPublicKey: activeScriptPublicKey,
      signatureScript,
      sequence: inputSequence,
      computeBudget: input.computeBudget,
      covenantId,
    }),
  ];
  const mass = resolveStorageMass({ providedMass: input.mass, inputs, outputs });
  const transaction = buildTransaction({
    inputs,
    outputs,
    lockTime: lockTimeDaa,
    subnetworkId: normalizeNativeSubnetworkId(input.subnetworkId),
    gas: normalizeZeroGas(input.gas),
    payload: normalizeHex(input.payload ?? "", "payload"),
    mass,
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
    sighashes: debug.sighashes,
    signatureScript,
    covenantId,
    fee: { amount: fee.toString(), source: "refund-output", refundOutputAmount: refundOutputAmount.toString() },
    compute,
  };
}

export const vectorBackedBatchTransactionBuilder: BatchGenesisTransactionBuilder &
  BatchClaimTransactionBuilder &
  BatchTopUpTransactionBuilder &
  BatchRefundTransactionBuilder = {
  buildBatchGenesisTxV1: buildBatchGenesisTxV1Artifact,
  buildBatchClaimTxV1: buildBatchClaimTxV1Artifact,
  buildBatchTopUpTxV1: buildBatchTopUpTxV1Artifact,
  buildBatchRefundTxV1: buildBatchRefundTxV1Artifact,
};

function buildTransaction(input: {
  inputs: readonly TxV1ReferenceInput[];
  outputs: readonly TxV1ReferenceOutput[];
  lockTime: bigint;
  subnetworkId: string;
  gas: bigint;
  payload: string;
  mass: bigint;
}): TxV1ReferenceTransaction {
  if (input.inputs.length === 0) throw new Error("transaction-v1 requires at least one input");
  if (input.outputs.length === 0) throw new Error("transaction-v1 requires at least one output");
  const transaction = {
    version: 1,
    inputs: input.inputs,
    outputs: input.outputs,
    lockTime: input.lockTime.toString(),
    subnetworkId: input.subnetworkId,
    gas: input.gas.toString(),
    payload: input.payload,
    mass: input.mass.toString(),
    estimatedSerializedSize: 0,
  } satisfies TxV1ReferenceTransaction;
  return { ...transaction, estimatedSerializedSize: estimatedSerializedSize(transaction) };
}

function buildReferenceInput(input: {
  previousOutpoint: FundingOutpoint;
  amount: Uint64Value;
  scriptPublicKey: string;
  signatureScript: string;
  sequence: Uint64Value;
  computeBudget: number;
  covenantId: string | null;
}): TxV1ReferenceInput {
  const computeBudget = normalizeUint16(input.computeBudget, "computeBudget");
  return {
    previousOutpoint: normalizeOutpoint(input.previousOutpoint),
    signatureScript: normalizeHex(input.signatureScript, "signatureScript"),
    sequence: normalizeUint64(input.sequence, "sequence").toString(),
    computeBudget,
    utxo: {
      amount: normalizePositiveUint64(input.amount, "input amount").toString(),
      scriptPublicKey: normalizeSerializedScriptPublicKey(input.scriptPublicKey, "input scriptPublicKey"),
      blockDaaScore: "0",
      isCoinbase: false,
      covenantId: input.covenantId === null ? null : normalizeNonzeroHash32(input.covenantId, "input covenantId"),
    },
  };
}

function normalizeFundingInput(input: TxV1FundingInputPlan, index: number): TxV1ReferenceInput {
  const scriptPublicKey = normalizeSerializedScriptPublicKey(input.scriptPublicKey, `fundingInputs[${index}].scriptPublicKey`);
  p2pkPublicKey(scriptPublicKey, `fundingInputs[${index}].scriptPublicKey`);
  if (input.computeBudget !== TX_V1_P2PK_COMPUTE_BUDGET) {
    throw new Error(`fundingInputs[${index}].computeBudget must be ${TX_V1_P2PK_COMPUTE_BUDGET}`);
  }
  return buildReferenceInput({
    previousOutpoint: input.previousOutpoint,
    amount: input.amount,
    scriptPublicKey,
    signatureScript: buildTxV1P2pkSignatureScript(input.signature),
    sequence: input.sequence ?? "0",
    computeBudget: TX_V1_P2PK_COMPUTE_BUDGET,
    covenantId: null,
  });
}

function buildDigestDebug(transaction: TxV1ReferenceTransaction): {
  txid: TxV1IdDebug;
  hash: TxV1DigestDebug;
  sighashes: readonly TxV1SighashDebug[];
} {
  const payloadDigest = blake3Keyed("PayloadDigest", hexToBytes(transaction.payload, undefined, "payload"));
  const restPreimage = writeTransaction(transaction, { signatureScript: false, payload: false, mass: false, computeBudget: false });
  const restDigest = blake3Keyed("TransactionRest", restPreimage);
  const txidInput = concatBytes([hexToBytes(payloadDigest, 32, "payloadDigest"), hexToBytes(restDigest, 32, "restDigest")]);
  const txidDigest = blake3Keyed("TransactionV1Id", txidInput);
  const hashPreimage = writeTransaction(transaction, { signatureScript: true, payload: true, mass: true, computeBudget: true });
  const hashDigest = blake2bKeyed("TransactionHash", hashPreimage);
  return {
    txid: {
      payloadDigest,
      restPreimage: bytesToHex(restPreimage),
      restDigest,
      digest: txidDigest,
    },
    hash: { preimage: bytesToHex(hashPreimage), digest: hashDigest },
    sighashes: transaction.inputs.map((_, index) => transactionV1Sighash(transaction, index)),
  };
}

function writeTransaction(
  transaction: TxV1ReferenceTransaction,
  flags: { signatureScript: boolean; payload: boolean; mass: boolean; computeBudget: boolean },
): Uint8Array {
  const writer = new ByteWriter().u16(transaction.version).len(transaction.inputs.length);
  for (const input of transaction.inputs) {
    writeOutpoint(writer, input.previousOutpoint);
    writer.varBytes(flags.signatureScript ? input.signatureScript : "").u64(input.sequence);
    if (flags.computeBudget) writer.u16(input.computeBudget);
  }
  writer.len(transaction.outputs.length);
  for (const output of transaction.outputs) writeOutput(writer, output, transaction.version);
  writer.u64(transaction.lockTime).bytes(transaction.subnetworkId).u64(transaction.gas).varBytes(flags.payload ? transaction.payload : "");
  if (flags.mass) writer.u64(transaction.mass);
  return writer.finish();
}

function writeSighashAllPreimage(transaction: TxV1ReferenceTransaction, inputIndex: number): Uint8Array {
  const input = transaction.inputs[inputIndex];
  if (!input) throw new Error("sighash input index is out of range");
  const writer = new ByteWriter().u16(transaction.version).bytes(hashPreviousOutputs(transaction)).bytes(hashSequences(transaction));
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
  for (const input of transaction.inputs) writeOutpoint(writer, input.previousOutpoint);
  return blake2bKeyed("TransactionSigningHash", writer.finish());
}

function hashSequences(transaction: TxV1ReferenceTransaction): string {
  const writer = new ByteWriter();
  for (const input of transaction.inputs) writer.u64(input.sequence);
  return blake2bKeyed("TransactionSigningHash", writer.finish());
}

function hashOutputs(transaction: TxV1ReferenceTransaction): string {
  const writer = new ByteWriter();
  for (const output of transaction.outputs) writeOutput(writer, output, transaction.version);
  return blake2bKeyed("TransactionSigningHash", writer.finish());
}

function hashPayload(transaction: TxV1ReferenceTransaction): string {
  if (transaction.subnetworkId === NATIVE_SUBNETWORK_ID && transaction.payload === "") return ZERO_HASH;
  return blake2bKeyed("TransactionSigningHash", new ByteWriter().varBytes(transaction.payload).finish());
}

function writeOutpoint(writer: ByteWriter, outpoint: FundingOutpoint): void {
  writer.bytes(outpoint.txid).u32(outpoint.index);
}

function writeOutput(writer: ByteWriter, output: TxV1ReferenceOutput, version: number): void {
  writer.u64(output.amount);
  writeScriptPublicKey(writer, parseSerializedScriptPublicKey(output.scriptPublicKey, "outputScriptPublicKey"));
  if (version >= 1) {
    writer.bool(output.covenant !== null);
    if (output.covenant !== null) writer.u16(output.covenant.authorizingInput).bytes(output.covenant.covenantId);
  }
}

function writeScriptPublicKey(writer: ByteWriter, scriptPublicKey: ScriptPublicKey): void {
  // Consensus hash preimages encode the version little-endian, unlike the
  // big-endian serialized interchange form used by the public artifacts.
  writer.u16(scriptPublicKey.version).varBytes(scriptPublicKey.script);
}

function estimatedSerializedSize(transaction: TxV1ReferenceTransaction): number {
  const inputSize = transaction.inputs.reduce(
    (sum, input) => sum + 32 + 4 + 8 + hexToBytes(input.signatureScript, undefined, "signatureScript").byteLength + 8 + 2,
    0,
  );
  const outputSize = transaction.outputs.reduce((sum, output) => {
    const script = parseSerializedScriptPublicKey(output.scriptPublicKey, "outputScriptPublicKey").script;
    // Mirrors rusty-kaspa's deterministic mass estimate, including its
    // covenant payload but not the presence flag used by hash serialization.
    return sum + 8 + 2 + 8 + hexToBytes(script, undefined, "outputScriptPublicKey.script").byteLength + (output.covenant ? 2 + 32 : 0);
  }, 0);
  return 2 + 8 + inputSize + 8 + outputSize + 8 + 20 + 8 + 32 + 8 + hexToBytes(transaction.payload, undefined, "payload").byteLength;
}

function normalizeOutputs(outputs: readonly TxV1OutputPlan[]): TxV1ReferenceOutput[] {
  return outputs.map((output, index) => ({
    amount: normalizePositiveUint64(output.amount, `outputs[${index}].amount`).toString(),
    scriptPublicKey: normalizeSerializedScriptPublicKey(output.scriptPublicKey, `outputs[${index}].scriptPublicKey`),
    covenant: normalizeCovenant(output.covenant ?? null, `outputs[${index}].covenant`),
  }));
}

function assertExactOutputs(
  actual: readonly TxV1ReferenceOutput[],
  expected: readonly TxV1ReferenceOutput[],
  label: string,
): void {
  if (actual.length !== expected.length) throw new Error(`${label} transaction must have exactly ${expected.length} outputs`);
  for (let index = 0; index < expected.length; index += 1) {
    const left = actual[index]!;
    const right = expected[index]!;
    if (
      left.amount !== right.amount ||
      left.scriptPublicKey !== right.scriptPublicKey ||
      left.covenant?.authorizingInput !== right.covenant?.authorizingInput ||
      left.covenant?.covenantId !== right.covenant?.covenantId ||
      (left.covenant === null) !== (right.covenant === null)
    ) {
      throw new Error(`${label} output ${index} does not match the canonical topology`);
    }
  }
}

function normalizeCovenant(covenant: TxV1CovenantBinding | null, label: string): TxV1CovenantBinding | null {
  if (covenant === null) return null;
  return {
    authorizingInput: normalizeUint16(covenant.authorizingInput, `${label}.authorizingInput`),
    covenantId: normalizeNonzeroHash32(covenant.covenantId, `${label}.covenantId`),
  };
}

function resolveStorageMass(input: {
  providedMass?: Uint64Value;
  inputs: readonly TxV1ReferenceInput[];
  outputs: readonly TxV1ReferenceOutput[];
}): bigint {
  const computedMass = calculateKaspaStorageMass({
    inputs: input.inputs.map((item) => ({
      amount: item.utxo.amount,
      scriptPublicKey: item.utxo.scriptPublicKey,
      hasCovenant: item.utxo.covenantId !== null,
    })),
    outputs: input.outputs.map((output) => ({
      amount: output.amount,
      scriptPublicKey: output.scriptPublicKey,
      hasCovenant: output.covenant !== null,
    })),
  });
  if (input.providedMass !== undefined && normalizeUint64(input.providedMass, "mass") !== computedMass) {
    throw new Error("storage mass must match contextual storage mass");
  }
  return computedMass;
}

function normalizeComputeEvidence(computeBudget: number, scriptUnitsEstimate: number, label: string): TxV1ComputeEvidence {
  const normalizedBudget = normalizeUint16(computeBudget, `${label} compute budget`);
  if (!Number.isSafeInteger(scriptUnitsEstimate) || scriptUnitsEstimate < 0) {
    throw new Error(`${label} script-unit estimate is required`);
  }
  const expectedBudget = computeBudgetForScriptUnits(scriptUnitsEstimate);
  if (normalizedBudget !== expectedBudget) {
    throw new Error(`${label} compute budget must match its script-unit estimate (${expectedBudget})`);
  }
  return {
    computeBudget: normalizedBudget,
    scriptUnitsEstimate,
    scriptUnitAllowance: scriptUnitAllowance(normalizedBudget),
  };
}

function assertRedeemScriptPublicKey(redeemScript: string, scriptPublicKey: string, label: string): void {
  const expected = serializedScriptPublicKey(payToScriptHashScript(redeemScript));
  if (expected !== scriptPublicKey) throw new Error(`${label} redeem script does not match its script public key`);
}

function p2pkPublicKey(serialized: string, label: string): string {
  const scriptPublicKey = parseSerializedScriptPublicKey(serialized, label);
  const script = hexToBytes(scriptPublicKey.script, undefined, `${label}.script`);
  if (scriptPublicKey.version !== 0 || script.byteLength !== 34 || script[0] !== 32 || script[33] !== 0xac) {
    throw new Error(`${label} must be a version-0 Schnorr P2PK script`);
  }
  return bytesToHex(script.slice(1, 33));
}

function normalizeOutpoint(outpoint: FundingOutpoint): FundingOutpoint {
  return { txid: normalizeHash32(outpoint.txid, "outpoint.txid"), index: normalizeUint32(outpoint.index, "outpoint.index") };
}

function normalizeNativeSubnetworkId(subnetworkId = NATIVE_SUBNETWORK_ID): string {
  const normalized = bytesToHex(hexToBytes(subnetworkId, 20, "subnetworkId"));
  if (normalized !== NATIVE_SUBNETWORK_ID) throw new Error("transaction-v1 artifacts must use the native subnetwork");
  return normalized;
}

function normalizeZeroGas(gas: Uint64Value = "0"): bigint {
  const normalized = normalizeUint64(gas, "gas");
  if (normalized !== 0n) throw new Error("transaction-v1 artifacts must use zero gas");
  return normalized;
}

function parseSerializedScriptPublicKey(serialized: string, label: string): ScriptPublicKey {
  const bytes = hexToBytes(serialized, undefined, label);
  if (bytes.byteLength < 2) throw new Error(`${label} must contain a uint16 version and script bytes`);
  return { version: (bytes[0] << 8) | bytes[1], script: bytesToHex(bytes.subarray(2)) };
}

function normalizeSerializedScriptPublicKey(serialized: string, label: string): string {
  const parsed = parseSerializedScriptPublicKey(serialized, label);
  return bytesToHex(concatBytes([u16Be(parsed.version), hexToBytes(parsed.script, undefined, `${label}.script`)]));
}

function normalizeHash32(hex: string, label: string): string {
  return bytesToHex(hexToBytes(hex, 32, label));
}

function normalizeNonzeroHash32(hex: string, label: string): string {
  const normalized = normalizeHash32(hex, label);
  if (normalized === ZERO_HASH) throw new Error(`${label} must not be zero`);
  return normalized;
}

function normalizeHex(hex: string, label: string): string {
  return bytesToHex(hexToBytes(hex, undefined, label));
}

function normalizeUint16(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > U16_MAX) throw new Error(`${label} must fit in uint16`);
  return value;
}

function normalizeUint32(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > U32_MAX) throw new Error(`${label} must fit in uint32`);
  return value;
}

function normalizeUint64(value: Uint64Value, label: string): bigint {
  const normalized =
    typeof value === "bigint" ? value : typeof value === "number" ? numberToUint64(value, label) : stringToUint64(value, label);
  if (normalized < 0n || normalized > U64_MAX) throw new Error(`${label} must fit in uint64`);
  return normalized;
}

function normalizePositiveUint64(value: Uint64Value, label: string): bigint {
  const normalized = normalizeUint64(value, label);
  if (normalized === 0n) throw new Error(`${label} must be positive`);
  return normalized;
}

function normalizeNonNegativeInt64(value: Uint64Value, label: string): bigint {
  const normalized = normalizeUint64(value, label);
  if (normalized > I64_MAX) throw new Error(`${label} must fit signed int64`);
  return normalized;
}

function normalizePositiveInt64(value: Uint64Value, label: string): bigint {
  const normalized = normalizeNonNegativeInt64(value, label);
  if (normalized === 0n) throw new Error(`${label} must be positive`);
  return normalized;
}

function numberToUint64(value: number, label: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return BigInt(value);
}

function stringToUint64(value: string, label: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} must be a canonical uint64 decimal string`);
  return BigInt(value);
}

function sumUint64(values: readonly bigint[], label: string): bigint {
  const sum = values.reduce((total, value) => total + value, 0n);
  if (sum > U64_MAX) throw new Error(`${label} must fit in uint64`);
  return sum;
}

function blake2bKeyed(domain: string, input: Uint8Array): string {
  return bytesToHex(Uint8Array.from(blake2b(input, Buffer.from(domain, "utf8"), 32)));
}

function blake3Keyed(domain: string, input: Uint8Array): string {
  const key = new Uint8Array(32);
  key.set(Buffer.from(domain, "utf8"));
  return bytesToHex(blake3(input, { key }));
}

function bytesFromHexOrBytes(value: string | Uint8Array, expectedLength: number, label: string): Uint8Array {
  const bytes = typeof value === "string" ? hexToBytes(value, expectedLength, label) : value;
  if (bytes.byteLength !== expectedLength) throw new Error(`${label} must be ${expectedLength} bytes`);
  return bytes;
}

function pushDataHex(hex: string): string {
  return bytesToHex(pushData(hexToBytes(hex, undefined, "pushdata")));
}

function pushData(data: Uint8Array): Uint8Array {
  if (data.byteLength <= 75) return concatBytes([Uint8Array.of(data.byteLength), data]);
  if (data.byteLength <= 0xff) return concatBytes([Uint8Array.of(0x4c, data.byteLength), data]);
  if (data.byteLength <= 0xffff) {
    return concatBytes([Uint8Array.of(0x4d, data.byteLength & 0xff, data.byteLength >>> 8), data]);
  }
  throw new Error("pushdata payload is too large");
}

function u16Le(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff);
}

function u16Be(value: number): Uint8Array {
  const normalized = normalizeUint16(value, "script public key version");
  return Uint8Array.of((normalized >>> 8) & 0xff, normalized & 0xff);
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
    if (!Number.isInteger(value) || value < 0 || value > 0xff) throw new Error("value must fit uint8");
    this.#parts.push(Uint8Array.of(value));
    return this;
  }

  u16(value: number): this {
    this.#parts.push(u16Le(normalizeUint16(value, "u16")));
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
