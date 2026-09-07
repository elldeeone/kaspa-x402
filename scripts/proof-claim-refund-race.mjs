import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { bytesToHex, hexToBytes, channelId, voucherDigest } from "@kaspa-x402/core";
import { escrowScriptPublicKey, serializedScriptPublicKey } from "@kaspa-x402/covenant";
import { readPrivateKeyFile, writePrivateKeyFile, assertPrivateKeyDirectory } from "./private-key-files.mjs";
import { buildPreparedGenesis, buildPreparedClaim, buildPreparedRefund, submitBatchArtifact, waitForAddressOutpoint, waitForDaa, getAddressUtxos, makeAddressCodec, escrowParamsFromChannelConfig } from "./live-adapter-reference.mjs";

const { values } = parseArgs({ options: { live: { type: "boolean" }, "refund-first": { type: "boolean" }, wallet: { type: "string" }, sdk: { type: "string" }, "data-dir": { type: "string" }, rpc: { type: "string" } } });
if (!values.live || !values.wallet || !values.sdk || !values["data-dir"] || !values.rpc) throw new Error("requires --live --wallet FILE --sdk DIRECTORY --data-dir DIRECTORY --rpc URL (TN10 only)");
const dataDir = path.resolve(values["data-dir"]);
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
assertPrivateKeyDirectory(dataDir);
const sdkRequire = createRequire(path.join(path.resolve(values.sdk), "kaspa.js"));
globalThis.WebSocket = sdkRequire("websocket").w3cwebsocket;
const sdk = sdkRequire(path.resolve(values.sdk));
const { schnorr } = sdkRequire("@noble/curves/secp256k1.js");
const networkId = "testnet-10";
const network = "kaspa:testnet-10";
const fundingPrivateKeyHex = readPrivateKeyFile(path.resolve(values.wallet));
const fundingAddress = new sdk.PrivateKey(fundingPrivateKeyHex).toAddress(networkId).toString();
const rpc = new sdk.RpcClient({ url: values.rpc, networkId });
const report = { network, evidence: "live node consensus race; no durable SDK client/server reconciliation claim", generatedAt: new Date().toISOString() };
const save = () => fs.writeFileSync(path.join(dataDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
const balance = async () => (await getAddressUtxos(rpc, fundingAddress)).reduce((sum, u) => sum + BigInt(u.amount), 0n);
const sign = (digest, key) => bytesToHex(schnorr.sign(hexToBytes(digest), hexToBytes(key)));
try {
  await rpc.connect();
  const info = await rpc.getServerInfo();
  assert.equal(info.networkId, networkId);
  assert.equal(info.isSynced, true);
  assert.equal(info.hasUtxoIndex, true);
  report.balanceBeforeSompi = String(await balance());
  assert(BigInt(report.balanceBeforeSompi) >= 60_000_000n, "isolated wallet needs at least 0.6 TN KAS");
  console.log(JSON.stringify({ stage: "preflight", network, balanceSompi: report.balanceBeforeSompi }));
  const clientKey = bytesToHex(schnorr.utils.randomSecretKey());
  const serverKey = bytesToHex(schnorr.utils.randomSecretKey());
  writePrivateKeyFile(path.join(dataDir, "channel-keys.json"), JSON.stringify({ clientKey, serverKey }));
  const config = {
    network, asset: "KAS", templateId: "kaspa-x402-escrow-v3",
    clientPublicKey: bytesToHex(schnorr.getPublicKey(hexToBytes(clientKey))),
    serverPublicKey: bytesToHex(schnorr.getPublicKey(hexToBytes(serverKey))),
    payTo: fundingAddress, refundAddress: fundingAddress,
    refundTimeoutDaa: String(BigInt(info.virtualDaaScore) + 200n), salt: crypto.randomBytes(32).toString("hex"),
  };
  const addressCodec = makeAddressCodec(sdk, networkId);
  const params = escrowParamsFromChannelConfig(config, addressCodec, "0");
  const escrowSpk = escrowScriptPublicKey(params);
  const escrowAddress = addressCodec.encodeScriptAddress({ scriptPublicKey: escrowSpk });
  const artifacts = new Map();
  const common = { rpc, sdk, networkId, network, schnorr, addressCodec, dataDir, fundingPrivateKeyHex, fundingAddress, spentOutpoints: new Set(), knownUtxos: new Map(), batchArtifactsByTxid: artifacts, batchGenesisByOutpoint: new Map(), pendingBroadcasts: new Map() };
  const genesis = await buildPreparedGenesis({ ...common, request: { amount: "50000000", channelId: channelId(config), channelConfig: config, escrowAddress, escrowScriptPublicKey: serializedScriptPublicKey(escrowSpk) } });
  assert.equal(await submitBatchArtifact(rpc, sdk, genesis.artifact), genesis.artifact.transactionId);
  await waitForAddressOutpoint({ rpc, address: escrowAddress, txid: genesis.artifact.transactionId, index: 0, amount: 50_000_000n, covenantId: genesis.successor.covenantId });
  const channel = { id: channelId(config), channelId: channelId(config), channelConfig: config, config, clientPrivateKey: clientKey, covenantId: genesis.successor.covenantId, activeOutpoint: genesis.successor.outpoint, activeScriptPublicKey: genesis.successor.scriptPublicKey, fundingAmount: "50000000", chargedCumulativeAmount: "10000000", claimedCumulativeAmount: "0", signedMaxClaimable: "10000000" };
  channel.voucherSignature = sign(voucherDigest({ network, covenantId: channel.covenantId, amount: channel.signedMaxClaimable }), clientKey);
  fs.writeFileSync(path.join(dataDir, "channel.json"), `${JSON.stringify({ ...channel, clientPrivateKey: undefined }, null, 2)}\n`, { mode: 0o600 });
  report.genesis = { transactionId: genesis.artifact.transactionId, covenantId: channel.covenantId, amountSompi: channel.fundingAmount, timeoutDaa: config.refundTimeoutDaa, finality: "accepted" };
  save();
  console.log(JSON.stringify({ stage: "genesis-accepted", transactionId: genesis.artifact.transactionId }));
  await waitForDaa(rpc, BigInt(config.refundTimeoutDaa) + 10n);
  const claim = await buildPreparedClaim({ ...common, channel, claimAmount: "10000000", serverPrivateKeyHex: serverKey });
  const refund = await buildPreparedRefund({ ...common, channel, refundAmount: channel.fundingAmount, refundAddress: fundingAddress, signDigest: async (digest) => `${sign(digest, clientKey)}01` });
  const claimArtifact = artifacts.get(claim.transactionId);
  const refundArtifact = artifacts.get(refund.transactionId);
  assert.deepEqual(claimArtifact.transaction.inputs[0].previousOutpoint, refundArtifact.transaction.inputs[0].previousOutpoint);
  assert.equal(claimArtifact.transaction.inputs[0].previousOutpoint.txid, genesis.artifact.transactionId);
  const startedAt = Date.now();
  const submissionOrder = values["refund-first"] ? [1, 0] : [0, 1];
  const raceArtifacts = [claimArtifact, refundArtifact];
  const submitted = await Promise.allSettled(submissionOrder.map((index) => submitBatchArtifact(rpc, sdk, raceArtifacts[index])));
  const outcomes = [];
  submissionOrder.forEach((index, position) => { outcomes[index] = submitted[position]; });
  const winners = outcomes.flatMap((outcome, index) => outcome.status === "fulfilled" ? [index] : []);
  assert.equal(winners.length, 1, "race must produce exactly one successful submission");
  const winner = winners[0];
  const loser = outcomes[1 - winner];
  assert.equal(loser.reason?.definitiveNodeRejection, true, "loser requires a definitive node rejection");
  assert.equal(loser.reason?.rejectedTransactionId, winner === 0 ? refund.transactionId : claim.transactionId);
  report.race = { submissionOrder: submissionOrder.map((index) => index === 0 ? "claim" : "refund"), durationMs: Date.now() - startedAt, winner: winner === 0 ? "claim" : "refund", claimTransactionId: claim.transactionId, refundTransactionId: refund.transactionId, loserDefinitiveNodeRejection: true, loserError: loser.reason.message };
  save();
  let terminalRefund;
  if (winner === 0) {
    const successor = { ...channel, activeOutpoint: claim.continuationOutpoint, activeScriptPublicKey: claim.continuationScriptPublicKey, fundingAmount: claim.continuationFundingAmount, claimedCumulativeAmount: "10000000" };
    const successorAddress = common.pendingBroadcasts.get(claim.transaction).successorAddress;
    await waitForAddressOutpoint({ rpc, address: successorAddress, txid: claim.transactionId, index: claim.continuationOutpoint.index, amount: 40_000_000n, covenantId: channel.covenantId });
    await waitForAddressOutpoint({ rpc, address: fundingAddress, txid: claim.transactionId, index: 0, amount: 8_000_000n });
    const cleanup = await buildPreparedRefund({ ...common, channel: successor, refundAmount: successor.fundingAmount, refundAddress: fundingAddress, signDigest: async (digest) => `${sign(digest, clientKey)}01` });
    terminalRefund = artifacts.get(cleanup.transactionId);
    assert.equal(await submitBatchArtifact(rpc, sdk, terminalRefund), cleanup.transactionId);
    await waitForAddressOutpoint({ rpc, address: fundingAddress, txid: cleanup.transactionId, index: 0, amount: 38_000_000n });
    assert(!(await getAddressUtxos(rpc, successorAddress)).some((u) => u.outpoint.txid === claim.transactionId && u.outpoint.index === claim.continuationOutpoint.index));
  } else {
    terminalRefund = refundArtifact;
    await waitForAddressOutpoint({ rpc, address: fundingAddress, txid: refund.transactionId, index: 0, amount: 48_000_000n });
  }
  assert(!(await getAddressUtxos(rpc, escrowAddress)).some((u) => u.outpoint.txid === genesis.artifact.transactionId && u.outpoint.index === 0));
  const refunded = BigInt(terminalRefund.fee.refundOutputAmount);
  const paid = winner === 0 ? 8_000_000n : 0n;
  const spendFees = winner === 0 ? 4_000_000n : 2_000_000n;
  assert.equal(refunded + paid + spendFees, 50_000_000n);
  report.cleanup = { terminalRefundTransactionId: terminalRefund.transactionId, finality: "accepted", oldHeadAbsent: true, terminal: true, merchantOutputSompi: String(paid), refundSompi: String(refunded), covenantSpendFeesSompi: String(spendFees), conservedEscrowSompi: "50000000" };
  report.balanceAfterSompi = String(await balance());
  report.status = "passed";
  save();
  console.log(JSON.stringify(report));
} catch (error) {
  report.status = "failed";
  report.error = error.message;
  save();
  throw error;
} finally {
  await rpc.disconnect();
}
