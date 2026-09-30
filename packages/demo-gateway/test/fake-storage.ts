import type { GatewayStorage } from "../src/state.js";

export class FakeStorage implements GatewayStorage {
  #values = new Map<string, unknown>();
  #transactionTail: Promise<void> = Promise.resolve();
  #failWriteAt: number | undefined;
  #writes = 0;

  failWriteAt(index: number): void {
    this.#failWriteAt = index;
    this.#writes = 0;
  }

  snapshot(): Map<string, unknown> {
    return structuredClone(this.#values);
  }

  #beforeWrite(): void {
    if (++this.#writes === this.#failWriteAt) {
      this.#failWriteAt = undefined;
      throw new Error("injected storage write failure");
    }
  }

  readonly listRequests: Array<{
    prefix?: string;
    start?: string;
    end?: string;
    limit?: number;
  }> = [];

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return structuredClone(this.#values.get(key) as T | undefined);
  }

  async put<T = unknown>(key: string, value: T): Promise<void> {
    this.#beforeWrite();
    this.#values.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<boolean> {
    this.#beforeWrite();
    return this.#values.delete(key);
  }

  async list<T = unknown>(options: {
    prefix?: string;
    start?: string;
    end?: string;
    limit?: number;
  }): Promise<Map<string, T>> {
    this.listRequests.push({ ...options });
    const result = new Map<string, T>();
    const entries = Array.from(this.#values.entries()).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    for (const [key, value] of entries) {
      if (options.prefix && !key.startsWith(options.prefix)) continue;
      if (options.start && key < options.start) continue;
      if (options.end && key >= options.end) continue;
      result.set(key, structuredClone(value) as T);
      if (options.limit !== undefined && result.size >= options.limit) break;
    }
    return result;
  }

  async transaction<T>(
    closure: (txn: GatewayStorage) => Promise<T>,
  ): Promise<T> {
    const previous = this.#transactionTail;
    let release!: () => void;
    this.#transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const snapshot = structuredClone(Array.from(this.#values.entries()));
    try {
      return await closure(this);
    } catch (error) {
      this.#values = new Map(snapshot);
      throw error;
    } finally {
      release();
    }
  }
}
