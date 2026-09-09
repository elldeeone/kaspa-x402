import {
  applyCovenantSelectedChainUpdate,
  canonicalCovenantTransitions,
  channelId,
  createCovenantLineageState,
  decideChainEvidence,
  parseSompiString,
  stableStringify,
  type AcceptedTransactionEvidence,
  type CovenantLaunchManifest,
  type CovenantLineageState,
} from "@kaspa-x402/core";
import { ESCROW_V4_LAUNCH_IDENTITY } from "@kaspa-x402/covenant";
import type {
  ChannelLookupScope,
  ChannelStore,
  DirectModeChannel,
  FundingSuccessorIntent,
  FundingTransitionAttemptApplyRequest,
  FundingTransitionAttemptApplyResult,
  FundingTransitionAttemptRecord,
  GenesisChannelIntent,
  RefundAttemptApplyRequest,
  RefundAttemptApplyResult,
  RefundAttemptRecord,
} from "./types.js";

export class MemoryChannelStore implements ChannelStore {
  readonly #channels = new Map<string, DirectModeChannel>();
  readonly #fundingAttempts = new Map<
    string,
    FundingTransitionAttemptRecord
  >();
  readonly #refundAttempts = new Map<string, RefundAttemptRecord>();

  constructor(
    channels: readonly DirectModeChannel[] = [],
    refundAttempts: readonly RefundAttemptRecord[] = [],
    fundingAttempts: readonly FundingTransitionAttemptRecord[] = [],
  ) {
    for (const channel of channels) {
      const key = channelKey(channel.id);
      if (this.#channels.has(key)) {
        throw new Error("persisted channels contain a duplicate channel id");
      }
      assertChannelLineageConsistency(channel);
      this.#channels.set(key, cloneChannel(channel));
    }
    for (const attempt of fundingAttempts) {
      const key = channelKey(attempt.channelId);
      if (this.#fundingAttempts.has(key)) {
        throw new Error(
          "persisted funding attempts contain a duplicate channel",
        );
      }
      const channel = this.#channels.get(key);
      if (!persistedFundingAttemptMatchesChannel(channel, attempt)) {
        throw new Error(
          "persisted funding attempt does not match channel state",
        );
      }
      this.#fundingAttempts.set(key, cloneFundingAttempt(attempt));
    }
    for (const attempt of refundAttempts) {
      const key = channelKey(attempt.channelId);
      if (this.#refundAttempts.has(key)) {
        throw new Error(
          "persisted refund attempts contain a duplicate channel",
        );
      }
      const channel = this.#channels.get(key);
      if (
        !persistedRefundAttemptMatchesChannel(channel, attempt) ||
        (isOpenRefundAttempt(attempt) &&
          isOpenFundingAttempt(this.#fundingAttempts.get(key)))
      ) {
        throw new Error(
          "persisted refund attempt does not match channel state",
        );
      }
      this.#refundAttempts.set(key, cloneRefundAttempt(attempt));
    }
  }

  async loadChannels(scope: ChannelLookupScope): Promise<DirectModeChannel[]> {
    return Array.from(this.#channels.values())
      .filter((channel) => matchesScope(channel, scope))
      .map(cloneChannel);
  }

  async saveChannel(channel: DirectModeChannel): Promise<void> {
    const key = channelKey(channel.id);
    this.#assertChannelMutable(channel.id);
    assertChannelLineageConsistency(channel);
    const existingChannel = this.#channels.get(key);
    if (existingChannel) {
      if (!sameLineage(existingChannel.lineage, channel.lineage)) {
        throw new Error(
          "generic channel save cannot replace authoritative covenant lineage",
        );
      }
      if (
        isRefundOnlyStatus(existingChannel.status) &&
        channel.status !== existingChannel.status
      ) {
        throw new Error(
          "refund-only channel status requires authoritative lineage reconciliation",
        );
      }
    }
    this.#channels.set(key, cloneChannel(channel));
  }

  async applySettledChannel(
    expected: DirectModeChannel,
    channel: DirectModeChannel,
  ): Promise<DirectModeChannel> {
    const key = channelKey(expected.id);
    const current = this.#channels.get(key);
    if (!current || !sameChannelSnapshot(current, expected)) {
      throw new Error("channel changed before settlement apply");
    }
    if (current.status !== "active" || channel.status !== "active") {
      throw new Error("refund-only channel cannot accept a delayed settlement");
    }
    const unchanged = {
      ...channel,
      chargedCumulativeAmount: expected.chargedCumulativeAmount,
      signedMaxClaimable: expected.signedMaxClaimable,
      requiresDepositVoucher: expected.requiresDepositVoucher,
    };
    if (stableStringify(unchanged) !== stableStringify(expected)) {
      throw new Error("settlement changed fields outside channel accounting");
    }
    assertChannelLineageConsistency(channel);
    this.#channels.set(key, cloneChannel(channel));
    return cloneChannel(channel);
  }

  async quarantineChannel(
    expected: DirectModeChannel,
  ): Promise<DirectModeChannel> {
    const key = channelKey(expected.id);
    const current = this.#channels.get(key);
    if (
      !current ||
      !sameHex(current.covenantId, expected.covenantId) ||
      !sameManifest(current.lineage.manifest, expected.lineage.manifest)
    ) {
      throw new Error("channel identity changed before quarantine");
    }
    if (current.status !== "active") return cloneChannel(current);
    const quarantined = { ...current, status: "suspicious" as const };
    this.#channels.set(key, cloneChannel(quarantined));
    return cloneChannel(quarantined);
  }

  async retireChannel(channelId: string): Promise<void> {
    const key = channelKey(channelId);
    this.#assertChannelMutable(channelId);
    const channel = this.#channels.get(key);
    if (!channel) return;
    this.#channels.set(key, { ...channel, status: "retired" });
  }

  async deleteChannel(channelId: string): Promise<void> {
    const key = channelKey(channelId);
    this.#assertChannelMutable(channelId);
    if (this.#fundingAttempts.get(key)?.status === "applied") {
      this.#fundingAttempts.delete(key);
    }
    this.#channels.delete(key);
  }

  async listRefundableChannels(nowDaa?: string): Promise<DirectModeChannel[]> {
    return Array.from(this.#channels.values())
      .filter(
        (channel) =>
          isRefundable(channel, nowDaa) &&
          !isOpenFundingAttempt(
            this.#fundingAttempts.get(channelKey(channel.id)),
          ) &&
          !isOpenRefundAttempt(
            this.#refundAttempts.get(channelKey(channel.id)),
          ),
      )
      .map(cloneChannel);
  }

  async loadFundingTransitionAttempt(
    channelId: string,
  ): Promise<FundingTransitionAttemptRecord | undefined> {
    const attempt = this.#fundingAttempts.get(channelKey(channelId));
    return attempt ? cloneFundingAttempt(attempt) : undefined;
  }

  async loadOpenFundingTransitionAttempts(
    scope: ChannelLookupScope = {},
  ): Promise<FundingTransitionAttemptRecord[]> {
    return Array.from(this.#fundingAttempts.values())
      .filter(
        (attempt) =>
          isOpenFundingAttempt(attempt) &&
          matchesFundingAttemptScope(attempt, scope),
      )
      .map(cloneFundingAttempt);
  }

  async claimFundingTransitionAttempt(
    attempt: FundingTransitionAttemptRecord,
  ): Promise<void> {
    if (!isNewFundingAttempt(attempt)) {
      throw new Error("new funding transition attempt must be pending");
    }
    const key = channelKey(attempt.channelId);
    const existing = this.#fundingAttempts.get(key);
    if (isOpenFundingAttempt(existing)) {
      throw new Error("funding transition attempt is already pending");
    }
    const openLineageAttempt = Array.from(this.#fundingAttempts.values()).find(
      (candidate) =>
        isOpenFundingAttempt(candidate) &&
        (sameHex(
          candidate.intendedSuccessor.covenantId,
          attempt.intendedSuccessor.covenantId,
        ) ||
          (candidate.kind === "genesis" &&
            attempt.kind === "genesis" &&
            sameGenesisLane(candidate.intent, attempt.intent))),
    );
    if (openLineageAttempt) {
      throw new Error("payment lane already has an open funding transition");
    }
    if (isOpenRefundAttempt(this.#refundAttempts.get(key))) {
      throw new Error("channel has an open refund attempt");
    }
    const channel = this.#channels.get(key);
    if (!newFundingAttemptMatchesChannel(channel, attempt)) {
      throw new Error("channel state changed before funding transition claim");
    }
    this.#fundingAttempts.set(key, cloneFundingAttempt(attempt));
  }

  async saveFundingTransitionAttempt(
    attempt: FundingTransitionAttemptRecord,
  ): Promise<void> {
    const key = channelKey(attempt.channelId);
    const existing = this.#fundingAttempts.get(key);
    if (!existing || existing.status === "applied") {
      throw new Error("funding transition attempt is not open");
    }
    if (
      existing.status !== "pending" ||
      attempt.status !== "broadcast" ||
      attempt.finality !== "broadcast" ||
      !sameFundingArtifact(existing, attempt)
    ) {
      throw new Error(
        "funding transition update does not match pending artifact",
      );
    }
    this.#fundingAttempts.set(key, cloneFundingAttempt(attempt));
  }

  async applyFundingTransitionAttempt(
    request: FundingTransitionAttemptApplyRequest,
  ): Promise<FundingTransitionAttemptApplyResult> {
    const key = channelKey(request.channelId);
    const attempt = this.#fundingAttempts.get(key);
    if (!attempt) throw new Error("funding transition attempt was not found");
    if (attempt.kind !== request.kind) {
      throw new Error("funding transition kind does not match pending attempt");
    }
    if (!sameHex(attempt.transactionId, request.transactionId)) {
      throw new Error(
        "funding transaction id does not match pending attempt",
      );
    }
    const decision = decideChainEvidence(
      request.acceptance,
      attempt.requiredConfirmations,
    );
    if (
      decision.status !== "confirmed" ||
      !sameHex(request.acceptance.transactionId, attempt.transactionId)
    ) {
      throw new Error(
        "funding transition has not reached the configured confirmation threshold",
      );
    }
    const current = this.#channels.get(key);
    if (attempt.status === "applied") {
      if (!appliedFundingAttemptMatchesChannel(current, attempt)) {
        throw new Error(
          "applied funding attempt has inconsistent channel state",
        );
      }
      return {
        channel: cloneChannel(current),
        attempt: cloneFundingAttempt(attempt),
      };
    }
    if (!openFundingAttemptMatchesChannel(current, attempt)) {
      throw new Error("channel state changed before funding transition apply");
    }
    if (!evidenceMatchesFundingAttempt(request, attempt)) {
      throw new Error(
        "funding transition evidence does not match reserved successor",
      );
    }

    const channel =
      attempt.kind === "genesis"
        ? channelFromGenesisAttempt(attempt, request.evidence)
        : channelFromTopUpAttempt(attempt, request.evidence);
    const applied: FundingTransitionAttemptRecord = {
      ...attempt,
      status: "applied",
      finality: "confirmed",
      acceptance: structuredClone(request.acceptance),
    };
    this.#channels.set(key, cloneChannel(channel));
    this.#fundingAttempts.set(key, cloneFundingAttempt(applied));
    return {
      channel: cloneChannel(channel),
      attempt: cloneFundingAttempt(applied),
    };
  }

  async releaseFundingTransitionAttempt(
    channelId: string,
    transactionId: string,
  ): Promise<void> {
    const key = channelKey(channelId);
    const attempt = this.#fundingAttempts.get(key);
    if (!attempt || attempt.status === "applied") {
      throw new Error("funding transition attempt is not open");
    }
    if (!sameHex(attempt.transactionId, transactionId)) {
      throw new Error(
        "funding transaction id does not match pending attempt",
      );
    }
    if (!openFundingAttemptMatchesChannel(this.#channels.get(key), attempt)) {
      throw new Error(
        "channel state changed before funding transition release",
      );
    }
    this.#fundingAttempts.delete(key);
  }

  async loadRefundAttempt(
    channelId: string,
  ): Promise<RefundAttemptRecord | undefined> {
    const attempt = this.#refundAttempts.get(channelKey(channelId));
    return attempt ? cloneRefundAttempt(attempt) : undefined;
  }

  async claimRefundAttempt(attempt: RefundAttemptRecord): Promise<void> {
    if (
      attempt.status !== "pending" ||
      attempt.finality !== undefined ||
      attempt.acceptance !== undefined
    ) {
      throw new Error("new refund attempt must be pending");
    }
    const key = channelKey(attempt.channelId);
    const existing = this.#refundAttempts.get(key);
    if (existing && existing.status !== "applied") {
      throw new Error("refund attempt is already pending");
    }
    if (existing) {
      throw new Error("refund attempt is already applied");
    }
    const fundingAttempt = this.#fundingAttempts.get(key);
    if (isOpenFundingAttempt(fundingAttempt)) {
      throw new Error("channel has an open funding transition");
    }
    const channel = this.#channels.get(key);
    if (!channelMatchesRefundAttempt(channel, attempt)) {
      throw new Error("channel state changed before refund claim");
    }
    this.#refundAttempts.set(key, cloneRefundAttempt(attempt));
  }

  async saveRefundAttempt(attempt: RefundAttemptRecord): Promise<void> {
    const key = channelKey(attempt.channelId);
    const existing = this.#refundAttempts.get(key);
    if (!existing || existing.status === "applied") {
      throw new Error("refund attempt is not open");
    }
    if (
      existing.status !== "pending" ||
      attempt.status !== "broadcast" ||
      attempt.finality !== "broadcast" ||
      !sameRefundArtifact(existing, attempt)
    ) {
      throw new Error("refund attempt update does not match pending artifact");
    }
    this.#refundAttempts.set(key, cloneRefundAttempt(attempt));
  }

  async applyRefundAttempt(
    request: RefundAttemptApplyRequest,
  ): Promise<RefundAttemptApplyResult> {
    const key = channelKey(request.channelId);
    const attempt = this.#refundAttempts.get(key);
    if (!attempt) throw new Error("refund attempt was not found");
    if (!sameHex(attempt.transactionId, request.transactionId)) {
      throw new Error("refund transaction id does not match pending attempt");
    }
    const decision = decideChainEvidence(
      request.acceptance,
      attempt.requiredConfirmations,
    );
    if (
      decision.status !== "confirmed" ||
      !sameHex(request.acceptance.transactionId, attempt.transactionId)
    ) {
      throw new Error(
        "refund has not reached the configured confirmation threshold",
      );
    }
    const current = this.#channels.get(key);
    if (attempt.status === "applied") {
      if (
        !channelHeadMatchesRefundAttempt(current, attempt) ||
        current.status !== "refunded" ||
        (attempt.finality !== "accepted" && attempt.finality !== "confirmed")
      ) {
        throw new Error(
          "applied refund attempt has inconsistent channel state",
        );
      }
      return {
        channel: cloneChannel(current),
        attempt: cloneRefundAttempt(attempt),
      };
    }
    if (!channelMatchesRefundAttempt(current, attempt)) {
      throw new Error("channel state changed before refund apply");
    }
    const lineage = applyCovenantSelectedChainUpdate(current.lineage, {
      fromCheckpoint: current.lineage.checkpoint,
      checkpoint: request.acceptance.checkpoint,
      continuity: "complete",
      removedChainBlockHashes: [],
      addedChainBlocks: [
        {
          blockHash: request.acceptance.acceptingBlockHash,
          transitions: [
            {
              kind: "refund",
              covenantId: attempt.covenantId,
              templateId: current.templateId,
              consumedOutpoint: attempt.activeOutpoint,
              transactionId: attempt.transactionId,
              authorizedSuccessorCount: 0,
              successor: null,
              terminalOutput: {
                index: 0,
                scriptPublicKey: attempt.refundScriptPublicKey,
                value: attempt.refundAmount,
              },
              acceptance: request.acceptance,
            },
          ],
        },
      ],
    });
    const refunded = {
      ...current,
      lineage,
      status: "refunded" as const,
    };
    const applied: RefundAttemptRecord = {
      ...attempt,
      status: "applied",
      finality: "confirmed",
      acceptance: structuredClone(request.acceptance),
    };
    this.#channels.set(key, cloneChannel(refunded));
    this.#refundAttempts.set(key, cloneRefundAttempt(applied));
    return {
      channel: cloneChannel(refunded),
      attempt: cloneRefundAttempt(applied),
    };
  }

  async releaseRefundAttempt(
    channelId: string,
    transactionId: string,
  ): Promise<void> {
    const key = channelKey(channelId);
    const attempt = this.#refundAttempts.get(key);
    if (!attempt || attempt.status === "applied") {
      throw new Error("refund attempt is not open");
    }
    if (!sameHex(attempt.transactionId, transactionId)) {
      throw new Error("refund transaction id does not match pending attempt");
    }
    if (!channelMatchesRefundAttempt(this.#channels.get(key), attempt)) {
      throw new Error("channel state changed before refund release");
    }
    this.#refundAttempts.delete(key);
  }

  async loadCovenantLineage(
    channelId: string,
  ): Promise<CovenantLineageState | undefined> {
    const channel = this.#channels.get(channelKey(channelId));
    return channel ? structuredClone(channel.lineage) : undefined;
  }

  async applyCovenantLineage(input: {
    expectedChannel: DirectModeChannel;
    lineage: CovenantLineageState;
    channel: DirectModeChannel;
  }): Promise<DirectModeChannel> {
    const key = channelKey(input.expectedChannel.id);
    const current = this.#channels.get(key);
    if (!current || !sameChannelSnapshot(current, input.expectedChannel)) {
      throw new Error("channel changed before covenant lineage reconciliation");
    }
    const fundingAttempt = this.#fundingAttempts.get(key);
    if (isOpenFundingAttempt(fundingAttempt)) {
      throw new Error("channel has an open funding transition");
    }
    const refundAttempt = this.#refundAttempts.get(key);
    if (isOpenRefundAttempt(refundAttempt)) {
      throw new Error("channel has an open refund attempt");
    }
    if (!sameManifest(current.lineage.manifest, input.lineage.manifest)) {
      throw new Error("covenant launch manifest is immutable");
    }
    if (!journalHasPrefix(input.lineage, current.lineage)) {
      throw new Error("covenant lineage journal is not append-only");
    }
    if (
      !sameHex(input.channel.id, current.id) ||
      !sameLineage(input.channel.lineage, input.lineage)
    ) {
      throw new Error("reconciled channel does not own the supplied lineage");
    }
    assertChannelLineageConsistency(input.channel);
    if (fundingAttempt?.kind === "top-up" && fundingAttempt.status === "applied") {
      const transitionStillCanonical = canonicalCovenantTransitions(
        input.lineage,
      ).some((transition) =>
        sameHex(transition.transactionId, fundingAttempt.transactionId),
      );
      if (!transitionStillCanonical) {
        const appendedEvents = input.lineage.journal.slice(
          current.lineage.journal.length,
        );
        const verifiedRemoval =
          input.channel.status === "refundable" &&
          fundingAttempt.acceptance !== undefined &&
          appendedEvents.some(
            (event) =>
              event.event === "removed" &&
              sameHex(
                event.acceptingBlockHash,
                fundingAttempt.acceptance!.acceptingBlockHash,
              ) &&
              event.transactionIds.some((transactionId) =>
                sameHex(transactionId, fundingAttempt.transactionId),
              ),
          );
        if (!verifiedRemoval) {
          throw new Error(
            "applied top-up can only reopen after its selected-chain removal",
          );
        }
        this.#fundingAttempts.set(key, {
          ...fundingAttempt,
          expectedChannel: cloneChannel(input.channel),
          status: "broadcast",
          finality: "broadcast",
          acceptance: undefined,
        });
      }
    }
    if (refundAttempt?.status === "applied") {
      const refundStillCanonical = canonicalCovenantTransitions(
        input.lineage,
      ).some(
        (transition) =>
          transition.kind === "refund" &&
          sameHex(transition.transactionId, refundAttempt.transactionId) &&
          sameOutpoint(transition.consumedOutpoint, refundAttempt.activeOutpoint),
      );
      if (!refundStillCanonical) {
        const appendedEvents = input.lineage.journal.slice(
          current.lineage.journal.length,
        );
        const verifiedRemoval =
          current.status === "refunded" &&
          current.lineage.currentHead === null &&
          input.lineage.currentHead !== null &&
          input.channel.status === "refundable" &&
          refundAttempt.acceptance !== undefined &&
          appendedEvents.some(
            (event) =>
              event.event === "removed" &&
              sameHex(
                event.acceptingBlockHash,
                refundAttempt.acceptance!.acceptingBlockHash,
              ) &&
              event.transactionIds.some((transactionId) =>
                sameHex(transactionId, refundAttempt.transactionId),
              ),
          );
        if (!verifiedRemoval) {
          throw new Error(
            "applied refund can only roll back after its selected-chain removal restores a refund-only head",
          );
        }
        this.#refundAttempts.delete(key);
      }
    }
    this.#channels.set(key, cloneChannel(input.channel));
    return cloneChannel(input.channel);
  }

  #assertChannelMutable(channelId: string): void {
    const key = channelKey(channelId);
    if (isOpenFundingAttempt(this.#fundingAttempts.get(key))) {
      throw new Error("channel has an open funding transition");
    }
    const refundAttempt = this.#refundAttempts.get(key);
    if (isOpenRefundAttempt(refundAttempt)) {
      throw new Error("channel has an open refund attempt");
    }
    if (refundAttempt?.status === "applied") {
      throw new Error("channel has a terminal refund attempt");
    }
  }
}

function matchesScope(
  channel: DirectModeChannel,
  scope: ChannelLookupScope,
): boolean {
  if (scope.origin && channel.origin !== scope.origin) return false;
  if (scope.resourceUrl && channel.resourceUrl !== scope.resourceUrl)
    return false;
  if (scope.network && channel.config.network !== scope.network) return false;
  if (scope.status && channel.status !== scope.status) return false;
  return true;
}

function matchesFundingAttemptScope(
  attempt: FundingTransitionAttemptRecord,
  scope: ChannelLookupScope,
): boolean {
  const origin =
    attempt.kind === "genesis"
      ? attempt.intent.origin
      : attempt.expectedChannel.origin;
  const resourceUrl =
    attempt.kind === "genesis"
      ? attempt.intent.resourceUrl
      : attempt.expectedChannel.resourceUrl;
  const network =
    attempt.kind === "genesis"
      ? attempt.intent.config.network
      : attempt.expectedChannel.config.network;
  const status =
    attempt.kind === "genesis" ? "active" : attempt.expectedChannel.status;
  if (scope.origin && scope.origin !== origin) return false;
  if (scope.resourceUrl && scope.resourceUrl !== resourceUrl) return false;
  if (scope.network && scope.network !== network) return false;
  if (scope.status && scope.status !== status) return false;
  return true;
}

function isRefundable(channel: DirectModeChannel, nowDaa?: string): boolean {
  if (!["active", "retired", "refundable"].includes(channel.status))
    return false;
  return (
    nowDaa === undefined ||
    parseSompiString(nowDaa) > parseSompiString(channel.refundTimeoutDaa)
  );
}

function isRefundOnlyStatus(status: DirectModeChannel["status"]): boolean {
  return status === "suspicious" || status === "refundable" || status === "refunded";
}

function cloneChannel(channel: DirectModeChannel): DirectModeChannel {
  return structuredClone(channel);
}

function cloneFundingAttempt(
  attempt: FundingTransitionAttemptRecord,
): FundingTransitionAttemptRecord {
  return structuredClone(attempt);
}

function cloneRefundAttempt(attempt: RefundAttemptRecord): RefundAttemptRecord {
  return structuredClone(attempt);
}

function isOpenFundingAttempt(
  attempt: FundingTransitionAttemptRecord | undefined,
): boolean {
  return attempt !== undefined && attempt.status !== "applied";
}

function isNewFundingAttempt(attempt: FundingTransitionAttemptRecord): boolean {
  return (
    attempt.status === "pending" &&
    attempt.finality === undefined &&
    fundingAttemptArtifactIsConsistent(attempt)
  );
}

function fundingAttemptChannelId(
  attempt: FundingTransitionAttemptRecord,
): string {
  return attempt.kind === "genesis"
    ? attempt.intent.channelId
    : attempt.expectedChannel.id;
}

function newFundingAttemptMatchesChannel(
  channel: DirectModeChannel | undefined,
  attempt: FundingTransitionAttemptRecord,
): boolean {
  if (attempt.kind === "genesis") {
    return (
      channel === undefined &&
      sameHex(channelId(attempt.intent.config), attempt.channelId)
    );
  }
  return (
    channel !== undefined &&
    channel.status === "active" &&
    sameChannelSnapshot(channel, attempt.expectedChannel) &&
    sameHex(attempt.intendedSuccessor.covenantId, channel.covenantId) &&
    sameHex(
      attempt.intendedSuccessor.scriptPublicKey,
      channel.activeScriptPublicKey,
    ) &&
    parseSompiString(attempt.intendedSuccessor.amount) >
      parseSompiString(channel.fundingAmount)
  );
}

function openFundingAttemptMatchesChannel(
  channel: DirectModeChannel | undefined,
  attempt: FundingTransitionAttemptRecord,
): boolean {
  return attempt.kind === "genesis"
    ? channel === undefined
    : channel !== undefined &&
        sameChannelSnapshot(channel, attempt.expectedChannel);
}

function persistedFundingAttemptMatchesChannel(
  channel: DirectModeChannel | undefined,
  attempt: FundingTransitionAttemptRecord,
): boolean {
  if (!fundingAttemptArtifactIsConsistent(attempt)) return false;
  switch (attempt.status) {
    case "pending":
      return (
        attempt.finality === undefined &&
        openFundingAttemptMatchesChannel(channel, attempt)
      );
    case "broadcast":
      return (
        attempt.finality === "broadcast" &&
        openFundingAttemptMatchesChannel(channel, attempt)
      );
    case "applied":
      return (
        (attempt.finality === "accepted" ||
          attempt.finality === "confirmed") &&
        appliedFundingAttemptMatchesChannel(channel, attempt)
      );
    default:
      return false;
  }
}

function fundingAttemptArtifactIsConsistent(
  attempt: FundingTransitionAttemptRecord,
): boolean {
  return (
    Number.isSafeInteger(attempt.requiredConfirmations) &&
    attempt.requiredConfirmations > 0 &&
    sameHex(attempt.channelId, fundingAttemptChannelId(attempt)) &&
    sameHex(attempt.transactionId, attempt.intendedSuccessor.outpoint.txid) &&
    !/^0{64}$/i.test(attempt.intendedSuccessor.covenantId) &&
    (attempt.kind === "genesis"
      ? attempt.intent.fundingSource === attempt.fundingSource &&
        sameHex(channelId(attempt.intent.config), attempt.channelId)
      : sameHex(
          attempt.intendedSuccessor.covenantId,
          attempt.expectedChannel.covenantId,
        ) &&
        sameHex(
          attempt.intendedSuccessor.scriptPublicKey,
          attempt.expectedChannel.activeScriptPublicKey,
        ))
  );
}

function appliedFundingAttemptMatchesChannel(
  channel: DirectModeChannel | undefined,
  attempt: FundingTransitionAttemptRecord,
): channel is DirectModeChannel {
  if (!channel || !sameIntendedHead(channel, attempt.intendedSuccessor)) {
    return false;
  }
  if (attempt.kind === "genesis") {
    return (
      sameHex(channel.id, attempt.intent.channelId) &&
      sameHex(channel.covenantId, attempt.intendedSuccessor.covenantId) &&
      channel.origin === attempt.intent.origin &&
      channel.resourceUrl === attempt.intent.resourceUrl &&
      JSON.stringify(channel.config) ===
        JSON.stringify(attempt.intent.config) &&
      channel.clientPrivateKey === attempt.intent.clientPrivateKey &&
      channel.escrowAddress === attempt.intent.escrowAddress &&
      channel.fundingSource === attempt.fundingSource &&
      genesisEvidenceMatchesSuccessor(
        channel.genesisEvidence,
        attempt.intendedSuccessor,
      ) &&
      channel.status === "active"
    );
  }
  return (
    sameHex(channel.id, attempt.expectedChannel.id) &&
    sameHex(channel.covenantId, attempt.expectedChannel.covenantId) &&
    channel.chargedCumulativeAmount ===
      attempt.expectedChannel.chargedCumulativeAmount &&
    channel.claimedCumulativeAmount ===
      attempt.expectedChannel.claimedCumulativeAmount &&
    channel.signedMaxClaimable === attempt.expectedChannel.signedMaxClaimable &&
    channel.status === attempt.expectedChannel.status &&
    channel.requiresDepositVoucher &&
    channel.lastTopUpEvidence !== undefined &&
    topUpEvidenceMatchesAttempt(channel.lastTopUpEvidence, attempt)
  );
}

function genesisEvidenceMatchesSuccessor(
  evidence: DirectModeChannel["genesisEvidence"],
  successor: FundingSuccessorIntent,
): boolean {
  return (
    evidence.totalOutputCount === 1 &&
    evidence.authorizedOutputCount === 1 &&
    sameHex(evidence.covenantId, successor.covenantId) &&
    sameOutpoint(evidence.genesisOutpoint, successor.outpoint) &&
    sameHex(evidence.genesisScriptPublicKey, successor.scriptPublicKey) &&
    evidence.genesisAmount === successor.amount
  );
}

function topUpEvidenceMatchesAttempt(
  evidence: NonNullable<DirectModeChannel["lastTopUpEvidence"]>,
  attempt: Extract<FundingTransitionAttemptRecord, { kind: "top-up" }>,
): boolean {
  return (
    evidence.authorizedSuccessorCount === 1 &&
    Number.isSafeInteger(evidence.authorizingInput) &&
    evidence.authorizingInput >= 0 &&
    sameHex(evidence.covenantId, attempt.intendedSuccessor.covenantId) &&
    sameOutpoint(
      evidence.spentOutpoint,
      attempt.expectedChannel.activeOutpoint,
    ) &&
    sameOutpoint(
      evidence.successorOutpoint,
      attempt.intendedSuccessor.outpoint,
    ) &&
    sameHex(
      evidence.successorScriptPublicKey,
      attempt.intendedSuccessor.scriptPublicKey,
    ) &&
    evidence.successorAmount === attempt.intendedSuccessor.amount
  );
}

function evidenceMatchesFundingAttempt(
  request: FundingTransitionAttemptApplyRequest,
  attempt: FundingTransitionAttemptRecord,
): boolean {
  if (request.kind === "genesis" && attempt.kind === "genesis") {
    return (
      request.evidence.totalOutputCount === 1 &&
      request.evidence.authorizedOutputCount === 1 &&
      sameHex(
        request.evidence.acceptance.transactionId,
        request.acceptance.transactionId,
      ) &&
      sameAcceptedEvidence(request.evidence.acceptance, request.acceptance) &&
      sameHex(
        request.evidence.covenantId,
        attempt.intendedSuccessor.covenantId,
      ) &&
      sameOutpoint(
        request.evidence.genesisOutpoint,
        attempt.intendedSuccessor.outpoint,
      ) &&
      sameHex(
        request.evidence.genesisScriptPublicKey,
        attempt.intendedSuccessor.scriptPublicKey,
      ) &&
      request.evidence.genesisAmount === attempt.intendedSuccessor.amount
    );
  }
  if (request.kind === "top-up" && attempt.kind === "top-up") {
    return (
      request.evidence.authorizedSuccessorCount === 1 &&
      Number.isSafeInteger(request.evidence.authorizingInput) &&
      request.evidence.authorizingInput >= 0 &&
      sameHex(
        request.evidence.acceptance.transactionId,
        request.acceptance.transactionId,
      ) &&
      sameAcceptedEvidence(request.evidence.acceptance, request.acceptance) &&
      sameHex(
        request.evidence.covenantId,
        attempt.intendedSuccessor.covenantId,
      ) &&
      sameOutpoint(
        request.evidence.spentOutpoint,
        attempt.expectedChannel.activeOutpoint,
      ) &&
      sameOutpoint(
        request.evidence.successorOutpoint,
        attempt.intendedSuccessor.outpoint,
      ) &&
      sameHex(
        request.evidence.successorScriptPublicKey,
        attempt.intendedSuccessor.scriptPublicKey,
      ) &&
      request.evidence.successorAmount === attempt.intendedSuccessor.amount
    );
  }
  return false;
}

function channelFromGenesisAttempt(
  attempt: Extract<FundingTransitionAttemptRecord, { kind: "genesis" }>,
  evidence: FundingTransitionAttemptApplyRequest["evidence"],
): DirectModeChannel {
  if (!("genesisOutpoint" in evidence)) {
    throw new Error("genesis transition requires genesis evidence");
  }
  const manifest: CovenantLaunchManifest = {
    format: "kaspa-x402-covenant-launch-v1",
    network: attempt.intent.config.network,
    compiler: structuredClone(ESCROW_V4_LAUNCH_IDENTITY.compiler),
    source: structuredClone(ESCROW_V4_LAUNCH_IDENTITY.source),
    bytecode: structuredClone(ESCROW_V4_LAUNCH_IDENTITY.bytecode),
    constructorSlots: structuredClone(
      ESCROW_V4_LAUNCH_IDENTITY.constructorSlots,
    ),
    abi: structuredClone(ESCROW_V4_LAUNCH_IDENTITY.abi),
    selectors: structuredClone(ESCROW_V4_LAUNCH_IDENTITY.selectors),
    identitySha256: ESCROW_V4_LAUNCH_IDENTITY.identitySha256,
    genesis: {
      derivation: "kip20-covenant-id-v1",
      covenantId: evidence.covenantId,
      authorizingInput: evidence.authorizingInput,
      transactionId: attempt.transactionId,
      outpoint: evidence.genesisOutpoint,
      scriptPublicKey: evidence.genesisScriptPublicKey,
      value: evidence.genesisAmount,
      claimedCumulativeAmount: "0",
      acceptance: evidence.acceptance,
    },
  };
  return {
    id: attempt.channelId,
    covenantId: attempt.intendedSuccessor.covenantId,
    genesisEvidence: evidence,
    origin: attempt.intent.origin,
    ...(attempt.intent.resourceUrl
      ? { resourceUrl: attempt.intent.resourceUrl }
      : {}),
    config: attempt.intent.config,
    ...(attempt.intent.clientPrivateKey
      ? { clientPrivateKey: attempt.intent.clientPrivateKey }
      : {}),
    clientPublicKey: attempt.intent.config.clientPublicKey,
    serverPublicKey: attempt.intent.config.serverPublicKey,
    activeOutpoint: attempt.intendedSuccessor.outpoint,
    activeScriptPublicKey: attempt.intendedSuccessor.scriptPublicKey,
    escrowAddress: attempt.intent.escrowAddress,
    fundingSource: attempt.fundingSource,
    fundingAmount: attempt.intendedSuccessor.amount,
    chargedCumulativeAmount: "0",
    claimedCumulativeAmount: "0",
    signedMaxClaimable: "0",
    requiresDepositVoucher: true,
    refundTimeoutDaa: attempt.intent.config.refundTimeoutDaa,
    templateId: attempt.intent.config.templateId,
    lineage: createCovenantLineageState(manifest),
    status: "active",
  };
}

function channelFromTopUpAttempt(
  attempt: Extract<FundingTransitionAttemptRecord, { kind: "top-up" }>,
  evidence: FundingTransitionAttemptApplyRequest["evidence"],
): DirectModeChannel {
  if (!("successorOutpoint" in evidence)) {
    throw new Error("top-up transition requires top-up evidence");
  }
  const lineage = applyCovenantSelectedChainUpdate(
    attempt.expectedChannel.lineage,
    {
      fromCheckpoint: attempt.expectedChannel.lineage.checkpoint,
      checkpoint: evidence.acceptance.checkpoint,
      continuity: "complete",
      removedChainBlockHashes: [],
      addedChainBlocks: [
        {
          blockHash: evidence.acceptance.acceptingBlockHash,
          transitions: [
            {
              kind: "top-up",
              covenantId: evidence.covenantId,
              templateId: attempt.expectedChannel.templateId,
              consumedOutpoint: evidence.spentOutpoint,
              transactionId: attempt.transactionId,
              authorizedSuccessorCount: evidence.authorizedSuccessorCount,
              successor: {
                outpoint: evidence.successorOutpoint,
                covenantId: evidence.covenantId,
                authorizingInput: evidence.authorizingInput,
                scriptPublicKey: evidence.successorScriptPublicKey,
                value: evidence.successorAmount,
                claimedCumulativeAmount:
                  attempt.expectedChannel.claimedCumulativeAmount,
              },
              terminalOutput: null,
              acceptance: evidence.acceptance,
            },
          ],
        },
      ],
    },
  );
  return {
    ...attempt.expectedChannel,
    activeOutpoint: attempt.intendedSuccessor.outpoint,
    activeScriptPublicKey: attempt.intendedSuccessor.scriptPublicKey,
    fundingAmount: attempt.intendedSuccessor.amount,
    lastTopUpEvidence: evidence,
    lineage,
    requiresDepositVoucher: true,
  };
}

function sameIntendedHead(
  channel: DirectModeChannel,
  successor: FundingSuccessorIntent,
): boolean {
  return (
    sameHex(channel.covenantId, successor.covenantId) &&
    sameOutpoint(channel.activeOutpoint, successor.outpoint) &&
    sameHex(channel.activeScriptPublicKey, successor.scriptPublicKey) &&
    channel.fundingAmount === successor.amount
  );
}

function sameFundingArtifact(
  left: FundingTransitionAttemptRecord,
  right: FundingTransitionAttemptRecord,
): boolean {
  return (
    left.kind === right.kind &&
    sameHex(left.channelId, right.channelId) &&
    sameHex(left.transaction, right.transaction) &&
    sameHex(left.transactionId, right.transactionId) &&
    sameSuccessor(left.intendedSuccessor, right.intendedSuccessor) &&
    left.fundingSource === right.fundingSource &&
    left.requiredConfirmations === right.requiredConfirmations &&
    (left.kind === "genesis"
      ? right.kind === "genesis" &&
        sameGenesisIntent(left.intent, right.intent)
      : right.kind === "top-up" &&
        sameChannelSnapshot(left.expectedChannel, right.expectedChannel))
  );
}

function sameGenesisLane(
  left: GenesisChannelIntent,
  right: GenesisChannelIntent,
): boolean {
  return (
    left.origin === right.origin &&
    left.resourceUrl === right.resourceUrl &&
    left.config.network === right.config.network &&
    left.config.payTo === right.config.payTo &&
    sameHex(left.config.serverPublicKey, right.config.serverPublicKey)
  );
}

function sameGenesisIntent(
  left: GenesisChannelIntent,
  right: GenesisChannelIntent,
): boolean {
  return (
    sameHex(left.channelId, right.channelId) &&
    left.origin === right.origin &&
    left.resourceUrl === right.resourceUrl &&
    JSON.stringify(left.config) === JSON.stringify(right.config) &&
    left.clientPrivateKey === right.clientPrivateKey &&
    left.escrowAddress === right.escrowAddress &&
    left.fundingSource === right.fundingSource
  );
}

function sameChannelSnapshot(
  left: DirectModeChannel,
  right: DirectModeChannel,
): boolean {
  return (
    sameHex(left.id, right.id) &&
    sameHex(left.covenantId, right.covenantId) &&
    sameOutpoint(left.activeOutpoint, right.activeOutpoint) &&
    sameHex(left.activeScriptPublicKey, right.activeScriptPublicKey) &&
    left.fundingAmount === right.fundingAmount &&
    left.chargedCumulativeAmount === right.chargedCumulativeAmount &&
    left.claimedCumulativeAmount === right.claimedCumulativeAmount &&
    left.signedMaxClaimable === right.signedMaxClaimable &&
    left.status === right.status &&
    sameLineage(left.lineage, right.lineage) &&
    sameVoucher(left.latestVoucher, right.latestVoucher)
  );
}

function sameVoucher(
  left: DirectModeChannel["latestVoucher"],
  right: DirectModeChannel["latestVoucher"],
): boolean {
  if (!left || !right) return left === right;
  return (
    sameHex(left.covenantId, right.covenantId) &&
    left.amount === right.amount &&
    sameHex(left.signature, right.signature)
  );
}

function sameSuccessor(
  left: FundingSuccessorIntent,
  right: FundingSuccessorIntent,
): boolean {
  return (
    sameOutpoint(left.outpoint, right.outpoint) &&
    sameHex(left.covenantId, right.covenantId) &&
    left.amount === right.amount &&
    sameHex(left.scriptPublicKey, right.scriptPublicKey)
  );
}

function sameOutpoint(
  left: { txid: string; index: number },
  right: { txid: string; index: number },
): boolean {
  return sameHex(left.txid, right.txid) && left.index === right.index;
}

function isOpenRefundAttempt(
  attempt: RefundAttemptRecord | undefined,
): boolean {
  return attempt !== undefined && attempt.status !== "applied";
}

function channelMatchesRefundAttempt(
  channel: DirectModeChannel | undefined,
  attempt: RefundAttemptRecord,
): channel is DirectModeChannel {
  return (
    channelHeadMatchesRefundAttempt(channel, attempt) &&
    channel.status === attempt.channelStatus
  );
}

function channelHeadMatchesRefundAttempt(
  channel: DirectModeChannel | undefined,
  attempt: RefundAttemptRecord,
): channel is DirectModeChannel {
  return (
    channel !== undefined &&
    sameHex(channel.id, attempt.channelId) &&
    sameHex(channel.covenantId, attempt.covenantId) &&
    sameOutpoint(channel.activeOutpoint, attempt.activeOutpoint) &&
    sameHex(channel.activeScriptPublicKey, attempt.activeScriptPublicKey) &&
    channel.fundingAmount === attempt.fundingAmount &&
    attempt.refundAmount === attempt.fundingAmount
  );
}

function persistedRefundAttemptMatchesChannel(
  channel: DirectModeChannel | undefined,
  attempt: RefundAttemptRecord,
): boolean {
  switch (attempt.status) {
    case "pending":
      return (
        attempt.finality === undefined &&
        attempt.acceptance === undefined &&
        channelMatchesRefundAttempt(channel, attempt)
      );
    case "broadcast":
      return (
        attempt.finality === "broadcast" &&
        (attempt.acceptance === undefined ||
          sameHex(attempt.acceptance.transactionId, attempt.transactionId)) &&
        channelMatchesRefundAttempt(channel, attempt)
      );
    case "applied":
      return (
        channelHeadMatchesRefundAttempt(channel, attempt) &&
        channel.status === "refunded" &&
        attempt.finality === "confirmed" &&
        attempt.acceptance !== undefined &&
        sameHex(attempt.acceptance.transactionId, attempt.transactionId)
      );
    default:
      return false;
  }
}

function sameRefundArtifact(
  left: RefundAttemptRecord,
  right: RefundAttemptRecord,
): boolean {
  return (
    sameHex(left.channelId, right.channelId) &&
    sameHex(left.covenantId, right.covenantId) &&
    sameOutpoint(left.activeOutpoint, right.activeOutpoint) &&
    sameHex(left.activeScriptPublicKey, right.activeScriptPublicKey) &&
    left.fundingAmount === right.fundingAmount &&
    left.channelStatus === right.channelStatus &&
    left.refundAmount === right.refundAmount &&
    left.refundScriptPublicKey.toLowerCase() ===
      right.refundScriptPublicKey.toLowerCase() &&
    left.requiredConfirmations === right.requiredConfirmations &&
    sameHex(left.transaction, right.transaction) &&
    sameHex(left.transactionId, right.transactionId)
  );
}

function sameHex(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function sameAcceptedEvidence(
  left: AcceptedTransactionEvidence,
  right: AcceptedTransactionEvidence,
): boolean {
  return (
    left.status === right.status &&
    sameHex(left.transactionId, right.transactionId) &&
    sameHex(left.acceptingBlockHash, right.acceptingBlockHash) &&
    left.acceptingBlockBlueScore === right.acceptingBlockBlueScore &&
    left.confirmationCount === right.confirmationCount &&
    sameHex(left.checkpoint.blockHash, right.checkpoint.blockHash) &&
    left.checkpoint.blueScore === right.checkpoint.blueScore &&
    left.checkpoint.daaScore === right.checkpoint.daaScore
  );
}

function channelKey(channelId: string): string {
  return channelId.toLowerCase();
}

function assertChannelLineageConsistency(channel: DirectModeChannel): void {
  const manifest = channel.lineage.manifest;
  if (
    manifest.network !== channel.config.network ||
    manifest.bytecode.templateId !== channel.templateId ||
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
    !sameHex(manifest.genesis.covenantId, channel.covenantId) ||
    !sameHex(
      manifest.genesis.transactionId,
      channel.genesisEvidence.genesisOutpoint.txid,
    ) ||
    !sameOutpoint(
      manifest.genesis.authorizingInput,
      channel.genesisEvidence.authorizingInput,
    ) ||
    !sameOutpoint(
      manifest.genesis.outpoint,
      channel.genesisEvidence.genesisOutpoint,
    ) ||
    !sameHex(
      manifest.genesis.scriptPublicKey,
      channel.genesisEvidence.genesisScriptPublicKey,
    ) ||
    manifest.genesis.value !== channel.genesisEvidence.genesisAmount ||
    stableStringify(manifest.genesis.acceptance) !==
      stableStringify(channel.genesisEvidence.acceptance)
  ) {
    throw new Error(
      "channel does not match its immutable covenant launch manifest",
    );
  }
  const head = channel.lineage.currentHead;
  if (channel.status === "refunded") {
    if (head !== null) {
      throw new Error("refunded channel still has a derived covenant head");
    }
    return;
  }
  if (
    head === null ||
    !sameOutpoint(head.outpoint, channel.activeOutpoint) ||
    !sameHex(head.scriptPublicKey, channel.activeScriptPublicKey) ||
    head.value !== channel.fundingAmount ||
    head.claimedCumulativeAmount !== channel.claimedCumulativeAmount
  ) {
    throw new Error("channel head does not match its derived covenant lineage index");
  }
}

function sameManifest(
  left: CovenantLaunchManifest,
  right: CovenantLaunchManifest,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameLineage(
  left: CovenantLineageState,
  right: CovenantLineageState,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function journalHasPrefix(
  next: CovenantLineageState,
  current: CovenantLineageState,
): boolean {
  return (
    next.journal.length >= current.journal.length &&
    current.journal.every(
      (event, index) => JSON.stringify(event) === JSON.stringify(next.journal[index]),
    )
  );
}
