export function transactionInputOutpoint(input) {
  const outpoint = input.previousOutpoint ?? input.utxo?.outpoint;
  const txid = outpoint?.transactionId ?? input.transactionId;
  const index = outpoint?.index ?? input.index;
  if (txid === undefined || index === undefined) return undefined;
  return {
    txid: String(txid),
    index: Number(index),
  };
}
