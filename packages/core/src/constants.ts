export const X402_VERSION = 2;

export const SUPPORTED_NETWORKS = [
  "kaspa:mainnet",
  "kaspa:testnet-10",
] as const;

export const ASSET_ID = "KAS";
export const ESCROW_BINDING_ID = "kaspa-escrow-v2";
export const ESCROW_TEMPLATE_ID = "kaspa-x402-escrow-v2";

export const VOUCHER_DOMAIN_TAG = "kaspa:x402:escrow-voucher:v2";
export const CHANNEL_DOMAIN_TAG = "kaspa:x402:channel:v1";
export const BATCH_PAYMENT_REQUIREMENTS_DOMAIN_TAG =
  "kaspa:x402:batch-payment-requirements:v2";
export const BATCH_COMMITMENT_DOMAIN_TAG = "kaspa:x402:batch-commitment:v2";

export const U32_MAX = 0xffff_ffff;
export const U64_MAX = 0xffff_ffff_ffff_ffffn;
/** SilverScript covenant state and arithmetic use non-negative signed int64 values. */
export const BATCH_SCRIPT_INT_MAX = 0x7fff_ffff_ffff_ffffn;
/** Below this consensus boundary lock_time is a DAA score; at/above it is a timestamp. */
export const KASPA_LOCK_TIME_THRESHOLD = 500_000_000_000n;

export const U64_DECIMAL_PATTERN =
  /^(?:0|[1-9][0-9]{0,18}|1[0-7][0-9]{18}|18[0-3][0-9]{17}|184[0-3][0-9]{16}|1844[0-5][0-9]{15}|18446[0-6][0-9]{14}|184467[0-3][0-9]{13}|1844674[0-3][0-9]{12}|184467440[0-6][0-9]{10}|1844674407[0-2][0-9]{9}|18446744073[0-6][0-9]{8}|1844674407370[0-8][0-9]{6}|18446744073709[0-4][0-9]{5}|184467440737095[0-4][0-9]{4}|18446744073709550[0-9]{3}|18446744073709551[0-5][0-9]{2}|1844674407370955160[0-9]{1}|1844674407370955161[0-4]|18446744073709551615)$/;

export const BATCH_AMOUNT_DECIMAL_PATTERN =
  /^(?:0|[1-9][0-9]{0,17}|[1-8][0-9]{18}|9[0-1][0-9]{17}|92[0-1][0-9]{16}|922[0-2][0-9]{15}|9223[0-2][0-9]{14}|92233[0-6][0-9]{13}|922337[0-1][0-9]{12}|92233720[0-2][0-9]{10}|922337203[0-5][0-9]{9}|9223372036[0-7][0-9]{8}|92233720368[0-4][0-9]{7}|922337203685[0-3][0-9]{6}|9223372036854[0-6][0-9]{5}|92233720368547[0-6][0-9]{4}|922337203685477[0-4][0-9]{3}|9223372036854775[0-7][0-9]{2}|922337203685477580[0-7])$/;

export const HEX_BYTE_PATTERN = /^(?:[0-9a-fA-F]{2})*$/;
export const HASH32_PATTERN = /^[0-9a-fA-F]{64}$/;
export const SIGNATURE64_PATTERN = /^[0-9a-fA-F]{128}$/;
