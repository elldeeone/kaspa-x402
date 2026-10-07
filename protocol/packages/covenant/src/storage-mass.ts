import { hexToBytes } from "./template.js";

export const KASPA_STORAGE_MASS_PARAMETER = 1_000_000_000_000n;

const UTXO_CONST_STORAGE = 63n;
const UTXO_COVENANT_STORAGE = 32n;
const UTXO_UNIT_SIZE = 100n;
const U64_MAX = 0xffff_ffff_ffff_ffffn;

export interface KaspaStorageCell {
  amount: bigint | number | string;
  scriptPublicKey: string;
  hasCovenant?: boolean;
}

/** Mirrors rusty-kaspa's KIP-9 contextual storage-mass calculation. */
export function calculateKaspaStorageMass(input: {
  inputs: readonly KaspaStorageCell[];
  outputs: readonly KaspaStorageCell[];
  storageMassParameter?: bigint;
}): bigint {
  const parameter = input.storageMassParameter ?? KASPA_STORAGE_MASS_PARAMETER;
  if (parameter < 0n || parameter > U64_MAX) throw new Error("storage mass parameter must fit uint64");
  const outputCells = input.outputs.map(toUtxoCell);
  const inputCells = input.inputs.map(toUtxoCell);
  if (inputCells.length === 0 || outputCells.length === 0) throw new Error("storage mass requires input and output UTXO cells");

  const outsPlurality = outputCells.reduce((sum, cell) => sum + cell.plurality, 0n);
  const harmonicOuts = outputCells.reduce((sum, cell) => sum + (parameter * cell.plurality * cell.plurality) / cell.amount, 0n);
  const insPlurality = inputCells.reduce((sum, cell) => sum + cell.plurality, 0n);
  const relaxedFormulaPath =
    outsPlurality === 1n || (inputCells.length <= 2 && (insPlurality === 1n || (outsPlurality === 2n && insPlurality === 2n)));

  if (relaxedFormulaPath) {
    const harmonicIns = inputCells.reduce((sum, cell) => sum + (parameter * cell.plurality * cell.plurality) / cell.amount, 0n);
    return harmonicOuts > harmonicIns ? harmonicOuts - harmonicIns : 0n;
  }

  const sumIns = inputCells.reduce((sum, cell) => sum + cell.amount, 0n);
  const meanIns = maxBigInt(sumIns / insPlurality, 1n);
  const arithmeticIns = insPlurality * (parameter / meanIns);
  return harmonicOuts > arithmeticIns ? harmonicOuts - arithmeticIns : 0n;
}

function toUtxoCell(input: KaspaStorageCell): { amount: bigint; plurality: bigint } {
  const amount = normalizeUint64(input.amount, "storage cell amount");
  if (amount === 0n) throw new Error("storage mass cannot be calculated for zero-value UTXO cells");
  const serialized = hexToBytes(input.scriptPublicKey, undefined, "storage cell scriptPublicKey");
  if (serialized.byteLength < 2) throw new Error("storage cell scriptPublicKey must include a uint16 version");
  const scriptLength = BigInt(serialized.byteLength - 2);
  const covenantSize = input.hasCovenant ? UTXO_COVENANT_STORAGE : 0n;
  return {
    amount,
    plurality: divCeil(UTXO_CONST_STORAGE + scriptLength + covenantSize, UTXO_UNIT_SIZE),
  };
}

function normalizeUint64(value: bigint | number | string, label: string): bigint {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`${label} must be a safe unsigned integer`);
  if (typeof value === "string" && !/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} must be canonical uint64`);
  const normalized = BigInt(value);
  if (normalized < 0n || normalized > U64_MAX) throw new Error(`${label} must fit uint64`);
  return normalized;
}

function divCeil(value: bigint, divisor: bigint): bigint {
  return (value + divisor - 1n) / divisor;
}

function maxBigInt(a: bigint, b: bigint): bigint {
  return a >= b ? a : b;
}
