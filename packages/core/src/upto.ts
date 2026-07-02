import { formatSompiString, parseSompiString } from "./amount.js";
import { UPTO_AUTHORIZATION_DOMAIN_TAG, UPTO_MIN_REFUND_OUTPUT_SOMPI } from "./constants.js";
import { bytesToHex, concatBytes, hexToBytes, le32, sha256 } from "./binary.js";
import { KaspaX402Error } from "./errors.js";
import { parseKaspaNetwork } from "./network.js";
import type { ByteHex, FundingOutpoint, Hash32Hex, NetworkId, SompiString } from "./types.js";

export type UptoAuthorizationDigestInput = {
  network: NetworkId | string;
  activeScriptPublicKey: ByteHex;
  authorizationOutpoint: FundingOutpoint;
  requestHash: Hash32Hex;
  nonce: Hash32Hex;
};

export function minimumUptoAuthorizationAmount(maxAmountSompi: SompiString, settlementFeeReserveSompi: SompiString): SompiString {
  return formatSompiString(
    parseSompiString(maxAmountSompi) + parseSompiString(settlementFeeReserveSompi) + parseSompiString(UPTO_MIN_REFUND_OUTPUT_SOMPI),
  );
}

export function uptoAuthorizationDomainTag(): string {
  return UPTO_AUTHORIZATION_DOMAIN_TAG;
}

export function uptoAuthorizationPreimage(input: UptoAuthorizationDigestInput): Uint8Array {
  return concatBytes([
    sha256(UPTO_AUTHORIZATION_DOMAIN_TAG),
    sha256(parseKaspaNetwork(input.network)),
    sha256(serializedScriptPublicKeyBytes(input.activeScriptPublicKey, "activeScriptPublicKey")),
    hexToBytes(input.authorizationOutpoint.txid, {
      expectedLength: 32,
      errorCode: "invalid_kaspa_upto_authorization_outpoint",
      label: "authorizationOutpoint.txid",
    }),
    le32(input.authorizationOutpoint.index, "invalid_kaspa_upto_authorization_outpoint"),
    hexToBytes(input.requestHash, { expectedLength: 32, errorCode: "invalid_kaspa_x402_payload", label: "requestHash" }),
    hexToBytes(input.nonce, { expectedLength: 32, errorCode: "invalid_kaspa_upto_authorization", label: "nonce" }),
  ]);
}

export function uptoAuthorizationPreimageHex(input: UptoAuthorizationDigestInput): string {
  return bytesToHex(uptoAuthorizationPreimage(input));
}

export function uptoAuthorizationDigest(input: UptoAuthorizationDigestInput): string {
  return bytesToHex(sha256(uptoAuthorizationPreimage(input)));
}

function serializedScriptPublicKeyBytes(hex: string, label: string): Uint8Array {
  const bytes = hexToBytes(hex, { errorCode: "invalid_kaspa_upto_template", label });
  if (bytes.byteLength < 3) {
    throw new KaspaX402Error("invalid_kaspa_upto_template", `${label} must be serialized as uint16_le version followed by script bytes`);
  }
  const version = bytes[0] | ((bytes[1] ?? 0) << 8);
  if (version !== 0) {
    throw new KaspaX402Error("invalid_kaspa_upto_template", `${label} version must be 0 for kaspa-x402 v1`);
  }
  return bytes;
}
