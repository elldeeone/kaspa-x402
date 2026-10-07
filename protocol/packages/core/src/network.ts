import { SUPPORTED_NETWORKS } from "./constants.js";
import { KaspaX402Error } from "./errors.js";
import type { NetworkId } from "./types.js";

export function isKaspaX402Network(value: unknown): value is NetworkId {
  return typeof value === "string" && (SUPPORTED_NETWORKS as readonly string[]).includes(value);
}

export function parseKaspaNetwork(value: unknown): NetworkId {
  if (!isKaspaX402Network(value)) {
    throw new KaspaX402Error("invalid_kaspa_x402_network", "unsupported Kaspa x402 network");
  }
  return value;
}

export function assertSupportedNetwork(value: unknown, supported: readonly NetworkId[] = SUPPORTED_NETWORKS): NetworkId {
  if (typeof value !== "string" || !supported.includes(value as NetworkId)) {
    throw new KaspaX402Error("invalid_kaspa_x402_network", "network is not supported by this implementation");
  }
  return value as NetworkId;
}

export function assertMainnetAllowed(network: NetworkId, allowMainnet = false, component = "Kaspa x402 runtime"): void {
  if (network === "kaspa:mainnet" && !allowMainnet) {
    throw new KaspaX402Error("invalid_kaspa_x402_network", `${component} requires allowMainnet for kaspa:mainnet`);
  }
}
