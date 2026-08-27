export function assertReleaseLocalSchema(schema, expectedId) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    throw new Error("release schema must be an object");
  if (schema.$id !== expectedId)
    throw new Error(`release schema id must be ${expectedId}`);
  const expectedPrefix = new URL(".", expectedId).href;
  visit(schema, (key, value) => {
    if (key !== "$ref" && key !== "$dynamicRef") return;
    if (typeof value !== "string")
      throw new Error(`${key} must be a string`);
    let resolved;
    try {
      resolved = new URL(value, expectedId).href;
    } catch {
      throw new Error(`${key} is not a valid URL reference`);
    }
    if (!resolved.startsWith(expectedPrefix))
      throw new Error(`${key} escapes release-local schemas: ${value}`);
  });
}

function visit(value, inspect) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) visit(item, inspect);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    inspect(key, item);
    visit(item, inspect);
  }
}
