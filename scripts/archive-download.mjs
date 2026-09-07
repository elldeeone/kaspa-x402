import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

export async function sha256File(file, maximumBytes = MAX_ARCHIVE_BYTES) {
  const hash = crypto.createHash("sha256");
  let size = 0;
  for await (const chunk of fs.createReadStream(file)) {
    size += chunk.length;
    if (size > maximumBytes) throw new Error("archive exceeds the size limit");
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function download(url, target, { maximumBytes = MAX_ARCHIVE_BYTES, timeoutMs = 120_000, get = https.get } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const directory = await fs.promises.mkdtemp(path.join(path.dirname(target), ".archive-"));
  const temporary = path.join(directory, "download");
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (new URL(url).protocol !== "https:") throw new Error("archive downloads require HTTPS");
      const response = await new Promise((resolve, reject) => {
        const request = get(url, { signal }, resolve);
        request.on("error", reject);
      });
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.destroy();
        url = new URL(response.headers.location, url).href;
        continue;
      }
      if (response.statusCode !== 200) {
        response.destroy();
        throw new Error(`archive download failed: HTTP ${response.statusCode}`);
      }
      let size = 0;
      const limit = new Transform({ transform(chunk, encoding, callback) {
        size += chunk.length;
        callback(size > maximumBytes ? new Error("archive exceeds the size limit") : null, chunk);
      } });
      await pipeline(response, limit, fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 }), { signal });
      await fs.promises.rename(temporary, target);
      return;
    }
    throw new Error("too many archive redirects");
  } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
}
