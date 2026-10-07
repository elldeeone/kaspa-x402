import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  buildHashChainHeadRedeemScript,
  generateHashChainBorrowGrants,
  hashChainBorrowGuard,
  hashChainHeadScriptPublicKey,
  hashChainHeadTemplateHash,
  prepareHashChainBorrowGuards,
} from "../src/hash-chain.js";
import { payToScriptHashScript, serializedScriptPublicKey } from "../src/template.js";
import {
  HASH_CHAIN_HEAD_V2_COMPILED_BASE,
  HASH_CHAIN_HEAD_V2_SAMPLE_GUARD,
  HASH_CHAIN_HEAD_V2_SAMPLE_OWNER,
  HASH_CHAIN_HEAD_V2_SAMPLE_TEMPLATE_HASH,
} from "../src/generated/hash-chain-head-v2.js";

describe("hash-chain borrower authorization", () => {
  it("advances exactly once per released link, in reverse generation order", () => {
    const keyOne = "02".repeat(32);
    const keyTwo = "03".repeat(32);
    const chain = prepareHashChainBorrowGuards("01".repeat(32), [keyOne, keyTwo]);
    expect(chain.releases).toHaveLength(2);

    const first = chain.releases[0]!;
    expect(first.oneTimePublicKey).toBe(keyTwo);
    expect(hashChainBorrowGuard(first.revealedGuard, first.oneTimePublicKey)).toBe(chain.initialGuard);

    const second = chain.releases[1]!;
    expect(hashChainBorrowGuard(second.revealedGuard, second.oneTimePublicKey)).toBe(first.revealedGuard);
    expect(hashChainBorrowGuard(first.revealedGuard, first.oneTimePublicKey)).not.toBe(first.revealedGuard);
    expect(hashChainBorrowGuard(first.revealedGuard, keyOne)).not.toBe(chain.initialGuard);
  });

  it("rejects malformed guard and key material", () => {
    expect(() => hashChainBorrowGuard("00", "02".repeat(32))).toThrow("revealedGuard");
    expect(() => hashChainBorrowGuard("01".repeat(32), "00")).toThrow("oneTimePublicKey");
    expect(() => prepareHashChainBorrowGuards("01".repeat(32), [])).toThrow("one-time key");
  });

  it("generates unique signing keys and a verifiable two-link release sequence", () => {
    const chain = generateHashChainBorrowGrants(2);
    expect(chain.grants).toHaveLength(2);
    expect(chain.grants[0]!.oneTimePrivateKey).not.toBe(chain.grants[1]!.oneTimePrivateKey);
    let guard = chain.initialGuard;
    for (const grant of chain.grants) {
      expect(Buffer.from(schnorr.getPublicKey(Buffer.from(grant.oneTimePrivateKey, "hex"))).toString("hex"))
        .toBe(grant.oneTimePublicKey);
      expect(hashChainBorrowGuard(grant.revealedGuard, grant.oneTimePublicKey)).toBe(guard);
      guard = grant.revealedGuard;
    }
    expect(() => generateHashChainBorrowGrants(0)).toThrow("grant count");
  });

  it("instantiates the pinned SilverScript ABI and derives distinct successor scripts", () => {
    expect(buildHashChainHeadRedeemScript({
      ownerPublicKey: HASH_CHAIN_HEAD_V2_SAMPLE_OWNER,
      guard: HASH_CHAIN_HEAD_V2_SAMPLE_GUARD,
    })).toBe(HASH_CHAIN_HEAD_V2_COMPILED_BASE);
    const next = { ownerPublicKey: HASH_CHAIN_HEAD_V2_SAMPLE_OWNER, guard: "23".repeat(32) };
    const redeemScript = buildHashChainHeadRedeemScript(next);
    expect(redeemScript).not.toBe(HASH_CHAIN_HEAD_V2_COMPILED_BASE);
    expect(hashChainHeadScriptPublicKey(next))
      .toBe(serializedScriptPublicKey(payToScriptHashScript(redeemScript)));
    expect(hashChainHeadScriptPublicKey(next)).not.toBe(hashChainHeadScriptPublicKey({
      ownerPublicKey: HASH_CHAIN_HEAD_V2_SAMPLE_OWNER,
      guard: HASH_CHAIN_HEAD_V2_SAMPLE_GUARD,
    }));
    expect(hashChainHeadTemplateHash(HASH_CHAIN_HEAD_V2_SAMPLE_OWNER)).toBe(HASH_CHAIN_HEAD_V2_SAMPLE_TEMPLATE_HASH);
  });

  it("derives the same head scripts as the independent Rusty-Kaspa consensus vector", () => {
    const vector = JSON.parse(readFileSync(new URL("../../../vectors/hash-chain/consensus-v1.json", import.meta.url), "utf8"));
    const expected = vector.expected;
    expect(hashChainHeadScriptPublicKey({ ownerPublicKey: HASH_CHAIN_HEAD_V2_SAMPLE_OWNER, guard: expected.chain.initialGuard }))
      .toBe(expected.transactions.genesis.transaction.outputs[0].scriptPublicKey);
    expect(hashChainHeadScriptPublicKey({ ownerPublicKey: HASH_CHAIN_HEAD_V2_SAMPLE_OWNER, guard: expected.chain.firstRevealedGuard }))
      .toBe(expected.transactions.borrow1.transaction.outputs[0].scriptPublicKey);
    expect(hashChainHeadScriptPublicKey({ ownerPublicKey: HASH_CHAIN_HEAD_V2_SAMPLE_OWNER, guard: expected.chain.secondRevealedGuard }))
      .toBe(expected.transactions.borrow2.transaction.outputs[0].scriptPublicKey);
  });
});
