import {
  canonicalCovenantTransitions,
  parseSompiString,
  stableStringify,
  type CovenantLineageState,
} from "@kaspa-x402/core";
import { ESCROW_V4_LAUNCH_IDENTITY } from "@kaspa-x402/covenant";
import type { ServerChannelRecord } from "./types.js";

export function assertServerChannelLineageConsistency(
  channel: ServerChannelRecord,
): void {
  // This also validates the manifest, journal sequence, transitions, and
  // atomically derived currentHead.
  canonicalCovenantTransitions(channel.lineage);
  const manifest = channel.lineage.manifest;
  if (
    manifest.network !== channel.channelConfig.network ||
    stableStringify(manifest.compiler) !==
      stableStringify(ESCROW_V4_LAUNCH_IDENTITY.compiler) ||
    stableStringify(manifest.source) !==
      stableStringify(ESCROW_V4_LAUNCH_IDENTITY.source) ||
    stableStringify(manifest.bytecode) !==
      stableStringify(ESCROW_V4_LAUNCH_IDENTITY.bytecode) ||
    stableStringify(manifest.constructorSlots) !==
      stableStringify(ESCROW_V4_LAUNCH_IDENTITY.constructorSlots) ||
    stableStringify(manifest.abi) !==
      stableStringify(ESCROW_V4_LAUNCH_IDENTITY.abi) ||
    stableStringify(manifest.selectors) !==
      stableStringify(ESCROW_V4_LAUNCH_IDENTITY.selectors) ||
    manifest.identitySha256.toLowerCase() !==
      ESCROW_V4_LAUNCH_IDENTITY.identitySha256.toLowerCase() ||
    manifest.genesis.covenantId.toLowerCase() !==
      channel.covenantId.toLowerCase() ||
    manifest.genesis.transactionId.toLowerCase() !==
      channel.genesisEvidence.genesisOutpoint.txid.toLowerCase() ||
    !sameOutpoint(
      manifest.genesis.authorizingInput,
      channel.genesisEvidence.authorizingInput,
    ) ||
    !sameOutpoint(
      manifest.genesis.outpoint,
      channel.genesisEvidence.genesisOutpoint,
    ) ||
    manifest.genesis.scriptPublicKey.toLowerCase() !==
      channel.genesisEvidence.genesisScriptPublicKey.toLowerCase() ||
    manifest.genesis.value !== channel.genesisEvidence.genesisAmount ||
    stableStringify(manifest.genesis.acceptance) !==
      stableStringify(channel.genesisEvidence.acceptance)
  ) {
    throw new Error(
      "server channel does not match its immutable covenant launch manifest",
    );
  }
  const head = channel.lineage.currentHead;
  if (head === null) {
    if (channel.status !== "refunded") {
      throw new Error("terminal covenant lineage requires a refunded channel");
    }
    return;
  }
  if (channel.status === "refunded") {
    throw new Error("refunded server channel still has a derived covenant head");
  }
  if (
    head.outpoint.txid.toLowerCase() !==
      channel.activeOutpoint.txid.toLowerCase() ||
    head.outpoint.index !== channel.activeOutpoint.index ||
    head.scriptPublicKey.toLowerCase() !==
      channel.activeScriptPublicKey.toLowerCase() ||
    head.value !== channel.fundingAmount ||
    head.claimedCumulativeAmount !== channel.claimedCumulativeAmount
  ) {
    throw new Error("server channel head does not match its derived covenant lineage");
  }
}

function sameOutpoint(
  left: { txid: string; index: number },
  right: { txid: string; index: number },
): boolean {
  return (
    left.txid.toLowerCase() === right.txid.toLowerCase() &&
    left.index === right.index
  );
}

export function assertServerCovenantLineageExtension(
  previous: ServerChannelRecord,
  next: ServerChannelRecord,
): void {
  assertServerCovenantJournalExtension(previous, next);
  if (
    next.channelId !== previous.channelId ||
    next.covenantId !== previous.covenantId ||
    stableStringify(next.genesisEvidence) !==
      stableStringify(previous.genesisEvidence) ||
    stableStringify(next.channelConfig) !==
      stableStringify(previous.channelConfig) ||
    next.chargedCumulativeAmount !== previous.chargedCumulativeAmount ||
    next.signedMaxClaimable !== previous.signedMaxClaimable ||
    next.voucherSignature !== previous.voucherSignature ||
    next.lastCommitmentId !== previous.lastCommitmentId
  ) {
    throw new Error(
      "covenant lineage reconciliation changed immutable or off-chain channel state",
    );
  }
  if (
    parseSompiString(next.version) !== parseSompiString(previous.version) + 1n
  ) {
    throw new Error("covenant lineage reconciliation must increment channel version");
  }
  const nextIds = new Set(
    canonicalCovenantTransitions(next.lineage).map((transition) =>
      transition.transactionId.toLowerCase(),
    ),
  );
  const rolledBack = canonicalCovenantTransitions(previous.lineage).some(
    (transition) => !nextIds.has(transition.transactionId.toLowerCase()),
  );
  const expectedStatus =
    next.lineage.currentHead === null
      ? "refunded"
      : previous.status === "refunded" || rolledBack
        ? "suspicious"
        : previous.status;
  if (next.status !== expectedStatus) {
    throw new Error(
      "covenant lineage reconciliation has an invalid channel status transition",
    );
  }
}

export function assertServerCovenantJournalExtension(
  previous: ServerChannelRecord,
  next: ServerChannelRecord,
): void {
  assertServerChannelLineageConsistency(previous);
  assertServerChannelLineageConsistency(next);
  if (
    stableStringify(previous.lineage.manifest) !==
    stableStringify(next.lineage.manifest)
  ) {
    throw new Error("covenant launch manifest is immutable");
  }
  if (next.lineage.journal.length < previous.lineage.journal.length) {
    throw new Error("covenant lineage journal is not append-only");
  }
  for (let index = 0; index < previous.lineage.journal.length; index++) {
    if (
      stableStringify(previous.lineage.journal[index]) !==
      stableStringify(next.lineage.journal[index])
    ) {
      throw new Error("covenant lineage journal is not append-only");
    }
  }
}

export function sameCovenantLineage(
  left: CovenantLineageState,
  right: CovenantLineageState,
): boolean {
  return stableStringify(left) === stableStringify(right);
}
