import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import {
  DirectModeClient,
  MemoryChannelStore,
  PAYMENT_SIGNATURE_HEADER,
} from "@kaspa-x402/client";
import {
  bytesToHex,
  decodePaymentResponseHeader,
  encodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  hexToBytes,
  readKaspaSettlementExtension,
  sha256Hex,
  stableStringify,
  voucherDigest,
} from "@kaspa-x402/core";
import {
  buildClaimArgs,
  buildEscrowRedeemScript,
  buildRefundArgs,
  CLAIM_COMPUTE_BUDGET,
  REFUND_COMPUTE_BUDGET,
  escrowScriptPublicKey,
  serializedScriptPublicKey,
} from "@kaspa-x402/covenant";
import { DirectModeServer, MemoryServerChannelStore } from "@kaspa-x402/server";

// Reference adapter for scripts/proof-live-testnet.mjs. It is testnet-only,
// spends testnet funds, and writes local signing/recovery material under
// KASPA_X402_DATA_DIR. Keep that directory out of source control.
const NATIVE_SUBNETWORK_ID = "00".repeat(20);
const DEFAULT_CONFIRMATION_TIMEOUT_MS = 120_000;
const DEFAULT_FEE_SOMPI = 2_000_000n;
const EXACT_AMOUNT = "100000000";
const BATCH_REQUEST_AMOUNT = "100000000";
const BATCH_DEPOSIT_AMOUNT = "400000000";
const SDK_GENERATED_TX_VERSION_SOURCE = "sdk-generated-transaction";
const ADAPTER_SUBMITTED_TX_VERSION_SOURCE = "adapter-submitted-transaction-shape";

export async function runLiveProof(context) {
  const sdkPath = process.env.KASPA_X402_KASPA_WASM_MODULE;
  if (!sdkPath) throw new Error("KASPA_X402_KASPA_WASM_MODULE is required by the reference live adapter");

  const absoluteSdkPath = path.resolve(sdkPath);
  const sdkRequire = createRequire(absoluteSdkPath);
  globalThis.WebSocket = sdkRequire("websocket").w3cwebsocket;
  const sdk = sdkRequire(absoluteSdkPath);
  const { schnorr } = sdkRequire("@noble/curves/secp256k1");
  sdk.initConsolePanicHook?.();

  const networkId = kaspaNetworkId(context.network);
  const dataDir = path.resolve(context.dataDir);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const fundingPrivateKeyHex = loadFundingPrivateKey(context.fundingWallet);
  const fundingPrivateKey = new sdk.PrivateKey(fundingPrivateKeyHex);
  const fundingAddress = fundingPrivateKey.toAddress(networkId).toString();
  const fundingPublicKey = bytesToHex(schnorr.getPublicKey(hexToBytes(fundingPrivateKeyHex, { expectedLength: 32 })));
  const serverChannelKey = loadOrCreateChannelKey(path.join(dataDir, "server-channel-key"), schnorr);
  const serverPayoutKey = loadOrCreateWalletKey(path.join(dataDir, "server-payout-key"), sdk);
  const serverPayoutAddress = serverPayoutKey.toAddress(networkId).toString();

  const rpc = new sdk.RpcClient({ url: context.rpcUrl, networkId });
  const pendingBroadcasts = new Map();
  const knownUtxos = new Map();
  const fundingVersionByTxid = new Map();
  try {
    await rpc.connect({ timeoutDuration: 15_000, retries: 2 });
    const serverInfo = await rpc.getServerInfo();
    if (!serverInfo.isSynced) throw new Error("configured testnet node reports unsynced");
    if (!serverInfo.hasUtxoIndex) throw new Error("configured testnet node does not expose UTXO index");

    const timeoutDelta = positiveBigInt(context.timeoutDaa, "timeoutDaa");
    const refundTimeoutDaa = (BigInt(serverInfo.virtualDaaScore) + timeoutDelta).toString();
    const addressCodec = makeAddressCodec(sdk, networkId);
    const chain = makeChainProvider({
      rpc,
      sdk,
      addressCodec,
      networkId,
      pendingBroadcasts,
      knownUtxos,
      dataDir,
    });
    const fundingProvider = makeFundingProvider({
      rpc,
      sdk,
      addressCodec,
      chain,
      networkId,
      network: context.network,
      fundingPrivateKey,
      fundingPrivateKeyHex,
      fundingAddress,
      fundingPublicKey,
      pendingBroadcasts,
      knownUtxos,
      fundingVersionByTxid,
    });
    const signer = makeSigner({
      schnorr,
      fundingPrivateKeyHex,
      fundingPublicKey,
      dataDir,
    });
    const serverStore = new MemoryServerChannelStore();
    const clientStore = new MemoryChannelStore();
    const server = new DirectModeServer({
      network: context.network,
      payTo: serverPayoutAddress,
      serverPublicKey: serverChannelKey.publicKey,
      amount: EXACT_AMOUNT,
      minDepositSompi: BATCH_DEPOSIT_AMOUNT,
      refundTimeoutDaa,
      store: serverStore,
      chainProvider: chain,
      addressCodec,
      voucherVerifier: {
        verifyVoucher({ digest, voucher, clientPublicKey }) {
          return schnorr.verify(hexToBytes(voucher.signature, { expectedLength: 64 }), hexToBytes(digest, { expectedLength: 32 }), hexToBytes(clientPublicKey, { expectedLength: 32 }));
        },
      },
      exactTransactionVerifier: {
        async verifyExactPayment(request) {
          const utxo = await waitForAddressOutpoint({
            rpc,
            address: request.payTo,
            txid: request.transactionId,
            index: request.paymentOutputIndex,
            amount: BigInt(request.amount),
            scriptPublicKey: request.payToScriptPublicKey,
          });
          return {
            transactionId: utxo.outpoint.txid,
            paymentOutput: {
              amount: utxo.amount,
              scriptPublicKey: utxo.scriptPublicKey,
              address: request.payTo,
            },
            finality: "accepted",
            payerAddress: fundingAddress,
          };
        },
      },
      claimBuilder: {
        async buildClaimTransaction({ channel, claimAmount }) {
          return buildAndSubmitClaim({
            channel,
            claimAmount,
            rpc,
            sdk,
            networkId,
            serverPrivateKeyHex: serverChannelKey.privateKey,
            addressCodec,
            pendingBroadcasts,
            knownUtxos,
          });
        },
      },
      acceptedFinality: "accepted",
    });
    const client = new DirectModeClient({
      fundingProvider,
      signer,
      store: clientStore,
      addressCodec,
      refundAddress: fundingAddress,
      supportedNetworks: [context.network],
    });

    const report = {
      node: {
        rpcUrl: context.rpcUrl,
        networkId: serverInfo.networkId,
        virtualDaaScore: String(serverInfo.virtualDaaScore),
      },
      addresses: {
        funding: fundingAddress,
        serverPayout: serverPayoutAddress,
      },
      timeout: {
        deltaDaa: timeoutDelta.toString(),
        refundTimeoutDaa,
      },
    };
    let flow = "exact";
    try {
      report.exact = await runExact({ client, server, fundingVersionByTxid });
      flow = "batch";
      report.batch = await runBatch({
        client,
        server,
        serverStore,
        rpc,
        sdk,
        networkId,
        addressCodec,
        serverPrivateKeyHex: serverChannelKey.privateKey,
        fundingAddress,
        pendingBroadcasts,
        knownUtxos,
        fundingVersionByTxid,
        timeoutDaa: BigInt(refundTimeoutDaa),
      });
    } catch (error) {
      throw new Error(`${flow} flow failed: ${error?.message ?? String(error)} ${JSON.stringify(error?.details ?? error?.cause ?? null)}`);
    }
    report.requiredFlowStatus = Object.fromEntries(context.requiredFlows.map((flow) => [flow, "passed"]));
    report.fundingBalanceAfterSompi = (await balanceSompi(rpc, fundingAddress)).toString();
    return report;
  } finally {
    try {
      await rpc.disconnect();
    } catch {
      // best effort shutdown
    }
  }
}

async function runExact({ client, server, fundingVersionByTxid }) {
  const resource = { url: "https://live.kaspa-x402.local/exact", description: "Live exact proof" };
  const payment = await client.createPayment(paymentRequiredFor(server, { resource, amount: EXACT_AMOUNT, scheme: "exact" }), {
    url: resource.url,
  });
  const requestHash = payment.paymentPayload.payload.requestHash;
  if (!requestHash) throw new Error("exact payment did not include a request hash");
  try {
    await server.verifyPayment({
      resource,
      paymentRequirements: payment.paymentPayload.accepted,
      paymentPayload: payment.paymentPayload,
      requestHash,
    });
  } catch (error) {
    throw new Error(`exact preflight verify failed: ${error?.code ?? "error"} ${error?.message ?? String(error)}`);
  }
  const response = await server.handlePaidRequest(requestWithPayment(payment.paymentPayload, { url: resource.url, resource, scheme: "exact", amount: EXACT_AMOUNT, requestHash }), async () => ({
    status: 200,
    body: { ok: true },
  }));
  if (response.status !== 200) {
    throw new Error(`exact payment failed: ${JSON.stringify({ status: response.status, body: response.body, headers: response.headers })}`);
  }
  const settlement = decodeResponse(response);
  const settlementExtra = requireSettlementExtension(settlement);
  await client.applySettlement(payment, settlement);
  const replayPayload = JSON.parse(JSON.stringify(payment.paymentPayload));
  delete replayPayload.payload.requestHash;
  const replay = await server.handlePaidRequest(requestWithPayment(replayPayload, { url: `${resource.url}/replay`, resource, scheme: "exact", amount: EXACT_AMOUNT, requestHash: hash({ flow: "exact", request: 2 }) }), async () => ({
    status: 200,
    body: { ok: false },
  }));
  if (replay.status !== 409 || replay.body?.error !== "invalid_transaction_state") {
    throw new Error(`exact replay was not rejected: ${replay.status}`);
  }
  const legacyPayload = JSON.parse(JSON.stringify(payment.paymentPayload));
  legacyPayload.payload = {
    ...legacyPayload.payload,
    transaction: "00",
  };
  delete legacyPayload.payload.transactionId;
  delete legacyPayload.payload.paymentOutputIndex;
  const legacyTransactionPayloadRejected = await server.handlePaidRequest(requestWithPaymentHeader(unsafePaymentHeader(legacyPayload), {
    url: `${resource.url}/legacy-transaction`,
    resource,
    scheme: "exact",
    amount: EXACT_AMOUNT,
    requestHash: hash({ flow: "exact", request: "legacy-transaction" }),
  }), async () => ({
    status: 200,
    body: { ok: false },
  }));
  return {
    txid: settlement.transaction,
    ...versionEvidenceForTxid(fundingVersionByTxid, settlement.transaction),
    outputIndex: settlementExtra.paymentOutputIndex,
    amount: settlement.amount,
    finality: settlementExtra.finality,
    payloadEvidence: {
      type: "transactionId-output-index",
      transactionId: payment.paymentPayload.payload.transactionId,
      paymentOutputIndex: payment.paymentPayload.payload.paymentOutputIndex,
    },
    legacyTransactionPayloadRejected: {
      rejected: legacyTransactionPayloadRejected.status === 402,
      status: legacyTransactionPayloadRejected.status,
      error: legacyTransactionPayloadRejected.body?.error,
    },
    replay: { status: replay.status, error: replay.body.error },
  };
}

async function runBatch(input) {
  const { client, server, serverStore, rpc, sdk, networkId, addressCodec, serverPrivateKeyHex, fundingAddress, fundingVersionByTxid, timeoutDaa } = input;
  const firstResource = { url: "https://live.kaspa-x402.local/batch/first", description: "Live batch first request" };
  const firstHash = hash({ flow: "batch", request: 1 });
  const first = await client.createPayment(paymentRequiredFor(server, { resource: firstResource, amount: BATCH_REQUEST_AMOUNT, scheme: "batch-settlement" }), {
    url: firstResource.url,
    requestHash: firstHash,
    paymentIdentifier: "live-batch-first-0001",
  });
  const firstResponse = await server.handlePaidRequest(requestWithPayment(first.paymentPayload, { url: firstResource.url, resource: firstResource, scheme: "batch-settlement", amount: BATCH_REQUEST_AMOUNT, requestHash: firstHash }), async () => ({
    status: 200,
    body: { ok: true },
  }));
  if (firstResponse.status !== 200) throw new Error(`batch deposit-voucher failed with status ${firstResponse.status}`);
  const firstSettlement = decodeResponse(firstResponse);
  const firstSettlementExtra = requireSettlementExtension(firstSettlement);
  await client.applySettlement(first, firstSettlement);

  const secondResource = { ...firstResource, description: "Live batch second request" };
  const secondHash = hash({ flow: "batch", request: 2 });
  const second = await client.createPayment(paymentRequiredFor(server, { resource: secondResource, amount: BATCH_REQUEST_AMOUNT, scheme: "batch-settlement" }), {
    url: secondResource.url,
    requestHash: secondHash,
    paymentIdentifier: "live-batch-second-0002",
  });
  if (second.openedChannel) throw new Error("batch voucher-only request opened a second channel");
  const secondResponse = await server.handlePaidRequest(requestWithPayment(second.paymentPayload, { url: secondResource.url, resource: secondResource, scheme: "batch-settlement", amount: BATCH_REQUEST_AMOUNT, requestHash: secondHash }), async () => ({
    status: 200,
    body: { ok: true },
  }));
  if (secondResponse.status !== 200) {
    throw new Error(`batch voucher-only failed with status ${secondResponse.status}: ${JSON.stringify({ body: secondResponse.body, headers: secondResponse.headers })}`);
  }
  const secondSettlement = decodeResponse(secondResponse);
  const secondSettlementExtra = requireSettlementExtension(secondSettlement);
  await client.applySettlement(second, secondSettlement);

  const [claimable] = await server.listClaimableChannels();
  if (!claimable) throw new Error("no claimable batch channel found");
  const oldVoucher = { amount: claimable.signedMaxClaimable, signature: claimable.voucherSignature };
  const oldOutpoint = claimable.activeOutpoint;
  const oldScriptPublicKey = claimable.activeScriptPublicKey;
  const claim = await server.executeClaim(claimable.channelId);
  if (!claim.accepted) throw new Error("batch claim was not accepted");

  const claimedChannel = await serverStore.loadChannel(claimable.channelId);
  if (!claimedChannel) throw new Error("claimed channel missing from store");
  const replay = await attemptBatchReplay({
    channel: {
      ...claimedChannel,
      activeOutpoint: claim.channel.activeOutpoint,
      activeScriptPublicKey: claim.channel.activeScriptPublicKey,
      fundingAmount: claim.channel.fundingAmount,
      signedMaxClaimable: oldVoucher.amount,
      voucherSignature: oldVoucher.signature,
    },
    oldOutpoint,
    oldScriptPublicKey,
    oldVoucher,
    claimAmount: oldVoucher.amount,
    rpc,
    sdk,
    networkId,
    addressCodec,
    serverPrivateKeyHex,
  });
  if (!replay.rejected) throw new Error("batch replay was accepted");

  await waitForDaa(rpc, timeoutDaa + 10n);
  const refund = await buildAndSubmitRefund({
    channel: claim.channel,
    clientPrivateKeyHex: first.channel.clientPrivateKey,
    refundAddress: fundingAddress,
    rpc,
    sdk,
    networkId,
    addressCodec,
  });

  return {
    deposit: {
      txid: first.channel.activeOutpoint.txid,
      ...versionEvidenceForTxid(fundingVersionByTxid, first.channel.activeOutpoint.txid),
      outpoint: first.channel.activeOutpoint,
      escrowAddress: first.channel.escrowAddress,
      fundingAmountSompi: first.channel.fundingAmount,
      channelId: first.channel.id,
      settlementCommitment: firstSettlementExtra.commitmentId,
      finality: "accepted",
      chargedAmount: firstSettlementExtra.chargedAmount,
      settlementAmount: firstSettlement.amount,
      extensionChargedAmount: firstSettlementExtra.chargedAmount,
      chargedCumulativeBefore: "0",
      chargedCumulativeAmount: firstSettlementExtra.channelState.chargedCumulativeAmount,
    },
    voucherOnly: {
      openedChannel: second.openedChannel,
      channelId: second.channel.id,
      activeOutpoint: second.channel.activeOutpoint,
      settlementCommitment: secondSettlementExtra.commitmentId,
      chargedAmount: secondSettlementExtra.chargedAmount,
      settlementAmount: secondSettlement.amount,
      extensionChargedAmount: secondSettlementExtra.chargedAmount,
      chargedCumulativeBefore: firstSettlementExtra.channelState.chargedCumulativeAmount,
      chargedCumulativeAmount: secondSettlementExtra.channelState.chargedCumulativeAmount,
      signedMaxClaimable: secondSettlementExtra.channelState.signedMaxClaimable,
    },
    claim: {
      txid: claim.transactionId,
      txVersion: 1,
      txVersionSource: ADAPTER_SUBMITTED_TX_VERSION_SOURCE,
      finality: claim.finality,
      originalOutpoint: oldOutpoint,
      continuationOutpoint: claim.channel.activeOutpoint,
      inputAmountSompi: claimable.fundingAmount,
      claimedCumulativeAmount: claimable.claimedCumulativeAmount,
      activeChargedAmountSompi: oldVoucher.amount,
      claimAmountSompi: oldVoucher.amount,
      serverOutputAmountSompi: String(BigInt(oldVoucher.amount) - DEFAULT_FEE_SOMPI),
      feeSompi: DEFAULT_FEE_SOMPI.toString(),
      continuationFundingAmountSompi: claim.channel.fundingAmount,
    },
    replay: {
      oldOutpoint,
      oldScriptPublicKey,
      attemptedInputOutpoint: replay.attemptedInputOutpoint,
      attemptedTxVersion: replay.attemptedTxVersion,
      attemptedTxVersionSource: replay.attemptedTxVersionSource,
      serverOutputAmountSompi: replay.serverOutputAmountSompi,
      continuationOutputAmountSompi: replay.continuationOutputAmountSompi,
      rejected: replay.rejected,
      finality: "rejected",
      reason: replay.reason,
    },
    refund,
  };
}

function makeFundingProvider(input) {
  const { rpc, sdk, addressCodec, chain, networkId, network, fundingPrivateKey, fundingPrivateKeyHex, fundingAddress, fundingPublicKey, knownUtxos, fundingVersionByTxid } = input;
  return {
    networkId: network,
    sourceKind: "hot-wallet",
    async getPublicIdentity() {
      return { address: fundingAddress, publicKey: fundingPublicKey };
    },
    async fundEscrowDeposit(request) {
      const sent = await sendFromFunding({
        rpc,
        sdk,
        networkId,
        fundingPrivateKey,
        fundingAddress,
        outputs: [{ address: request.escrowAddress, amount: BigInt(request.amount) }],
      });
      rememberFundingVersion(fundingVersionByTxid, sent);
      const utxo = await waitForAddressOutpoint({
        rpc,
        address: request.escrowAddress,
        txid: sent.txid,
        amount: BigInt(request.amount),
        scriptPublicKey: request.escrowScriptPublicKey,
      });
      rememberUtxo(knownUtxos, utxo);
      return {
        outpoint: utxo.outpoint,
        txid: utxo.outpoint.txid,
        index: utxo.outpoint.index,
        amount: utxo.amount,
        fundingSource: "hot-wallet",
        transaction: sent.txid,
      };
    },
    async payExact(request) {
      const sent = await sendFromFunding({
        rpc,
        sdk,
        networkId,
        fundingPrivateKey,
        fundingAddress,
        outputs: [{ address: request.payTo, amount: BigInt(request.amount) }],
      });
      rememberFundingVersion(fundingVersionByTxid, sent);
      const utxo = await waitForAddressOutpoint({
        rpc,
        address: request.payTo,
        txid: sent.txid,
        amount: BigInt(request.amount),
        scriptPublicKey: addressCodec.scriptPublicKeyForAddress(request.payTo, network),
      });
      return {
        transactionId: sent.txid,
        paymentOutputIndex: utxo.outpoint.index,
        payerAddress: fundingAddress,
        finality: "accepted",
        fundingSource: "hot-wallet",
      };
    },
    async getUtxos(addresses) {
      const utxos = [];
      for (const address of addresses) {
        const entries = await getAddressUtxos(rpc, address);
        for (const utxo of entries) {
          rememberUtxo(knownUtxos, utxo);
          utxos.push(utxo);
        }
      }
      return utxos;
    },
    async getVirtualDaaScore() {
      const info = await rpc.getServerInfo();
      return String(info.virtualDaaScore);
    },
    async sendTransaction(transaction) {
      return chain.sendTransaction(transaction);
    },
    async estimateFees() {
      return { feeSompi: DEFAULT_FEE_SOMPI.toString() };
    },
  };
}

function makeChainProvider({ rpc, knownUtxos, pendingBroadcasts, dataDir }) {
  return {
    async getUtxo(outpoint) {
      return knownUtxos.get(outpointKey(outpoint)) ?? null;
    },
    async getVirtualDaaScore() {
      const info = await rpc.getServerInfo();
      return String(info.virtualDaaScore);
    },
    async estimateClaimFee() {
      return DEFAULT_FEE_SOMPI.toString();
    },
    async sendTransaction(transaction) {
      const record = pendingBroadcasts.get(transaction);
      if (record?.submitted) {
        return { transactionId: record.txid, finality: "accepted" };
      }
      throw new Error("unknown live transaction token");
    },
  };
}

function makeSigner({ schnorr, fundingPrivateKeyHex, fundingPublicKey, dataDir }) {
  return {
    async generateChannelKey() {
      const privateKey = bytesToHex(schnorr.utils.randomPrivateKey());
      const publicKey = bytesToHex(schnorr.getPublicKey(hexToBytes(privateKey, { expectedLength: 32 })));
      const file = path.join(dataDir, `client-channel-key-${Date.now()}-${publicKey.slice(0, 12)}.json`);
      fs.writeFileSync(file, `${JSON.stringify({ createdAt: new Date().toISOString(), publicKey, privateKey }, null, 2)}\n`, { mode: 0o600 });
      return { privateKey, publicKey };
    },
    async randomSalt() {
      return bytesToHex(crypto.randomBytes(32));
    },
    async randomNonce() {
      return bytesToHex(crypto.randomBytes(32));
    },
    async signVoucher({ digest, channel }) {
      if (!channel.clientPrivateKey) throw new Error("channel private key is required for voucher signing");
      return bytesToHex(schnorr.sign(hexToBytes(digest, { expectedLength: 32 }), hexToBytes(channel.clientPrivateKey, { expectedLength: 32 })));
    },
    async signRefund() {
      throw new Error(`direct refund signing is handled by the live adapter for ${fundingPublicKey}`);
    },
  };
}

function makeAddressCodec(sdk, networkId) {
  return {
    scriptPublicKeyForAddress(address) {
      return serializeSdkScriptPublicKey(sdk.payToAddressScript(address));
    },
    encodeScriptAddress(input) {
      const spk = new sdk.ScriptPublicKey(input.scriptPublicKey.version, input.scriptPublicKey.script);
      const address = sdk.addressFromScriptPublicKey(spk, networkId);
      if (!address) throw new Error("could not encode script address");
      return address.toString();
    },
  };
}

async function buildAndSubmitClaim(input) {
  const { channel, claimAmount, rpc, sdk, networkId, serverPrivateKeyHex, addressCodec, pendingBroadcasts, knownUtxos } = input;
  const claim = BigInt(claimAmount);
  const inputAmount = BigInt(channel.fundingAmount);
  const fee = DEFAULT_FEE_SOMPI;
  if (claim <= fee) throw new Error("claim amount does not cover fee");
  const params = escrowParams(channel, addressCodec);
  const redeem = buildEscrowRedeemScript(params);
  const escrowSpk = sdk.payToScriptHashScript(redeem);
  const serverSpk = sdk.payToAddressScript(channel.channelConfig.payTo);
  const outputs = [
    { value: claim - fee, scriptPublicKey: serverSpk },
    { value: inputAmount - claim, scriptPublicKey: escrowSpk },
  ];
  const base = p2shComputeBudgetInputBase(channel.activeOutpoint, inputAmount, escrowSpk, 0n, CLAIM_COMPUTE_BUDGET);
  const txShape = { version: 1, outputs, lockTime: 0n, subnetworkId: NATIVE_SUBNETWORK_ID, gas: 0n, payload: "" };
  const unsigned = new sdk.Transaction({ ...txShape, inputs: [{ ...base, signatureScript: "" }] });
  const serverSignature = hexToBytes(sdk.createInputSignature(unsigned, 0, new sdk.PrivateKey(serverPrivateKeyHex), sdk.SighashType.All)).slice(1);
  const signatureScript = sdk.payToScriptHashSignatureScript(
    redeem,
    buildClaimArgs({
      serverSignature,
      voucherSignature: channel.voucherSignature,
      amount: channel.signedMaxClaimable,
    }),
  );
  const transaction = { ...txShape, inputs: [{ ...base, signatureScript }] };
  const { transactionId } = await rpc.submitTransaction({ transaction, allowOrphan: false });
  const txid = String(transactionId);
  const continuation = await waitForAddressOutpoint({
    rpc,
    address: channel.escrowAddress,
    txid,
    index: 1,
    amount: inputAmount - claim,
    scriptPublicKey: channel.activeScriptPublicKey,
  });
  rememberUtxo(knownUtxos, continuation);
  pendingBroadcasts.set(txid, { kind: "claim", submitted: true, txid });
  return {
    transaction: txid,
    txVersion: 1,
    claimAmount,
    continuationOutpoint: continuation.outpoint,
    continuationScriptPublicKey: continuation.scriptPublicKey,
    continuationFundingAmount: continuation.amount,
  };
}

async function attemptBatchReplay(input) {
  const { channel, oldVoucher, rpc, sdk, serverPrivateKeyHex } = input;
  const replayClaimAmount = BigInt(channel.fundingAmount) / 2n;
  const evidence = {
    attemptedInputOutpoint: channel.activeOutpoint,
    attemptedTxVersion: 1,
    attemptedTxVersionSource: ADAPTER_SUBMITTED_TX_VERSION_SOURCE,
    serverOutputAmountSompi: replayClaimAmount > DEFAULT_FEE_SOMPI ? String(replayClaimAmount - DEFAULT_FEE_SOMPI) : "0",
    continuationOutputAmountSompi: String(BigInt(channel.fundingAmount) - replayClaimAmount),
  };
  try {
    if (replayClaimAmount <= DEFAULT_FEE_SOMPI) {
      throw new Error("continuation amount is too small for replay proof");
    }
    await rawClaim({
      channel,
      voucher: oldVoucher,
      claimAmount: replayClaimAmount,
      rpc,
      sdk,
      serverPrivateKeyHex,
      destination: channel.channelConfig.payTo,
    });
    return { ...evidence, rejected: false, reason: "replay transaction was accepted" };
  } catch (error) {
    return { ...evidence, rejected: true, reason: String(error?.message ?? error).slice(0, 180) };
  }
}

async function rawClaim({ channel, voucher, claimAmount, rpc, sdk, serverPrivateKeyHex, destination }) {
  const inputAmount = BigInt(channel.fundingAmount);
  const params = escrowParams(channel, {
    scriptPublicKeyForAddress(address, network) {
      return serializeSdkScriptPublicKey(sdk.payToAddressScript(address));
    },
  });
  const redeem = buildEscrowRedeemScript(params);
  const escrowSpk = sdk.payToScriptHashScript(redeem);
  const destSpk = sdk.payToAddressScript(destination);
  const outputs = [
    { value: claimAmount - DEFAULT_FEE_SOMPI, scriptPublicKey: destSpk },
    { value: inputAmount - claimAmount, scriptPublicKey: escrowSpk },
  ];
  const base = p2shComputeBudgetInputBase(channel.activeOutpoint, inputAmount, escrowSpk, 0n, CLAIM_COMPUTE_BUDGET);
  const txShape = { version: 1, outputs, lockTime: 0n, subnetworkId: NATIVE_SUBNETWORK_ID, gas: 0n, payload: "" };
  const unsigned = new sdk.Transaction({ ...txShape, inputs: [{ ...base, signatureScript: "" }] });
  const serverSignature = hexToBytes(sdk.createInputSignature(unsigned, 0, new sdk.PrivateKey(serverPrivateKeyHex), sdk.SighashType.All)).slice(1);
  const signatureScript = sdk.payToScriptHashSignatureScript(redeem, buildClaimArgs({ serverSignature, voucherSignature: voucher.signature, amount: voucher.amount }));
  const transaction = { ...txShape, inputs: [{ ...base, signatureScript }] };
  return rpc.submitTransaction({ transaction, allowOrphan: false });
}

async function buildAndSubmitRefund(input) {
  const { channel, clientPrivateKeyHex, refundAddress, rpc, sdk, addressCodec } = input;
  const inputAmount = BigInt(channel.fundingAmount);
  const params = escrowParams(channel, addressCodec);
  const redeem = buildEscrowRedeemScript(params);
  const escrowSpk = sdk.payToScriptHashScript(redeem);
  const refundSpk = sdk.payToAddressScript(refundAddress);
  const outputs = [{ value: inputAmount - DEFAULT_FEE_SOMPI, scriptPublicKey: refundSpk }];
  const base = p2shComputeBudgetInputBase(channel.activeOutpoint, inputAmount, escrowSpk, 0n, REFUND_COMPUTE_BUDGET);
  const txShape = { version: 1, outputs, lockTime: BigInt(channel.channelConfig.refundTimeoutDaa), subnetworkId: NATIVE_SUBNETWORK_ID, gas: 0n, payload: "" };
  const unsigned = new sdk.Transaction({ ...txShape, inputs: [{ ...base, signatureScript: "" }] });
  const clientSignature = hexToBytes(sdk.createInputSignature(unsigned, 0, new sdk.PrivateKey(clientPrivateKeyHex), sdk.SighashType.All)).slice(1);
  const signatureScript = sdk.payToScriptHashSignatureScript(redeem, buildRefundArgs({ clientSignature }));
  const transaction = { ...txShape, inputs: [{ ...base, signatureScript }] };
  const { transactionId } = await rpc.submitTransaction({ transaction, allowOrphan: false });
  const refundUtxo = await waitForAddressOutpoint({
    rpc,
    address: refundAddress,
    txid: String(transactionId),
    index: 0,
    amount: inputAmount - DEFAULT_FEE_SOMPI,
    scriptPublicKey: serializeSdkScriptPublicKey(refundSpk),
  });
  return {
    txid: String(transactionId),
    txVersion: 1,
    txVersionSource: ADAPTER_SUBMITTED_TX_VERSION_SOURCE,
    finality: "accepted",
    refundAddress,
    inputAmountSompi: inputAmount.toString(),
    refundAmountSompi: refundUtxo.amount,
    feeSompi: DEFAULT_FEE_SOMPI.toString(),
    outputIndex: refundUtxo.outpoint.index,
  };
}

async function sendFromFunding({ rpc, sdk, networkId, fundingPrivateKey, fundingAddress, outputs, entries }) {
  const feeEstimate = await rpc.getFeeEstimate();
  const feeRate = feeEstimate.estimate?.normalBuckets?.[0]?.feerate ?? feeEstimate.estimate?.priorityBucket?.feerate ?? 1;
  const sourceEntries = entries ?? (await rpc.getUtxosByAddresses([fundingAddress])).entries;
  const { transactions } = await sdk.createTransactions({
    entries: sourceEntries,
    outputs,
    changeAddress: fundingAddress,
    feeRate,
    priorityFee: 0n,
    networkId,
  });
  let txid = "";
  let txVersion = undefined;
  for (const pending of transactions) {
    txVersion = generatedTransactionVersion(pending);
    await pending.sign([fundingPrivateKey]);
    txid = await pending.submit(rpc);
  }
  if (!txid) throw new Error("transaction generator produced no transaction");
  return { txid, txVersion, txVersionSource: SDK_GENERATED_TX_VERSION_SOURCE };
}

function generatedTransactionVersion(pending) {
  const version = pending.transaction?.version;
  if (!Number.isInteger(version)) {
    throw new Error("generated funding transaction did not expose a numeric version");
  }
  return version;
}

function rememberFundingVersion(fundingVersionByTxid, sent) {
  fundingVersionByTxid.set(sent.txid.toLowerCase(), {
    txVersion: sent.txVersion,
    txVersionSource: sent.txVersionSource,
  });
}

function versionEvidenceForTxid(fundingVersionByTxid, txid) {
  const evidence = fundingVersionByTxid.get(String(txid).toLowerCase());
  if (!evidence) {
    throw new Error(`missing generated transaction version evidence for ${txid}`);
  }
  return evidence;
}

function authorizationVersionEvidence(fundingVersionByTxid, txid) {
  const evidence = versionEvidenceForTxid(fundingVersionByTxid, txid);
  return {
    authorizationTxVersion: evidence.txVersion,
    authorizationTxVersionSource: evidence.txVersionSource,
  };
}

async function waitForAddressOutpoint(input) {
  const started = Date.now();
  let last = "not checked";
  while (Date.now() - started < DEFAULT_CONFIRMATION_TIMEOUT_MS) {
    const entries = await getAddressUtxos(input.rpc, input.address);
    const match = entries.find((utxo) => {
      if (input.txid && utxo.outpoint.txid.toLowerCase() !== input.txid.toLowerCase()) return false;
      if (input.index !== undefined && utxo.outpoint.index !== input.index) return false;
      if (!input.allowAnyAmount && input.amount !== undefined && BigInt(utxo.amount) !== input.amount) return false;
      if (input.scriptPublicKey && utxo.scriptPublicKey.toLowerCase() !== input.scriptPublicKey.toLowerCase()) return false;
      return true;
    });
    if (match) return match;
    last = `${entries.length} candidate UTXO(s)`;
    await sleep(1_000);
  }
  throw new Error(`timed out waiting for ${input.address} outpoint ${input.txid ?? "*"}:${input.index ?? "*"} (${last})`);
}

async function getAddressUtxos(rpc, address) {
  const { entries } = await rpc.getUtxosByAddresses([address]);
  return entries.map((entry) => {
    const raw = entry.entry ?? entry;
    const outpoint = raw.outpoint ?? entry.outpoint;
    return {
      outpoint: {
        txid: String(outpoint.transactionId),
        index: Number(outpoint.index),
      },
      amount: String(raw.amount ?? entry.amount),
      scriptPublicKey: serializeSdkScriptPublicKey(raw.scriptPublicKey ?? entry.scriptPublicKey),
      finality: "accepted",
      address,
      raw: entry,
    };
  });
}

async function balanceSompi(rpc, address) {
  const { entries } = await rpc.getBalancesByAddresses([address]);
  return entries.reduce((sum, entry) => sum + BigInt(entry.balance ?? 0), 0n);
}

async function waitForDaa(rpc, target) {
  while (true) {
    const info = await rpc.getServerInfo();
    if (BigInt(info.virtualDaaScore) >= target) return;
    await sleep(1_000);
  }
}

function p2shInputBase(outpoint, amount, scriptPublicKey, sequence, sigOpCount) {
  return {
    previousOutpoint: { transactionId: outpoint.txid, index: outpoint.index },
    sequence,
    sigOpCount,
    utxo: {
      outpoint: { transactionId: outpoint.txid, index: outpoint.index },
      amount,
      scriptPublicKey,
      blockDaaScore: 0n,
      isCoinbase: false,
    },
  };
}

function p2shComputeBudgetInputBase(outpoint, amount, scriptPublicKey, sequence, computeBudget) {
  return {
    previousOutpoint: { transactionId: outpoint.txid, index: outpoint.index },
    sequence,
    sigOpCount: 0,
    computeBudget,
    utxo: {
      outpoint: { transactionId: outpoint.txid, index: outpoint.index },
      amount,
      scriptPublicKey,
      blockDaaScore: 0n,
      isCoinbase: false,
    },
  };
}

function escrowParams(channel, addressCodec) {
  const payoutScriptPublicKey = addressCodec.scriptPublicKeyForAddress(channel.channelConfig.payTo, channel.channelConfig.network);
  const refundScriptPublicKey = addressCodec.scriptPublicKeyForAddress(channel.channelConfig.refundAddress, channel.channelConfig.network);
  return {
    clientPublicKey: channel.channelConfig.clientPublicKey,
    serverPublicKey: channel.channelConfig.serverPublicKey,
    network: channel.channelConfig.network,
    payoutScriptPublicKeyHash: sha256Hex(hexToBytes(payoutScriptPublicKey)),
    refundScriptPublicKeyHash: sha256Hex(hexToBytes(refundScriptPublicKey)),
    timeoutDaa: channel.channelConfig.refundTimeoutDaa,
  };
}

function paymentRequiredFor(server, input) {
  return encodePaymentRequiredHeader(server.buildPaymentRequired(input));
}

function requestWithPayment(paymentPayload, input) {
  let paymentHeader;
  try {
    paymentHeader = encodePaymentSignatureHeader(paymentPayload);
  } catch (error) {
    throw new Error(`could not encode payment payload for ${input.url}: ${error?.message ?? String(error)} ${JSON.stringify(error?.details ?? error?.cause ?? null)}`);
  }
  return requestWithPaymentHeader(paymentHeader, input);
}

function requestWithPaymentHeader(paymentHeader, input) {
  return {
    method: "GET",
    url: input.url,
    body: null,
    headers: {
      [PAYMENT_SIGNATURE_HEADER]: paymentHeader,
    },
    resource: input.resource,
    paymentAmount: input.amount,
    paymentScheme: input.scheme,
    requestHash: input.requestHash,
  };
}

function unsafePaymentHeader(value) {
  return Buffer.from(stableStringify(value), "utf8").toString("base64");
}

function decodeResponse(response) {
  const header = response.headers?.["PAYMENT-RESPONSE"];
  if (!header) throw new Error("missing PAYMENT-RESPONSE header");
  return decodePaymentResponseHeader(header);
}

function requireSettlementExtension(settlement) {
  const extra = readKaspaSettlementExtension(settlement);
  if (!extra) throw new Error("settlement response is missing kaspa extension metadata");
  return extra;
}

function loadFundingPrivateKey(specifier) {
  if (!specifier) throw new Error("KASPA_X402_FUNDING_WALLET is required");
  if (specifier.startsWith("wallet-key:")) {
    return fs.readFileSync(path.resolve(specifier.slice("wallet-key:".length)), "utf8").trim();
  }
  if (/^[0-9a-fA-F]{64}$/.test(specifier)) return specifier.toLowerCase();
  throw new Error("KASPA_X402_FUNDING_WALLET must be wallet-key:<path> or a 32-byte private key hex");
}

function loadOrCreateChannelKey(file, schnorr) {
  if (fs.existsSync(file)) {
    const privateKey = fs.readFileSync(file, "utf8").trim();
    return { privateKey, publicKey: bytesToHex(schnorr.getPublicKey(hexToBytes(privateKey, { expectedLength: 32 }))) };
  }
  const privateKey = bytesToHex(schnorr.utils.randomPrivateKey());
  fs.writeFileSync(file, `${privateKey}\n`, { mode: 0o600 });
  return { privateKey, publicKey: bytesToHex(schnorr.getPublicKey(hexToBytes(privateKey, { expectedLength: 32 }))) };
}

function loadOrCreateWalletKey(file, sdk) {
  if (fs.existsSync(file)) return new sdk.PrivateKey(fs.readFileSync(file, "utf8").trim());
  const keypair = sdk.Keypair.random();
  fs.writeFileSync(file, `${keypair.privateKey}\n`, { mode: 0o600 });
  return new sdk.PrivateKey(keypair.privateKey);
}

function serializeSdkScriptPublicKey(scriptPublicKey) {
  const script = hexToBytes(String(scriptPublicKey.script));
  const version = Number(scriptPublicKey.version ?? 0);
  return bytesToHex(Uint8Array.from([version & 0xff, (version >>> 8) & 0xff, ...script]));
}

function rememberUtxo(knownUtxos, utxo) {
  knownUtxos.set(outpointKey(utxo.outpoint), utxo);
}

function outpointKey(outpoint) {
  return `${outpoint.txid.toLowerCase()}:${outpoint.index}`;
}

function hash(value) {
  return sha256Hex(stableStringify(value));
}

function kaspaNetworkId(network) {
  if (network === "kaspa:testnet-10") return "testnet-10";
  throw new Error("live adapter only supports kaspa:testnet-10");
}

function positiveBigInt(value, label) {
  const parsed = BigInt(value);
  if (parsed <= 0n) throw new Error(`${label} must be positive`);
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
