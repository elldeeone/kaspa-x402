import { describe, expect, it, vi } from "vitest";
import type { GatewayEnv } from "../src/config.js";
import {
  GATEWAY_STATE_OBJECT_NAME,
  RemoteGatewayState,
} from "../src/remote-state.js";

describe("remote gateway state", () => {
  it("uses a fresh Alpha.10 object identity instead of migrating old alpha state", () => {
    const idFromName = vi.fn(() => ({}) as DurableObjectId);
    const namespace = {
      idFromName,
      get: vi.fn(() => ({ fetch: vi.fn() }) as unknown as DurableObjectStub),
    } as unknown as GatewayEnv["GATEWAY_STATE"];

    new RemoteGatewayState(namespace);

    expect(GATEWAY_STATE_OBJECT_NAME).toBe("demo-gateway-alpha.10");
    expect(idFromName).toHaveBeenCalledWith(GATEWAY_STATE_OBJECT_NAME);
  });
});
