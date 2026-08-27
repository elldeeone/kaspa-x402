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
  if (!usesCompleteMetadataHash(release.version)) {
    return {
      version: release.version,
      sourceState: "locked",
      dirtyInputs: [],
      contentLock: release.contentLock,
      snapshotScope: release.snapshotScope,
      activeAlphaOnlyRoutes: release.activeAlphaOnlyRoutes,
      unversionedRoutes: release.unversionedRoutes,
      npmInstall: release.npmInstall,
      artifacts: release.artifacts,
    };
  }
  return { ...release, contentSha256: "<content-sha256>" };
}

export function usesCompleteMetadataHash(version) {
  return compareVersions(version, "0.1.0-alpha.11") >= 0;
}

function compareVersions(left, right) {
  return String(left).localeCompare(String(right), "en", { numeric: true });
}
