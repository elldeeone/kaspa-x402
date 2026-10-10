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
  savePnnEvidence(record: PnnEvidenceRecord, signal?: AbortSignal): Promise<void>;
  recordPnnCheckpoint(checkpoint: ChainCheckpoint, signal?: AbortSignal): Promise<void>;
  findPnnCheckpointBefore(
    daaScore: string,
  ): Promise<ChainCheckpoint | undefined>;
}

/** One request's node reads; durable receipts survive Worker restarts. */
export class PnnChainEvidence implements ChainEvidenceClient {
  #signal?: AbortSignal;
  #candidate?: SafeTransaction;
  #candidateRecord?: PnnEvidenceRecord;
  #origins: PnnUtxo[] = [];
  #paymentOutput?: { address: string; index: number };
  #verified = new Map<
    string,
    { transaction: RestTransaction; evidence: AcceptedTransactionEvidence }
  >();
  #snapshot?: Awaited<ReturnType<KaspaPnnClient["snapshotHashChainUtxos"]>>;

  constructor(
    readonly pnn: KaspaPnnClient,
    readonly book: ScriptAddressBook,
    readonly store: PnnEvidenceStore,
    readonly confirmations = 30,
  ) {}

  async verifyExactPayment(request: ExactTransactionVerificationRequest) {
    this.#resetVerification(request);
    // Signature/envelope validation in the shared verifier precedes node I/O.
    const result = await new VerifiedExactTransactionVerifier(
      this,
    ).verifyExactPayment(request);
    this.#checkLive();
    const checkpoint =
      this.#candidateRecord?.checkpoint ?? this.#snapshot?.checkpoint;
    if (!checkpoint)
      throw unavailable("exact payment lacks a trusted PNN checkpoint");
    const evidenceReceipt: PnnEvidenceRecord = {
      transactionId: result.transactionId,
      checkpoint,
      origins: this.#origins,
      ...(this.#candidateRecord?.transaction
        ? {
            transaction: this.#candidateRecord.transaction,
            evidence: this.#candidateRecord.evidence,
          }
        : {}),
    };
    return { ...result, evidenceReceipt };
  }

  async persistOwnedEvidence(
    transactionId: string,
    receipt: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    if (!receipt || typeof receipt !== "object" ||
      (receipt as PnnEvidenceRecord).transactionId !== transactionId) {
      throw unavailable("owned PNN receipt does not match the claimed transaction");
    }
    const latest = this.#candidateRecord?.transactionId === transactionId &&
      this.#candidateRecord.transaction && this.#candidateRecord.evidence
      ? this.#candidateRecord : receipt as PnnEvidenceRecord;
    await this.store.savePnnEvidence(latest, signal);
  }

  #checkLive(): void { this.#signal?.throwIfAborted(); }

  #resetVerification(request: ExactTransactionVerificationRequest): void {
    this.#signal = request.signal;
    this.#checkLive();
    this.#verified.clear();
    this.#candidateRecord = undefined;
    this.#origins = [];
    this.#snapshot = undefined;
    this.#paymentOutput = {
      address: request.payTo,
      index: request.paymentOutputIndex,
    };
    this.#candidate = parseSafeTransactionArtifact(request.transaction);
  }

  async getTransaction(transactionId: string): Promise<RestTransaction | null> {
    this.#checkLive();
    const id = hashValue(transactionId, "PNN transaction id");
    const verified = this.#verified.get(id);
    if (verified) return verified.transaction;
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
      const evidence = await this.pnn.confirmAcceptedTransaction(
        cached.evidence,
        this.confirmations,
        this.#signal,
      );
      return this.#remember(id, cached.transaction, evidence);
    }
    const snapshot = await this.pnn.snapshotHashChainUtxos(
      this.book.addresses(),
      this.#signal,
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
    }, this.#signal);
    if (!accepted) return null;
    const evidence = await this.pnn.confirmAcceptedTransaction(
      accepted.evidence,
      this.confirmations,
      this.#signal,
    );
    const transaction = observedTransaction(accepted.raw, evidence);
    this.#checkLive();
    return this.#remember(id, transaction, evidence);
  }

  async #candidateTransaction(): Promise<RestTransaction | null> {
    this.#checkLive();
    const candidate = this.#candidate!;
    const cached = await this.store.loadPnnEvidence(candidate.id);
    this.#candidateRecord = cached;
    if (cached?.origins) this.#origins = cached.origins;
    if (cached?.transaction && cached.evidence) {
      const evidence = await this.pnn.confirmAcceptedTransaction(
        cached.evidence,
        this.confirmations,
        this.#signal,
      );
      assertChainTransactionMatchesSafe(cached.transaction, candidate);
      this.#candidateRecord = { ...cached, evidence };
      return this.#remember(candidate.id, cached.transaction, evidence);
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
    this.#snapshot = await this.pnn.snapshotHashChainUtxos(addresses, this.#signal);
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
    let from = cached?.checkpoint;
    if (!cached) {
      const snapshot = await this.pnn.snapshotHashChainUtxos([
        this.#paymentOutput!.address,
      ], this.#signal);
      const output = snapshot.utxos.find((item) =>
        sameOutpoint(item.outpoint, {
          txid: candidate.id,
          index: this.#paymentOutput!.index,
        }),
      );
      if (!output)
        throw unavailable(
          "spent payment inputs have no accepted candidate output or durable receipt",
        );
      if (output.blockDaaScore)
        from = await this.store.findPnnCheckpointBefore(output.blockDaaScore);
    }
    const accepted = await this.pnn.findAcceptedTransaction(
      candidate.id,
      from ? { from } : {},
      this.#signal,
    );
    if (!accepted)
      throw unavailable(
        "payment inputs are spent or missing and accepted evidence is unavailable",
      );
    const evidence = await this.pnn.confirmAcceptedTransaction(
      accepted.evidence,
      this.confirmations,
      this.#signal,
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
    // A pending receipt's origins were authenticated before broadcast. Commit
    // its accepted readback before the settlement reconciler asks for evidence.
    this.#checkLive();
    return this.#remember(candidate.id, transaction, evidence);
  }

  async getUtxosForAddress(address: string): Promise<RestObservedUtxo[]> {
    this.#checkLive();
    const snapshot =
      this.#snapshot ?? (await this.pnn.snapshotHashChainUtxos([address], this.#signal));
    this.#checkLive();
    const script = scriptPublicKeyForAddress(address, "kaspa:testnet-10");
    return snapshot.utxos
      .filter((utxo) => utxo.scriptPublicKey === script)
      .map(observedUtxo);
  }

  async getVirtualDaaScore(signal?: AbortSignal): Promise<string> {
    const liveSignal = signal ?? this.#signal;
    liveSignal?.throwIfAborted();
    const snapshot = await this.pnn.snapshotHashChainUtxos([], liveSignal);
    liveSignal?.throwIfAborted();
    if (!snapshot.checkpoint.daaScore)
      throw unavailable("PNN checkpoint lacks DAA score");
    await this.store.recordPnnCheckpoint(snapshot.checkpoint, liveSignal);
    liveSignal?.throwIfAborted();
    return snapshot.checkpoint.daaScore;
  }

  async observeAcceptedUtxo(address: string, outpoint: FundingOutpoint) {
    const initial = (
      await this.pnn.snapshotHashChainUtxos([address], this.#signal)
    ).utxos.find((utxo) => sameOutpoint(utxo.outpoint, outpoint));
    if (!initial) return null;
    this.book.recordOutpoint(outpoint, initial.scriptPublicKey, address);
    const transaction = await this.getTransaction(outpoint.txid);
    if (!transaction) return null;
    const evidence = await this.acceptedTransactionEvidence(outpoint.txid);
    const current = await this.pnn.snapshotHashChainUtxos([address], this.#signal);
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
    const verified = this.#verified.get(transactionId);
    if (!verified) throw unavailable("PNN accepted receipt is unavailable");
    return structuredClone(verified.evidence);
  }

  #remember(
    id: string,
    transaction: RestTransaction,
    evidence: AcceptedTransactionEvidence,
  ) {
    this.#verified.set(id, { transaction, evidence });
    return transaction;
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
