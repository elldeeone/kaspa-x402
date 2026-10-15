import type { NetworkId } from "@kaspa-x402/core";
import type { PnnEvidenceRecord, PnnEvidenceStore, PnnNetworkCheckpoint } from "../src/index.js";

// Test-only storage: adapter restart tests share this state; this is not crash-durable.
export class MemoryEvidenceStore implements PnnEvidenceStore {
  private records = new Map<string, PnnEvidenceRecord>();
  private checkpoints: PnnNetworkCheckpoint[] = [];
  async loadPnnEvidence(id: string) { return structuredClone(this.records.get(id)); }
  async savePnnEvidence(record: PnnEvidenceRecord) {
    this.records.set(record.transactionId, structuredClone(record));
  }
  async recordPnnCheckpoint(checkpoint: PnnNetworkCheckpoint) {
    this.checkpoints.push(structuredClone(checkpoint));
  }
  async findPnnCheckpointBefore(daaScore: string, network: NetworkId = "kaspa:testnet-10") {
    return structuredClone(this.checkpoints
      .filter(item => (item.network ?? "kaspa:testnet-10") === network && BigInt(item.daaScore!) < BigInt(daaScore))
      .sort((a, b) => BigInt(a.daaScore!) > BigInt(b.daaScore!) ? -1 : 1)[0]);
  }
}
