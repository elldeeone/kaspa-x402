#!/usr/bin/env node
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  bindRequestHashToTrustedContext, decodePaymentRequiredHeader, decodePaymentResponseHeader,
  sha256Hex, stableStringify,
} from "@kaspa-x402/core";
import {
  DirectModeClient, MemoryChannelStore, PendingExactPaymentError,
  claimHashChainGrantViaHttp, signHashChainExactTransaction,
} from "@kaspa-x402/client";
import {
  buildHashChainOwnerRotationSignatureScript, buildTxV1P2pkSignatureScript,
  calculateKaspaStorageMass, generateHashChainBorrowGrants,
  hashChainHeadScriptPublicKey, transactionV1CovenantId,
  transactionV1Id, transactionV1Sighash,
} from "@kaspa-x402/covenant";
import {
  DirectModeServer, HashChainExactTransactionVerifier,
  MemoryServerChannelStore, handleHashChainGrantClaimHttp,
} from "@kaspa-x402/server";
import { HashChainGrantIssuer } from "../packages/server/dist/hash-chain-grants.js";
import {
  getAddressUtxos, liveChainCheckpoint, referenceTransactionToSdk,
  selectedChainEvidenceRemainsCanonical, waitForAcceptedTransactionEvidence,
} from "./live-adapter-reference.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parseOptions(process.argv.slice(2));
if (!options.live || !options.walletFile || !options.rpcUrl) {
  throw new Error("usage: proof-hash-chain-testnet.mjs --live --wallet-file <private-file> --rpc-url <testnet-10 wrpc> [--output-dir <private-dir>]");
}
const outputDir = path.resolve(options.outputDir ?? path.join(root, ".kaspa-x402-live", `hash-chain-${Date.now()}`));
fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
const reportFile = path.join(outputDir, "report.json");
const runtimeArtifacts = [
  "packages/core/dist/index.js", "packages/covenant/dist/index.js",
  "packages/server/dist/index.js", "packages/server/dist/hash-chain-grants.js",
  "packages/client/dist/index.js", "packages/facilitator/dist/index.js",
  "packages/cli/dist/index.js", "scripts/live-adapter-reference.mjs",
  "scripts/proof-hash-chain-testnet.mjs",
];
const HASH_CHAIN_RPC_TIMEOUT_MS = 15_000;
const HASH_CHAIN_MIN_ACCEPTANCE_WINDOW_MS = 30_000;
const HASH_CHAIN_ORIGIN_SNAPSHOT_TIMEOUT_MS = 15_000;
const HASH_CHAIN_SERVER_SETTLEMENT_RESERVE_MS = 45_000;
const HASH_CHAIN_POST_ACCEPTANCE_RESERVE_MS =
  HASH_CHAIN_ORIGIN_SNAPSHOT_TIMEOUT_MS + HASH_CHAIN_SERVER_SETTLEMENT_RESERVE_MS;
const runtimeSha256 = Object.fromEntries(runtimeArtifacts.map((relative) => [relative,
  createHash("sha256").update(fs.readFileSync(path.join(root, relative))).digest("hex")]));
const report = { kind: "native-kas-hash-chain-live-v1", network: "kaspa:testnet-10", startedAt: new Date().toISOString(),
  runtimeSha256, evidenceSource: {
    class: "configured-pnn-selected-chain-v2", independentlyOperatedSources: 1,
    origins: "pre-spend PNN UTXO snapshots", finality: "selected-chain checkpoint continuity",
  },
  status: "running", stages: [], transactions: [], x402: [] };
const persist = () => writePrivateJson(reportFile, report);
persist();

const sdkRequire = createRequire(path.join(root, ".kaspa-x402-live/runtime/sdk-v2.0.0/kaspa.js"));
globalThis.WebSocket = sdkRequire("websocket").w3cwebsocket;
const sdk = sdkRequire("./kaspa.js");
const rawWallet = fs.readFileSync(path.resolve(options.walletFile), "utf8").trim();
const fundingPrivateKeyHex = path.extname(options.walletFile) === ".json"
  ? JSON.parse(rawWallet).private_key : rawWallet;
if (!/^[0-9a-fA-F]{64}$/.test(fundingPrivateKeyHex)) throw new Error("wallet file does not contain a 32-byte private key");
const fundingKey = new sdk.PrivateKey(fundingPrivateKeyHex);
const fundingAddress = fundingKey.toAddress("testnet-10").toString();
const fundingPublicKey = Buffer.from(schnorr.getPublicKey(Buffer.from(fundingPrivateKeyHex, "hex"))).toString("hex");
const fundingScript = scriptHex(sdk.payToAddressScript(fundingAddress));
const rpc = new sdk.RpcClient({ url: options.rpcUrl, networkId: "testnet-10" });
let issuer;
let http;
try {
  await rpc.connect({ timeoutDuration: 15_000, retries: 2 });
  const info = await rpc.getServerInfo();
  if (String(info.networkId) !== "testnet-10" || !info.isSynced || !info.hasUtxoIndex) {
    throw new Error("the configured node is not a synced Testnet-10 UTXO-index node");
  }
  const ownerPrivateKey = Buffer.from(schnorr.utils.randomSecretKey()).toString("hex");
  const ownerPublicKey = Buffer.from(schnorr.getPublicKey(Buffer.from(ownerPrivateKey, "hex"))).toString("hex");
  writePrivateText(path.join(outputDir, "owner-key"), ownerPrivateKey);
  const grants = generateHashChainBorrowGrants(3);
  const headId = randomBytes(32).toString("hex");
  let genesisFunding = (await getAddressUtxos(rpc, fundingAddress))
    .filter((item) => item.covenantId === undefined && BigInt(item.amount) > 70_000_000n)
    .sort((a, b) => BigInt(a.amount) < BigInt(b.amount) ? -1 : 1)[0];
  if (!genesisFunding) throw new Error("no spendable Testnet-10 funding UTXO for genesis");
  if (BigInt(genesisFunding.amount) > 200_000_000n) {
    await createFundingShard(rpc, sdk, fundingKey, fundingAddress, genesisFunding);
    genesisFunding = (await getAddressUtxos(rpc, fundingAddress)).find((item) => item.amount === "100000000");
    if (!genesisFunding) throw new Error("the accepted 100m-sompi funding shard is unavailable");
  }
  const genesisFee = 1_000_000n;
  const headAmount = BigInt(genesisFunding.amount) - genesisFee;
  const initialScript = hashChainHeadScriptPublicKey({ ownerPublicKey, guard: grants.initialGuard });
  const unbound = { amount: headAmount.toString(), scriptPublicKey: initialScript, covenant: null };
  const covenantId = transactionV1CovenantId(genesisFunding.outpoint, [{ index: 0, output: unbound }]);
  const genesisUnsigned = referenceTransaction([refInput(genesisFunding, null)], [
    { ...unbound, covenant: { authorizingInput: 0, covenantId } },
  ]);
  const genesis = signReference(genesisUnsigned, [{ index: 0, privateKey: fundingPrivateKeyHex, kind: "p2pk" }]);
  const genesisCheckpoint = await liveChainCheckpoint(rpc);
  await submitReference(rpc, sdk, genesis);
  const genesisAcceptance = await waitForAcceptedTransactionEvidence({ rpc, transactionId: genesis.id,
    fromCheckpoint: genesisCheckpoint, minConfirmationCount: 30 });
  const genesisOrigin = await snapshotTrustedOrigin(rpc, sdk, { txid: genesis.id, index: 0 }, {
    amount: headAmount.toString(), scriptPublicKey: initialScript, covenantId,
  });
  report.stages.push("genesis-accepted");
  report.transactions.push({ role: "genesis", transactionId: genesis.id, predecessor: genesisFunding.outpoint,
    successor: { txid: genesis.id, index: 0 }, amount: headAmount.toString(), covenantId,
    finality: genesisAcceptance.status, confirmationCount: genesisAcceptance.confirmationCount });
  persist();

  // The configured PNN is the proof's authoritative live source. Snapshot
  // accepted origins before spending them, then require selected-chain
  // acceptance of the exact candidate ID before exposing it to the server.
  const trustedOrigins = new Map([[outpointKey({ txid: genesis.id, index: 0 }), genesisOrigin]]);
  const pendingCandidates = new Map();
  const selectedCandidates = new Map();
  const selectedEvidence = new Map([[genesis.id, genesisAcceptance]]);
  const chainView = {
    async getAcceptedOrigins(outpoints, { signal } = {}) {
      signal?.throwIfAborted();
      return outpoints.map((outpoint) => trustedOrigins.get(outpointKey(outpoint)) ?? null);
    },
    async getSelectedTransaction(transactionId, { signal } = {}) {
      signal?.throwIfAborted();
      const id = transactionId.toLowerCase();
      const candidate = selectedCandidates.get(id);
      const evidence = selectedEvidence.get(id);
      if (!candidate || !evidence || !await selectedChainEvidenceRemainsCanonical({ rpc, evidence, signal })) {
        return null;
      }
      return candidate.transaction;
    },
  };

  const storeKey = randomBytes(32);
  writePrivateText(path.join(outputDir, "grant-store-key"), storeKey.toString("hex"));
  issuer = await HashChainGrantIssuer.open({ databasePath: path.join(outputDir, "grants.sqlite"),
    encryptionKey: storeKey, canClaim: () => true });
  issuer.installHead({ headId, network: "kaspa:testnet-10", ownerPublicKey,
    head: { outpoint: { txid: genesis.id, index: 0 }, amount: headAmount.toString(),
      guard: grants.initialGuard, scriptPublicKey: initialScript, covenantId },
    grants: grants.grants });
  const addressCodec = {
    scriptPublicKeyForAddress(address) { return scriptHex(sdk.payToAddressScript(address)); },
    encodeScriptAddress({ serializedScriptPublicKey }) { return addressForScript(sdk, serializedScriptPublicKey); },
  };
  const reserved = new Set([outpointKey(genesisFunding.outpoint)]);
  const trustedSecurityContext = { principal: "hash-chain-live-proof" };
  let server;
  http = createServer(async (req, res) => {
    const disconnect = new AbortController();
    const abortDisconnected = () => {
      if (!res.writableEnded) disconnect.abort(new Error("HTTP caller disconnected"));
    };
    req.once("aborted", abortDisconnected);
    res.once("close", abortDisconnected);
    try {
      const url = `http://127.0.0.1:${http.address().port}${req.url}`;
      if (req.url === "/hash-chain/grant") {
        const body = await readBody(req, 4096);
        const answer = await handleHashChainGrantClaimHttp(server,
          new Request(url, { method: req.method, headers: req.headers, body,
            signal: disconnect.signal }));
        res.writeHead(answer.status, Object.fromEntries(answer.headers));
        res.end(await answer.text());
        return;
      }
      const resource = { url };
      const answer = await server.handlePaidRequest({ method: req.method, url,
        headers: req.headers, resource, paymentScheme: "exact", trustedSecurityContext,
        signal: disconnect.signal },
        async () => ({ status: 200, body: { access: "granted", resource: req.url } }));
      res.writeHead(answer.status, answer.headers);
      res.end(JSON.stringify(answer.body));
    } catch {
      res.writeHead(503, { "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "request_failed" }));
    } finally {
      req.off("aborted", abortDisconnected);
      res.off("close", abortDisconnected);
    }
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${http.address().port}`;
  const grantDestinationPolicy = { allowedOrigins: [origin] };
  server = new DirectModeServer({
    network: "kaspa:testnet-10", payTo: fundingAddress, serverPublicKey: ownerPublicKey,
    minDepositSompi: "1000", claimReserveSompi: "10", amount: "20000000",
    refundTimeoutDaa: "1000", minimumRefundLeadDaa: "0", confirmationThreshold: 30,
    maxTimeoutSeconds: 150, acceptedFinality: "accepted", store: new MemoryServerChannelStore(),
    chainProvider: { async getVirtualDaaScore() { return String((await rpc.getServerInfo()).virtualDaaScore); },
      async sendTransaction() { throw new Error("hash-chain payer must broadcast"); } },
    addressCodec, voucherVerifier: { verifyVoucher: () => false },
    batchPresentationVerifier: { verifyPresentation: () => false },
    exactProfile: "hash-chain-additive", exactTransactionVerifier: new HashChainExactTransactionVerifier(chainView),
    hashChainIssuer: issuer, hashChainHeadId: headId,
    hashChainGrantClaimUrl: `${origin}/hash-chain/grant`,
    admitHashChainChallenge: async () => true,
    hashChainIsSelected: async (transactionId, signal) => {
      signal?.throwIfAborted();
      const evidence = selectedEvidence.get(transactionId.toLowerCase());
      return !!evidence && selectedChainEvidenceRemainsCanonical({ rpc, evidence, signal });
    },
    hashChainGetCurrentUtxo: async (outpoint, signal) => {
      signal?.throwIfAborted();
      const current = issuer.getCurrent(headId).head;
      const address = addressCodec.encodeScriptAddress({
        network: "kaspa:testnet-10",
        scriptPublicKey: { version: 0, script: current.scriptPublicKey.slice(4) },
        serializedScriptPublicKey: current.scriptPublicKey,
      });
      const match = (await getAddressUtxos(rpc, address)).find((utxo) =>
        utxo.outpoint.txid === outpoint.txid && utxo.outpoint.index === outpoint.index);
      signal?.throwIfAborted();
      return match ? {
        outpoint: match.outpoint,
        amount: match.amount,
        scriptPublicKey: match.scriptPublicKey,
        covenantId: match.covenantId ?? null,
      } : null;
    },
  });
  const provider = {
    networkId: "kaspa:testnet-10", sourceKind: "hot-wallet",
    async getPublicIdentity() { return { address: fundingAddress, publicKey: fundingPublicKey }; },
    async claimHashChainGrant(request) {
      return claimHashChainGrantViaHttp(request, (digest) =>
        Buffer.from(schnorr.sign(Buffer.from(digest, "hex"), Buffer.from(fundingPrivateKeyHex, "hex"))).toString("hex"));
    },
    async payHashChainTransaction(request) {
      const file = path.join(outputDir, `attempt-${request.attemptId}.json`);
      if (fs.existsSync(file)) {
        const saved = JSON.parse(fs.readFileSync(file, "utf8"));
        if (saved.intentHash !== request.intentHash) throw new Error("persisted payment intent changed");
        if (!pendingCandidates.has(saved.result.transactionId.toLowerCase())) {
          throw new Error("persisted payment lacks this process's trusted PNN origin snapshots");
        }
        return saved.result;
      }
      const funding = (await getAddressUtxos(rpc, fundingAddress))
        .filter((item) => !reserved.has(outpointKey(item.outpoint)) && !item.covenantId &&
          BigInt(item.amount) > BigInt(request.amount) + 2_000_000n)
        .sort((a, b) => BigInt(a.amount) < BigInt(b.amount) ? -1 : 1)[0];
      if (!funding) throw new Error("payer funding is unavailable");
      const result = signHashChainExactTransaction({ request,
        funding: { outpoint: funding.outpoint, amount: funding.amount,
          scriptPublicKey: funding.scriptPublicKey, privateKey: fundingPrivateKeyHex,
          payerAddress: fundingAddress }, feeSompi: "1000000" });
      if (!request.hashChainHead) throw new Error("hash-chain payment request is missing its trusted head");
      trustedOrigins.set(outpointKey(funding.outpoint), {
        amount: funding.amount, scriptPublicKey: funding.scriptPublicKey, covenantId: null,
      });
      const successorOrigin = {
        amount: (BigInt(request.hashChainHead.headAmount) + BigInt(request.amount)).toString(),
        scriptPublicKey: request.payToScriptPublicKey,
        covenantId: request.hashChainHead.covenantId,
      };
      pendingCandidates.set(result.transactionId.toLowerCase(), {
        transaction: {
          transactionId: result.transactionId.toLowerCase(), finality: "accepted",
          spentHead: request.hashChainHead.expectedHeadOutpoint,
          successor: { ...successorOrigin, authorizingInput: 0 },
        },
        expectedSuccessor: successorOrigin,
        file, intentHash: request.intentHash, result,
      });
      writePrivateJson(file, { intentHash: request.intentHash, result });
      reserved.add(outpointKey(funding.outpoint));
      return result;
    },
    async finalizeExactPaymentAttempt() {},
    async sendTransaction(transaction) {
      const parsed = sdk.Transaction.deserializeFromSafeJSON(transaction);
      const transactionId = parsed.id.toLowerCase();
      const existing = selectedCandidates.get(transactionId);
      const existingEvidence = selectedEvidence.get(transactionId);
      if (existing && existingEvidence) {
        if (!await selectedChainEvidenceRemainsCanonical({ rpc, evidence: existingEvidence })) {
          throw new Error("previously accepted hash-chain candidate was removed from the selected chain");
        }
        return { transactionId, evidence: existingEvidence };
      }
      const candidate = pendingCandidates.get(transactionId);
      if (!candidate) throw new Error("submitted hash-chain candidate was not prepared by this proof run");
      if (!candidate.broadcastCheckpoint) {
        requireAuthorizationBudget(candidate,
          (2 * HASH_CHAIN_RPC_TIMEOUT_MS) + HASH_CHAIN_MIN_ACCEPTANCE_WINDOW_MS +
            HASH_CHAIN_POST_ACCEPTANCE_RESERVE_MS,
          "hash-chain authorization cannot safely fit checkpoint, broadcast, and settlement");
        candidate.broadcastCheckpoint = await runWithTimeout(
          "hash-chain pre-broadcast checkpoint",
          HASH_CHAIN_RPC_TIMEOUT_MS,
          (signal) => liveChainCheckpoint(rpc, { signal }),
        );
        candidate.broadcastStartedAt = new Date().toISOString();
        writePrivateJson(candidate.file, {
          intentHash: candidate.intentHash, result: candidate.result,
          broadcastCheckpoint: candidate.broadcastCheckpoint,
          broadcastStartedAt: candidate.broadcastStartedAt,
        });
      }
      let submissionError;
      const submissionBudgetMs = HASH_CHAIN_RPC_TIMEOUT_MS + HASH_CHAIN_MIN_ACCEPTANCE_WINDOW_MS +
        HASH_CHAIN_POST_ACCEPTANCE_RESERVE_MS;
      const remainingBeforeSubmission = authorizationRemainingMs(candidate);
      const hasPriorSubmission = Boolean(candidate.lastSubmissionStartedAt);
      if (!hasPriorSubmission && remainingBeforeSubmission < submissionBudgetMs) {
        throw new Error("hash-chain authorization cannot safely fit broadcast and settlement");
      }
      if (remainingBeforeSubmission >= submissionBudgetMs) {
        candidate.lastSubmissionStartedAt = new Date().toISOString();
        try {
          const submitted = await runWithTimeout(
            "hash-chain transaction submission",
            HASH_CHAIN_RPC_TIMEOUT_MS,
            (signal) => awaitWithSignal(
              rpc.submitTransaction({ transaction: parsed, allowOrphan: false }),
              signal,
            ),
          );
          if (String(submitted.transactionId).toLowerCase() !== transactionId) {
            throw new Error("broadcast ID mismatch");
          }
          candidate.submissionAcknowledgedAt = new Date().toISOString();
        } catch (error) {
          submissionError = error;
        }
      } else {
        candidate.readbackOnlyStartedAt = new Date().toISOString();
        submissionError = new Error(
          "hash-chain retry skipped rebroadcast to preserve the settlement window",
        );
      }
      writePrivateJson(candidate.file, {
        intentHash: candidate.intentHash, result: candidate.result,
        broadcastCheckpoint: candidate.broadcastCheckpoint,
        broadcastStartedAt: candidate.broadcastStartedAt,
        lastSubmissionStartedAt: candidate.lastSubmissionStartedAt,
        ...(candidate.submissionAcknowledgedAt
          ? { submissionAcknowledgedAt: candidate.submissionAcknowledgedAt }
          : {}),
        ...(candidate.readbackOnlyStartedAt
          ? { readbackOnlyStartedAt: candidate.readbackOnlyStartedAt }
          : {}),
      });
      let evidence;
      try {
        const remainingAuthorizationMs = authorizationRemainingMs(candidate) -
          HASH_CHAIN_POST_ACCEPTANCE_RESERVE_MS;
        if (!Number.isSafeInteger(remainingAuthorizationMs) || remainingAuthorizationMs <= 0) {
          throw new Error("hash-chain acceptance was not proven before the settlement safety margin");
        }
        evidence = await waitForAcceptedTransactionEvidence({ rpc, transactionId,
          fromCheckpoint: candidate.broadcastCheckpoint, minConfirmationCount: 1,
          timeoutMs: Math.min(120_000, remainingAuthorizationMs) });
      } catch (error) {
        if (submissionError) {
          throw new AggregateError([submissionError, error], "hash-chain broadcast was not proven selected");
        }
        throw error;
      }
      if (evidence.transactionId.toLowerCase() !== transactionId) {
        throw new Error("selected-chain evidence belongs to a different hash-chain candidate");
      }
      const successorOrigin = await snapshotTrustedOrigin(
        rpc, sdk, { txid: transactionId, index: 0 }, candidate.expectedSuccessor, {
          timeoutMs: HASH_CHAIN_ORIGIN_SNAPSHOT_TIMEOUT_MS,
        },
      );
      selectedCandidates.set(transactionId, candidate);
      selectedEvidence.set(transactionId, evidence);
      trustedOrigins.set(outpointKey({ txid: transactionId, index: 0 }), successorOrigin);
      return { transactionId, evidence };
    },
  };
  const client = new DirectModeClient({ fundingProvider: provider, signer: {},
    store: new MemoryChannelStore(), addressCodec, confirmationThreshold: 30,
    fundingPolicy: { allowedExactProfiles: ["hash-chain-additive"], allowedOrigins: [origin],
      maximumExactAmountSompi: "20000000" },
    hashChainGrantDestinationPolicy: grantDestinationPolicy, fetch,
  });
  for (let i = 1; i <= 2; i++) {
    const url = `${origin}/resource/${i}`;
    const paymentIdentifier = `hash_chain_tn10_${path.basename(outputDir).replace(/[^A-Za-z0-9_-]/g, "_")}_${i}`;
    let outcome;
    let lastPending;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { outcome = await client.paidFetch(url, { paymentIdentifier, trustedSecurityContext }); break; }
      catch (error) {
        if (!(error instanceof PendingExactPaymentError)) throw error;
        lastPending = error;
        await sleep(1000);
      }
    }
    if (!outcome || outcome.response.status !== 200 || !outcome.payment?.transactionId) {
      throw new AggregateError(lastPending ? [lastPending] : [],
        `payment ${i} did not produce a selected-chain x402 success`);
    }
    const txid = outcome.payment.transactionId;
    const settlement = decodePaymentResponseHeader(outcome.response.headers.get("PAYMENT-RESPONSE"));
    const selected = selectedCandidates.get(txid);
    const evidence = selectedEvidence.get(txid);
    if (!settlement.success || settlement.transaction !== txid || !selected || !evidence ||
      !await selectedChainEvidenceRemainsCanonical({ rpc, evidence })) {
      throw new Error(`payment ${i} lacks selected-chain x402 settlement evidence`);
    }
    const current = issuer.getCurrent(headId);
    report.x402.push({ payment: i, resource: url, responseStatus: outcome.response.status,
      paymentRequiredBinding: outcome.payment.accepted.extra.binding,
      paymentResponseSha256: sha256Hex(outcome.response.headers.get("PAYMENT-RESPONSE")),
      settlement, transactionId: txid, headVersion: current.headVersion,
      head: current.head, acceptance: {
        acceptingBlockHash: evidence.acceptingBlockHash,
        confirmationCount: evidence.confirmationCount,
        selectedPnn: true,
      } });
    report.stages.push(`payment-${i}-accepted`);
    persist();
  }

  const abandonUrl = `${origin}/resource/abandoned`;
  const abandonedResponse = await fetch(abandonUrl);
  if (abandonedResponse.status !== 402) throw new Error("abandonment challenge was not offered");
  const abandonedRequired = decodePaymentRequiredHeader(abandonedResponse.headers.get("PAYMENT-REQUIRED"));
  const abandoned = abandonedRequired.accepts[0];
  if (abandoned?.scheme !== "exact" || abandoned.extra.profile !== "hash-chain-additive") throw new Error("abandonment offer is invalid");
  const abandonHash = bindRequestHashToTrustedContext(
    sha256Hex(stableStringify({ method: "GET", url: abandonUrl, body: null })),
    trustedSecurityContext,
  );
  const abandonedGrant = await claimHashChainGrantViaHttp({ network: "kaspa:testnet-10",
    head: { headId: abandoned.extra.headId, headVersion: abandoned.extra.headVersion,
      covenantId: abandoned.extra.covenantId, expectedHeadOutpoint: abandoned.extra.expectedHeadOutpoint,
      headAmount: abandoned.extra.headAmount, headScriptPublicKey: abandoned.extra.headScriptPublicKey,
      headRedeemScript: abandoned.extra.headRedeemScript, currentGuard: abandoned.extra.currentGuard,
      nextGuard: abandoned.extra.nextGuard, oneTimePublicKey: abandoned.extra.oneTimePublicKey,
      grantId: abandoned.extra.grantId, grantClaimUrl: abandoned.extra.grantClaimUrl,
      challengeId: abandoned.extra.challengeId, challengeExpiresAt: abandoned.extra.challengeExpiresAt },
    resourceUrl: abandonUrl, requestHash: abandonHash, payerPublicKey: fundingPublicKey,
    destinationPolicy: grantDestinationPolicy },
    (digest) => Buffer.from(schnorr.sign(Buffer.from(digest, "hex"), Buffer.from(fundingPrivateKeyHex, "hex"))).toString("hex"));
  report.stages.push("grant-delivered-and-abandoned");
  report.abandonedGrant = { grantId: abandonedGrant.grantId, headVersion: abandonedGrant.headVersion,
    headOutpoint: abandoned.extra.expectedHeadOutpoint, expiresAt: abandonedGrant.expiresAt };
  persist();
  await sleep(Math.max(0, Date.parse(abandonedGrant.expiresAt) - Date.now() + 1000));
  const abandonedState = issuer.markAbandoned(headId);
  if (abandonedState.phase !== "needsRotation") throw new Error("abandoned grant did not require owner rotation");
  const replacement = generateHashChainBorrowGrants(2);
  const before = issuer.getCurrent(headId);
  const rotationFunding = (await getAddressUtxos(rpc, fundingAddress))
    .filter((item) => !reserved.has(outpointKey(item.outpoint)) && !item.covenantId && BigInt(item.amount) > 1_000_000n)
    .sort((a, b) => BigInt(a.amount) < BigInt(b.amount) ? -1 : 1)[0];
  if (!rotationFunding) throw new Error("owner rotation fee funding is unavailable");
  const rotatedScript = hashChainHeadScriptPublicKey({ ownerPublicKey, guard: replacement.initialGuard });
  const rotationUnsigned = referenceTransaction([
    refInput({ outpoint: before.head.outpoint, amount: before.head.amount,
      scriptPublicKey: before.head.scriptPublicKey }, covenantId),
    refInput(rotationFunding, null),
  ], [
    { amount: before.head.amount, scriptPublicKey: rotatedScript,
      covenant: { authorizingInput: 0, covenantId } },
    { amount: (BigInt(rotationFunding.amount) - 1_000_000n).toString(),
      scriptPublicKey: rotationFunding.scriptPublicKey, covenant: null },
  ]);
  const rotation = signReference(rotationUnsigned, [
    { index: 0, privateKey: ownerPrivateKey, kind: "owner-rotation",
      redeemScript: abandoned.extra.headRedeemScript, newGuard: replacement.initialGuard },
    { index: 1, privateKey: fundingPrivateKeyHex, kind: "p2pk" },
  ]);
  const rotationCheckpoint = await liveChainCheckpoint(rpc);
  await submitReference(rpc, sdk, rotation);
  const rotationAcceptance = await waitForAcceptedTransactionEvidence({ rpc, transactionId: rotation.id,
    fromCheckpoint: rotationCheckpoint, minConfirmationCount: 1 });
  const rotationOrigin = await snapshotTrustedOrigin(rpc, sdk, { txid: rotation.id, index: 0 }, {
    amount: before.head.amount, scriptPublicKey: rotatedScript, covenantId,
  });
  selectedEvidence.set(rotation.id, rotationAcceptance);
  const after = issuer.recordAcceptedRotation(headId, {
    finality: "accepted", predecessor: before.head.outpoint,
    successor: { outpoint: { txid: rotation.id, index: 0 }, amount: rotationOrigin.amount,
      guard: replacement.initialGuard, scriptPublicKey: rotationOrigin.scriptPublicKey,
      covenantId: rotationOrigin.covenantId },
  }, replacement.grants);
  if (after.phase !== "ready" || after.headVersion !== before.headVersion + 1 ||
    after.head.covenantId !== covenantId ||
    !await selectedChainEvidenceRemainsCanonical({ rpc, evidence: rotationAcceptance })) {
    throw new Error("accepted owner rotation did not restore a ready same-ID head");
  }
  report.transactions.push({ role: "owner-rotation", transactionId: rotation.id,
    predecessor: before.head.outpoint, successor: after.head.outpoint,
    beforeVersion: before.headVersion, afterVersion: after.headVersion,
    covenantId, finality: rotationAcceptance.status,
    acceptingBlockHash: rotationAcceptance.acceptingBlockHash,
    confirmationCount: rotationAcceptance.confirmationCount, selectedPnn: true });
  for (const evidence of selectedEvidence.values()) {
    if (!await selectedChainEvidenceRemainsCanonical({ rpc, evidence })) {
      throw new Error("a reported transaction was removed from the selected chain before proof completion");
    }
  }
  report.stages.push("abandoned-grant-owner-rotation-accepted");
  report.status = "complete";
  report.completedAt = new Date().toISOString();
  persist();
  console.log(JSON.stringify({ status: report.status, reportFile, transactionIds: report.transactions.map((item) => item.transactionId),
    paymentIds: report.x402.map((item) => item.transactionId), headVersion: after.headVersion }));
} catch (error) {
  report.status = "failed";
  report.failure = error instanceof Error ? error.message : String(error);
  report.failedAt = new Date().toISOString();
  persist();
  console.error(`hash-chain Testnet-10 proof failed; see ${reportFile}: ${report.failure}`);
  process.exitCode = 1;
} finally {
  issuer?.close();
  if (http) await new Promise((resolve) => http.close(resolve));
  await rpc.disconnect().catch(() => {});
}

function parseOptions(argv) {
  const parsed = { live: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--live") parsed.live = true;
    else if (argv[i] === "--wallet-file") parsed.walletFile = argv[++i];
    else if (argv[i] === "--rpc-url") parsed.rpcUrl = argv[++i];
    else if (argv[i] === "--output-dir") parsed.outputDir = argv[++i];
    else throw new Error(`unsupported option ${argv[i]}`);
  }
  return parsed;
}
function writePrivateText(file, value) { fs.writeFileSync(file, `${value}\n`, { mode: 0o600, flag: "wx" }); }
function writePrivateJson(file, value) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}
function scriptHex(value) {
  if (typeof value === "string") return value.toLowerCase();
  const script = value.script instanceof Uint8Array ? Buffer.from(value.script).toString("hex") : String(value.script);
  return `${Number(value.version).toString(16).padStart(4, "0")}${script}`.toLowerCase();
}
function addressForScript(sdk, serialized) {
  const bytes = Buffer.from(serialized, "hex");
  const spk = new sdk.ScriptPublicKey((bytes[0] << 8) | bytes[1], bytes.subarray(2));
  return sdk.addressFromScriptPublicKey(spk, "testnet-10").toString();
}
async function snapshotTrustedOrigin(
  rpc,
  sdk,
  outpoint,
  expected,
  { signal, timeoutMs = HASH_CHAIN_ORIGIN_SNAPSHOT_TIMEOUT_MS } = {},
) {
  const address = addressForScript(sdk, expected.scriptPublicKey);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const activeSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  try {
    while (true) {
      activeSignal.throwIfAborted();
      const matches = (await awaitWithSignal(getAddressUtxos(rpc, address), activeSignal)).filter((item) =>
        item.outpoint.txid.toLowerCase() === outpoint.txid.toLowerCase() &&
        item.outpoint.index === outpoint.index);
      if (matches.length > 1) throw new Error("PNN returned duplicate trusted origin outputs");
      if (matches.length === 1) {
        const observed = matches[0];
        const covenantId = observed.covenantId ?? null;
        if (observed.amount !== expected.amount ||
          observed.scriptPublicKey.toLowerCase() !== expected.scriptPublicKey.toLowerCase() ||
          covenantId !== expected.covenantId) {
          throw new Error("PNN trusted origin output differs from the exact candidate");
        }
        return { amount: observed.amount, scriptPublicKey: observed.scriptPublicKey.toLowerCase(), covenantId };
      }
      await awaitWithSignal(sleep(250), activeSignal);
    }
  } catch (error) {
    if (!timeoutSignal.aborted || signal?.aborted) throw error;
  }
  throw new Error("PNN did not return the current trusted origin output");
}
function outpointKey(outpoint) { return `${outpoint.txid}:${outpoint.index}`; }
function refInput(utxo, covenantId) {
  return { previousOutpoint: utxo.outpoint, signatureScript: "", sequence: "0", computeBudget: 10,
    utxo: { amount: utxo.amount, scriptPublicKey: utxo.scriptPublicKey,
      blockDaaScore: "0", isCoinbase: false, covenantId } };
}
function referenceTransaction(inputs, outputs) {
  const mass = calculateKaspaStorageMass({
    inputs: inputs.map((item) => ({ amount: item.utxo.amount, scriptPublicKey: item.utxo.scriptPublicKey,
      hasCovenant: item.utxo.covenantId !== null })),
    outputs: outputs.map((item) => ({ amount: item.amount, scriptPublicKey: item.scriptPublicKey,
      hasCovenant: item.covenant !== null })),
  });
  return { version: 1, inputs, outputs, lockTime: "0", subnetworkId: "00".repeat(20),
    gas: "0", payload: "", mass: mass.toString(), estimatedSerializedSize: 0 };
}
function signReference(unsigned, signers) {
  const inputs = unsigned.inputs.map((item) => ({ ...item }));
  for (const signer of signers) {
    const digest = transactionV1Sighash(unsigned, signer.index).digest;
    const signature = Buffer.from(schnorr.sign(Buffer.from(digest, "hex"), Buffer.from(signer.privateKey, "hex"))).toString("hex");
    inputs[signer.index].signatureScript = signer.kind === "owner-rotation"
      ? buildHashChainOwnerRotationSignatureScript({ newGuard: signer.newGuard,
        signature, redeemScript: signer.redeemScript })
      : buildTxV1P2pkSignatureScript(signature);
  }
  const transaction = { ...unsigned, inputs };
  return { id: transactionV1Id(transaction), transaction };
}
async function submitReference(rpc, sdk, signed) {
  const transaction = referenceTransactionToSdk(sdk, signed.transaction);
  if (transaction.id.toLowerCase() !== signed.id) throw new Error("Kaspa SDK transaction ID differs from canonical v1 ID");
  const accepted = await rpc.submitTransaction({ transaction, allowOrphan: false });
  if (String(accepted.transactionId).toLowerCase() !== signed.id) throw new Error("node returned a different transaction ID");
}
async function readBody(request, limit) {
  let text = "";
  for await (const chunk of request) {
    text += chunk.toString("utf8");
    if (text.length > limit) throw new Error("request too large");
  }
  return text;
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function authorizationRemainingMs(candidate) {
  const expiresAt = Date.parse(candidate.result.authorization.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    throw new Error("hash-chain authorization expiry is invalid");
  }
  return expiresAt - Date.now();
}

function requireAuthorizationBudget(candidate, requiredMs, message) {
  if (authorizationRemainingMs(candidate) < requiredMs) throw new Error(message);
}

async function runWithTimeout(label, timeoutMs, operation) {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await operation(signal);
  } catch (error) {
    if (!signal.aborted) throw error;
    throw new Error(`${label} timed out`, { cause: error });
  }
}

function awaitWithSignal(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new Error("operation aborted"));
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

async function createFundingShard(rpc, sdk, fundingKey, address, source) {
  const splitAmount = 100_000_000n;
  const fee = 1_000_000n;
  const script = sdk.payToAddressScript(address);
  const raw = Buffer.from(source.scriptPublicKey, "hex");
  const sourceScript = new sdk.ScriptPublicKey((raw[0] << 8) | raw[1], raw.subarray(2));
  const inputBase = { previousOutpoint: { transactionId: source.outpoint.txid, index: source.outpoint.index },
    sequence: 0n, sigOpCount: 1, utxo: {
      outpoint: { transactionId: source.outpoint.txid, index: source.outpoint.index },
      amount: BigInt(source.amount), scriptPublicKey: sourceScript,
      blockDaaScore: 0n, isCoinbase: false,
    } };
  const shape = { version: 0, outputs: [
    { value: splitAmount, scriptPublicKey: script },
    { value: BigInt(source.amount) - splitAmount - fee, scriptPublicKey: script },
  ], lockTime: 0n, subnetworkId: "00".repeat(20), gas: 0n, payload: "" };
  const unsigned = new sdk.Transaction({ ...shape, inputs: [{ ...inputBase, signatureScript: "" }] });
  const signatureScript = sdk.createInputSignature(unsigned, 0, fundingKey, sdk.SighashType.All);
  const signed = new sdk.Transaction({ ...shape, inputs: [{ ...inputBase, signatureScript }] });
  const checkpoint = await liveChainCheckpoint(rpc);
  const submitted = await rpc.submitTransaction({ transaction: signed, allowOrphan: false });
  if (String(submitted.transactionId).toLowerCase() !== signed.id.toLowerCase()) throw new Error("funding split ID mismatch");
  await waitForAcceptedTransactionEvidence({ rpc, transactionId: signed.id,
    fromCheckpoint: checkpoint, minConfirmationCount: 30 });
}
