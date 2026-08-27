const RELEASE_METADATA_KEYS = new Set([
  "version",
  "generatedFrom",
  "commitDate",
  "sourceState",
  "dirtyInputs",
  "contentLock",
  "snapshotScope",
  "activeAlphaOnlyRoutes",
  "unversionedRoutes",
  "npmInstall",
  "artifacts",
  "contentSha256",
]);

export function releaseMetadataForHash(release) {
  if (!release || typeof release !== "object" || Array.isArray(release))
    throw new Error("release metadata must be an object");
  const unknown = Object.keys(release).filter(
    (key) => !RELEASE_METADATA_KEYS.has(key),
  );
  if (unknown.length > 0)
    throw new Error(
      `release metadata contains unknown fields: ${unknown.join(", ")}`,
    );
  return { ...release, contentSha256: "<content-sha256>" };
}
