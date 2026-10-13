import type { AcceptedTransactionEvidence, ChainCheckpoint, FundingOutpoint } from "@kaspa-x402/core";
import {
  authenticateHashChainPaymentLocally,
  HashChainExactTransactionVerifier,
  type ExactTransactionVerificationRequest,
  type ExactTransactionVerifier,
  type HashChainSelectedTransaction,
  type HashChainTrustedOrigin,
} from "@kaspa-x402/server";
import type { HashChainGrantClaim } from "@kaspa-x402/server/hash-chain-issuer";
import { assertPolicySelectedPnnClient, type PolicySelectedPnnClient } from "@kaspa-x402/adapters";
import { addressForScriptPublicKey } from "@kaspa-x402/adapters/native";
import type { HashChainStorage } from "./hash-chain-storage.js";

type Origin = HashChainTrustedOrigin & { outpoint: FundingOutpoint };
type Snapshot = { utxos: Origin[]; checkpoint: ChainCheckpoint };
type Accepted = { transaction: HashChainSelectedTransaction; evidence: AcceptedTransactionEvidence };

/** Public REST indexes omit covenant data; use the gateway's configured PNNs. */
export class HashChainPnnView implements ExactTransactionVerifier {
  readonly #pnn: PolicySelectedPnnClient;

  constructor(pnn: PolicySelectedPnnClient, private readonly storage: HashChainStorage) {
    assertPolicySelectedPnnClient(pnn);
    this.#pnn = pnn;
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
    const snapshot = await this.#pnn.snapshotHashChainUtxos(addresses, signal);
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
      // The service supplies a claim only before assignment; refresh that payer's pre-spend snapshot.
      this.storage.sql.exec("INSERT OR REPLACE INTO hash_chain_origin_snapshots(challenge_id, snapshot) VALUES(?, ?)",
        claimantSnapshotKey(claim.challengeId, claim.payerPublicKey), JSON.stringify(snapshot));
    }
    return matching[0] ?? null;
  }

  qualifyingFundingOutpoints(claim: HashChainGrantClaim, requiredAmount: string) {
    const row = this.storage.sql.exec<{ snapshot: string }>(
      "SELECT snapshot FROM hash_chain_origin_snapshots WHERE challenge_id = ?",
      claimantSnapshotKey(claim.challengeId, claim.payerPublicKey),
    ).toArray()[0];
    if (!row) throw new Error("payer funding snapshot is unavailable");
    const snapshot = JSON.parse(row.snapshot) as Snapshot;
    const script = `000020${claim.payerPublicKey}ac`;
    const eligible = snapshot.utxos.filter((utxo) =>
      utxo.covenantId === null && utxo.scriptPublicKey === script &&
      BigInt(utxo.amount) >= BigInt(requiredAmount));
    if (eligible.length === 0) throw new Error("payer has no eligible funding UTXO");
    eligible.sort((a, b) => `${a.outpoint.txid}:${a.outpoint.index}`.localeCompare(`${b.outpoint.txid}:${b.outpoint.index}`));
    return eligible.map((utxo) => utxo.outpoint);
  }

  async verifyExactPayment(request: ExactTransactionVerificationRequest) {
    const challengeId = request.hashChainHead?.challengeId ?? "";
    const payerPublicKey = request.hashChainHead
      ? authenticateHashChainPaymentLocally(request).payerPublicKey : "";
    const row = this.storage.sql.exec<{ snapshot: string }>(
      "SELECT snapshot FROM hash_chain_origin_snapshots WHERE challenge_id = ?",
      claimantSnapshotKey(challengeId, payerPublicKey),
    ).toArray()[0];
    let snapshot: Snapshot | undefined = row ? JSON.parse(row.snapshot) : undefined;
    if (!snapshot && payerPublicKey) {
      const legacy = this.storage.sql.exec<{ snapshot: string }>(
        "SELECT snapshot FROM hash_chain_origin_snapshots WHERE challenge_id = ?", challengeId,
      ).toArray()[0];
      const oldSnapshot: Snapshot | undefined = legacy ? JSON.parse(legacy.snapshot) : undefined;
      if (oldSnapshot?.utxos.some((utxo) =>
        utxo.covenantId === null && utxo.scriptPublicKey === `000020${payerPublicKey}ac`))
        snapshot = oldSnapshot;
    }
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
        const accepted = await this.#pnn.findHashChainPayment(id, snapshot.checkpoint, signal);
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
    await this.#pnn.confirmAcceptedTransaction(accepted.evidence, 1, signal);
    signal?.throwIfAborted();
    return true;
  }

  async selectedOwnerRotation(id: string, from: ChainCheckpoint, signal?: AbortSignal) {
    const accepted = await this.#pnn.findHashChainPayment(id, from, signal);
    if (!accepted) return null;
    await this.#pnn.confirmAcceptedTransaction(accepted.evidence, 1, signal);
    signal?.throwIfAborted();
    return accepted.transaction;
  }

  #accepted(id: string): Accepted | undefined {
    const row = this.storage.sql.exec<{ acceptance: string }>(
      "SELECT acceptance FROM hash_chain_acceptance WHERE transaction_id = ?", id,
    ).toArray()[0];
    return row ? JSON.parse(row.acceptance) : undefined;
  }
}

function claimantSnapshotKey(challengeId: string, payerPublicKey: string): string {
  return `${challengeId.toLowerCase()}:${payerPublicKey.toLowerCase()}`;
}

function sameOutpoint(left: FundingOutpoint, right: FundingOutpoint): boolean {
  return left.txid === right.txid && left.index === right.index;
}
