import { KaspaX402Error, type NetworkId, type SompiString } from "@kaspa-x402/core";

export const MIN_STANDARD_OUTPUT_SOMPI = 10_000_000n;

export interface GatewayEnv {
  GATEWAY_STATE: DurableObjectNamespace;
  KASPA_X402_NETWORK?: string;
  KASPA_X402_CHAIN_API_BASE?: string;
  KASPA_X402_PAY_TO?: string;
  KASPA_X402_SERVER_PUBLIC_KEY?: string;
  KASPA_X402_EXACT_AMOUNT?: string;
  KASPA_X402_BATCH_AMOUNT?: string;
  KASPA_X402_MIN_DEPOSIT_SOMPI?: string;
  KASPA_X402_REFUND_TIMEOUT_DAA?: string;
  KASPA_X402_MAX_TIMEOUT_SECONDS?: string;
  KASPA_X402_CLAIM_FEE_SOMPI?: string;
  KASPA_X402_RATE_LIMIT_PER_MINUTE?: string;
  KASPA_X402_CORS_ORIGIN?: string;
}

export interface GatewayConfig {
  network: NetworkId;
  chainApiBase: string;
  payTo: string;
  serverPublicKey: string;
  exactAmount: SompiString;
  batchAmount: SompiString;
  minDepositSompi: SompiString;
  refundTimeoutDaa: SompiString;
  maxTimeoutSeconds: number;
  claimFeeSompi: SompiString;
  rateLimitPerMinute: number;
  corsOrigin: string;
}

export function readGatewayConfig(env: GatewayEnv): GatewayConfig {
  const network = env.KASPA_X402_NETWORK ?? "kaspa:testnet-10";
  if (network !== "kaspa:testnet-10") {
    throw new KaspaX402Error("invalid_kaspa_x402_network", "hosted gateway only supports kaspa:testnet-10");
  }
  const payTo = required(env.KASPA_X402_PAY_TO, "KASPA_X402_PAY_TO");
  if (!payTo.startsWith("kaspatest:")) throw new KaspaX402Error("invalid_kaspa_x402_network", "payTo must be a testnet address");
  const serverPublicKey = required(env.KASPA_X402_SERVER_PUBLIC_KEY, "KASPA_X402_SERVER_PUBLIC_KEY").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(serverPublicKey)) throw new KaspaX402Error("invalid_kaspa_public_key", "server public key must be x-only hex");
  const exactAmount = sompi(env.KASPA_X402_EXACT_AMOUNT ?? "20000000", "KASPA_X402_EXACT_AMOUNT");
  const minDepositSompi = sompi(env.KASPA_X402_MIN_DEPOSIT_SOMPI ?? "20000000", "KASPA_X402_MIN_DEPOSIT_SOMPI");
  assertStandardOutputAmount(exactAmount, "KASPA_X402_EXACT_AMOUNT");
  assertStandardOutputAmount(minDepositSompi, "KASPA_X402_MIN_DEPOSIT_SOMPI");
  return {
    network,
    chainApiBase: required(env.KASPA_X402_CHAIN_API_BASE, "KASPA_X402_CHAIN_API_BASE"),
    payTo,
    serverPublicKey,
    exactAmount,
    batchAmount: sompi(env.KASPA_X402_BATCH_AMOUNT ?? "500", "KASPA_X402_BATCH_AMOUNT"),
    minDepositSompi,
    refundTimeoutDaa: sompi(env.KASPA_X402_REFUND_TIMEOUT_DAA ?? "3600", "KASPA_X402_REFUND_TIMEOUT_DAA"),
    maxTimeoutSeconds: uint(env.KASPA_X402_MAX_TIMEOUT_SECONDS ?? "60", "KASPA_X402_MAX_TIMEOUT_SECONDS", 1, 600),
    claimFeeSompi: sompi(env.KASPA_X402_CLAIM_FEE_SOMPI ?? "10000", "KASPA_X402_CLAIM_FEE_SOMPI"),
    rateLimitPerMinute: uint(env.KASPA_X402_RATE_LIMIT_PER_MINUTE ?? "60", "KASPA_X402_RATE_LIMIT_PER_MINUTE", 1, 600),
    corsOrigin: env.KASPA_X402_CORS_ORIGIN ?? "https://kaspa-x402.org",
  };
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function sompi(value: string, name: string): SompiString {
  const text = value.trim();
  if (!/^(?:0|[1-9][0-9]*)$/.test(text)) throw new Error(`${name} must be a canonical uint64 string`);
  const bigint = BigInt(text);
  if (bigint > 18_446_744_073_709_551_615n) throw new Error(`${name} exceeds uint64`);
  return text;
}

function assertStandardOutputAmount(value: SompiString, name: string): void {
  if (BigInt(value) < MIN_STANDARD_OUTPUT_SOMPI) {
    throw new Error(`${name} is below Kaspa storage-mass floor ${MIN_STANDARD_OUTPUT_SOMPI}`);
  }
}

function uint(value: string, name: string, min: number, max: number): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error(`${name} must be an integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${name} is outside range ${min}-${max}`);
  return number;
}
