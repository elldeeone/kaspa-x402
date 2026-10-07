import type { ChainCheckpoint } from "@kaspa-x402/core";
import type { PnnEvidenceRecord, PnnEvidenceStore } from "../src/index.js";

// Test-only storage: adapter restart tests share this state; this is not crash-durable.
export class MemoryEvidenceStore implements PnnEvidenceStore {
  private records = new Map<string, PnnEvidenceRecord>();
  private checkpoints: ChainCheckpoint[] = [];
  async loadPnnEvidence(id: string) { return structuredClone(this.records.get(id)); }
  async savePnnEvidence(record: PnnEvidenceRecord) {
    this.records.set(record.transactionId, structuredClone(record));
  }
  async recordPnnCheckpoint(checkpoint: ChainCheckpoint) {
    this.checkpoints.push(structuredClone(checkpoint));
  }
  async findPnnCheckpointBefore(daaScore: string) {
    return structuredClone(this.checkpoints
      .filter(item => BigInt(item.daaScore!) < BigInt(daaScore))
      .sort((a, b) => BigInt(a.daaScore!) > BigInt(b.daaScore!) ? -1 : 1)[0]);
  }
}
