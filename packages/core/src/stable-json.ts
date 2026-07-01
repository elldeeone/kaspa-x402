export function stableStringify(value: unknown): string {
  return stringifyJson(value, "$");
}

function stringifyJson(value: unknown, path: string): string {
  if (value === null) return "null";

  if (Array.isArray(value)) {
    return `[${value.map((item, index) => stringifyJson(item, `${path}[${index}]`)).join(",")}]`;
  }

  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must be a plain JSON object`);
    }

    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stringifyJson(record[key], `${path}.${key}`)}`)
      .join(",")}}`;
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }

  throw new TypeError(`${path} is not JSON-serializable`);
}
