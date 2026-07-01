import { ASSET_ID, CHANNEL_DOMAIN_TAG, ESCROW_TEMPLATE_ID } from "./constants.js";
import { bytesToHex, concatBytes, hexToBytes, le64, sha256 } from "./binary.js";
import { KaspaX402Error } from "./errors.js";
import { parseKaspaNetwork } from "./network.js";
import type { ChannelConfig, Hash32Hex } from "./types.js";

export function channelIdPreimage(input: ChannelConfig): Uint8Array {
  const network = parseKaspaNetwork(input.network);
  if (input.asset !== ASSET_ID) {
    throw new KaspaX402Error("invalid_kaspa_x402_asset", "channel asset must be KAS");
  }
  if (input.templateId !== ESCROW_TEMPLATE_ID) {
    throw new KaspaX402Error("invalid_kaspa_x402_payload", "unsupported channel template id");
  }

  return concatBytes([
    sha256(CHANNEL_DOMAIN_TAG),
    sha256(network),
    sha256(input.asset),
    sha256(input.templateId),
    hexToBytes(input.clientPublicKey, { expectedLength: 32, errorCode: "invalid_kaspa_public_key", label: "clientPublicKey" }),
    hexToBytes(input.serverPublicKey, { expectedLength: 32, errorCode: "invalid_kaspa_public_key", label: "serverPublicKey" }),
    sha256(input.payTo),
    sha256(input.refundAddress),
    le64(input.refundTimeoutDaa),
    hexToBytes(input.salt, { expectedLength: 32, label: "salt" }),
  ]);
}

export function channelIdPreimageHex(input: ChannelConfig): string {
  return bytesToHex(channelIdPreimage(input));
}

export function channelId(input: ChannelConfig): Hash32Hex {
  return bytesToHex(sha256(channelIdPreimage(input)));
}

export function validateChannelId(input: ChannelConfig, expected: Hash32Hex): boolean {
  if (channelId(input).toLowerCase() !== expected.toLowerCase()) {
    throw new KaspaX402Error("invalid_kaspa_channel_id", "channel id does not match channel config");
  }
  return true;
}
