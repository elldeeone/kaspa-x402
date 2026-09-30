import { describe, expect, it, vi } from "vitest";
import { HashChainPnnView } from "../src/hash-chain-pnn-view.js";

const HEAD = { txid: "11".repeat(32), index: 0 };
const HEAD_SCRIPT = `000020${"11".repeat(32)}ac`;
const PAYER_PUBLIC_KEY = "22".repeat(32);
const PAYER_SCRIPT = `000020${PAYER_PUBLIC_KEY}ac`;
const CLAIM = {
  grantId: "33".repeat(32),
  challengeId: "44".repeat(32),
  requestHash: "55".repeat(32),
  payerPublicKey: PAYER_PUBLIC_KEY,
  signature: "66".repeat(64),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

function viewWith(utxos: Array<{
  outpoint: { txid: string; index: number };
  amount: string;
  scriptPublicKey: string;
  covenantId: string | null;
}>) {
  const snapshotHashChainUtxos = vi.fn(async () => ({
    utxos,
    checkpoint: { blockHash: "77".repeat(32), blueScore: "1" },
  }));
  const exec = vi.fn((..._args: unknown[]) => ({}));
  const view = new HashChainPnnView(
    { snapshotHashChainUtxos } as never,
    { sql: { exec }, transactionSync: (operation: () => unknown) => operation() } as never,
  );
  return { view, exec };
}

describe("hash-chain PNN grant eligibility", () => {
  it("rejects a grant claim without an uncovenanted payer UTXO covering quote and fee", async () => {
    const head = { outpoint: HEAD, amount: "100000000", scriptPublicKey: HEAD_SCRIPT, covenantId: "88".repeat(32) };
    for (const payer of [
      undefined,
      { outpoint: { txid: "99".repeat(32), index: 0 }, amount: "20999999", scriptPublicKey: PAYER_SCRIPT, covenantId: null },
      { outpoint: { txid: "99".repeat(32), index: 0 }, amount: "21000000", scriptPublicKey: PAYER_SCRIPT, covenantId: "aa".repeat(32) },
    ]) {
      const { view, exec } = viewWith([head, ...(payer ? [payer] : [])]);
      await expect(view.currentUtxo(HEAD, HEAD_SCRIPT, undefined, CLAIM, "21000000"))
        .rejects.toThrow("payer has no eligible funding UTXO");
      expect(exec.mock.calls.some((call) => String(call[0]).includes(
        "INSERT OR IGNORE INTO hash_chain_origin_snapshots",
      ))).toBe(false);
    }
  });

  it("accepts and snapshots a funded payer only after the eligibility proof passes", async () => {
    const { view, exec } = viewWith([
      { outpoint: HEAD, amount: "100000000", scriptPublicKey: HEAD_SCRIPT, covenantId: "88".repeat(32) },
      { outpoint: { txid: "99".repeat(32), index: 0 }, amount: "21000000", scriptPublicKey: PAYER_SCRIPT, covenantId: null },
    ]);
    await expect(view.currentUtxo(HEAD, HEAD_SCRIPT, undefined, CLAIM, "21000000"))
      .resolves.toMatchObject({ outpoint: HEAD });
    expect(exec.mock.calls.some((call) => String(call[0]).includes(
      "INSERT OR IGNORE INTO hash_chain_origin_snapshots",
    ))).toBe(true);
  });
});
