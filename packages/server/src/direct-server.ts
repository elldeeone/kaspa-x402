import {
  X402_VERSION,
  bytesToHex,
  channelId,
  concatBytes,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  formatSompiString,
  hexToBytes,
  le32,
  le64,
  parseSompiString,
  sha256,
  sha256Hex,
  stableStringify,
  validatePaymentRetry,
  voucherDigest,
  voucherPreimageHex,
  type BatchPaymentRequirements,
  type ChannelConfig,
  type DepositVoucherPayload,
  type FundingOutpoint,
  type Hash32Hex,
  type PaymentPayload,
  type PaymentRequired,
  type ResourceInfo,
  type SettlementResponse,
  type SompiString,
  type Voucher,
  type VoucherPayload,
} from "@kaspa-x402/core";
import { KaspaX402Error } from "@kaspa-x402/core";
import { deriveEscrowAddress, escrowScriptPublicKey, serializedScriptPublicKey } from "@kaspa-x402/covenant";
import { activeChargedAmount, MemoryChannelLockManager } from "./stores.js";
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  type BatchCommitmentRecord,
  type BuildPaymentRequiredOptions,
  type ChainUtxo,
  type ClaimExecutionResult,
  type ClaimAttemptRecord,
  type ClaimPreview,
  type ClaimRecoveryInput,
  type DirectModeServerConfig,
  type HandlerContext,
  type PaidRequest,
  type ProtectedHandler,
  type ProtectedHandlerResult,
  type ServerChannelRecord,
  type ServerResponse,
  type SettlementFinality,
  type VerifiedPayment,
} from "./types.js";

type ResolvedServerConfig = DirectModeServerConfig &
  Required<Pick<DirectModeServerConfig, "asset" | "templateId" | "maxTimeoutSeconds" | "acceptedFinality" | "lockManager">>;

type PendingSettlement = {
  channel: ServerChannelRecord;
  settlement: SettlementResponse;
  commitment: Omit<BatchCommitmentRecord, "response">;
};

export class DirectModeServer {
  readonly #config: ResolvedServerConfig;

  constructor(config: DirectModeServerConfig) {
    this.#config = {
      asset: "KAS",
      templateId: "kaspa-x402-escrow-v1",
      maxTimeoutSeconds: 60,
      acceptedFinality: "accepted",
      lockManager: new MemoryChannelLockManager(),
      ...config,
    };
  }

  buildPaymentRequired(options: BuildPaymentRequiredOptions): PaymentRequired {
    return makePaymentRequired(this.#config, options);
  }

  paymentRequiredResponse(options: BuildPaymentRequiredOptions, status = 402): ServerResponse {
    return {
      status,
      headers: {
        [PAYMENT_REQUIRED_HEADER]: encodePaymentRequiredHeader(this.buildPaymentRequired(options)),
      },
    };
  }

  async extractPayment(header: string): Promise<PaymentPayload> {
    return decodePaymentSignatureHeader(header);
  }

  async handlePaidRequest(request: PaidRequest, handler: ProtectedHandler): Promise<ServerResponse> {
    const resource = request.resource ?? { url: request.url };
    const paymentAmount = request.paymentAmount;
    const paymentHeader = readHeader(request.headers, PAYMENT_SIGNATURE_HEADER);
    if (!paymentHeader) {
      return this.paymentRequiredResponse({ resource, amount: paymentAmount });
    }

    let paymentPayload: PaymentPayload;
    try {
      paymentPayload = await this.extractPayment(paymentHeader);
    } catch {
      return this.paymentRequiredResponse({ resource, amount: paymentAmount });
    }

    const channelId = safePaymentChannelId(paymentPayload);
    if (!channelId) {
      return this.paymentRequiredResponse({ resource, amount: paymentAmount });
    }
    const paymentIdentifier = readPaymentIdentifier(paymentPayload);
    if (this.#config.requirePaymentIdentifier && !paymentIdentifier) {
      return this.paymentRequiredResponse({ resource, amount: paymentAmount });
    }

    const lockManager = this.#config.lockManager ?? new MemoryChannelLockManager();
    const run = async () =>
      lockManager.runExclusive(channelId, async () => {
      const fingerprint = request.requestHash ?? fingerprintRequest(request);
      const cached = await this.#checkIdempotency(paymentIdentifier, fingerprint, channelId, paymentPayload);
      if (cached) return cached;

      let verified: VerifiedPayment;
      try {
        verified = await this.#verifyPayment(paymentPayload, resource, paymentAmount);
      } catch (error) {
        return this.#correctiveResponse(resource, paymentPayload, error, paymentAmount);
      }

      let handlerResult: ProtectedHandlerResult;
      try {
        handlerResult = await handler({
          request,
          payment: verified,
          requestFingerprint: fingerprint,
          paymentIdentifier,
        });
      } catch {
        await this.#preserveLiveDepositTransition(verified);
        return {
          status: 500,
          headers: {},
        };
      }

      let chargedAmount: SompiString;
      try {
        chargedAmount = handlerResult.chargedAmount ?? verified.accepted.amount;
        if (parseSompiString(chargedAmount) > parseSompiString(verified.accepted.amount)) {
          throw new KaspaX402Error("invalid_kaspa_settlement_response", "handler charge exceeds accepted amount");
        }
      } catch (error) {
        await this.#preserveLiveDepositTransition(verified);
        return this.#correctiveResponse(resource, paymentPayload, error, paymentAmount);
      }

      let pending: PendingSettlement;
      try {
        pending = this.#buildSuccessfulSettlement(verified, chargedAmount, fingerprint, paymentIdentifier);
      } catch (error) {
        await this.#preserveLiveDepositTransition(verified);
        return this.#correctiveResponse(resource, paymentPayload, error, paymentAmount);
      }
      const { channel, settlement } = pending;
      const response: ServerResponse = {
        status: handlerResult.status ?? 200,
        headers: {
          ...(handlerResult.headers ?? {}),
          [PAYMENT_RESPONSE_HEADER]: encodePaymentResponseHeader(settlement),
        },
        body: handlerResult.body,
      };
      try {
        await this.#config.store.commitSettlement({
          channel,
          commitment: { ...pending.commitment, response },
          ...(paymentIdentifier
            ? {
                paymentIdentifier: {
                  id: paymentIdentifier,
                  fingerprint,
                  paymentPayloadHash: paymentPayloadHash(paymentPayload),
                  response,
                  settlement,
                  channelId: channel.channelId,
                },
              }
            : {}),
          expected: expectedSettlementChannelState(verified.commitExpectedChannel),
        });
      } catch {
        return {
          status: 500,
          headers: {},
        };
      }
      return response;
    });

    return paymentIdentifier ? lockManager.runExclusive(idempotencyLockKey(paymentIdentifier), run) : run();
  }

  async listClaimableChannels(): Promise<ServerChannelRecord[]> {
    const channels = await this.#config.store.listChannels();
    return channels.filter((channel) => channel.status === "active" && activeChargedAmount(channel) > 0n);
  }

  async previewClaim(channelId: Hash32Hex): Promise<ClaimPreview> {
    const channel = await this.#requireChannel(channelId);
    if (channel.status !== "active") {
      throw new KaspaX402Error("invalid_kaspa_channel_id", "channel is not active");
    }
    const claimAmount = formatSompiString(activeChargedAmount(channel));
    const estimatedFee = await this.#config.chainProvider.estimateClaimFee(channel);
    const claim = parseSompiString(claimAmount);
    const signed = parseSompiString(channel.signedMaxClaimable);
    const fee = parseSompiString(estimatedFee);
    const reason =
      claim === 0n
        ? "channel has no active charge"
        : !channel.voucherSignature
          ? "channel has no signed voucher"
          : signed < claim
            ? "signed ceiling cannot cover active charge"
            : claim <= fee
              ? "claim amount does not exceed estimated fee"
              : undefined;
    return {
      channel,
      claimAmount,
      estimatedFee,
      claimable: reason === undefined,
      ...(reason ? { reason } : {}),
    };
  }

  async executeClaim(channelId: Hash32Hex): Promise<ClaimExecutionResult> {
    return this.#config.lockManager.runExclusive(channelId, async () => {
      if (!this.#config.claimBuilder) {
        throw new KaspaX402Error("invalid_kaspa_transaction", "claim transaction builder is required");
      }
      const preview = await this.previewClaim(channelId);
      const openAttempt = await this.#config.store.loadOpenClaimAttempt(channelId);
      if (openAttempt) {
        throw new KaspaX402Error("invalid_kaspa_transaction", "claim attempt is already pending");
      }
      if (!preview.claimable) {
        throw new KaspaX402Error("invalid_kaspa_x402_amount", preview.reason ?? "claim is not economical");
      }
      const claim = await this.#config.claimBuilder.buildClaimTransaction({
        channel: preview.channel,
        claimAmount: preview.claimAmount,
      });
      if (claim.claimAmount !== preview.claimAmount) {
        throw new KaspaX402Error("invalid_kaspa_transaction", "claim transaction amount does not match preview");
      }
      if (!claim.continuationOutpoint || !claim.continuationScriptPublicKey || !claim.continuationFundingAmount) {
        throw new KaspaX402Error("invalid_kaspa_transaction", "claim transaction must provide continuation channel state");
      }
      const attempt: ClaimAttemptRecord = {
        attemptId: claimAttemptId(preview.channel, claim.transaction, claim.claimAmount),
        channelId: preview.channel.channelId,
        activeOutpoint: preview.channel.activeOutpoint,
        activeScriptPublicKey: preview.channel.activeScriptPublicKey,
        fundingAmount: preview.channel.fundingAmount,
        claimAmount: claim.claimAmount,
        chargedCumulativeAmount: preview.channel.chargedCumulativeAmount,
        claimedCumulativeAmount: preview.channel.claimedCumulativeAmount,
        signedMaxClaimable: preview.channel.signedMaxClaimable,
        ...(preview.channel.voucherSignature ? { voucherSignature: preview.channel.voucherSignature } : {}),
        channelStatus: preview.channel.status,
        transaction: claim.transaction,
        continuationOutpoint: claim.continuationOutpoint,
        continuationScriptPublicKey: claim.continuationScriptPublicKey,
        continuationFundingAmount: claim.continuationFundingAmount,
        status: "pending",
      };
      await this.#config.store.saveClaimAttempt(attempt);
      const broadcast = await this.#config.chainProvider.sendTransaction(claim.transaction);
      const accepted = isAcceptedFinality(broadcast.finality, this.#config.acceptedFinality);
      const broadcastAttempt: ClaimAttemptRecord = {
        ...attempt,
        transactionId: broadcast.transactionId,
        finality: broadcast.finality,
        status: "broadcast",
      };
      await this.#config.store.saveClaimAttempt(broadcastAttempt);
      let resultFinality = broadcast.finality;
      if (accepted) {
        if (claim.continuationOutpoint.txid.toLowerCase() !== broadcast.transactionId.toLowerCase()) {
          throw new KaspaX402Error("invalid_kaspa_outpoint", "continuation outpoint must belong to the accepted claim transaction");
        }
        const continuation = await this.#verifiedFundingUtxo(claim.continuationOutpoint, claim.continuationScriptPublicKey, claim.continuationFundingAmount);
        resultFinality = continuation.finality;
      }
      const updated = accepted
        ? {
            ...preview.channel,
            activeOutpoint: claim.continuationOutpoint,
            activeScriptPublicKey: claim.continuationScriptPublicKey,
            fundingAmount: claim.continuationFundingAmount,
            claimedCumulativeAmount: preview.channel.chargedCumulativeAmount,
            signedMaxClaimable: "0",
            voucherSignature: undefined,
          }
        : preview.channel;
      if (accepted) {
        const acceptedAttempt: ClaimAttemptRecord = {
          ...broadcastAttempt,
          continuationOutpoint: claim.continuationOutpoint,
          continuationScriptPublicKey: claim.continuationScriptPublicKey,
          continuationFundingAmount: claim.continuationFundingAmount,
          finality: resultFinality,
          status: "accepted",
        };
        await this.#config.store.saveClaimAttempt(acceptedAttempt);
        await this.#config.store.applyClaimAttempt(updated, acceptedAttempt);
      }
      return {
        channel: updated,
        transactionId: broadcast.transactionId,
        finality: resultFinality,
        accepted,
      };
    });
  }

  async abandonClaimAttempt(channelId: Hash32Hex, reason?: string): Promise<void> {
    await this.#config.lockManager.runExclusive(channelId, async () => {
      const attempt = await this.#config.store.loadOpenClaimAttempt(channelId);
      if (!attempt) return;
      if (attempt.status === "accepted") {
        throw new KaspaX402Error("invalid_kaspa_transaction", "accepted claim attempts must be recovered, not abandoned");
      }
      await this.#config.store.abandonClaimAttempt(attempt.attemptId, reason);
    });
  }

  async recoverAcceptedClaim(channelId: Hash32Hex, input: ClaimRecoveryInput = {}): Promise<ClaimExecutionResult> {
    return this.#config.lockManager.runExclusive(channelId, async () => {
      const attempt = await this.#config.store.loadOpenClaimAttempt(channelId);
      if (!attempt || (attempt.status !== "accepted" && attempt.status !== "broadcast" && attempt.status !== "pending") || (!attempt.transactionId && !input.transactionId)) {
        throw new KaspaX402Error("invalid_kaspa_transaction", "accepted claim attempt was not found");
      }
      if (attempt.transactionId && input.transactionId && attempt.transactionId.toLowerCase() !== input.transactionId.toLowerCase()) {
        throw new KaspaX402Error("invalid_kaspa_transaction", "claim recovery transaction id does not match recorded broadcast");
      }
      const transactionId = attempt.transactionId ?? input.transactionId;
      const inputFinality = (input as { finality?: SettlementFinality }).finality;
      if (inputFinality === "broadcast") {
        throw new KaspaX402Error("invalid_kaspa_transaction", "accepted claim recovery needs accepted transaction evidence");
      }
      const evidenceFinality = inputFinality ?? (attempt.finality === "broadcast" ? undefined : attempt.finality);
      if (!transactionId || !evidenceFinality) {
        throw new KaspaX402Error("invalid_kaspa_transaction", "accepted claim recovery needs accepted transaction evidence");
      }
      if (!attempt.continuationOutpoint || !attempt.continuationScriptPublicKey || !attempt.continuationFundingAmount) {
        throw new KaspaX402Error("invalid_kaspa_transaction", "accepted claim attempt is missing continuation state");
      }
      if (attempt.continuationOutpoint.txid.toLowerCase() !== transactionId.toLowerCase()) {
        throw new KaspaX402Error("invalid_kaspa_outpoint", "continuation outpoint must belong to the accepted claim transaction");
      }
      const channel = await this.#requireChannel(channelId);
      if (!sameActiveOutpoint(channel, attempt.activeOutpoint, attempt.activeScriptPublicKey)) {
        throw new KaspaX402Error("invalid_kaspa_outpoint", "claim attempt does not match active channel");
      }
      if (
        channel.chargedCumulativeAmount !== attempt.chargedCumulativeAmount ||
        channel.claimedCumulativeAmount !== attempt.claimedCumulativeAmount
      ) {
        throw new KaspaX402Error("invalid_kaspa_settlement_response", "channel state changed after claim attempt");
      }
      const continuation = await this.#verifiedFundingUtxo(attempt.continuationOutpoint, attempt.continuationScriptPublicKey, attempt.continuationFundingAmount);
      const updated = {
        ...channel,
        activeOutpoint: attempt.continuationOutpoint,
        activeScriptPublicKey: attempt.continuationScriptPublicKey,
        fundingAmount: attempt.continuationFundingAmount,
        claimedCumulativeAmount: formatSompiString(parseSompiString(attempt.claimedCumulativeAmount) + parseSompiString(attempt.claimAmount)),
        signedMaxClaimable: "0",
        voucherSignature: undefined,
      };
      validateChannelAccounting(updated);
      await this.#config.store.applyClaimAttempt(updated, {
        ...attempt,
        transactionId,
        finality: continuation.finality,
        status: "accepted",
      });
      return {
        channel: updated,
        transactionId,
        finality: continuation.finality,
        accepted: true,
      };
    });
  }

  async #verifyPayment(paymentPayload: PaymentPayload, resource: ResourceInfo, paymentAmount?: SompiString): Promise<VerifiedPayment> {
    const paymentRequired = await this.#expectedPaymentRequired(resource, paymentPayload, paymentAmount);
    const retry = validatePaymentRetry({ paymentRequired, paymentPayload });
    if (!retry.ok) throw retry.error;

    if (paymentPayload.accepted.scheme !== "batch-settlement") {
      throw new KaspaX402Error("invalid_kaspa_x402_scheme", "server only supports batch-settlement in direct mode");
    }

    const accepted = paymentPayload.accepted as BatchPaymentRequirements;
    const payload = paymentPayload.payload;
    if (payload.type === "deposit-voucher") {
      return this.#verifyDepositVoucher(paymentRequired, paymentPayload, accepted, payload);
    }
    if (payload.type === "voucher") {
      return this.#verifyVoucher(paymentRequired, paymentPayload, accepted, payload);
    }
    throw new KaspaX402Error("invalid_kaspa_payment_payload_type", "unsupported server payment payload type");
  }

  async #verifyDepositVoucher(
    paymentRequired: ReturnType<typeof makePaymentRequired>,
    paymentPayload: PaymentPayload,
    accepted: BatchPaymentRequirements,
    payload: DepositVoucherPayload,
  ): Promise<VerifiedPayment> {
    validateChannelTerms(this.#config, accepted, payload.channelConfig);
    if (channelId(payload.channelConfig) !== payload.channelId) {
      throw new KaspaX402Error("invalid_kaspa_channel_id", "channel id does not match channel config");
    }
    const derived = deriveServerEscrow(this.#config, payload.channelConfig);
    if (derived.escrowAddress !== payload.escrowAddress) {
      throw new KaspaX402Error("invalid_kaspa_x402_binding", "escrow address does not match channel config");
    }
    if (derived.activeScriptPublicKey.toLowerCase() !== payload.activeScriptPublicKey.toLowerCase()) {
      throw new KaspaX402Error("invalid_kaspa_x402_binding", "active script does not match channel config");
    }
    if (parseSompiString(payload.fundingAmountSompi) < parseSompiString(accepted.extra.minDepositSompi)) {
      throw new KaspaX402Error("invalid_kaspa_x402_amount", "deposit is below the required minimum");
    }

    const utxo = await this.#verifiedFundingUtxo(payload.fundingOutpoint, payload.activeScriptPublicKey, payload.fundingAmountSompi);
    const existing = await this.#config.store.loadChannel(payload.channelId);
    if (existing && existing.status !== "active") {
      throw new KaspaX402Error("invalid_kaspa_channel_id", "existing channel is not active");
    }
    if (existing) await this.#rejectOpenClaimAttempt(existing.channelId);
    const initial: ServerChannelRecord = {
      channelId: payload.channelId,
      channelConfig: payload.channelConfig,
      escrowAddress: payload.escrowAddress,
      activeOutpoint: payload.fundingOutpoint,
      activeScriptPublicKey: payload.activeScriptPublicKey,
      fundingAmount: utxo.amount,
      chargedCumulativeAmount: existing?.chargedCumulativeAmount ?? "0",
      claimedCumulativeAmount: existing?.claimedCumulativeAmount ?? "0",
      signedMaxClaimable: existing && sameActiveOutpoint(existing, payload.fundingOutpoint, payload.activeScriptPublicKey) ? existing.signedMaxClaimable : "0",
      voucherSignature: existing && sameActiveOutpoint(existing, payload.fundingOutpoint, payload.activeScriptPublicKey) ? existing.voucherSignature : undefined,
      lastCommitmentId: existing?.lastCommitmentId,
      status: "active",
    };

    if (existing && !sameActiveOutpoint(existing, payload.fundingOutpoint, payload.activeScriptPublicKey)) {
      if (!this.#config.topUpVerifier) {
        throw new KaspaX402Error("invalid_kaspa_outpoint", "top-up transition verifier is required");
      }
      const verified = await this.#config.topUpVerifier.verifyTopUp({
        previous: existing,
        next: initial,
        utxo,
        payment: paymentPayload,
      });
      if (!verified) throw new KaspaX402Error("invalid_kaspa_outpoint", "top-up transition was rejected");
    }

    await this.#verifyVoucherAmountAndSignature(initial, accepted, payload.voucher);
    return {
      paymentRequired,
      paymentPayload,
      accepted,
      channel: initial,
      commitExpectedChannel: existing ?? initial,
      voucher: payload.voucher,
      openedChannel: !existing,
    };
  }

  async #verifyVoucher(
    paymentRequired: ReturnType<typeof makePaymentRequired>,
    paymentPayload: PaymentPayload,
    accepted: BatchPaymentRequirements,
    payload: VoucherPayload,
  ): Promise<VerifiedPayment> {
    const channel = await this.#requireChannel(payload.channelId);
    validateChannelTerms(this.#config, accepted, channel.channelConfig);
    if (channel.status !== "active") {
      throw new KaspaX402Error("invalid_kaspa_channel_id", "channel is not active");
    }
    await this.#rejectOpenClaimAttempt(channel.channelId);
    if (payload.clientPublicKey !== channel.channelConfig.clientPublicKey) {
      throw new KaspaX402Error("invalid_kaspa_public_key", "client public key does not match channel");
    }
    if (!sameActiveOutpoint(channel, payload.fundingOutpoint, payload.activeScriptPublicKey)) {
      throw new KaspaX402Error("invalid_kaspa_outpoint", "payment outpoint does not match active channel");
    }
    await this.#verifiedFundingUtxo(payload.fundingOutpoint, payload.activeScriptPublicKey, channel.fundingAmount);
    await this.#verifyVoucherAmountAndSignature(channel, accepted, payload.voucher);
    return {
      paymentRequired,
      paymentPayload,
      accepted,
      channel,
      commitExpectedChannel: channel,
      voucher: payload.voucher,
      openedChannel: false,
    };
  }

  async #verifyVoucherAmountAndSignature(channel: ServerChannelRecord, accepted: BatchPaymentRequirements, voucher: Voucher): Promise<void> {
    validateChannelPreVoucherAccounting(channel);
    const requiredVoucherAmount = maxAmount(channel.signedMaxClaimable, formatSompiString(activeChargedAmount(channel) + parseSompiString(accepted.amount)));
    if (voucher.amount !== requiredVoucherAmount) {
      throw new KaspaX402Error("invalid_kaspa_x402_amount", "voucher amount does not match required cumulative amount");
    }
    if (parseSompiString(voucher.amount) > parseSompiString(channel.fundingAmount)) {
      throw new KaspaX402Error("invalid_kaspa_x402_amount", "voucher amount exceeds active funding amount");
    }
    const reserve = await this.#minimumActiveReserve(channel);
    if (parseSompiString(voucher.amount) + reserve > parseSompiString(channel.fundingAmount)) {
      throw new KaspaX402Error("invalid_kaspa_x402_amount", "voucher amount does not leave required claim reserve");
    }
    validateChannelAccounting({ ...channel, signedMaxClaimable: voucher.amount, voucherSignature: voucher.signature });
    const input = {
      network: channel.channelConfig.network,
      activeScriptPublicKey: channel.activeScriptPublicKey,
      outpoint: channel.activeOutpoint,
      amount: voucher.amount,
    };
    const verified = await this.#config.voucherVerifier.verifyVoucher({
      channelId: channel.channelId,
      clientPublicKey: channel.channelConfig.clientPublicKey,
      digest: voucherDigest(input),
      preimage: voucherPreimageHex(input),
      voucher,
    });
    if (!verified) throw new KaspaX402Error("invalid_kaspa_signature", "voucher signature was rejected");
  }

  async #minimumActiveReserve(channel: ServerChannelRecord): Promise<bigint> {
    return parseSompiString(await this.#config.chainProvider.estimateClaimFee(channel));
  }

  async #rejectOpenClaimAttempt(channelId: Hash32Hex): Promise<void> {
    const openAttempt = await this.#config.store.loadOpenClaimAttempt(channelId);
    if (openAttempt) {
      throw new KaspaX402Error("invalid_kaspa_transaction", "channel has an open claim attempt");
    }
  }

  async #verifiedFundingUtxo(outpoint: FundingOutpoint, activeScriptPublicKey: string, fundingAmount: SompiString): Promise<ChainUtxo> {
    const utxo = await this.#config.chainProvider.getUtxo(outpoint, this.#config.network);
    if (!utxo) throw new KaspaX402Error("invalid_kaspa_outpoint", "funding outpoint was not found");
    if (!isAcceptedFinality(utxo.finality, this.#config.acceptedFinality)) {
      throw new KaspaX402Error("invalid_kaspa_transaction", "funding outpoint has not reached required finality");
    }
    if (utxo.scriptPublicKey.toLowerCase() !== activeScriptPublicKey.toLowerCase()) {
      throw new KaspaX402Error("invalid_kaspa_x402_binding", "funding script does not match active script");
    }
    if (utxo.amount !== fundingAmount) {
      throw new KaspaX402Error("invalid_kaspa_x402_amount", "funding amount does not match payment payload");
    }
    return utxo;
  }

  async #preserveLiveDepositTransition(verified: VerifiedPayment): Promise<void> {
    if (verified.paymentPayload.payload.type !== "deposit-voucher") return;
    const channel: ServerChannelRecord = {
      ...verified.channel,
      signedMaxClaimable: verified.voucher.amount,
      voucherSignature: verified.voucher.signature,
      status: "active",
    };
    validateChannelAccounting(channel);
    await this.#config.store.saveChannel(channel);
  }

  #buildSuccessfulSettlement(
    verified: VerifiedPayment,
    chargedAmount: SompiString,
    fingerprint: Hash32Hex,
    paymentIdentifier?: string,
  ): PendingSettlement {
    const chargedCumulativeAmount = formatSompiString(parseSompiString(verified.channel.chargedCumulativeAmount) + parseSompiString(chargedAmount));
    const commitmentId = batchCommitmentId({
      accepted: verified.accepted,
      channel: verified.channel,
      requestFingerprint: fingerprint,
      voucher: verified.voucher,
      chargedAmount,
      chargedCumulativeAfter: chargedCumulativeAmount,
    });
    const channel: ServerChannelRecord = {
      ...verified.channel,
      chargedCumulativeAmount,
      signedMaxClaimable: verified.voucher.amount,
      voucherSignature: verified.voucher.signature,
      lastCommitmentId: commitmentId,
      status: "active",
    };
    validateChannelAccounting(channel);
    const settlement: SettlementResponse = {
      success: true,
      transaction: verified.paymentPayload.payload.type === "deposit-voucher" ? verified.channel.activeOutpoint.txid : "",
      network: this.#config.network,
      payer: verified.channel.channelConfig.refundAddress,
      extra: {
        commitmentId,
        ...(verified.paymentPayload.payload.type === "deposit-voucher" ? { fundingAmount: channel.fundingAmount } : {}),
        chargedAmount,
        channelState: channelState(channel),
      },
    };
    return {
      channel,
      settlement,
      commitment: {
        commitmentId,
        channelId: channel.channelId,
        requestFingerprint: fingerprint,
        paymentRequirementsHash: bytesToHex(batchPaymentRequirementsHash(verified.accepted)),
        activeOutpoint: channel.activeOutpoint,
        activeScriptPublicKey: channel.activeScriptPublicKey,
        voucher: verified.voucher,
        chargedAmount,
        chargedCumulativeBefore: verified.channel.chargedCumulativeAmount,
        chargedCumulativeAfter: chargedCumulativeAmount,
        claimedCumulativeAmount: channel.claimedCumulativeAmount,
        ...(paymentIdentifier ? { paymentIdentifier } : {}),
        settlement,
      },
    };
  }

  async #checkIdempotency(
    paymentIdentifier: string | undefined,
    fingerprint: Hash32Hex,
    channelId: Hash32Hex,
    paymentPayload: PaymentPayload,
  ): Promise<ServerResponse | undefined> {
    if (!paymentIdentifier) return undefined;
    const record = await this.#config.store.loadPaymentIdentifier(paymentIdentifier);
    if (!record) return undefined;
    if (record.fingerprint !== fingerprint || record.channelId !== channelId) {
      return {
        status: 409,
        headers: {},
        body: {
          error: "payment_identifier_conflict",
        },
      };
    }
    if (record.paymentPayloadHash !== paymentPayloadHash(paymentPayload)) {
      return {
        status: 409,
        headers: {},
        body: {
          error: "payment_identifier_conflict",
        },
      };
    }
    return record.response;
  }

  async #correctiveResponse(resource: ResourceInfo, paymentPayload: PaymentPayload, error: unknown, paymentAmount?: SompiString): Promise<ServerResponse> {
    const channelId = safePaymentChannelId(paymentPayload);
    const channel = channelId ? await this.#config.store.loadChannel(channelId) : undefined;
    const activeChannel = channel?.status === "active" ? channel : undefined;
    return {
      ...this.paymentRequiredResponse({
        resource,
        amount: paymentAmount,
        ...(activeChannel ? { channel: activeChannel, voucherState: latestVoucher(activeChannel) } : {}),
      }),
      body: {
        error: error instanceof KaspaX402Error ? error.code : "invalid_kaspa_x402_payload",
      },
    };
  }

  async #requireChannel(channelId: Hash32Hex): Promise<ServerChannelRecord> {
    const channel = await this.#config.store.loadChannel(channelId);
    if (!channel) throw new KaspaX402Error("invalid_kaspa_channel_id", "channel not found");
    return channel;
  }

  async #expectedPaymentRequired(resource: ResourceInfo, paymentPayload: PaymentPayload, paymentAmount?: SompiString): Promise<PaymentRequired> {
    const payloadChannelId = safePaymentChannelId(paymentPayload);
    const accepted = paymentPayload.accepted;
    if (accepted.scheme !== "batch-settlement" || !payloadChannelId) {
      return this.buildPaymentRequired({ resource, amount: paymentAmount });
    }
    const channel = await this.#config.store.loadChannel(payloadChannelId);
    const acceptedExtra = accepted.extra;
    if (!channel || channel.status !== "active" || (!acceptedExtra.channelState && !acceptedExtra.voucherState)) {
      return this.buildPaymentRequired({ resource, amount: paymentAmount });
    }
    return this.buildPaymentRequired({
      resource,
      amount: paymentAmount,
      channel,
      voucherState: latestVoucher(channel),
    });
  }
}

function makePaymentRequired(config: ResolvedServerConfig, options: BuildPaymentRequiredOptions): PaymentRequired {
  const accepted: BatchPaymentRequirements = {
    scheme: "batch-settlement",
    network: config.network,
    amount: options.amount ?? config.amount,
    asset: "KAS",
    payTo: config.payTo,
    maxTimeoutSeconds: config.maxTimeoutSeconds,
    extra: {
      binding: "kaspa-escrow-v1",
      templateId: config.templateId,
      serverPublicKey: config.serverPublicKey,
      minDepositSompi: config.minDepositSompi,
      refundTimeoutDaa: config.refundTimeoutDaa,
      ...(config.claimPolicy ? { claimPolicy: config.claimPolicy } : {}),
      ...(options.channel ? { channelState: channelState(options.channel) } : {}),
      ...(options.voucherState ? { voucherState: options.voucherState } : {}),
    },
  };
  return {
    x402Version: X402_VERSION,
    resource: options.resource,
    accepts: [accepted],
    ...(config.requirePaymentIdentifier
      ? {
          extensions: {
            "payment-identifier": {
              info: {
                required: true,
              },
            },
          },
        }
      : {}),
  };
}

function validateChannelTerms(config: ResolvedServerConfig, accepted: BatchPaymentRequirements, channelConfig: ChannelConfig): void {
  if (accepted.network !== config.network || channelConfig.network !== config.network) {
    throw new KaspaX402Error("invalid_kaspa_x402_network", "payment network does not match server config");
  }
  if (accepted.asset !== "KAS" || channelConfig.asset !== "KAS") {
    throw new KaspaX402Error("invalid_kaspa_x402_asset", "payment asset does not match server config");
  }
  if (accepted.payTo !== config.payTo || channelConfig.payTo !== config.payTo) {
    throw new KaspaX402Error("invalid_kaspa_x402_payload", "payTo does not match server config");
  }
  if (accepted.extra.serverPublicKey !== config.serverPublicKey || channelConfig.serverPublicKey !== config.serverPublicKey) {
    throw new KaspaX402Error("invalid_kaspa_public_key", "server public key does not match server config");
  }
  if (accepted.extra.templateId !== config.templateId || channelConfig.templateId !== config.templateId) {
    throw new KaspaX402Error("invalid_kaspa_x402_binding", "template id does not match server config");
  }
  if (accepted.extra.refundTimeoutDaa !== config.refundTimeoutDaa || channelConfig.refundTimeoutDaa !== config.refundTimeoutDaa) {
    throw new KaspaX402Error("invalid_kaspa_x402_payload", "refund timeout does not match server config");
  }
}

function deriveServerEscrow(config: ResolvedServerConfig, channelConfig: ChannelConfig): { escrowAddress: string; activeScriptPublicKey: string } {
  const payoutScriptPublicKeyHash = scriptPublicKeyHash(config.addressCodec.scriptPublicKeyForAddress(channelConfig.payTo, channelConfig.network));
  const refundScriptPublicKeyHash = scriptPublicKeyHash(config.addressCodec.scriptPublicKeyForAddress(channelConfig.refundAddress, channelConfig.network));
  const params = {
    clientPublicKey: channelConfig.clientPublicKey,
    serverPublicKey: channelConfig.serverPublicKey,
    network: channelConfig.network,
    payoutScriptPublicKeyHash,
    refundScriptPublicKeyHash,
    timeoutDaa: channelConfig.refundTimeoutDaa,
  };
  const scriptPublicKey = escrowScriptPublicKey(params);
  return {
    escrowAddress: deriveEscrowAddress(params, (input) => config.addressCodec.encodeScriptAddress(input)),
    activeScriptPublicKey: serializedScriptPublicKey(scriptPublicKey),
  };
}

function channelState(channel: ServerChannelRecord) {
  return {
    channelId: channel.channelId,
    activeOutpoint: channel.activeOutpoint,
    activeScriptPublicKey: channel.activeScriptPublicKey,
    fundingAmount: channel.fundingAmount,
    chargedCumulativeAmount: channel.chargedCumulativeAmount,
    claimedCumulativeAmount: channel.claimedCumulativeAmount,
    signedMaxClaimable: channel.signedMaxClaimable,
  };
}

function expectedSettlementChannelState(channel: ServerChannelRecord) {
  return {
    channelId: channel.channelId,
    chargedCumulativeAmount: channel.chargedCumulativeAmount,
    claimedCumulativeAmount: channel.claimedCumulativeAmount,
    signedMaxClaimable: channel.signedMaxClaimable,
    activeOutpoint: channel.activeOutpoint,
    activeScriptPublicKey: channel.activeScriptPublicKey,
    status: channel.status,
  };
}

function validateChannelAccounting(channel: ServerChannelRecord): void {
  validateChannelPreVoucherAccounting(channel);
  const active = parseSompiString(channel.chargedCumulativeAmount) - parseSompiString(channel.claimedCumulativeAmount);
  const funding = parseSompiString(channel.fundingAmount);
  const signed = parseSompiString(channel.signedMaxClaimable);
  if (active > signed) throw new KaspaX402Error("invalid_kaspa_settlement_response", "active charged amount cannot exceed signed ceiling");
  if (signed > funding) throw new KaspaX402Error("invalid_kaspa_settlement_response", "signed ceiling cannot exceed funding amount");
}

function validateChannelPreVoucherAccounting(channel: ServerChannelRecord): void {
  const charged = parseSompiString(channel.chargedCumulativeAmount);
  const claimed = parseSompiString(channel.claimedCumulativeAmount);
  const active = charged - claimed;
  const funding = parseSompiString(channel.fundingAmount);
  if (claimed > charged) throw new KaspaX402Error("invalid_kaspa_settlement_response", "claimed amount cannot exceed charged amount");
  if (active > funding) throw new KaspaX402Error("invalid_kaspa_settlement_response", "active charged amount cannot exceed funding amount");
}

function safePaymentChannelId(paymentPayload: PaymentPayload): Hash32Hex | undefined {
  const payload = paymentPayload.payload;
  if ("channelId" in payload && typeof payload.channelId === "string") return payload.channelId;
  return undefined;
}

function readHeader(headers: PaidRequest["headers"], name: string): string | undefined {
  if (!headers) return undefined;
  if ("get" in headers && typeof headers.get === "function") return headers.get(name) ?? headers.get(name.toLowerCase()) ?? undefined;
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found?.[1];
}

function readPaymentIdentifier(paymentPayload: PaymentPayload): string | undefined {
  const paymentIdentifier = paymentPayload.extensions?.["payment-identifier"];
  if (!isRecord(paymentIdentifier)) return undefined;
  const info = paymentIdentifier.info;
  if (!isRecord(info)) return undefined;
  return typeof info.id === "string" ? info.id : undefined;
}

function fingerprintRequest(request: PaidRequest): Hash32Hex {
  return sha256Hex(
    stableStringify({
      method: request.method ?? "GET",
      url: request.url,
      body: request.body ?? null,
    }),
  );
}

function paymentPayloadHash(paymentPayload: PaymentPayload): Hash32Hex {
  return sha256Hex(stableStringify(paymentPayload));
}

function idempotencyLockKey(paymentIdentifier: string): Hash32Hex {
  return sha256Hex(`kaspa:x402:payment-identifier-lock:${paymentIdentifier}`);
}

function latestVoucher(channel: ServerChannelRecord): Voucher | undefined {
  return channel.voucherSignature ? { amount: channel.signedMaxClaimable, signature: channel.voucherSignature } : undefined;
}

function claimAttemptId(channel: ServerChannelRecord, transaction: string, claimAmount: SompiString): Hash32Hex {
  return sha256Hex(
    stableStringify({
      channelId: channel.channelId,
      activeOutpoint: channel.activeOutpoint,
      activeScriptPublicKey: channel.activeScriptPublicKey,
      claimAmount,
      transaction,
    }),
  );
}

function maxAmount(a: SompiString, b: SompiString): SompiString {
  return parseSompiString(a) >= parseSompiString(b) ? a : b;
}

function sameActiveOutpoint(channel: ServerChannelRecord, outpoint: FundingOutpoint, activeScriptPublicKey: string): boolean {
  return (
    channel.activeOutpoint.txid.toLowerCase() === outpoint.txid.toLowerCase() &&
    channel.activeOutpoint.index === outpoint.index &&
    channel.activeScriptPublicKey.toLowerCase() === activeScriptPublicKey.toLowerCase()
  );
}

function scriptPublicKeyHash(scriptPublicKey: string): string {
  return sha256Hex(hexToBytes(scriptPublicKey));
}

function batchCommitmentId(input: {
  accepted: BatchPaymentRequirements;
  channel: ServerChannelRecord;
  requestFingerprint: Hash32Hex;
  voucher: Voucher;
  chargedAmount: SompiString;
  chargedCumulativeAfter: SompiString;
}): Hash32Hex {
  return bytesToHex(
    sha256(
      concatBytes([
        sha256("kaspa:x402:batch-commitment:v1"),
        hexToBytes(input.channel.channelId, { expectedLength: 32, label: "channelId" }),
        hexToBytes(input.requestFingerprint, { expectedLength: 32, label: "requestFingerprint" }),
        batchPaymentRequirementsHash(input.accepted),
        hexToBytes(input.channel.activeOutpoint.txid, { expectedLength: 32, label: "activeOutpoint.txid" }),
        le32(input.channel.activeOutpoint.index),
        le64(input.voucher.amount),
        sha256(hexToBytes(input.voucher.signature, { expectedLength: 64, label: "voucher.signature" })),
        le64(input.chargedAmount),
        le64(input.channel.chargedCumulativeAmount),
        le64(input.chargedCumulativeAfter),
        le64(input.channel.claimedCumulativeAmount),
      ]),
    ),
  );
}

function batchPaymentRequirementsHash(accepted: BatchPaymentRequirements): Uint8Array {
  return sha256(
    concatBytes([
      sha256("kaspa:x402:batch-payment-requirements:v1"),
      sha256("batch-settlement"),
      sha256(accepted.network),
      sha256("KAS"),
      le64(accepted.amount),
      sha256(accepted.payTo),
      le64(accepted.maxTimeoutSeconds),
      sha256("kaspa-escrow-v1"),
      sha256(accepted.extra.templateId),
      hexToBytes(accepted.extra.serverPublicKey, { expectedLength: 32, label: "serverPublicKey" }),
      le64(accepted.extra.minDepositSompi),
      le64(accepted.extra.refundTimeoutDaa),
    ]),
  );
}

function isAcceptedFinality(finality: string, required: "accepted" | "confirmed"): boolean {
  return finality === "confirmed" || (required === "accepted" && finality === "accepted");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
