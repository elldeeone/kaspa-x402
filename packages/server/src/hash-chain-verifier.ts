import { schnorr } from "@noble/curves/secp256k1.js";
import {
  exactRequestAuthorizationDigest,
  exactRequestAuthorizationId,
  stableStringify,
  type FundingOutpoint,
} from "@kaspa-x402/core";
import {
  buildHashChainBorrowSignatureScript,
  calculateKaspaStorageMass,
  hashChainBorrowGuard,
  hashChainHeadScriptPublicKey,
  parseHashChainHeadRedeemScript,
  transactionV1Id,
  transactionV1SchnorrSignatureEvidence,
  transactionV1Sighash,
  kaspaSighashType,
  type TxV1ReferenceTransaction,
} from "@kaspa-x402/covenant";
import type {
  ExactTransactionVerification,
  ExactTransactionVerificationRequest,
  ExactTransactionVerifier,
} from "./types.js";

const NATIVE_SUBNETWORK = "00".repeat(20);
const U64_MAX = 0xffff_ffff_ffff_ffffn;

export interface HashChainTrustedOrigin {
  amount: string;
  scriptPublicKey: string;
  covenantId: string | null;
}

/** Returned only for a transaction on the selected chain. Confirmation counts belong to the adapter. */
export interface HashChainSelectedTransaction {
  transactionId: string;
  finality: "accepted" | "confirmed";
  spentHead: FundingOutpoint;
  successor: { amount: string; scriptPublicKey: string; covenantId: string; authorizingInput: 0 };
}

export interface HashChainChainView {
  /** Batch-read accepted origin outputs with one bounded, cancellable snapshot. */
  getAcceptedOrigins(
    outpoints: readonly FundingOutpoint[],
    options?: { signal?: AbortSignal },
  ): Promise<readonly (HashChainTrustedOrigin | null)[]>;
  /** Return null for unknown, mempool-only, or reorged transactions. */
  getSelectedTransaction(
    transactionId: string,
    options?: { signal?: AbortSignal },
  ): Promise<HashChainSelectedTransaction | null>;
}

interface ParsedInput {
  previousOutpoint: FundingOutpoint;
  signatureScript: string;
  sequence: string;
  computeBudget: number;
  hintedAmount: string;
  hintedScript: string;
}
interface ParsedOutput {
  amount: string;
  scriptPublicKey: string;
  covenant: { authorizingInput: number; covenantId: string } | null;
}
interface ParsedArtifact {
  id: string;
  version: number;
  inputs: ParsedInput[];
  outputs: ParsedOutput[];
  lockTime: string;
  subnetworkId: string;
  gas: string;
  payload: string;
  storageMass: string;
}
interface LocallyValidatedHashChainPayment {
  head: NonNullable<ExactTransactionVerificationRequest["hashChainHead"]>;
  artifact: ParsedArtifact;
  reference: TxV1ReferenceTransaction;
  transactionId: string;
  output: ParsedOutput;
  payerScripts: Set<string>;
  authorization: ExactTransactionVerificationRequest["authorization"];
  publicKey: string;
  digest: string;
}
const localValidationCache = new WeakMap<
  ExactTransactionVerificationRequest,
  { fingerprint: string; validated: LocallyValidatedHashChainPayment }
>();

/**
 * Authenticates the candidate entirely locally. The server runs this before
 * invoking any configured verifier so the per-grant candidate pin cannot be
 * bypassed by an adapter that omits a callback.
 */
export function authenticateHashChainPaymentLocally(
  request: ExactTransactionVerificationRequest,
): { transactionId: string; payerPublicKey: string } {
  const validated = locallyValidateHashChainPayment(request, 8);
  localValidationCache.set(request, {
    fingerprint: localValidationFingerprint(request),
    validated,
  });
  return {
    transactionId: validated.transactionId,
    payerPublicKey: validated.publicKey,
  };
}

function localValidationFingerprint(
  request: ExactTransactionVerificationRequest,
): string {
  return stableStringify({
    network: request.network,
    profile: request.profile,
    transaction: request.transaction,
    transactionEncoding: request.transactionEncoding,
    paymentOutputIndex: request.paymentOutputIndex,
    amount: request.amount,
    payTo: request.payTo,
    payToScriptPublicKey: request.payToScriptPublicKey,
    requestHash: request.requestHash,
    paymentRequirementsHash: request.paymentRequirementsHash,
    authorization: request.authorization,
    hashChainHead: request.hashChainHead,
  });
}

function locallyValidateHashChainPayment(
  request: ExactTransactionVerificationRequest,
  maxInputs: number,
): LocallyValidatedHashChainPayment {
  request.signal?.throwIfAborted();
  const head = request.hashChainHead;
  if (request.network !== "kaspa:testnet-10" || request.profile !== "hash-chain-additive" || !head ||
    request.paymentOutputIndex !== 0 || request.transactionEncoding !== "kaspa-sdk-safe-json-v2.0.0") {
    throw new Error("hash-chain verifier requires the Testnet-10 upfront profile and head challenge");
  }
  if (!/^[0-9a-f]{64}$/.test(head.covenantId) || /^0+$/.test(head.covenantId) ||
    head.expectedHeadOutpoint.index !== 0 ||
    hashChainBorrowGuard(head.nextGuard, head.oneTimePublicKey) !== head.currentGuard) {
    throw new Error("hash-chain grant or covenant identity is invalid");
  }
  const parsedHead = parseHashChainHeadRedeemScript(head.headRedeemScript);
  const successorScript = hashChainHeadScriptPublicKey({
    ownerPublicKey: parsedHead.ownerPublicKey,
    guard: head.nextGuard,
  });
  if (parsedHead.guard !== head.currentGuard ||
    hashChainHeadScriptPublicKey(parsedHead) !== head.headScriptPublicKey ||
    successorScript !== request.payToScriptPublicKey.toLowerCase()) {
    throw new Error("hash-chain head or successor script is inconsistent");
  }

  const artifact = parseArtifact(request.transaction);
  if (artifact.inputs.length > maxInputs) {
    throw new Error("hash-chain transaction exceeds the per-payment input budget");
  }
  if (artifact.version !== 1 || artifact.lockTime !== "0" ||
    artifact.subnetworkId !== NATIVE_SUBNETWORK || artifact.gas !== "0" || artifact.payload !== "" ||
    artifact.inputs.length < 2 || artifact.outputs.length < 1 || artifact.outputs.length > 2) {
    throw new Error("hash-chain transaction topology or native envelope is invalid");
  }
  const headInput = artifact.inputs[0]!;
  if (headInput.previousOutpoint.txid !== head.expectedHeadOutpoint.txid ||
    headInput.previousOutpoint.index !== 0 || headInput.sequence !== "0" ||
    headInput.computeBudget < 1 || headInput.computeBudget > 65535 ||
    headInput.hintedAmount !== head.headAmount ||
    headInput.hintedScript !== head.headScriptPublicKey) {
    throw new Error("hash-chain transaction does not spend the advertised head");
  }
  for (const input of artifact.inputs.slice(1)) {
    if (input.computeBudget !== 10 || input.sequence !== "0") {
      throw new Error("hash-chain payer input budget or sequence is invalid");
    }
  }
  const output = artifact.outputs[0]!;
  const expectedAmount = BigInt(head.headAmount) + BigInt(request.amount);
  if (expectedAmount > U64_MAX || output.amount !== expectedAmount.toString() ||
    output.scriptPublicKey !== successorScript ||
    output.covenant?.authorizingInput !== 0 || output.covenant.covenantId !== head.covenantId ||
    artifact.outputs[1]?.covenant !== undefined && artifact.outputs[1]?.covenant !== null) {
    throw new Error("hash-chain successor is not the exact quoted same-ID increase");
  }

  const reference: TxV1ReferenceTransaction = {
    version: 1,
    inputs: artifact.inputs.map((input, index) => ({
      previousOutpoint: input.previousOutpoint,
      signatureScript: input.signatureScript,
      sequence: input.sequence,
      computeBudget: input.computeBudget,
      utxo: {
        amount: input.hintedAmount,
        scriptPublicKey: input.hintedScript,
        blockDaaScore: "0",
        isCoinbase: false,
        covenantId: index === 0 ? head.covenantId : null,
      },
    })),
    outputs: artifact.outputs,
    lockTime: artifact.lockTime,
    subnetworkId: artifact.subnetworkId,
    gas: artifact.gas,
    payload: artifact.payload,
    mass: artifact.storageMass,
    estimatedSerializedSize: 0,
  };
  const transactionId = transactionV1Id(reference);
  if (transactionId !== artifact.id) {
    throw new Error("hash-chain transaction ID is not canonical");
  }
  const headWitness = Buffer.from(headInput.signatureScript, "hex");
  if (headWitness[66] !== 65) {
    throw new Error("hash-chain head witness lacks a canonical Schnorr signature");
  }
  const headSighashType = kaspaSighashType(headWitness[131]!);
  const headSignature = headWitness.subarray(67, 131).toString("hex");
  if (buildHashChainBorrowSignatureScript({
    revealedGuard: head.nextGuard,
    oneTimePublicKey: head.oneTimePublicKey,
    signature: headSignature,
    sighashType: headSighashType,
    redeemScript: head.headRedeemScript,
  }) !== headInput.signatureScript ||
    !schnorr.verify(
      Buffer.from(headSignature, "hex"),
      Buffer.from(transactionV1Sighash(reference, 0, headSighashType).digest, "hex"),
      Buffer.from(head.oneTimePublicKey, "hex"),
    )) {
    throw new Error("hash-chain one-time signature or borrow witness is invalid");
  }
  const fundingKeys = new Map<number, string>();
  const payerScripts = new Set<string>();
  for (let index = 1; index < reference.inputs.length; index++) {
    request.signal?.throwIfAborted();
    const evidence = transactionV1SchnorrSignatureEvidence(reference, index);
    if (!schnorr.verify(
      Buffer.from(evidence.signature, "hex"),
      Buffer.from(evidence.digest, "hex"),
      Buffer.from(evidence.publicKey, "hex"),
    )) {
      throw new Error("hash-chain payer funding signature is invalid");
    }
    fundingKeys.set(index, evidence.publicKey);
    payerScripts.add(artifact.inputs[index]!.hintedScript);
  }
  const authorization = request.authorization;
  const publicKey = fundingKeys.get(authorization.inputIndex);
  if (!publicKey || authorization.version !== "kaspa-x402-exact-request-authorization-v1" ||
    !Number.isFinite(Date.parse(authorization.expiresAt))) {
    throw new Error("hash-chain request authorization is missing or not signed by a payer input");
  }
  const digest = exactRequestAuthorizationDigest({
    network: request.network,
    profile: request.profile,
    transactionId,
    paymentOutputIndex: 0,
    amount: request.amount,
    payTo: request.payTo,
    payToScriptPublicKey: request.payToScriptPublicKey,
    paymentRequirementsHash: request.paymentRequirementsHash,
    requestHash: request.requestHash,
    challengeId: head.challengeId,
    inputIndex: authorization.inputIndex,
    expiresAt: authorization.expiresAt,
  });
  if (digest !== authorization.digest.toLowerCase() ||
    !schnorr.verify(
      Buffer.from(authorization.signature, "hex"),
      Buffer.from(digest, "hex"),
      Buffer.from(publicKey, "hex"),
    )) {
    throw new Error("hash-chain payer request authorization signature is invalid");
  }
  return {
    head,
    artifact,
    reference,
    transactionId,
    output,
    payerScripts,
    authorization,
    publicKey,
    digest,
  };
}

/**
 * Verifies the payer's signed v1 proof against independently read selected-chain
 * inputs. Consensus acceptance supplies the final script-unit and DAG checks.
 */
export class HashChainExactTransactionVerifier implements ExactTransactionVerifier {
  constructor(
    private readonly chain: HashChainChainView,
    private readonly maxFeeSompi = 10_000_000n,
    private readonly maxInputs = 8,
  ) {
    if (maxFeeSompi < 0n || maxFeeSompi > U64_MAX) throw new Error("invalid hash-chain fee ceiling");
    if (!Number.isSafeInteger(maxInputs) || maxInputs < 2 || maxInputs > 8) {
      throw new Error("hash-chain input budget must be an integer from 2 to 8");
    }
  }

  async verifyExactPayment(request: ExactTransactionVerificationRequest): Promise<ExactTransactionVerification> {
    request.signal?.throwIfAborted();
    const cached = localValidationCache.get(request);
    const {
      head,
      artifact,
      transactionId,
      output,
      payerScripts,
      authorization,
      publicKey,
      digest,
    } = cached?.fingerprint === localValidationFingerprint(request) &&
      cached.validated.artifact.inputs.length <= this.maxInputs
      ? cached.validated
      : locallyValidateHashChainPayment(request, this.maxInputs);
    request.signal?.throwIfAborted();
    const observedOrigins = await this.chain.getAcceptedOrigins(
      artifact.inputs.map((input) => input.previousOutpoint),
      { signal: request.signal },
    );
    request.signal?.throwIfAborted();
    if (observedOrigins.length !== artifact.inputs.length) {
      throw new Error("hash-chain origin observer returned an incomplete batch");
    }
    const origins: HashChainTrustedOrigin[] = [];
    for (let index = 0; index < artifact.inputs.length; index++) {
      const input = artifact.inputs[index]!;
      const origin = observedOrigins[index];
      if (!origin || origin.amount !== input.hintedAmount ||
        origin.scriptPublicKey.toLowerCase() !== input.hintedScript) {
        throw new Error("hash-chain input does not match an accepted origin output");
      }
      origins.push({ ...origin, scriptPublicKey: origin.scriptPublicKey.toLowerCase(),
        covenantId: origin.covenantId?.toLowerCase() ?? null });
    }
    if (origins[0]!.covenantId !== head.covenantId ||
      origins.slice(1).some((item) => item.covenantId !== null)) {
      throw new Error("hash-chain input covenant lineage is invalid");
    }
    if (artifact.outputs[1] && !payerScripts.has(artifact.outputs[1].scriptPublicKey)) {
      throw new Error("hash-chain change is not controlled by a verified payer input");
    }
    const inputAmount = origins.reduce((sum, input) => sum + BigInt(input.amount), 0n);
    const outputAmount = artifact.outputs.reduce((sum, item) => sum + BigInt(item.amount), 0n);
    if (inputAmount < outputAmount || inputAmount - outputAmount > this.maxFeeSompi) {
      throw new Error("hash-chain payer fee is invalid or excessive");
    }
    const mass = calculateKaspaStorageMass({
      inputs: origins.map((input) => ({ amount: input.amount, scriptPublicKey: input.scriptPublicKey, hasCovenant: input.covenantId !== null })),
      outputs: artifact.outputs.map((item) => ({ amount: item.amount, scriptPublicKey: item.scriptPublicKey, hasCovenant: item.covenant !== null })),
    });
    if (mass !== BigInt(artifact.storageMass)) throw new Error("hash-chain contextual storage mass is invalid");
    request.signal?.throwIfAborted();
    const selected = await this.chain.getSelectedTransaction(transactionId, {
      signal: request.signal,
    });
    request.signal?.throwIfAborted();
    if (selected && (selected.transactionId.toLowerCase() !== transactionId ||
      selected.spentHead.txid.toLowerCase() !== head.expectedHeadOutpoint.txid || selected.spentHead.index !== 0 ||
      selected.successor.amount !== output.amount ||
      selected.successor.scriptPublicKey.toLowerCase() !== output.scriptPublicKey ||
      selected.successor.covenantId.toLowerCase() !== head.covenantId ||
      selected.successor.authorizingInput !== 0 ||
      (request.requiredFinality === "confirmed" && selected.finality !== "confirmed"))) {
      throw new Error("selected-chain hash-chain successor or finality does not match proof");
    }
    return {
      transactionId,
      paymentOutput: { amount: request.amount, scriptPublicKey: output.scriptPublicKey, address: request.payTo },
      continuation: { outpoint: { txid: transactionId, index: 0 }, amount: output.amount, scriptPublicKey: output.scriptPublicKey },
      requestAuthorization: {
        authorizationId: exactRequestAuthorizationId(authorization), digest,
        inputIndex: authorization.inputIndex, publicKey,
      },
      ...(selected ? { finality: selected.finality } : {}),
    };
  }
}

function parseArtifact(serialized: string): ParsedArtifact {
  if (typeof serialized !== "string" || serialized.length > 131072) throw new Error("hash-chain transaction artifact exceeds 128 KiB");
  const raw: unknown = JSON.parse(serialized);
  const tx = record(raw, "transaction");
  const inputs = array(tx.inputs, "inputs");
  const outputs = array(tx.outputs, "outputs");
  if (inputs.length < 2 || inputs.length > 64 || outputs.length < 1 || outputs.length > 2) {
    throw new Error("hash-chain transaction input or output count is invalid");
  }
  const parsedInputs: ParsedInput[] = inputs.map((value, index) => {
    const input = record(value, `input ${index}`);
    const outpoint = record(input.previousOutpoint ?? input, "previous outpoint");
    const utxo = record(input.utxo, "input UTXO hint");
    if (Number(input.sigOpCount ?? 0) !== 0) throw new Error("hash-chain input sigOpCount must be zero");
    return {
      previousOutpoint: { txid: hash(outpoint.transactionId ?? outpoint.txid, "input transaction ID"), index: smallInteger(outpoint.index, "input index") },
      signatureScript: hex(input.signatureScript, "input witness"),
      sequence: decimal(input.sequence, "input sequence"),
      computeBudget: smallInteger(input.computeBudget, "input compute budget"),
      hintedAmount: decimal(utxo.amount, "input amount"),
      hintedScript: script(utxo.scriptPublicKey, "input script"),
    };
  });
  const seen = new Set<string>();
  for (const input of parsedInputs) {
    const key = `${input.previousOutpoint.txid}:${input.previousOutpoint.index}`;
    if (seen.has(key)) throw new Error("hash-chain transaction duplicates an input outpoint");
    seen.add(key);
  }
  const parsedOutputs: ParsedOutput[] = outputs.map((value, index) => {
    const output = record(value, `output ${index}`);
    const binding = output.covenant == null ? null : record(output.covenant, "output covenant");
    return {
      amount: decimal(output.value ?? output.amount, "output value"),
      scriptPublicKey: script(output.scriptPublicKey, "output script"),
      covenant: binding ? {
        authorizingInput: smallInteger(binding.authorizingInput, "covenant authorizing input"),
        covenantId: hash(binding.covenantId, "output covenant ID"),
      } : null,
    };
  });
  return {
    id: hash(tx.id, "transaction ID"), version: smallInteger(tx.version, "transaction version"),
    inputs: parsedInputs, outputs: parsedOutputs,
    lockTime: decimal(tx.lockTime ?? "0", "lockTime"),
    subnetworkId: hex(tx.subnetworkId ?? NATIVE_SUBNETWORK, "subnetwork"),
    gas: decimal(tx.gas ?? "0", "gas"), payload: hex(tx.payload ?? "", "payload"),
    storageMass: decimal(tx.storageMass, "storageMass"),
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}
function decimal(value: unknown, label: string): string {
  const normalized = typeof value === "bigint" ? value.toString() : String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(normalized) || BigInt(normalized) > U64_MAX ||
    (typeof value === "number" && !Number.isSafeInteger(value))) throw new Error(`${label} must be canonical uint64`);
  return normalized;
}
function smallInteger(value: unknown, label: string): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > 0xffff_ffff) throw new Error(`${label} must be uint32`);
  return normalized;
}
function hex(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(?:[0-9a-fA-F]{2})*$/.test(value)) throw new Error(`${label} must be byte hex`);
  return value.toLowerCase();
}
function hash(value: unknown, label: string): string {
  const normalized = hex(value, label);
  if (normalized.length !== 64) throw new Error(`${label} must be 32-byte hex`);
  return normalized;
}
function script(value: unknown, label: string): string {
  const normalized = hex(value, label);
  if (!normalized.startsWith("0000") || normalized.length < 6) throw new Error(`${label} must be a version-0 serialized script`);
  return normalized;
}
