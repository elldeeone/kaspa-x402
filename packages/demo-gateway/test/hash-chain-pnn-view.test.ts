import { describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { schnorr } from "@noble/curves/secp256k1.js";
import { HashChainGrantIssuer, hashChainGrantClaimDigest } from "@kaspa-x402/server/hash-chain-grants";
import { generateHashChainBorrowGrants, hashChainHeadScriptPublicKey } from "@kaspa-x402/covenant";
import { KaspaPnnClient, selectPnnChainEvidenceClient } from "@kaspa-x402/adapters";
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
    checkpoint: { blockHash: "77".repeat(32), blueScore: "1", daaScore: "1" },
  }));
  const exec = vi.fn((..._args: unknown[]) => ({}));
  const raw = new KaspaPnnClient({ endpoints: [] });
  vi.spyOn(raw, "snapshotHashChainUtxos").mockImplementation(snapshotHashChainUtxos);
  const view = new HashChainPnnView(
    selectPnnChainEvidenceClient({ mode: "trusted-single-source", verification: raw }),
    { sql: { exec }, transactionSync: (operation: () => unknown) => operation() } as never,
  );
  return { view, exec };
}

describe("hash-chain PNN grant eligibility", () => {
  it("rejects a raw verification client before touching grant storage", () => {
    const raw = new KaspaPnnClient({ endpoints: [] });
    const sql = { exec: vi.fn() };
    expect(() => new HashChainPnnView(raw as never, { sql } as never))
      .toThrow("explicit PNN chain-evidence trust policy is required");
    expect(sql.exec).not.toHaveBeenCalled();
  });

  it("keeps the selected authority after a runtime property swap", async () => {
    const head = { outpoint: HEAD, amount: "100000000", scriptPublicKey: HEAD_SCRIPT,
      covenantId: "88".repeat(32) };
    const { view } = viewWith([head]);
    const rogue = new KaspaPnnClient({ endpoints: [] });
    const rogueRead = vi.spyOn(rogue, "snapshotHashChainUtxos").mockResolvedValue({
      utxos: [], checkpoint: { blockHash: "99".repeat(32), blueScore: "9", daaScore: "9" },
    });
    Reflect.set(view, "pnn", rogue);
    await expect(view.currentUtxo(HEAD, HEAD_SCRIPT)).resolves.toMatchObject({ outpoint: HEAD });
    expect(rogueRead).not.toHaveBeenCalled();
  });

  it("uses fresh funding when a lower-sorting abandoned outpoint remains unspent after restart", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), "kaspa-gateway-grant-funding-"));
    const file = path.join(folder, "grants.sqlite");
    const key = randomBytes(32);
    const secret = Buffer.alloc(32, 7);
    const payerPublicKey = Buffer.from(schnorr.getPublicKey(secret)).toString("hex");
    const payerScript = `000020${payerPublicKey}ac`;
    const ownerPublicKey = "56b328b30c8bf5839e24058747879408bdb36241dc9c2e7c619faa12b2920967";
    const oldFunding = { txid: "01".repeat(32), index: 0 };
    const freshFunding = { txid: "ff".repeat(32), index: 0 };
    const funding = (outpoint: typeof oldFunding) => ({ outpoint, amount: "21000000",
      scriptPublicKey: payerScript, covenantId: null });
    const snapshots = new Map<string, string>();
    let selectedUtxos: Array<{ outpoint: typeof oldFunding; amount: string;
      scriptPublicKey: string; covenantId: string | null }> = [];
    const raw = new KaspaPnnClient({ endpoints: [] });
    vi.spyOn(raw, "snapshotHashChainUtxos").mockImplementation(async () => ({
      utxos: selectedUtxos, checkpoint: { blockHash: "77".repeat(32), blueScore: "1", daaScore: "1" },
    }));
    const view = new HashChainPnnView(
      selectPnnChainEvidenceClient({ mode: "trusted-single-source", verification: raw }),
      { sql: { exec(query: string, ...args: unknown[]) {
      if (query.startsWith("INSERT OR IGNORE INTO hash_chain_origin_snapshots"))
        snapshots.set(String(args[0]), String(args[1]));
      return { toArray: () => query.startsWith("SELECT snapshot") && snapshots.has(String(args[0]))
        ? [{ snapshot: snapshots.get(String(args[0]))! }] : [] };
    } }, transactionSync: (operation: () => unknown) => operation() } as never);
    let now = new Date("2026-09-22T12:00:00.000Z");
    const admissionPolicy = { maxGrantsPerClaimant: 1, windowSeconds: 86_400,
      resolveFundingOutpoint: async (claim: { challengeId: string; payerPublicKey: string }) =>
        view.qualifyingFundingOutpoints(claim as never, "21000000") };
    let issuer = await HashChainGrantIssuer.open({ databasePath: file, encryptionKey: key,
      admissionPolicy, now: () => now });
    const heads = ["ab".repeat(32), "bc".repeat(32)];
    const headUtxos = [] as typeof selectedUtxos;
    try {
      for (const [index, headId] of heads.entries()) {
        const chain = generateHashChainBorrowGrants(1);
        const head = { outpoint: { txid: (index + 2).toString(16).padStart(2, "0").repeat(32), index: 0 as const },
          amount: "100000000", guard: chain.initialGuard, covenantId: "de".repeat(32),
          scriptPublicKey: hashChainHeadScriptPublicKey({ ownerPublicKey, guard: chain.initialGuard }) };
        headUtxos.push(head);
        issuer.installHead({ headId, network: "kaspa:testnet-10", ownerPublicKey, head, grants: chain.grants });
      }
      const claimFor = (challenge: { grantId: string; challengeId: string; requestHash: string; expiresAt: string }) => {
        const unsigned = { grantId: challenge.grantId, challengeId: challenge.challengeId,
          requestHash: challenge.requestHash, payerPublicKey, expiresAt: challenge.expiresAt };
        return { ...unsigned, signature: Buffer.from(schnorr.sign(
          hashChainGrantClaimDigest("kaspa:testnet-10", unsigned), secret)).toString("hex") };
      };
      const claimOn = async (headId: string, requestHash: string) => {
        const challenge = issuer.issueAdmittedChallenge(headId, requestHash, 60, "20000000", "ef".repeat(32));
        const claim = claimFor(challenge);
        return issuer.claimGrantAfterCurrentHeadObservation(headId, claim, { observe: async (current) =>
          view.currentUtxo(current.head.outpoint, current.head.scriptPublicKey, undefined, claim, "21000000") });
      };
      selectedUtxos = [headUtxos[0]!, funding(oldFunding)];
      await expect(claimOn(heads[0]!, "cd".repeat(32))).resolves.toMatchObject({ grantId: expect.any(String) });
      issuer.close();
      now = new Date("2026-09-23T12:00:01.000Z");
      issuer = await HashChainGrantIssuer.open({ databasePath: file, encryptionKey: key,
        admissionPolicy, now: () => now });
      expect(issuer.getCurrent(heads[0]!).phase).toBe("needsRotation");
      selectedUtxos = [headUtxos[1]!, funding(oldFunding), funding(freshFunding)];
      await expect(claimOn(heads[1]!, "ce".repeat(32))).resolves.toMatchObject({ grantId: expect.any(String) });
      expect(issuer.getCurrent(heads[1]!).phase).toBe("assigned");
    } finally { issuer.close(); rmSync(folder, { recursive: true, force: true }); }
  });

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
