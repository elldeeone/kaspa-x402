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
  uptoAuthorizationDigest,
  uptoAuthorizationPreimageHex,
  validatePaymentRetry,
  voucherDigest,
  voucherPreimageHex,
  type BatchPaymentRequirements,
  type ChannelConfig,
  type DepositVoucherPayload,
  type ExactPaymentRequirements,
  type ExactTransferPayload,
  type FundingOutpoint,
  type Hash32Hex,
  type PaymentPayload,
  type PaymentRequired,
  type ResourceInfo,
  type SettlementResponse,
  type SompiString,
  type UptoAuthorizationPayload,
  type UptoPaymentRequirements,
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
  type ExactPaymentRecord,
  type HandlerContext,
  type PaidRequest,
  type PaymentIdentifierRecord,
  type ProtectedHandler,
  type ProtectedHandlerResult,
  type ServerChannelRecord,
  type ServerResponse,
  type SettlementFinality,
  type TransactionBroadcast,
  type UptoAuthorizationRecord,
  type UptoBroadcastAuthorizationRecord,
  type UptoPendingAuthorizationRecord,
  type UptoSettledAuthorizationRecord,
  type UptoSettlementTransactionVerification,
  type VerifiedBatchPayment,
  type VerifiedExactPayment,
  type VerifiedUptoPayment,
  type VerifiedPayment,
} from "./types.js";

type ResolvedServerConfig = DirectModeServerConfig &
  Required<
    Pick<
      DirectModeServerConfig,
      "asset" | "templateId" | "authorizationTemplateId" | "authorizationTimeoutDaa" | "maxTimeoutSeconds" | "acceptedFinality" | "lockManager"
    >
  >;

type PendingSettlement = {
  channel: ServerChannelRecord;
  settlement: SettlementResponse;
  commitment: Omit<BatchCommitmentRecord, "response">;
};

type PendingExactSettlement = {
  settlement: SettlementResponse;
  payment: Omit<ExactPaymentRecord, "response">;
};

type PendingUptoSettlement = {
  settlement: SettlementResponse;
  authorization: Omit<UptoSettledAuthorizationRecord, "response">;
  transaction?: string;
};

export class DirectModeServer {
  readonly #config: ResolvedServerConfig;

  constructor(config: DirectModeServerConfig) {
    this.#config = {
      asset: "KAS",
      templateId: "kaspa-x402-escrow-v1",
      authorizationTemplateId: "kaspa-x402-upto-v1",
      authorizationTimeoutDaa: config.authorizationTimeoutDaa ?? config.refundTimeoutDaa,
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
      return this.paymentRequiredResponse({ resource, amount: paymentAmount, scheme: request.paymentScheme });
    }

    let paymentPayload: PaymentPayload;
    try {
      paymentPayload = await this.extractPayment(paymentHeader);
    } catch {
      return this.paymentRequiredResponse({ resource, amount: paymentAmount, scheme: request.paymentScheme });
    }
    if (request.paymentScheme && paymentPayload.accepted.scheme !== request.paymentScheme) {
      return this.paymentRequiredResponse({ resource, amount: paymentAmount, scheme: request.paymentScheme });
    }

    const paymentLockKey = safePaymentLockKey(paymentPayload);
    if (!paymentLockKey) {
      return this.paymentRequiredResponse({ resource, amount: paymentAmount, scheme: request.paymentScheme });
    }
    const paymentIdentifier = readPaymentIdentifier(paymentPayload);
    if (this.#config.requirePaymentIdentifier && !paymentIdentifier) {
      return this.paymentRequiredResponse({ resource, amount: paymentAmount, scheme: request.paymentScheme });
    }

    const lockManager = this.#config.lockManager ?? new MemoryChannelLockManager();
    const run = async () =>
      lockManager.runExclusive(paymentLockKey, async () => {
      let fingerprint: Hash32Hex;
      try {
        fingerprint = request.requestHash ?? fingerprintRequest(request);
      } catch {
        return this.paymentRequiredResponse({ resource, amount: paymentAmount, scheme: request.paymentScheme });
      }
      const cached = await this.#checkIdempotency(paymentIdentifier, fingerprint, safePaymentScopeIdHint(paymentPayload), paymentPayload);
      if (cached) return cached;

      let verified: VerifiedPayment;
      try {
        verified = await this.#verifyPayment(paymentPayload, resource, fingerprint, paymentAmount, request.paymentScheme);
      } catch (error) {
        return this.#correctiveResponse(resource, paymentPayload, error, paymentAmount, request.paymentScheme);
      }
      if (verified.scheme === "exact") {
        const replay = await this.#checkExactReplay(verified, fingerprint, paymentPayload);
        if (replay) return replay;
      }
      if (verified.scheme === "upto") {
        const replay = await this.#checkUptoReplay(verified, fingerprint, paymentPayload);
        if (replay) return replay;
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
        if (verified.scheme === "exact" && chargedAmount !== verified.accepted.amount) {
          throw new KaspaX402Error("invalid_kaspa_settlement_response", "exact settlement amount must equal the accepted amount");
        }
      } catch (error) {
        await this.#preserveLiveDepositTransition(verified);
        return this.#correctiveResponse(resource, paymentPayload, error, paymentAmount, request.paymentScheme);
      }

      if (verified.scheme === "exact") {
        return this.#commitExactResponse(verified, handlerResult, chargedAmount, fingerprint, paymentIdentifier);
      }
      if (verified.scheme === "upto") {
        return this.#commitUptoResponse(verified, handlerResult, chargedAmount, fingerprint, paymentIdentifier);
      }
      return this.#commitBatchResponse(verified, handlerResult, chargedAmount, fingerprint, paymentIdentifier);
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

  async #verifyPayment(
    paymentPayload: PaymentPayload,
    resource: ResourceInfo,
    requestFingerprint: Hash32Hex,
    paymentAmount?: SompiString,
    requestedScheme?: "exact" | "upto" | "batch-settlement",
  ): Promise<VerifiedPayment> {
    const paymentRequired = await this.#expectedPaymentRequired(resource, paymentPayload, paymentAmount, requestedScheme);
    const retry = validatePaymentRetry({ paymentRequired, paymentPayload });
    if (!retry.ok) throw retry.error;

    if (paymentPayload.accepted.scheme === "exact") {
      const payload = paymentPayload.payload;
      if (payload.type !== "exact-transfer") {
        throw new KaspaX402Error("invalid_kaspa_payment_payload_type", "unsupported exact payment payload type");
      }
      return this.#verifyExactPayment(
        paymentRequired,
        paymentPayload as PaymentPayload & { accepted: ExactPaymentRequirements; payload: ExactTransferPayload },
        requestFingerprint,
      );
    }

    if (paymentPayload.accepted.scheme === "upto") {
      const payload = paymentPayload.payload;
      if (payload.type !== "upto-authorization") {
        throw new KaspaX402Error("invalid_kaspa_payment_payload_type", "unsupported upto payment payload type");
      }
      return this.#verifyUptoPayment(
        paymentRequired,
        paymentPayload as PaymentPayload & { accepted: UptoPaymentRequirements; payload: UptoAuthorizationPayload },
        requestFingerprint,
      );
    }

    if (paymentPayload.accepted.scheme !== "batch-settlement") {
      throw new KaspaX402Error("invalid_kaspa_x402_scheme", "server only supports exact, upto, and batch-settlement in direct mode");
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

  async #verifyExactPayment(
    paymentRequired: ReturnType<typeof makePaymentRequired>,
    paymentPayload: PaymentPayload & { accepted: ExactPaymentRequirements; payload: ExactTransferPayload },
    requestFingerprint: Hash32Hex,
  ): Promise<VerifiedExactPayment> {
    const accepted = paymentPayload.accepted;
    const payload = paymentPayload.payload;
    validateExactTerms(this.#config, accepted);
    if (payload.requestHash && payload.requestHash.toLowerCase() !== requestFingerprint.toLowerCase()) {
      throw new KaspaX402Error("invalid_kaspa_x402_payload", "exact payload requestHash does not match request fingerprint");
    }
    if (!this.#config.exactTransactionVerifier) {
      throw new KaspaX402Error("invalid_kaspa_transaction", "exact transaction verifier is required");
    }
    const payToScriptPublicKey = this.#config.addressCodec.scriptPublicKeyForAddress(accepted.payTo, accepted.network);
    const verification = await this.#config.exactTransactionVerifier.verifyExactPayment({
      network: accepted.network,
      transaction: payload.transaction,
      transactionId: payload.transactionId,
      paymentOutputIndex: payload.paymentOutputIndex,
      amount: accepted.amount,
      payTo: accepted.payTo,
      payToScriptPublicKey,
      requiredFinality: this.#config.acceptedFinality,
      requestHash: requestFingerprint,
    });
    if (!/^[0-9a-fA-F]{64}$/.test(verification.transactionId)) {
      throw new KaspaX402Error("invalid_kaspa_transaction", "exact verifier returned an invalid transaction id");
    }
    if (!isExactFinality(verification.finality)) {
      throw new KaspaX402Error("invalid_kaspa_transaction", "exact verifier returned an invalid finality");
    }
    if (payload.transactionId && verification.transactionId.toLowerCase() !== payload.transactionId.toLowerCase()) {
      throw new KaspaX402Error("invalid_kaspa_transaction", "exact transaction id does not match payload hint");
    }
    if (verification.paymentOutput.amount !== accepted.amount) {
      throw new KaspaX402Error("invalid_kaspa_x402_amount", "exact payment output amount does not match accepted amount");
    }
    if (verification.paymentOutput.scriptPublicKey.toLowerCase() !== payToScriptPublicKey.toLowerCase()) {
      throw new KaspaX402Error("invalid_kaspa_x402_binding", "exact payment output script does not match payTo");
    }
    if (!exactFinalityMeets(verification.finality, this.#config.acceptedFinality)) {
      throw new KaspaX402Error("invalid_kaspa_transaction", "exact payment has not reached required finality");
    }
    if (accepted.extra.finality && !exactFinalityMeets(verification.finality, accepted.extra.finality)) {
      throw new KaspaX402Error("invalid_kaspa_transaction", "exact payment has not reached advertised finality");
    }
    return {
      scheme: "exact",
      paymentRequired,
      paymentPayload,
      accepted,
      transactionId: verification.transactionId,
      paymentOutputIndex: payload.paymentOutputIndex,
      payerAddress: verification.payerAddress ?? payload.payerAddress,
      finality: verification.finality,
    };
  }

  async #verifyUptoPayment(
    paymentRequired: ReturnType<typeof makePaymentRequired>,
    paymentPayload: PaymentPayload & { accepted: UptoPaymentRequirements; payload: UptoAuthorizationPayload },
    requestFingerprint: Hash32Hex,
  ): Promise<VerifiedUptoPayment> {
    const accepted = paymentPayload.accepted;
    const payload = paymentPayload.payload;
    validateUptoTerms(this.#config, accepted);

    const authorizationScopeId = uptoAuthorizationScopeId(payload.authorizationOutpoint);
    const nonceScopeId = uptoNonceScopeId(accepted.network, payload.clientPublicKey, payload.authorization.nonce);
    const existingByOutpoint = await this.#config.store.loadUptoAuthorization(authorizationScopeId);
    const existingByNonce = await this.#config.store.loadUptoAuthorization(nonceScopeId);
    const existingConsumption = existingByOutpoint ?? existingByNonce;
    if (existingConsumption) {
      return {
        scheme: "upto",
        paymentRequired,
        paymentPayload,
        accepted,
        authorizationScopeId,
        nonceScopeId,
        existingConsumption,
      };
    }

    if (payload.authorization.maxAmountSompi !== accepted.amount) {
      throw new KaspaX402Error("invalid_kaspa_upto_max_amount", "upto authorization maximum does not match accepted amount");
    }
    if (payload.authorization.payTo !== accepted.payTo) {
      throw new KaspaX402Error("invalid_kaspa_upto_recipient", "upto authorization recipient does not match accepted payTo");
    }
    if (payload.authorization.serverPublicKey !== accepted.extra.serverPublicKey) {
      throw new KaspaX402Error("invalid_kaspa_public_key", "upto authorization server public key does not match accepted requirement");
    }
    if (!payload.authorization.requestHash || payload.authorization.requestHash.toLowerCase() !== requestFingerprint.toLowerCase()) {
      throw new KaspaX402Error("invalid_kaspa_x402_payload", "upto authorization request hash does not match request fingerprint");
    }
    if (parseSompiString(payload.authorization.validAfterDaa) > parseSompiString(payload.authorization.validBeforeDaa)) {
      throw new KaspaX402Error("invalid_kaspa_upto_expired", "upto authorization validity window is invalid");
    }
    if (parseSompiString(payload.authorization.validBeforeDaa) > parseSompiString(accepted.extra.authorizationTimeoutDaa)) {
      throw new KaspaX402Error("invalid_kaspa_upto_expired", "upto authorization exceeds advertised timeout");
    }
    const nowDaa = await this.#config.chainProvider.getVirtualDaaScore();
    if (
      parseSompiString(nowDaa) < parseSompiString(payload.authorization.validAfterDaa) ||
      parseSompiString(nowDaa) > parseSompiString(payload.authorization.validBeforeDaa)
    ) {
      throw new KaspaX402Error("invalid_kaspa_upto_expired", "upto authorization is outside its DAA validity window");
    }

    if (!this.#config.uptoScriptDeriver) {
      throw new KaspaX402Error("invalid_kaspa_upto_template", "upto authorization script deriver is required");
    }
    const expectedScript = await this.#config.uptoScriptDeriver.deriveAuthorizationScript({
      accepted,
      payload,
      requestFingerprint,
    });
    if (expectedScript.toLowerCase() !== payload.authorizationScriptPublicKey.toLowerCase()) {
      throw new KaspaX402Error("invalid_kaspa_upto_template", "upto authorization script does not match derived template");
    }

    const utxo = await this.#verifiedFundingUtxo(payload.authorizationOutpoint, payload.authorizationScriptPublicKey, payload.authorizationAmountSompi);
    if (parseSompiString(utxo.amount) < parseSompiString(payload.authorization.maxAmountSompi)) {
      throw new KaspaX402Error("invalid_kaspa_x402_amount", "upto authorization amount is below the signed maximum");
    }

    if (!this.#config.uptoAuthorizationVerifier) {
      throw new KaspaX402Error("invalid_kaspa_signature", "upto authorization signature verifier is required");
    }
    const digestInput = {
      network: accepted.network,
      payTo: payload.authorization.payTo,
      refundAddress: payload.refundAddress,
      clientPublicKey: payload.clientPublicKey,
      serverPublicKey: payload.authorization.serverPublicKey,
      authorizationOutpoint: payload.authorizationOutpoint,
      maxAmountSompi: payload.authorization.maxAmountSompi,
      validAfterDaa: payload.authorization.validAfterDaa,
      validBeforeDaa: payload.authorization.validBeforeDaa,
      nonce: payload.authorization.nonce,
      requestHash: payload.authorization.requestHash,
    };
    const digest = uptoAuthorizationDigest(digestInput);
    const preimage = uptoAuthorizationPreimageHex(digestInput);
    const verified = await this.#config.uptoAuthorizationVerifier.verifyUptoAuthorization({
      accepted,
      payload,
      digest,
      preimage,
      requestFingerprint,
    });
    if (!verified) throw new KaspaX402Error("invalid_kaspa_signature", "upto authorization signature was rejected");

    return {
      scheme: "upto",
      paymentRequired,
      paymentPayload,
      accepted,
      authorizationScopeId,
      nonceScopeId,
      utxo,
    };
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
      scheme: "batch-settlement",
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
      scheme: "batch-settlement",
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

  async #commitBatchResponse(
    verified: VerifiedBatchPayment,
    handlerResult: ProtectedHandlerResult,
    chargedAmount: SompiString,
    fingerprint: Hash32Hex,
    paymentIdentifier?: string,
  ): Promise<ServerResponse> {
    let pending: PendingSettlement;
    try {
      pending = this.#buildSuccessfulSettlement(verified, chargedAmount, fingerprint, paymentIdentifier);
    } catch (error) {
      await this.#preserveLiveDepositTransition(verified);
      return this.#correctiveResponse(verified.paymentRequired.resource, verified.paymentPayload, error, verified.accepted.amount, "batch-settlement");
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
                paymentPayloadHash: paymentPayloadHash(verified.paymentPayload),
                response,
                settlement,
                paymentScopeId: channel.channelId,
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
  }

  async #commitExactResponse(
    verified: VerifiedExactPayment,
    handlerResult: ProtectedHandlerResult,
    chargedAmount: SompiString,
    fingerprint: Hash32Hex,
    paymentIdentifier?: string,
  ): Promise<ServerResponse> {
    const pending = this.#buildSuccessfulExactSettlement(verified, chargedAmount, fingerprint);
    const response: ServerResponse = {
      status: handlerResult.status ?? 200,
      headers: {
        ...(handlerResult.headers ?? {}),
        [PAYMENT_RESPONSE_HEADER]: encodePaymentResponseHeader(pending.settlement),
      },
      body: handlerResult.body,
    };
    try {
      await this.#config.store.commitExactPayment({
        payment: { ...pending.payment, response },
        ...(paymentIdentifier
          ? {
              paymentIdentifier: {
                id: paymentIdentifier,
                fingerprint,
                paymentPayloadHash: paymentPayloadHash(verified.paymentPayload),
                response,
                settlement: pending.settlement,
                paymentScopeId: exactPaymentScopeId(verified.transactionId, verified.paymentOutputIndex),
                transactionId: verified.transactionId,
                paymentOutputIndex: verified.paymentOutputIndex,
              },
            }
          : {}),
      });
    } catch {
      return {
        status: 500,
        headers: {},
      };
    }
    return response;
  }

  async #commitUptoResponse(
    verified: VerifiedUptoPayment,
    handlerResult: ProtectedHandlerResult,
    chargedAmount: SompiString,
    fingerprint: Hash32Hex,
    paymentIdentifier?: string,
  ): Promise<ServerResponse> {
    let pending: PendingUptoSettlement;
    try {
      pending = await this.#buildSuccessfulUptoSettlement(verified, chargedAmount, fingerprint);
    } catch (error) {
      if (!(error instanceof KaspaX402Error)) {
        return {
          status: 500,
          headers: {},
        };
      }
      return this.#correctiveResponse(verified.paymentRequired.resource, verified.paymentPayload, error, verified.accepted.amount, "upto");
    }
    let response: ServerResponse = {
      status: handlerResult.status ?? 200,
      headers: {
        ...(handlerResult.headers ?? {}),
        [PAYMENT_RESPONSE_HEADER]: encodePaymentResponseHeader(pending.settlement),
      },
      body: handlerResult.body,
    };
    if (pending.transaction) {
      const transactionId = pending.authorization.transactionId;
      if (!transactionId) {
        return this.#correctiveResponse(
          verified.paymentRequired.resource,
          verified.paymentPayload,
          new KaspaX402Error("invalid_kaspa_settlement_response", "upto settlement transaction id is missing"),
          verified.accepted.amount,
          "upto",
        );
      }
      const reservation = this.#uptoAuthorizationReservation(verified, chargedAmount, pending.transaction, transactionId, fingerprint, response, pending.settlement, paymentIdentifier);
      const reservedSettlement = withUptoSettlementFinality(pending.settlement, transactionId, "broadcast");
      const reservedResponse = uptoPendingResponse(reservedSettlement);
      const reservedPaymentIdentifier = paymentIdentifier
        ? uptoPaymentIdentifierRecord(paymentIdentifier, reservation, reservedResponse, uptoPendingSettlement(reservedSettlement))
        : undefined;
      try {
        await this.#config.store.reserveUptoAuthorization(reservation, reservedPaymentIdentifier);
      } catch {
        return {
          status: 500,
          headers: {},
        };
      }

      let broadcast: TransactionBroadcast;
      try {
        broadcast = await this.#config.chainProvider.sendTransaction(pending.transaction);
      } catch {
        return {
          status: 500,
          headers: {},
        };
      }
      if (broadcast.transactionId.toLowerCase() !== transactionId.toLowerCase()) {
        return this.#correctiveResponse(
          verified.paymentRequired.resource,
          verified.paymentPayload,
          new KaspaX402Error("invalid_kaspa_transaction", "upto settlement transaction id does not match verified transaction"),
          verified.accepted.amount,
          "upto",
        );
      }

      const finality = normalizeBroadcastFinality(broadcast.finality);
      const finalizedSettlement = withUptoSettlementFinality(pending.settlement, broadcast.transactionId, finality);
      response = responseWithSettlement(response, finalizedSettlement);
      const broadcastRecord: UptoBroadcastAuthorizationRecord = {
        ...pending.authorization,
        status: "broadcast",
        transaction: pending.transaction,
        transactionId: broadcast.transactionId,
        finality,
        settlement: finalizedSettlement,
        response,
        ...(paymentIdentifier ? { paymentIdentifier } : {}),
      };
      const requiredFinality = pending.authorization.requiredFinality;
      const broadcastIdentifierResponse = isAcceptedFinality(finality, requiredFinality) ? response : uptoPendingResponse(finalizedSettlement);
      const broadcastPaymentIdentifier = paymentIdentifier
        ? uptoPaymentIdentifierRecord(
            paymentIdentifier,
            broadcastRecord,
            broadcastIdentifierResponse,
            isAcceptedFinality(finality, requiredFinality) ? finalizedSettlement : uptoPendingSettlement(finalizedSettlement),
          )
        : undefined;
      try {
        await this.#config.store.markUptoAuthorizationBroadcast(broadcastRecord, broadcastPaymentIdentifier);
      } catch {
        return {
          status: 500,
          headers: {},
        };
      }
      if (!isAcceptedFinality(broadcast.finality, requiredFinality)) {
        return uptoPendingResponse(finalizedSettlement);
      }
      const settledAuthorization = settledUptoAuthorizationFromBroadcast(broadcastRecord);
      const paymentIdentifierRecord = paymentIdentifier ? uptoPaymentIdentifierRecord(paymentIdentifier, settledAuthorization, response, finalizedSettlement) : undefined;
      try {
        await this.#config.store.commitUptoSettlement({
          authorization: settledAuthorization,
          ...(paymentIdentifierRecord ? { paymentIdentifier: paymentIdentifierRecord } : {}),
        });
      } catch {
        return {
          status: 500,
          headers: {},
        };
      }
      return response;
    }

    const paymentIdentifierRecord = paymentIdentifier ? uptoPaymentIdentifierRecord(paymentIdentifier, pending.authorization, response, pending.settlement) : undefined;
    try {
      await this.#config.store.commitUptoSettlement({
        authorization: { ...pending.authorization, response },
        ...(paymentIdentifierRecord ? { paymentIdentifier: paymentIdentifierRecord } : {}),
      });
    } catch {
      return {
        status: 500,
        headers: {},
      };
    }
    return response;
  }

  async #preserveLiveDepositTransition(verified: VerifiedPayment): Promise<void> {
    if (verified.scheme !== "batch-settlement" || verified.paymentPayload.payload.type !== "deposit-voucher") return;
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
    verified: VerifiedBatchPayment,
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

  #buildSuccessfulExactSettlement(verified: VerifiedExactPayment, chargedAmount: SompiString, fingerprint: Hash32Hex): PendingExactSettlement {
    const settlement: SettlementResponse = {
      success: true,
      transaction: verified.transactionId,
      network: this.#config.network,
      ...(verified.payerAddress ? { payer: verified.payerAddress } : {}),
      amount: chargedAmount,
      extra: {
        paymentOutputIndex: verified.paymentOutputIndex,
        finality: verified.finality,
        requestHash: fingerprint,
      },
    };
    return {
      settlement,
      payment: {
        transactionId: verified.transactionId,
        paymentOutputIndex: verified.paymentOutputIndex,
        requestFingerprint: fingerprint,
        paymentRequirementsHash: sha256Hex(stableStringify(verified.accepted)),
        paymentPayloadHash: paymentPayloadHash(verified.paymentPayload),
        amount: chargedAmount,
        ...(verified.payerAddress ? { payerAddress: verified.payerAddress } : {}),
        finality: verified.finality,
        settlement,
      },
    };
  }

  async #buildSuccessfulUptoSettlement(
    verified: VerifiedUptoPayment,
    chargedAmount: SompiString,
    fingerprint: Hash32Hex,
  ): Promise<PendingUptoSettlement> {
    const payload = verified.paymentPayload.payload;
    const maxAmount = parseSompiString(payload.authorization.maxAmountSompi);
    const charge = parseSompiString(chargedAmount);
    if (charge > maxAmount) {
      throw new KaspaX402Error("invalid_kaspa_upto_settlement_amount", "handler charge exceeds signed upto maximum");
    }
    if (charge === 0n) {
      const settlement: SettlementResponse = {
        success: true,
        transaction: "",
        network: this.#config.network,
        payer: payload.refundAddress,
        extra: {
          chargedAmount: "0",
          maxAmountSompi: payload.authorization.maxAmountSompi,
          authorizationOutpoint: payload.authorizationOutpoint,
          refundAddress: payload.refundAddress,
        },
      };
      return {
        settlement,
        authorization: this.#uptoAuthorizationRecord(verified, chargedAmount, settlement, fingerprint),
      };
    }
    if (!verified.utxo) {
      throw new KaspaX402Error("invalid_kaspa_upto_replay", "upto authorization was already consumed");
    }
    if (!this.#config.uptoSettlementBuilder) {
      throw new KaspaX402Error("invalid_kaspa_transaction", "upto settlement transaction builder is required");
    }
    if (!this.#config.uptoSettlementVerifier) {
      throw new KaspaX402Error("invalid_kaspa_transaction", "upto settlement transaction verifier is required");
    }
    const built = await this.#config.uptoSettlementBuilder.buildUptoSettlementTransaction({
      accepted: verified.accepted,
      payload,
      utxo: verified.utxo,
      chargeAmount: chargedAmount,
      requestFingerprint: fingerprint,
    });
    const paymentScriptPublicKey = this.#config.addressCodec.scriptPublicKeyForAddress(verified.accepted.payTo, verified.accepted.network);
    const refundScriptPublicKey = this.#config.addressCodec.scriptPublicKeyForAddress(payload.refundAddress, verified.accepted.network);
    const transactionVerification = await this.#config.uptoSettlementVerifier.verifyUptoSettlementTransaction({
      accepted: verified.accepted,
      payload,
      transaction: built.transaction,
      chargeAmount: chargedAmount,
      requestFingerprint: fingerprint,
      authorizationOutpoint: payload.authorizationOutpoint,
      payToScriptPublicKey: paymentScriptPublicKey,
      refundScriptPublicKey,
    });
    validateUptoSettlementTransactionEvidence(verified, transactionVerification, chargedAmount, paymentScriptPublicKey, refundScriptPublicKey);
    const settlement: SettlementResponse = {
      success: true,
      transaction: transactionVerification.transactionId,
      network: this.#config.network,
      payer: payload.refundAddress,
      amount: chargedAmount,
      extra: {
        maxAmountSompi: payload.authorization.maxAmountSompi,
        authorizationOutpoint: payload.authorizationOutpoint,
        refundAddress: payload.refundAddress,
        ...(transactionVerification.paymentOutputIndex !== undefined ? { paymentOutputIndex: transactionVerification.paymentOutputIndex } : {}),
      },
    };
    return {
      settlement,
      authorization: {
        ...this.#uptoAuthorizationRecord(verified, chargedAmount, settlement, fingerprint),
        transactionId: transactionVerification.transactionId,
      },
      transaction: built.transaction,
    };
  }

  #uptoAuthorizationRecord(
    verified: VerifiedUptoPayment,
    chargedAmount: SompiString,
    settlement: SettlementResponse,
    fingerprint: Hash32Hex,
  ): Omit<UptoSettledAuthorizationRecord, "response"> {
    const payload = verified.paymentPayload.payload;
    return {
      status: "settled",
      authorizationScopeId: verified.authorizationScopeId,
      nonceScopeId: verified.nonceScopeId,
      authorizationOutpoint: payload.authorizationOutpoint,
      nonce: payload.authorization.nonce,
      requestFingerprint: fingerprint,
      paymentRequirementsHash: sha256Hex(stableStringify(verified.accepted)),
      paymentPayloadHash: paymentPayloadHash(verified.paymentPayload),
      requiredFinality: requiredUptoFinality(verified.accepted, this.#config.acceptedFinality),
      maxAmountSompi: payload.authorization.maxAmountSompi,
      authorizationAmountSompi: payload.authorizationAmountSompi,
      chargedAmount,
      refundAddress: payload.refundAddress,
      payerAddress: payload.refundAddress,
      settlement,
    };
  }

  #uptoAuthorizationReservation(
    verified: VerifiedUptoPayment,
    chargedAmount: SompiString,
    transaction: string,
    transactionId: Hash32Hex,
    fingerprint: Hash32Hex,
    response: ServerResponse,
    settlement: SettlementResponse,
    paymentIdentifier?: string,
  ): UptoPendingAuthorizationRecord {
    const payload = verified.paymentPayload.payload;
    return {
      status: "pending",
      authorizationScopeId: verified.authorizationScopeId,
      nonceScopeId: verified.nonceScopeId,
      authorizationOutpoint: payload.authorizationOutpoint,
      nonce: payload.authorization.nonce,
      requestFingerprint: fingerprint,
      paymentRequirementsHash: sha256Hex(stableStringify(verified.accepted)),
      paymentPayloadHash: paymentPayloadHash(verified.paymentPayload),
      requiredFinality: requiredUptoFinality(verified.accepted, this.#config.acceptedFinality),
      maxAmountSompi: payload.authorization.maxAmountSompi,
      authorizationAmountSompi: payload.authorizationAmountSompi,
      chargedAmount,
      refundAddress: payload.refundAddress,
      payerAddress: payload.refundAddress,
      transaction,
      transactionId,
      settlement,
      response,
      ...(paymentIdentifier ? { paymentIdentifier } : {}),
    };
  }

  async #checkIdempotency(
    paymentIdentifier: string | undefined,
    fingerprint: Hash32Hex,
    paymentScopeId: Hash32Hex | undefined,
    paymentPayload: PaymentPayload,
  ): Promise<ServerResponse | undefined> {
    if (!paymentIdentifier) return undefined;
    const record = await this.#config.store.loadPaymentIdentifier(paymentIdentifier);
    if (!record) return undefined;
    const currentPayloadHash = paymentPayloadHash(paymentPayload);
    const fingerprintMatches = record.fingerprint === fingerprint;
    const scopeMatches = paymentIdentifierScopeMatches(record, paymentScopeId);
    const payloadMatches = record.paymentPayloadHash === currentPayloadHash;
    if (record.authorizationScopeId && record.fingerprint === fingerprint && paymentPayload.accepted.scheme === "upto") {
      const authorization = await this.#config.store.loadUptoAuthorization(record.authorizationScopeId);
      if (authorization?.status === "pending" || authorization?.status === "broadcast") {
        return this.#recoverUptoSettlement(authorization, { releaseStoredResponse: scopeMatches && payloadMatches });
      }
    }
    if (!fingerprintMatches || !scopeMatches) {
      return paymentIdentifierConflictResponse();
    }
    if (!payloadMatches) {
      return paymentIdentifierConflictResponse();
    }
    return record.response;
  }

  async #checkExactReplay(verified: VerifiedExactPayment, fingerprint: Hash32Hex, paymentPayload: PaymentPayload): Promise<ServerResponse | undefined> {
    const record = await this.#config.store.loadExactPayment(verified.transactionId, verified.paymentOutputIndex);
    if (!record) return undefined;
    if (
      record.requestFingerprint === fingerprint &&
      record.paymentPayloadHash === paymentPayloadHash(paymentPayload) &&
      record.paymentOutputIndex === verified.paymentOutputIndex
    ) {
      return record.response;
    }
    return {
      status: 409,
      headers: {},
      body: {
        error: "exact_payment_replay",
      },
    };
  }

  async #checkUptoReplay(verified: VerifiedUptoPayment, fingerprint: Hash32Hex, paymentPayload: PaymentPayload): Promise<ServerResponse | undefined> {
    const record = verified.existingConsumption;
    if (!record) return undefined;
    if (record.requestFingerprint === fingerprint && record.paymentPayloadHash === paymentPayloadHash(paymentPayload)) {
      if (record.status === "pending" || record.status === "broadcast") return this.#recoverUptoSettlement(record);
      return record.response;
    }
    return {
      status: 409,
      headers: {},
      body: {
        error: "upto_authorization_replay",
      },
    };
  }

  async #recoverUptoSettlement(
    record: UptoPendingAuthorizationRecord | UptoBroadcastAuthorizationRecord,
    options: { releaseStoredResponse?: boolean } = {},
  ): Promise<ServerResponse> {
    const releaseStoredResponse = options.releaseStoredResponse ?? true;
    let recoverable: UptoBroadcastAuthorizationRecord;
    if (record.status === "broadcast" && isAcceptedFinality(record.finality, record.requiredFinality)) {
      recoverable = record;
    } else {
      let broadcast: TransactionBroadcast;
      try {
        broadcast = await this.#config.chainProvider.sendTransaction(record.transaction);
      } catch {
        return uptoPendingResponse(pendingSettlementForUptoRecord(record));
      }
      if (broadcast.transactionId.toLowerCase() !== record.transactionId.toLowerCase()) {
        return uptoPendingResponse(pendingSettlementForUptoRecord(record));
      }
      const finality = normalizeBroadcastFinality(broadcast.finality);
      const settlement = withUptoSettlementFinality(record.settlement, broadcast.transactionId, finality);
      const response = responseWithSettlement(record.response, settlement);
      recoverable = {
        ...record,
        status: "broadcast",
        transactionId: broadcast.transactionId,
        finality,
        settlement,
        response,
      };
      const paymentIdentifierRecord = recoverable.paymentIdentifier
        ? uptoPaymentIdentifierRecord(recoverable.paymentIdentifier, recoverable, response, settlement)
        : undefined;
      try {
        await this.#config.store.markUptoAuthorizationBroadcast(recoverable, paymentIdentifierRecord);
      } catch {
        return {
          status: 500,
          headers: {},
        };
      }
      if (!isAcceptedFinality(finality, record.requiredFinality)) {
        return uptoPendingResponse(settlement);
      }
    }

    const settled = settledUptoAuthorizationFromBroadcast(recoverable);
    const paymentIdentifierRecord = recoverable.paymentIdentifier
      ? uptoPaymentIdentifierRecord(recoverable.paymentIdentifier, settled, recoverable.response, recoverable.settlement)
      : undefined;
    try {
      await this.#config.store.commitUptoSettlement({
        authorization: settled,
        ...(paymentIdentifierRecord ? { paymentIdentifier: paymentIdentifierRecord } : {}),
      });
    } catch {
      return {
        status: 500,
        headers: {},
      };
    }
    return releaseStoredResponse ? recoverable.response : paymentIdentifierConflictResponse();
  }

  async #correctiveResponse(
    resource: ResourceInfo,
    paymentPayload: PaymentPayload,
    error: unknown,
    paymentAmount?: SompiString,
    requestedScheme?: "exact" | "upto" | "batch-settlement",
  ): Promise<ServerResponse> {
    const channelId = safePaymentChannelId(paymentPayload);
    const channel = channelId ? await this.#config.store.loadChannel(channelId) : undefined;
    const activeChannel = channel?.status === "active" ? channel : undefined;
    const scheme =
      paymentPayload.accepted.scheme === "exact" || paymentPayload.accepted.scheme === "upto" ? paymentPayload.accepted.scheme : requestedScheme;
    return {
      ...this.paymentRequiredResponse({
        resource,
        amount: paymentAmount,
        scheme,
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

  async #expectedPaymentRequired(
    resource: ResourceInfo,
    paymentPayload: PaymentPayload,
    paymentAmount?: SompiString,
    requestedScheme?: "exact" | "upto" | "batch-settlement",
  ): Promise<PaymentRequired> {
    const payloadChannelId = safePaymentChannelId(paymentPayload);
    const accepted = paymentPayload.accepted;
    if (accepted.scheme === "exact") {
      return this.buildPaymentRequired({ resource, amount: paymentAmount, scheme: "exact" });
    }
    if (accepted.scheme === "upto") {
      return this.buildPaymentRequired({ resource, amount: paymentAmount, scheme: "upto" });
    }
    if (accepted.scheme !== "batch-settlement" || !payloadChannelId) {
      return this.buildPaymentRequired({ resource, amount: paymentAmount, scheme: requestedScheme });
    }
    const channel = await this.#config.store.loadChannel(payloadChannelId);
    const acceptedExtra = accepted.extra;
    if (!channel || channel.status !== "active" || (!acceptedExtra.channelState && !acceptedExtra.voucherState)) {
      return this.buildPaymentRequired({ resource, amount: paymentAmount, scheme: "batch-settlement" });
    }
    return this.buildPaymentRequired({
      resource,
      amount: paymentAmount,
      scheme: "batch-settlement",
      channel,
      voucherState: latestVoucher(channel),
    });
  }
}

function makePaymentRequired(config: ResolvedServerConfig, options: BuildPaymentRequiredOptions): PaymentRequired {
  if (options.scheme === "exact") {
    const accepted: ExactPaymentRequirements = {
      scheme: "exact",
      network: config.network,
      amount: options.amount ?? config.amount,
      asset: "KAS",
      payTo: config.payTo,
      maxTimeoutSeconds: config.maxTimeoutSeconds,
      extra: {
        binding: "kaspa-exact-v1",
        finality: config.acceptedFinality,
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

  if (options.scheme === "upto") {
    const accepted: UptoPaymentRequirements = {
      scheme: "upto",
      network: config.network,
      amount: options.amount ?? config.amount,
      asset: "KAS",
      payTo: config.payTo,
      maxTimeoutSeconds: config.maxTimeoutSeconds,
      extra: {
        binding: "kaspa-upto-v1",
        authorizationTemplateId: config.authorizationTemplateId,
        serverPublicKey: config.serverPublicKey,
        authorizationTimeoutDaa: config.authorizationTimeoutDaa,
        finality: config.acceptedFinality,
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

function validateExactTerms(config: ResolvedServerConfig, accepted: ExactPaymentRequirements): void {
  if (accepted.network !== config.network) {
    throw new KaspaX402Error("invalid_kaspa_x402_network", "payment network does not match server config");
  }
  if (accepted.asset !== "KAS") {
    throw new KaspaX402Error("invalid_kaspa_x402_asset", "payment asset does not match server config");
  }
  if (accepted.payTo !== config.payTo) {
    throw new KaspaX402Error("invalid_kaspa_x402_payload", "payTo does not match server config");
  }
  if (accepted.extra.binding !== "kaspa-exact-v1") {
    throw new KaspaX402Error("invalid_kaspa_x402_binding", "exact binding does not match server config");
  }
  parseSompiString(accepted.amount);
}

function validateUptoTerms(config: ResolvedServerConfig, accepted: UptoPaymentRequirements): void {
  if (accepted.network !== config.network) {
    throw new KaspaX402Error("invalid_kaspa_x402_network", "payment network does not match server config");
  }
  if (accepted.asset !== "KAS") {
    throw new KaspaX402Error("invalid_kaspa_x402_asset", "payment asset does not match server config");
  }
  if (accepted.payTo !== config.payTo) {
    throw new KaspaX402Error("invalid_kaspa_upto_recipient", "payTo does not match server config");
  }
  if (accepted.extra.binding !== "kaspa-upto-v1") {
    throw new KaspaX402Error("invalid_kaspa_x402_binding", "upto binding does not match server config");
  }
  if (accepted.extra.authorizationTemplateId !== config.authorizationTemplateId) {
    throw new KaspaX402Error("invalid_kaspa_upto_template", "upto authorization template does not match server config");
  }
  if (accepted.extra.serverPublicKey !== config.serverPublicKey) {
    throw new KaspaX402Error("invalid_kaspa_public_key", "server public key does not match server config");
  }
  if (accepted.extra.authorizationTimeoutDaa !== config.authorizationTimeoutDaa) {
    throw new KaspaX402Error("invalid_kaspa_upto_expired", "authorization timeout does not match server config");
  }
  parseSompiString(accepted.amount);
  parseSompiString(accepted.extra.authorizationTimeoutDaa);
}

function validateUptoSettlementTransactionEvidence(
  verified: VerifiedUptoPayment,
  transaction: UptoSettlementTransactionVerification,
  chargedAmount: SompiString,
  paymentScriptPublicKey: string,
  refundScriptPublicKey: string,
): void {
  const payload = verified.paymentPayload.payload;
  if (transaction.chargeAmount !== chargedAmount) {
    throw new KaspaX402Error("invalid_kaspa_transaction", "upto settlement transaction amount does not match handler charge");
  }
  if (!/^[0-9a-fA-F]{64}$/.test(transaction.transactionId)) {
    throw new KaspaX402Error("invalid_kaspa_transaction", "upto settlement transaction id is invalid");
  }
  if (transaction.inputAmount !== payload.authorizationAmountSompi) {
    throw new KaspaX402Error("invalid_kaspa_transaction", "upto settlement input amount must match authorization amount");
  }
  if (transaction.chargeAmount !== transaction.paymentOutput.amount) {
    throw new KaspaX402Error("invalid_kaspa_transaction", "upto settlement payment output amount must match built charge");
  }
  if (!Number.isInteger(transaction.outputCount) || transaction.outputCount < 1) {
    throw new KaspaX402Error("invalid_kaspa_transaction", "upto settlement output count is invalid");
  }
  if (parseSompiString(transaction.chargeAmount) > parseSompiString(payload.authorization.maxAmountSompi)) {
    throw new KaspaX402Error("invalid_kaspa_upto_settlement_amount", "upto settlement transaction amount exceeds signed maximum");
  }
  if (parseSompiString(transaction.chargeAmount) <= 0n) {
    throw new KaspaX402Error("invalid_kaspa_transaction", "upto settlement transaction must move a positive amount");
  }
  if (!sameOutpoint(transaction.authorizationOutpoint, payload.authorizationOutpoint)) {
    throw new KaspaX402Error("invalid_kaspa_upto_authorization_outpoint", "upto settlement transaction does not consume the authorization outpoint");
  }
  if (transaction.paymentOutput.amount !== transaction.chargeAmount || transaction.paymentOutput.scriptPublicKey.toLowerCase() !== paymentScriptPublicKey.toLowerCase()) {
    throw new KaspaX402Error("invalid_kaspa_transaction", "upto settlement payment output does not match accepted payTo and charge");
  }
  if (!Number.isInteger(transaction.paymentOutput.outputIndex) || transaction.paymentOutput.outputIndex < 0 || transaction.paymentOutput.outputIndex >= transaction.outputCount) {
    throw new KaspaX402Error("invalid_kaspa_transaction", "upto settlement payment output index is invalid");
  }
  if (transaction.paymentOutputIndex !== undefined && transaction.paymentOutputIndex !== transaction.paymentOutput.outputIndex) {
    throw new KaspaX402Error("invalid_kaspa_transaction", "upto settlement payment output index evidence is inconsistent");
  }
  const inputAmount = parseSompiString(transaction.inputAmount);
  const chargeAmount = parseSompiString(transaction.chargeAmount);
  const feeAmount = parseSompiString(transaction.feeAmount);
  if (feeAmount < 0n || chargeAmount + feeAmount > inputAmount) {
    throw new KaspaX402Error("invalid_kaspa_transaction", "upto settlement fee accounting is invalid");
  }
  const refundAmount = inputAmount - chargeAmount - feeAmount;
  if (transaction.refundOutput) {
    if (!Number.isInteger(transaction.refundOutput.outputIndex) || transaction.refundOutput.outputIndex < 0 || transaction.refundOutput.outputIndex >= transaction.outputCount) {
      throw new KaspaX402Error("invalid_kaspa_transaction", "upto settlement refund output index is invalid");
    }
    if (transaction.refundOutput.outputIndex === transaction.paymentOutput.outputIndex) {
      throw new KaspaX402Error("invalid_kaspa_transaction", "upto settlement payment and refund outputs must be distinct");
    }
    if (transaction.refundOutputIndex !== undefined && transaction.refundOutputIndex !== transaction.refundOutput.outputIndex) {
      throw new KaspaX402Error("invalid_kaspa_transaction", "upto settlement refund output index evidence is inconsistent");
    }
    if (transaction.refundOutput.scriptPublicKey.toLowerCase() !== refundScriptPublicKey.toLowerCase()) {
      throw new KaspaX402Error("invalid_kaspa_transaction", "upto settlement refund output does not match refund address");
    }
    if (parseSompiString(transaction.refundOutput.amount) !== refundAmount) {
      throw new KaspaX402Error("invalid_kaspa_transaction", "upto settlement refund output amount does not conserve authorization value");
    }
  } else if (refundAmount !== 0n) {
    throw new KaspaX402Error("invalid_kaspa_transaction", "upto settlement must refund uncharged authorization value");
  } else if (transaction.refundOutputIndex !== undefined) {
    throw new KaspaX402Error("invalid_kaspa_transaction", "upto settlement refund output index is present without a refund output");
  }
  const expectedOutputCount = refundAmount === 0n ? 1 : 2;
  if (transaction.outputCount !== expectedOutputCount) {
    throw new KaspaX402Error("invalid_kaspa_transaction", "upto settlement contains unexpected outputs");
  }
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

function safePaymentScopeIdHint(paymentPayload: PaymentPayload): Hash32Hex | undefined {
  const channelId = safePaymentChannelId(paymentPayload);
  if (channelId) return channelId;
  const payload = paymentPayload.payload;
  if (payload.type === "exact-transfer" && typeof payload.transactionId === "string" && typeof payload.paymentOutputIndex === "number") {
    return exactPaymentScopeId(payload.transactionId, payload.paymentOutputIndex);
  }
  if (payload.type === "upto-authorization") {
    return uptoAuthorizationScopeId(payload.authorizationOutpoint);
  }
  return undefined;
}

function safePaymentLockKey(paymentPayload: PaymentPayload): Hash32Hex | undefined {
  const channelId = safePaymentChannelId(paymentPayload);
  if (channelId) return channelId;
  const payload = paymentPayload.payload;
  if (payload.type === "upto-authorization") {
    return uptoClientLockKey(paymentPayload.accepted.network, payload.clientPublicKey);
  }
  if (payload.type !== "exact-transfer" || typeof payload.transaction !== "string" || typeof payload.paymentOutputIndex !== "number") {
    return undefined;
  }
  return sha256Hex(
    stableStringify({
      scope: "kaspa:x402:exact-transaction-lock:v1",
      transactionId: typeof payload.transactionId === "string" ? payload.transactionId.toLowerCase() : null,
      transaction: typeof payload.transactionId === "string" ? null : payload.transaction.toLowerCase(),
    }),
  );
}

function exactPaymentScopeId(transactionId: Hash32Hex, paymentOutputIndex: number): Hash32Hex {
  return sha256Hex(
    stableStringify({
      scope: "kaspa:x402:exact-payment-outpoint:v1",
      transactionId: transactionId.toLowerCase(),
      paymentOutputIndex,
    }),
  );
}

function sameOutpoint(a: FundingOutpoint, b: FundingOutpoint): boolean {
  return a.txid.toLowerCase() === b.txid.toLowerCase() && a.index === b.index;
}

function uptoAuthorizationScopeId(outpoint: FundingOutpoint): Hash32Hex {
  return sha256Hex(
    stableStringify({
      scope: "kaspa:x402:upto-authorization-outpoint:v1",
      txid: outpoint.txid.toLowerCase(),
      index: outpoint.index,
    }),
  );
}

function uptoNonceScopeId(network: string, clientPublicKey: string, nonce: string): Hash32Hex {
  return sha256Hex(
    stableStringify({
      scope: "kaspa:x402:upto-authorization-nonce:v1",
      network,
      clientPublicKey: clientPublicKey.toLowerCase(),
      nonce: nonce.toLowerCase(),
    }),
  );
}

function uptoClientLockKey(network: string, clientPublicKey: string): Hash32Hex {
  return sha256Hex(
    stableStringify({
      scope: "kaspa:x402:upto-client-lock:v1",
      network,
      clientPublicKey: clientPublicKey.toLowerCase(),
    }),
  );
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

function paymentIdentifierScopeMatches(record: PaymentIdentifierRecord, paymentScopeId: Hash32Hex | undefined): boolean {
  return (
    paymentScopeId === undefined ||
    record.paymentScopeId === paymentScopeId ||
    record.channelId === paymentScopeId ||
    record.transactionId === paymentScopeId ||
    record.authorizationScopeId === paymentScopeId
  );
}

function paymentIdentifierConflictResponse(): ServerResponse {
  return {
    status: 409,
    headers: {},
    body: {
      error: "payment_identifier_conflict",
    },
  };
}

function normalizeBroadcastFinality(finality: SettlementFinality): SettlementFinality {
  return finality === "confirmed" ? "confirmed" : finality === "accepted" ? "accepted" : "broadcast";
}

function requiredUptoFinality(accepted: UptoPaymentRequirements, fallback: Exclude<SettlementFinality, "broadcast">): Exclude<SettlementFinality, "broadcast"> {
  return accepted.extra.finality ?? fallback;
}

function withUptoSettlementFinality(settlement: SettlementResponse, transactionId: Hash32Hex, finality: SettlementFinality): SettlementResponse {
  const responseFinality = finality === "broadcast" ? "mempool" : finality;
  return {
    ...settlement,
    transaction: transactionId,
    extra: {
      ...(settlement.extra ?? {}),
      finality: responseFinality,
    },
  };
}

function responseWithSettlement(response: ServerResponse, settlement: SettlementResponse): ServerResponse {
  return {
    ...response,
    headers: {
      ...(response.headers ?? {}),
      [PAYMENT_RESPONSE_HEADER]: encodePaymentResponseHeader(settlement),
    },
  };
}

function uptoPendingSettlement(settlement: SettlementResponse): SettlementResponse {
  return {
    ...settlement,
    success: false,
    errorReason: "upto_authorization_pending",
  };
}

function uptoPendingResponse(settlement: SettlementResponse): ServerResponse {
  const pendingSettlement = uptoPendingSettlement(settlement);
  return {
    status: 202,
    headers: {
      [PAYMENT_RESPONSE_HEADER]: encodePaymentResponseHeader(pendingSettlement),
    },
    body: {
      error: "upto_authorization_pending",
    },
  };
}

function pendingSettlementForUptoRecord(record: UptoPendingAuthorizationRecord | UptoBroadcastAuthorizationRecord): SettlementResponse {
  return withUptoSettlementFinality(record.settlement, record.transactionId, record.status === "broadcast" ? record.finality : "broadcast");
}

function settledUptoAuthorizationFromBroadcast(record: UptoBroadcastAuthorizationRecord): UptoSettledAuthorizationRecord {
  if (record.finality === "broadcast") {
    throw new KaspaX402Error("invalid_kaspa_transaction", "broadcast-only upto settlement cannot be marked settled");
  }
  const { transaction: _transaction, status: _status, ...settled } = record;
  return { ...settled, finality: record.finality, status: "settled" };
}

function uptoPaymentIdentifierRecord(
  id: string,
  authorization: Pick<UptoAuthorizationRecord, "authorizationScopeId" | "requestFingerprint" | "paymentPayloadHash" | "transactionId">,
  response: ServerResponse,
  settlement: SettlementResponse,
): PaymentIdentifierRecord {
  return {
    id,
    fingerprint: authorization.requestFingerprint,
    paymentPayloadHash: authorization.paymentPayloadHash,
    response,
    settlement,
    paymentScopeId: authorization.authorizationScopeId,
    authorizationScopeId: authorization.authorizationScopeId,
    ...(authorization.transactionId ? { transactionId: authorization.transactionId } : {}),
  };
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

function exactFinalityMeets(actual: "mempool" | "accepted" | "confirmed", required: "mempool" | "accepted" | "confirmed"): boolean {
  const rank = { mempool: 0, accepted: 1, confirmed: 2 } as const;
  return rank[actual] >= rank[required];
}

function isExactFinality(value: unknown): value is "mempool" | "accepted" | "confirmed" {
  return value === "mempool" || value === "accepted" || value === "confirmed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
