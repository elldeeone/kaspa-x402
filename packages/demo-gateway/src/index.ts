import { DurableObject } from "cloudflare:workers";
import { KASPA_X402_RESOURCE_BUDGET } from "@kaspa-x402/core";
import {
  handleGatewayRequest,
  readRequestJsonWithLimit,
  runGatewayCanary,
} from "./gateway.js";
import { readGatewayConfig, type GatewayEnv } from "./config.js";
import { HashChainDemoService, type HashChainHeadRegistration } from "./hash-chain-service.js";
import {
  dispatchGatewayState,
  GatewayLedger,
  type GatewayPublicAdmissionResult,
  type GatewayStateRequest,
  type GatewayStorage,
} from "./state.js";

export class GatewayState extends DurableObject<GatewayEnv> {
  readonly #ledger: GatewayLedger;
  #hashChain?: HashChainDemoService;

  constructor(ctx: DurableObjectState, env: GatewayEnv) {
    super(ctx, env);
    this.#ledger = new GatewayLedger(ctx.storage as GatewayStorage);
  }

  #hashChainService(): HashChainDemoService {
    return this.#hashChain ??= new HashChainDemoService(this.ctx.storage,
      this.#ledger, readGatewayConfig(this.env));
  }

  registerHashChainHead(input: HashChainHeadRegistration) {
    return this.#hashChainService().register(input);
  }

  hashChainHead() {
    return this.#hashChainService().current() ?? null;
  }

  acquirePublicAdmission(
    token: string,
    callerKey: string,
    nowMs: number,
    globalLimit: number,
    callerLimit: number,
    ttlMs: number,
  ): Promise<GatewayPublicAdmissionResult> {
    return this.#ledger.acquirePublicAdmission(token, callerKey, nowMs, globalLimit, callerLimit, ttlMs);
  }

  renewPublicAdmission(
    token: string,
    callerKey: string,
    nowMs: number,
    ttlMs: number,
  ): Promise<boolean> {
    return this.#ledger.renewPublicAdmission(token, callerKey, nowMs, ttlMs);
  }

  releasePublicAdmission(token: string): Promise<void> {
    return this.#ledger.releasePublicAdmission(token);
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/hash-chain" || path.startsWith("/hash-chain/"))
      return this.#hashChainService().fetch(request);
    if (request.method !== "POST")
      return new Response("method not allowed", { status: 405 });
    let payload: GatewayStateRequest;
    try {
      payload = await readRequestJsonWithLimit<GatewayStateRequest>(
        request,
        KASPA_X402_RESOURCE_BUDGET.maxDecodedHeaderBytes,
        "gateway state",
      );
    } catch (error) {
      return Response.json(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        { status: 400 },
      );
    }
    try {
      const value = await dispatchGatewayState(this.#ledger, payload, request.signal);
      return Response.json({ ok: true, value });
    } catch (error) {
      return Response.json(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        { status: 500 },
      );
    }
  }
}

export default {
  async fetch(
    request: Request,
    env: GatewayEnv,
    context: ExecutionContext,
  ): Promise<Response> {
    return handleGatewayRequest(request, env, context);
  },
  async scheduled(
    _event: ScheduledController,
    env: GatewayEnv,
    context: ExecutionContext,
  ): Promise<void> {
    context.waitUntil(runGatewayCanary(env, "scheduled"));
  },
};
