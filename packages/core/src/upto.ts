import { ASSET_ID, UPTO_AUTHORIZATION_DOMAIN_TAG } from "./constants.js";
import { bytesToHex, concatBytes, hexToBytes, le32, le64, sha256 } from "./binary.js";
import { parseKaspaNetwork } from "./network.js";
import type { FundingOutpoint, NetworkId, PublicKeyHex, SompiString } from "./types.js";

export type UptoAuthorizationDigestInput = {
  network: NetworkId | string;
  payTo: string;
  refundAddress: string;
  clientPublicKey: PublicKeyHex;
  serverPublicKey: PublicKeyHex;
  authorizationOutpoint: FundingOutpoint;
  maxAmountSompi: SompiString;
  validAfterDaa: SompiString;
  validBeforeDaa: SompiString;
  nonce: string;
  requestHash: string;
};

export function uptoAuthorizationDomainTag(): string {
  return UPTO_AUTHORIZATION_DOMAIN_TAG;
}

export function uptoAuthorizationPreimage(input: UptoAuthorizationDigestInput): Uint8Array {
  const requestHashBytes = hexToBytes(input.requestHash, { expectedLength: 32, errorCode: "invalid_kaspa_x402_payload", label: "requestHash" });
  return concatBytes([
    sha256(UPTO_AUTHORIZATION_DOMAIN_TAG),
    sha256(parseKaspaNetwork(input.network)),
    sha256(ASSET_ID),
    sha256(input.payTo),
    sha256(input.refundAddress),
    hexToBytes(input.clientPublicKey, { expectedLength: 32, errorCode: "invalid_kaspa_public_key", label: "clientPublicKey" }),
    hexToBytes(input.serverPublicKey, { expectedLength: 32, errorCode: "invalid_kaspa_public_key", label: "serverPublicKey" }),
    hexToBytes(input.authorizationOutpoint.txid, {
      expectedLength: 32,
      errorCode: "invalid_kaspa_upto_authorization_outpoint",
      label: "authorizationOutpoint.txid",
    }),
    le32(input.authorizationOutpoint.index, "invalid_kaspa_upto_authorization_outpoint"),
    le64(input.maxAmountSompi),
    le64(input.validAfterDaa),
    le64(input.validBeforeDaa),
    hexToBytes(input.nonce, { expectedLength: 32, errorCode: "invalid_kaspa_upto_authorization", label: "nonce" }),
    sha256(requestHashBytes),
  ]);
}

export function uptoAuthorizationPreimageHex(input: UptoAuthorizationDigestInput): string {
  return bytesToHex(uptoAuthorizationPreimage(input));
}

export function uptoAuthorizationDigest(input: UptoAuthorizationDigestInput): string {
  return bytesToHex(sha256(uptoAuthorizationPreimage(input)));
}
