import { blake3 } from "@noble/hashes/blake3.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  HASH_CHAIN_HEAD_V1_COMPILED_BASE,
  HASH_CHAIN_HEAD_V1_LAYOUT,
  HASH_CHAIN_HEAD_V1_SAMPLE_OWNER,
  HASH_CHAIN_HEAD_V1_SAMPLE_GUARD,
} from "./generated/hash-chain-head-v1.js";
import { payToScriptHashScript, serializedScriptPublicKey } from "./template.js";

export interface HashChainBorrowGrant {
  revealedGuard: string;
  oneTimePublicKey: string;
  /** Secret signing material. Never place this in a public offer or log. */
  oneTimePrivateKey: string;
}

export interface HashChainHeadParams {
  ownerPublicKey: string;
  guard: string;
}

/** KCC20 hash-chain/v1 guard step: unkeyed BLAKE3(link || one-time pubkey). */
export function hashChainBorrowGuard(revealedGuard: string, oneTimePublicKey: string): string {
  const link = fixedBytes(revealedGuard, "revealedGuard");
  const key = fixedBytes(oneTimePublicKey, "oneTimePublicKey");
  const input = new Uint8Array(64);
  input.set(link);
  input.set(key, 32);
  return Buffer.from(blake3(input)).toString("hex");
}

/**
 * Prepare public guard material for keys in generation order. Borrowers consume
 * the returned links in reverse order, matching KCC20 hash-chain/v1.
 * The caller retains the matching one-time private keys in secure storage.
 */
export function prepareHashChainBorrowGuards(
  seed: string,
  oneTimePublicKeys: readonly string[],
): { initialGuard: string; releases: readonly { revealedGuard: string; oneTimePublicKey: string }[] } {
  if (oneTimePublicKeys.length === 0) throw new Error("hash chain requires a one-time key");
  let guard = Buffer.from(fixedBytes(seed, "seed")).toString("hex");
  const forward: { revealedGuard: string; oneTimePublicKey: string }[] = [];
  for (const publicKey of oneTimePublicKeys) {
    const revealedGuard = guard;
    guard = hashChainBorrowGuard(revealedGuard, publicKey);
    forward.push({ revealedGuard, oneTimePublicKey: publicKey.toLowerCase() });
  }
  return { initialGuard: guard, releases: forward.reverse() };
}

/** Generates fresh one-time keys and the matching reverse-order grant chain. */
export function generateHashChainBorrowGrants(count: number): {
  initialGuard: string;
  grants: readonly HashChainBorrowGrant[];
} {
  if (!Number.isSafeInteger(count) || count < 1 || count > 1024) {
    throw new Error("grant count must be an integer from 1 to 1024");
  }
  const seed = Buffer.from(schnorr.utils.randomSecretKey()).toString("hex");
  const privateKeys = Array.from({ length: count }, () => schnorr.utils.randomSecretKey());
  const publicKeys = privateKeys.map((key) => Buffer.from(schnorr.getPublicKey(key)).toString("hex"));
  const prepared = prepareHashChainBorrowGuards(seed, publicKeys);
  return {
    initialGuard: prepared.initialGuard,
    grants: prepared.releases.map((release, reverseIndex) => ({
      ...release,
      oneTimePrivateKey: Buffer.from(privateKeys[count - 1 - reverseIndex]!).toString("hex"),
    })),
  };
}

/** Patches only compiler-proven constructor and state slots in the pinned ABI. */
export function buildHashChainHeadRedeemScript(params: HashChainHeadParams): string {
  const owner = fixedBytes(params.ownerPublicKey, "ownerPublicKey");
  schnorr.utils.lift_x(BigInt(`0x${Buffer.from(owner).toString("hex")}`));
  const guard = fixedBytes(params.guard, "guard");
  const script = Buffer.from(HASH_CHAIN_HEAD_V1_COMPILED_BASE, "hex");
  const sampleOwner = Buffer.from(HASH_CHAIN_HEAD_V1_SAMPLE_OWNER, "hex");
  const sampleGuard = Buffer.from(HASH_CHAIN_HEAD_V1_SAMPLE_GUARD, "hex");
  for (const offset of HASH_CHAIN_HEAD_V1_LAYOUT.ownerOffsets) {
    if (!script.subarray(offset, offset + 32).equals(sampleOwner)) {
      throw new Error("pinned owner constructor slot changed");
    }
    script.set(owner, offset);
  }
  const offset = HASH_CHAIN_HEAD_V1_LAYOUT.guardOffset;
  if (!script.subarray(offset, offset + 32).equals(sampleGuard)) {
    throw new Error("pinned guard state slot changed");
  }
  script.set(guard, offset);
  return script.toString("hex");
}

export function hashChainHeadScriptPublicKey(params: HashChainHeadParams): string {
  return serializedScriptPublicKey(payToScriptHashScript(buildHashChainHeadRedeemScript(params)));
}

/** SilverScript's state-excluded template hash for an instantiated owner. */
export function hashChainHeadTemplateHash(ownerPublicKey: string): string {
  const script = Buffer.from(buildHashChainHeadRedeemScript({ ownerPublicKey, guard: HASH_CHAIN_HEAD_V1_SAMPLE_GUARD }), "hex");
  const { offset, len } = HASH_CHAIN_HEAD_V1_LAYOUT.stateSpan;
  const prefix = script.subarray(0, offset);
  const suffix = script.subarray(offset + len);
  const prefixLength = Buffer.alloc(8);
  const suffixLength = Buffer.alloc(8);
  prefixLength.writeBigInt64LE(BigInt(prefix.length));
  suffixLength.writeBigInt64LE(BigInt(suffix.length));
  return Buffer.from(blake3(Buffer.concat([prefixLength, prefix, suffixLength, suffix]))).toString("hex");
}

function fixedBytes(value: string, label: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${label} must be 32-byte hex`);
  return Uint8Array.from(Buffer.from(value, "hex"));
}
