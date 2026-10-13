import {
  DirectModeServer,
  handleHashChainGrantClaimHttp,
} from "@kaspa-x402/server";
import type { HashChainGrantIssuer, HashChainPublicGrant } from "@kaspa-x402/server/hash-chain-issuer";
import { NativeAddressCodec, ScriptAddressBook, type PolicySelectedPnnClient } from "@kaspa-x402/adapters";
import type { GatewayConfig } from "./config.js";
import { HASH_CHAIN_CALLER_HEADER } from "./hash-chain-proxy.js";
import { addressForScriptPublicKey } from "@kaspa-x402/adapters/native";
import { DurableGatewayLockManager, type GatewayStateClient } from "./state.js";
import { openDurableHashChainIssuer, type HashChainStorage } from "./hash-chain-storage.js";
import { HashChainPnnView } from "./hash-chain-pnn-view.js";
import { configuredPnnClient } from "./pnn-trust.js";
import { decodePaymentSignatureHeader } from "@kaspa-x402/core";
import type { ChainCheckpoint } from "@kaspa-x402/core";
import type { HashChainBorrowGrant } from "@kaspa-x402/covenant";
import { readRequestJsonWithLimit } from "./gateway.js";
import type { HashChainGrantClaim } from "@kaspa-x402/server/hash-chain-issuer";

export type HashChainHeadRegistration = Parameters<HashChainGrantIssuer["installHead"]>[0];
export interface HashChainOwnerRecovery {
  headId: string;
  transactionId: string;
  fromCheckpoint: ChainCheckpoint;
  grants: HashChainBorrowGrant[];
}

/** Optional ready-head pool in the existing Durable Object and shared ledger. */
export class HashChainDemoService {
  readonly issuer: HashChainGrantIssuer;
  readonly #chain: HashChainPnnView;
  readonly #pnn: PolicySelectedPnnClient;
  readonly #lock: DurableGatewayLockManager;

  constructor(
    private readonly storage: HashChainStorage,
    private readonly state: GatewayStateClient,
    private readonly config: GatewayConfig,
  ) {
    this.issuer = openDurableHashChainIssuer(storage, {
      maxGrantsPerClaimant: 1,
      windowSeconds: 86_400,
      resolveFundingOutpoint: async (claim, grant) => {
        const challenge = this.issuer.getChallenge(grant.headId, claim.challengeId);
        if (!challenge) throw new Error("grant challenge is unavailable");
        return this.#chain.qualifyingFundingOutpoints(
          claim, (BigInt(challenge.quotedAmount) + BigInt(this.config.claimFeeSompi)).toString());
      },
    });
    this.#pnn = configuredPnnClient(config);
    this.#chain = new HashChainPnnView(this.#pnn, storage);
    this.#lock = new DurableGatewayLockManager(state);
  }

  current(): (HashChainPublicGrant & { payTo: string }) | undefined {
    const heads = this.issuer.listHeads().filter((head) => head.phase !== "retired");
    const selected = heads.find((head) => head.phase === "ready") ?? heads[0];
    return selected ? { ...selected,
      payTo: addressForScriptPublicKey(selected.head.scriptPublicKey, "kaspa:testnet-10") } : undefined;
  }

  async register(input: HashChainHeadRegistration): Promise<HashChainPublicGrant> {
    if (input.network !== "kaspa:testnet-10") throw new Error("Use a Testnet-10 head");
    if (!Array.isArray(input.grants) || input.grants.length > 64) throw new Error("Demo head requires 1 to 64 grants");
    const actual = await this.#currentUtxo(input.head.outpoint, input.head.scriptPublicKey);
    if (!actual || actual.amount !== input.head.amount || actual.scriptPublicKey !== input.head.scriptPublicKey ||
      actual.covenantId !== input.head.covenantId) throw new Error("Funded head does not match Testnet-10 UTXO evidence");
    return this.issuer.installHead(input, this.config.hashChainPoolSize);
  }

  async recover(input: HashChainOwnerRecovery): Promise<HashChainPublicGrant> {
    return this.issuer.recoverOwnerRotationAfterSelectedObservation(
      input.headId, input.transactionId, input.grants,
      { getSelectedTransaction: (id, { signal } = {}) =>
        this.#chain.selectedOwnerRotation(id, input.fromCheckpoint, signal) },
    );
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    let current = this.current();
    const allHeads = this.issuer.listHeads();
    if (path === "/hash-chain/status" || path === "/hash-chain/supported") {
      const available = !!current && current.phase === "ready" &&
        !!await this.#currentUtxo(current.head.outpoint, current.head.scriptPublicKey, request.signal);
      if (path.endsWith("/supported")) return json({ kinds: available ? [{
        x402Version: 2, scheme: "exact", network: "kaspa:testnet-10",
        extra: { asset: "KAS", binding: "kaspa-hash-chain-exact-v1", profile: "hash-chain-additive",
          templateId: "kaspa-x402-hash-chain-head-v2", modes: ["verify", "settle"],
          transactionEncoding: "kaspa-sdk-safe-json-v2.0.0" },
      }] : [] });
      return json({ available, phase: current?.phase ?? "unconfigured", headVersion: current?.headVersion,
        headAmount: current?.head.amount, network: "kaspa:testnet-10",
        readyHeads: allHeads.filter((head) => head.phase === "ready").length,
        capacity: this.config.hashChainPoolSize, trustMode: this.config.chainTrustMode });
    }
    if (path === "/hash-chain/grant") {
      let claim: HashChainGrantClaim;
      try { claim = await readRequestJsonWithLimit<HashChainGrantClaim>(request.clone(), 8192, "hash-chain grant claim"); }
      catch { return json({ error: "grant_claim_rejected" }, 400); }
      const match = allHeads.find((head) =>
        head.grantId === claim.grantId && !!this.issuer.getChallenge(head.headId, claim.challengeId));
      if (match) current = { ...match,
        payTo: addressForScriptPublicKey(match.head.scriptPublicKey, "kaspa:testnet-10") };
    } else {
      const header = request.headers.get("payment-signature");
      if (header) {
        try {
          const payment = decodePaymentSignatureHeader(header);
          const headId = payment.accepted.scheme === "exact" ? payment.accepted.extra.headId : undefined;
          const match = allHeads.find((head) => head.headId === headId);
          if (match) current = { ...match,
            payTo: addressForScriptPublicKey(match.head.scriptPublicKey, "kaspa:testnet-10") };
        } catch { /* The server returns the validated payment error. */ }
      }
    }
    if (!current) return json({ error: "hash_chain_unavailable" }, 503);
    const book = new ScriptAddressBook();
    const server = new DirectModeServer({
      network: "kaspa:testnet-10",
      payTo: current.payTo,
      amount: this.config.exactAmount,
      confirmationThreshold: 30,
      maxTimeoutSeconds: 150,
      acceptedFinality: "accepted",
      store: this.state,
      lockManager: this.#lock,
      publicBoundaryPolicy: { adapterTimeoutMs: 60_000 },
      addressCodec: new NativeAddressCodec(book),
      exactProfile: "hash-chain-additive",
      hashChainIssuer: this.issuer,
      hashChainHeadId: current.headId,
      hashChainGrantClaimUrl: `${this.config.gatewayBaseUrl}/hash-chain/grant`,
      exactTransactionVerifier: this.#chain,
      admitHashChainChallenge: () => true,
      hashChainGetCurrentUtxo: (outpoint, signal, claim) => {
        const grant = this.issuer.getCurrent(current.headId);
        // The issuer has already authenticated an assigned retry's claim tuple.
        const initialClaim = grant.phase === "ready" ? claim : undefined;
        const challenge = initialClaim
          ? this.issuer.getChallenge(current.headId, initialClaim.challengeId)
          : undefined;
        const requiredPayerFunding = challenge
          ? (BigInt(challenge.quotedAmount) + BigInt(this.config.claimFeeSompi)).toString()
          : undefined;
        return this.#chain.currentUtxo(
          outpoint,
          grant.head.scriptPublicKey,
          signal,
          initialClaim,
          requiredPayerFunding,
        );
      },
      hashChainIsSelected: (id, signal) => this.#chain.isSelected(id, { signal }),
    });
    const caller = request.headers.get(HASH_CHAIN_CALLER_HEADER);
    if (!/^[0-9a-f]{64}$/.test(caller ?? "")) return json({ error: "hash_chain_unavailable" }, 503);
    const trustedSecurityContext = { principal: `public-hash-chain-demo:${caller}` };
    if (path === "/hash-chain/grant") {
      return handleHashChainGrantClaimHttp(
        server,
        request,
        trustedSecurityContext,
      );
    }
    const url = new URL(new URL(request.url).pathname + new URL(request.url).search, this.config.gatewayBaseUrl).href;
    const answer = await server.handlePaidRequest({ routeAccess: "authenticated",
      method: "GET", url, headers: Object.fromEntries(request.headers), paymentScheme: "exact",
      resource: { url, description: "Native-KAS hash-chain demo report", mimeType: "application/json" },
      trustedSecurityContext, signal: request.signal,
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
  const responseHeaders = new Headers(headers);
  responseHeaders.set("cache-control", "private, no-store, max-age=0");
  return Response.json(body, { status, headers: responseHeaders });
}
