import type { SettleResponse } from "@x402/core/types";

/**
 * Single-process host example, outside the mechanism. Production must use the
 * existing durable operation store and retain uncertain outcomes across restart.
 */
export class PrototypeHandlerGate {
  private readonly results = new Map<string, { requestHash: string; result: Promise<unknown> }>();

  run(settlement: SettleResponse, requestHash: string, handler: () => Promise<unknown>): Promise<unknown> {
    if (!settlement.success || !/^[0-9a-f]{64}$/.test(settlement.transaction)) {
      return Promise.reject(new Error("accepted settlement required"));
    }
    const key = `${settlement.network}:${settlement.transaction}`;
    const previous = this.results.get(key);
    if (previous) {
      if (previous.requestHash !== requestHash) return Promise.reject(new Error("payment already used for another request"));
      return previous.result;
    }
    // Save ownership before any await; retain rejection after uncertain effects.
    const result = Promise.resolve().then(handler);
    this.results.set(key, { requestHash, result });
    return result;
  }
}
