import { describe, expect, it } from "vitest";

import { MemoryChannelLockManager } from "../src/index.js";

const KEY = "11".repeat(32);
const OTHER_KEY = "22".repeat(32);

describe("server runtime lock contract", () => {
  it("serializes work for the same key and releases after failure", async () => {
    const lock = new MemoryChannelLockManager();
    const order: string[] = [];
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstReady = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const first = lock.runExclusive(KEY, async () => {
      order.push("first:start");
      firstStarted();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first:end");
    });
    await firstReady;

    let secondStarted = false;
    const second = lock.runExclusive(KEY, async () => {
      secondStarted = true;
      order.push("second");
    });
    await Promise.resolve();
    expect(secondStarted).toBe(false);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);

    await expect(
      lock.runExclusive(KEY, async () => {
        throw new Error("lock body failed");
      }),
    ).rejects.toThrow("lock body failed");
    await expect(lock.runExclusive(KEY, async () => "released")).resolves.toBe("released");
  });

  it("allows different keys to run concurrently", async () => {
    const lock = new MemoryChannelLockManager();
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstReady = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const first = lock.runExclusive(KEY, async () => {
      firstStarted();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    });
    await firstReady;

    let secondStarted = false;
    const second = lock.runExclusive(OTHER_KEY, async () => {
      secondStarted = true;
    });
    await second;
    expect(secondStarted).toBe(true);
    releaseFirst();
    await first;
  });
});
