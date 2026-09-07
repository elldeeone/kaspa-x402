import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { download, sha256File } from "./archive-download.mjs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { VENDORED_KASPA_WASM } from "./site-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = VENDORED_KASPA_WASM.source;
const archiveUrl = source.archive;
const archiveSha256 = source.archiveSha256;
const archivePath =
  process.env.KASPA_X402_KASPA_WASM_ARCHIVE ||
  path.join(os.tmpdir(), path.basename(new URL(archiveUrl).pathname));

if (!archiveUrl || !archiveSha256) {
  throw new Error("vendored kaspa-wasm provenance is missing archive and archiveSha256");
}

if (!fs.existsSync(archivePath)) {
  await download(archiveUrl, archivePath);
}

const actualArchiveSha256 = await sha256File(archivePath);
if (actualArchiveSha256 !== archiveSha256) {
  throw new Error(`kaspa-wasm archive hash mismatch: expected ${archiveSha256}, got ${actualArchiveSha256}`);
}

for (const asset of VENDORED_KASPA_WASM.files) {
  const localPath = path.join(root, asset.source);
  const member = `kaspa-wasm32-sdk/${source.packagePath}/${path.basename(asset.source)}`;
  const archiveBytes = execFileSync("unzip", ["-p", archivePath, member], { maxBuffer: 128 * 1024 * 1024 });
  const archiveAssetSha256 = sha256(archiveBytes);
  const localAssetSha256 = await sha256File(localPath);
  if (archiveAssetSha256 !== asset.sha256) {
    throw new Error(`${member} hash does not match pinned provenance: ${archiveAssetSha256}`);
  }
  if (localAssetSha256 !== asset.sha256) {
    throw new Error(`${asset.source} hash does not match pinned provenance: ${localAssetSha256}`);
  }
}

console.log(
  JSON.stringify(
    {
      ok: true,
      archive: archiveUrl,
      archiveSha256,
      files: VENDORED_KASPA_WASM.files.map((asset) => ({ path: asset.target, sha256: asset.sha256 })),
    },
    null,
    2,
  ),
);

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
