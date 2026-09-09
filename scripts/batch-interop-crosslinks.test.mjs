import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { schnorr } from "@noble/curves/secp256k1.js";
import {
  applyBatchClaimAccounting,
  assertBatchVoucherReserve,
  batchCommitmentId,
  batchCommitmentPreimageHex,
  batchLaneAccounting,
  batchPaymentRequirementsHash,
  batchPaymentRequirementsPreimageHex,
  batchPresentationDigest,
  batchPresentationPreimage,
  channelId,
  channelIdPreimageHex,
  voucherDigest,
  voucherPreimageHex,
} from "@kaspa-x402/core";
import { transactionV1CovenantId } from "../packages/covenant/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vector = JSON.parse(
  fs.readFileSync(path.join(root, "vectors/batch/interop-v3.json"), "utf8"),
);

test("accepts the canonical Alpha.11 batch core cross-links", () => {
  assert.doesNotThrow(() => assertBatchCoreCrossLinks(vector));
});

test("rejects a voucher for a different covenant lineage", () => {
  const mutated = structuredClone(vector);
  mutated.voucher.input.covenantId = "67".repeat(32);
  assert.throws(() => assertBatchCoreCrossLinks(mutated), /voucher covenant id/);
});

test("rejects the KIP-20 unbound sentinel as a lane id", () => {
  const mutated = structuredClone(vector);
  mutated.lineage.covenantId = "00".repeat(32);
  assert.throws(() => assertBatchCoreCrossLinks(mutated), /unbound sentinel/);
});

test("rejects a voucher signer unrelated to the channel client", () => {
  const mutated = structuredClone(vector);
  mutated.voucher.signerPublicKey = mutated.channel.config.serverPublicKey;
  assert.throws(() => assertBatchCoreCrossLinks(mutated), /voucher signer/);
});

test("rejects a commitment unrelated to the channel", () => {
  const mutated = structuredClone(vector);
  mutated.commitment.input.channelId = "00".repeat(32);
  assert.throws(() => assertBatchCoreCrossLinks(mutated), /commitment channel id/);
});

test("rejects current-head evidence unrelated to the commitment", () => {
  const mutated = structuredClone(vector);
  mutated.lineage.currentHead.outpoint.index += 1;
  assert.throws(() => assertBatchCoreCrossLinks(mutated), /current head outpoint/);
});

test("rejects a claim that resets the lifetime voucher ceiling", () => {
  const mutated = structuredClone(vector);
  mutated.accounting.afterClaim.authorizedCumulativeAmount = "0";
  assert.throws(
    () => assertBatchCoreCrossLinks(mutated),
    /claimed cumulative amount|authorization preservation/,
  );
});

test("rejects accounting that uses a different reserve than the accepted requirement", () => {
  const mutated = structuredClone(vector);
  mutated.accounting.reserveAmount = "1000000";
  assert.throws(
    () => assertBatchCoreCrossLinks(mutated),
    /accounting reserve must match accepted claim reserve/,
  );
});

function assertBatchCoreCrossLinks(item) {
  assert.equal(item.kind, "batch-interop-v3");
  assert.equal(item.scope.transactionEvidenceIncluded, false);

  const config = item.channel.config;
  const accepted = item.paymentRequirements.value;
  const commitment = item.commitment.input;
  const covenantId = item.lineage.covenantId;

  assert.notEqual(covenantId, "00".repeat(32), "covenant id is unbound sentinel");
  assert.equal(config.templateId, "kaspa-x402-escrow-v4");
  assert.equal(accepted.extra.binding, "kaspa-escrow-v3");
  assert.equal(accepted.extra.templateId, config.templateId);
  assert.equal(accepted.network, config.network);
  assert.equal(accepted.asset, config.asset);
  assert.equal(accepted.payTo, config.payTo);
  assert.equal(accepted.extra.serverPublicKey, config.serverPublicKey);
  assert.equal(accepted.extra.refundTimeoutDaa, config.refundTimeoutDaa);

  assert.equal(channelIdPreimageHex(config), item.channel.preimage);
  assert.equal(channelId(config), item.channel.channelId);
  assert.equal(item.voucher.input.network, config.network);
  assert.equal(
    item.voucher.input.covenantId,
    covenantId,
    "voucher covenant id mismatch",
  );
  assert.equal(
    commitment.voucher.covenantId,
    covenantId,
    "commitment voucher covenant id mismatch",
  );
  assert.equal(
    item.voucher.signerPublicKey,
    config.clientPublicKey,
    "voucher signer mismatch",
  );
  assert.equal(voucherPreimageHex(item.voucher.input), item.voucher.preimage);
  assert.equal(voucherDigest(item.voucher.input), item.voucher.digest);
  assert.equal(
    schnorr.verify(
      Buffer.from(item.voucher.signature, "hex"),
      Buffer.from(item.voucher.digest, "hex"),
      Buffer.from(item.voucher.signerPublicKey, "hex"),
    ),
    true,
    "voucher signature mismatch",
  );

  assert.equal(
    batchPresentationPreimage(item.presentation.input),
    item.presentation.preimage,
  );
  assert.equal(
    batchPresentationDigest(item.presentation.input),
    item.presentation.digest,
  );
  assert.equal(item.presentation.signerPublicKey, config.clientPublicKey);
  assert.equal(
    schnorr.verify(
      Buffer.from(item.presentation.signature, "hex"),
      Buffer.from(item.presentation.digest, "hex"),
      Buffer.from(item.presentation.signerPublicKey, "hex"),
    ),
    true,
    "presentation signature mismatch",
  );

  assert.equal(
    commitment.channelId,
    item.channel.channelId,
    "commitment channel id mismatch",
  );
  assert.deepEqual(commitment.accepted, accepted);
  assert.deepEqual(
    commitment.activeOutpoint,
    item.lineage.currentHead.outpoint,
    "current head outpoint mismatch",
  );
  assert.equal(
    commitment.voucher.authorizedCumulativeAmount,
    item.voucher.input.authorizedCumulativeAmount,
  );
  assert.equal(commitment.voucher.signature, item.voucher.signature);
  assert.equal(commitment.presentationDigest, item.presentation.digest);
  assert.equal(
    item.presentation.input.acceptedRequirementsHash,
    item.paymentRequirements.sha256,
  );
  assert.equal(
    item.presentation.input.securityContextHash,
    accepted.extra.securityContextHash,
  );
  assert.equal(item.presentation.input.channelId, item.channel.channelId);
  assert.equal(item.presentation.input.covenantId, covenantId);
  assert.equal(item.presentation.input.voucherDigest, item.voucher.digest);
  assert.equal(
    item.presentation.input.requestFingerprint,
    commitment.requestFingerprint,
  );
  assert.equal(
    batchPaymentRequirementsPreimageHex(accepted),
    item.paymentRequirements.preimage,
  );
  assert.equal(
    batchPaymentRequirementsHash(accepted),
    item.paymentRequirements.sha256,
  );
  assert.equal(
    batchCommitmentPreimageHex(commitment),
    item.commitment.preimage,
  );
  assert.equal(batchCommitmentId(commitment), item.commitment.commitmentId);

  const genesis = item.lineage.genesisDerivation;
  const derivedCovenantId = transactionV1CovenantId(
    genesis.authorizingInput,
    genesis.authorizedOutputs.map(({ index, amount, scriptPublicKey }) => ({
      index,
      output: { amount, scriptPublicKey },
    })),
  );
  assert.equal(derivedCovenantId, covenantId, "genesis covenant id mismatch");

  for (const state of [
    item.accounting.beforeRequest,
    item.accounting.afterRequest,
    item.accounting.afterClaim,
  ]) {
    assert.equal(state.channelId, item.channel.channelId);
    assert.equal(state.covenantId, covenantId);
  }
  assert.deepEqual(
    item.accounting.beforeRequest.activeOutpoint,
    item.lineage.currentHead.outpoint,
  );
  assert.equal(
    item.accounting.beforeRequest.activeScriptPublicKey,
    item.lineage.currentHead.scriptPublicKey,
  );
  assert.deepEqual(
    item.accounting.afterClaim.activeOutpoint,
    item.lineage.successorHead.outpoint,
  );
  assert.equal(
    item.accounting.afterClaim.activeScriptPublicKey,
    item.lineage.successorHead.scriptPublicKey,
  );

  assert.deepEqual(
    stringifyBigints(
      batchLaneAccounting(laneAccountingState(item.accounting.beforeRequest)),
    ),
    item.accounting.derivedBeforeRequest,
  );
  assert.deepEqual(
    stringifyBigints(
      batchLaneAccounting(laneAccountingState(item.accounting.afterRequest)),
    ),
    item.accounting.derivedAfterRequest,
  );
  assert.deepEqual(
    stringifyBigints(
      batchLaneAccounting(laneAccountingState(item.accounting.afterClaim)),
    ),
    item.accounting.derivedAfterClaim,
  );
  assert.equal(
    item.accounting.reserveAmount,
    accepted.extra.claimReserveSompi,
    "accounting reserve must match accepted claim reserve",
  );
  assert.equal(
    assertBatchVoucherReserve(
      laneAccountingState(item.accounting.afterRequest),
      item.accounting.reserveAmount,
    ),
    true,
  );

  const afterClaim = applyBatchClaimAccounting(
    laneAccountingState(item.accounting.afterRequest),
    item.accounting.claimAmount,
  );
  assert.equal(afterClaim.fundingAmount, item.accounting.afterClaim.fundingAmount);
  assert.equal(
    afterClaim.chargedCumulativeAmount,
    item.accounting.afterClaim.authorizedCumulativeAmount,
  );
  assert.equal(
    afterClaim.claimedCumulativeAmount,
    item.accounting.afterClaim.claimedCumulativeAmount,
  );
  assert.equal(
    afterClaim.signedMaxClaimable,
    item.accounting.afterClaim.authorizedCumulativeAmount,
  );
}

function laneAccountingState(state) {
  return {
    fundingAmount: state.fundingAmount,
    chargedCumulativeAmount: state.authorizedCumulativeAmount,
    claimedCumulativeAmount: state.claimedCumulativeAmount,
    signedMaxClaimable: state.authorizedCumulativeAmount,
  };
}

function stringifyBigints(value) {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, item.toString()]),
  );
}
