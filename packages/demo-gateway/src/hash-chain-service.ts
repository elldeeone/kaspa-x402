import {
  DirectModeServer,
  handleHashChainGrantClaimHttp,
} from "@kaspa-x402/server";
import type { HashChainGrantIssuer } from "@kaspa-x402/server/hash-chain-issuer";
import { KaspaPnnClient, KaspaRestClient, NativeAddressCodec, RestKaspaChainProvider, ScriptAddressBook } from "./adapters.js";
import type { GatewayConfig } from "./config.js";
import { HASH_CHAIN_CALLER_HEADER } from "./hash-chain-proxy.js";
import { addressForScriptPublicKey } from "./kaspa-native.js";
import { DurableGatewayLockManager, type GatewayStateClient } from "./state.js";
import { openDurableHashChainIssuer, type HashChainStorage } from "./hash-chain-storage.js";
import { HashChainPnnView } from "./hash-chain-pnn-view.js";

export type HashChainHeadRegistration = Parameters<HashChainGrantIssuer["installHead"]>[0];

/** One demo head in the existing Durable Object, using the shared payment ledger. */
export class HashChainDemoService {
  readonly issuer: HashChainGrantIssuer;
  readonly #chain: HashChainPnnView;
  readonly #rest: KaspaRestClient;
  readonly #lock: DurableGatewayLockManager;

  constructor(
    private readonly storage: HashChainStorage,
    private readonly state: GatewayStateClient,
    private readonly config: GatewayConfig,
  ) {
    this.issuer = openDurableHashChainIssuer(storage);
    this.#chain = new HashChainPnnView(new KaspaPnnClient({ endpoints: config.pnnEndpoints,
      timeoutMs: config.pnnTimeoutMs, attempts: config.pnnAttempts }), storage);
    this.#rest = new KaspaRestClient(config.chainApiBase);
    this.#lock = new DurableGatewayLockManager(state);
  }

  current() {
    const row = this.storage.sql.exec<{ head_id: string | null; pay_to: string | null }>(
      "SELECT head_id, pay_to FROM hash_chain_demo WHERE id = 1",
    ).one();
    return row.head_id ? { ...this.issuer.getCurrent(row.head_id), payTo: row.pay_to! } : undefined;
  }

  async register(input: HashChainHeadRegistration) {
    if (input.network !== "kaspa:testnet-10") throw new Error("Use a Testnet-10 head");
    if (!Array.isArray(input.grants) || input.grants.length > 64) throw new Error("Demo head requires 1 to 64 grants");
    const payTo = addressForScriptPublicKey(input.head.scriptPublicKey, "kaspa:testnet-10");
    const actual = await this.#currentUtxo(input.head.outpoint, input.head.scriptPublicKey);
    if (!actual || actual.amount !== input.head.amount || actual.scriptPublicKey !== input.head.scriptPublicKey ||
      actual.covenantId !== input.head.covenantId) throw new Error("Funded head does not match Testnet-10 UTXO evidence");
    return this.storage.transactionSync(() => {
      const previous = this.current();
      if (previous?.phase === "assigned") this.issuer.markAbandoned(previous.headId);
      const head = this.issuer.installHead(input);
      this.storage.sql.exec("UPDATE hash_chain_demo SET head_id = ?, pay_to = ? WHERE id = 1", input.headId, payTo);
      return head;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const current = this.current();
    if (path === "/hash-chain/status" || path === "/hash-chain/supported") {
      const available = !!current && current.phase === "ready" &&
        !!await this.#currentUtxo(current.head.outpoint, current.head.scriptPublicKey, request.signal);
      if (path.endsWith("/supported")) return json({ kinds: available ? [{
        x402Version: 2, scheme: "exact", network: "kaspa:testnet-10",
        extra: { asset: "KAS", binding: "kaspa-hash-chain-exact-v1", profile: "hash-chain-additive",
          templateId: "kaspa-x402-hash-chain-head-v1", modes: ["verify", "settle"],
          transactionEncoding: "kaspa-sdk-safe-json-v2.0.0" },
      }] : [] });
      return json({ available, phase: current?.phase ?? "unconfigured", headVersion: current?.headVersion,
        headAmount: current?.head.amount, network: "kaspa:testnet-10" });
    }
    if (!current) return json({ error: "hash_chain_unavailable" }, 503);
    const book = new ScriptAddressBook();
    const server = new DirectModeServer({
      network: "kaspa:testnet-10", payTo: current.payTo, serverPublicKey: current.ownerPublicKey,
      amount: this.config.exactAmount, minDepositSompi: "1000", claimReserveSompi: "10",
      refundTimeoutDaa: "1000", minimumRefundLeadDaa: "0", confirmationThreshold: 30,
      maxTimeoutSeconds: 150, acceptedFinality: "accepted", store: this.state, lockManager: this.#lock,
      chainProvider: new RestKaspaChainProvider(this.#rest, book, this.config.claimFeeSompi),
      addressCodec: new NativeAddressCodec(book),
      voucherVerifier: { verifyVoucher: () => false }, batchPresentationVerifier: { verifyPresentation: () => false },
      exactProfile: "hash-chain-additive", hashChainIssuer: this.issuer, hashChainHeadId: current.headId,
      hashChainGrantClaimUrl: `${this.config.gatewayBaseUrl}/hash-chain/grant`,
      exactTransactionVerifier: this.#chain,
      admitHashChainChallenge: () => true,
      hashChainGetCurrentUtxo: (outpoint, signal, claim) => {
        const head = this.issuer.getCurrent(current.headId).head;
        return this.#chain.currentUtxo(outpoint, head.scriptPublicKey, signal, claim);
      },
      hashChainIsSelected: (id, signal) => this.#chain.isSelected(id, { signal }),
    });
    if (path === "/hash-chain/grant") return handleHashChainGrantClaimHttp(server, request);
    const caller = request.headers.get(HASH_CHAIN_CALLER_HEADER);
    if (!/^[0-9a-f]{64}$/.test(caller ?? "")) return json({ error: "hash_chain_unavailable" }, 503);
    const url = new URL(new URL(request.url).pathname + new URL(request.url).search, this.config.gatewayBaseUrl).href;
    const answer = await server.handlePaidRequest({
      method: "GET", url, headers: Object.fromEntries(request.headers), paymentScheme: "exact",
      resource: { url, description: "Native-KAS hash-chain demo report", mimeType: "application/json" },
      trustedSecurityContext: { principal: `public-hash-chain-demo:${caller}` }, signal: request.signal,
    }, ({ payment }) => {
      if (payment.scheme !== "exact") throw new Error("Hash-chain demo requires exact payment");
      return { status: 200, body: {
        access: "granted", resource: "hash-chain demo report", network: "kaspa:testnet-10",
        transactionId: payment.transactionId, amountSompi: payment.accepted.amount,
      } };
    });
    return json(answer.body, answer.status, { ...answer.headers, [HASH_CHAIN_CALLER_HEADER]: caller! });
  }

  async #currentUtxo(outpoint: { txid: string; index: number }, script: string, signal?: AbortSignal) {
    return this.#chain.currentUtxo(outpoint, script, signal);
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}
