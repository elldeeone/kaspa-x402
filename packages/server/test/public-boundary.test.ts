import { describe, expect, it } from "vitest";

import {
  MemoryPublicBoundaryController,
  PublicBoundaryError,
} from "../src/index.js";

const ALICE = { principal: "alice", tenant: "merchant" } as const;
const BOB = { principal: "bob", tenant: "merchant" } as const;

describe("public boundary controller", () => {
  it("applies request quotas per authenticated caller and resets the window", () => {
    let now = 1_000;
    const boundary = new MemoryPublicBoundaryController(
      { callerQuota: 1, callerQuotaWindowMs: 100 },
      () => now,
    );

    boundary.enterRequest(ALICE).release();
    expect(() =>
      boundary.enterRequest({
        ...ALICE,
        authorizationScopes: ["different-request-scope"],
      }),
    ).toThrowError(
      expect.objectContaining({ reason: "caller_quota_exceeded" }),
    );
    expect(() => boundary.enterRequest(BOB).release()).not.toThrow();

    now += 100;
    expect(() => boundary.enterRequest(ALICE).release()).not.toThrow();
  });

  it("bounds tracked callers and reclaims expired quota windows", () => {
    let now = 1_000;
    const boundary = new MemoryPublicBoundaryController(
      {
        callerQuota: 2,
        callerQuotaWindowMs: 100,
        maxTrackedCallers: 1,
      },
      () => now,
    );

    boundary.enterRequest(ALICE).release();
    expect(() => boundary.enterRequest(BOB)).toThrowError(
      expect.objectContaining({ reason: "caller_quota_exceeded" }),
    );

    now += 100;
    expect(() => boundary.enterRequest(BOB).release()).not.toThrow();
  });

  it("bounds global, caller, and channel concurrency without leaking permits", () => {
    const global = new MemoryPublicBoundaryController({
      maxGlobalConcurrency: 1,
      maxCallerConcurrency: 1,
    });
    const request = global.enterRequest(ALICE);
    expect(() => global.enterRequest(BOB)).toThrowError(
      expect.objectContaining({ reason: "global_concurrency_exceeded" }),
    );
    request.release();
    expect(() => global.enterRequest(BOB).release()).not.toThrow();

    const caller = new MemoryPublicBoundaryController({
      maxGlobalConcurrency: 2,
      maxCallerConcurrency: 1,
    });
    const firstCaller = caller.enterRequest(ALICE);
    expect(() => caller.enterRequest(ALICE)).toThrowError(
      expect.objectContaining({ reason: "caller_concurrency_exceeded" }),
    );
    firstCaller.release();

    const channel = new MemoryPublicBoundaryController({
      maxChannelConcurrency: 1,
    });
    const firstChannel = channel.enterChannel("channel-a");
    expect(() => channel.enterChannel("channel-a")).toThrowError(
      expect.objectContaining({ reason: "channel_concurrency_exceeded" }),
    );
    expect(() => channel.enterChannel("channel-b").release()).not.toThrow();
    firstChannel.release();
  });

  it("times out adapters while retaining capacity until timed-out work settles", async () => {
    const boundary = new MemoryPublicBoundaryController({
      maxAdapterConcurrency: 1,
      adapterTimeoutMs: 10,
    });
    let finish!: () => void;
    const hanging = boundary.runAdapter(
      "chain-provider",
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );

    await expect(hanging).rejects.toMatchObject<Partial<PublicBoundaryError>>({
      reason: "adapter_timeout",
      status: 504,
    });
    await expect(
      boundary.runAdapter("chain-provider", async () => "blocked"),
    ).rejects.toMatchObject<Partial<PublicBoundaryError>>({
      reason: "adapter_concurrency_exceeded",
    });

    finish();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await expect(
      boundary.runAdapter("chain-provider", async () => "released"),
    ).resolves.toBe("released");
  });
});
