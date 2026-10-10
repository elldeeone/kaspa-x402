import { describe, expect, it } from "vitest";

import {
  MemoryPublicBoundaryController,
  PublicBoundaryError,
  publicBoundaryCallerKey,
} from "../src/index.js";

const ALICE = { principal: "alice", tenant: "merchant" } as const;
const BOB = { principal: "bob", tenant: "merchant" } as const;
const ALICE_ADMISSION = "aa".repeat(32);
const BOB_ADMISSION = "bb".repeat(32);

describe("public boundary controller", () => {
  it("applies request quotas per trusted admission key and resets the window", () => {
    let now = 1_000;
    const boundary = new MemoryPublicBoundaryController(
      { callerQuota: 1, callerQuotaWindowMs: 100 },
      () => now,
    );

    boundary.enterRequest(ALICE, ALICE_ADMISSION).release();
    expect(() =>
      boundary.enterRequest({
        ...ALICE,
        authorizationScopes: ["different-request-scope"],
      }, ALICE_ADMISSION),
    ).toThrowError(
      expect.objectContaining({ reason: "caller_quota_exceeded" }),
    );
    expect(() => boundary.enterRequest(BOB, BOB_ADMISSION).release()).not.toThrow();

    now += 100;
    expect(() => boundary.enterRequest(ALICE, ALICE_ADMISSION).release()).not.toThrow();
  });

  it("charges stored challenge keys to the original caller quota", () => {
    const boundary = new MemoryPublicBoundaryController({ callerQuota: 1 });
    boundary.enterRequestKey(publicBoundaryCallerKey(ALICE)).release();
    expect(() => boundary.enterRequestKey(publicBoundaryCallerKey(ALICE)))
      .toThrowError(expect.objectContaining({ reason: "caller_quota_exceeded" }));
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

    boundary.enterRequest(ALICE, ALICE_ADMISSION).release();
    expect(() => boundary.enterRequest(BOB, BOB_ADMISSION)).toThrowError(
      expect.objectContaining({ reason: "caller_quota_exceeded" }),
    );

    now += 100;
    expect(() => boundary.enterRequest(BOB, BOB_ADMISSION).release()).not.toThrow();
  });

  it("bounds global, caller, and channel concurrency without leaking permits", () => {
    const global = new MemoryPublicBoundaryController({
      maxGlobalConcurrency: 1,
      maxCallerConcurrency: 1,
    });
    const request = global.enterRequest(ALICE, ALICE_ADMISSION);
    expect(() => global.enterRequest(BOB, BOB_ADMISSION)).toThrowError(
      expect.objectContaining({ reason: "global_concurrency_exceeded" }),
    );
    request.release();
    expect(() => global.enterRequest(BOB, BOB_ADMISSION).release()).not.toThrow();

    const caller = new MemoryPublicBoundaryController({
      maxGlobalConcurrency: 2,
      maxCallerConcurrency: 1,
    });
    const firstCaller = caller.enterRequest(ALICE, ALICE_ADMISSION);
    expect(() => caller.enterRequest(ALICE, ALICE_ADMISSION)).toThrowError(
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

    await expect(hanging).rejects.toMatchObject({
      reason: "adapter_timeout",
      status: 504,
    } satisfies Partial<PublicBoundaryError>);
    await expect(
      boundary.runAdapter("chain-provider", async () => "blocked"),
    ).rejects.toMatchObject({
      reason: "adapter_concurrency_exceeded",
    } satisfies Partial<PublicBoundaryError>);

    finish();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await expect(
      boundary.runAdapter("chain-provider", async () => "released"),
    ).resolves.toBe("released");
  });

  it("aborts cooperative adapters on timeout and parent cancellation", async () => {
    const boundary = new MemoryPublicBoundaryController({
      maxAdapterConcurrency: 1,
      adapterTimeoutMs: 10,
    });
    let timedOutSignal: AbortSignal | undefined;
    await expect(boundary.runAdapter("cooperative", (signal) =>
      new Promise<void>((_resolve, reject) => {
        timedOutSignal = signal;
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }))).rejects.toMatchObject({ reason: "adapter_timeout" });
    expect(timedOutSignal?.aborted).toBe(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await expect(boundary.runAdapter("cooperative", async () => "released"))
      .resolves.toBe("released");

    const parent = new AbortController();
    let parentSignal: AbortSignal | undefined;
    const pending = boundary.runAdapter("parent", (signal) =>
      new Promise<void>((_resolve, reject) => {
        parentSignal = signal;
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }), parent.signal);
    await Promise.resolve();
    parent.abort(new Error("caller left"));
    await expect(pending).rejects.toThrow("caller left");
    expect(parentSignal?.aborted).toBe(true);
  });
});
