import type { FundingOutpoint } from "@kaspa-x402/core";
import type { HashChainObservedHead } from "./hash-chain-grants.js";
import type { HashChainChainView, HashChainSelectedTransaction, HashChainTrustedOrigin } from "./hash-chain-verifier.js";

/** Bounded Testnet-10 REST readback; both the transaction and its accepting block must remain selected. */
export class HashChainRestView implements HashChainChainView {
  readonly #baseUrl: string;
  constructor(baseUrl: string, private readonly fetcher: typeof fetch = fetch) {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:") throw new Error("selected-chain REST endpoint must use HTTPS");
    this.#baseUrl = parsed.href.replace(/\/+$/, "");
  }

  async getAcceptedOrigin(outpoint: FundingOutpoint): Promise<HashChainTrustedOrigin | null> {
    const tx = await this.#selectedTransaction(outpoint.txid);
    if (!tx) return null;
    const outputs = list(tx.outputs);
    const output = outputs.find((item) => Number(record(item).index) === outpoint.index) ?? outputs[outpoint.index];
    if (!output) return null;
    const item = record(output);
    return {
      amount: decimal(item.amount),
      scriptPublicKey: script(item.script_public_key),
      covenantId: covenant(item)?.covenantId ?? null,
    };
  }

  async getSelectedTransaction(transactionId: string): Promise<HashChainSelectedTransaction | null> {
    const tx = await this.#selectedTransaction(transactionId);
    if (!tx) return null;
    const first = record(list(tx.inputs)[0]);
    const outputs = list(tx.outputs);
    const output = record(outputs.find((item) => Number(record(item).index) === 0) ?? outputs[0]);
    const binding = covenant(output);
    if (!binding || binding.authorizingInput !== 0) return null;
    return {
      transactionId: hash(tx.transaction_id), finality: "accepted",
      spentHead: {
        txid: hash(first.previous_outpoint_hash),
        index: index(first.previous_outpoint_index),
      },
      successor: {
        amount: decimal(output.amount), scriptPublicKey: script(output.script_public_key),
        covenantId: binding.covenantId, authorizingInput: 0,
      },
    };
  }

  async isSelected(transactionId: string): Promise<boolean> {
    return (await this.#selectedTransaction(transactionId)) !== null;
  }

  /** A virtual-UTXO read prevents release of a key for a reorged or already spent head. */
  async isUnspentHead(head: HashChainObservedHead, address: string): Promise<boolean> {
    const response = await this.#json<unknown[]>(`/addresses/${encodeURIComponent(address)}/utxos`);
    if (!Array.isArray(response)) throw new Error("selected-chain REST UTXO list is invalid");
    if (response.length > 512) throw new Error("selected-chain REST UTXO list is too large");
    for (const raw of response) {
      const utxo = record(raw);
      const outpoint = record(utxo.outpoint);
      if (hash(outpoint.transactionId) !== head.outpoint.txid || index(outpoint.index) !== head.outpoint.index) continue;
      const entry = record(utxo.utxoEntry);
      const scriptPublicKey = record(entry.scriptPublicKey);
      return decimal(entry.amount) === head.amount &&
        script(scriptPublicKey.scriptPublicKey) === head.scriptPublicKey &&
        hash(entry.covenantId ?? entry.covenant_id) === head.covenantId;
    }
    return false;
  }

  async #selectedTransaction(transactionId: string): Promise<Record<string, unknown> | null> {
    const id = hash(transactionId);
    const tx = await this.#json(`/transactions/${id}?inputs=true&outputs=true&resolve_previous_outpoints=no`);
    if (!tx || tx.is_accepted !== true || hash(tx.transaction_id) !== id) return null;
    const acceptingBlock = hash(tx.accepting_block_hash);
    const block = await this.#json(`/blocks/${acceptingBlock}?includeTransactions=false`);
    if (!block) return null;
    const verbose = record(block.verboseData);
    if (verbose.isChainBlock !== true || hash(verbose.hash) !== acceptingBlock) return null;
    return tx;
  }

  async #json<T = Record<string, unknown>>(path: string): Promise<T | null> {
    const response = await this.fetcher(`${this.#baseUrl}${path}`, {
      headers: { accept: "application/json", "cache-control": "no-cache" },
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`selected-chain REST returned HTTP ${response.status}`);
    const contentLength = Number(response.headers.get("content-length"));
    if (contentLength > 524288) throw new Error("selected-chain REST response is too large");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("selected-chain REST response has no body");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 524288) {
        await reader.cancel();
        throw new Error("selected-chain REST response is too large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("selected-chain REST shape is invalid");
  return value as Record<string, unknown>;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("selected-chain REST list is invalid");
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value)) throw new Error("selected-chain REST hash is invalid");
  return value.toLowerCase();
}
function index(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > 0xffff_ffff) throw new Error("selected-chain REST index is invalid");
  return number;
}
function decimal(value: unknown): string {
  const text = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(text)) throw new Error("selected-chain REST amount is invalid");
  return text;
}
function script(value: unknown): string {
  if (typeof value !== "string" || !/^(?:[0-9a-fA-F]{2})+$/.test(value)) throw new Error("selected-chain REST script is invalid");
  const lower = value.toLowerCase();
  return lower.startsWith("0000") ? lower : `0000${lower}`;
}
function covenant(output: Record<string, unknown>): { covenantId: string; authorizingInput: number } | null {
  const nested = output.covenant && typeof output.covenant === "object" ? record(output.covenant) : undefined;
  const rawId = output.covenant_id ?? nested?.covenantId;
  if (rawId === undefined || rawId === null || rawId === "") return null;
  const covenantId = hash(rawId);
  if (/^0+$/.test(covenantId)) return null;
  return { covenantId, authorizingInput: index(output.covenant_authorizing_input ?? nested?.authorizingInput) };
}
