/** Kaspa consensus-supported signature scopes. Wallets default to ALL. */
export type KaspaSighashType = 0x01 | 0x02 | 0x04 | 0x81 | 0x82 | 0x84;

export const KASPA_SIGHASH_NAMES = {
  1: "all", 2: "none", 4: "single",
  129: "all-anyonecanpay", 130: "none-anyonecanpay", 132: "single-anyonecanpay",
} as const;

export function kaspaSighashType(value: number): KaspaSighashType {
  if (!Number.isInteger(value) || !Object.hasOwn(KASPA_SIGHASH_NAMES, value)) throw new Error("invalid Kaspa sighash type");
  return value as KaspaSighashType;
}
