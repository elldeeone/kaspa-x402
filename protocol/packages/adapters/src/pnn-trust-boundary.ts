import type { KaspaPnnClient } from "./adapters.js";

declare const selectedPnnClient: unique symbol;

/** A verification client minted by an explicit PNN trust policy. */
export type PolicySelectedPnnClient = KaspaPnnClient & {
  readonly [selectedPnnClient]: true;
};

const selectedClients = new WeakSet<KaspaPnnClient>();

/** Internal registration; the package root exports only the selector and selected type. */
export function registerPolicySelectedPnnClient(client: KaspaPnnClient): PolicySelectedPnnClient {
  Object.freeze(client);
  selectedClients.add(client);
  return client as PolicySelectedPnnClient;
}

export function assertPolicySelectedPnnClient(client: unknown): asserts client is PolicySelectedPnnClient {
  if (!client || typeof client !== "object" || !selectedClients.has(client as KaspaPnnClient))
    throw new Error("explicit PNN chain-evidence trust policy is required");
}
