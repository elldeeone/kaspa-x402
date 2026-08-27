import crypto from "node:crypto";
import { blake2b } from "blakejs";

export type NetworkId = "kaspa:mainnet" | "kaspa:testnet-10";

export interface FundingOutpoint {
  txid: string;
  index: number;
}

export interface EscrowTemplateParams {
  clientPublicKey: string;
  serverPublicKey: string;
  network: NetworkId;
  payoutScriptPublicKeyHash: string;
  refundScriptPublicKeyHash: string;
  timeoutDaa: bigint | number | string;
  settledTotal: bigint | number | string;
}

export interface ScriptPublicKey {
  version: number;
  script: string;
}

export interface DeriveEscrowAddressInput {
  network: NetworkId;
  scriptPublicKey: ScriptPublicKey;
  serializedScriptPublicKey: string;
}

export type KaspaAddressEncoder = (input: DeriveEscrowAddressInput) => string;

export interface ClaimArgsInput {
  serverSignature: string | Uint8Array;
  voucherSignature: string | Uint8Array;
  totalAuthorized: bigint | number | string;
  claimAmount: bigint | number | string;
}

export interface TopUpArgsInput {
  clientSignature: string | Uint8Array;
}

export interface RefundArgsInput {
  clientSignature: string | Uint8Array;
}

export interface VoucherPreimageInput {
  network: NetworkId;
  covenantId: string;
  totalAuthorized: bigint | number | string;
}

export interface Kip10AdditiveTemplateParams {
  ownerPublicKey: string;
  amount: bigint | number | string;
}

export interface ParsedKip10AdditiveRedeemScript {
  ownerPublicKey: string;
  amount: string;
}

export const ESCROW_TEMPLATE_ID = "kaspa-x402-escrow-v3";
export const ESCROW_VOUCHER_DOMAIN = "kaspa:x402:escrow-voucher:v2";
export const ESCROW_VOUCHER_DOMAIN_TAG = "dd08a0f48c41d89eda672cef33c3d43a4c2bd11083efbcd62dbbae0e018ec30b";
export const SCRIPT_INT64_MAX = 0x7fff_ffff_ffff_ffffn;
export const KIP10_ADDITIVE_TEMPLATE_ID = "kaspa-x402-kip10-additive-v1";
export const KIP10_EXACT_TRANSACTION_ENCODING = "kaspa-sdk-safe-json-v2.0.0";
export const KASPA_LOCK_TIME_THRESHOLD = 500_000_000_000n;
export const SCRIPT_UNITS_PER_COMPUTE_BUDGET = 10_000;
export const FREE_SCRIPT_UNITS_PER_INPUT = 9_999;

const U64_MAX = 0xffff_ffff_ffff_ffffn;
const HEX_BYTE_PATTERN = /^(?:[0-9a-fA-F]{2})*$/;
const U64_DECIMAL_PATTERN =
  /^(?:0|[1-9][0-9]{0,18}|1[0-7][0-9]{18}|18[0-3][0-9]{17}|184[0-3][0-9]{16}|1844[0-5][0-9]{15}|18446[0-6][0-9]{14}|184467[0-3][0-9]{13}|1844674[0-3][0-9]{12}|184467440[0-6][0-9]{10}|1844674407[0-2][0-9]{9}|18446744073[0-6][0-9]{8}|1844674407370[0-8][0-9]{6}|18446744073709[0-4][0-9]{5}|184467440737095[0-4][0-9]{4}|18446744073709550[0-9]{3}|18446744073709551[0-5][0-9]{2}|1844674407370955160[0-9]{1}|1844674407370955161[0-4]|18446744073709551615)$/;

// silverc 28a16f0ee194dcb288a5aaf371abd0f4b77f462e slot map for
// contracts/kaspa-x402-escrow-v3.sil. State is the fixed-width little-endian
// int64 between V3_SEG_0 and V3_SEG_1. Every constructor slot is fixed-width,
// including timeout, so silverc's generated state-transition offsets remain
// valid for every supported parameter value.
const V3_SEG_0 = "6b08";
const V3_SEG_1 =
  "6c760423959b4287637554798201419d7553798201409d75527982589d757882589d75b9cbb9cf76d27653799c695379765979597959795979b2519c69b5009c69b3519c69b4529c69b9009c69b9bd08000000000000000087695379014001417f010187695379";
const V3_SEG_2 =
  "ac69b9cf76d0519c6976d2519c69b9cb519c69b900cc519c6900d5200000000000000000000000000000000000000000000000000000000000000000876951d578876920dd08a0f48c41d89eda672cef33c3d43a4c2bd11083efbcd62dbbae0e018ec30b";
const V3_SEG_3 = "7e787e53797e547978a8";
const V3_SEG_4 = "d76953795379587900a269785979a0697600a069785979947878a169b9be5279789f6900c200a06900c25379a16900c3a8";
const V3_SEG_5 =
  "876951c2785479949c695a795379935f79519c69b900cc0108527958cd7eb976c902080494765193bc7c7eb976c97602fe83937cbc7eaa02000001aa7e01207e7c7e01877e78c3887575757575757575757575757575757575757575757551677604525888a6876375788201419d75b9cbb9cf76d27653799c695379765679b2519c69b5009c69b351a069b400a069b452a169b9009c69b9bd080000000000000000876976014001417f0101876976";
const V3_SEG_6 =
  "ac69b9cf76d0519c6976d2519c69b9cb519c69b900cc009c6900d5788769527900a26900c2b9bea069b4529c6351d5200000000000000000000000000000000000000000000000000000000000000000876951c200a06951c3a8";
const V3_SEG_7 =
  "87696852795779519c69b900cc0108527958cd7eb976c902080494765193bc7c7eb976c97602fe83937cbc7eaa02000001aa7e01207e7c7e01877e78c38875757575757575757575755167760417a2027b876375788201419d75b2519c69b3519c69b4519c69b9009c69b9bd0800000000000000008769";
const V3_SEG_8 = "7600050088526a74a569b078014001417f0101876978";
const V3_SEG_9 =
  "ac69b9cf76d0519c6976d2009c69b9cb009c6900d5200000000000000000000000000000000000000000000000000000000000000000876900c200a06900c2b9bea16900c3a8";
const V3_SEG_10 = "876975757551676a686868";

export function buildEscrowRedeemScript(params: EscrowTemplateParams): string {
  const client = hexToBytes(params.clientPublicKey, 32, "clientPublicKey");
  const server = hexToBytes(params.serverPublicKey, 32, "serverPublicKey");
  const payoutScriptPublicKeyHash = hexToBytes(params.payoutScriptPublicKeyHash, 32, "payoutScriptPublicKeyHash");
  const refundScriptPublicKeyHash = hexToBytes(params.refundScriptPublicKeyHash, 32, "refundScriptPublicKeyHash");
  const timeout = normalizeScriptInt64(params.timeoutDaa, "timeoutDaa");
  const settledTotal = normalizeScriptInt64(params.settledTotal, "settledTotal");
  if (timeout >= KASPA_LOCK_TIME_THRESHOLD) {
    throw new Error("timeoutDaa must remain below the consensus timestamp boundary");
  }
  const network = networkHash(params.network);

  return bytesToHex(
    concatBytes([
      hexToBytes(V3_SEG_0, undefined, "V3_SEG_0"),
      int64Le(settledTotal),
      hexToBytes(V3_SEG_1, undefined, "V3_SEG_1"),
      pushData(server),
      hexToBytes(V3_SEG_2, undefined, "V3_SEG_2"),
      pushData(network),
      hexToBytes(V3_SEG_3, undefined, "V3_SEG_3"),
      pushData(client),
      hexToBytes(V3_SEG_4, undefined, "V3_SEG_4"),
      pushData(payoutScriptPublicKeyHash),
      hexToBytes(V3_SEG_5, undefined, "V3_SEG_5"),
      pushData(client),
      hexToBytes(V3_SEG_6, undefined, "V3_SEG_6"),
      pushData(refundScriptPublicKeyHash),
      hexToBytes(V3_SEG_7, undefined, "V3_SEG_7"),
      pushData(int64Le(timeout)),
      hexToBytes(V3_SEG_8, undefined, "V3_SEG_8"),
      pushData(client),
      hexToBytes(V3_SEG_9, undefined, "V3_SEG_9"),
      pushData(refundScriptPublicKeyHash),
      hexToBytes(V3_SEG_10, undefined, "V3_SEG_10"),
    ]),
  );
}

export function buildKip10AdditiveRedeemScript(params: Kip10AdditiveTemplateParams): string {
  const owner = hexToBytes(params.ownerPublicKey, 32, "ownerPublicKey");
  const amount = normalizeScriptInt64(params.amount, "amount");
  return bytesToHex(
    concatBytes([
      Uint8Array.of(0x63),
      pushData(owner),
      Uint8Array.of(0xac, 0x67, 0xb9, 0xbf, 0xb9, 0xc3, 0x88, 0xb9, 0xc2),
      pushScriptNumber(amount),
      Uint8Array.of(0x94, 0xb9, 0xbe, 0xa2, 0x68),
    ]),
  );
}

/**
 * Parses the canonical additive-threshold KIP-10 template used by exact
 * payments. The parser deliberately accepts only the byte-for-byte canonical
 * script form produced by {@link buildKip10AdditiveRedeemScript}; semantically
 * similar scripts are not interchangeable reservation terms.
 */
export function parseKip10AdditiveRedeemScript(redeemScript: string): ParsedKip10AdditiveRedeemScript {
  const bytes = hexToBytes(redeemScript, undefined, "redeemScript");
  const fixedPrefix = Uint8Array.of(0x63, 0x20);
  const opcodes = Uint8Array.of(0xac, 0x67, 0xb9, 0xbf, 0xb9, 0xc3, 0x88, 0xb9, 0xc2);
  const suffix = Uint8Array.of(0x94, 0xb9, 0xbe, 0xa2, 0x68);
  const minimumLength = fixedPrefix.length + 32 + opcodes.length + 1 + suffix.length;
  if (bytes.length < minimumLength || bytes[0] !== fixedPrefix[0] || bytes[1] !== fixedPrefix[1]) {
    throw new Error("redeemScript is not the canonical KIP-10 additive template");
  }

  const owner = bytes.slice(2, 34);
  if (!bytesEqual(bytes.slice(34, 43), opcodes)) {
    throw new Error("redeemScript is not the canonical KIP-10 additive template");
  }
  const { value: amount, nextOffset } = readNonNegativeScriptNumber(bytes, 43);
  if (!bytesEqual(bytes.slice(nextOffset), suffix)) {
    throw new Error("redeemScript is not the canonical KIP-10 additive template");
  }

  const parsed = { ownerPublicKey: bytesToHex(owner), amount: amount.toString() };
  if (buildKip10AdditiveRedeemScript(parsed) !== bytesToHex(bytes)) {
    throw new Error("redeemScript must use canonical KIP-10 script-number encoding");
  }
  return parsed;
}

export function kip10AdditiveScriptPublicKey(params: Kip10AdditiveTemplateParams): ScriptPublicKey {
  return payToScriptHashScript(buildKip10AdditiveRedeemScript(params));
}

export function buildKip10AdditiveBorrowArgs(): string {
  return "00";
}

export function buildKip10AdditiveBorrowSignatureScript(redeemScript: string): string {
  const canonical = parseKip10AdditiveRedeemScript(redeemScript);
  const script = hexToBytes(buildKip10AdditiveRedeemScript(canonical), undefined, "redeemScript");
  return bytesToHex(concatBytes([Uint8Array.of(0x00), pushData(script)]));
}

export function escrowScriptPublicKey(params: EscrowTemplateParams): ScriptPublicKey {
  return payToScriptHashScript(buildEscrowRedeemScript(params));
}

export function serializedScriptPublicKey(scriptPublicKey: ScriptPublicKey): string {
  const version = scriptPublicKey.version;
  if (!Number.isInteger(version) || version < 0 || version > 0xffff) {
    throw new Error("script public key version must fit in uint16");
  }

  return bytesToHex(concatBytes([Uint8Array.of((version >>> 8) & 0xff, version & 0xff), hexToBytes(scriptPublicKey.script, undefined, "script")]));
}

export function escrowScriptPubKeyHash(paramsOrScriptPublicKey: EscrowTemplateParams | ScriptPublicKey): string {
  const spk = "script" in paramsOrScriptPublicKey ? paramsOrScriptPublicKey : escrowScriptPublicKey(paramsOrScriptPublicKey);
  return bytesToHex(sha256(hexToBytes(serializedScriptPublicKey(spk), undefined, "serializedScriptPublicKey")));
}

export function deriveEscrowAddress(params: EscrowTemplateParams, encodeAddress: KaspaAddressEncoder): string {
  const scriptPublicKey = escrowScriptPublicKey(params);
  const address = encodeAddress({
    network: params.network,
    scriptPublicKey,
    serializedScriptPublicKey: serializedScriptPublicKey(scriptPublicKey),
  });
  if (typeof address !== "string" || address.length === 0) {
    throw new Error("address encoder must return a non-empty address string");
  }
  return address;
}

export function buildClaimArgs(input: ClaimArgsInput): string {
  const serverSignature = bytesFromHexOrBytes(input.serverSignature, 65, "serverSignature");
  const voucherSignature = bytesFromHexOrBytes(input.voucherSignature, 64, "voucherSignature");
  const totalAuthorizedValue = normalizeScriptInt64(input.totalAuthorized, "totalAuthorized");
  const claimAmountValue = normalizeScriptInt64(input.claimAmount, "claimAmount");
  if (totalAuthorizedValue === 0n) throw new Error("totalAuthorized must be positive");
  if (claimAmountValue === 0n) throw new Error("claimAmount must be positive");
  const totalAuthorized = int64Le(totalAuthorizedValue);
  const claimAmount = int64Le(claimAmountValue);
  return bytesToHex(
    concatBytes([
      pushData(serverSignature),
      pushData(voucherSignature),
      pushData(totalAuthorized),
      pushData(claimAmount),
      pushData(Uint8Array.of(0x23, 0x95, 0x9b, 0x42)),
    ]),
  );
}

export function buildTopUpArgs(input: TopUpArgsInput): string {
  const clientSignature = bytesFromHexOrBytes(input.clientSignature, 65, "clientSignature");
  return bytesToHex(concatBytes([pushData(clientSignature), pushData(Uint8Array.of(0x52, 0x58, 0x88, 0xa6))]));
}

export function buildRefundArgs(input: RefundArgsInput): string {
  const clientSignature = bytesFromHexOrBytes(input.clientSignature, 65, "clientSignature");
  return bytesToHex(concatBytes([pushData(clientSignature), pushData(Uint8Array.of(0x17, 0xa2, 0x02, 0x7b))]));
}

export function voucherPreimage(input: VoucherPreimageInput): string {
  const totalAuthorized = normalizeScriptInt64(input.totalAuthorized, "totalAuthorized");
  if (totalAuthorized === 0n) throw new Error("totalAuthorized must be positive");
  const covenantId = hexToBytes(input.covenantId, 32, "covenantId");
  if (covenantId.every((byte) => byte === 0)) throw new Error("covenantId must identify a bound KIP-20 lineage");
  return bytesToHex(
    concatBytes([
      hexToBytes(ESCROW_VOUCHER_DOMAIN_TAG, 32, "domainTag"),
      networkHash(input.network),
      covenantId,
      int64Le(totalAuthorized),
    ]),
  );
}

export function voucherDigest(input: VoucherPreimageInput): string {
  return bytesToHex(sha256(hexToBytes(voucherPreimage(input), undefined, "voucherPreimage")));
}

export function computeBudgetForScriptUnits(scriptUnits: number): number {
  if (!Number.isSafeInteger(scriptUnits) || scriptUnits < 0) {
    throw new Error("script units must be a non-negative safe integer");
  }
  if (scriptUnits <= FREE_SCRIPT_UNITS_PER_INPUT) {
    return 0;
  }
  const budget = Math.ceil((scriptUnits - FREE_SCRIPT_UNITS_PER_INPUT) / SCRIPT_UNITS_PER_COMPUTE_BUDGET);
  if (budget > 0xffff) {
    throw new Error("script units exceed the transaction-v1 compute budget range");
  }
  return budget;
}

export function scriptUnitAllowance(computeBudget: number): number {
  if (!Number.isInteger(computeBudget) || computeBudget < 0 || computeBudget > 0xffff) {
    throw new Error("compute budget must fit in uint16");
  }
  return computeBudget * SCRIPT_UNITS_PER_COMPUTE_BUDGET + FREE_SCRIPT_UNITS_PER_INPUT;
}

export function payToScriptHashScript(redeemScript: string | Uint8Array): ScriptPublicKey {
  const redeem = typeof redeemScript === "string" ? hexToBytes(redeemScript, undefined, "redeemScript") : redeemScript;
  const scriptHash = blake2b(redeem, undefined, 32);
  return {
    version: 0,
    script: bytesToHex(concatBytes([Uint8Array.of(0xaa, 0x20), scriptHash, Uint8Array.of(0x87)])),
  };
}

export function networkHash(network: NetworkId): Uint8Array {
  if (network !== "kaspa:mainnet" && network !== "kaspa:testnet-10") {
    throw new Error("network must be kaspa:mainnet or kaspa:testnet-10");
  }
  return sha256(utf8Bytes(network));
}

export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function hexToBytes(hex: string, expectedLength?: number, label = "hex"): Uint8Array {
  if (!HEX_BYTE_PATTERN.test(hex)) {
    throw new Error(`${label} must be an even-length hex byte string`);
  }
  if (expectedLength !== undefined && hex.length !== expectedLength * 2) {
    throw new Error(`${label} must be ${expectedLength} bytes`);
  }
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function bytesFromHexOrBytes(value: string | Uint8Array, expectedLength: number, label: string): Uint8Array {
  const bytes = typeof value === "string" ? hexToBytes(value, expectedLength, label) : value;
  if (bytes.byteLength !== expectedLength) {
    throw new Error(`${label} must be ${expectedLength} bytes`);
  }
  return bytes;
}

function utf8Bytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "utf8"));
}

function sha256(value: Uint8Array): Uint8Array {
  return Uint8Array.from(crypto.createHash("sha256").update(value).digest());
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

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((byte, index) => byte === right[index]);
}

function readNonNegativeScriptNumber(bytes: Uint8Array, offset: number): { value: bigint; nextOffset: number } {
  const opcode = bytes[offset];
  if (opcode === undefined) throw new Error("redeemScript is missing the additive threshold");
  if (opcode === 0x00) return { value: 0n, nextOffset: offset + 1 };
  if (opcode >= 0x51 && opcode <= 0x60) return { value: BigInt(opcode - 0x50), nextOffset: offset + 1 };
  if (opcode < 0x01 || opcode > 0x08 || offset + 1 + opcode > bytes.length) {
    throw new Error("redeemScript has an invalid KIP-10 additive threshold");
  }

  const numberBytes = bytes.slice(offset + 1, offset + 1 + opcode);
  if ((numberBytes[numberBytes.length - 1] ?? 0) & 0x80) {
    throw new Error("redeemScript KIP-10 additive threshold must be non-negative");
  }
  let value = 0n;
  for (let index = numberBytes.length - 1; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(numberBytes[index] ?? 0);
  }
  if (value > 0x7fff_ffff_ffff_ffffn) {
    throw new Error("redeemScript KIP-10 additive threshold must fit in signed 64-bit script number");
  }
  return { value, nextOffset: offset + 1 + opcode };
}

function normalizeUint64(value: bigint | number | string, label: string): bigint {
  const normalized =
    typeof value === "bigint"
      ? value
      : typeof value === "number"
        ? numberToUint64(value, label)
        : stringToUint64(value, label);
  if (normalized < 0n || normalized > U64_MAX) {
    throw new Error(`${label} must fit in uint64`);
  }
  return normalized;
}

function normalizeScriptInt64(value: bigint | number | string, label: string): bigint {
  const normalized = normalizeUint64(value, label);
  if (normalized > 0x7fff_ffff_ffff_ffffn) {
    throw new Error(`${label} must fit in signed 64-bit script number`);
  }
  return normalized;
}

function numberToUint64(value: number, label: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return BigInt(value);
}

function stringToUint64(value: string, label: string): bigint {
  if (!U64_DECIMAL_PATTERN.test(value)) {
    throw new Error(`${label} must be a canonical uint64 decimal string`);
  }
  return BigInt(value);
}

function int64Le(value: bigint): Uint8Array {
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64LE(value);
  return Uint8Array.from(buffer);
}

function pushData(data: Uint8Array): Uint8Array {
  if (data.byteLength <= 75) {
    return concatBytes([Uint8Array.of(data.byteLength), data]);
  }
  if (data.byteLength <= 0xff) {
    return concatBytes([Uint8Array.of(0x4c, data.byteLength), data]);
  }
  if (data.byteLength <= 0xffff) {
    return concatBytes([Uint8Array.of(0x4d, data.byteLength & 0xff, data.byteLength >>> 8), data]);
  }
  throw new Error("pushdata payload is too large");
}

function pushScriptNumber(value: bigint): Uint8Array {
  if (value === 0n) return Uint8Array.of(0x00);
  if (value <= 16n) return Uint8Array.of(0x50 + Number(value));

  const bytes: number[] = [];
  let cursor = value;
  while (cursor > 0n) {
    bytes.push(Number(cursor & 0xffn));
    cursor >>= 8n;
  }
  if ((bytes[bytes.length - 1] ?? 0) & 0x80) {
    bytes.push(0);
  }
  return pushData(Uint8Array.from(bytes));
}
