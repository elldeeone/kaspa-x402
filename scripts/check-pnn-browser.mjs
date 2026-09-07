import { sanitizeProofOutputText } from "./proof-output-security.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sdkDir = path.join(root, "site/src/vendor/kaspa-wasm/2.0.0/kaspa-core");
const timeoutMs = Number(process.env.KASPA_X402_PNN_TIMEOUT_MS ?? 15_000);
const attempts = Number(process.env.KASPA_X402_PNN_ATTEMPTS ?? 3);
const networkId = "testnet-10";

try { await main(); process.exit(0); } catch (error) {
  console.error(sanitizeProofOutputText(error instanceof Error ? error.message : String(error)));
  process.exit(1);
}

async function main() {
const sdk = await import(pathToFileUrl(path.join(sdkDir, "kaspa.js")));
const wasm = fs.readFileSync(path.join(sdkDir, "kaspa_bg.wasm"));
sdk.initSync(wasm);

const privateKey = new sdk.PrivateKey("1".repeat(64));
const address = privateKey.toAddress(networkId).toString();
const endpoint =
  process.env.KASPA_X402_PNN_ENDPOINT ??
  (await withRetries("resolver lookup", async () => {
    const resolver = new sdk.Resolver();
    return withTimeout(
      resolver.getUrl(sdk.Encoding.Borsh, networkId),
      "resolver lookup",
    );
  }));
const rpc = new sdk.RpcClient({
  url: endpoint,
  networkId,
  encoding: sdk.Encoding.Borsh,
});

try {
  await withRetries("rpc connect", () =>
    withTimeout(rpc.connect(), "rpc connect"),
  );
  const [serverInfo, blockDagInfo, utxos] = await Promise.all([
    withRetries("getServerInfo", () =>
      withTimeout(rpc.getServerInfo(), "getServerInfo"),
    ),
    withRetries("getBlockDagInfo", () =>
      withTimeout(rpc.getBlockDagInfo(), "getBlockDagInfo"),
    ),
    withRetries("getUtxosByAddresses", () =>
      withTimeout(rpc.getUtxosByAddresses([address]), "getUtxosByAddresses"),
    ),
  ]);
  console.log(
    sanitizeProofOutputText(JSON.stringify(
      {
        ok: true,
        sdk: { package: "kaspa-wasm", version: sdk.version() },
        network: "kaspa:testnet-10",
        endpoint,
        serverInfo,
        blockDagInfo,
        address,
        utxoEntryCount: Array.isArray(utxos?.entries)
          ? utxos.entries.length
          : undefined,
      },
      bigintReplacer,
      2,
    )),
  );
} finally {
  try {
    await withTimeout(rpc.disconnect(), "rpc disconnect");
  } catch {
    // Nothing else can be done if connect failed or websocket cleanup stalls.
  }
}

// The vendored WASM SDK may retain background websocket handles after a clean
// disconnect. This is a standalone diagnostic, so terminate once its bounded
// work and cleanup have completed.


}

function withTimeout(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

async function withRetries(label, task) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(500 * attempt);
    }
  }
  throw new Error(
    sanitizeProofOutputText(`${label} failed after ${attempts} attempts: ${lastError?.message ?? lastError}`),
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pathToFileUrl(file) {
  return new URL(`file://${file}`).href;
}

function bigintReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}
