import { KaspaX402Error, type FundingOutpoint, type NetworkId, type SompiString } from "@kaspa-x402/core";
import type {
  AddressCodec,
  ChainUtxo,
  PreparedTransaction,
  ExactTransactionVerification,
  ExactTransactionVerificationRequest,
  ExactTransactionVerifier,
  ServerChainProvider,
  TransactionBroadcast,
  VoucherVerificationRequest,
  VoucherVerifier,
} from "@kaspa-x402/server";
import {
  KIP10_EXACT_TRANSACTION_ENCODING,
  buildKip10AdditiveBorrowSignatureScript,
  calculateKaspaStorageMass,
  exactV0SchnorrSignatureEvidence,
  exactV0TransactionId,
  parseKip10AdditiveRedeemScript,
  payToScriptHashScript,
  serializedScriptPublicKey,
  type DeriveEscrowAddressInput,
  type ExactV0ReferenceTransaction,
} from "@kaspa-x402/covenant";
import { addressForScriptPublicKey, encodeScriptAddress, scriptPublicKeyForAddress, verifyKaspaSchnorrDigest } from "./kaspa-native.js";

type FetchLike = typeof fetch;
type SleepLike = (ms: number) => Promise<void>;

const NATIVE_SUBNETWORK_ID = "00".repeat(20);
const MAX_SAFE_TRANSACTION_ARTIFACT_CHARS = 128 * 1024;
const MAX_SAFE_TRANSACTION_INPUTS = 64;
const MAX_SAFE_TRANSACTION_OUTPUTS = 64;
const MAX_SAFE_TRANSACTION_FEE_SOMPI = 100_000_000n;
const U64_MAX = 0xffff_ffff_ffff_ffffn;

type PnnRpc = {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getServerInfo(): Promise<{ networkId?: unknown; isSynced?: unknown; virtualDaaScore?: unknown }>;
  submitTransaction(request: { transaction: unknown; allowOrphan: boolean }): Promise<{ transactionId?: unknown }>;
  getUtxosByAddresses(addresses: string[]): Promise<{ entries?: unknown[] }>;
};

type PnnRpcFactory = (endpoint: string, timeoutMs: number) => PnnRpc;

type KaspaPnnClientOptions = {
  endpoints: string[];
  timeoutMs?: number;
  attempts?: number;
  rpcFactory?: PnnRpcFactory;
  sleep?: SleepLike;
};

export class ScriptAddressBook {
  readonly #scriptToAddress = new Map<string, string>();

  record(scriptPublicKey: string, address: string): void {
    this.#scriptToAddress.set(scriptPublicKey.toLowerCase(), address);
  }

  addresses(): string[] {
    return Array.from(new Set(this.#scriptToAddress.values()));
  }

  addressForScriptPublicKey(scriptPublicKey: string): string | undefined {
    return this.#scriptToAddress.get(scriptPublicKey.toLowerCase());
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

  async sendTransaction(transaction: PreparedTransaction): Promise<TransactionBroadcast> {
    const parsed = parseSafeTransactionArtifact(transaction);
    const accepted = await this.#client.getTransaction(parsed.id);
    if (accepted?.is_accepted) {
      assertChainTransactionMatchesSafe(accepted, parsed);
      return { transactionId: parsed.id, finality: "accepted" };
    }

    let transactionId: string;
    try {
      transactionId = await this.#client.submitTransaction(transaction);
    } catch (error) {
      if (!isDuplicateTransactionError(error)) throw error;
      transactionId = parsed.id;
    }
    if (transactionId.toLowerCase() !== parsed.id) {
      throw new KaspaX402Error("invalid_kaspa_transaction", "Kaspa REST returned a transaction id that does not match the exact artifact");
    }
    await this.#client.waitForTransactionAccepted(parsed);
    return { transactionId: parsed.id, finality: "accepted" };
  }
}

export class PnnBroadcastChainProvider implements ServerChainProvider {
  readonly #reads: RestKaspaChainProvider;
  readonly #book: ScriptAddressBook;
  readonly #pnn: KaspaPnnClient;

  constructor(reads: RestKaspaChainProvider, book: ScriptAddressBook, pnn: KaspaPnnClient) {
    this.#reads = reads;
    this.#book = book;
    this.#pnn = pnn;
  }

  getUtxo(outpoint: FundingOutpoint, network: NetworkId): Promise<ChainUtxo | null> {
    return this.#reads.getUtxo(outpoint, network);
  }

  getVirtualDaaScore(): Promise<SompiString> {
    return this.#reads.getVirtualDaaScore();
  }

  estimateClaimFee(): Promise<SompiString> {
    return this.#reads.estimateClaimFee();
  }

  sendTransaction(transaction: PreparedTransaction): Promise<TransactionBroadcast> {
    return this.#pnn.submitTransaction(transaction, this.#book);
  }
}

export class KaspaPnnClient {
  readonly #endpoints: string[];
  readonly #timeoutMs: number;
  readonly #attempts: number;
  readonly #rpcFactory: PnnRpcFactory;
  readonly #sleep: SleepLike;

  constructor(options: KaspaPnnClientOptions) {
    this.#endpoints = options.endpoints;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#attempts = options.attempts ?? 2;
    this.#rpcFactory = options.rpcFactory ?? ((endpoint, timeoutMs) => new JsonPnnRpc(endpoint, timeoutMs));
    this.#sleep = options.sleep ?? sleep;
  }

  async health(): Promise<{ ok: true; networkId: string; endpoint: string; virtualDaaScore?: string }> {
    return this.#withRpc(async ({ rpc, endpoint }) => {
      const info = await this.#checkedServerInfo(rpc, endpoint);
      return {
        ok: true,
        networkId: "testnet-10",
        endpoint,
        ...(info.virtualDaaScore !== undefined ? { virtualDaaScore: String(info.virtualDaaScore) } : {}),
      };
    });
  }

  async submitTransaction(transaction: PreparedTransaction, book: ScriptAddressBook): Promise<TransactionBroadcast> {
    const safe = parseSafeTransactionArtifact(transaction);
    const evidence = pnnPaymentEvidence(safe, book);
    return this.#withRpc(async ({ rpc, endpoint }) => {
      await this.#checkedServerInfo(rpc, endpoint);
      const parsed = pnnTransactionFromSafe(safe);
      let transactionId = safe.id;
      try {
        const result = await withTimeout(rpc.submitTransaction({ transaction: parsed, allowOrphan: false }), this.#timeoutMs, "pnn submitTransaction");
        if (typeof result.transactionId !== "string" || !/^[0-9a-fA-F]{64}$/.test(result.transactionId)) {
          throw invalidTransaction("Kaspa PNN did not return a transaction id");
        }
        transactionId = result.transactionId.toLowerCase();
      } catch (error) {
        if (!isDuplicateTransactionError(error)) throw error;
      }
      if (transactionId !== safe.id) {
        throw invalidTransaction("Kaspa PNN returned a transaction id that does not match the exact artifact");
      }
      await this.#waitForAcceptedPayment(rpc, safe.id, evidence);
      return { transactionId: safe.id, finality: "accepted" };
    });
  }

  async #withRpc<T>(fn: (input: { rpc: PnnRpc; endpoint: string }) => Promise<T>): Promise<T> {
    if (this.#endpoints.length === 0) throw invalidTransaction("Kaspa PNN endpoints are not configured");
    const errors: string[] = [];
    for (const endpoint of this.#endpoints) {
      const rpc = this.#rpcFactory(endpoint, this.#timeoutMs);
      try {
        await withTimeout(rpc.connect(), this.#timeoutMs, `pnn connect ${endpoint}`);
        return await fn({ rpc, endpoint });
      } catch (error) {
        errors.push(`${endpoint}: ${errorMessage(error)}`);
      } finally {
        await rpc.disconnect().catch(() => undefined);
      }
    }
    throw invalidTransaction(`Kaspa PNN request failed: ${errors.join(" | ")}`);
  }

  async #checkedServerInfo(rpc: PnnRpc, endpoint: string): Promise<{ virtualDaaScore?: unknown }> {
    const info = await withTimeout(rpc.getServerInfo(), this.#timeoutMs, `pnn getServerInfo ${endpoint}`);
    if (info.networkId !== "testnet-10") throw invalidTransaction(`Kaspa PNN endpoint returned network ${String(info.networkId)}`);
    if (info.isSynced === false) throw invalidTransaction("Kaspa PNN endpoint is not synced");
    return info;
  }

  async #waitForAcceptedPayment(rpc: PnnRpc, txid: string, evidence: PnnPaymentEvidence): Promise<void> {
    let last = "not checked";
    for (let attempt = 0; attempt < this.#attempts; attempt += 1) {
      const match = await this.#findAcceptedPayment(rpc, txid, evidence);
      if (match) return;
      last = `attempt ${attempt + 1} found no matching payment output`;
      await this.#sleep(Math.min(1_000 * (attempt + 1), this.#timeoutMs));
    }
    const deadline = Date.now() + this.#timeoutMs;
    while (Date.now() <= deadline) {
      const match = await this.#findAcceptedPayment(rpc, txid, evidence);
      if (match) return;
      last = "payment output not accepted yet";
      await this.#sleep(1_000);
    }
    throw invalidTransaction(`exact transaction did not reach accepted finality through PNN: ${last}`);
  }

  async #findAcceptedPayment(rpc: PnnRpc, txid: string, evidence: PnnPaymentEvidence): Promise<boolean> {
    const result = await withTimeout(rpc.getUtxosByAddresses([evidence.address]), this.#timeoutMs, "pnn getUtxosByAddresses");
    const entries = Array.isArray(result.entries) ? result.entries : [];
    return entries.some((entry) => {
      const utxo = pnnUtxo(entry);
      return (
        utxo.outpoint.txid === txid &&
        utxo.outpoint.index === evidence.outputIndex &&
        utxo.amount === evidence.amount &&
        utxo.scriptPublicKey === evidence.scriptPublicKey
      );
    });
  }
}

class JsonPnnRpc implements PnnRpc {
  readonly #endpoint: string;
  readonly #timeoutMs: number;
  #ws: WebSocket | undefined;
  #nextId = 1;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timeoutId: ReturnType<typeof setTimeout> }>();

  constructor(endpoint: string, timeoutMs: number) {
    this.#endpoint = endpoint;
    this.#timeoutMs = timeoutMs;
  }

  connect(): Promise<void> {
    if (this.#ws && this.#ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.#endpoint);
      this.#ws = ws;
      let settled = false;
      const cleanup = () => {
        ws.removeEventListener("open", handleOpen);
        ws.removeEventListener("error", handleError);
        ws.removeEventListener("close", handleClose);
      };
      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          ws.close();
        } catch {
          // Ignore close failures while failing the connection attempt.
        }
        reject(new Error(`pnn websocket connect timed out after ${this.#timeoutMs}ms`));
      }, this.#timeoutMs);
      const handleOpen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        cleanup();
        ws.addEventListener("message", (event) => this.#handleMessage(event));
        ws.addEventListener("close", () => this.#rejectPending("pnn websocket closed"));
        ws.addEventListener("error", () => this.#rejectPending("pnn websocket error"));
        resolve();
      };
      const handleError = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        cleanup();
        reject(new Error("pnn websocket error"));
      };
      const handleClose = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        cleanup();
        reject(new Error("pnn websocket closed before connect"));
      };
      ws.addEventListener("open", handleOpen);
      ws.addEventListener("error", handleError);
      ws.addEventListener("close", handleClose);
    });
  }

  disconnect(): Promise<void> {
    this.#rejectPending("pnn websocket disconnected");
    if (this.#ws && this.#ws.readyState !== WebSocket.CLOSED && this.#ws.readyState !== WebSocket.CLOSING) {
      this.#ws.close();
    }
    this.#ws = undefined;
    return Promise.resolve();
  }

  getServerInfo(): Promise<{ networkId?: unknown; isSynced?: unknown; virtualDaaScore?: unknown }> {
    return this.#request("getServerInfo", {});
  }

  submitTransaction(request: { transaction: unknown; allowOrphan: boolean }): Promise<{ transactionId?: unknown }> {
    return this.#request("submitTransaction", request);
  }

  getUtxosByAddresses(addresses: string[]): Promise<{ entries?: unknown[] }> {
    return this.#request("getUtxosByAddresses", { addresses });
  }

  #request<T>(method: string, params: unknown): Promise<T> {
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("pnn websocket is not connected"));
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`pnn ${method} timed out after ${this.#timeoutMs}ms`));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeoutId });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  #handleMessage(event: MessageEvent): void {
    if (typeof event.data !== "string") {
      this.#rejectPending("pnn websocket returned a non-text message");
      return;
    }
    const message = parseJson(event.data);
    if (!isRecord(message)) {
      this.#rejectPending("pnn websocket returned malformed JSON");
      return;
    }
    const id = typeof message.id === "number" ? message.id : undefined;
    if (id === undefined) return;
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timeoutId);
    if (message.error !== undefined) {
      pending.reject(new Error(pnnErrorMessage(message.error)));
      return;
    }
    pending.resolve(message.params);
  }

  #rejectPending(message: string): void {
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      clearTimeout(pending.timeoutId);
      pending.reject(new Error(message));
    }
  }
}

export class RestExactTransactionVerifier implements ExactTransactionVerifier {
  readonly #client: KaspaRestClient;
  readonly #maxFeeSompi: bigint;

  constructor(client: KaspaRestClient, options: { maxFeeSompi?: bigint | string } = {}) {
    this.#client = client;
    this.#maxFeeSompi = BigInt(options.maxFeeSompi ?? MAX_SAFE_TRANSACTION_FEE_SOMPI);
    if (this.#maxFeeSompi < 0n || this.#maxFeeSompi > U64_MAX) {
      throw new Error("maxFeeSompi must fit in uint64");
    }
  }

  async verifyExactPayment(request: ExactTransactionVerificationRequest): Promise<ExactTransactionVerification> {
    assertTestnet(request.network);
    if (request.transactionEncoding !== KIP10_EXACT_TRANSACTION_ENCODING) {
      throw invalidTransaction("unsupported exact transaction encoding");
    }
    if (request.profile === "standard-native") {
      return this.#verifyStandardNative(request);
    }
    if (!request.reservation) {
      throw invalidTransaction("hosted exact verification requires KIP-10 reservation terms");
    }
    const transaction = parseSafeTransactionArtifact(request.transaction);
    assertExactTransactionEnvelope(transaction, this.#maxFeeSompi);
    const paymentOutput = transaction.outputs[request.paymentOutputIndex];
    if (!paymentOutput) throw invalidTransaction("exact transaction is missing payment output");
    if (paymentOutput.scriptPublicKey !== request.payToScriptPublicKey.toLowerCase()) {
      throw invalidTransaction("exact transaction payment output script does not match payTo");
    }
    if (paymentOutput.value !== request.amount) {
      throw invalidTransaction("exact transaction payment output amount does not match accepted amount");
    }

    const reservation = request.reservation;
    const template = parseKip10AdditiveRedeemScript(reservation.borrowRedeemScript);
    if (template.amount !== reservation.additiveThresholdSompi) {
      throw invalidTransaction("exact transaction KIP-10 script threshold does not match reservation");
    }
    const borrowInputIndex = transaction.inputs.findIndex(
      (input) => input.transactionId === reservation.borrowOutpoint.txid.toLowerCase() && input.index === reservation.borrowOutpoint.index,
    );
    if (borrowInputIndex < 0) throw invalidTransaction("exact transaction does not spend the reserved borrow outpoint");
    if (borrowInputIndex === request.paymentOutputIndex) {
      throw invalidTransaction("exact transaction payment output cannot replace the KIP-10 continuation output");
    }
    const advertisedBorrowScript = serializedScriptPublicKey(payToScriptHashScript(reservation.borrowRedeemScript)).toLowerCase();
    if (advertisedBorrowScript !== reservation.borrowScriptPublicKey.toLowerCase()) {
      throw invalidTransaction("exact transaction borrow redeem script does not match reservation script public key");
    }
    const borrowInput = transaction.inputs[borrowInputIndex];
    if (borrowInput.utxo?.scriptPublicKey !== reservation.borrowScriptPublicKey.toLowerCase()) {
      throw invalidTransaction("exact transaction borrow input script does not match reservation");
    }
    if (borrowInput.utxo.amount !== reservation.borrowAmount) {
      throw invalidTransaction("exact transaction borrow input amount does not match reservation");
    }
    if (borrowInput.signatureScript !== buildKip10AdditiveBorrowSignatureScript(reservation.borrowRedeemScript)) {
      throw invalidTransaction("exact transaction borrow input does not select the canonical KIP-10 borrower branch");
    }
    const continuation = transaction.outputs[borrowInputIndex];
    if (!continuation) throw invalidTransaction("exact transaction is missing KIP-10 continuation output");
    if (continuation.scriptPublicKey !== reservation.borrowScriptPublicKey.toLowerCase()) {
      throw invalidTransaction("exact transaction KIP-10 continuation script does not match reservation");
    }
    if (BigInt(continuation.value) < BigInt(reservation.borrowAmount) + BigInt(reservation.additiveThresholdSompi)) {
      throw invalidTransaction("exact transaction KIP-10 continuation amount is below the additive threshold");
    }
    const duplicatePayment = transaction.outputs.some(
      (output, index) =>
        index !== request.paymentOutputIndex && output.scriptPublicKey === paymentOutput.scriptPublicKey && output.value === paymentOutput.value,
    );
    if (duplicatePayment) throw invalidTransaction("exact transaction contains an ambiguous duplicate payment output");

    const accepted = await this.#client.getTransaction(transaction.id);
    const finality = accepted?.is_accepted ? "accepted" : undefined;
    if (accepted?.is_accepted) assertChainTransactionMatchesSafe(accepted, transaction);

    return {
      transactionId: transaction.id,
      paymentOutput: {
        amount: paymentOutput.value,
        scriptPublicKey: paymentOutput.scriptPublicKey,
        address: request.payTo,
      },
      continuation: {
        outpoint: { txid: transaction.id, index: borrowInputIndex },
        amount: continuation.value,
        scriptPublicKey: continuation.scriptPublicKey,
      },
      ...(finality ? { finality } : {}),
    };
  }

  async #verifyStandardNative(request: ExactTransactionVerificationRequest): Promise<ExactTransactionVerification> {
    if (request.reservation) throw invalidTransaction("standard-native exact cannot include additive reservation terms");
    const transaction = parseSafeTransactionArtifact(request.transaction);
    assertStandardNativeTransactionEnvelope(transaction, this.#maxFeeSompi);
    const reference = exactV0ReferenceTransaction(transaction);
    const transactionId = exactV0TransactionId(reference);
    if (transaction.id !== transactionId) throw invalidTransaction("standard-native transaction id does not match canonical fields");

    const merchantOutputs = transaction.outputs
      .map((output, index) => ({ output, index }))
      .filter(({ output }) => output.scriptPublicKey === request.payToScriptPublicKey.toLowerCase());
    if (merchantOutputs.length !== 1) throw invalidTransaction("standard-native transaction must contain exactly one merchant output");
    const merchant = merchantOutputs[0]!;
    if (merchant.index !== request.paymentOutputIndex) throw invalidTransaction("standard-native payment output index is not canonical");
    if (merchant.output.value !== request.amount) throw invalidTransaction("standard-native merchant output must equal the accepted amount");

    const accepted = await this.#client.getTransaction(transaction.id);
    const finality = accepted?.is_accepted ? "accepted" : undefined;
    if (accepted?.is_accepted) assertChainTransactionMatchesSafe(accepted, transaction);

    const payerScripts = new Set<string>();
    for (let index = 0; index < transaction.inputs.length; index += 1) {
      const input = transaction.inputs[index]!;
      const previous = await this.#trustedInput(input, request.network, finality === "accepted");
      if (previous.amount !== input.utxo.amount || previous.scriptPublicKey !== input.utxo.scriptPublicKey) {
        throw invalidTransaction("standard-native embedded UTXO evidence does not match trusted chain state");
      }
      const evidence = exactV0SchnorrSignatureEvidence(reference, index);
      if (!verifyKaspaSchnorrDigest(evidence)) throw invalidTransaction("standard-native funding signature is invalid");
      payerScripts.add(previous.scriptPublicKey);
    }

    const changeOutputs = transaction.outputs.filter((_, index) => index !== merchant.index);
    if (changeOutputs.length > 1) throw invalidTransaction("standard-native transaction may contain at most one payer change output");
    if (changeOutputs[0] && !payerScripts.has(changeOutputs[0].scriptPublicKey)) {
      throw invalidTransaction("standard-native change output is not controlled by a verified payer input");
    }

    return {
      transactionId,
      paymentOutput: {
        amount: merchant.output.value,
        scriptPublicKey: merchant.output.scriptPublicKey,
        address: request.payTo,
      },
      ...(finality ? { finality } : {}),
    };
  }

  async #trustedInput(
    input: SafeTransactionInput,
    network: NetworkId,
    acceptedCandidateSpendsInput: boolean,
  ): Promise<{ amount: string; scriptPublicKey: string }> {
    const previous = await this.#client.getTransaction(input.transactionId);
    if (!previous?.is_accepted || !Array.isArray(previous.outputs)) {
      throw invalidTransaction("standard-native input origin is not accepted chain state");
    }
    const output = previous.outputs.find((candidate) => candidate.index === input.index) ?? previous.outputs[input.index];
    if (!output || output.amount === undefined || typeof output.script_public_key !== "string") {
      throw invalidTransaction("standard-native input origin output is missing");
    }
    const trusted = {
      amount: String(output.amount),
      scriptPublicKey: normalizeRestScript(output.script_public_key),
    };
    if (acceptedCandidateSpendsInput) return trusted;
    const address = addressForScriptPublicKey(trusted.scriptPublicKey, network);
    const unspent = (await this.#client.getUtxosForAddress(address)).some(
      (utxo) => sameOutpoint(utxo.outpoint, { txid: input.transactionId, index: input.index }) &&
        utxo.amount === trusted.amount &&
        utxo.scriptPublicKey === trusted.scriptPublicKey,
    );
    if (!unspent) throw invalidTransaction("standard-native input is not currently unspent");
    return trusted;
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
  readonly #acceptanceTimeoutMs: number;
  readonly #acceptancePollMs: number;

  constructor(baseUrl: string, options: { fetch?: FetchLike; timeoutMs?: number; acceptanceTimeoutMs?: number; acceptancePollMs?: number } = {}) {
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#timeoutMs = options.timeoutMs ?? 8_000;
    this.#acceptanceTimeoutMs = options.acceptanceTimeoutMs ?? 60_000;
    this.#acceptancePollMs = options.acceptancePollMs ?? 1_000;
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

  async submitTransaction(transaction: PreparedTransaction): Promise<string> {
    const parsed = parseSafeTransactionArtifact(transaction);
    const result = await this.#json<RestSubmitTransactionResponse>("/transactions", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        transaction: restSubmitTransactionFromSafe(parsed),
        allowOrphan: false,
      }),
    });
    if (typeof result.error === "string" && result.error) throw invalidTransaction(`Kaspa REST rejected transaction: ${result.error}`);
    if (typeof result.transactionId !== "string" || !/^[0-9a-fA-F]{64}$/.test(result.transactionId)) {
      throw invalidTransaction("Kaspa REST did not return a transaction id");
    }
    return result.transactionId.toLowerCase();
  }

  async getTransaction(transactionId: string): Promise<RestTransaction | null> {
    try {
      return await this.#json<RestTransaction>(
        `/transactions/${encodeURIComponent(transactionId.toLowerCase())}?inputs=true&outputs=true&resolve_previous_outpoints=no`,
      );
    } catch (error) {
      if (error instanceof RestNotFoundError) return null;
      throw error;
    }
  }

  async waitForTransactionAccepted(transaction: SafeTransaction): Promise<void> {
    const deadline = Date.now() + this.#acceptanceTimeoutMs;
    let last = "not checked";
    while (Date.now() <= deadline) {
      const accepted = await this.getTransaction(transaction.id);
      if (accepted?.is_accepted) {
        assertChainTransactionMatchesSafe(accepted, transaction);
        return;
      }
      const acceptance = await this.#transactionAccepted(transaction.id);
      if (acceptance) last = "acceptance endpoint returned true before transaction details were indexed";
      else last = "transaction not accepted yet";
      await sleep(this.#acceptancePollMs);
    }
    throw invalidTransaction(`exact transaction did not reach accepted finality: ${last}`);
  }

  async #transactionAccepted(transactionId: string): Promise<boolean> {
    const result = await this.#json<RestTxAcceptanceResponse[]>("/transactions/acceptance", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ transactionIds: [transactionId.toLowerCase()] }),
    });
    return result.some((entry) => entry.transactionId?.toLowerCase() === transactionId.toLowerCase() && entry.accepted === true);
  }

  async #json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        ...init,
        headers: { accept: "application/json" },
        ...("headers" in init ? { headers: { accept: "application/json", ...init.headers } } : {}),
        signal: controller.signal,
      });
      if (response.status === 404) throw new RestNotFoundError(path);
      const text = await response.text();
      const body = parseJson(text);
      if (!response.ok) {
        const detail = isRecord(body) && typeof body.error === "string" ? `: ${body.error}` : "";
        throw invalidTransaction(`Kaspa REST request failed: ${response.status}${detail}`);
      }
      return body as T;
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

type RestSubmitTransactionResponse = {
  transactionId?: string;
  error?: string;
};

type RestTxAcceptanceResponse = {
  transactionId?: string;
  accepted: boolean;
};

type RestTransaction = {
  transaction_id?: string;
  version?: number;
  lock_time?: string | number | null;
  subnetwork_id?: string | null;
  gas?: string | number | null;
  payload?: string | null;
  is_accepted?: boolean;
  inputs?: RestTransactionInput[];
  outputs?: RestTransactionOutput[];
};

type RestTransactionInput = {
  previous_outpoint_hash?: string;
  previous_outpoint_index?: string | number;
  signature_script?: string;
  sequence?: string | number | null;
  sig_op_count?: string | number;
  compute_budget?: number;
};

type RestTransactionOutput = {
  index?: number;
  amount?: string | number;
  script_public_key?: string;
};

type SafeTransaction = {
  id: string;
  version: number;
  inputs: SafeTransactionInput[];
  outputs: SafeTransactionOutput[];
  lockTime?: string;
  subnetworkId?: string;
  gas?: string;
  payload?: string;
  storageMass?: string;
};

type SafeTransactionInput = {
  transactionId: string;
  index: number;
  sequence: string;
  sigOpCount: number;
  computeBudget?: number;
  signatureScript: string;
  utxo: {
    amount: string;
    scriptPublicKey: string;
  };
};

type SafeTransactionOutput = {
  value: string;
  scriptPublicKey: string;
  covenant: null;
};

type PnnPaymentEvidence = {
  address: string;
  outputIndex: number;
  amount: string;
  scriptPublicKey: string;
};

type PnnUtxo = {
  outpoint: FundingOutpoint;
  amount: string;
  scriptPublicKey: string;
};

function pnnPaymentEvidence(transaction: SafeTransaction, book: ScriptAddressBook): PnnPaymentEvidence {
  for (let outputIndex = 0; outputIndex < transaction.outputs.length; outputIndex += 1) {
    const output = transaction.outputs[outputIndex];
    const address = book.addressForScriptPublicKey(output.scriptPublicKey);
    if (address) {
      return {
        address,
        outputIndex,
        amount: output.value,
        scriptPublicKey: output.scriptPublicKey,
      };
    }
  }
  throw invalidTransaction("exact transaction artifact does not pay a known gateway address");
}

function pnnUtxo(entry: unknown): PnnUtxo {
  if (!isRecord(entry)) throw invalidTransaction("Kaspa PNN UTXO entry is not an object");
  const raw = isRecord(entry.entry) ? entry.entry : entry;
  const utxoEntry = isRecord(raw.utxoEntry) ? raw.utxoEntry : isRecord(raw.utxo) ? raw.utxo : raw;
  const outpoint = isRecord(raw.outpoint) ? raw.outpoint : isRecord(entry.outpoint) ? entry.outpoint : undefined;
  if (!outpoint) throw invalidTransaction("Kaspa PNN UTXO entry is missing outpoint");
  return {
    outpoint: {
      txid: hashValue(outpoint.transactionId, "Kaspa PNN UTXO transactionId"),
      index: uint32Value(outpoint.index, "Kaspa PNN UTXO index"),
    },
    amount: uintStringValue(utxoEntry.amount ?? raw.amount ?? entry.amount, "Kaspa PNN UTXO amount"),
    scriptPublicKey: serializeSdkScriptPublicKey(utxoEntry.scriptPublicKey ?? raw.scriptPublicKey ?? entry.scriptPublicKey),
  };
}

function serializeSdkScriptPublicKey(value: unknown): string {
  if (typeof value === "string") return serializedScriptValue(value, "Kaspa PNN UTXO scriptPublicKey");
  if (!isRecord(value)) throw invalidTransaction("Kaspa PNN UTXO scriptPublicKey is not an object");
  const script = hexValue(value.script, "Kaspa PNN UTXO script");
  const version = uint32Value(value.version ?? 0, "Kaspa PNN UTXO script version");
  if (version > 0xffff) throw invalidTransaction("Kaspa PNN UTXO script version exceeds uint16");
  return `${((version >>> 8) & 0xff).toString(16).padStart(2, "0")}${(version & 0xff).toString(16).padStart(2, "0")}${script}`.toLowerCase();
}

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

function parseSafeTransactionArtifact(transaction: PreparedTransaction): SafeTransaction {
  if (transaction.length > MAX_SAFE_TRANSACTION_ARTIFACT_CHARS) {
    throw invalidTransaction("exact transaction artifact exceeds the 128 KiB limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(transaction);
  } catch {
    throw invalidTransaction("exact transaction artifact is not valid safe JSON");
  }
  if (!isRecord(parsed)) throw invalidTransaction("exact transaction artifact must be a JSON object");
  const inputValues = arrayValue(parsed.inputs, "inputs");
  const outputValues = arrayValue(parsed.outputs, "outputs");
  if (inputValues.length > MAX_SAFE_TRANSACTION_INPUTS) throw invalidTransaction("exact transaction has too many inputs");
  if (outputValues.length > MAX_SAFE_TRANSACTION_OUTPUTS) throw invalidTransaction("exact transaction has too many outputs");
  const inputs = inputValues.map((input, index) => parseSafeInput(input, index));
  const outputs = outputValues.map((output, index) => parseSafeOutput(output, index));
  if (inputs.length === 0) throw invalidTransaction("exact transaction artifact must have inputs");
  if (outputs.length === 0) throw invalidTransaction("exact transaction artifact must have outputs");
  return {
    id: hashValue(parsed.id, "transaction id"),
    version: uint32Value(parsed.version, "transaction version"),
    inputs,
    outputs,
    ...(parsed.lockTime !== undefined ? { lockTime: uintStringValue(parsed.lockTime, "lockTime") } : {}),
    ...(parsed.subnetworkId !== undefined ? { subnetworkId: hexValue(parsed.subnetworkId, "subnetworkId") } : {}),
    ...(parsed.gas !== undefined ? { gas: uintStringValue(parsed.gas, "gas") } : {}),
    ...(parsed.payload !== undefined ? { payload: hexValue(parsed.payload, "payload") } : {}),
    ...(parsed.storageMass !== undefined ? { storageMass: uintStringValue(parsed.storageMass, "storageMass") } : {}),
  };
}

function assertExactTransactionEnvelope(transaction: SafeTransaction, maxFeeSompi: bigint): void {
  if (transaction.version !== 1) throw invalidTransaction("KIP-10 exact transaction version must be 1");
  if ((transaction.lockTime ?? "0") !== "0") throw invalidTransaction("KIP-10 exact transaction lockTime must be 0");
  if ((transaction.subnetworkId ?? NATIVE_SUBNETWORK_ID) !== NATIVE_SUBNETWORK_ID) {
    throw invalidTransaction("KIP-10 exact transaction must use the native subnetwork");
  }
  if ((transaction.gas ?? "0") !== "0") throw invalidTransaction("KIP-10 exact transaction gas must be 0");
  if ((transaction.payload ?? "") !== "") throw invalidTransaction("KIP-10 exact transaction payload must be empty");
  if ((transaction.storageMass ?? "0") !== "0") throw invalidTransaction("KIP-10 exact transaction storageMass must be 0");
  for (const [index, input] of transaction.inputs.entries()) {
    if (!input.utxo.scriptPublicKey.startsWith("0000")) {
      throw invalidTransaction(`transaction input ${index} UTXO script public key version must be 0`);
    }
  }
  for (const [index, output] of transaction.outputs.entries()) {
    if (!output.scriptPublicKey.startsWith("0000")) {
      throw invalidTransaction(`transaction output ${index} script public key version must be 0`);
    }
  }

  const inputAmount = transaction.inputs.reduce((total, input) => total + BigInt(input.utxo.amount), 0n);
  const outputAmount = transaction.outputs.reduce((total, output) => total + BigInt(output.value), 0n);
  if (outputAmount > inputAmount) throw invalidTransaction("exact transaction outputs exceed input amounts");
  if (inputAmount - outputAmount > maxFeeSompi) throw invalidTransaction("exact transaction fee exceeds the configured maximum");
}

function assertStandardNativeTransactionEnvelope(transaction: SafeTransaction, maxFeeSompi: bigint): void {
  if (transaction.version !== 0) throw invalidTransaction("standard-native transaction version must be 0");
  if ((transaction.lockTime ?? "0") !== "0") throw invalidTransaction("standard-native transaction lockTime must be 0");
  if ((transaction.subnetworkId ?? NATIVE_SUBNETWORK_ID) !== NATIVE_SUBNETWORK_ID) {
    throw invalidTransaction("standard-native transaction must use the native subnetwork");
  }
  if ((transaction.gas ?? "0") !== "0") throw invalidTransaction("standard-native transaction gas must be 0");
  if ((transaction.payload ?? "") !== "") throw invalidTransaction("standard-native transaction payload must be empty");
  if (transaction.inputs.length === 0) throw invalidTransaction("standard-native transaction must have payer inputs");
  if (transaction.outputs.length < 1 || transaction.outputs.length > 2) {
    throw invalidTransaction("standard-native transaction must contain merchant output and optional change only");
  }
  for (const [index, input] of transaction.inputs.entries()) {
    if (input.computeBudget !== undefined) throw invalidTransaction(`standard-native input ${index} cannot carry a compute budget`);
    if (input.sigOpCount !== 1) throw invalidTransaction(`standard-native input ${index} sigOpCount must be 1`);
    if (!input.utxo.scriptPublicKey.startsWith("0000")) throw invalidTransaction(`standard-native input ${index} script version must be 0`);
  }
  for (const [index, output] of transaction.outputs.entries()) {
    if (!output.scriptPublicKey.startsWith("0000")) throw invalidTransaction(`standard-native output ${index} script version must be 0`);
    if (output.covenant !== null) throw invalidTransaction(`standard-native output ${index} cannot carry a covenant`);
  }
  if (transaction.storageMass === undefined) throw invalidTransaction("standard-native transaction must commit contextual storage mass");
  const storageMass = calculateKaspaStorageMass({
    inputs: transaction.inputs.map((input) => ({
      amount: input.utxo.amount,
      scriptPublicKey: input.utxo.scriptPublicKey,
      hasCovenant: false,
    })),
    outputs: transaction.outputs.map((output) => ({
      amount: output.value,
      scriptPublicKey: output.scriptPublicKey,
      hasCovenant: false,
    })),
  });
  if (BigInt(transaction.storageMass) !== storageMass) {
    throw invalidTransaction("standard-native transaction storage mass does not match contextual KIP-9 mass");
  }
  const inputAmount = transaction.inputs.reduce((total, input) => total + BigInt(input.utxo.amount), 0n);
  const outputAmount = transaction.outputs.reduce((total, output) => total + BigInt(output.value), 0n);
  if (outputAmount > inputAmount) throw invalidTransaction("standard-native outputs exceed input amounts");
  const fee = inputAmount - outputAmount;
  if (fee > maxFeeSompi) throw invalidTransaction("standard-native transaction fee exceeds the configured maximum");
}

function exactV0ReferenceTransaction(transaction: SafeTransaction): ExactV0ReferenceTransaction {
  if (transaction.version !== 0) throw invalidTransaction("standard-native transaction version must be 0");
  return {
    version: 0,
    inputs: transaction.inputs.map((input) => ({
      previousOutpoint: { txid: input.transactionId, index: input.index },
      signatureScript: input.signatureScript,
      sequence: input.sequence,
      sigOpCount: input.sigOpCount,
      utxo: { ...input.utxo },
    })),
    outputs: transaction.outputs.map((output) => ({
      amount: output.value,
      scriptPublicKey: output.scriptPublicKey,
      covenant: output.covenant,
    })),
    lockTime: transaction.lockTime ?? "0",
    subnetworkId: transaction.subnetworkId ?? NATIVE_SUBNETWORK_ID,
    gas: transaction.gas ?? "0",
    payload: transaction.payload ?? "",
    ...(transaction.storageMass !== undefined ? { storageMass: transaction.storageMass } : {}),
  };
}

function parseSafeInput(value: unknown, position: number): SafeTransactionInput {
  if (!isRecord(value)) throw invalidTransaction(`transaction input ${position} must be an object`);
  const previous = isRecord(value.previousOutpoint) ? value.previousOutpoint : value;
  const utxo = isRecord(value.utxo) ? value.utxo : undefined;
  if (!utxo) throw invalidTransaction(`transaction input ${position} is missing UTXO evidence`);
  return {
    transactionId: hashValue(previous.transactionId, `transaction input ${position} outpoint transactionId`),
    index: uint32Value(previous.index, `transaction input ${position} outpoint index`),
    sequence: uintStringValue(value.sequence, `transaction input ${position} sequence`),
    sigOpCount: uint32Value(value.sigOpCount, `transaction input ${position} sigOpCount`),
    ...(value.computeBudget !== undefined ? { computeBudget: uint32Value(value.computeBudget, `transaction input ${position} computeBudget`) } : {}),
    signatureScript: hexValue(value.signatureScript, `transaction input ${position} signatureScript`),
    utxo: {
      amount: uintStringValue(utxo.amount, `transaction input ${position} utxo amount`),
      scriptPublicKey: serializedScriptValue(utxo.scriptPublicKey, `transaction input ${position} utxo scriptPublicKey`),
    },
  };
}

function parseSafeOutput(value: unknown, position: number): SafeTransactionOutput {
  if (!isRecord(value)) throw invalidTransaction(`transaction output ${position} must be an object`);
  if (value.covenant !== undefined && value.covenant !== null) {
    throw invalidTransaction(`transaction output ${position} covenant must be null`);
  }
  return {
    value: uintStringValue(value.value, `transaction output ${position} value`),
    scriptPublicKey: serializedScriptValue(value.scriptPublicKey, `transaction output ${position} scriptPublicKey`),
    covenant: null,
  };
}

function restSubmitTransactionFromSafe(transaction: SafeTransaction): Record<string, unknown> {
  return {
    version: transaction.version,
    inputs: transaction.inputs.map((input) => ({
      previousOutpoint: {
        transactionId: input.transactionId,
        index: input.index,
      },
      signatureScript: input.signatureScript,
      sequence: input.sequence,
      sigOpCount: input.sigOpCount,
      ...(input.computeBudget !== undefined ? { computeBudget: input.computeBudget } : {}),
    })),
    outputs: transaction.outputs.map((output) => ({
      amount: output.value,
      scriptPublicKey: restScriptPublicKey(output.scriptPublicKey),
    })),
    ...(transaction.lockTime !== undefined ? { lockTime: transaction.lockTime } : {}),
    ...(transaction.subnetworkId !== undefined ? { subnetworkId: transaction.subnetworkId } : {}),
    ...(transaction.gas !== undefined ? { gas: transaction.gas } : {}),
    ...(transaction.payload !== undefined ? { payload: transaction.payload } : {}),
  };
}

function pnnTransactionFromSafe(transaction: SafeTransaction): Record<string, unknown> {
  return {
    version: transaction.version,
    inputs: transaction.inputs.map((input) => ({
      previousOutpoint: {
        transactionId: input.transactionId,
        index: input.index,
      },
      signatureScript: input.signatureScript,
      sequence: uintSafeNumber(input.sequence, "transaction input sequence"),
      sigOpCount: input.sigOpCount,
      computeBudget: input.computeBudget ?? 0,
      verboseData: null,
    })),
    outputs: transaction.outputs.map((output) => ({
      value: uintSafeNumber(output.value, "transaction output value"),
      scriptPublicKey: output.scriptPublicKey,
      verboseData: null,
      covenant: null,
    })),
    lockTime: uintSafeNumber(transaction.lockTime ?? "0", "lockTime"),
    subnetworkId: transaction.subnetworkId ?? "00".repeat(20),
    gas: uintSafeNumber(transaction.gas ?? "0", "gas"),
    payload: transaction.payload ?? "",
    storageMass: uintSafeNumber(transaction.storageMass ?? "0", "storageMass"),
    verboseData: null,
  };
}

function restScriptPublicKey(serialized: string): { version: number; scriptPublicKey: string } {
  if (serialized.length < 4) throw invalidTransaction("serialized script public key is too short");
  return {
    version: Number.parseInt(serialized.slice(0, 4), 16),
    scriptPublicKey: serialized.slice(4),
  };
}

function assertChainTransactionMatchesSafe(chain: RestTransaction, safe: SafeTransaction): void {
  if (chain.transaction_id?.toLowerCase() !== safe.id) throw invalidTransaction("accepted transaction id does not match exact artifact");
  if (chain.version !== undefined && chain.version !== safe.version) throw invalidTransaction("accepted transaction version does not match exact artifact");
  if (chain.lock_time != null && String(chain.lock_time) !== (safe.lockTime ?? "0")) {
    throw invalidTransaction("accepted transaction lockTime does not match exact artifact");
  }
  if (chain.subnetwork_id != null && chain.subnetwork_id.toLowerCase() !== (safe.subnetworkId ?? NATIVE_SUBNETWORK_ID)) {
    throw invalidTransaction("accepted transaction subnetwork does not match exact artifact");
  }
  if (chain.gas != null && String(chain.gas) !== (safe.gas ?? "0")) {
    throw invalidTransaction("accepted transaction gas does not match exact artifact");
  }
  if (chain.payload != null && chain.payload.toLowerCase() !== (safe.payload ?? "")) {
    throw invalidTransaction("accepted transaction payload does not match exact artifact");
  }
  if (!Array.isArray(chain.inputs) || chain.inputs.length !== safe.inputs.length) {
    throw invalidTransaction("accepted transaction inputs do not match exact artifact");
  }
  if (!Array.isArray(chain.outputs) || chain.outputs.length !== safe.outputs.length) {
    throw invalidTransaction("accepted transaction outputs do not match exact artifact");
  }
  for (let index = 0; index < safe.inputs.length; index += 1) {
    const expected = safe.inputs[index];
    const actual = chain.inputs[index];
    if (!actual) throw invalidTransaction("accepted transaction input is missing");
    if (actual.previous_outpoint_hash?.toLowerCase() !== expected.transactionId) {
      throw invalidTransaction("accepted transaction input outpoint does not match exact artifact");
    }
    if (Number(actual.previous_outpoint_index) !== expected.index) {
      throw invalidTransaction("accepted transaction input index does not match exact artifact");
    }
    if (typeof actual.signature_script === "string" && actual.signature_script.toLowerCase() !== expected.signatureScript) {
      throw invalidTransaction("accepted transaction signature script does not match exact artifact");
    }
    if (actual.sequence != null && String(actual.sequence) !== expected.sequence) {
      throw invalidTransaction("accepted transaction sequence does not match exact artifact");
    }
    if (actual.sig_op_count !== undefined && Number(actual.sig_op_count) !== expected.sigOpCount) {
      throw invalidTransaction("accepted transaction sigOpCount does not match exact artifact");
    }
    if (expected.computeBudget !== undefined && actual.compute_budget !== undefined && actual.compute_budget !== expected.computeBudget) {
      throw invalidTransaction("accepted transaction computeBudget does not match exact artifact");
    }
  }
  for (let index = 0; index < safe.outputs.length; index += 1) {
    const expected = safe.outputs[index];
    const actual = chain.outputs.find((output) => output.index === index) ?? chain.outputs[index];
    if (!actual) throw invalidTransaction("accepted transaction output is missing");
    if (String(actual.amount) !== expected.value) {
      throw invalidTransaction("accepted transaction output amount does not match exact artifact");
    }
    if (typeof actual.script_public_key === "string" && normalizeRestScript(actual.script_public_key) !== expected.scriptPublicKey) {
      throw invalidTransaction("accepted transaction output script does not match exact artifact");
    }
  }
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw invalidTransaction(`transaction ${label} must be an array`);
  return value;
}

function hashValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value)) throw invalidTransaction(`${label} must be 32-byte hex`);
  return value.toLowerCase();
}

function hexValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(?:[0-9a-fA-F]{2})*$/.test(value)) throw invalidTransaction(`${label} must be byte hex`);
  return value.toLowerCase();
}

function serializedScriptValue(value: unknown, label: string): string {
  const hex = hexValue(value, label);
  if (hex.length < 4) throw invalidTransaction(`${label} must include a uint16 version prefix`);
  return hex;
}

function uint32Value(value: unknown, label: string): number {
  const text = uintStringValue(value, label);
  const bigint = BigInt(text);
  if (bigint > 0xffff_ffffn) throw invalidTransaction(`${label} exceeds uint32`);
  return Number(bigint);
}

function uintStringValue(value: unknown, label: string): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw invalidTransaction(`${label} must be a safe unsigned integer`);
    return String(value);
  }
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,19})$/.test(value)) throw invalidTransaction(`${label} must be an unsigned integer`);
  if (BigInt(value) > U64_MAX) throw invalidTransaction(`${label} exceeds uint64`);
  return value;
}

function uintSafeNumber(value: string, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw invalidTransaction(`${label} exceeds JSON-safe integer range`);
  return number;
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidTransaction(message: string): KaspaX402Error {
  return new KaspaX402Error("invalid_kaspa_transaction", message);
}

function isDuplicateTransactionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(already|duplicate|known|mempool|accepted)\b/i.test(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pnnErrorMessage(error: unknown): string {
  if (!isRecord(error)) return String(error);
  if (typeof error.message === "string") return error.message;
  return JSON.stringify(error);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
