import { KaspaX402Error, type FundingOutpoint, type Hash32Hex, type NetworkId, type SompiString } from "@kaspa-x402/core";
import type {
  AddressCodec,
  ChainUtxo,
  ExactTransactionVerification,
  ExactTransactionVerificationRequest,
  ExactTransactionVerifier,
  ServerChainProvider,
  TransactionBroadcast,
  VoucherVerificationRequest,
  VoucherVerifier,
} from "@kaspa-x402/server";
import type { DeriveEscrowAddressInput } from "@kaspa-x402/covenant";
import { encodeScriptAddress, scriptPublicKeyForAddress, verifyKaspaSchnorrDigest } from "./kaspa-native.js";

type FetchLike = typeof fetch;

export class ScriptAddressBook {
  readonly #scriptToAddress = new Map<string, string>();

  record(scriptPublicKey: string, address: string): void {
    this.#scriptToAddress.set(scriptPublicKey.toLowerCase(), address);
  }

  addresses(): string[] {
    return Array.from(new Set(this.#scriptToAddress.values()));
  }
}

export class NativeAddressCodec implements AddressCodec {
  readonly #book: ScriptAddressBook;

  constructor(book: ScriptAddressBook) {
    this.#book = book;
  }

  scriptPublicKeyForAddress(address: string, network: NetworkId): string {
    assertTestnet(network);
    const serialized = scriptPublicKeyForAddress(address, network);
    this.#book.record(serialized, address);
    return serialized;
  }

  encodeScriptAddress(input: DeriveEscrowAddressInput): string {
    assertTestnet(input.network);
    const address = encodeScriptAddress(input);
    this.#book.record(input.serializedScriptPublicKey, address);
    return address;
  }
}

export class RestKaspaChainProvider implements ServerChainProvider {
  readonly #client: KaspaRestClient;
  readonly #book: ScriptAddressBook;
  readonly #claimFeeSompi: SompiString;

  constructor(client: KaspaRestClient, book: ScriptAddressBook, claimFeeSompi: SompiString) {
    this.#client = client;
    this.#book = book;
    this.#claimFeeSompi = claimFeeSompi;
  }

  async getUtxo(outpoint: FundingOutpoint, network: NetworkId): Promise<ChainUtxo | null> {
    assertTestnet(network);
    for (const address of this.#book.addresses()) {
      const match = (await this.#client.getUtxosForAddress(address)).find((utxo) => sameOutpoint(utxo.outpoint, outpoint));
      if (match) return match;
    }
    return null;
  }

  async getVirtualDaaScore(): Promise<SompiString> {
    return this.#client.getVirtualDaaScore();
  }

  async estimateClaimFee(): Promise<SompiString> {
    return this.#claimFeeSompi;
  }

  async sendTransaction(): Promise<TransactionBroadcast> {
    throw new KaspaX402Error("invalid_kaspa_transaction", "claim broadcast is disabled for the hosted testnet gateway");
  }
}

export class RestExactTransactionVerifier implements ExactTransactionVerifier {
  readonly #client: KaspaRestClient;

  constructor(client: KaspaRestClient) {
    this.#client = client;
  }

  async verifyExactPayment(request: ExactTransactionVerificationRequest): Promise<ExactTransactionVerification> {
    assertTestnet(request.network);
    if (!request.transactionId) {
      throw new KaspaX402Error("invalid_kaspa_transaction", "exact gateway payments must include transactionId evidence");
    }
    const utxos = await this.#client.getUtxosForAddress(request.payTo);
    const match = utxos.find((utxo) => sameOutpoint(utxo.outpoint, { txid: request.transactionId as Hash32Hex, index: request.paymentOutputIndex }));
    if (!match) {
      throw new KaspaX402Error("invalid_kaspa_outpoint", "exact payment output was not found at payTo address");
    }
    return {
      transactionId: request.transactionId.toLowerCase(),
      paymentOutput: {
        amount: match.amount,
        scriptPublicKey: match.scriptPublicKey,
        address: request.payTo,
      },
      finality: "accepted",
    };
  }
}

export class NativeVoucherVerifier implements VoucherVerifier {
  verifyVoucher(request: VoucherVerificationRequest): boolean {
    return verifyKaspaSchnorrDigest({
      digest: request.digest,
      signature: request.voucher.signature,
      publicKey: request.clientPublicKey,
    });
  }
}

export class KaspaRestClient {
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(baseUrl: string, options: { fetch?: FetchLike; timeoutMs?: number } = {}) {
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#timeoutMs = options.timeoutMs ?? 8_000;
  }

  async health(): Promise<{ ok: true; networkName: string; virtualDaaScore: SompiString }> {
    const blockdag = await this.#json<RestBlockdag>("/info/blockdag");
    if (blockdag.networkName !== "kaspa-testnet-10") {
      throw new KaspaX402Error("invalid_kaspa_x402_network", `unexpected Kaspa REST network ${blockdag.networkName}`);
    }
    return {
      ok: true,
      networkName: blockdag.networkName,
      virtualDaaScore: String(blockdag.virtualDaaScore),
    };
  }

  async getVirtualDaaScore(): Promise<SompiString> {
    return (await this.health()).virtualDaaScore;
  }

  async getUtxosForAddress(address: string): Promise<ChainUtxo[]> {
    const utxos = await this.#json<RestUtxo[]>(`/addresses/${encodeURIComponent(address)}/utxos`);
    return utxos.map((utxo) => ({
      outpoint: {
        txid: String(utxo.outpoint.transactionId).toLowerCase(),
        index: Number(utxo.outpoint.index),
      },
      amount: String(utxo.utxoEntry.amount),
      scriptPublicKey: normalizeRestScript(utxo.utxoEntry.scriptPublicKey.scriptPublicKey),
      finality: "accepted",
    }));
  }

  async #json<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (response.status === 404) throw new RestNotFoundError(path);
      if (!response.ok) throw new Error(`Kaspa REST request failed: ${response.status}`);
      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}

class RestNotFoundError extends Error {}

type RestBlockdag = {
  networkName: string;
  virtualDaaScore: string | number;
};

type RestUtxo = {
  outpoint: {
    transactionId: string;
    index: number;
  };
  utxoEntry: {
    amount: string;
    scriptPublicKey: {
      scriptPublicKey: string;
    };
  };
};

function assertTestnet(network: NetworkId): void {
  if (network !== "kaspa:testnet-10") {
    throw new KaspaX402Error("invalid_kaspa_x402_network", "hosted gateway only supports kaspa:testnet-10");
  }
}

function normalizeRestScript(script: string): string {
  const lower = script.toLowerCase();
  return lower.startsWith("0000") ? lower : `0000${lower}`;
}

function sameOutpoint(left: FundingOutpoint, right: FundingOutpoint): boolean {
  return left.txid.toLowerCase() === right.txid.toLowerCase() && left.index === right.index;
}
