import { blake2b } from "blakejs";

import { bytesToHex, hexToBytes } from "./template.js";
import type { FundingOutpoint } from "./template.js";

const NATIVE_SUBNETWORK_ID = "00".repeat(20);
const SIG_HASH_ALL = 0x01;
const ZERO_HASH = "00".repeat(32);
const U16_MAX = 0xffff;

export interface ExactV0ReferenceInput {
  previousOutpoint: FundingOutpoint;
  signatureScript: string;
  sequence: string;
  sigOpCount: number;
  utxo: {
    amount: string;
    scriptPublicKey: string;
  };
}

export interface ExactV0ReferenceOutput {
  amount: string;
  scriptPublicKey: string;
  covenant?: null;
}

export interface ExactV0ReferenceTransaction {
  version: 0;
  inputs: readonly ExactV0ReferenceInput[];
  outputs: readonly ExactV0ReferenceOutput[];
  lockTime: string;
  subnetworkId: string;
  gas: string;
  payload: string;
  storageMass?: string;
}

export interface ExactV0SignatureEvidence {
  publicKey: string;
  signature: string;
  hashType: 1;
  digest: string;
}

/** Recomputes Rusty Kaspa's version-0 transaction ID. */
export function exactV0TransactionId(transaction: ExactV0ReferenceTransaction): string {
  assertExactV0Context(transaction);
  const writer = new ByteWriter().u16(0).len(transaction.inputs.length);
  for (const input of transaction.inputs) {
    writeOutpoint(writer, input.previousOutpoint);
    writer.varBytes("").u64(input.sequence);
  }
  writer.len(transaction.outputs.length);
  for (const output of transaction.outputs) writeOutput(writer, output);
  writer
    .u64(transaction.lockTime)
    .bytes(transaction.subnetworkId)
    .u64(transaction.gas)
    .varBytes(transaction.payload);
  return blake2bKeyed("TransactionID", writer.finish());
}

/** Recomputes Rusty Kaspa's Schnorr SIGHASH_ALL digest for one version-0 P2PK input. */
export function exactV0SchnorrSignatureEvidence(
  transaction: ExactV0ReferenceTransaction,
  inputIndex: number,
): ExactV0SignatureEvidence {
  assertExactV0Context(transaction);
  const input = transaction.inputs[inputIndex];
  if (!input) throw new Error("exact input index is out of range");
  const signatureScript = hexToBytes(input.signatureScript, undefined, "signatureScript");
  if (signatureScript.byteLength !== 66 || signatureScript[0] !== 65 || signatureScript[65] !== SIG_HASH_ALL) {
    throw new Error("standard-native input must use a canonical 65-byte Schnorr SIGHASH_ALL push");
  }
  const publicKey = p2pkPublicKey(input.utxo.scriptPublicKey);
  const writer = new ByteWriter()
    .u16(0)
    .bytes(hashPreviousOutputs(transaction))
    .bytes(hashSequences(transaction))
    .bytes(hashSigOpCounts(transaction));
  writeOutpoint(writer, input.previousOutpoint);
  writeScriptPublicKey(writer, input.utxo.scriptPublicKey);
  writer
    .u64(input.utxo.amount)
    .u64(input.sequence)
    .u8(input.sigOpCount)
    .bytes(hashOutputs(transaction))
    .u64(transaction.lockTime)
    .bytes(transaction.subnetworkId)
    .u64(transaction.gas)
    .bytes(transaction.subnetworkId === NATIVE_SUBNETWORK_ID && transaction.payload === "" ? ZERO_HASH : hashPayload(transaction))
    .u8(SIG_HASH_ALL);
  return {
    publicKey,
    signature: bytesToHex(signatureScript.slice(1, 65)),
    hashType: SIG_HASH_ALL,
    digest: blake2bKeyed("TransactionSigningHash", writer.finish()),
  };
}

function assertExactV0Context(transaction: ExactV0ReferenceTransaction): void {
  if (transaction.version !== 0) throw new Error("standard-native transaction version must be 0");
  if (transaction.subnetworkId.toLowerCase() !== NATIVE_SUBNETWORK_ID) throw new Error("standard-native transaction must use native subnetwork");
  if (transaction.lockTime !== "0" || transaction.gas !== "0" || transaction.payload !== "") {
    throw new Error("standard-native transaction context fields must be zero and empty");
  }
}

function p2pkPublicKey(serializedScriptPublicKey: string): string {
  const { version, script } = parseScriptPublicKey(serializedScriptPublicKey);
  if (version !== 0 || script.byteLength !== 34 || script[0] !== 32 || script[33] !== 0xac) {
    throw new Error("standard-native funding input must be a version-0 Schnorr P2PK script");
  }
  return bytesToHex(script.slice(1, 33));
}

function hashPreviousOutputs(transaction: ExactV0ReferenceTransaction): string {
  const writer = new ByteWriter();
  for (const input of transaction.inputs) writeOutpoint(writer, input.previousOutpoint);
  return blake2bKeyed("TransactionSigningHash", writer.finish());
}

function hashSequences(transaction: ExactV0ReferenceTransaction): string {
  const writer = new ByteWriter();
  for (const input of transaction.inputs) writer.u64(input.sequence);
  return blake2bKeyed("TransactionSigningHash", writer.finish());
}

function hashSigOpCounts(transaction: ExactV0ReferenceTransaction): string {
  const writer = new ByteWriter();
  for (const input of transaction.inputs) writer.u8(input.sigOpCount);
  return blake2bKeyed("TransactionSigningHash", writer.finish());
}

function hashOutputs(transaction: ExactV0ReferenceTransaction): string {
  const writer = new ByteWriter();
  for (const output of transaction.outputs) writeOutput(writer, output);
  return blake2bKeyed("TransactionSigningHash", writer.finish());
}

function hashPayload(transaction: ExactV0ReferenceTransaction): string {
  return blake2bKeyed("TransactionSigningHash", new ByteWriter().varBytes(transaction.payload).finish());
}

function writeOutpoint(writer: ByteWriter, outpoint: FundingOutpoint): void {
  writer.bytes(outpoint.txid).u32(outpoint.index);
}

function writeOutput(writer: ByteWriter, output: ExactV0ReferenceOutput): void {
  if (output.covenant !== undefined && output.covenant !== null) throw new Error("standard-native outputs cannot carry covenants");
  writer.u64(output.amount);
  writeScriptPublicKey(writer, output.scriptPublicKey);
}

function writeScriptPublicKey(writer: ByteWriter, serialized: string): void {
  const { version, script } = parseScriptPublicKey(serialized);
  writer.u16(version).varBytes(bytesToHex(script));
}

function parseScriptPublicKey(serialized: string): { version: number; script: Uint8Array } {
  const bytes = hexToBytes(serialized, undefined, "scriptPublicKey");
  if (bytes.byteLength < 2) throw new Error("serialized script public key is too short");
  const version = (bytes[0] << 8) | bytes[1];
  return { version, script: bytes.slice(2) };
}

function blake2bKeyed(domain: string, input: Uint8Array): string {
  return bytesToHex(Uint8Array.from(blake2b(input, Buffer.from(domain, "utf8"), 32)));
}

function u16Le(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > U16_MAX) throw new Error("value must fit uint16");
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff);
}

function u32Le(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new Error("value must fit uint32");
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function u64Le(value: string | bigint): Uint8Array {
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > 0xffff_ffff_ffff_ffffn) throw new Error("value must fit uint64");
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(parsed);
  return Uint8Array.from(buffer);
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

class ByteWriter {
  readonly #parts: Uint8Array[] = [];

  bytes(hexOrBytes: string | Uint8Array): this {
    this.#parts.push(typeof hexOrBytes === "string" ? hexToBytes(hexOrBytes, undefined, "bytes") : hexOrBytes);
    return this;
  }

  varBytes(hex: string): this {
    const bytes = hexToBytes(hex, undefined, "varBytes");
    this.u64(BigInt(bytes.byteLength));
    this.#parts.push(bytes);
    return this;
  }

  len(value: number): this {
    return this.u64(BigInt(value));
  }

  u8(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) throw new Error("value must fit uint8");
    this.#parts.push(Uint8Array.of(value));
    return this;
  }

  u16(value: number): this {
    this.#parts.push(u16Le(value));
    return this;
  }

  u32(value: number): this {
    this.#parts.push(u32Le(value));
    return this;
  }

  u64(value: string | bigint): this {
    this.#parts.push(u64Le(value));
    return this;
  }

  finish(): Uint8Array {
    return concatBytes(this.#parts);
  }
}
