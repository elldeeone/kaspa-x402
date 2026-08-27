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
  await waitForProcessExit(chromeProcess);
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(userDataDir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}

async function waitForProcessExit(process, timeoutMs = 5_000) {
  if (process.exitCode !== null || process.signalCode !== null) return;
  await new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timeout);
      process.off("exit", finish);
      resolve();
    };
    const timeout = setTimeout(() => {
      process.kill("SIGKILL");
      finish();
    }, timeoutMs);
    process.once("exit", finish);
  });
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
  const {
    paymentRequiredHeader: _paymentRequiredHeader,
    paymentSignatureHeader: _paymentSignatureHeader,
    batchPaymentRequiredHeader: _batchPaymentRequiredHeader,
    batchPaymentSignatureHeader: _batchPaymentSignatureHeader,
    ...summary
  } = value;
  return summary;
}

function assertBrowserResult(value) {
  assert(value.addressPrefix === "kaspatest:", `unexpected address prefix: ${value.addressPrefix}`);
  assert(value.acceptedScheme === "exact", `unexpected accepted scheme: ${value.acceptedScheme}`);
  assert(value.requiredBytes > 0, "missing PAYMENT-REQUIRED header");
  assert(value.signatureBytes > 0, "missing PAYMENT-SIGNATURE header");
  assert(value.batchRequiredBytes > 0, "missing batch PAYMENT-REQUIRED header");
  assert(value.batchSignatureBytes > 0, "missing batch PAYMENT-SIGNATURE header");
  assert(value.batchBinding === "kaspa-escrow-v2", `unexpected batch binding: ${value.batchBinding}`);
  assert(value.batchTemplateId === "kaspa-x402-escrow-v3", `unexpected batch template: ${value.batchTemplateId}`);
  assert(value.batchCovenantId === "7".repeat(64), "batch voucher did not bind the stable covenant id");
  assert(value.batchVoucherAmount === "30000000", `unexpected batch voucher T: ${value.batchVoucherAmount}`);
  assert(value.batchAuthorizationVersion === "kaspa-x402-batch-request-authorization-v1", "batch payload omitted request authorization");
  assert(value.batchCurrentTxid === "8".repeat(64), "batch payload did not carry the current outpoint");
  assert(value.batchBefore.A === "2500000", `unexpected A before request: ${value.batchBefore.A}`);
  assert(value.batchBefore.S === "1700000", `unexpected S before request: ${value.batchBefore.S}`);
  assert(value.batchBefore.T === "30000000", `unexpected T before request: ${value.batchBefore.T}`);
  assert(value.batchBefore.V === "88300000", `unexpected V before request: ${value.batchBefore.V}`);
  assert(value.batchBefore.R === "10000000", `unexpected R before request: ${value.batchBefore.R}`);
  assert(value.batchAfterWork.A === "22500000", `unexpected A after work: ${value.batchAfterWork.A}`);
  assert(value.batchPartial.D === "800000", `unexpected partial claim D: ${value.batchPartial.D}`);
  assert(value.batchSuccessor.covenantId === value.batchCovenantId, "partial claim changed covenant id");
  assert(value.batchSuccessor.A === "22500000", "partial claim reset A");
  assert(value.batchSuccessor.S === "2500000", "partial claim did not advance S");
  assert(value.batchSuccessor.T === "30000000", "partial claim reset T");
  assert(value.batchSuccessor.V === "87500000", "partial claim did not reduce V by D");
  assert(value.batchSuccessor.voucherSignature === "unchanged", "partial claim did not preserve voucher proof");
  assert(value.exactPaymentFieldsHiddenForBatch === true, "batch selection did not hide exact transaction controls");
  assert(value.narrowedBatchCovenantId === value.batchCovenantId, "compatibility narrowing lost corrective batch lane identity");
  assert(value.narrowedSupported === 2, `expected two supported requirements, got ${value.narrowedSupported}`);
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
  assertHeaderPair(
    value.paymentRequiredHeader,
    value.paymentSignatureHeader,
    "exact",
  );
  assertHeaderPair(
    value.batchPaymentRequiredHeader,
    value.batchPaymentSignatureHeader,
    "batch",
  );
}

function assertHeaderPair(requiredHeader, signatureHeader, label) {
  const paymentRequired = decodePaymentRequiredHeader(requiredHeader);
  const paymentPayload = decodePaymentSignatureHeader(signatureHeader);
  assert(encodePaymentRequiredHeader(paymentRequired) === requiredHeader, `${label} PAYMENT-REQUIRED does not round-trip through core encoder`);
  assert(encodePaymentSignatureHeader(paymentPayload) === signatureHeader, `${label} PAYMENT-SIGNATURE does not round-trip through core encoder`);
  const retry = validatePaymentRetry({ paymentRequired, paymentPayload });
  assert(retry.ok, `${label} PaymentRequired/PaymentPayload pair failed core validation: ${retry.error?.message}`);
  assert(paymentRequired.accepts[0]?.maxTimeoutSeconds > 0, `${label} offer timeout must be positive`);
  assert(paymentRequired.accepts[0]?.payTo?.trim(), `${label} offer payTo must be non-empty`);
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
  byId('demo-profile').value = 'batch-settlement';
  byId('demo-profile').dispatchEvent(new Event('change'));
  await click('demo-build-offer', 250);
  const batchRequired = await waitFor(
    () => {
      const header = byId('demo-payment-required').value;
      return header && header !== required ? header : undefined;
    },
    'batch payment required'
  );
  await click('demo-build-payment', 250);
  const batchSignature = await waitFor(
    () => {
      const header = byId('demo-payment-signature').value;
      return header && header !== signature ? header : undefined;
    },
    'batch payment signature'
  );
  const batch = JSON.parse(atob(batchRequired));
  const batchPayment = JSON.parse(atob(batchSignature));
  const batchOutput = JSON.parse(byId('demo-payment-output').textContent);
  const lanePreview = batchOutput.lanePreview;
  const exactPaymentFieldsHiddenForBatch = byId('demo-exact-payment-fields').hidden;
  const batchCorrective = {
    ...batch.accepts[0],
    extra: {
      ...batch.accepts[0].extra,
      channelState: batchOutput.mockSettlementResponse.extensions.kaspa.channelState,
      voucherState: batchPayment.payload.voucher
    }
  };
  byId('demo-narrow-input').value = JSON.stringify({
    x402Version: 2,
    resource: { url: 'https://example.test/mixed' },
    accepts: [
      { scheme: 'foreign', network: 'eip155:1', asset: 'USDC', amount: '1000', payTo: '0x0', maxTimeoutSeconds: 60, extra: {} },
      exact.accepts[0],
      { scheme: 'batch-settlement', network: 'kaspa:testnet-10', asset: 'KAS', amount: '1000', payTo: exact.accepts[0].payTo, maxTimeoutSeconds: 60, extra: { binding: 'unsupported-escrow-binding' } },
      batchCorrective
    ]
  });
  await click('demo-narrow-offer', 250);
  const narrowed = JSON.parse(byId('demo-narrow-output').textContent);
  await click('demo-connect', 100);
  const connectedStatus = await waitFor(() => byId('demo-status').value.startsWith('Connected to') && byId('demo-status').value, 'pnn connect', demoConnectTimeoutMs);
  const rpc = JSON.parse(byId('demo-rpc-output').textContent);
  await click('demo-check-tx', 500);
  const transactionStatus = await waitFor(
    () => JSON.parse(byId('demo-payment-output').textContent || '{}').status,
    'transaction status lookup'
  );
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
    batchRequiredBytes: batchRequired.length,
    batchSignatureBytes: batchSignature.length,
    batchPaymentRequiredHeader: batchRequired,
    batchPaymentSignatureHeader: batchSignature,
    batchBinding: batch.accepts[0].extra.binding,
    batchTemplateId: batch.accepts[0].extra.templateId,
    batchCovenantId: batchPayment.payload.voucher.covenantId,
    batchVoucherAmount: batchPayment.payload.voucher.amount,
    batchAuthorizationVersion: batchPayment.payload.authorization.version,
    batchCurrentTxid: batchPayment.payload.fundingOutpoint.txid,
    batchBefore: lanePreview.beforeRequest,
    batchAfterWork: lanePreview.afterSuccessfulWork,
    batchPartial: lanePreview.partialClaim,
    batchSuccessor: lanePreview.partialClaim.successor,
    exactPaymentFieldsHiddenForBatch,
    narrowedBatchCovenantId: narrowed.narrowed.accepts.find((entry) => entry.scheme === 'batch-settlement').extra.channelState.covenantId,
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
