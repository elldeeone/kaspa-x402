import {
  KaspaX402Error,
  type ExactProfile,
  type NetworkId,
  type SompiString,
} from "@kaspa-x402/core";

/** Reference gateway policy, not a universal Kaspa consensus dust constant. */
export const MIN_REFERENCE_ONCHAIN_OUTPUT_SOMPI = 10_000_000n;

type WidenStringBindings<T> = {
  [Key in keyof T]: T[Key] extends string ? string : T[Key];
};

type GeneratedGatewayEnv = WidenStringBindings<Env>;

/** Generated Wrangler bindings, widened for test/operator overrides plus secrets. */
export type GatewayEnv = Partial<Omit<GeneratedGatewayEnv, "GATEWAY_STATE">> &
  Pick<GeneratedGatewayEnv, "GATEWAY_STATE"> & {
    KASPA_X402_ADMIN_TOKEN?: string;
  };

export interface GatewayConfig {
  enabled: boolean;
  network: NetworkId;
  chainApiBase: string;
  payTo: string;
  serverPublicKey: string;
  exactAmount: SompiString;
  exactProfile: ExactProfile;
  batchAmount: SompiString;
  minDepositSompi: SompiString;
  claimReserveSompi: SompiString;
  refundTimeoutDaaDelta: SompiString;
  minimumRefundLeadDaa: SompiString;
  maxTimeoutSeconds: number;
  claimFeeSompi: SompiString;
  corsOrigin: string;
  siteBaseUrl: string;
  releaseVersion: string;
  gatewayBaseUrl: string;
  adminToken?: string;
  hostedExactSettlementEnabled: boolean;
  chainBroadcastMode: "rest" | "pnn";
  pnnEndpoints: string[];
  pnnTimeoutMs: number;
  pnnAttempts: number;
}

export function readGatewayConfig(env: GatewayEnv): GatewayConfig {
  if (env.KASPA_X402_ADMIN_TOKEN?.trim() && !/^[0-9a-fA-F]{64}$/.test(env.KASPA_X402_ADMIN_TOKEN.trim()))
    throw new Error("KASPA_X402_ADMIN_TOKEN must encode 32 random bytes as 64 hex characters");
  const network = env.KASPA_X402_NETWORK ?? "kaspa:testnet-10";
  if (network !== "kaspa:testnet-10") {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_network",
      "hosted gateway only supports kaspa:testnet-10",
    );
  }
  const payTo = required(env.KASPA_X402_PAY_TO, "KASPA_X402_PAY_TO");
  if (!payTo.startsWith("kaspatest:"))
    throw new KaspaX402Error(
      "invalid_kaspa_x402_network",
      "payTo must be a testnet address",
    );
  const serverPublicKey = required(
    env.KASPA_X402_SERVER_PUBLIC_KEY,
    "KASPA_X402_SERVER_PUBLIC_KEY",
  ).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(serverPublicKey))
    throw new KaspaX402Error(
      "invalid_kaspa_public_key",
      "server public key must be x-only hex",
    );
  const exactAmount = sompi(
    env.KASPA_X402_EXACT_AMOUNT ?? "20000000",
    "KASPA_X402_EXACT_AMOUNT",
  );
  const batchAmount = sompi(
    env.KASPA_X402_BATCH_AMOUNT ?? "500",
    "KASPA_X402_BATCH_AMOUNT",
  );
  const minDepositSompi = sompi(
    env.KASPA_X402_MIN_DEPOSIT_SOMPI ?? "20000000",
    "KASPA_X402_MIN_DEPOSIT_SOMPI",
  );
  const claimReserveSompi = sompi(
    env.KASPA_X402_CLAIM_RESERVE_SOMPI ?? "10000000",
    "KASPA_X402_CLAIM_RESERVE_SOMPI",
  );
  assertStandardOutputAmount(exactAmount, "KASPA_X402_EXACT_AMOUNT");
  assertStandardOutputAmount(minDepositSompi, "KASPA_X402_MIN_DEPOSIT_SOMPI");
  assertStandardOutputAmount(
    claimReserveSompi,
    "KASPA_X402_CLAIM_RESERVE_SOMPI",
  );
  if (
    BigInt(minDepositSompi) <
    BigInt(batchAmount) + BigInt(claimReserveSompi)
  ) {
    throw new Error(
      "KASPA_X402_MIN_DEPOSIT_SOMPI must cover KASPA_X402_BATCH_AMOUNT plus KASPA_X402_CLAIM_RESERVE_SOMPI",
    );
  }
  const chainBroadcastMode = broadcastMode(
    env.KASPA_X402_CHAIN_BROADCAST_MODE ?? "rest",
  );
  const enabled = bool(
    env.KASPA_X402_GATEWAY_ENABLED ?? "false",
    "KASPA_X402_GATEWAY_ENABLED",
  );
  const chainApiBase = baseUrl(
    required(env.KASPA_X402_CHAIN_API_BASE, "KASPA_X402_CHAIN_API_BASE"),
    "KASPA_X402_CHAIN_API_BASE",
  );
  const endpoints = pnnEndpoints(env.KASPA_X402_PNN_ENDPOINTS ?? "");
  if (chainBroadcastMode === "pnn" && endpoints.length === 0) {
    throw new Error(
      "KASPA_X402_PNN_ENDPOINTS is required when KASPA_X402_CHAIN_BROADCAST_MODE=pnn",
    );
  }
  const refundTimeoutDaaDelta = sompi(
    env.KASPA_X402_REFUND_TIMEOUT_DAA_DELTA ?? "36000",
    "KASPA_X402_REFUND_TIMEOUT_DAA_DELTA",
  );
  const minimumRefundLeadDaa = sompi(
    env.KASPA_X402_MINIMUM_REFUND_LEAD_DAA ?? "1000",
    "KASPA_X402_MINIMUM_REFUND_LEAD_DAA",
  );
  if (BigInt(refundTimeoutDaaDelta) <= BigInt(minimumRefundLeadDaa)) {
    throw new Error(
      "KASPA_X402_REFUND_TIMEOUT_DAA_DELTA must exceed KASPA_X402_MINIMUM_REFUND_LEAD_DAA",
    );
  }
  return {
    enabled,
    network,
    chainApiBase,
    payTo,
    serverPublicKey,
    exactAmount,
    exactProfile: exactProfile(
      env.KASPA_X402_EXACT_PROFILE ?? "standard-native",
    ),
    batchAmount,
    minDepositSompi,
    claimReserveSompi,
    refundTimeoutDaaDelta,
    minimumRefundLeadDaa,
    maxTimeoutSeconds: uint(
      env.KASPA_X402_MAX_TIMEOUT_SECONDS ?? "60",
      "KASPA_X402_MAX_TIMEOUT_SECONDS",
      1,
      600,
    ),
    claimFeeSompi: sompi(
      env.KASPA_X402_CLAIM_FEE_SOMPI ?? "10000",
      "KASPA_X402_CLAIM_FEE_SOMPI",
    ),
    corsOrigin: env.KASPA_X402_CORS_ORIGIN ?? "https://kaspa-x402.org",
    siteBaseUrl: baseUrl(
      env.KASPA_X402_SITE_BASE_URL ?? "https://kaspa-x402.org",
      "KASPA_X402_SITE_BASE_URL",
    ),
    releaseVersion: releaseVersion(
      env.KASPA_X402_RELEASE_VERSION ?? "0.1.0-alpha.11",
    ),
    gatewayBaseUrl: baseUrl(
      env.KASPA_X402_GATEWAY_BASE_URL ?? "https://demo.kaspa-x402.org",
      "KASPA_X402_GATEWAY_BASE_URL",
    ),
    hostedExactSettlementEnabled: bool(
      env.KASPA_X402_HOSTED_EXACT_SETTLEMENT_ENABLED ?? "false",
      "KASPA_X402_HOSTED_EXACT_SETTLEMENT_ENABLED",
    ),
    chainBroadcastMode,
    pnnEndpoints: endpoints,
    pnnTimeoutMs: uint(
      env.KASPA_X402_PNN_TIMEOUT_MS ?? "15000",
      "KASPA_X402_PNN_TIMEOUT_MS",
      1000,
      60000,
    ),
    pnnAttempts: uint(
      env.KASPA_X402_PNN_ATTEMPTS ?? "2",
      "KASPA_X402_PNN_ATTEMPTS",
      1,
      5,
    ),
    ...(env.KASPA_X402_ADMIN_TOKEN?.trim()
      ? { adminToken: env.KASPA_X402_ADMIN_TOKEN.trim() }
      : {}),
  };
}

function releaseVersion(value: string): string {
  const normalized = value.trim();
  if (!/^0\.1\.0-alpha\.\d+$/.test(normalized)) {
    throw new Error(
      "KASPA_X402_RELEASE_VERSION must be an alpha release version",
    );
  }
  return normalized;
}

function exactProfile(value: string): ExactProfile {
  const normalized = value.trim().toLowerCase();
  if (normalized === "standard-native" || normalized === "additive")
    return normalized;
  throw new Error(
    "KASPA_X402_EXACT_PROFILE must be standard-native or additive",
  );
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function sompi(value: string, name: string): SompiString {
  const text = value.trim();
  if (!/^(?:0|[1-9][0-9]*)$/.test(text))
    throw new Error(`${name} must be a canonical uint64 string`);
  const bigint = BigInt(text);
  if (bigint > 18_446_744_073_709_551_615n)
    throw new Error(`${name} exceeds uint64`);
  return text;
}

function assertStandardOutputAmount(value: SompiString, name: string): void {
  if (BigInt(value) < MIN_REFERENCE_ONCHAIN_OUTPUT_SOMPI) {
    throw new Error(
      `${name} is below reference on-chain output policy ${MIN_REFERENCE_ONCHAIN_OUTPUT_SOMPI}`,
    );
  }
}

function bool(value: string, name: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  throw new Error(`${name} must be true or false`);
}

function broadcastMode(value: string): "rest" | "pnn" {
  const normalized = value.trim().toLowerCase();
  if (normalized === "rest" || normalized === "pnn") return normalized;
  throw new Error("KASPA_X402_CHAIN_BROADCAST_MODE must be rest or pnn");
}

function pnnEndpoints(value: string): string[] {
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length > 8) {
    throw new Error("KASPA_X402_PNN_ENDPOINTS accepts at most 8 entries");
  }
  for (const entry of entries) {
    if (entry.length > 2_048) {
      throw new Error("KASPA_X402_PNN_ENDPOINTS entries are too long");
    }
    const parsed = new URL(entry);
    if (parsed.protocol !== "wss:" && parsed.protocol !== "ws:") {
      throw new Error(
        "KASPA_X402_PNN_ENDPOINTS entries must be ws or wss URLs",
      );
    }
    if (
      parsed.protocol === "ws:" &&
      parsed.hostname !== "127.0.0.1" &&
      parsed.hostname !== "localhost"
    ) {
      throw new Error(
        "KASPA_X402_PNN_ENDPOINTS must use wss except for localhost",
      );
    }
    if (parsed.username || parsed.password || parsed.hash) {
      throw new Error(
        "KASPA_X402_PNN_ENDPOINTS must not contain credentials or fragments",
      );
    }
  }
  return entries;
}

function baseUrl(value: string, name: string): string {
  const text = value.trim();
  const parsed = new URL(text);
  if (parsed.username || parsed.password) {
    throw new Error(`${name} must not contain credentials`);
  }
  if (
    parsed.protocol !== "https:" &&
    parsed.hostname !== "127.0.0.1" &&
    parsed.hostname !== "localhost"
  ) {
    throw new Error(`${name} must be an https URL`);
  }
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/$/, "");
}

function uint(value: string, name: string, min: number, max: number): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value))
    throw new Error(`${name} must be an integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max)
    throw new Error(`${name} is outside range ${min}-${max}`);
  return number;
}
