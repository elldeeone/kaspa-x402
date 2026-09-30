import { defineExactStoreContract } from "../../../test-support/exact-store-contract.mjs";
import { GatewayLedger } from "../src/state.js";
import { FakeStorage } from "./fake-storage.js";

defineExactStoreContract(
  "gateway",
  (options) => {
    const storage = new FakeStorage();
    const reopen = () => new GatewayLedger(storage, options);
    return {
      store: reopen(),
      peer: reopen,
      reopen,
      stats: () => storage.get("durable-budget:meta"),
      snapshot: () => storage.snapshot(),
      failWriteAt: (index) => storage.failWriteAt(index),
    };
  },
  { checkWriteFailures: true },
);
