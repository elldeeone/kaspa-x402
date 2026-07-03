import { DurableObject } from "cloudflare:workers";
import { handleGatewayRequest, runGatewayCanary } from "./gateway.js";
import type { GatewayEnv } from "./config.js";
import { dispatchGatewayState, GatewayLedger, type GatewayStateRequest, type GatewayStorage } from "./state.js";

export class GatewayState extends DurableObject<GatewayEnv> {
  readonly #ledger: GatewayLedger;

  constructor(ctx: DurableObjectState, env: GatewayEnv) {
    super(ctx, env);
    this.#ledger = new GatewayLedger(ctx.storage as GatewayStorage);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    try {
      const payload = (await request.json()) as GatewayStateRequest;
      const value = await dispatchGatewayState(this.#ledger, payload);
      return Response.json({ ok: true, value });
    } catch (error) {
      return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
  }
}

export default {
  async fetch(request: Request, env: GatewayEnv, context: ExecutionContext): Promise<Response> {
    return handleGatewayRequest(request, env, context);
  },
  async scheduled(_event: ScheduledController, env: GatewayEnv, context: ExecutionContext): Promise<void> {
    context.waitUntil(runGatewayCanary(env, "scheduled"));
  },
};
