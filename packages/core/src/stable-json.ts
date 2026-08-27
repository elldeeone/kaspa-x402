export interface StableJsonLimits {
  maxDepth?: number;
  maxNodes?: number;
  maxObjectKeys?: number;
  maxOutputBytes?: number;
}

const DEFAULT_LIMITS = {
  maxDepth: 64,
  maxNodes: 100_000,
  maxObjectKeys: 4_096,
  maxOutputBytes: 1_048_576,
} as const;

type Frame =
  | { kind: "value"; value: unknown; path: string; depth: number }
  | { kind: "text"; text: string }
  | { kind: "leave"; value: object };

/** Deterministic, work-budgeted JSON serialization without recursive descent. */
export function stableStringify(
  value: unknown,
  limits: StableJsonLimits = {},
): string {
  const budget = {
    maxDepth: limits.maxDepth ?? DEFAULT_LIMITS.maxDepth,
    maxNodes: limits.maxNodes ?? DEFAULT_LIMITS.maxNodes,
    maxObjectKeys: limits.maxObjectKeys ?? DEFAULT_LIMITS.maxObjectKeys,
    maxOutputBytes: limits.maxOutputBytes ?? DEFAULT_LIMITS.maxOutputBytes,
  };
  for (const [name, amount] of Object.entries(budget)) {
    if (!Number.isInteger(amount) || amount <= 0)
      throw new RangeError(`${name} must be a positive integer`);
  }

  const encoder = new TextEncoder();
  const output: string[] = [];
  const active = new WeakSet<object>();
  const stack: Frame[] = [{ kind: "value", value, path: "$", depth: 0 }];
  let nodes = 0;
  let outputBytes = 0;

  const append = (text: string) => {
    outputBytes += encoder.encode(text).byteLength;
    if (outputBytes > budget.maxOutputBytes)
      throw new RangeError("stable JSON output exceeds the byte limit");
    output.push(text);
  };

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === "text") {
      append(frame.text);
      continue;
    }
    if (frame.kind === "leave") {
      active.delete(frame.value);
      continue;
    }

    nodes += 1;
    if (nodes > budget.maxNodes)
      throw new RangeError("stable JSON input exceeds the node limit");
    if (frame.depth > budget.maxDepth)
      throw new RangeError(`${frame.path} exceeds the JSON depth limit`);

    const current = frame.value;
    if (current === null) {
      append("null");
      continue;
    }
    if (typeof current === "string" || typeof current === "boolean") {
      append(JSON.stringify(current));
      continue;
    }
    if (typeof current === "number" && Number.isFinite(current)) {
      append(JSON.stringify(current));
      continue;
    }
    if (typeof current !== "object")
      throw new TypeError(`${frame.path} is not JSON-serializable`);
    if (active.has(current))
      throw new TypeError(`${frame.path} contains a JSON cycle`);

    active.add(current);
    stack.push({ kind: "leave", value: current });
    if (Array.isArray(current)) {
      stack.push({ kind: "text", text: "]" });
      for (let index = current.length - 1; index >= 0; index -= 1) {
        stack.push({
          kind: "value",
          value: current[index],
          path: `${frame.path}[${index}]`,
          depth: frame.depth + 1,
        });
        if (index > 0) stack.push({ kind: "text", text: "," });
      }
      stack.push({ kind: "text", text: "[" });
      continue;
    }

    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError(`${frame.path} must be a plain JSON object`);
    const record = current as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.length > budget.maxObjectKeys)
      throw new RangeError(`${frame.path} exceeds the object-key limit`);
    stack.push({ kind: "text", text: "}" });
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]!;
      stack.push({
        kind: "value",
        value: record[key],
        path: `${frame.path}.${key}`,
        depth: frame.depth + 1,
      });
      stack.push({ kind: "text", text: ":" });
      stack.push({ kind: "text", text: JSON.stringify(key) });
      if (index > 0) stack.push({ kind: "text", text: "," });
    }
    stack.push({ kind: "text", text: "{" });
  }

  return output.join("");
}
