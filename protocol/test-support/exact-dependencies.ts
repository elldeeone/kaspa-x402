// Deny accidental batch dependency access, including accesses that optional checks might hide.
export function restrict<T extends object>(target: T, allowed: readonly string[]): T {
  return new Proxy(target, {
    get(target, key) {
      if (typeof key === "string" && !allowed.includes(key))
        throw new Error(`unexpected batch dependency: ${key}`);
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
