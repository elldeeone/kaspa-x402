import { describe, expect, it, vi } from "vitest";
import {
  KaspaPnnClient,
  PnnBroadcastChainProvider,
  PnnChainEvidence,
  ScriptAddressBook,
  selectPnnChainEvidenceClient,
  type VerifiedKaspaChainProvider,
} from "../src/index.js";
import { MemoryEvidenceStore } from "./memory-evidence-store.js";

const checkpoint = (daaScore: string) => ({
  blockHash: "ab".repeat(32), blueScore: daaScore, daaScore,
});

describe("policy-selected PNN authorization", () => {
  it("rejects missing, raw, and type-bypassed clients before protected chain I/O", () => {
    const raw = new KaspaPnnClient({ endpoints: [] });
    const snapshot = vi.spyOn(raw, "snapshotHashChainUtxos");
    const confirm = vi.spyOn(raw, "confirmAcceptedTransaction");
    const lineage = vi.spyOn(raw, "discoverCovenantLineage");
    const book = new ScriptAddressBook();
    const store = new MemoryEvidenceStore();
    const reads = { getUtxo: vi.fn() } as unknown as VerifiedKaspaChainProvider;

    expect(() => new PnnChainEvidence(undefined as never, book, store))
      .toThrow("explicit PNN chain-evidence trust policy is required");
    expect(() => new PnnChainEvidence(raw as never, book, store))
      .toThrow("explicit PNN chain-evidence trust policy is required");
    expect(() => new PnnBroadcastChainProvider(reads, book, raw as never, 30))
      .toThrow("explicit PNN chain-evidence trust policy is required");
    expect(snapshot).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(lineage).not.toHaveBeenCalled();
    expect(reads.getUtxo).not.toHaveBeenCalled();
  });

  it("authorizes selected single-source reads with one verification node", async () => {
    const raw = new KaspaPnnClient({ endpoints: [] });
    const snapshot = vi.spyOn(raw, "snapshotHashChainUtxos")
      .mockResolvedValue({ utxos: [], checkpoint: checkpoint("100") });
    const selected = selectPnnChainEvidenceClient({ mode: "trusted-single-source", verification: raw });
    expect(selected).not.toBe(raw);

    const evidence = new PnnChainEvidence(selected, new ScriptAddressBook(), new MemoryEvidenceStore());
    await expect(evidence.getVirtualDaaScore()).resolves.toBe("100");
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it("keeps the selected verification authority after a runtime property swap", async () => {
    const safe = new KaspaPnnClient({ endpoints: [] });
    const rogue = new KaspaPnnClient({ endpoints: [] });
    const safeRead = vi.spyOn(safe, "snapshotHashChainUtxos")
      .mockResolvedValue({ utxos: [], checkpoint: checkpoint("100") });
    const rogueRead = vi.spyOn(rogue, "snapshotHashChainUtxos")
      .mockResolvedValue({ utxos: [], checkpoint: checkpoint("999") });
    const selected = selectPnnChainEvidenceClient({ mode: "trusted-single-source", verification: safe });
    const evidence = new PnnChainEvidence(selected, new ScriptAddressBook(), new MemoryEvidenceStore());
    Reflect.set(evidence, "pnn", rogue);

    await expect(evidence.getVirtualDaaScore()).resolves.toBe("100");
    expect(safeRead).toHaveBeenCalledTimes(1);
    expect(rogueRead).not.toHaveBeenCalled();
  });

  it("does not allow swapping the selected wrapper's verification target", async () => {
    const safe = new KaspaPnnClient({ endpoints: [] });
    const rogue = new KaspaPnnClient({ endpoints: [] });
    const safeRead = vi.spyOn(safe, "snapshotHashChainUtxos")
      .mockResolvedValue({ utxos: [], checkpoint: checkpoint("100") });
    const rogueRead = vi.spyOn(rogue, "snapshotHashChainUtxos")
      .mockResolvedValue({ utxos: [], checkpoint: checkpoint("999") });
    const selected = selectPnnChainEvidenceClient({ mode: "trusted-single-source", verification: safe });
    Reflect.set(selected, "verification", rogue);

    const evidence = new PnnChainEvidence(selected, new ScriptAddressBook(), new MemoryEvidenceStore());
    await expect(evidence.getVirtualDaaScore()).resolves.toBe("100");
    expect(safeRead).toHaveBeenCalledTimes(1);
    expect(rogueRead).not.toHaveBeenCalled();
  });

  it("does not allow replacing a policy-selected read method", async () => {
    const safe = new KaspaPnnClient({ endpoints: [] });
    const rogue = new KaspaPnnClient({ endpoints: [] });
    const safeRead = vi.spyOn(safe, "snapshotHashChainUtxos")
      .mockResolvedValue({ utxos: [], checkpoint: checkpoint("100") });
    const rogueRead = vi.spyOn(rogue, "snapshotHashChainUtxos")
      .mockResolvedValue({ utxos: [], checkpoint: checkpoint("999") });
    const selected = selectPnnChainEvidenceClient({ mode: "trusted-single-source", verification: safe });
    Reflect.set(selected, "snapshotHashChainUtxos", rogue.snapshotHashChainUtxos.bind(rogue));

    const evidence = new PnnChainEvidence(selected, new ScriptAddressBook(), new MemoryEvidenceStore());
    await expect(evidence.getVirtualDaaScore()).resolves.toBe("100");
    expect(safeRead).toHaveBeenCalledTimes(1);
    expect(rogueRead).not.toHaveBeenCalled();
  });

  it("does not allow replacing a policy-selected prototype method", async () => {
    const safe = new KaspaPnnClient({ endpoints: [] });
    const rogue = new KaspaPnnClient({ endpoints: [] });
    const safeRead = vi.spyOn(safe, "snapshotHashChainUtxos")
      .mockResolvedValue({ utxos: [], checkpoint: checkpoint("100") });
    const rogueRead = vi.spyOn(rogue, "snapshotHashChainUtxos")
      .mockResolvedValue({ utxos: [], checkpoint: checkpoint("999") });
    const selected = selectPnnChainEvidenceClient({ mode: "trusted-single-source", verification: safe });
    const prototype = Object.getPrototypeOf(selected) as object;
    const original = Object.getOwnPropertyDescriptor(prototype, "snapshotHashChainUtxos")!;
    try {
      Reflect.set(prototype, "snapshotHashChainUtxos", rogue.snapshotHashChainUtxos.bind(rogue));
      const evidence = new PnnChainEvidence(selected, new ScriptAddressBook(), new MemoryEvidenceStore());
      await expect(evidence.getVirtualDaaScore()).resolves.toBe("100");
      expect(safeRead).toHaveBeenCalledTimes(1);
      expect(rogueRead).not.toHaveBeenCalled();
    } finally {
      if (!Object.isFrozen(prototype)) Object.defineProperty(prototype, "snapshotHashChainUtxos", original);
    }
  });

  it("keeps corroboration authorities fixed after policy selection", async () => {
    const submission = new KaspaPnnClient({ endpoints: [] });
    const a = new KaspaPnnClient({ endpoints: [] });
    const b = new KaspaPnnClient({ endpoints: [] });
    const aRead = vi.spyOn(a, "snapshotHashChainUtxos")
      .mockResolvedValue({ utxos: [], checkpoint: checkpoint("100") });
    const bRead = vi.spyOn(b, "snapshotHashChainUtxos")
      .mockResolvedValue({ utxos: [], checkpoint: checkpoint("101") });
    const authorities = [
      { trustDomain: "operator-a", client: a }, { trustDomain: "operator-b", client: b },
    ];
    const selected = selectPnnChainEvidenceClient({ mode: "independent-corroboration",
      submission, authorities, requiredAuthorities: 2 });
    authorities[1]!.client = a;

    const evidence = new PnnChainEvidence(selected, new ScriptAddressBook(), new MemoryEvidenceStore());
    await expect(evidence.getVirtualDaaScore()).resolves.toBe("101");
    expect(aRead).toHaveBeenCalledTimes(1);
    expect(bRead).toHaveBeenCalledTimes(1);
  });

  it("corroborates independent reads and sends submissions only to the submission client", async () => {
    const submission = new KaspaPnnClient({ endpoints: [] });
    const a = new KaspaPnnClient({ endpoints: [] });
    const b = new KaspaPnnClient({ endpoints: [] });
    const submit = vi.spyOn(submission, "submitTransaction").mockResolvedValue({
      transactionId: "cd".repeat(32), finality: "accepted",
      evidence: { status: "unknown", transactionId: "cd".repeat(32), reason: "pending" },
    });
    const submissionRead = vi.spyOn(submission, "snapshotHashChainUtxos");
    const aRead = vi.spyOn(a, "snapshotHashChainUtxos")
      .mockResolvedValue({ utxos: [], checkpoint: checkpoint("100") });
    const bRead = vi.spyOn(b, "snapshotHashChainUtxos")
      .mockResolvedValue({ utxos: [], checkpoint: checkpoint("101") });
    const aSubmit = vi.spyOn(a, "submitTransaction");
    const bSubmit = vi.spyOn(b, "submitTransaction");
    const selected = selectPnnChainEvidenceClient({ mode: "independent-corroboration",
      submission, requiredAuthorities: 2, authorities: [
        { trustDomain: "operator-a", client: a }, { trustDomain: "operator-b", client: b },
      ] });
    const book = new ScriptAddressBook();
    const evidence = new PnnChainEvidence(selected, book, new MemoryEvidenceStore());
    await expect(evidence.getVirtualDaaScore()).resolves.toBe("101");
    await expect(evidence.submitTransaction("signed artifact")).resolves.toBe("cd".repeat(32));
    const reads = { getUtxo: vi.fn() } as unknown as VerifiedKaspaChainProvider;
    await expect(new PnnBroadcastChainProvider(reads, book, selected, 30)
      .sendTransaction("signed artifact")).resolves.toMatchObject({ transactionId: "cd".repeat(32) });
    expect(aRead).toHaveBeenCalledTimes(1);
    expect(bRead).toHaveBeenCalledTimes(1);
    expect(submissionRead).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledTimes(2);
    expect(aSubmit).not.toHaveBeenCalled();
    expect(bSubmit).not.toHaveBeenCalled();
  });
});
