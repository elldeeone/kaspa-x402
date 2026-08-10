import { VOUCHER_DOMAIN_TAG } from "./constants.js";
import { bytesToHex, concatBytes, hexToBytes, le64, sha256 } from "./binary.js";
import { parseBatchLaneAmount } from "./batch-lane.js";
import { KaspaX402Error } from "./errors.js";
import { parseKaspaNetwork } from "./network.js";
import type { Hash32Hex, NetworkId, SompiString } from "./types.js";

export type VoucherDigestInput = {
  network: NetworkId | string;
  covenantId: Hash32Hex;
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
  const covenantId = hexToBytes(input.covenantId, {
    expectedLength: 32,
    errorCode: "invalid_kaspa_x402_binding",
    label: "covenantId",
  });
  if (covenantId.every((byte) => byte === 0)) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_binding",
      "covenantId must identify a bound KIP-20 lineage",
    );
  }
  return concatBytes([
    sha256(VOUCHER_DOMAIN_TAG),
    sha256(network),
    covenantId,
    le64(parseBatchLaneAmount(input.amount, "voucher amount")),
  ]);
}

export function voucherPreimageHex(input: VoucherDigestInput): string {
  return bytesToHex(voucherPreimage(input));
}

export function voucherDigest(input: VoucherDigestInput): string {
  return bytesToHex(sha256(voucherPreimage(input)));
}
