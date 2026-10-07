import { generateKeyPairSync } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { schnorr } from "@noble/curves/secp256k1.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { x402HTTPResourceServer, type HTTPRequestContext } from "@x402/core/http";
import type { PaymentPayload, SettleContext, SettleRequest, SettleResponse } from "@x402/core/types";
import {
  bindRequestHashToTrustedContext, encodePaymentSignatureHeader, exactAuthorizationExpiryError, stableStringify,
  type ExactTransactionPayload, type PaymentPayload as KaspaPaymentPayload,
} from "@kaspa-x402/core";
import {
  BINDING_FIELD, boundRequestHash, createClientScheme, createFacilitatorScheme,
  createServerScheme, type BoundPayment, type Operation,
} from "./binding.js";
import { PrototypeHandlerGate } from "./handler.js";
import { authorize, digestFor, fixture, NETWORK, NOW, PAYER_KEY, PROFILES } from "./fixtures.js";

afterEach(() => vi.unstubAllGlobals());

const OPERATION: Operation = {
  method: "POST", url: "https://api.example.test/file", body: { id: 1 },
  trustedSecurityContext: { principal: "payer:1", tenant: "tenant:a" },
};

async function setup(profile: typeof PROFILES[number] = "standard-native") {
  const vector = fixture(profile);
  const keys = generateKeyPairSync("ed25519");
  const audience = "https://facilitator.example.test";
  const claims = new WeakMap<object, Operation>();
  const events: string[] = [];
  const wire: SettleRequest[] = [];
  let now = NOW;
  let failSettlement = false;
  let broadcasts = 0;
  let handlers = 0;
  let verified = 0;
  const settlements = new Map<string, { hash: string; result: Promise<SettleResponse> }>();

  function verifyPayer(input: BoundPayment) {
    verified++;
    const payload = input.paymentPayload.payload as ExactTransactionPayload;
    // Fixed known consensus fixtures, not a replacement for chain verification.
    const original = vector.payment.payload as ExactTransactionPayload;
    if (stableStringify(JSON.parse(payload.transaction)) !== stableStringify(JSON.parse(original.transaction))) throw new Error("unknown transaction fixture");
    const digest = digestFor(input.paymentPayload, vector.transactionId);
    const signerScript = JSON.parse(payload.transaction).inputs[payload.authorization.inputIndex].utxo.scriptPublicKey;
    expect(signerScript).toBe(`000020${Buffer.from(PAYER_KEY).toString("hex")}ac`);
    if (payload.requestHash !== bindRequestHashToTrustedContext(input.requestHash, input.trustedSecurityContext) ||
        exactAuthorizationExpiryError({
          maxTimeoutSeconds: input.paymentRequirements.maxTimeoutSeconds,
          authorizationExpiresAt: payload.authorization.expiresAt,
          challengeExpiresAt: input.paymentRequirements.extra.challengeExpiresAt,
          nowMs: now,
        }) ||
        payload.authorization.digest !== digest ||
        !schnorr.verify(Buffer.from(payload.authorization.signature, "hex"), Buffer.from(digest, "hex"), PAYER_KEY)) {
      throw new Error("invalid payer authorization");
    }
  }

  const mechanism = createFacilitatorScheme({
    publicKey: keys.publicKey, audience, payTo: vector.payment.accepted.payTo, now: () => now,
    backend: {
      async verify(input) { verifyPayer(input); return { isValid: true }; },
      async settle(input) {
        verifyPayer(input);
        if (failSettlement) return { success: false, errorReason: "chain_unavailable", network: NETWORK, transaction: "" };
        const hash = String(input.paymentPayload.payload.requestHash);
        const previous = settlements.get(vector.transactionId);
        if (previous) {
          if (previous.hash !== hash) throw new Error("transaction reused for another request");
          return previous.result;
        }
        const result = (async (): Promise<SettleResponse> => {
          events.push("broadcast"); broadcasts++;
          await setImmediate(); // Let competing retries reach the reserved entry.
          events.push("accepted");
          return { success: true, network: NETWORK, transaction: vector.transactionId, amount: input.paymentRequirements.amount };
        })();
        settlements.set(vector.transactionId, { hash, result });
        return result;
      },
    },
  });
  const facilitator = new x402Facilitator().register(NETWORK, mechanism);
  // Exercise the real HTTPFacilitatorClient serializer through a JSON boundary.
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === `${audience}/supported`) return Response.json(facilitator.getSupported());
    const body = JSON.parse(String(init?.body));
    expect(Object.keys(body).sort()).toEqual(["paymentPayload", "paymentRequirements", "x402Version"]);
    wire.push(body);
    return Response.json(await facilitator.settle(body.paymentPayload, body.paymentRequirements));
  }));
  const serverScheme = createServerScheme({
    privateKey: keys.privateKey, audience, now: () => now,
    resolveOperation(context) {
      const request = (context.transportContext as { request: HTTPRequestContext } | undefined)?.request;
      const operation = request && claims.get(request.adapter);
      if (!operation) throw new Error("missing trusted operation context");
      return operation;
    },
  });
  const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: audience })).register(NETWORK, serverScheme);
  const terms = vector.payment.accepted;
  const option = {
    scheme: terms.scheme, network: terms.network,
    price: { amount: terms.amount, asset: terms.asset },
    payTo: terms.payTo, maxTimeoutSeconds: terms.maxTimeoutSeconds, extra: terms.extra,
  };
  const http = new x402HTTPResourceServer(server, {
    "POST /file": { accepts: option },
    "POST /other": { accepts: option },
    "GET /file": { accepts: option },
  });
  await http.initialize();

  async function makePayment(operation = OPERATION) {
    const client = new x402Client().setSpendControls({
      allowedAssets: [{ network: NETWORK, asset: "KAS", maxAmountPerPayment: "100000000" }],
    });
    client.register(NETWORK, createClientScheme(operation, async (accepted, hash) =>
      authorize({ ...vector.payment, accepted }, vector.transactionId, hash)));
    return client.createPaymentPayload({ x402Version: 2, resource: { url: operation.url }, accepts: [terms] });
  }

  function request(payment: PaymentPayload, operation = OPERATION): HTTPRequestContext {
    const paymentHeader = encodePaymentSignatureHeader(payment as KaspaPaymentPayload);
    const adapter = {
      getHeader: (name: string) => name.toLowerCase() === "payment-signature" ? paymentHeader : undefined,
      getMethod: () => operation.method,
      getPath: () => new URL(operation.url).pathname,
      getUrl: () => operation.url,
      getAcceptHeader: () => "application/json",
      getUserAgent: () => "compatibility-test",
      getBody: () => operation.body,
    };
    // Application auth/body parsing happens before x402. Never source from payment.
    claims.set(adapter, structuredClone(operation));
    return { adapter, path: adapter.getPath(), method: operation.method,
      paymentHeader };
  }

  const gate = new PrototypeHandlerGate();
  async function dispatch(payment: PaymentPayload, operation = OPERATION, handlerFails = false) {
    const result = await http.processHTTPRequest(request(payment, operation));
    if (result.type !== "payment-verified") return result;
    expect(result.beforeHandlerSettlement?.phase).toBe("before-handler");
    return gate.run(result.beforeHandlerSettlement!.result, boundRequestHash(operation, result.paymentRequirements), async () => {
      events.push("handler"); handlers++;
      if (handlerFails) throw new Error("uncertain handler outcome");
      return { type: "success", body: "protected result" };
    });
  }
  return {
    makePayment, dispatch, request, http, server, serverScheme, mechanism, vector, wire, events,
    counts: () => ({ broadcasts, handlers, verified }),
    failSettlement: () => { failSettlement = true; },
    advance: (ms: number) => { now += ms; },
  };
}

describe.each(PROFILES)("upstream exact integration: %s", (profile) => {
  it("uses upstream client, HTTP flow, serializer and facilitator without changing payer-signed fields", async () => {
    const app = await setup(profile);
    const payment = await app.makePayment();
    const original = structuredClone(payment);
    expect(await app.dispatch(payment)).toEqual({ type: "success", body: "protected result" });
    expect(app.events).toEqual(["broadcast", "accepted", "handler"]);
    expect(payment).toEqual(original);
    const { [BINDING_FIELD]: statement, ...forwarded } = app.wire[0].paymentPayload.payload;
    expect(statement).toBeDefined();
    expect(forwarded).toEqual(original.payload);
    expect(app.wire[0].paymentRequirements).toEqual(original.accepted);
    expect(app.wire[0]).not.toHaveProperty("requestHash");
  });

  it.each([
    ["method", { ...OPERATION, method: "GET" }],
    ["URL", { ...OPERATION, url: "https://api.example.test/other" }],
    ["body", { ...OPERATION, body: { id: 2 } }],
    ["tenant", { ...OPERATION, trustedSecurityContext: { ...OPERATION.trustedSecurityContext!, tenant: "tenant:b" } }],
  ])("rejects changed %s before facilitator or protected work", async (_name, changed) => {
    const app = await setup(profile);
    const result = await app.dispatch(await app.makePayment(), changed);
    expect(result).toMatchObject({ type: "payment-error" });
    expect(app.wire).toHaveLength(0);
    expect(app.counts()).toEqual({ broadcasts: 0, handlers: 0, verified: 0 });
  });

  it("rejects changing the fingerprint without a new payer signature", async () => {
    const app = await setup(profile);
    const payment = await app.makePayment();
    const changed = { ...OPERATION, body: { id: 2 } };
    payment.payload.requestHash = boundRequestHash(changed, payment.accepted);
    expect(await app.dispatch(payment, changed)).toMatchObject({ type: "payment-error" });
    expect(app.counts()).toEqual({ broadcasts: 0, handlers: 0, verified: 1 });
  });

  it("settles and runs protected work once under concurrent and later retries", async () => {
    const app = await setup(profile);
    const payment = await app.makePayment();
    const replies = await Promise.all(Array.from({ length: 8 }, () => app.dispatch(structuredClone(payment))));
    expect(replies.every(reply => stableStringify(reply) === stableStringify(replies[0]))).toBe(true);
    expect(await app.dispatch(payment)).toEqual(replies[0]);
    expect(app.counts()).toMatchObject({ broadcasts: 1, handlers: 1 });
  });

  it("does not repeat protected work if an opaque payment identifier changes", async () => {
    const app = await setup(profile);
    const payment = await app.makePayment();
    await app.dispatch(payment);
    const identifier = payment.extensions!["payment-identifier"] as { info: { id: string } };
    identifier.info.id = "another_payment_identifier";
    expect(await app.dispatch(payment)).toMatchObject({ type: "success" });
    expect(app.counts()).toMatchObject({ broadcasts: 1, handlers: 1 });
  });

  it("does not grant a different operation even with a fresh payer authorization for the same transaction", async () => {
    const app = await setup(profile);
    await app.dispatch(await app.makePayment());
    const changed = { ...OPERATION, body: { id: 2 } };
    expect(await app.dispatch(await app.makePayment(changed), changed)).toMatchObject({ type: "payment-error" });
    expect(app.counts()).toMatchObject({ broadcasts: 1, handlers: 1 });
  });
});

describe("binding trust and failure boundaries", () => {
  it("fails closed without host-derived request context", async () => {
    const app = await setup();
    const payment = await app.makePayment();
    await expect(app.server.settlePayment(payment, payment.accepted, {}, undefined, undefined, "before-handler")).rejects.toThrow();
    expect(app.wire).toHaveLength(0);
  });

  it("rejects a payer-supplied server binding even if it was previously valid", async () => {
    const app = await setup();
    const payment = await app.makePayment();
    await app.dispatch(payment);
    const injected = structuredClone(app.wire[0].paymentPayload);
    expect(await app.dispatch(injected)).toMatchObject({ type: "payment-error" });
    expect(app.wire).toHaveLength(1);
  });

  it("rejects plain upstream requests without an authenticated independent binding", async () => {
    const app = await setup();
    const payment = await app.makePayment();
    expect(await app.mechanism.verify(payment, payment.accepted)).toMatchObject({ isValid: false });
    expect(await app.mechanism.settle(payment, payment.accepted)).toMatchObject({ success: false });
    expect(app.counts().verified).toBe(0);
  });

  it.each(["signature", "requestHash", "tenant", "requirements", "payment", "expiry"])("rejects changed %s at facilitator before backend verification", async (field) => {
    const app = await setup();
    await app.dispatch(await app.makePayment());
    const forwarded = structuredClone(app.wire[0]);
    const binding = forwarded.paymentPayload.payload[BINDING_FIELD] as Record<string, unknown>;
    if (field === "signature") binding.signature = "00".repeat(64);
    if (field === "requestHash") binding.requestHash = "00".repeat(32);
    if (field === "tenant") binding.trustedSecurityContext = { principal: "payer:1", tenant: "tenant:b" };
    if (field === "requirements") forwarded.paymentRequirements.amount = "1";
    if (field === "payment") forwarded.paymentPayload.payload.transaction = "changed";
    if (field === "expiry") app.advance(30_000);
    expect(await app.mechanism.settle(forwarded.paymentPayload, forwarded.paymentRequirements)).toMatchObject({ success: false });
    expect(app.counts().verified).toBe(1);
  });

  it("never runs the handler after settlement failure", async () => {
    const app = await setup(); app.failSettlement();
    expect(await app.dispatch(await app.makePayment())).toMatchObject({ type: "payment-error" });
    expect(app.counts().handlers).toBe(0);
  });

  it("retains an uncertain handler outcome and does not rerun it on retry", async () => {
    const app = await setup(); const payment = await app.makePayment();
    await expect(app.dispatch(payment, OPERATION, true)).rejects.toThrow("uncertain handler outcome");
    await expect(app.dispatch(payment)).rejects.toThrow("uncertain handler outcome");
    expect(app.counts()).toMatchObject({ broadcasts: 1, handlers: 1 });
  });

  it("requires an upfront invocation even when called directly", async () => {
    const app = await setup(); const payment = await app.makePayment();
    const context: SettleContext = { paymentPayload: payment, requirements: payment.accepted, declaredExtensions: {}, phase: "after-handler" };
    expect(await app.serverScheme.schemeHooks!.onBeforeSettle!(context)).toMatchObject({ abort: true });
  });
});
