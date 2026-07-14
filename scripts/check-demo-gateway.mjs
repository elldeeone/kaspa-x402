import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { decodePaymentRequiredHeader } from "../packages/core/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gatewayDir = path.join(root, "packages/demo-gateway");
const timeoutMs = Number(
  process.env.KASPA_X402_GATEWAY_SMOKE_TIMEOUT_MS ?? 45_000,
);
const port = Number(
  process.env.KASPA_X402_GATEWAY_SMOKE_PORT ?? (await openPort()),
);
const base = `http://127.0.0.1:${port}`;
const output = [];

const child = spawn(
  "npx",
  [
    "wrangler",
    "dev",
    "--config",
    "wrangler.jsonc",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
  ],
  {
    cwd: gatewayDir,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  },
);

child.stdout.on("data", (chunk) => output.push(chunk.toString()));
child.stderr.on("data", (chunk) => output.push(chunk.toString()));

try {
  await waitForReady();
  const result = await smokeGateway(base);
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
} finally {
  await stopChild(child);
}

async function smokeGateway(baseUrl) {
  const health = await getJson(`${baseUrl}/health`);
  const canary = await getJson(`${baseUrl}/canary`);
  const supported = await getJson(`${baseUrl}/supported`);
  const exact = await fetch(`${baseUrl}/exact`);
  const exactRequired = decodePaymentRequiredHeader(
    exact.headers.get("PAYMENT-REQUIRED"),
  );
  const batch = await fetch(`${baseUrl}/batch`);
  const batchRequired = decodePaymentRequiredHeader(
    batch.headers.get("PAYMENT-REQUIRED"),
  );
  const unsupportedHeader = btoa(
    JSON.stringify({
      x402Version: 2,
      accepted: { scheme: "evm", network: "eip155:1" },
      payload: {},
    }),
  );
  const unsupported = await getJson(`${baseUrl}/batch`, {
    headers: { "PAYMENT-SIGNATURE": unsupportedHeader },
  });
  const head = await fetch(`${baseUrl}/batch`, { method: "HEAD" });

  assert(
    health.status === 200 && health.body.ok === true,
    "health endpoint failed",
  );
  assert(health.body.enabled === true, "health did not report enabled gateway");
  assert(
    canary.status === 200 && canary.body.ok === true,
    "canary endpoint failed",
  );
  assert(
    health.body.chain?.networkName === "kaspa-testnet-10",
    `unexpected network ${health.body.chain?.networkName}`,
  );
  assert(
    exact.status === 402,
    `expected standard-native exact 402, got ${exact.status}`,
  );
  assert(
    exactRequired.accepts[0]?.scheme === "exact",
    "exact offer did not advertise exact",
  );
  assert(
    exactRequired.accepts[0]?.extra?.binding === "kaspa-exact-v2",
    "exact offer binding changed",
  );
  assert(
    exactRequired.accepts[0]?.extra?.profile === "standard-native",
    "exact offer profile changed",
  );
  assert(batch.status === 402, `expected batch 402, got ${batch.status}`);
  assert(
    batchRequired.accepts[0]?.scheme === "batch-settlement",
    "batch offer did not advertise batch-settlement",
  );
  assert(
    batchRequired.accepts[0]?.extra?.binding === "kaspa-escrow-v1",
    "batch offer binding changed",
  );
  assert(
    unsupported.status === 402 &&
      unsupported.body.error === "unsupported_scheme",
    "unsupported scheme was not rejected",
  );
  assert(head.status === 402, `expected HEAD 402, got ${head.status}`);
  assert(
    supported.body.enabled === true,
    "supported endpoint did not report enabled gateway",
  );
  assert(
    Array.isArray(supported.body.kinds) && supported.body.kinds.length === 2,
    "supported kinds changed",
  );

  return {
    url: baseUrl,
    health: {
      networkName: health.body.chain.networkName,
      virtualDaaScore: health.body.chain.virtualDaaScore,
    },
    supported: supported.body.kinds.map(
      (kind) => `${kind.scheme}:${kind.network}`,
    ),
    exact: {
      status: exact.status,
      profile: exactRequired.accepts[0].extra.profile,
      amount: exactRequired.accepts[0].amount,
    },
    batch: {
      scheme: batchRequired.accepts[0].scheme,
      amount: batchRequired.accepts[0].amount,
    },
    unsupported: unsupported.body.error,
  };
}

async function waitForReady() {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(
        `wrangler dev exited early with code ${child.exitCode}\n${output.join("")}`,
      );
    }
    try {
      const health = await fetch(`${base}/health`);
      if (health.status === 200) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(
    `gateway smoke timed out: ${lastError?.message ?? "not ready"}\n${output.join("")}`,
  );
}

async function getJson(url, init) {
  const response = await fetch(url, init);
  return {
    status: response.status,
    body: await response.json(),
  };
}

async function openPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (!address || typeof address === "string")
    throw new Error("could not allocate local port");
  return address.port;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalChild(child, "SIGTERM");
  const exited = await waitForExit(child, 5_000);
  if (exited || child.exitCode !== null || child.signalCode !== null) {
    closeChildPipes(child);
    return;
  }
  signalChild(child, "SIGKILL");
  await waitForExit(child, 2_000);
  closeChildPipes(child);
}

function signalChild(child, signal) {
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // Fall back to signaling the wrapper process below.
  }
  child.kill(signal);
}

function closeChildPipes(child) {
  child.stdout?.destroy();
  child.stderr?.destroy();
}

function waitForExit(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
