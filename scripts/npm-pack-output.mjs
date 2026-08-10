function isPackageRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeNpmPackOutput(output) {
  if (Array.isArray(output)) {
    if (output.length === 0) {
      throw new Error("npm pack output did not contain any package records");
    }
    for (const record of output) {
      if (!isPackageRecord(record) || typeof record.name !== "string") {
        throw new Error("npm pack array contained an invalid package record");
      }
    }
    return output;
  }

  if (!isPackageRecord(output)) {
    throw new Error("npm pack output was not an array or keyed package map");
  }

  const entries = Object.entries(output);
  if (entries.length === 0) {
    throw new Error("npm pack output did not contain any package records");
  }
  for (const [key, record] of entries) {
    if (!isPackageRecord(record) || typeof record.name !== "string") {
      throw new Error(`npm pack map contained an invalid record for ${key}`);
    }
    if (key !== record.name) {
      throw new Error(
        `npm pack map key ${key} did not match package name ${record.name}`,
      );
    }
  }
  return entries.map(([, record]) => record);
}
