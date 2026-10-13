import type { AcceptedTransactionEvidence, ChainCheckpoint, FundingOutpoint } from "@kaspa-x402/core";
import {
  HashChainExactTransactionVerifier,
  type ExactTransactionVerificationRequest,
  type ExactTransactionVerifier,
  type HashChainSelectedTransaction,
  type HashChainTrustedOrigin,
} from "@kaspa-x402/server";
import type { HashChainGrantClaim } from "@kaspa-x402/server/hash-chain-issuer";
import { KaspaPnnClient } from "@kaspa-x402/adapters";
import { addressForScriptPublicKey } from "@kaspa-x402/adapters/native";
import type { HashChainStorage } from "./hash-chain-storage.js";

type Origin = HashChainTrustedOrigin & { outpoint: FundingOutpoint };
type Snapshot = { utxos: Origin[]; checkpoint: ChainCheckpoint };
type Accepted = { transaction: HashChainSelectedTransaction; evidence: AcceptedTransactionEvidence };

/** Public REST indexes omit covenant data; use the gateway's configured PNNs. */
export class HashChainPnnView implements ExactTransactionVerifier {
  constructor(private readonly pnn: KaspaPnnClient, private readonly storage: HashChainStorage) {
    storage.sql.exec("CREATE TABLE IF NOT EXISTS hash_chain_origin_snapshots (challenge_id TEXT PRIMARY KEY, snapshot TEXT NOT NULL)");
    storage.sql.exec("CREATE TABLE IF NOT EXISTS hash_chain_acceptance (transaction_id TEXT PRIMARY KEY, acceptance TEXT NOT NULL)");
  }

  async currentUtxo(
    outpoint: FundingOutpoint,
    script: string,
    signal?: AbortSignal,
    claim?: HashChainGrantClaim,
    requiredPayerFunding?: string,
  ) {
    signal?.throwIfAborted();
    const addresses = [addressForScriptPublicKey(script, "kaspa:testnet-10")];
    if (claim) addresses.push(addressForScriptPublicKey(`000020${claim.payerPublicKey}ac`, "kaspa:testnet-10"));
    const snapshot = await this.pnn.snapshotHashChainUtxos(addresses, signal);
    signal?.throwIfAborted();
    const matching = snapshot.utxos.filter((item) => sameOutpoint(item.outpoint, outpoint));
    if (matching.length > 1) throw new Error("PNN returned duplicate head UTXOs");
    if (claim && matching.length === 1) {
      const payerScript = `000020${claim.payerPublicKey}ac`;
      if (requiredPayerFunding === undefined || !snapshot.utxos.some((item) =>
        item.covenantId === null &&
        item.scriptPublicKey === payerScript &&
        BigInt(item.amount) >= BigInt(requiredPayerFunding))) {
        throw new Error("payer has no eligible funding UTXO");
      }
      // A repeated delivery must retain the checkpoint from before the spend.
      this.storage.sql.exec("INSERT OR IGNORE INTO hash_chain_origin_snapshots(challenge_id, snapshot) VALUES(?, ?)",
        claim.challengeId, JSON.stringify(snapshot));
    }
    return matching[0] ?? null;
  }

  async verifyExactPayment(request: ExactTransactionVerificationRequest) {
    const row = this.storage.sql.exec<{ snapshot: string }>(
      "SELECT snapshot FROM hash_chain_origin_snapshots WHERE challenge_id = ?",
      request.hashChainHead?.challengeId ?? "",
    ).toArray()[0];
    const snapshot: Snapshot | undefined = row ? JSON.parse(row.snapshot) : undefined;
    return new HashChainExactTransactionVerifier({
      getAcceptedOrigins: async (outpoints, { signal } = {}) => {
        signal?.throwIfAborted();
        return outpoints.map((outpoint) => {
          const matches = snapshot?.utxos.filter((origin) => sameOutpoint(origin.outpoint, outpoint)) ?? [];
          if (matches.length > 1) throw new Error("PNN origin snapshot contains duplicate outpoints");
          return matches[0] ?? null;
        });
      },
      getSelectedTransaction: async (id, { signal } = {}) => {
        signal?.throwIfAborted();
        const cached = this.#accepted(id);
        if (cached) return await this.isSelected(id, { signal }) ? cached.transaction : null;
        if (!snapshot) return null;
        const accepted = await this.pnn.findHashChainPayment(id, snapshot.checkpoint, signal);
        signal?.throwIfAborted();
        if (accepted) this.storage.sql.exec(
          "INSERT OR IGNORE INTO hash_chain_acceptance(transaction_id, acceptance) VALUES(?, ?)", id, JSON.stringify(accepted));
        return accepted?.transaction ?? null;
      },
    }).verifyExactPayment(request);
  }

  async isSelected(id: string, { signal }: { signal?: AbortSignal } = {}) {
    signal?.throwIfAborted();
    const accepted = this.#accepted(id);
    if (!accepted) return false;
    await this.pnn.confirmAcceptedTransaction(accepted.evidence, 1, signal);
    signal?.throwIfAborted();
    return true;
  }

  #accepted(id: string): Accepted | undefined {
    const row = this.storage.sql.exec<{ acceptance: string }>(
      "SELECT acceptance FROM hash_chain_acceptance WHERE transaction_id = ?", id,
    ).toArray()[0];
    return row ? JSON.parse(row.acceptance) : undefined;
  }
}

function sameOutpoint(left: FundingOutpoint, right: FundingOutpoint): boolean {
  return left.txid === right.txid && left.index === right.index;
}
