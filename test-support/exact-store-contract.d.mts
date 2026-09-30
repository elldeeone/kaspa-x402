import type {
  ServerStateStore,
  ServerDurableStateLimits,
} from "@kaspa-x402/server";

export interface ExactStoreContractOptions {
  limits?: Partial<ServerDurableStateLimits>;
  now?: () => number;
}
export interface ExactStoreContractHarness {
  store: ServerStateStore;
  peer(): ServerStateStore;
  reopen?(): ServerStateStore;
  stats(): unknown | Promise<unknown>;
  snapshot?(): unknown;
  failWriteAt?(index: number): void;
}
export function defineExactStoreContract(
  name: string,
  create: (
    options?: ExactStoreContractOptions,
  ) => ExactStoreContractHarness | Promise<ExactStoreContractHarness>,
  options?: { checkWriteFailures?: boolean },
): void;
