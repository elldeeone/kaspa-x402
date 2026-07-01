import { VOUCHER_DOMAIN_TAG } from "./constants.js";
import { bytesToHex, concatBytes, hexToBytes, le32, le64, sha256 } from "./binary.js";
import { KaspaX402Error } from "./errors.js";
import { parseKaspaNetwork } from "./network.js";
import type { FundingOutpoint, NetworkId, SompiString } from "./types.js";

export type VoucherDigestInput = {
  network: NetworkId | string;
  activeScriptPublicKey: string;
  outpoint: FundingOutpoint;
  amount: SompiString;
};

export function voucherDomainTag(): string {
  return VOUCHER_DOMAIN_TAG;
}

export function networkHash(network: NetworkId | string): Uint8Array {
  return sha256(parseKaspaNetwork(network));
}

export function voucherPreimage(input: VoucherDigestInput): Uint8Array {
  const network = parseKaspaNetwork(input.network);
  const activeScriptPublicKey = serializedScriptPublicKeyBytes(input.activeScriptPublicKey);
  return concatBytes([
    sha256(VOUCHER_DOMAIN_TAG),
    sha256(network),
    sha256(activeScriptPublicKey),
    hexToBytes(input.outpoint.txid, { expectedLength: 32, errorCode: "invalid_kaspa_outpoint", label: "outpoint.txid" }),
    le32(input.outpoint.index),
    le64(input.amount),
  ]);
}

export function voucherPreimageHex(input: VoucherDigestInput): string {
  return bytesToHex(voucherPreimage(input));
}

export function voucherDigest(input: VoucherDigestInput): string {
  return bytesToHex(sha256(voucherPreimage(input)));
}

function serializedScriptPublicKeyBytes(value: string): Uint8Array {
  const bytes = hexToBytes(value, { errorCode: "invalid_kaspa_x402_binding", label: "activeScriptPublicKey" });
  if (bytes.byteLength < 3) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_binding",
      "activeScriptPublicKey must be serialized as uint16_le version followed by script bytes",
    );
  }

  const version = bytes[0] | ((bytes[1] ?? 0) << 8);
  if (version !== 0) {
    throw new KaspaX402Error("invalid_kaspa_x402_binding", "activeScriptPublicKey version must be 0 for kaspa-x402 v1");
  }
  return bytes;
}
