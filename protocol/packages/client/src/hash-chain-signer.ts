import { schnorr } from "@noble/curves/secp256k1.js";
import { exactRequestAuthorizationDigest, type FundingOutpoint } from "@kaspa-x402/core";
import {
  buildHashChainBorrowSignatureScript,
  buildTxV1P2pkSignatureScript,
  calculateKaspaStorageMass,
  hashChainBorrowGuard,
  hashChainHeadScriptPublicKey,
  hashChainOneTimePublicKey,
  parseHashChainHeadRedeemScript,
  transactionV1Id,
  transactionV1Sighash,
  type TxV1ReferenceTransaction,
} from "@kaspa-x402/covenant";
import type { ExactTransactionPaymentRequest, ExactTransactionPaymentResult, HashChainGrantDelivery } from "./types.js";

const NATIVE_SUBNETWORK = "00".repeat(20);
const MAX_FEE = 10_000_000n;
// Rusty-Kaspa's pinned Testnet-10 BlockMassLimits.storage is 500,000.
const MAX_STORAGE_MASS = 500_000n;

export interface HashChainPayerFundingInput {
  outpoint: FundingOutpoint;
  amount: string;
  scriptPublicKey: string;
  privateKey: string;
  payerAddress: string;
}

/** Builds a fully payer-signed native v1 borrow. The caller durably reserves inputs and broadcasts it. */
export function signHashChainExactTransaction(input: {
  request: ExactTransactionPaymentRequest & { grant: HashChainGrantDelivery };
  funding: HashChainPayerFundingInput;
  feeSompi: string;
  /** Optional BIP340 auxiliary data for reproducible conformance vectors. */
  schnorrAuxRand?: Uint8Array;
}): ExactTransactionPaymentResult {
  const { request, funding, feeSompi, schnorrAuxRand } = input;
  if (schnorrAuxRand && schnorrAuxRand.length !== 32) throw new Error("Schnorr auxiliary data must be 32 bytes");
  const head = request.hashChainHead;
  if (!head || request.network !== "kaspa:testnet-10" || request.profile !== "hash-chain-additive" ||
    request.paymentOutputIndex !== 0) throw new Error("hash-chain signer requires a Testnet-10 head challenge");
  if (request.grant.grantId !== head.grantId || request.grant.headVersion !== Number(head.headVersion) ||
    request.grant.nextGuard !== head.nextGuard || request.grant.oneTimePublicKey !== head.oneTimePublicKey ||
    hashChainOneTimePublicKey(request.grant.oneTimePrivateKey) !== head.oneTimePublicKey ||
    hashChainBorrowGuard(head.nextGuard, head.oneTimePublicKey) !== head.currentGuard) {
    throw new Error("delivered one-time grant does not match the advertised head");
  }
  const parsed = parseHashChainHeadRedeemScript(head.headRedeemScript);
  if (parsed.guard !== head.currentGuard ||
    hashChainHeadScriptPublicKey(parsed) !== head.headScriptPublicKey ||
    hashChainHeadScriptPublicKey({ ownerPublicKey: parsed.ownerPublicKey, guard: head.nextGuard }) !== request.payToScriptPublicKey) {
    throw new Error("hash-chain current and successor scripts do not match the pinned covenant");
  }
  const payerKey = Buffer.from(funding.privateKey, "hex");
  if (!/^[0-9a-f]{64}$/.test(funding.privateKey) || payerKey.length !== 32 ||
    funding.scriptPublicKey !== `000020${Buffer.from(schnorr.getPublicKey(payerKey)).toString("hex")}ac`) {
    throw new Error("funding input is not controlled by the payer signing key");
  }
  const amount = canonicalPositive(request.amount, "quoted amount");
  const headAmount = canonicalPositive(head.headAmount, "head amount");
  const fundingAmount = canonicalPositive(funding.amount, "funding amount");
  const targetFee = canonicalPositive(feeSompi, "fee");
  if (targetFee > MAX_FEE || headAmount + amount > 0xffff_ffff_ffff_ffffn ||
    fundingAmount < amount + targetFee) throw new Error("funding cannot cover the exact increase and bounded fee");
  if (funding.outpoint.txid === head.expectedHeadOutpoint.txid && funding.outpoint.index === head.expectedHeadOutpoint.index) {
    throw new Error("head and funding outpoints must differ");
  }
  const inputs: TxV1ReferenceTransaction["inputs"] = [
    { previousOutpoint: head.expectedHeadOutpoint, signatureScript: "", sequence: "0", computeBudget: 10,
      utxo: { amount: head.headAmount, scriptPublicKey: head.headScriptPublicKey,
        blockDaaScore: "0", isCoinbase: false, covenantId: head.covenantId } },
    { previousOutpoint: funding.outpoint, signatureScript: "", sequence: "0", computeBudget: 10,
      utxo: { amount: funding.amount, scriptPublicKey: funding.scriptPublicKey,
        blockDaaScore: "0", isCoinbase: false, covenantId: null } },
  ];
  const change = fundingAmount - amount - targetFee;
  const successor: TxV1ReferenceTransaction["outputs"][number] = {
    amount: (headAmount + amount).toString(), scriptPublicKey: request.payToScriptPublicKey,
    covenant: { authorizingInput: 0, covenantId: head.covenantId },
  };
  const changeOutput: TxV1ReferenceTransaction["outputs"][number] = {
    amount: change.toString(), scriptPublicKey: funding.scriptPublicKey, covenant: null,
  };
  const storageMass = (outputs: TxV1ReferenceTransaction["outputs"]) => calculateKaspaStorageMass({
    inputs: inputs.map((item) => ({ amount: item.utxo.amount, scriptPublicKey: item.utxo.scriptPublicKey, hasCovenant: item.utxo.covenantId !== null })),
    outputs: outputs.map((item) => ({ amount: item.amount, scriptPublicKey: item.scriptPublicKey, hasCovenant: item.covenant !== null })),
  });
  let outputs: TxV1ReferenceTransaction["outputs"] = change > 0n ? [successor, changeOutput] : [successor];
  let mass = storageMass(outputs);
  if (mass >= MAX_STORAGE_MASS && change > 0n && targetFee + change <= MAX_FEE) {
    outputs = [successor];
    mass = storageMass(outputs);
  }
  if (mass >= MAX_STORAGE_MASS) throw new Error("hash-chain funding produces excessive transaction mass");
  const unsigned: TxV1ReferenceTransaction = {
    version: 1, inputs, outputs, lockTime: "0", subnetworkId: NATIVE_SUBNETWORK,
    gas: "0", payload: "", mass: mass.toString(), estimatedSerializedSize: 0,
  };
  const headSignature = Buffer.from(schnorr.sign(
    Buffer.from(transactionV1Sighash(unsigned, 0).digest, "hex"),
    Buffer.from(request.grant.oneTimePrivateKey, "hex"),
    schnorrAuxRand,
  )).toString("hex");
  const payerSignature = Buffer.from(schnorr.sign(
    Buffer.from(transactionV1Sighash(unsigned, 1).digest, "hex"), payerKey, schnorrAuxRand,
  )).toString("hex");
  const signed: TxV1ReferenceTransaction = { ...unsigned, inputs: [
    { ...inputs[0]!, signatureScript: buildHashChainBorrowSignatureScript({
      revealedGuard: head.nextGuard, oneTimePublicKey: head.oneTimePublicKey,
      signature: headSignature, redeemScript: head.headRedeemScript,
    }) },
    { ...inputs[1]!, signatureScript: buildTxV1P2pkSignatureScript(payerSignature) },
  ] };
  const transactionId = transactionV1Id(signed);
  const digest = exactRequestAuthorizationDigest({
    network: request.network, profile: request.profile, transactionId,
    paymentOutputIndex: 0, amount: request.amount, payTo: request.payTo,
    payToScriptPublicKey: request.payToScriptPublicKey,
    paymentRequirementsHash: request.paymentRequirementsHash, requestHash: request.requestHash,
    paymentIdentifier: request.paymentIdentifier,
    challengeId: head.challengeId, inputIndex: 1,
    expiresAt: request.authorizationExpiresAt,
  });
  const safe = {
    id: transactionId, version: 1,
    inputs: signed.inputs.map((item) => ({
      transactionId: item.previousOutpoint.txid, index: item.previousOutpoint.index,
      sequence: item.sequence, sigOpCount: 0, computeBudget: item.computeBudget,
      signatureScript: item.signatureScript,
      utxo: { address: null, amount: item.utxo.amount,
        scriptPublicKey: item.utxo.scriptPublicKey,
        blockDaaScore: item.utxo.blockDaaScore, isCoinbase: false,
        covenantId: item.utxo.covenantId },
    })),
    outputs: signed.outputs.map((item) => ({ value: item.amount,
      scriptPublicKey: item.scriptPublicKey, covenant: item.covenant })),
    subnetworkId: signed.subnetworkId, lockTime: signed.lockTime,
    gas: signed.gas, storageMass: signed.mass, payload: signed.payload,
  };
  return {
    transaction: JSON.stringify(safe), transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
    transactionId, paymentOutputIndex: 0,
    inputOutpoints: [head.expectedHeadOutpoint, funding.outpoint],
    authorization: {
      version: "kaspa-x402-exact-request-authorization-v2", inputIndex: 1,
      expiresAt: request.authorizationExpiresAt, digest,
      signature: Buffer.from(schnorr.sign(Buffer.from(digest, "hex"), payerKey, schnorrAuxRand)).toString("hex"),
    },
    payerAddress: funding.payerAddress, fundingSource: "hot-wallet",
  };
}


function canonicalPositive(value: string, label: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${label} must be canonical positive sompi`);
  const amount = BigInt(value);
  if (amount > 0xffff_ffff_ffff_ffffn) throw new Error(`${label} exceeds uint64`);
  return amount;
}
