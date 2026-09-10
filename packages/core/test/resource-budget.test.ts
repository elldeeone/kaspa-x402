import fs from "node:fs";
import { describe, expect, it } from "vitest";

import {
  KASPA_X402_RESOURCE_BUDGET as BUDGET,
  assertDecodedByteBudget,
  assertEncodedHeaderBudget,
  assertJsonResourceBudget,
  assertMcpPaymentResponseCapacity,
  decodeBoundedJsonBytes,
  bindRequestHashToTrustedContext,
  canonicalTrustedSecurityContext,
  decodeMcpToolCallParams,
  exactTransactionReplayIdentityHash,
  mcpToolCallFingerprint,
  paymentIdentifierExtension,
  paymentReplayIdentityHash,
  stableStringify,
  trustedSecurityContextHash,
  type PaymentPayload,
  type PaymentRequirements,
  type ResourceBudgetProfile,
} from "../src/index.js";

describe("versioned resource budget", () => {
  it("reserves one MCP metadata property for the settlement response", () => {
    expect(() =>
      assertMcpPaymentResponseCapacity({
        _meta: wideObject(BUDGET.maxExtensionProperties - 1),
      }),
    ).not.toThrow();
    expect(() =>
      assertMcpPaymentResponseCapacity({
        _meta: wideObject(BUDGET.maxExtensionProperties),
      }),
    ).toThrow("must reserve one property");
    expect(() =>
      assertMcpPaymentResponseCapacity({
        _meta: { "x402/payment-response": null },
      }),
    ).toThrow("is reserved");
  });

  it("accepts the encoded header maximum and rejects maximum plus one", () => {
    const maximum = "A".repeat(BUDGET.maxEncodedHeaderBytes);
    expect(assertEncodedHeaderBudget(maximum).decodedBytes).toBe(
      BUDGET.maxDecodedHeaderBytes,
    );
    expect(() =>
      assertEncodedHeaderBudget(`${maximum}A`),
    ).toThrow("encoded limit");
  });

  it("accepts the decoded byte maximum and rejects maximum plus one", () => {
    expect(() =>
      assertDecodedByteBudget(
        "a".repeat(BUDGET.maxDecodedHeaderBytes),
        "decoded test",
      ),
    ).not.toThrow();
    expect(() =>
      assertDecodedByteBudget(
        "a".repeat(BUDGET.maxDecodedHeaderBytes + 1),
        "decoded test",
      ),
    ).toThrow("decoded limit");
  });

  it("bounds and structurally validates raw JSON before callers use it", () => {
    expect(decodeBoundedJsonBytes('{"ok":true}', "raw test")).toEqual({
      ok: true,
    });
    expect(() =>
      decodeBoundedJsonBytes(
        new TextEncoder().encode(
          `"${"a".repeat(BUDGET.maxDecodedHeaderBytes)}"`,
        ),
        "raw test",
      ),
    ).toThrow("decoded limit");
  });

  it("accepts the string maximum and rejects maximum plus one", () => {
    expect(() =>
      assertJsonResourceBudget("a".repeat(BUDGET.maxStringBytes)),
    ).not.toThrow();
    expect(() =>
      assertJsonResourceBudget("a".repeat(BUDGET.maxStringBytes + 1)),
    ).toThrow("string limit");
  });

  it("accepts the artifact maximum and rejects maximum plus one", () => {
    expect(() =>
      assertJsonResourceBudget({
        transaction: "a".repeat(BUDGET.maxArtifactBytes),
      }),
    ).not.toThrow();
    expect(() =>
      assertJsonResourceBudget({
        transaction: "a".repeat(BUDGET.maxArtifactBytes + 1),
      }),
    ).toThrow("string limit");
  });

  it("accepts array, accepts, object, and extension maxima", () => {
    expect(() =>
      assertJsonResourceBudget(Array(BUDGET.maxArrayItems).fill(null)),
    ).not.toThrow();
    expect(() =>
      assertJsonResourceBudget(Array(BUDGET.maxArrayItems + 1).fill(null)),
    ).toThrow("array limit");

    expect(() =>
      assertJsonResourceBudget({ accepts: Array(BUDGET.maxAccepts).fill(null) }),
    ).not.toThrow();
    expect(() =>
      assertJsonResourceBudget({
        accepts: Array(BUDGET.maxAccepts + 1).fill(null),
      }),
    ).toThrow("accepts exceeds array limit");

    expect(() =>
      assertJsonResourceBudget(wideObject(BUDGET.maxObjectProperties)),
    ).not.toThrow();
    expect(() =>
      assertJsonResourceBudget(wideObject(BUDGET.maxObjectProperties + 1)),
    ).toThrow("property limit");

    expect(() =>
      assertJsonResourceBudget({
        extensions: wideObject(BUDGET.maxExtensionProperties),
      }),
    ).not.toThrow();
    expect(() =>
      assertJsonResourceBudget({
        extensions: wideObject(BUDGET.maxExtensionProperties + 1),
      }),
    ).toThrow("extensions exceeds property limit");
  });

  it("accepts the depth maximum and rejects maximum plus one", () => {
    expect(() => assertJsonResourceBudget(nested(BUDGET.maxDepth))).not.toThrow();
    expect(() =>
      assertJsonResourceBudget(nested(BUDGET.maxDepth + 1)),
    ).toThrow("depth limit");
  });

  it("accepts node and aggregate-work maxima and rejects one more node", () => {
    const maximum = nodeTree(BUDGET.maxNodes);
    const result = assertJsonResourceBudget(maximum);
    expect(result.nodes).toBe(BUDGET.maxNodes);
    expect(result.work).toBe(BUDGET.maxValidationWork);

    const over = nodeTree(BUDGET.maxNodes + 1);
    expect(() => assertJsonResourceBudget(over)).toThrow(/(?:node|work) limit/);

    const workProfile: ResourceBudgetProfile = {
      ...BUDGET,
      maxNodes: BUDGET.maxNodes + 10,
    };
    expect(
      assertJsonResourceBudget(maximum, { profile: workProfile }).work,
    ).toBe(BUDGET.maxValidationWork);
    expect(() =>
      assertJsonResourceBudget(over, { profile: workProfile }),
    ).toThrow("validation work limit");
  });

  it("accepts the canonical-output maximum and rejects maximum plus one", () => {
    const emptySize = stableStringify([
      { transaction: "" },
      { transaction: "" },
    ]).length;
    const secondLength =
      BUDGET.maxCanonicalBytes - BUDGET.maxArtifactBytes - emptySize;
    const maximum = [
      { transaction: "a".repeat(BUDGET.maxArtifactBytes) },
      { transaction: "b".repeat(secondLength) },
    ];
    expect(assertJsonResourceBudget(maximum).canonicalBytes).toBe(
      BUDGET.maxCanonicalBytes,
    );
    (maximum[1] as { transaction: string }).transaction += "b";
    expect(() => assertJsonResourceBudget(maximum)).toThrow(
      "canonical JSON limit",
    );
  });

  it("rejects cycles deterministically without recursive stack growth", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => assertJsonResourceBudget(cyclic)).toThrow(
      "cyclic object graph",
    );
  });
});

describe("trusted context and MCP admission", () => {
  it("decodes bounded raw MCP parameters before fingerprinting", () => {
    expect(
      decodeMcpToolCallParams('{"name":"read","arguments":{"id":1}}'),
    ).toEqual({ name: "read", arguments: { id: 1 } });
    expect(() =>
      decodeMcpToolCallParams(
        `{"name":"read","arguments":"${"a".repeat(BUDGET.maxDecodedHeaderBytes)}"}`,
      ),
    ).toThrow("decoded limit");
  });

  const accepted = {
    scheme: "exact",
    network: "kaspa:testnet-10",
    amount: "1",
    asset: "KAS",
    payTo: "kaspatest:test",
    maxTimeoutSeconds: 1,
    extra: { binding: "kaspa-exact-v2", profile: "standard-native" },
  } as PaymentRequirements;

  it("canonicalizes scope order and binds principal, tenant, scope, and state", () => {
    const left = {
      principal: "user:1",
      tenant: "tenant:a",
      authorizationScopes: ["write", "read", "read"],
      handlerState: { plan: "pro", policyVersion: 2 },
    };
    const right = {
      ...left,
      authorizationScopes: ["read", "write"],
    };
    expect(canonicalTrustedSecurityContext(left)).toEqual(
      canonicalTrustedSecurityContext(right),
    );
    expect(trustedSecurityContextHash(left)).toBe(
      trustedSecurityContextHash(right),
    );
    expect(
      bindRequestHashToTrustedContext("ab".repeat(32), left),
    ).not.toBe(bindRequestHashToTrustedContext("ab".repeat(32), {
      ...left,
      principal: "user:2",
    }));
  });

  it("rejects raw credential-shaped handler state", () => {
    expect(() =>
      trustedSecurityContextHash({
        principal: "user:1",
        handlerState: { bearer_token: "do-not-store" },
      }),
    ).toThrow("raw credential field");
  });

  it("accepts MCP audience and tool-name maxima and rejects maximum plus one", () => {
    const fingerprint = (audience: string, toolName: string) =>
      mcpToolCallFingerprint({ audience, toolName, accepted });
    expect(() =>
      fingerprint(
        "a".repeat(BUDGET.maxMcpAudienceBytes),
        "t".repeat(BUDGET.maxMcpToolNameBytes),
      ),
    ).not.toThrow();
    expect(() =>
      fingerprint("a".repeat(BUDGET.maxMcpAudienceBytes + 1), "tool"),
    ).toThrow("audience");
    expect(() =>
      fingerprint("audience", "t".repeat(BUDGET.maxMcpToolNameBytes + 1)),
    ).toThrow("tool name");
  });

  it("binds canonical MCP ResourceInfo and trusted caller context", () => {
    const base = {
      audience: "https://mcp.example.test",
      toolName: "download",
      arguments: { id: "alpha" },
      accepted,
      resource: {
        url: "mcp://resource/a",
        description: "A",
        mimeType: "application/json",
      },
    };
    const first = mcpToolCallFingerprint({
      ...base,
      trustedSecurityContext: { principal: "user:a" },
    });
    expect(
      mcpToolCallFingerprint({
        ...base,
        resource: { ...base.resource, url: "mcp://resource/b" },
        trustedSecurityContext: { principal: "user:a" },
      }),
    ).not.toBe(first);
    expect(
      mcpToolCallFingerprint({
        ...base,
        trustedSecurityContext: { principal: "user:b" },
      }),
    ).not.toBe(first);
    expect(
      mcpToolCallFingerprint({
        ...base,
        resource: { ...base.resource, tenantResource: "B" },
        trustedSecurityContext: { principal: "user:a" },
      }),
    ).not.toBe(first);
    expect(
      mcpToolCallFingerprint({
        ...base,
        resource: {
          mimeType: base.resource.mimeType,
          description: base.resource.description,
          url: base.resource.url,
        },
        trustedSecurityContext: { principal: "user:a" },
      }),
    ).toBe(first);
  });
});

describe("semantic replay identity", () => {
  const fixture = (
    JSON.parse(
      fs.readFileSync(
        new URL(
          "../../../vectors/x402-http/batch-voucher.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { paymentPayload: PaymentPayload }
  ).paymentPayload;
  const exactFixture = (
    JSON.parse(
      fs.readFileSync(
        new URL(
          "../../../vectors/x402-http/exact-transaction.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { paymentPayload: PaymentPayload }
  ).paymentPayload;

  it("normalizes schema-known accepted hex in MCP fingerprints", () => {
    if (fixture.accepted.scheme !== "batch-settlement") {
      throw new Error("fixture mismatch");
    }
    const uppercase = structuredClone(fixture.accepted);
    uppercase.extra.serverPublicKey =
      uppercase.extra.serverPublicKey.toUpperCase();
    uppercase.extra.securityContextHash =
      uppercase.extra.securityContextHash.toUpperCase();
    const fingerprint = (accepted: PaymentRequirements) =>
      mcpToolCallFingerprint({
        audience: "https://mcp.example.test",
        toolName: "download",
        accepted,
      });

    expect(fingerprint(uppercase)).toBe(fingerprint(fixture.accepted));
  });

  it("normalizes schema-known hex and excludes unsigned unknown fields", () => {
    const variant = structuredClone(fixture) as PaymentPayload;
    if (variant.payload.type !== "voucher") throw new Error("fixture mismatch");
    variant.payload.activeScriptPublicKey =
      variant.payload.activeScriptPublicKey.toUpperCase();
    variant.payload.voucher.signature =
      variant.payload.voucher.signature.toUpperCase();
    variant.payload.untrusted = { nested: true };
    variant.untrusted = "ignored";
    variant.extensions = {
      untrusted: { ignored: true },
      "payment-identifier": paymentIdentifierExtension({
        required: false,
        id: "identifier-is-separate",
      }),
    };
    expect(paymentReplayIdentityHash(variant)).toBe(
      paymentReplayIdentityHash(fixture),
    );
  });

  it("canonicalizes exact transaction identity and excludes receipt metadata", () => {
    const variant = structuredClone(exactFixture);
    if (variant.payload.type !== "exact-transaction") {
      throw new Error("fixture mismatch");
    }
    const transaction = JSON.parse(variant.payload.transaction) as {
      inputs: Array<{
        previousOutpoint: { transactionId: string };
      }>;
      untrusted?: unknown;
    };
    transaction.inputs[0]!.previousOutpoint.transactionId =
      transaction.inputs[0]!.previousOutpoint.transactionId.toUpperCase();
    transaction.untrusted = { ignored: true };
    variant.payload.transaction = JSON.stringify(transaction, null, 2);
    variant.payload.payerAddress = "kaspatest:receipt-only-variant";

    expect(paymentReplayIdentityHash(variant)).toBe(
      paymentReplayIdentityHash(exactFixture),
    );
  });

  it("keeps different exact consensus transaction fields distinct", () => {
    const changed = structuredClone(exactFixture);
    if (changed.payload.type !== "exact-transaction") {
      throw new Error("fixture mismatch");
    }
    const transaction = JSON.parse(changed.payload.transaction) as {
      outputs: Array<{ value: string }>;
    };
    transaction.outputs[0]!.value = (
      BigInt(transaction.outputs[0]!.value) + 1n
    ).toString();
    changed.payload.transaction = JSON.stringify(transaction);

    expect(paymentReplayIdentityHash(changed)).not.toBe(
      paymentReplayIdentityHash(exactFixture),
    );
  });

  it("rejects parsed exact artifacts that exceed structural budgets", () => {
    const cases = [
      nested(BUDGET.maxDepth + 1),
      Array(BUDGET.maxArrayItems + 1).fill(null),
    ];

    for (const artifact of cases) {
      expect(() =>
        exactTransactionReplayIdentityHash(JSON.stringify(artifact)),
      ).toThrow(/(?:depth|array) limit/);
    }
  });

  it("preserves opaque identity for bounded unsupported exact artifacts", () => {
    const malformed = exactTransactionReplayIdentityHash("not-json");
    const unsupported = exactTransactionReplayIdentityHash(
      '{"transaction":"signed-kip10-exact"}',
    );

    expect(malformed).toMatch(/^[0-9a-f]{64}$/);
    expect(unsupported).toMatch(/^[0-9a-f]{64}$/);
    expect(malformed).not.toBe(unsupported);
  });

  it("keeps payment identifier idempotency separate from replay identity", () => {
    const first = structuredClone(fixture) as PaymentPayload;
    const second = structuredClone(fixture) as PaymentPayload;
    first.extensions = {
      "payment-identifier": paymentIdentifierExtension({
        required: false,
        id: "first_identifier_1",
      }),
    };
    second.extensions = {
      "payment-identifier": paymentIdentifierExtension({
        required: false,
        id: "second_identifier2",
      }),
    };
    expect(paymentReplayIdentityHash(first)).toBe(
      paymentReplayIdentityHash(second),
    );
  });

  it("keeps genuinely different signed voucher semantics distinct", () => {
    const changed = structuredClone(fixture) as PaymentPayload;
    if (changed.payload.type !== "voucher") throw new Error("fixture mismatch");
    changed.payload.voucher.authorizedCumulativeAmount = "25000001";
    expect(paymentReplayIdentityHash(changed)).not.toBe(
      paymentReplayIdentityHash(fixture),
    );
  });
});

function wideObject(count: number): Record<string, null> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`p${index}`, null]),
  );
}

function nested(depth: number): unknown {
  let value: unknown = null;
  for (let index = 0; index < depth; index += 1) value = [value];
  return value;
}

function nodeTree(nodes: number): unknown[] {
  if (nodes < 1) throw new Error("nodes must be positive");
  if (nodes === 1) return [];
  const root: unknown[] = [];
  let remaining = nodes - 1;
  while (remaining > 0) {
    const childCount = Math.min(BUDGET.maxArrayItems, remaining - 1);
    if (childCount < 0) break;
    root.push(Array(childCount).fill(null));
    remaining -= childCount + 1;
  }
  return root;
}
