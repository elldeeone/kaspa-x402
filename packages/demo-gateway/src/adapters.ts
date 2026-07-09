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
  payToScriptHashScript,
  serializedScriptPublicKey,
  type DeriveEscrowAddressInput,
} from "@kaspa-x402/covenant";
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

export class RestExactTransactionVerifier implements ExactTransactionVerifier {
  readonly #client: KaspaRestClient;

  constructor(client: KaspaRestClient) {
    this.#client = client;
  }

  async verifyExactPayment(request: ExactTransactionVerificationRequest): Promise<ExactTransactionVerification> {
    assertTestnet(request.network);
    void this.#client;
    if (request.transactionEncoding !== KIP10_EXACT_TRANSACTION_ENCODING) {
      throw invalidTransaction("unsupported exact transaction encoding");
    }
    if (!request.reservation) {
      throw invalidTransaction("hosted exact verification requires KIP-10 reservation terms");
    }
    const transaction = parseSafeTransactionArtifact(request.transaction);
    const paymentOutput = transaction.outputs[request.paymentOutputIndex];
    if (!paymentOutput) throw invalidTransaction("exact transaction is missing payment output");
    if (paymentOutput.scriptPublicKey !== request.payToScriptPublicKey.toLowerCase()) {
      throw invalidTransaction("exact transaction payment output script does not match payTo");
    }
    if (paymentOutput.value !== request.amount) {
      throw invalidTransaction("exact transaction payment output amount does not match accepted amount");
    }

    const reservation = request.reservation;
    const borrowInputIndex = transaction.inputs.findIndex(
      (input) => input.transactionId === reservation.borrowOutpoint.txid.toLowerCase() && input.index === reservation.borrowOutpoint.index,
    );
    if (borrowInputIndex < 0) throw invalidTransaction("exact transaction does not spend the reserved borrow outpoint");
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
    const continuation = transaction.outputs[borrowInputIndex];
    if (!continuation) throw invalidTransaction("exact transaction is missing KIP-10 continuation output");
    if (continuation.scriptPublicKey !== reservation.borrowScriptPublicKey.toLowerCase()) {
      throw invalidTransaction("exact transaction KIP-10 continuation script does not match reservation");
    }
    if (BigInt(continuation.value) < BigInt(reservation.borrowAmount) + BigInt(reservation.additiveThresholdSompi)) {
      throw invalidTransaction("exact transaction KIP-10 continuation amount is below the additive threshold");
    }

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
      ...(finality ? { finality } : {}),
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
  is_accepted?: boolean;
  inputs?: RestTransactionInput[];
  outputs?: RestTransactionOutput[];
};

type RestTransactionInput = {
  previous_outpoint_hash?: string;
  previous_outpoint_index?: string | number;
  signature_script?: string;
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

function parseSafeTransactionArtifact(transaction: PreparedTransaction): SafeTransaction {
  let parsed: unknown;
  try {
    parsed = JSON.parse(transaction);
  } catch {
    throw invalidTransaction("exact transaction artifact is not valid safe JSON");
  }
  if (!isRecord(parsed)) throw invalidTransaction("exact transaction artifact must be a JSON object");
  const inputs = arrayValue(parsed.inputs, "inputs").map((input, index) => parseSafeInput(input, index));
  const outputs = arrayValue(parsed.outputs, "outputs").map((output, index) => parseSafeOutput(output, index));
  if (inputs.length === 0) throw invalidTransaction("exact transaction artifact must have inputs");
  if (outputs.length === 0) throw invalidTransaction("exact transaction artifact must have outputs");
  return {
    id: hashValue(parsed.id, "transaction id"),
    version: uint32Value(parsed.version, "transaction version"),
    inputs,
    outputs,
    ...(parsed.lockTime !== undefined ? { lockTime: uintStringValue(parsed.lockTime, "lockTime") } : {}),
    ...(typeof parsed.subnetworkId === "string" ? { subnetworkId: hexValue(parsed.subnetworkId, "subnetworkId") } : {}),
    ...(parsed.gas !== undefined ? { gas: uintStringValue(parsed.gas, "gas") } : {}),
    ...(typeof parsed.payload === "string" ? { payload: hexValue(parsed.payload, "payload") } : {}),
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
  return {
    value: uintStringValue(value.value, `transaction output ${position} value`),
    scriptPublicKey: serializedScriptValue(value.scriptPublicKey, `transaction output ${position} scriptPublicKey`),
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
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) throw invalidTransaction(`${label} must be an unsigned integer`);
  return value;
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
  return /\b(already|duplicate|known|mempool)\b/i.test(message);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
