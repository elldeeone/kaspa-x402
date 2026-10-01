import {
  KaspaX402Error,
  type AcceptedTransactionEvidence,
  type ChainCheckpoint,
  type FundingOutpoint,
} from "@kaspa-x402/core";
import type { ExactTransactionVerificationRequest } from "@kaspa-x402/server";
import {
  KaspaPnnClient,
  ScriptAddressBook,
  VerifiedExactTransactionVerifier,
  parseSafeTransactionArtifact,
  assertChainTransactionMatchesSafe,
  sameOutpoint,
  unwrapRecord,
  requiredRecord,
  optionalArray,
  hashValue,
  uintStringValue,
  serializeSdkScriptPublicKey,
  pnnInputOutpoint,
  pnnOutputCovenant,
  pnnInputCovenantId,
  type ChainEvidenceClient,
  type SafeTransaction,
  type RestTransaction,
  type RestObservedUtxo,
  type PnnUtxo,
} from "./adapters.js";
import {
  addressForScriptPublicKey,
  scriptPublicKeyForAddress,
} from "./kaspa-native.js";

export interface PnnEvidenceRecord {
  transactionId: string;
  checkpoint: ChainCheckpoint;
  origins?: PnnUtxo[];
  transaction?: RestTransaction;
  evidence?: AcceptedTransactionEvidence;
}

export interface PnnEvidenceStore {
  loadPnnEvidence(
    transactionId: string,
  ): Promise<PnnEvidenceRecord | undefined>;
  savePnnEvidence(record: PnnEvidenceRecord): Promise<void>;
  recordPnnCheckpoint(checkpoint: ChainCheckpoint): Promise<void>;
  findPnnCheckpointBefore(
    daaScore: string,
  ): Promise<ChainCheckpoint | undefined>;
}

/** One request's node reads; durable receipts survive Worker restarts. */
export class PnnChainEvidence implements ChainEvidenceClient {
  #candidate?: SafeTransaction;
  #candidateRecord?: PnnEvidenceRecord;
  #origins: PnnUtxo[] = [];
  #snapshot?: Awaited<ReturnType<KaspaPnnClient["snapshotHashChainUtxos"]>>;

  constructor(
    readonly pnn: KaspaPnnClient,
    readonly book: ScriptAddressBook,
    readonly store: PnnEvidenceStore,
    readonly confirmations = 30,
  ) {}

  async verifyExactPayment(request: ExactTransactionVerificationRequest) {
    this.#candidate = parseSafeTransactionArtifact(request.transaction);
    // Signature/envelope validation in the shared verifier precedes node I/O.
    const result = await new VerifiedExactTransactionVerifier(
      this,
    ).verifyExactPayment(request);
    const checkpoint =
      this.#candidateRecord?.checkpoint ?? this.#snapshot?.checkpoint;
    if (!checkpoint)
      throw unavailable("exact payment lacks a trusted PNN checkpoint");
    await this.store.savePnnEvidence({
      transactionId: result.transactionId,
      checkpoint,
      origins: this.#origins,
      ...(this.#candidateRecord?.transaction
        ? {
            transaction: this.#candidateRecord.transaction,
            evidence: this.#candidateRecord.evidence,
          }
        : {}),
    });
    return result;
  }

  async getTransaction(transactionId: string): Promise<RestTransaction | null> {
    const id = hashValue(transactionId, "PNN transaction id");
    if (this.#candidate?.id === id) return this.#candidateTransaction();
    const origins = this.#origins.filter(
      (origin) => origin.outpoint.txid === id,
    );
    if (origins.length > 0)
      return {
        transaction_id: id,
        is_accepted: true,
        outputs: origins.map((origin) => ({
          index: origin.outpoint.index,
          amount: origin.amount,
          script_public_key: origin.scriptPublicKey,
        })),
      };
    const cached = await this.store.loadPnnEvidence(id);
    if (cached?.transaction && cached.evidence) {
      await this.pnn.confirmAcceptedTransaction(
        cached.evidence,
        this.confirmations,
      );
      return cached.transaction;
    }
    const snapshot = await this.pnn.snapshotHashChainUtxos(
      this.book.addresses(),
    );
    const current = snapshot.utxos.find((utxo) => utxo.outpoint.txid === id);
    const from =
      cached?.checkpoint ??
      (current?.blockDaaScore
        ? await this.store.findPnnCheckpointBefore(current.blockDaaScore)
        : undefined);
    const accepted = await this.pnn.findAcceptedTransaction(id, {
      ...(from ? { from } : {}),
      ...(current?.blockDaaScore
        ? { originDaaScore: current.blockDaaScore }
        : {}),
    });
    if (!accepted) return null;
    const evidence = await this.pnn.confirmAcceptedTransaction(
      accepted.evidence,
      this.confirmations,
    );
    const transaction = observedTransaction(accepted.raw, evidence);
    await this.store.savePnnEvidence({
      transactionId: id,
      checkpoint: cached?.checkpoint ?? evidence.checkpoint!,
      transaction,
      evidence,
      ...(cached?.origins ? { origins: cached.origins } : {}),
    });
    return transaction;
  }

  async #candidateTransaction(): Promise<RestTransaction | null> {
    const candidate = this.#candidate!;
    const cached = await this.store.loadPnnEvidence(candidate.id);
    this.#candidateRecord = cached;
    if (cached?.origins) this.#origins = cached.origins;
    if (cached?.transaction && cached.evidence) {
      await this.pnn.confirmAcceptedTransaction(
        cached.evidence,
        this.confirmations,
      );
      assertChainTransactionMatchesSafe(cached.transaction, candidate);
      return cached.transaction;
    }
    const addresses = [
      ...new Set(
        candidate.inputs.map((input) =>
          addressForScriptPublicKey(
            input.utxo.scriptPublicKey,
            "kaspa:testnet-10",
          ),
        ),
      ),
    ];
    this.#snapshot = await this.pnn.snapshotHashChainUtxos(addresses);
    const currentOrigins = candidate.inputs.map((input) =>
      this.#snapshot!.utxos.filter((utxo) =>
        sameOutpoint(utxo.outpoint, {
          txid: input.transactionId,
          index: input.index,
        }),
      ),
    );
    if (currentOrigins.some((matches) => matches.length > 1))
      throw unavailable("PNN returned duplicate input UTXOs");
    if (currentOrigins.every((matches) => matches.length === 1)) {
      this.#origins = currentOrigins.map((matches) => matches[0]!);
      return null;
    }
    const accepted = await this.pnn.findAcceptedTransaction(
      candidate.id,
      cached ? { from: cached.checkpoint } : {},
    );
    if (!accepted)
      throw unavailable(
        "payment inputs are spent or missing and accepted evidence is unavailable",
      );
    const evidence = await this.pnn.confirmAcceptedTransaction(
      accepted.evidence,
      this.confirmations,
    );
    const transaction = observedTransaction(accepted.raw, evidence);
    assertChainTransactionMatchesSafe(transaction, candidate);
    if (!cached?.origins) this.#origins = acceptedOrigins(accepted.raw);
    if (this.#origins.length !== candidate.inputs.length)
      throw unavailable(
        "accepted payment lacks complete trusted input evidence",
      );
    this.#candidateRecord = {
      transactionId: candidate.id,
      checkpoint: cached?.checkpoint ?? evidence.checkpoint!,
      origins: this.#origins,
      transaction,
      evidence,
    };
    return transaction;
  }

  async getUtxosForAddress(address: string): Promise<RestObservedUtxo[]> {
    const snapshot =
      this.#snapshot ?? (await this.pnn.snapshotHashChainUtxos([address]));
    const script = scriptPublicKeyForAddress(address, "kaspa:testnet-10");
    return snapshot.utxos
      .filter((utxo) => utxo.scriptPublicKey === script)
      .map(observedUtxo);
  }

  async getVirtualDaaScore(): Promise<string> {
    const snapshot = await this.pnn.snapshotHashChainUtxos([]);
    if (!snapshot.checkpoint.daaScore)
      throw unavailable("PNN checkpoint lacks DAA score");
    await this.store.recordPnnCheckpoint(snapshot.checkpoint);
    return snapshot.checkpoint.daaScore;
  }

  async observeAcceptedUtxo(address: string, outpoint: FundingOutpoint) {
    const initial = (
      await this.pnn.snapshotHashChainUtxos([address])
    ).utxos.find((utxo) => sameOutpoint(utxo.outpoint, outpoint));
    if (!initial) return null;
    this.book.recordOutpoint(outpoint, initial.scriptPublicKey, address);
    const transaction = await this.getTransaction(outpoint.txid);
    if (!transaction) return null;
    const evidence = await this.acceptedTransactionEvidence(outpoint.txid);
    const current = await this.pnn.snapshotHashChainUtxos([address]);
    const matches = current.utxos.filter((utxo) =>
      sameOutpoint(utxo.outpoint, outpoint),
    );
    if (matches.length > 1)
      throw unavailable("PNN returned duplicate covenant UTXOs");
    const utxo = matches[0];
    const output = transaction.outputs?.find(
      (item) => item.index === outpoint.index,
    );
    if (!utxo || !output) return null;
    return { utxo: observedUtxo(utxo), transaction, output, evidence };
  }

  async acceptedTransactionEvidence(
    transactionId: string,
  ): Promise<AcceptedTransactionEvidence> {
    await this.getTransaction(transactionId);
    const record = await this.store.loadPnnEvidence(transactionId);
    if (!record?.evidence)
      throw unavailable("PNN accepted receipt is unavailable");
    return this.pnn.confirmAcceptedTransaction(
      record.evidence,
      this.confirmations,
    );
  }

  async submitTransaction(transaction: string): Promise<string> {
    return (await this.pnn.submitTransaction(transaction, this.book))
      .transactionId;
  }

  async waitForTransactionAccepted(
    transaction: SafeTransaction,
  ): Promise<RestTransaction> {
    const accepted = await this.getTransaction(transaction.id);
    if (!accepted) throw unavailable("PNN transaction is not accepted");
    assertChainTransactionMatchesSafe(accepted, transaction);
    return accepted;
  }
}

function observedTransaction(
  raw: unknown,
  evidence: AcceptedTransactionEvidence,
): RestTransaction {
  const tx = unwrapRecord(raw, "transaction");
  const outputs = optionalArray(tx.outputs, "PNN outputs");
  const inputs = optionalArray(tx.inputs, "PNN inputs");
  if (inputs.length > 16 || outputs.length > 64)
    throw unavailable("PNN transaction exceeds gateway evidence bounds");
  return {
    transaction_id: evidence.transactionId,
    is_accepted: true,
    version: Number(tx.version),
    lock_time: uintStringValue(tx.lockTime ?? "0", "PNN lock time"),
    subnetwork_id: String(tx.subnetworkId ?? "00".repeat(20)),
    gas: uintStringValue(tx.gas ?? "0", "PNN gas"),
    payload: String(tx.payload ?? ""),
    accepting_block_hash: evidence.acceptingBlockHash,
    accepting_block_blue_score: evidence.acceptingBlockBlueScore,
    inputs: inputs.map((item) => {
      const input = requiredRecord(item, "PNN input");
      const outpoint = pnnInputOutpoint(input);
      return {
        previous_outpoint_hash: outpoint.txid,
        previous_outpoint_index: outpoint.index,
        signature_script: String(input.signatureScript ?? ""),
        sequence: String(input.sequence ?? "0"),
        ...(pnnInputCovenantId(input)
          ? { covenant_id: pnnInputCovenantId(input) }
          : {}),
        ...(input.computeBudget !== undefined
          ? { compute_budget: String(input.computeBudget) }
          : {}),
        ...(input.sigOpCount !== undefined
          ? { sig_op_count: String(input.sigOpCount) }
          : {}),
      };
    }),
    outputs: outputs.map((item, index) => {
      const output = requiredRecord(item, "PNN output");
      const covenant = pnnOutputCovenant(output);
      return {
        index,
        amount: uintStringValue(
          output.value ?? output.amount,
          "PNN output amount",
        ),
        script_public_key: serializeSdkScriptPublicKey(output.scriptPublicKey),
        ...(covenant
          ? {
              covenant_id: covenant.covenantId,
              covenant_authorizing_input: covenant.authorizingInput,
            }
          : {}),
      };
    }),
  };
}

function acceptedOrigins(raw: unknown): PnnUtxo[] {
  return optionalArray(
    unwrapRecord(raw, "transaction").inputs,
    "PNN inputs",
  ).map((item) => {
    const input = requiredRecord(item, "PNN input");
    const entry = requiredRecord(
      requiredRecord(input.verboseData, "PNN input data").utxoEntry,
      "PNN input UTXO",
    );
    return {
      outpoint: pnnInputOutpoint(input),
      amount: uintStringValue(entry.amount, "PNN input amount"),
      scriptPublicKey: serializeSdkScriptPublicKey(entry.scriptPublicKey),
      covenantId:
        typeof entry.covenantId === "string"
          ? hashValue(entry.covenantId, "PNN input covenant")
          : null,
    };
  });
}

function unavailable(message: string) {
  return new KaspaX402Error("invalid_kaspa_transaction", message);
}

function observedUtxo(utxo: PnnUtxo): RestObservedUtxo {
  return {
    outpoint: utxo.outpoint,
    amount: utxo.amount,
    scriptPublicKey: utxo.scriptPublicKey,
    ...(utxo.covenantId ? { covenantId: utxo.covenantId } : {}),
  };
}
