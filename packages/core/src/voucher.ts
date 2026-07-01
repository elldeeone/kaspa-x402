import { VOUCHER_DOMAIN_TAG } from "./constants.js";
import { bytesToHex, concatBytes, hexToBytes, le32, le64, sha256 } from "./binary.js";
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
  return concatBytes([
    sha256(VOUCHER_DOMAIN_TAG),
    sha256(network),
    sha256(hexToBytes(input.activeScriptPublicKey, { label: "activeScriptPublicKey" })),
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
