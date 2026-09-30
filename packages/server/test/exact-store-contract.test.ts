import { MemoryServerChannelStore } from "../src/index.js";
import { defineExactStoreContract } from "../../../test-support/exact-store-contract.mjs";

defineExactStoreContract("memory", (options) => {
  const store = new MemoryServerChannelStore([], options);
  return { store, peer: () => store, stats: () => store.durableStateStats() };
});
