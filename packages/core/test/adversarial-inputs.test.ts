import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { readMcpPaymentPayload, readMcpPaymentResponse } from "../src/index.js";

const vector = JSON.parse(fs.readFileSync(new URL("../../../vectors/x402-http/exact-transaction.json", import.meta.url), "utf8"));

describe("MCP payment representation budgets", () => {
  for (const [name, read, fixture] of [
    ["payload", (value: unknown) => readMcpPaymentPayload({ name: "paid", _meta: { "x402/payment": value } }), vector.paymentPayload],
    ["response", (value: unknown) => readMcpPaymentResponse({ _meta: { "x402/payment-response": value } }), vector.settlementResponse],
  ] as const) {
    it(`${name} accepts the ordinary fixture`, () => expect(read(fixture)).toEqual(fixture));
    for (const kind of ["bytes", "depth", "nodes", "keys", "cycle"] as const) {
      it(`${name} rejects excessive ${kind} before schema validation`, () => {
        const value = structuredClone(fixture);
        let extension: unknown = "leaf";
        if (kind === "bytes") extension = "x".repeat(256 * 1024);
        if (kind === "depth") for (let i = 0; i < 40; i++) extension = { nested: extension };
        if (kind === "nodes") extension = Array(16_384).fill(null);
        if (kind === "keys") extension = Object.fromEntries(Array.from({ length: 1_025 }, (_, i) => [String(i), null]));
        if (kind === "cycle") { const cycle: Record<string, unknown> = {}; cycle.self = cycle; extension = cycle; }
        value.extensions = { adversarial: extension };
        expect(() => read(value)).toThrow();
      });
    }
  }
});
