/** Local compatibility experiment. Not a published Kaspa wire profile. */
import { sign, verify, type KeyObject } from "node:crypto";
import {
  bindRequestHashToTrustedContext,
  sha256Hex,
  stableStringify,
  validateKaspaPaymentRequirement,
  validatePaymentPayload,
  type ExactPaymentRequirements,
  type PaymentPayload as KaspaPaymentPayload,
  type TrustedSecurityContext,
} from "@kaspa-x402/core";
import type {
  DeepReadonly,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SchemeNetworkClient,
  SchemeNetworkServer,
  SettleContext,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";

export const BINDING_FIELD = "kaspaServerBinding";
const VERSION = "kaspa-x402-server-binding-prototype-v1";
const TTL_MS = 30_000;

/** The host supplies this from the actual operation and authenticated claims. */
export interface Operation {
  method: string;
  url: string;
  body: unknown;
  trustedSecurityContext?: TrustedSecurityContext;
}

export function requestHash(operation: Operation, accepted: PaymentRequirements): string {
  // Keep the existing DirectMode preimage. No hash is inserted in requirements.
  return sha256Hex(stableStringify({
    method: operation.method,
    url: operation.url,
    body: operation.body,
    ...(accepted.extra.binding === "kaspa-hash-chain-exact-v1"
      ? {}
      : { paymentRequirementsHash: sha256Hex(stableStringify(accepted)) }),
  }));
}

export function boundRequestHash(operation: Operation, accepted: PaymentRequirements): string {
  return bindRequestHashToTrustedContext(requestHash(operation, accepted), operation.trustedSecurityContext);
}

/** One instance per operation: core's client hook does not receive its body. */
export function createClientScheme(
  operation: Operation,
  buildPayment: (requirements: ExactPaymentRequirements, hash: string) => Promise<KaspaPaymentPayload>,
): SchemeNetworkClient {
  const intent = structuredClone(operation);
  return {
    scheme: "exact",
    async createPaymentPayload(version, requirements) {
      if (version !== 2) throw new Error("x402 v2 required");
      const payment = await buildPayment(exactRequirements(requirements), boundRequestHash(intent, requirements));
      exactPayment(payment, requirements);
      if (payment.payload.requestHash !== boundRequestHash(intent, requirements)) {
        throw new Error("wallet returned a different request binding");
      }
      return { x402Version: 2, payload: payment.payload, extensions: payment.extensions };
    },
  };
}

function exactRequirements(value: PaymentRequirements): ExactPaymentRequirements {
  const result = validateKaspaPaymentRequirement(value);
  if (!result.ok) throw result.error;
  if (result.value.scheme !== "exact") throw new Error("exact requirements required");
  return result.value;
}

function exactPayment(value: DeepReadonly<PaymentPayload>, requirements: PaymentRequirements): KaspaPaymentPayload {
  exactRequirements(requirements);
  const result = validatePaymentPayload(value);
  if (!result.ok) throw result.error;
  if (result.value.payload.type !== "exact-transaction" ||
      stableStringify(value.accepted) !== stableStringify(requirements)) {
    throw new Error("payment does not match selected exact requirements");
  }
  return result.value;
}

export function createServerScheme(config: {
  privateKey: KeyObject;
  audience: string;
  resolveOperation: (context: SettleContext) => Operation;
  now?: () => number;
}): SchemeNetworkServer {
  const now = config.now ?? Date.now;
  function checkedOperation(context: SettleContext): Operation {
    if (context.phase !== "before-handler") throw new Error("upfront settlement required");
    // Core hooks expose readonly values. Clone before entering local validators.
    const payment = exactPayment(structuredClone(context.paymentPayload), structuredClone(context.requirements));
    if (BINDING_FIELD in payment.payload) throw new Error("payer supplied server binding");
    const operation = config.resolveOperation(context);
    if (boundRequestHash(operation, structuredClone(context.requirements)) !==
        String(payment.payload.requestHash).toLowerCase()) {
      throw new Error("request binding mismatch");
    }
    return operation;
  }
  return {
    scheme: "exact",
    defaultAssetTransferMethod: "default",
    paymentFlows: {
      default: { supported: ["upfront"], default: "upfront" },
      "kaspa-v1-hash-chain-proof": { supported: ["upfront"], default: "upfront" },
    },
    async parsePrice(price) {
      if (typeof price !== "object" || price.asset !== "KAS") {
        throw new Error("use an explicit atomic KAS amount");
      }
      return price;
    },
    async enhancePaymentRequirements(requirements) {
      exactRequirements(requirements);
      return requirements;
    },
    schemeHooks: {
      async onBeforeSettle(context) {
        try {
          checkedOperation(context);
        } catch (error) {
          // Upstream logs ordinary hook throws and continues. Return abort.
          return { abort: true, reason: "invalid_request_binding", message: String(error) };
        }
      },
    },
    async enrichSettlementPayload(context) {
      const operation = checkedOperation(context);
      const statement = {
        version: VERSION,
        audience: config.audience,
        expiresAt: now() + TTL_MS,
        paymentHash: sha256Hex(stableStringify(context.paymentPayload)),
        requirementsHash: sha256Hex(stableStringify(context.requirements)),
        requestHash: requestHash(operation, structuredClone(context.requirements)),
        ...(operation.trustedSecurityContext
          ? { trustedSecurityContext: operation.trustedSecurityContext }
          : {}),
      };
      return {
        [BINDING_FIELD]: {
          ...statement,
          signature: sign(null, Buffer.from(stableStringify(statement)), config.privateKey).toString("hex"),
        },
      };
    },
  };
}

export interface BoundPayment {
  paymentPayload: KaspaPaymentPayload;
  paymentRequirements: ExactPaymentRequirements;
  /** Independent raw hash; backend applies trustedSecurityContext exactly once. */
  requestHash: string;
  trustedSecurityContext?: TrustedSecurityContext;
}

export interface ExactBackend {
  verify(input: BoundPayment): Promise<VerifyResponse>;
  settle(input: BoundPayment): Promise<SettleResponse>;
}

export function createFacilitatorScheme(config: {
  publicKey: KeyObject;
  audience: string;
  payTo: string;
  backend: ExactBackend;
  now?: () => number;
}): SchemeNetworkFacilitator {
  const now = config.now ?? Date.now;
  function authenticate(payment: PaymentPayload, requirements: PaymentRequirements): BoundPayment {
    const { [BINDING_FIELD]: binding, ...payload } = payment.payload;
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
      throw new Error("missing server binding");
    }
    const { signature, ...statement } = binding as Record<string, unknown>;
    const cleanPayment = { ...payment, payload };
    if (typeof signature !== "string" || !/^[0-9a-f]{128}$/.test(signature) ||
        !verify(null, Buffer.from(stableStringify(statement)), config.publicKey, Buffer.from(signature, "hex"))) {
      throw new Error("invalid server signature");
    }
    if (statement.version !== VERSION || statement.audience !== config.audience ||
        requirements.network !== "kaspa:testnet-10" || requirements.payTo !== config.payTo ||
        typeof statement.expiresAt !== "number" || !Number.isSafeInteger(statement.expiresAt) ||
        statement.expiresAt <= now() || statement.expiresAt > now() + TTL_MS ||
        statement.paymentHash !== sha256Hex(stableStringify(cleanPayment)) ||
        statement.requirementsHash !== sha256Hex(stableStringify(requirements)) ||
        typeof statement.requestHash !== "string") {
      throw new Error("invalid server binding");
    }
    const validated = exactPayment(cleanPayment, requirements);
    // Trusted only after authenticating the pinned resource server's statement.
    const context = statement.trustedSecurityContext as TrustedSecurityContext | undefined;
    if (bindRequestHashToTrustedContext(statement.requestHash, context) !==
        String(validated.payload.requestHash).toLowerCase()) {
      throw new Error("request binding mismatch");
    }
    return {
      paymentPayload: validated,
      paymentRequirements: exactRequirements(requirements),
      requestHash: statement.requestHash,
      ...(context ? { trustedSecurityContext: context } : {}),
    };
  }
  return {
    scheme: "exact",
    caipFamily: "kaspa:*",
    getExtra: () => ({ profiles: ["standard-native", "additive", "hash-chain-additive"] }),
    getSigners: () => [],
    async verify(payment, requirements) {
      let input: BoundPayment;
      try { input = authenticate(payment, requirements); }
      catch { return { isValid: false, invalidReason: "invalid_request_binding" }; }
      return config.backend.verify(input);
    },
    async settle(payment, requirements) {
      let input: BoundPayment;
      try { input = authenticate(payment, requirements); }
      catch {
        return { success: false, errorReason: "invalid_request_binding", transaction: "", network: requirements.network };
      }
      // Preserve backend failures, including indeterminate chain outcomes.
      return config.backend.settle(input);
    },
  };
}
