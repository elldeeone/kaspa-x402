import type { FundingOutpoint } from "@kaspa-x402/core";
import type { HashChainChainView, HashChainSelectedTransaction, HashChainTrustedOrigin } from "./hash-chain-verifier.js";

/** Bounded Testnet-10 REST readback; both the transaction and its accepting block must remain selected. */
export class HashChainRestView implements HashChainChainView {
  readonly #baseUrl: string;
  constructor(baseUrl: string, private readonly fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init)) {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:") throw new Error("selected-chain REST endpoint must use HTTPS");
    this.#baseUrl = parsed.href.replace(/\/+$/, "");
  }

  async getAcceptedOrigin(
    outpoint: FundingOutpoint,
    options?: { signal?: AbortSignal },
  ): Promise<HashChainTrustedOrigin | null> {
    return (await this.getAcceptedOrigins([outpoint], options))[0] ?? null;
  }

  async getAcceptedOrigins(
    outpoints: readonly FundingOutpoint[],
    options: { signal?: AbortSignal } = {},
  ): Promise<readonly (HashChainTrustedOrigin | null)[]> {
    if (outpoints.length === 0 || outpoints.length > 64) {
      throw new Error("selected-chain REST origin batch must contain 1 to 64 outpoints");
    }
    options.signal?.throwIfAborted();
    const transactionIds = [...new Set(outpoints.map((item) => hash(item.txid)))];
    const response = await this.#json<unknown[]>(
      "/transactions/search?resolve_previous_outpoints=no&acceptance=accepted&fields=transaction_id,is_accepted,accepting_block_hash,outputs",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transactionIds }),
      },
      options.signal,
    );
    if (!Array.isArray(response)) {
      throw new Error("selected-chain REST transaction batch is invalid");
    }
    const transactions = new Map<string, Record<string, unknown>>();
    for (const raw of response) {
      const tx = record(raw);
      const id = hash(tx.transaction_id);
      if (!transactionIds.includes(id) || transactions.has(id)) {
        throw new Error("selected-chain REST transaction batch is inconsistent");
      }
      transactions.set(id, tx);
    }
    const blockCache = new Map<string, Promise<Record<string, unknown> | null>>();
    const selected = new Map<string, Record<string, unknown> | null>();
    await Promise.all(transactionIds.map(async (id) => {
      const tx = transactions.get(id);
      selected.set(
        id,
        tx && await this.#isSelectedTransaction(tx, id, blockCache, options.signal)
          ? tx
          : null,
      );
    }));
    options.signal?.throwIfAborted();
    return outpoints.map((outpoint) => {
      const tx = selected.get(hash(outpoint.txid));
      if (!tx) return null;
      const outputs = list(tx.outputs);
      const output = outputs.find(
        (item) => Number(record(item).index) === outpoint.index,
      ) ?? outputs[outpoint.index];
      if (!output) return null;
      const item = record(output);
      return {
        amount: decimal(item.amount),
        scriptPublicKey: script(item.script_public_key),
        covenantId: covenant(item)?.covenantId ?? null,
      };
    });
  }

  async getSelectedTransaction(
    transactionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<HashChainSelectedTransaction | null> {
    const tx = await this.#selectedTransaction(transactionId, options.signal);
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

  async isSelected(
    transactionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<boolean> {
    return (await this.#selectedTransaction(transactionId, options.signal)) !== null;
  }

  async #selectedTransaction(
    transactionId: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | null> {
    const id = hash(transactionId);
    const tx = await this.#json(
      `/transactions/${id}?inputs=true&outputs=true&resolve_previous_outpoints=no`,
      {},
      signal,
    );
    if (!tx) return null;
    return await this.#isSelectedTransaction(tx, id, new Map(), signal)
      ? tx
      : null;
  }

  async #isSelectedTransaction(
    tx: Record<string, unknown>,
    transactionId: string,
    blockCache: Map<string, Promise<Record<string, unknown> | null>>,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (tx.is_accepted !== true || hash(tx.transaction_id) !== transactionId) {
      return false;
    }
    const acceptingBlock = hash(tx.accepting_block_hash);
    let block = blockCache.get(acceptingBlock);
    if (!block) {
      block = this.#json(
        `/blocks/${acceptingBlock}?includeTransactions=false`,
        {},
        signal,
      );
      blockCache.set(acceptingBlock, block);
    }
    const selectedBlock = await block;
    signal?.throwIfAborted();
    if (!selectedBlock) return false;
    const verbose = record(selectedBlock.verboseData);
    return verbose.isChainBlock === true && hash(verbose.hash) === acceptingBlock;
  }

  async #json<T = Record<string, unknown>>(
    path: string,
    init: RequestInit = {},
    signal?: AbortSignal,
  ): Promise<T | null> {
    signal?.throwIfAborted();
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(8000)])
      : AbortSignal.timeout(8000);
    const response = await this.fetcher(`${this.#baseUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        "cache-control": "no-cache",
        ...(init.headers ?? {}),
      },
      cache: "no-store",
      redirect: "manual",
      signal: requestSignal,
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`selected-chain REST returned HTTP ${response.status}`);
    const contentLength = Number(response.headers.get("content-length"));
    if (contentLength > 524288) throw new Error("selected-chain REST response is too large");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("selected-chain REST response has no body");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        signal?.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 524288) {
          throw new Error("selected-chain REST response is too large");
        }
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel(error).catch(() => undefined);
      throw error;
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
