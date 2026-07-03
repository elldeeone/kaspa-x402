import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
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

const actualArchiveSha256 = sha256File(archivePath);
if (actualArchiveSha256 !== archiveSha256) {
  throw new Error(`kaspa-wasm archive hash mismatch: expected ${archiveSha256}, got ${actualArchiveSha256}`);
}

for (const asset of VENDORED_KASPA_WASM.files) {
  const localPath = path.join(root, asset.source);
  const member = `kaspa-wasm32-sdk/${source.packagePath}/${path.basename(asset.source)}`;
  const archiveBytes = execFileSync("unzip", ["-p", archivePath, member], { maxBuffer: 128 * 1024 * 1024 });
  const archiveAssetSha256 = sha256(archiveBytes);
  const localAssetSha256 = sha256File(localPath);
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

function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function download(url, target, redirects = 0) {
  if (redirects > 5) throw new Error(`too many redirects while downloading ${url}`);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
        response.resume();
        download(new URL(response.headers.location, url).toString(), target, redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`download failed for ${url}: HTTP ${response.statusCode}`));
        return;
      }
      const temp = `${target}.tmp-${process.pid}`;
      const file = fs.createWriteStream(temp, { flags: "wx" });
      file.on("error", reject);
      file.on("finish", () => {
        file.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          fs.rename(temp, target, (renameError) => (renameError ? reject(renameError) : resolve()));
        });
      });
      response.pipe(file);
    });
    request.on("error", reject);
  });
}
