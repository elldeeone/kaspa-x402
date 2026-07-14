import init, {
  ConnectStrategy,
  Encoding,
  PrivateKey,
  RpcClient,
  Transaction,
  version,
} from "/vendor/kaspa-wasm/2.0.0/kaspa-core/kaspa.js";

const NETWORK_ID = "testnet-10";
const NETWORK = "kaspa:testnet-10";
const SDK_ROUTE = "/vendor/kaspa-wasm/2.0.0/kaspa-core/kaspa.js";
const UINT64_MAX = 18446744073709551615n;
const CONNECT_TIMEOUT_MS = 15_000;
const PUBLIC_WSS_ENDPOINTS = [
  "wss://vector-10.kaspa.green/kaspa/testnet-10/wrpc/borsh",
  "wss://electron-10.kaspa.stream/kaspa/testnet-10/wrpc/borsh",
  "wss://electron-10.kaspa.blue/kaspa/testnet-10/wrpc/borsh",
  "wss://muon-10.kaspa.blue/kaspa/testnet-10/wrpc/borsh",
];

const state = {
  sdkReady: false,
  rpc: undefined,
  rpcEndpoint: undefined,
  privateKey: undefined,
  paymentRequired: undefined,
  paymentPayload: undefined,
};

const ui = {
  status: element("demo-status"),
  rpcOutput: element("demo-rpc-output"),
  endpoint: element("demo-endpoint"),
  privateKey: element("demo-private-key"),
  revealKey: element("demo-reveal-key"),
  address: element("demo-address"),
  utxoOutput: element("demo-utxo-output"),
  profile: element("demo-profile"),
  amount: element("demo-amount"),
  timeout: element("demo-timeout"),
  finality: element("demo-finality"),
  resourceUrl: element("demo-resource-url"),
  description: element("demo-description"),
  payTo: element("demo-pay-to"),
  batchFields: element("demo-batch-fields"),
  serverPublicKey: element("demo-server-public-key"),
  minDeposit: element("demo-min-deposit"),
  refundDaa: element("demo-refund-daa"),
  paymentRequiredHeader: element("demo-payment-required"),
  offerOutput: element("demo-offer-output"),
  transaction: element("demo-transaction"),
  outputIndex: element("demo-output-index"),
  transactionId: element("demo-transaction-id"),
  paymentSignatureHeader: element("demo-payment-signature"),
  paymentOutput: element("demo-payment-output"),
  narrowInput: element("demo-narrow-input"),
  narrowOutput: element("demo-narrow-output"),
};

bind("demo-init", initializeSdk);
bind("demo-connect", connectRpc);
bind("demo-disconnect", disconnectRpc);
bind("demo-reset", resetDemo);
bind("demo-generate-key", generateKey);
bind("demo-import-key", importKey);
bind("demo-copy-address", () => copyText(ui.address.value, "Address copied."));
bind("demo-load-utxos", loadUtxos);
bind("demo-build-offer", buildOffer);
bind("demo-copy-required", () =>
  copyText(ui.paymentRequiredHeader.value, "PAYMENT-REQUIRED copied."),
);
bind("demo-build-payment", buildPaymentRetry);
bind("demo-copy-signature", () =>
  copyText(ui.paymentSignatureHeader.value, "PAYMENT-SIGNATURE copied."),
);
bind("demo-check-tx", checkTransactionStatus);
bind("demo-broadcast-tx", broadcastTransaction);
bind("demo-narrow-offer", inspectAccepts);

const initialCustomEndpoint = customEndpointFromQuery();
if (initialCustomEndpoint) ui.endpoint.value = initialCustomEndpoint;

ui.profile.addEventListener("change", () => {
  ui.batchFields.hidden = ui.profile.value !== "batch-settlement";
});
ui.revealKey.addEventListener("change", () => {
  ui.privateKey.type = ui.revealKey.checked ? "text" : "password";
});

writeJson(ui.rpcOutput, {
  network: NETWORK,
  sdk: SDK_ROUTE,
  endpoints: PUBLIC_WSS_ENDPOINTS,
});

async function initializeSdk() {
  if (state.sdkReady) {
    setStatus(`SDK already loaded: kaspa-wasm ${version()}.`);
    return;
  }
  setStatus("Loading SDK...");
  await init();
  state.sdkReady = true;
  setStatus(`SDK loaded: kaspa-wasm ${version()}.`);
  writeJson(ui.rpcOutput, {
    sdkVersion: version(),
    network: NETWORK,
    privateStorage: "none",
  });
}

async function connectRpc() {
  await initializeSdk();
  await disconnectRpc({ quiet: true });
  const candidates = selectedEndpoints();
  let connected;
  const errors = [];
  for (const endpoint of candidates) {
    if (location.protocol === "https:" && endpoint.startsWith("ws://")) {
      errors.push(`${endpoint}: blocked on HTTPS page`);
      continue;
    }
    setStatus(`Connecting to ${endpoint}...`);
    const rpc = new RpcClient({
      url: endpoint,
      networkId: NETWORK_ID,
      encoding: Encoding.Borsh,
    });
    try {
      await withTimeout(
        rpc.connect({
          strategy: ConnectStrategy.Fallback,
          timeoutDuration: CONNECT_TIMEOUT_MS,
          url: endpoint,
        }),
        `connect ${endpoint}`,
      );
      connected = { endpoint, rpc };
      break;
    } catch (error) {
      errors.push(`${endpoint}: ${error?.message ?? error}`);
      try {
        await rpc.disconnect();
      } catch {
        // Ignore cleanup failures after unsuccessful websocket attempts.
      }
    }
  }
  if (!connected)
    throw new Error(
      `Could not connect to a testnet endpoint. ${errors.join(" | ")}`,
    );
  const { endpoint, rpc } = connected;
  state.rpc = rpc;
  state.rpcEndpoint = endpoint;
  const [info, dag] = await Promise.all([
    rpc.getServerInfo(),
    rpc.getBlockDagInfo(),
  ]);
  setStatus(
    `Connected to ${readField(info, "networkId", "network_id")} at DAA ${readField(dag, "virtualDaaScore", "virtual_daa_score")}.`,
  );
  writeJson(ui.rpcOutput, {
    endpoint,
    serverInfo: info,
    blockDagInfo: dag,
  });
}

async function disconnectRpc(options = {}) {
  if (!state.rpc) return;
  try {
    await state.rpc.disconnect();
  } finally {
    state.rpc = undefined;
    state.rpcEndpoint = undefined;
    if (!options.quiet) setStatus("Disconnected.");
  }
}

function selectedEndpoints() {
  const manual = ui.endpoint.value.trim();
  if (!manual) return PUBLIC_WSS_ENDPOINTS;
  const parsed = new URL(manual);
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:")
    throw new Error("Endpoint override must use ws:// or wss://.");
  if (PUBLIC_WSS_ENDPOINTS.includes(manual)) return [manual];
  const allowedCustomEndpoint = customEndpointFromQuery();
  if (
    !isLocalPreview() ||
    !customEndpointsEnabled() ||
    !allowedCustomEndpoint ||
    manual !== allowedCustomEndpoint ||
    !isLocalEndpointHost(parsed.hostname)
  ) {
    throw new Error(
      "Custom endpoints require a local preview with ?allow-custom-endpoints=1&endpoint=... and a matching local or private-network host.",
    );
  }
  return [manual];
}

async function ensureRpc() {
  if (!state.rpc) await connectRpc();
  return state.rpc;
}

async function generateKey() {
  await initializeSdk();
  let privateKey;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    try {
      privateKey = new PrivateKey(hex(bytes));
      break;
    } catch {
      privateKey = undefined;
    }
  }
  if (!privateKey) throw new Error("Could not generate a valid private key.");
  setKey(privateKey);
  setStatus("Generated throwaway testnet key in browser memory.");
}

async function importKey() {
  await initializeSdk();
  const value = ui.privateKey.value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value))
    throw new Error("Private key must be 64 hex characters.");
  setKey(new PrivateKey(value));
  setStatus("Imported testnet key into browser memory.");
}

function setKey(privateKey) {
  disposePrivateKey();
  state.privateKey = privateKey;
  ui.privateKey.value = privateKey.toString();
  ui.address.value = privateKey.toAddress(NETWORK_ID).toString();
  if (!ui.payTo.value.trim()) ui.payTo.value = ui.address.value;
}

async function loadUtxos() {
  const address = ui.address.value.trim();
  if (!address) throw new Error("Generate or import a testnet address first.");
  const rpc = await ensureRpc();
  const result = await rpc.getUtxosByAddresses([address]);
  writeJson(ui.utxoOutput, result);
  setStatus("UTXO lookup complete.");
}

function buildOffer() {
  const profile = ui.profile.value;
  const amount = canonicalAmount(ui.amount.value, "amount");
  const timeout = positiveBoundedInteger(ui.timeout.value, "timeout seconds");
  const resourceUrl = requiredText(ui.resourceUrl.value, "resource URL");
  const payTo = requiredText(ui.payTo.value, "pay-to address");
  const accepted = {
    scheme: profile,
    network: NETWORK,
    amount,
    asset: "KAS",
    payTo,
    maxTimeoutSeconds: timeout,
    extra: profile === "exact" ? exactExtra(payTo) : batchExtra(),
  };
  const paymentRequired = {
    x402Version: 2,
    resource: {
      url: resourceUrl,
      description: ui.description.value.trim() || undefined,
      mimeType: "application/json",
    },
    accepts: [accepted],
  };
  pruneUndefined(paymentRequired.resource);
  const header = encodeHeader(paymentRequired);
  state.paymentRequired = paymentRequired;
  ui.paymentRequiredHeader.value = header;
  writeJson(ui.offerOutput, paymentRequired);
  setStatus(`${profile} offer built.`);
}

function exactExtra(payTo) {
  if (!state.privateKey || ui.address.value !== payTo) {
    throw new Error(
      "The browser demo builds standard-native offers for the generated or imported testnet key.",
    );
  }
  const publicKey = state.privateKey.toPublicKey();
  const xOnly = publicKey.toXOnlyPublicKey();
  const payToScriptPublicKey = `000020${xOnly.toString()}ac`;
  xOnly.free();
  publicKey.free();
  return {
    binding: "kaspa-exact-v2",
    profile: "standard-native",
    finality: ui.finality.value,
    transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
    payToScriptPublicKey,
    paymentOutputIndex: boundedInteger(
      ui.outputIndex.value,
      "payment output index",
    ),
    assetKind: "native",
    assetDecimals: 8,
  };
}

function batchExtra() {
  const serverPublicKey = requiredText(
    ui.serverPublicKey.value,
    "server public key",
  ).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(serverPublicKey))
    throw new Error("Server public key must be 64 hex characters.");
  return {
    binding: "kaspa-escrow-v1",
    templateId: "kaspa-x402-escrow-v1",
    serverPublicKey,
    minDepositSompi: canonicalAmount(ui.minDeposit.value, "minimum deposit"),
    refundTimeoutDaa: canonicalAmount(ui.refundDaa.value, "refund timeout DAA"),
    assetKind: "native",
    assetDecimals: 8,
  };
}

function buildPaymentRetry() {
  if (!state.paymentRequired) buildOffer();
  const accepted = state.paymentRequired.accepts[0];
  if (accepted.scheme !== "exact") {
    throw new Error("The mock retry builder is only for exact offers.");
  }
  const transactionId = normalizedTxId(
    requiredText(ui.transactionId.value, "transaction id"),
  );
  const transactionArtifact =
    ui.transaction.value.trim() ||
    stableStringify({
      demo: "kaspa-x402-standard-native-exact",
      transactionIdHint: transactionId,
    });
  const paymentPayload = {
    x402Version: 2,
    accepted,
    payload: {
      type: "exact-transaction",
      profile: accepted.extra.profile,
      transaction: transactionArtifact,
      transactionEncoding: accepted.extra.transactionEncoding,
      paymentOutputIndex: boundedInteger(
        ui.outputIndex.value,
        "payment output index",
      ),
      payerAddress: ui.address.value.trim() || undefined,
    },
  };
  pruneUndefined(paymentPayload.payload);
  const settlement = {
    success: true,
    transaction: transactionId,
    network: NETWORK,
    payer: ui.address.value.trim() || undefined,
    amount: accepted.amount,
  };
  pruneUndefined(settlement);
  state.paymentPayload = paymentPayload;
  ui.paymentSignatureHeader.value = encodeHeader(paymentPayload);
  writeJson(ui.paymentOutput, {
    paymentPayload,
    mockSettlementResponse: settlement,
  });
  setStatus("Exact retry transcript built.");
}

async function checkTransactionStatus() {
  const txid = normalizedTxId(
    requiredText(ui.transactionId.value, "transaction id"),
  );
  const rpc = await ensureRpc();
  try {
    const entry = await rpc.getMempoolEntry({
      transactionId: txid,
      includeOrphanPool: true,
      filterTransactionPool: false,
    });
    writeJson(ui.paymentOutput, { transactionId: txid, mempoolEntry: entry });
    setStatus("Transaction found in mempool.");
  } catch (error) {
    writeJson(ui.paymentOutput, {
      transactionId: txid,
      status: "not in mempool (may already be accepted)",
      error: String(error?.message ?? error),
    });
    setStatus("Transaction is not in mempool; it may already be accepted.");
  }
}

async function broadcastTransaction() {
  const txHexOrJson = requiredText(ui.transaction.value, "transaction JSON");
  const rpc = await ensureRpc();
  let transaction;
  if (txHexOrJson.trim().startsWith("{")) {
    transaction = Transaction.deserializeFromSafeJSON(txHexOrJson);
  } else if (/^[0-9a-fA-F]+$/.test(txHexOrJson.trim())) {
    throw new Error(
      "Broadcast requires a safe JSON transaction object from the SDK. Exact x402 payloads use KIP-10 transaction artifacts, not raw transaction hex.",
    );
  } else {
    throw new Error("Broadcast input must be a safe JSON transaction object.");
  }
  const result = await rpc.submitTransaction({
    transaction,
    allowOrphan: false,
  });
  writeJson(ui.paymentOutput, result);
  setStatus("Transaction submitted to the selected testnet endpoint.");
}

function inspectAccepts() {
  const parsed = JSON.parse(
    requiredText(ui.narrowInput.value, "PaymentRequired JSON"),
  );
  if (
    parsed.x402Version !== 2 ||
    !parsed.resource ||
    !Array.isArray(parsed.accepts)
  ) {
    throw new Error(
      "PaymentRequired must include x402Version 2, resource, and accepts.",
    );
  }
  const supported = [];
  const skipped = [];
  for (const entry of parsed.accepts) {
    if (isSupportedRequirement(entry)) supported.push(entry);
    else
      skipped.push({
        scheme: entry?.scheme,
        network: entry?.network,
        asset: entry?.asset,
        reason: skipReason(entry),
      });
  }
  writeJson(ui.narrowOutput, {
    supportedCount: supported.length,
    skippedCount: skipped.length,
    narrowed:
      supported.length > 0 ? { ...parsed, accepts: supported } : undefined,
    skipped,
  });
  setStatus(
    supported.length > 0
      ? "Compatible Kaspa entries found."
      : "No compatible Kaspa entries found.",
  );
}

function isSupportedRequirement(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.network !== NETWORK || entry.asset !== "KAS") return false;
  if (!isAmount(entry.amount) || !isNonEmptyString(entry.payTo)) return false;
  if (!isPositiveUint32(entry.maxTimeoutSeconds)) return false;
  if (entry.scheme === "exact") return isExactExtra(entry.extra);
  if (entry.scheme === "batch-settlement") return isBatchExtra(entry.extra);
  return false;
}

function skipReason(entry) {
  if (!entry || typeof entry !== "object") return "not an object";
  if (entry.network !== NETWORK) return "unsupported network";
  if (entry.asset !== "KAS") return "unsupported asset";
  if (entry.scheme !== "exact" && entry.scheme !== "batch-settlement")
    return "unsupported scheme";
  if (!isAmount(entry.amount)) return "invalid amount";
  if (!isNonEmptyString(entry.payTo)) return "missing payTo";
  if (!isPositiveUint32(entry.maxTimeoutSeconds)) return "invalid timeout";
  if (entry.scheme === "exact" && !isExactExtra(entry.extra))
    return "invalid exact extra";
  if (entry.scheme === "batch-settlement" && !isBatchExtra(entry.extra))
    return "invalid batch extra";
  return "unsupported binding";
}

function isExactExtra(extra) {
  if (!extra || typeof extra !== "object" || extra.binding !== "kaspa-exact-v2")
    return false;
  if (!["standard-native", "additive"].includes(extra.profile)) return false;
  if (
    extra.finality !== undefined &&
    !["accepted", "confirmed"].includes(extra.finality)
  )
    return false;
  if (extra.transactionEncoding !== "kaspa-sdk-safe-json-v2.0.0") return false;
  if (!isSerializedScriptPublicKey(extra.payToScriptPublicKey)) return false;
  if (
    extra.paymentOutputIndex !== undefined &&
    !isUint32(extra.paymentOutputIndex)
  )
    return false;
  if (extra.assetKind !== undefined && extra.assetKind !== "native")
    return false;
  if (extra.assetDecimals !== undefined && extra.assetDecimals !== 8)
    return false;
  if (extra.profile === "additive") {
    if (extra.templateId !== "kaspa-x402-kip10-additive-v1") return false;
    if (!isHash32(extra.headId) || !isAmount(extra.headVersion)) return false;
    if (!isOutpoint(extra.expectedHeadOutpoint) || !isAmount(extra.headAmount))
      return false;
    if (
      !isSerializedScriptPublicKey(extra.headScriptPublicKey) ||
      extra.headScriptPublicKey !== extra.payToScriptPublicKey
    )
      return false;
    if (
      !isHexBytes(extra.headRedeemScript) ||
      !isAmount(extra.additiveThresholdSompi)
    )
      return false;
    if (
      !isHash32(extra.challengeId) ||
      !isNonEmptyString(extra.challengeExpiresAt)
    )
      return false;
    if (extra.paymentOutputIndex !== 0) return false;
  }
  return true;
}

function isOutpoint(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    isHash32(value.txid) &&
    isUint32(value.index),
  );
}

function isSerializedScriptPublicKey(value) {
  return typeof value === "string" && /^0000(?:[0-9a-fA-F]{2})+$/.test(value);
}

function isHexBytes(value) {
  return typeof value === "string" && /^(?:[0-9a-fA-F]{2})+$/.test(value);
}

function isHash32(value) {
  return typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value);
}

function isBatchExtra(extra) {
  if (!extra || typeof extra !== "object") return false;
  if (extra.binding !== "kaspa-escrow-v1") return false;
  if (extra.templateId !== "kaspa-x402-escrow-v1") return false;
  if (
    typeof extra.serverPublicKey !== "string" ||
    !/^[0-9a-fA-F]{64}$/.test(extra.serverPublicKey)
  )
    return false;
  if (!isAmount(extra.minDepositSompi) || !isAmount(extra.refundTimeoutDaa))
    return false;
  if (extra.assetKind !== undefined && extra.assetKind !== "native")
    return false;
  if (extra.assetDecimals !== undefined && extra.assetDecimals !== 8)
    return false;
  return true;
}

function element(id) {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element #${id}`);
  return found;
}

function bind(id, handler) {
  element(id).addEventListener("click", () => {
    Promise.resolve(handler()).catch((error) => {
      setStatus(String(error?.message ?? error));
    });
  });
}

function setStatus(value) {
  ui.status.value = value;
}

function writeJson(target, value) {
  target.textContent = stableStringify(value, 2);
}

function encodeHeader(value) {
  const json = stableStringify(value);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function stableStringify(value, space = 0) {
  return JSON.stringify(sortJson(value), bigintReplacer, space);
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
}

function bigintReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readField(value, camel, snake) {
  return value?.[camel] ?? value?.[snake];
}

function requiredText(value, label) {
  const text = value.trim();
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function boundedInteger(value, label) {
  const text = String(value).trim();
  if (!/^(?:0|[1-9][0-9]*)$/.test(text))
    throw new Error(`${label} must be an unsigned integer.`);
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < 0 || number > 4294967295)
    throw new Error(`${label} is outside uint32 range.`);
  return number;
}

function positiveBoundedInteger(value, label) {
  const number = boundedInteger(value, label);
  if (number <= 0) throw new Error(`${label} must be greater than zero.`);
  return number;
}

function isUint32(value) {
  return Number.isInteger(value) && value >= 0 && value <= 4294967295;
}

function isPositiveUint32(value) {
  return isUint32(value) && value > 0;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function canonicalAmount(value, label) {
  const text = String(value).trim();
  if (!isAmount(text))
    throw new Error(`${label} must be a canonical uint64 decimal string.`);
  return text;
}

function isAmount(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value))
    return false;
  return BigInt(value) <= UINT64_MAX;
}

function normalizedTxId(value) {
  if (!value) return "";
  const text = value.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(text))
    throw new Error("Transaction id must be 64 hex characters.");
  return text;
}

function withTimeout(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () =>
          reject(new Error(`${label} timed out after ${CONNECT_TIMEOUT_MS}ms`)),
        CONNECT_TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

function pruneUndefined(value) {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
}

async function copyText(value, successMessage) {
  if (!value) throw new Error("Nothing to copy.");
  await navigator.clipboard.writeText(value);
  setStatus(successMessage);
}

async function resetDemo() {
  await disconnectRpc({ quiet: true });
  disposePrivateKey();
  state.paymentRequired = undefined;
  state.paymentPayload = undefined;
  ui.revealKey.checked = false;
  ui.privateKey.type = "password";
  ui.privateKey.value = "";
  ui.address.value = "";
  ui.payTo.value = "";
  ui.paymentRequiredHeader.value = "";
  ui.paymentSignatureHeader.value = "";
  ui.transaction.value = "";
  ui.transactionId.value = "";
  writeJson(ui.rpcOutput, {});
  writeJson(ui.utxoOutput, {});
  writeJson(ui.offerOutput, {});
  writeJson(ui.paymentOutput, {});
  setStatus("Cleared browser memory and visible demo state.");
}

function isLocalPreview() {
  return (
    ["localhost", "127.0.0.1", "::1", ""].includes(location.hostname) ||
    /^10\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\./.test(location.hostname)
  );
}

function customEndpointsEnabled() {
  return (
    new URLSearchParams(location.search).get("allow-custom-endpoints") === "1"
  );
}

function customEndpointFromQuery() {
  return new URLSearchParams(location.search).get("endpoint")?.trim() ?? "";
}

function isLocalEndpointHost(hostname) {
  const clean = hostname.replace(/^\[|\]$/g, "");
  return (
    ["localhost", "127.0.0.1", "::1"].includes(clean) ||
    /^10\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\./.test(clean)
  );
}

function disposePrivateKey() {
  try {
    state.privateKey?.free?.();
  } finally {
    state.privateKey = undefined;
  }
}
