import { stableStringify, type AcceptedTransactionEvidence } from "@kaspa-x402/core";
import { KaspaPnnClient } from "./adapters.js";
import { registerPolicySelectedPnnClient, type PolicySelectedPnnClient } from "./pnn-trust-boundary.js";

export type PnnChainTrustMode = "trusted-single-source" | "independent-corroboration";
const MAX_CORROBORATED_DAA_SKEW = 100n;

export interface PnnVerificationAuthority {
  /** One administrative trust domain, regardless of its failover URL count. */
  trustDomain: string;
  client: KaspaPnnClient;
}

export type PnnChainTrustPolicy =
  | { mode: "trusted-single-source"; verification: KaspaPnnClient }
  | { mode: "independent-corroboration"; submission: KaspaPnnClient;
      authorities: readonly PnnVerificationAuthority[]; requiredAuthorities: number };

/** A host must choose the chain authority before protected verification. */
export function selectPnnChainEvidenceClient(policy: PnnChainTrustPolicy): PolicySelectedPnnClient {
  if (!policy || (policy.mode !== "trusted-single-source" && policy.mode !== "independent-corroboration"))
    throw new Error("explicit PNN chain-evidence trust policy is required");
  if (policy.mode === "trusted-single-source") {
    if (!(policy.verification instanceof KaspaPnnClient))
      throw new Error("trusted PNN verification authority is required");
    return registerPolicySelectedPnnClient(new SelectedKaspaPnnClient(policy.verification, policy.verification));
  }
  if (!(policy.submission instanceof KaspaPnnClient))
    throw new Error("independent chain-evidence submission client is invalid");
  const verification = new CorroboratedKaspaPnnClient(policy.submission, policy.authorities, policy.requiredAuthorities);
  return registerPolicySelectedPnnClient(new SelectedKaspaPnnClient(verification, policy.submission));
}

/** Keeps the selected verification authority distinct from its raw submission client. */
class SelectedKaspaPnnClient extends KaspaPnnClient {
  readonly #verification: KaspaPnnClient;
  readonly #submission: KaspaPnnClient;

  constructor(
    verification: KaspaPnnClient,
    submission: KaspaPnnClient,
  ) {
    super({ endpoints: [] });
    this.#verification = verification;
    this.#submission = submission;
  }

  override health(...args: Parameters<KaspaPnnClient["health"]>) {
    return this.#verification.health(...args);
  }
  override snapshotHashChainUtxos(...args: Parameters<KaspaPnnClient["snapshotHashChainUtxos"]>) {
    return this.#verification.snapshotHashChainUtxos(...args);
  }
  override findAcceptedTransaction(...args: Parameters<KaspaPnnClient["findAcceptedTransaction"]>) {
    return this.#verification.findAcceptedTransaction(...args);
  }
  override findHashChainPayment(...args: Parameters<KaspaPnnClient["findHashChainPayment"]>) {
    return this.#verification.findHashChainPayment(...args);
  }
  override confirmAcceptedTransaction(...args: Parameters<KaspaPnnClient["confirmAcceptedTransaction"]>) {
    return this.#verification.confirmAcceptedTransaction(...args);
  }
  override discoverCovenantLineage(...args: Parameters<KaspaPnnClient["discoverCovenantLineage"]>) {
    return this.#verification.discoverCovenantLineage(...args);
  }
  override submitTransaction(...args: Parameters<KaspaPnnClient["submitTransaction"]>) {
    return this.#submission.submitTransaction(...args);
  }
}
Object.freeze(SelectedKaspaPnnClient.prototype);

/** Compare completed, normalized chain reads across distinct operators. */
export class CorroboratedKaspaPnnClient extends KaspaPnnClient {
  readonly #submission: KaspaPnnClient;
  readonly #authorities: readonly PnnVerificationAuthority[];
  readonly #required: number;

  constructor(submission: KaspaPnnClient, authorities: readonly PnnVerificationAuthority[], required: number) {
    super({ endpoints: [] });
    if (!Number.isSafeInteger(required) || required < 2 || authorities.length < required ||
      new Set(authorities.map((authority) => authority.trustDomain)).size !== authorities.length ||
      new Set(authorities.map((authority) => authority.client)).size !== authorities.length ||
      authorities.some((authority) => !/^[a-z0-9_-]{1,64}$/.test(authority.trustDomain))) {
      throw new Error("independent chain-evidence authorities are invalid");
    }
    this.#submission = submission;
    this.#authorities = authorities.map(({ trustDomain, client }) => ({ trustDomain, client }));
    this.#required = required;
  }

  override async health() {
    const result = await this.#agree((client) => client.health(),
      (value) => ({ ok: value.ok, networkId: value.networkId }));
    if (!result.ok || result.networkId !== "testnet-10")
      throw new Error("independent chain evidence is on the wrong network");
    return { ok: true as const, networkId: "testnet-10", endpoint: "independent-authorities" };
  }

  override snapshotHashChainUtxos(...args: Parameters<KaspaPnnClient["snapshotHashChainUtxos"]>) {
    return this.#agree((client) => client.snapshotHashChainUtxos(...args), (value) => ({
      utxos: [...value.utxos].sort((a, b) =>
        `${a.outpoint.txid}:${a.outpoint.index}`.localeCompare(`${b.outpoint.txid}:${b.outpoint.index}`)),
    }), (results) => {
      let highest = results[0]!;
      let lowestDaa = BigInt(highest.checkpoint.daaScore);
      for (const result of results.slice(1)) {
        const daa = BigInt(result.checkpoint.daaScore);
        if (daa < lowestDaa) lowestDaa = daa;
        if (daa > BigInt(highest.checkpoint.daaScore)) highest = result;
      }
      if (BigInt(highest.checkpoint.daaScore) - lowestDaa > MAX_CORROBORATED_DAA_SKEW)
        throw new Error("independent chain evidence conflicts");
      return highest;
    });
  }

  override findAcceptedTransaction(...args: Parameters<KaspaPnnClient["findAcceptedTransaction"]>) {
    return this.#agree((client) => client.findAcceptedTransaction(...args), (value) => value && ({
      raw: value.raw, evidence: acceptanceFacts(value.evidence),
    }));
  }

  override findHashChainPayment(...args: Parameters<KaspaPnnClient["findHashChainPayment"]>) {
    return this.#agree((client) => client.findHashChainPayment(...args), (value) => value && ({
      transaction: value.transaction, evidence: acceptanceFacts(value.evidence),
    }));
  }

  override confirmAcceptedTransaction(...args: Parameters<KaspaPnnClient["confirmAcceptedTransaction"]>) {
    return this.#agree((client) => client.confirmAcceptedTransaction(...args), acceptanceFacts);
  }

  override discoverCovenantLineage(...args: Parameters<KaspaPnnClient["discoverCovenantLineage"]>) {
    return this.#agree((client) => client.discoverCovenantLineage(...args), (value) => ({
      fromCheckpoint: value.fromCheckpoint,
      continuity: value.continuity,
      removedChainBlockHashes: value.removedChainBlockHashes,
      addedChainBlocks: value.addedChainBlocks.map((block) => ({
        blockHash: block.blockHash,
        ...(block.genesisAcceptance ? { genesisAcceptance: acceptanceFacts(block.genesisAcceptance) } : {}),
        transitions: block.transitions.map((transition) => ({
          ...transition, acceptance: acceptanceFacts(transition.acceptance),
        })),
      })),
    }));
  }

  override submitTransaction(...args: Parameters<KaspaPnnClient["submitTransaction"]>) {
    return this.#submission.submitTransaction(...args);
  }

  async #agree<T>(read: (client: KaspaPnnClient) => Promise<T>,
    normalize: (value: T) => unknown = (value) => value,
    choose: (results: T[]) => T = (results) => results[0]!,
  ): Promise<T> {
    const results = await Promise.allSettled(this.#authorities.map((authority) => read(authority.client)));
    const successful: T[] = [];
    for (const result of results) if (result.status === "fulfilled") successful.push(result.value as T);
    if (successful.length < this.#required) throw new Error("independent chain evidence is unavailable");
    const baseline = stableStringify(normalize(successful[0]!));
    if (successful.some((result) => stableStringify(normalize(result)) !== baseline)) {
      throw new Error("independent chain evidence conflicts");
    }
    return choose(successful);
  }
}

/** Every authority verifies its own checkpoint and required depth before agreeing on chain facts. */
function acceptanceFacts(evidence: AcceptedTransactionEvidence) {
  const { checkpoint: _checkpoint, confirmationCount: _confirmationCount, ...facts } = evidence;
  return facts;
}
