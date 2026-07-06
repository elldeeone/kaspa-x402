import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  decodePaymentRequiredHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  validatePaymentRetry,
} from "../packages/core/dist/index.js";
import { SITE_DIST } from "./site-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, SITE_DIST);
const chrome = process.env.CHROME_BIN || findChrome();
const demoConnectTimeoutMs = Number(process.env.KASPA_X402_BROWSER_CONNECT_TIMEOUT_MS ?? 75_000);
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kaspa-x402-chrome-"));
const remotePort = await openPort();
const server = await startServer();
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const chromeProcess = spawn(chrome, [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--remote-debugging-address=127.0.0.1",
  `--remote-debugging-port=${remotePort}`,
  `--user-data-dir=${userDataDir}`,
  "about:blank",
], { stdio: "ignore" });

try {
  await waitForDevtools(remotePort);
  const result = await exerciseDemo(remotePort, `${baseUrl}/demo/`);
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
} finally {
  chromeProcess.kill("SIGTERM");
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(userDataDir, { recursive: true, force: true });
}

async function exerciseDemo(port, url) {
  const target = await fetchJson(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  const events = [];

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
      return;
    }
    if (message.method === "Runtime.exceptionThrown" || message.method === "Runtime.consoleAPICalled" || message.method === "Log.entryAdded") {
      events.push(message);
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  const send = (method, params = {}) => {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve) => pending.set(id, resolve));
  };

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Log.enable");
  await send("Page.navigate", { url });
  await waitForLoadEvent(ws);
  const result = await send("Runtime.evaluate", {
    expression: demoExerciseExpression(),
    awaitPromise: true,
    returnByValue: true,
  });
  await send("Target.closeTarget", { targetId: target.id });
  ws.close();

  if (result.result?.exceptionDetails) {
    throw new Error(`browser demo threw: ${JSON.stringify(result.result.exceptionDetails)}`);
  }
  const value = result.result.result.value;
  assertBrowserResult(value);
  assertCoreHeaderRoundTrip(value);
  if (value.localStorageKeys.length > 0 || value.sessionStorageKeys.length > 0) {
    throw new Error(`browser demo persisted state unexpectedly: ${JSON.stringify({
      localStorageKeys: value.localStorageKeys,
      sessionStorageKeys: value.sessionStorageKeys,
    })}`);
  }
  const errors = events
    .map((event) => ({
      level: event.params?.entry?.level,
      text: event.params?.entry?.text || event.params?.args?.map((arg) => arg.value || arg.description).join(" "),
    }))
    .filter((event) => event.level === "error" || /Refused to|CSP|Exception/i.test(event.text ?? ""));
  if (errors.length > 0) throw new Error(`browser console errors: ${JSON.stringify(errors)}`);
  const { paymentRequiredHeader: _paymentRequiredHeader, paymentSignatureHeader: _paymentSignatureHeader, ...summary } = value;
  return summary;
}

function assertBrowserResult(value) {
  assert(value.addressPrefix === "kaspatest:", `unexpected address prefix: ${value.addressPrefix}`);
  assert(value.acceptedScheme === "exact", `unexpected accepted scheme: ${value.acceptedScheme}`);
  assert(value.requiredBytes > 0, "missing PAYMENT-REQUIRED header");
  assert(value.signatureBytes > 0, "missing PAYMENT-SIGNATURE header");
  assert(value.narrowedSupported === 1, `expected one supported requirement, got ${value.narrowedSupported}`);
  assert(value.narrowedSkipped === 2, `expected two skipped requirements, got ${value.narrowedSkipped}`);
  assert(value.connectedStatus.startsWith("Connected to testnet-10"), `unexpected connection status: ${value.connectedStatus}`);
  assert(value.rpcNetwork === "testnet-10", `unexpected RPC network: ${value.rpcNetwork}`);
  assert(value.rpcSynced === true, "RPC endpoint is not synced");
  assert(value.transactionStatus === "not in mempool (may already be accepted)", `unexpected tx status: ${value.transactionStatus}`);
  assert(
    value.blockedEndpointStatus.includes("Custom endpoints require a local preview"),
    `custom endpoint override was not blocked: ${value.blockedEndpointStatus}`,
  );
  assert(value.afterResetAddress === "", "reset did not clear address");
  assert(value.afterResetPayTo === "", "reset did not clear pay-to address");
  assert(value.afterResetPrivateKeyType === "password", "reset did not restore private key field type");
  assert(value.afterResetRevealChecked === false, "reset did not clear reveal checkbox");
}

function assertCoreHeaderRoundTrip(value) {
  const paymentRequired = decodePaymentRequiredHeader(value.paymentRequiredHeader);
  const paymentPayload = decodePaymentSignatureHeader(value.paymentSignatureHeader);
  assert(encodePaymentRequiredHeader(paymentRequired) === value.paymentRequiredHeader, "PAYMENT-REQUIRED does not round-trip through core encoder");
  assert(encodePaymentSignatureHeader(paymentPayload) === value.paymentSignatureHeader, "PAYMENT-SIGNATURE does not round-trip through core encoder");
  const retry = validatePaymentRetry({ paymentRequired, paymentPayload });
  assert(retry.ok, `PaymentRequired/PaymentPayload pair failed core validation: ${retry.error?.message}`);
  assert(paymentRequired.accepts[0]?.maxTimeoutSeconds > 0, "offer timeout must be positive");
  assert(paymentRequired.accepts[0]?.payTo?.trim(), "offer payTo must be non-empty");
}

function demoExerciseExpression() {
  return `
(async () => {
  const demoConnectTimeoutMs = ${JSON.stringify(demoConnectTimeoutMs)};
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const byId = (id) => document.getElementById(id);
  const click = async (id, waitMs = 250) => {
    byId(id).click();
    await sleep(waitMs);
  };
  const waitFor = async (fn, label, ms = 30000) => {
    const started = Date.now();
    while (Date.now() - started < ms) {
      const value = fn();
      if (value) return value;
      await sleep(100);
    }
    throw new Error('Timed out waiting for ' + label + '; status=' + byId('demo-status').value);
  };
  await click('demo-init', 500);
  await waitFor(() => byId('demo-status').value.includes('SDK loaded') || byId('demo-status').value.includes('already loaded'), 'sdk load');
  await click('demo-generate-key', 500);
  const address = await waitFor(() => byId('demo-address').value, 'address');
  byId('demo-reveal-key').click();
  await click('demo-build-offer', 250);
  const required = await waitFor(() => byId('demo-payment-required').value, 'payment required');
  byId('demo-transaction-id').value = '0'.repeat(64);
  await click('demo-build-payment', 250);
  const signature = await waitFor(() => byId('demo-payment-signature').value, 'payment signature');
  const exact = JSON.parse(atob(required));
  byId('demo-narrow-input').value = JSON.stringify({
    x402Version: 2,
    resource: { url: 'https://example.test/mixed' },
    accepts: [
      { scheme: 'foreign', network: 'eip155:1', asset: 'USDC', amount: '1000', payTo: '0x0', maxTimeoutSeconds: 60, extra: {} },
      exact.accepts[0],
      { scheme: 'batch-settlement', network: 'kaspa:testnet-10', asset: 'KAS', amount: '1000', payTo: exact.accepts[0].payTo, maxTimeoutSeconds: 60, extra: { binding: 'kaspa-escrow-v1' } }
    ]
  });
  await click('demo-narrow-offer', 250);
  const narrowed = JSON.parse(byId('demo-narrow-output').textContent);
  await click('demo-connect', 100);
  const connectedStatus = await waitFor(() => byId('demo-status').value.startsWith('Connected to') && byId('demo-status').value, 'pnn connect', demoConnectTimeoutMs);
  const rpc = JSON.parse(byId('demo-rpc-output').textContent);
  await click('demo-check-tx', 500);
  await waitFor(() => byId('demo-payment-output').textContent.includes('transactionId'), 'transaction status lookup');
  const transactionStatus = JSON.parse(byId('demo-payment-output').textContent).status;
  byId('demo-endpoint').value = 'wss://example.com/kaspa/testnet-10/wrpc/borsh';
  await click('demo-connect', 500);
  const blockedEndpointStatus = await waitFor(
    () => byId('demo-status').value.includes('Custom endpoints require') && byId('demo-status').value,
    'custom endpoint block'
  );
  await click('demo-reset', 500);
  return {
    addressPrefix: address.slice(0, 10),
    requiredBytes: required.length,
    signatureBytes: signature.length,
    paymentRequiredHeader: required,
    paymentSignatureHeader: signature,
    acceptedScheme: exact.accepts[0].scheme,
    narrowedSupported: narrowed.supportedCount,
    narrowedSkipped: narrowed.skippedCount,
    connectedStatus,
    endpoint: rpc.endpoint,
    rpcNetwork: rpc.serverInfo?.networkId,
    rpcSynced: rpc.serverInfo?.isSynced,
    transactionStatus,
    blockedEndpointStatus,
    afterResetAddress: byId('demo-address').value,
    afterResetPayTo: byId('demo-pay-to').value,
    afterResetPrivateKeyType: byId('demo-private-key').type,
    afterResetRevealChecked: byId('demo-reveal-key').checked,
    localStorageKeys: Object.keys(localStorage),
    sessionStorageKeys: Object.keys(sessionStorage)
  };
})()
`;
}

async function waitForLoadEvent(ws) {
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 10_000);
    const handler = (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Page.loadEventFired") {
        clearTimeout(timeout);
        ws.removeEventListener("message", handler);
        resolve();
      }
    };
    ws.addEventListener("message", handler);
  });
}

async function startServer() {
  if (!fs.existsSync(outDir)) throw new Error("site/dist is missing; run npm run site:build first");
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const file = resolveFile(url.pathname);
    if (!file || !isInsideOutput(file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found\n");
      return;
    }
    response.writeHead(200, { "Content-Type": contentType(file), ...headersForPath(url.pathname) });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

function resolveFile(pathname) {
  const clean = decodeURIComponent(pathname).replace(/^\/+/, "");
  const candidate = path.join(outDir, clean);
  if (pathname.endsWith("/") || path.extname(candidate) === "") return path.join(candidate, "index.html");
  return candidate;
}

function headersForPath(pathname) {
  const headers = {};
  let activePattern;
  for (const line of readRawConfigLines("_headers")) {
    if (!line.startsWith(" ") && !line.startsWith("\t")) {
      activePattern = line.trim();
      continue;
    }
    if (!activePattern || !matchPattern(activePattern, pathname)) continue;
    const [name, ...valueParts] = line.trim().split(":");
    if (!name || valueParts.length === 0) continue;
    headers[name] = valueParts.join(":").trim();
  }
  return headers;
}

function readRawConfigLines(file) {
  const fullPath = path.join(outDir, file);
  if (!fs.existsSync(fullPath)) return [];
  return fs.readFileSync(fullPath, "utf8").split(/\r?\n/).filter((line) => line.trim() !== "");
}

function matchPattern(pattern, pathname) {
  if (pattern === pathname) return { splat: "" };
  if (!pattern.includes("*")) return undefined;
  const [prefix, suffix = ""] = pattern.split("*");
  if (!pathname.startsWith(prefix) || (suffix && !pathname.endsWith(suffix))) return undefined;
  return { splat: pathname.slice(prefix.length, suffix ? -suffix.length : undefined) };
}

function contentType(file) {
  switch (path.extname(file)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".wasm":
      return "application/wasm";
    case ".json":
      return file.endsWith(".schema.json") ? "application/schema+json; charset=utf-8" : "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function isInsideOutput(file) {
  const relative = path.relative(outDir, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function waitForDevtools(port) {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    try {
      await fetchJson(`http://127.0.0.1:${port}/json/version`);
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error("Chrome DevTools endpoint did not start");
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function openPort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function findChrome() {
  for (const candidate of ["google-chrome", "chromium", "chromium-browser", "chrome"]) {
    try {
      return execFileSync("sh", ["-lc", `command -v ${candidate}`], { encoding: "utf8" }).trim();
    } catch {
      // Try the next common binary name.
    }
  }
  throw new Error("Could not find Chrome. Set CHROME_BIN to run the browser demo smoke test.");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
