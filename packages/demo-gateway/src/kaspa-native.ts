import { bytesToHex, hexToBytes, KaspaX402Error, type NetworkId } from "@kaspa-x402/core";
import { schnorr } from "@noble/curves/secp256k1.js";
import { blake2b } from "@noble/hashes/blake2.js";
import type { DeriveEscrowAddressInput } from "@kaspa-x402/covenant";

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const CHECKSUM_LENGTH = 8;
const PREFIX_BY_NETWORK: Record<NetworkId, string> = {
  "kaspa:mainnet": "kaspa",
  "kaspa:testnet-10": "kaspatest",
};

const ADDRESS_VERSION_PUB_KEY = 0;
const ADDRESS_VERSION_PUB_KEY_ECDSA = 1;
const ADDRESS_VERSION_SCRIPT_HASH = 8;
const SCRIPT_PUBLIC_KEY_VERSION = 0;

const OP_DATA_32 = 0x20;
const OP_DATA_33 = 0x21;
const OP_EQUAL = 0x87;
const OP_BLAKE2B = 0xaa;
const OP_CHECK_SIG_ECDSA = 0xab;
const OP_CHECK_SIG = 0xac;

const PERSONAL_MESSAGE_KEY = new TextEncoder().encode("PersonalMessageSigningHash");

export function scriptPublicKeyForAddress(address: string, network: NetworkId): string {
  const decoded = decodeAddress(address);
  const expectedPrefix = prefixForNetwork(network);
  if (decoded.prefix !== expectedPrefix) {
    throw new KaspaX402Error("invalid_kaspa_x402_network", `address prefix must be ${expectedPrefix}`);
  }

  switch (decoded.version) {
    case ADDRESS_VERSION_PUB_KEY:
      if (decoded.payload.byteLength !== 32) throw invalidAddress("pubkey payload must be 32 bytes");
      return serializeScriptPublicKey(Uint8Array.of(OP_DATA_32, ...decoded.payload, OP_CHECK_SIG));
    case ADDRESS_VERSION_PUB_KEY_ECDSA:
      if (decoded.payload.byteLength !== 33) throw invalidAddress("ECDSA pubkey payload must be 33 bytes");
      return serializeScriptPublicKey(Uint8Array.of(OP_DATA_33, ...decoded.payload, OP_CHECK_SIG_ECDSA));
    case ADDRESS_VERSION_SCRIPT_HASH:
      if (decoded.payload.byteLength !== 32) throw invalidAddress("script-hash payload must be 32 bytes");
      return serializeScriptPublicKey(Uint8Array.of(OP_BLAKE2B, OP_DATA_32, ...decoded.payload, OP_EQUAL));
    default:
      throw invalidAddress("unsupported address version");
  }
}

export function encodeScriptAddress(input: DeriveEscrowAddressInput): string {
  const { version, script } = parseSerializedScriptPublicKey(input.serializedScriptPublicKey);
  if (version !== input.scriptPublicKey.version || bytesToHex(script) !== input.scriptPublicKey.script.toLowerCase()) {
    throw new KaspaX402Error("invalid_kaspa_x402_binding", "serialized script public key does not match script public key");
  }
  if (version !== SCRIPT_PUBLIC_KEY_VERSION) {
    throw new KaspaX402Error("invalid_kaspa_x402_binding", "script public key version must be 0");
  }
  const payload = standardScriptAddressPayload(script);
  return encodeAddress(prefixForNetwork(input.network), ADDRESS_VERSION_SCRIPT_HASH, payload);
}

export function verifyKaspaPersonalMessage(input: { message: string; signature: string; publicKey: string }): boolean {
  try {
    const signature = hexToBytes(input.signature, { expectedLength: 64, errorCode: "invalid_kaspa_signature", label: "voucher.signature" });
    const publicKey = hexToBytes(input.publicKey, { expectedLength: 32, errorCode: "invalid_kaspa_public_key", label: "clientPublicKey" });
    return schnorr.verify(signature, personalMessageHash(input.message), publicKey);
  } catch {
    return false;
  }
}

export function personalMessageHash(message: string): Uint8Array {
  return blake2b(new TextEncoder().encode(message), { dkLen: 32, key: PERSONAL_MESSAGE_KEY });
}

function decodeAddress(address: string): { prefix: string; version: number; payload: Uint8Array } {
  const separator = address.indexOf(":");
  if (separator <= 0 || separator === address.length - 1) throw invalidAddress("address must contain prefix and payload");
  if (address !== address.toLowerCase()) throw invalidAddress("address must use lowercase encoding");

  const prefix = address.slice(0, separator);
  const payloadText = address.slice(separator + 1);
  if (!Object.values(PREFIX_BY_NETWORK).includes(prefix)) throw invalidAddress("unsupported address prefix");
  if (payloadText.length <= CHECKSUM_LENGTH) throw invalidAddress("address payload is too short");

  const encoded = Array.from(payloadText, (char) => {
    const value = CHARSET.indexOf(char);
    if (value < 0) throw invalidAddress("address contains an invalid character");
    return value;
  });
  const payload = encoded.slice(0, -CHECKSUM_LENGTH);
  const checksum = encoded.slice(-CHECKSUM_LENGTH);
  if (computeChecksum(prefix, payload) !== fiveBitToU64(checksum)) throw invalidAddress("address checksum is invalid");

  const decoded = conv5to8(payload);
  if (decoded.byteLength < 1) throw invalidAddress("address payload is empty");
  const version = decoded[0];
  return { prefix, version, payload: decoded.slice(1) };
}

function encodeAddress(prefix: string, version: number, payload: Uint8Array): string {
  const payload5 = conv8to5(Uint8Array.of(version, ...payload));
  const checksum5 = conv8to5(u64Bytes(computeChecksum(prefix, payload5)).slice(3));
  return `${prefix}:${[...payload5, ...checksum5].map((value) => CHARSET[value]).join("")}`;
}

function standardScriptAddressPayload(script: Uint8Array): Uint8Array {
  if (script.byteLength === 34 && script[0] === OP_DATA_32 && script[33] === OP_CHECK_SIG) return script.slice(1, 33);
  if (script.byteLength === 35 && script[0] === OP_DATA_33 && script[34] === OP_CHECK_SIG_ECDSA) return script.slice(1, 34);
  if (script.byteLength === 35 && script[0] === OP_BLAKE2B && script[1] === OP_DATA_32 && script[34] === OP_EQUAL) return script.slice(2, 34);
  throw new KaspaX402Error("invalid_kaspa_x402_binding", "script public key is not a standard address script");
}

function parseSerializedScriptPublicKey(serialized: string): { version: number; script: Uint8Array } {
  const bytes = hexToBytes(serialized, { errorCode: "invalid_kaspa_x402_binding", label: "serializedScriptPublicKey" });
  if (bytes.byteLength < 2) throw new KaspaX402Error("invalid_kaspa_x402_binding", "serialized script public key is too short");
  return {
    version: bytes[0] | (bytes[1] << 8),
    script: bytes.slice(2),
  };
}

function serializeScriptPublicKey(script: Uint8Array): string {
  return bytesToHex(Uint8Array.of(SCRIPT_PUBLIC_KEY_VERSION & 0xff, (SCRIPT_PUBLIC_KEY_VERSION >>> 8) & 0xff, ...script));
}

function prefixForNetwork(network: NetworkId): string {
  const prefix = PREFIX_BY_NETWORK[network];
  if (!prefix) throw new KaspaX402Error("invalid_kaspa_x402_network", "unsupported Kaspa network");
  return prefix;
}

function computeChecksum(prefix: string, payload: readonly number[]): bigint {
  const prefix5 = Array.from(prefix, (char) => char.charCodeAt(0) & 0x1f);
  return polymod([...prefix5, 0, ...payload, 0, 0, 0, 0, 0, 0, 0, 0]);
}

function polymod(values: readonly number[]): bigint {
  let c = 1n;
  for (const d of values) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    if ((c0 & 0x01n) !== 0n) c ^= 0x98f2bc8e61n;
    if ((c0 & 0x02n) !== 0n) c ^= 0x79b76d99e2n;
    if ((c0 & 0x04n) !== 0n) c ^= 0xf33e5fb3c4n;
    if ((c0 & 0x08n) !== 0n) c ^= 0xae2eabe2a8n;
    if ((c0 & 0x10n) !== 0n) c ^= 0x1e4f43e470n;
  }
  return c ^ 1n;
}

function conv8to5(payload: Uint8Array): number[] {
  const outputLength = Math.floor((payload.byteLength * 8) / 5) + (payload.byteLength % 5 === 0 ? 0 : 1);
  const output = new Array<number>(outputLength);
  let outputIndex = 0;
  let buffer = 0;
  let bits = 0;

  for (const byte of payload) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output[outputIndex++] = (buffer >> bits) & 31;
      buffer &= (1 << bits) - 1;
    }
  }
  if (bits > 0) output[outputIndex] = (buffer << (5 - bits)) & 31;
  return output;
}

function conv5to8(payload: readonly number[]): Uint8Array {
  const output = new Uint8Array(Math.floor((payload.length * 5) / 8));
  let outputIndex = 0;
  let buffer = 0;
  let bits = 0;

  for (const value of payload) {
    if (value < 0 || value > 31) throw invalidAddress("five-bit payload value is outside range");
    buffer = (buffer << 5) | value;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      output[outputIndex++] = (buffer >> bits) & 255;
      buffer &= (1 << bits) - 1;
    }
  }
  return output;
}

function fiveBitToU64(values: readonly number[]): bigint {
  return bigintFromBytes(conv5to8(values));
}

function u64Bytes(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  for (let offset = 7, remaining = value; offset >= 0; offset -= 1, remaining >>= 8n) {
    bytes[offset] = Number(remaining & 0xffn);
  }
  return bytes;
}

function bigintFromBytes(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function invalidAddress(message: string): KaspaX402Error {
  return new KaspaX402Error("invalid_kaspa_x402_payload", message);
}
