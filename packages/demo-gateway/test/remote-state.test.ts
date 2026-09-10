import { describe, expect, it, vi } from "vitest";
import type { GatewayEnv } from "../src/config.js";
import {
  GATEWAY_STATE_OBJECT_NAME,
  RemoteGatewayState,
} from "../src/remote-state.js";

describe("remote gateway state", () => {
  it("uses a fresh Alpha.11 object identity instead of migrating old alpha state", () => {
    const idFromName = vi.fn(() => ({}) as DurableObjectId);
    const namespace = {
      idFromName,
      get: vi.fn(() => ({ fetch: vi.fn() }) as unknown as DurableObjectStub),
    } as unknown as GatewayEnv["GATEWAY_STATE"];

    new RemoteGatewayState(namespace);

    expect(GATEWAY_STATE_OBJECT_NAME).toBe("demo-gateway-alpha.11");
    expect(idFromName).toHaveBeenCalledWith(GATEWAY_STATE_OBJECT_NAME);
  });

  it("uses Durable Object RPC for deployment-wide admission", async () => {
    const acquirePublicAdmission = vi.fn(async () => ({
      allowed: true,
      active: 1,
    }));
    const releasePublicAdmission = vi.fn(async () => undefined);
    const namespace = {
      idFromName: vi.fn(() => ({}) as DurableObjectId),
      get: vi.fn(() => ({
        fetch: vi.fn(),
        acquirePublicAdmission,
        releasePublicAdmission,
      })),
    } as unknown as GatewayEnv["GATEWAY_STATE"];
    const state = new RemoteGatewayState(namespace);
    const token = "00000000-0000-4000-8000-000000000001";

    await expect(
      state.acquirePublicAdmission(token, 1_000, 4, 30_000),
    ).resolves.toEqual({ allowed: true, active: 1 });
    await state.releasePublicAdmission(token);

    expect(acquirePublicAdmission).toHaveBeenCalledWith(
      token,
      1_000,
      4,
      30_000,
    );
    expect(releasePublicAdmission).toHaveBeenCalledWith(token);
  });
});
