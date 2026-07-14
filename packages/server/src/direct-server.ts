import {
  X402_VERSION,
  KASPA_LOCK_TIME_THRESHOLD,
  assertMainnetAllowed,
  bytesToHex,
  channelId,
  concatBytes,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  formatSompiString,
  hexToBytes,
  le32,
  le64,
  kaspaSettlementExtensions,
  parseSompiString,
  paymentIdentifierExtension,
  sha256,
  sha256Hex,
  stableStringify,
  toX402ErrorReason,
  validatePaymentPayload,
  validatePaymentRequired,
  validatePaymentRetry,
  voucherDigest,
  voucherPreimageHex,
  type BatchPaymentRequirements,
  type ChannelConfig,
  type DepositVoucherPayload,
  type ExactPaymentRequirements,
  type ExactTransactionPayload,
  type FundingOutpoint,
  type Hash32Hex,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type ResourceInfo,
  type SettlementResponse,
  type SompiString,
  type SupportedKind,
  type Voucher,
  type VoucherPayload,
} from "@kaspa-x402/core";
import { KaspaX402Error } from "@kaspa-x402/core";
import {
  deriveEscrowAddress,
  escrowScriptPublicKey,
  parseKip10AdditiveRedeemScript,
  payToScriptHashScript,
  serializedScriptPublicKey,
} from "@kaspa-x402/covenant";
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
  type DirectPaymentSettlementOptions,
  type DirectPaymentVerification,
  type DirectPaymentVerificationOptions,
  type DirectModeServerConfig,
  type ExactPaymentRecord,
  type ExactHeadChallenge,
  type ExactHeadRecord,
  type ExactSettlementAttemptRecord,
  type ExactSettlementClaimResult,
  type HandlerContext,
  type PaidRequest,
  type PaymentIdentifierRecord,
  type PreparedTransaction,
  type ProtectedHandler,
  type ProtectedHandlerResult,
  type ServerChannelRecord,
  type ServerResponse,
  type SettlementFinality,
  type TransactionBroadcast,
  type VerifiedBatchPayment,
  type VerifiedExactPayment,
  type VerifiedPayment,
} from "./types.js";

type ResolvedServerConfig = DirectModeServerConfig &
  Required<
    Pick<
      DirectModeServerConfig,
      | "asset"
      | "templateId"
      | "maxTimeoutSeconds"
      | "acceptedFinality"
      | "exactProfile"
      | "minimumExactAdditiveThresholdSompi"
      | "minimumRefundLeadDaa"
      | "allowRollingRefundTimeoutDaa"
      | "lockManager"
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

export class DirectModeServer {
  readonly #config: ResolvedServerConfig;

  constructor(config: DirectModeServerConfig) {
    this.#config = {
      asset: "KAS",
      templateId: "kaspa-x402-escrow-v1",
      maxTimeoutSeconds: 60,
      acceptedFinality: "accepted",
      exactProfile: "standard-native",
      minimumExactAdditiveThresholdSompi: "10000000",
      minimumRefundLeadDaa: "1000",
      allowRollingRefundTimeoutDaa: false,
      lockManager: new MemoryChannelLockManager(),
      ...config,
    };
    assertMainnetAllowed(
      this.#config.network,
      this.#config.allowMainnet,
      "DirectModeServer",
    );
    assertRefundPolicyConfig(this.#config);
  }

  buildPaymentRequired(options: BuildPaymentRequiredOptions): PaymentRequired {
    return makePaymentRequired(this.#config, options);
  }

  paymentRequiredResponse(
    options: BuildPaymentRequiredOptions,
    status = 402,
  ): ServerResponse {
    return {
      status,
      headers: {
        [PAYMENT_REQUIRED_HEADER]: encodePaymentRequiredHeader(
          this.buildPaymentRequired(options),
        ),
      },
    };
  }

  async #paymentRequiredResponse(
    options: BuildPaymentRequiredOptions,
    status = 402,
  ): Promise<ServerResponse> {
    let paymentRequired: PaymentRequired;
    try {
      paymentRequired = await this.#buildRuntimePaymentRequired(options);
    } catch (error) {
      return {
        status: 503,
        headers: {},
        body: {
          error:
            error instanceof KaspaX402Error
              ? toX402ErrorReason(error.code)
              : "gateway_error",
        },
      };
    }
    return {
      status,
      headers: {
        [PAYMENT_REQUIRED_HEADER]: encodePaymentRequiredHeader(paymentRequired),
      },
    };
  }

  async #buildRuntimePaymentRequired(
    options: BuildPaymentRequiredOptions,
  ): Promise<PaymentRequired> {
    if (
      this.#config.exactProfile === "additive" &&
      paymentRequirementSchemes(options).includes("exact") &&
      !options.exactHead
    ) {
      const amount = options.amount ?? this.#config.amount;
      const payToScriptPublicKey =
        this.#config.addressCodec.scriptPublicKeyForAddress(
          this.#config.payTo,
          this.#config.network,
        );
      const selectionKey = sha256Hex(
        stableStringify({
          scope: "kaspa:x402:additive-head-selection:v1",
          network: this.#config.network,
          amount,
          payTo: this.#config.payTo,
          resource: options.resource,
        }),
      );
      const head = await this.#config.store.selectExactHead({
        network: this.#config.network,
        amount,
        payTo: this.#config.payTo,
        payToScriptPublicKey,
        minimumAdditiveThresholdSompi:
          this.#config.minimumExactAdditiveThresholdSompi,
        selectionKey,
      });
      if (!head)
        throw new KaspaX402Error(
          "invalid_kaspa_x402_payload",
          "additive exact head is unavailable",
        );
      const exactHead = makeExactHeadChallenge(
        head,
        amount,
        this.#config.maxTimeoutSeconds,
      );
      return makePaymentRequired(this.#config, { ...options, exactHead });
    }
    if (paymentRequirementSchemes(options).includes("batch-settlement")) {
      await this.#assertRefundWindow(this.#config.refundTimeoutDaa);
    }
    return makePaymentRequired(this.#config, options);
  }

  async extractPayment(header: string): Promise<PaymentPayload> {
    return decodePaymentSignatureHeader(header);
  }

  supportedKinds(): SupportedKind[] {
    const kinds: SupportedKind[] = [];
    if (this.#config.exactTransactionVerifier) {
      kinds.push({
        x402Version: X402_VERSION,
        scheme: "exact",
        network: this.#config.network,
        extra: {
          asset: this.#config.asset,
          binding: "kaspa-exact-v2",
          profile: this.#config.exactProfile,
          transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
          ...(this.#config.exactProfile === "additive"
            ? {
                templateId: "kaspa-x402-kip10-additive-v1",
              }
            : {}),
          modes: ["verify", "settle"],
        },
      });
    }
    kinds.push({
      x402Version: X402_VERSION,
      scheme: "batch-settlement",
      network: this.#config.network,
      extra: {
        asset: this.#config.asset,
        binding: "kaspa-escrow-v1",
        templateId: this.#config.templateId,
        modes: this.#config.claimBuilder
          ? ["verify", "settle", "claim"]
          : ["verify", "settle"],
      },
    });
    return kinds;
  }

  async verifyPayment(
    options: DirectPaymentVerificationOptions,
  ): Promise<DirectPaymentVerification> {
    const resource = options.resource ?? facilitatorResource();
    const paymentPayload = validatedPaymentPayload(options.paymentPayload);
    const paymentRequired = validatedPaymentRequired(
      this.#facilitatorPaymentRequired(resource, options.paymentRequirements),
    );
    const requestFingerprint = facilitatorRequestFingerprint({
      ...options,
      paymentPayload,
      paymentRequirements: paymentRequired.accepts[0],
      resource,
    });
    const payment = await this.#verifyPaymentAgainstRequired(
      paymentRequired,
      paymentPayload,
      requestFingerprint,
    );
    await this.#assertVerifyNotReplayed(
      payment,
      requestFingerprint,
      paymentPayload,
    );
    return {
      payment,
      requestFingerprint,
      ...verifiedPaymentSummary(payment),
    };
  }

  async settlePayment(
    options: DirectPaymentSettlementOptions,
  ): Promise<SettlementResponse> {
    const paymentPayload = validatedPaymentPayload(options.paymentPayload);
    const resource = options.resource ?? facilitatorResource();
    const settlementPaymentRequired = validatedPaymentRequired(
      this.#facilitatorPaymentRequired(resource, options.paymentRequirements),
    );
    const settlementRequirements = settlementPaymentRequired.accepts[0];
    assertSettlementRequirements(
      paymentPayload.accepted,
      settlementRequirements,
    );
    const requestFingerprint = facilitatorRequestFingerprint({
      ...options,
      paymentPayload,
      paymentRequirements: paymentPayload.accepted,
      resource,
    });
    const response = await this.handlePaidRequest(
      {
        method: "FACILITATOR",
        url: resource.url,
        resource,
        body: null,
        paymentAmount: paymentPayload.accepted.amount,
        paymentScheme: paymentPayload.accepted.scheme,
        requestHash: requestFingerprint,
        headers: {
          [PAYMENT_SIGNATURE_HEADER]:
            encodePaymentSignatureHeader(paymentPayload),
        },
      },
      async () => ({
        status: 200,
        chargedAmount: settlementRequirements.amount,
      }),
    );
    return settlementFromServerResponse(response, this.#config.network);
  }

  async handlePaidRequest(
    request: PaidRequest,
    handler: ProtectedHandler,
  ): Promise<ServerResponse> {
    const resource = request.resource ?? { url: request.url };
    const paymentAmount = request.paymentAmount;
    const requiredOptions = paymentRequirementRouteOptions(request);
    const requestedScheme = verificationRequestedScheme(request);
    const paymentHeader = readHeader(request.headers, PAYMENT_SIGNATURE_HEADER);
    if (!paymentHeader) {
      return this.#paymentRequiredResponse({
        resource,
        amount: paymentAmount,
        ...requiredOptions,
      });
    }

    let paymentPayload: PaymentPayload;
    try {
      paymentPayload = await this.extractPayment(paymentHeader);
    } catch {
      return this.#paymentRequiredResponse({
        resource,
        amount: paymentAmount,
        ...requiredOptions,
      });
    }
    if (!isPaymentSchemeAllowed(request, paymentPayload.accepted.scheme)) {
      return this.#paymentRequiredResponse({
        resource,
        amount: paymentAmount,
        ...requiredOptions,
      });
    }

    const paymentLockKey = safePaymentLockKey(paymentPayload);
    if (!paymentLockKey) {
      return this.#paymentRequiredResponse({
        resource,
        amount: paymentAmount,
        ...requiredOptions,
      });
    }
    const paymentIdentifier = readPaymentIdentifier(paymentPayload);
    if (this.#config.requirePaymentIdentifier && !paymentIdentifier) {
      return this.#paymentRequiredResponse({
        resource,
        amount: paymentAmount,
        ...requiredOptions,
      });
    }

    const lockManager =
      this.#config.lockManager ?? new MemoryChannelLockManager();
    const run = async () =>
      lockManager.runExclusive(paymentLockKey, async () => {
        let fingerprint: Hash32Hex;
        try {
          fingerprint =
            request.requestHash ??
            fingerprintRequest(request, paymentPayload.accepted);
        } catch {
          return this.#paymentRequiredResponse({
            resource,
            amount: paymentAmount,
            ...requiredOptions,
          });
        }
        const cached = await this.#checkIdempotency(
          paymentIdentifier,
          fingerprint,
          safePaymentScopeIdHint(paymentPayload),
          paymentPayload,
        );
        if (cached) return cached;
        const batchReplay = await this.#checkBatchReplay(
          paymentPayload,
          fingerprint,
        );
        if (batchReplay) return batchReplay;

        let verified: VerifiedPayment;
        try {
          verified = await this.#verifyPayment(
            paymentPayload,
            resource,
            fingerprint,
            paymentAmount,
            requestedScheme,
          );
        } catch (error) {
          return this.#correctiveResponse(
            resource,
            paymentPayload,
            error,
            paymentAmount,
            requestedScheme,
          );
        }
        const runVerified = async () => {
          if (verified.scheme === "exact") {
            const replay = await this.#checkExactReplay(verified, fingerprint);
            if (replay) return replay;
            try {
              const claim = await this.#claimExactSettlement(
                verified,
                fingerprint,
              );
              verified = await this.#settleExactIfNeeded(verified, claim);
              const handlerStarted = await this.#config.store.beginExactHandler(
                verified.transactionId,
                new Date().toISOString(),
              );
              if (!handlerStarted) {
                return {
                  status: 503,
                  headers: {},
                  body: { error: "exact_settlement_recovery_required" },
                };
              }
            } catch (error) {
              return this.#settlementCorrectiveResponse(
                resource,
                verified,
                error,
                paymentAmount,
                requestedScheme,
              );
            }
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
            chargedAmount =
              handlerResult.chargedAmount ?? verified.accepted.amount;
            if (
              parseSompiString(chargedAmount) >
              parseSompiString(verified.accepted.amount)
            ) {
              throw new KaspaX402Error(
                "invalid_kaspa_settlement_response",
                "handler charge exceeds accepted amount",
              );
            }
            if (
              verified.scheme === "exact" &&
              chargedAmount !== verified.accepted.amount
            ) {
              throw new KaspaX402Error(
                "invalid_kaspa_settlement_response",
                "exact settlement amount must equal the accepted amount",
              );
            }
          } catch (error) {
            await this.#preserveLiveDepositTransition(verified);
            return this.#correctiveResponse(
              resource,
              paymentPayload,
              error,
              paymentAmount,
              requestedScheme,
            );
          }

          if (verified.scheme === "exact") {
            return this.#commitExactResponse(
              verified,
              handlerResult,
              chargedAmount,
              fingerprint,
              paymentIdentifier,
            );
          }
          return this.#commitBatchResponse(
            verified,
            handlerResult,
            chargedAmount,
            fingerprint,
            paymentIdentifier,
          );
        };

        if (verified.scheme !== "exact") return runVerified();
        const verifiedLockKey = exactPaymentScopeId(verified.transactionId);
        return verifiedLockKey === paymentLockKey
          ? runVerified()
          : lockManager.runExclusive(verifiedLockKey, runVerified);
      });

    return paymentIdentifier
      ? lockManager.runExclusive(idempotencyLockKey(paymentIdentifier), run)
      : run();
  }

  async reconcileExactSettlement(
    transactionId: Hash32Hex,
  ): Promise<ExactSettlementAttemptRecord | undefined> {
    const attempt =
      await this.#config.store.loadExactSettlementAttempt(transactionId);
    if (!attempt)
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "exact settlement attempt was not found",
      );
    if (attempt.status === "accepted" || attempt.status === "applied")
      return attempt;
    if (!this.#config.exactSettlementReconciler) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "exact settlement reconciler is required",
      );
    }
    const result =
      await this.#config.exactSettlementReconciler.reconcileExactSettlement(
        attempt,
      );
    if (
      result.transactionId.toLowerCase() !== attempt.transactionId.toLowerCase()
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "exact reconciliation transaction id does not match the stored attempt",
      );
    }
    if (result.status === "unknown") return attempt;
    if (result.status === "rejected") {
      await this.#config.store.abandonExactSettlement(
        attempt.transactionId,
        result.reason,
        new Date().toISOString(),
      );
      return undefined;
    }
    if (
      result.paymentOutput.amount !== attempt.amount ||
      result.paymentOutput.scriptPublicKey.toLowerCase() !==
        attempt.payToScriptPublicKey.toLowerCase()
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "exact reconciliation payment output does not match the stored attempt",
      );
    }
    if (attempt.head) {
      if (
        !result.continuation ||
        !sameOutpoint(
          result.continuation.outpoint,
          attempt.head.successor.outpoint,
        ) ||
        result.continuation.amount !== attempt.head.successor.amount ||
        result.continuation.scriptPublicKey.toLowerCase() !==
          attempt.head.successor.scriptPublicKey.toLowerCase()
      ) {
        throw new KaspaX402Error(
          "invalid_kaspa_transaction",
          "exact reconciliation successor does not match the claimed head",
        );
      }
    } else if (result.continuation) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "standard-native exact reconciliation cannot advance an additive head",
      );
    }
    await this.#config.store.acceptExactSettlement(
      attempt.transactionId,
      result.finality,
      new Date().toISOString(),
    );
    return this.#config.store.loadExactSettlementAttempt(attempt.transactionId);
  }

  async listClaimableChannels(): Promise<ServerChannelRecord[]> {
    const channels = await this.#config.store.listChannels();
    return channels.filter(
      (channel) =>
        channel.status === "active" && activeChargedAmount(channel) > 0n,
    );
  }

  async previewClaim(channelId: Hash32Hex): Promise<ClaimPreview> {
    const channel = await this.#requireChannel(channelId);
    if (channel.status !== "active") {
      throw new KaspaX402Error(
        "invalid_kaspa_channel_id",
        "channel is not active",
      );
    }
    const claimAmount = formatSompiString(activeChargedAmount(channel));
    const estimatedFee =
      await this.#config.chainProvider.estimateClaimFee(channel);
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
        throw new KaspaX402Error(
          "invalid_kaspa_transaction",
          "claim transaction builder is required",
        );
      }
      const preview = await this.previewClaim(channelId);
      const openAttempt =
        await this.#config.store.loadOpenClaimAttempt(channelId);
      if (openAttempt) {
        throw new KaspaX402Error(
          "invalid_kaspa_transaction",
          "claim attempt is already pending",
        );
      }
      if (!preview.claimable) {
        throw new KaspaX402Error(
          "invalid_kaspa_x402_amount",
          preview.reason ?? "claim is not economical",
        );
      }
      const claim = await this.#config.claimBuilder.buildClaimTransaction({
        channel: preview.channel,
        claimAmount: preview.claimAmount,
      });
      if (claim.claimAmount !== preview.claimAmount) {
        throw new KaspaX402Error(
          "invalid_kaspa_transaction",
          "claim transaction amount does not match preview",
        );
      }
      if (
        !claim.continuationOutpoint ||
        !claim.continuationScriptPublicKey ||
        !claim.continuationFundingAmount
      ) {
        throw new KaspaX402Error(
          "invalid_kaspa_transaction",
          "claim transaction must provide continuation channel state",
        );
      }
      const expectedContinuationFunding = formatSompiString(
        parseSompiString(preview.channel.fundingAmount) -
          parseSompiString(claim.claimAmount),
      );
      if (claim.continuationFundingAmount !== expectedContinuationFunding) {
        throw new KaspaX402Error(
          "invalid_kaspa_transaction",
          "claim continuation amount must equal funding minus the authorized claim",
        );
      }
      const attempt: ClaimAttemptRecord = {
        attemptId: claimAttemptId(
          preview.channel,
          claim.transaction,
          claim.claimAmount,
        ),
        channelId: preview.channel.channelId,
        activeOutpoint: preview.channel.activeOutpoint,
        activeScriptPublicKey: preview.channel.activeScriptPublicKey,
        fundingAmount: preview.channel.fundingAmount,
        claimAmount: claim.claimAmount,
        chargedCumulativeAmount: preview.channel.chargedCumulativeAmount,
        claimedCumulativeAmount: preview.channel.claimedCumulativeAmount,
        signedMaxClaimable: preview.channel.signedMaxClaimable,
        ...(preview.channel.voucherSignature
          ? { voucherSignature: preview.channel.voucherSignature }
          : {}),
        channelStatus: preview.channel.status,
        transaction: claim.transaction,
        continuationOutpoint: claim.continuationOutpoint,
        continuationScriptPublicKey: claim.continuationScriptPublicKey,
        continuationFundingAmount: claim.continuationFundingAmount,
        status: "pending",
      };
      await this.#config.store.saveClaimAttempt(attempt);
      const broadcast = await this.#config.chainProvider.sendTransaction(
        claim.transaction,
      );
      const accepted = isAcceptedFinality(
        broadcast.finality,
        this.#config.acceptedFinality,
      );
      const broadcastAttempt: ClaimAttemptRecord = {
        ...attempt,
        transactionId: broadcast.transactionId,
        finality: broadcast.finality,
        status: "broadcast",
      };
      await this.#config.store.saveClaimAttempt(broadcastAttempt);
      let resultFinality = broadcast.finality;
      if (accepted) {
        if (
          claim.continuationOutpoint.txid.toLowerCase() !==
          broadcast.transactionId.toLowerCase()
        ) {
          throw new KaspaX402Error(
            "invalid_kaspa_outpoint",
            "continuation outpoint must belong to the accepted claim transaction",
          );
        }
        const continuation = await this.#verifiedFundingUtxo(
          claim.continuationOutpoint,
          claim.continuationScriptPublicKey,
          claim.continuationFundingAmount,
        );
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

  async abandonClaimAttempt(
    channelId: Hash32Hex,
    reason?: string,
  ): Promise<void> {
    await this.#config.lockManager.runExclusive(channelId, async () => {
      const attempt = await this.#config.store.loadOpenClaimAttempt(channelId);
      if (!attempt) return;
      if (attempt.status === "accepted") {
        throw new KaspaX402Error(
          "invalid_kaspa_transaction",
          "accepted claim attempts must be recovered, not abandoned",
        );
      }
      await this.#config.store.abandonClaimAttempt(attempt.attemptId, reason);
    });
  }

  async recoverAcceptedClaim(
    channelId: Hash32Hex,
    input: ClaimRecoveryInput = {},
  ): Promise<ClaimExecutionResult> {
    return this.#config.lockManager.runExclusive(channelId, async () => {
      const attempt = await this.#config.store.loadOpenClaimAttempt(channelId);
      if (
        !attempt ||
        (attempt.status !== "accepted" &&
          attempt.status !== "broadcast" &&
          attempt.status !== "pending") ||
        (!attempt.transactionId && !input.transactionId)
      ) {
        throw new KaspaX402Error(
          "invalid_kaspa_transaction",
          "accepted claim attempt was not found",
        );
      }
      if (
        attempt.transactionId &&
        input.transactionId &&
        attempt.transactionId.toLowerCase() !==
          input.transactionId.toLowerCase()
      ) {
        throw new KaspaX402Error(
          "invalid_kaspa_transaction",
          "claim recovery transaction id does not match recorded broadcast",
        );
      }
      const transactionId = attempt.transactionId ?? input.transactionId;
      const inputFinality = (input as { finality?: SettlementFinality })
        .finality;
      if (inputFinality === "broadcast") {
        throw new KaspaX402Error(
          "invalid_kaspa_transaction",
          "accepted claim recovery needs accepted transaction evidence",
        );
      }
      const evidenceFinality =
        inputFinality ??
        (attempt.finality === "broadcast" ? undefined : attempt.finality);
      if (!transactionId || !evidenceFinality) {
        throw new KaspaX402Error(
          "invalid_kaspa_transaction",
          "accepted claim recovery needs accepted transaction evidence",
        );
      }
      if (
        !attempt.continuationOutpoint ||
        !attempt.continuationScriptPublicKey ||
        !attempt.continuationFundingAmount
      ) {
        throw new KaspaX402Error(
          "invalid_kaspa_transaction",
          "accepted claim attempt is missing continuation state",
        );
      }
      if (
        attempt.continuationOutpoint.txid.toLowerCase() !==
        transactionId.toLowerCase()
      ) {
        throw new KaspaX402Error(
          "invalid_kaspa_outpoint",
          "continuation outpoint must belong to the accepted claim transaction",
        );
      }
      const channel = await this.#requireChannel(channelId);
      if (
        !sameActiveOutpoint(
          channel,
          attempt.activeOutpoint,
          attempt.activeScriptPublicKey,
        )
      ) {
        throw new KaspaX402Error(
          "invalid_kaspa_outpoint",
          "claim attempt does not match active channel",
        );
      }
      if (
        channel.chargedCumulativeAmount !== attempt.chargedCumulativeAmount ||
        channel.claimedCumulativeAmount !== attempt.claimedCumulativeAmount
      ) {
        throw new KaspaX402Error(
          "invalid_kaspa_settlement_response",
          "channel state changed after claim attempt",
        );
      }
      const continuation = await this.#verifiedFundingUtxo(
        attempt.continuationOutpoint,
        attempt.continuationScriptPublicKey,
        attempt.continuationFundingAmount,
      );
      const updated = {
        ...channel,
        activeOutpoint: attempt.continuationOutpoint,
        activeScriptPublicKey: attempt.continuationScriptPublicKey,
        fundingAmount: attempt.continuationFundingAmount,
        claimedCumulativeAmount: formatSompiString(
          parseSompiString(attempt.claimedCumulativeAmount) +
            parseSompiString(attempt.claimAmount),
        ),
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
    requestedScheme?: "exact" | "batch-settlement",
  ): Promise<VerifiedPayment> {
    const paymentRequired = await this.#expectedPaymentRequired(
      resource,
      paymentPayload,
      paymentAmount,
      requestedScheme,
    );
    return this.#verifyPaymentAgainstRequired(
      paymentRequired,
      paymentPayload,
      requestFingerprint,
    );
  }

  async #verifyPaymentAgainstRequired(
    paymentRequired: PaymentRequired,
    paymentPayload: PaymentPayload,
    requestFingerprint: Hash32Hex,
  ): Promise<VerifiedPayment> {
    const retry = validatePaymentRetry({ paymentRequired, paymentPayload });
    if (!retry.ok) throw retry.error;

    if (paymentPayload.accepted.scheme === "exact") {
      const payload = paymentPayload.payload;
      if (payload.type !== "exact-transaction") {
        throw new KaspaX402Error(
          "invalid_kaspa_payment_payload_type",
          "unsupported exact payment payload type",
        );
      }
      return this.#verifyExactPayment(
        paymentRequired,
        paymentPayload as PaymentPayload & {
          accepted: ExactPaymentRequirements;
          payload: ExactTransactionPayload;
        },
        requestFingerprint,
      );
    }

    if (paymentPayload.accepted.scheme !== "batch-settlement") {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_scheme",
        "server only supports exact and batch-settlement in direct mode",
      );
    }

    const accepted = paymentPayload.accepted as BatchPaymentRequirements;
    const payload = paymentPayload.payload;
    if (payload.type === "deposit-voucher") {
      return this.#verifyDepositVoucher(
        paymentRequired,
        paymentPayload,
        accepted,
        payload,
      );
    }
    if (payload.type === "voucher") {
      return this.#verifyVoucher(
        paymentRequired,
        paymentPayload,
        accepted,
        payload,
      );
    }
    throw new KaspaX402Error(
      "invalid_kaspa_payment_payload_type",
      "unsupported server payment payload type",
    );
  }

  async #verifyExactPayment(
    paymentRequired: ReturnType<typeof makePaymentRequired>,
    paymentPayload: PaymentPayload & {
      accepted: ExactPaymentRequirements;
      payload: ExactTransactionPayload;
    },
    requestFingerprint: Hash32Hex,
  ): Promise<VerifiedExactPayment> {
    const accepted = paymentPayload.accepted;
    const payload = paymentPayload.payload;
    validateExactTerms(this.#config, accepted);
    const profile = exactProfileFromAccepted(accepted);
    if (payload.profile !== profile) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_payload",
        "exact payload profile does not match accepted requirements",
      );
    }
    if (
      payload.requestHash &&
      payload.requestHash.toLowerCase() !== requestFingerprint.toLowerCase()
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_payload",
        "exact payload requestHash does not match request fingerprint",
      );
    }
    if (!this.#config.exactTransactionVerifier) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "exact transaction verifier is required",
      );
    }
    const payToScriptPublicKey =
      this.#config.addressCodec.scriptPublicKeyForAddress(
        accepted.payTo,
        accepted.network,
      );
    const head =
      profile === "additive"
        ? await this.#verifiedExactHead(accepted, payload)
        : undefined;
    const verification =
      await this.#config.exactTransactionVerifier.verifyExactPayment({
        network: accepted.network,
        profile,
        transaction: payload.transaction,
        transactionEncoding: payload.transactionEncoding,
        paymentOutputIndex: payload.paymentOutputIndex,
        amount: accepted.amount,
        payTo: accepted.payTo,
        payToScriptPublicKey,
        requiredFinality: this.#config.acceptedFinality,
        requestHash: requestFingerprint,
        ...(head ? { head } : {}),
      });
    if (!/^[0-9a-fA-F]{64}$/.test(verification.transactionId)) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "exact verifier returned an invalid transaction id",
      );
    }
    if (
      verification.finality !== undefined &&
      !isExactFinality(verification.finality)
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "exact verifier returned an invalid finality",
      );
    }
    if (
      head &&
      Date.parse(head.expiresAt) <= Date.now() &&
      verification.finality !== "accepted" &&
      verification.finality !== "confirmed"
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "additive exact head challenge has expired",
      );
    }
    if (verification.paymentOutput.amount !== accepted.amount) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_amount",
        "exact payment output amount does not match accepted amount",
      );
    }
    if (
      verification.paymentOutput.scriptPublicKey.toLowerCase() !==
      payToScriptPublicKey.toLowerCase()
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_binding",
        "exact payment output script does not match payTo",
      );
    }
    return {
      scheme: "exact",
      profile,
      paymentRequired,
      paymentPayload,
      accepted,
      transactionId: verification.transactionId,
      paymentOutputIndex: payload.paymentOutputIndex,
      transaction: payload.transaction,
      transactionEncoding: payload.transactionEncoding,
      ...(head ? { head } : {}),
      ...(verification.continuation
        ? { continuation: verification.continuation }
        : {}),
      ...(verification.payerAddress
        ? { payerAddress: verification.payerAddress }
        : {}),
      finality: verification.finality ?? "mempool",
      ...(verification.finality
        ? { observedFinality: verification.finality }
        : {}),
    };
  }

  async #verifiedExactHead(
    accepted: ExactPaymentRequirements,
    payload: ExactTransactionPayload,
  ): Promise<ExactHeadChallenge> {
    const head = exactHeadFromAccepted(accepted);
    if (!head) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_payload",
        "additive exact transaction requires complete head challenge terms",
      );
    }
    if (payload.challengeId?.toLowerCase() !== head.challengeId.toLowerCase()) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_payload",
        "additive exact payload challenge does not match accepted requirements",
      );
    }
    if (
      payload.transactionEncoding !== head.transactionEncoding ||
      payload.paymentOutputIndex !== 0
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "additive exact transaction does not match canonical head encoding or output index",
      );
    }
    const { challengeId: _challengeId, ...unsigned } = head;
    const expectedChallengeId = exactHeadChallengeId(
      accepted.network,
      accepted.payTo,
      accepted.amount,
      unsigned,
    );
    if (expectedChallengeId.toLowerCase() !== head.challengeId.toLowerCase()) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_payload",
        "additive exact challenge id does not bind its advertised terms",
      );
    }
    const stored = await this.#config.store.loadExactHead(head.headId);
    if (
      !stored ||
      stored.status === "unavailable" ||
      stored.status === "retired"
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "additive exact head is unavailable",
      );
    }
    if (
      stored.network !== accepted.network ||
      stored.payTo !== accepted.payTo ||
      stored.templateId !== head.templateId ||
      stored.transactionEncoding !== head.transactionEncoding ||
      stored.scriptPublicKey.toLowerCase() !==
        head.headScriptPublicKey.toLowerCase() ||
      stored.redeemScript.toLowerCase() !==
        head.headRedeemScript.toLowerCase() ||
      stored.additiveThresholdSompi !== head.additiveThresholdSompi
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "additive exact head does not match durable lineage terms",
      );
    }
    return head;
  }

  async #verifyDepositVoucher(
    paymentRequired: ReturnType<typeof makePaymentRequired>,
    paymentPayload: PaymentPayload,
    accepted: BatchPaymentRequirements,
    payload: DepositVoucherPayload,
  ): Promise<VerifiedPayment> {
    validateChannelTerms(this.#config, accepted, payload.channelConfig);
    await this.#assertRefundWindow(payload.channelConfig.refundTimeoutDaa);
    if (channelId(payload.channelConfig) !== payload.channelId) {
      throw new KaspaX402Error(
        "invalid_kaspa_channel_id",
        "channel id does not match channel config",
      );
    }
    const derived = deriveServerEscrow(this.#config, payload.channelConfig);
    if (derived.escrowAddress !== payload.escrowAddress) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_binding",
        "escrow address does not match channel config",
      );
    }
    if (
      derived.activeScriptPublicKey.toLowerCase() !==
      payload.activeScriptPublicKey.toLowerCase()
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_binding",
        "active script does not match channel config",
      );
    }
    if (
      parseSompiString(payload.fundingAmountSompi) <
      parseSompiString(accepted.extra.minDepositSompi)
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_amount",
        "deposit is below the required minimum",
      );
    }

    const utxo = await this.#verifiedFundingUtxo(
      payload.fundingOutpoint,
      payload.activeScriptPublicKey,
      payload.fundingAmountSompi,
    );
    const existing = await this.#config.store.loadChannel(payload.channelId);
    if (existing && existing.status !== "active") {
      throw new KaspaX402Error(
        "invalid_kaspa_channel_id",
        "existing channel is not active",
      );
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
      signedMaxClaimable:
        existing &&
        sameActiveOutpoint(
          existing,
          payload.fundingOutpoint,
          payload.activeScriptPublicKey,
        )
          ? existing.signedMaxClaimable
          : "0",
      voucherSignature:
        existing &&
        sameActiveOutpoint(
          existing,
          payload.fundingOutpoint,
          payload.activeScriptPublicKey,
        )
          ? existing.voucherSignature
          : undefined,
      lastCommitmentId: existing?.lastCommitmentId,
      status: "active",
    };

    if (
      existing &&
      !sameActiveOutpoint(
        existing,
        payload.fundingOutpoint,
        payload.activeScriptPublicKey,
      )
    ) {
      if (!this.#config.topUpVerifier) {
        throw new KaspaX402Error(
          "invalid_kaspa_outpoint",
          "top-up transition verifier is required",
        );
      }
      const verified = await this.#config.topUpVerifier.verifyTopUp({
        previous: existing,
        next: initial,
        utxo,
        payment: paymentPayload,
      });
      if (!verified)
        throw new KaspaX402Error(
          "invalid_kaspa_outpoint",
          "top-up transition was rejected",
        );
    }

    await this.#verifyVoucherAmountAndSignature(
      initial,
      accepted,
      payload.voucher,
    );
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
    await this.#assertRefundWindow(channel.channelConfig.refundTimeoutDaa);
    if (channel.status !== "active") {
      throw new KaspaX402Error(
        "invalid_kaspa_channel_id",
        "channel is not active",
      );
    }
    await this.#rejectOpenClaimAttempt(channel.channelId);
    if (payload.clientPublicKey !== channel.channelConfig.clientPublicKey) {
      throw new KaspaX402Error(
        "invalid_kaspa_public_key",
        "client public key does not match channel",
      );
    }
    if (
      !sameActiveOutpoint(
        channel,
        payload.fundingOutpoint,
        payload.activeScriptPublicKey,
      )
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_outpoint",
        "payment outpoint does not match active channel",
      );
    }
    await this.#verifiedFundingUtxo(
      payload.fundingOutpoint,
      payload.activeScriptPublicKey,
      channel.fundingAmount,
    );
    await this.#verifyVoucherAmountAndSignature(
      channel,
      accepted,
      payload.voucher,
    );
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

  async #verifyVoucherAmountAndSignature(
    channel: ServerChannelRecord,
    accepted: BatchPaymentRequirements,
    voucher: Voucher,
  ): Promise<void> {
    validateChannelPreVoucherAccounting(channel);
    const requiredVoucherAmount = maxAmount(
      channel.signedMaxClaimable,
      formatSompiString(
        activeChargedAmount(channel) + parseSompiString(accepted.amount),
      ),
    );
    if (voucher.amount !== requiredVoucherAmount) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_amount",
        "voucher amount does not match required cumulative amount",
      );
    }
    if (
      parseSompiString(voucher.amount) > parseSompiString(channel.fundingAmount)
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_amount",
        "voucher amount exceeds active funding amount",
      );
    }
    const reserve = await this.#minimumActiveReserve(channel);
    if (
      parseSompiString(voucher.amount) + reserve >
      parseSompiString(channel.fundingAmount)
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_amount",
        "voucher amount does not leave required claim reserve",
      );
    }
    validateChannelAccounting({
      ...channel,
      signedMaxClaimable: voucher.amount,
      voucherSignature: voucher.signature,
    });
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
    if (!verified)
      throw new KaspaX402Error(
        "invalid_kaspa_signature",
        "voucher signature was rejected",
      );
  }

  async #minimumActiveReserve(channel: ServerChannelRecord): Promise<bigint> {
    return parseSompiString(
      await this.#config.chainProvider.estimateClaimFee(channel),
    );
  }

  async #assertRefundWindow(timeoutDaa: SompiString): Promise<void> {
    const timeout = parseSompiString(timeoutDaa);
    const current = parseSompiString(
      await this.#config.chainProvider.getVirtualDaaScore(),
    );
    const lead = parseSompiString(this.#config.minimumRefundLeadDaa);
    if (timeout >= KASPA_LOCK_TIME_THRESHOLD) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_payload",
        "refund timeout crosses the consensus timestamp boundary",
      );
    }
    if (current + lead >= timeout) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_payload",
        "escrow is too close to its absolute DAA refund threshold",
      );
    }
    if (this.#config.allowRollingRefundTimeoutDaa) {
      const horizon = parseSompiString(this.#config.maximumRefundHorizonDaa!);
      if (timeout > current + horizon) {
        throw new KaspaX402Error(
          "invalid_kaspa_x402_payload",
          "refund timeout exceeds the server rolling DAA horizon",
        );
      }
    }
  }

  async #rejectOpenClaimAttempt(channelId: Hash32Hex): Promise<void> {
    const openAttempt =
      await this.#config.store.loadOpenClaimAttempt(channelId);
    if (openAttempt) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "channel has an open claim attempt",
      );
    }
  }

  async #verifiedFundingUtxo(
    outpoint: FundingOutpoint,
    activeScriptPublicKey: string,
    fundingAmount: SompiString,
  ): Promise<ChainUtxo> {
    const utxo = await this.#config.chainProvider.getUtxo(
      outpoint,
      this.#config.network,
    );
    if (!utxo)
      throw new KaspaX402Error(
        "invalid_kaspa_outpoint",
        "funding outpoint was not found",
      );
    if (!isAcceptedFinality(utxo.finality, this.#config.acceptedFinality)) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "funding outpoint has not reached required finality",
      );
    }
    if (
      utxo.scriptPublicKey.toLowerCase() !== activeScriptPublicKey.toLowerCase()
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_binding",
        "funding script does not match active script",
      );
    }
    if (utxo.amount !== fundingAmount) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_amount",
        "funding amount does not match payment payload",
      );
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
      pending = this.#buildSuccessfulSettlement(
        verified,
        chargedAmount,
        fingerprint,
        paymentIdentifier,
      );
    } catch (error) {
      await this.#preserveLiveDepositTransition(verified);
      return this.#correctiveResponse(
        verified.paymentRequired.resource,
        verified.paymentPayload,
        error,
        verified.accepted.amount,
        "batch-settlement",
      );
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
        expected: expectedSettlementChannelState(
          verified.commitExpectedChannel,
        ),
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
    const pending = this.#buildSuccessfulExactSettlement(
      verified,
      chargedAmount,
      fingerprint,
    );
    const response: ServerResponse = {
      status: handlerResult.status ?? 200,
      headers: {
        ...(handlerResult.headers ?? {}),
        [PAYMENT_RESPONSE_HEADER]: encodePaymentResponseHeader(
          pending.settlement,
        ),
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
                paymentScopeId:
                  safePaymentScopeIdHint(verified.paymentPayload) ??
                  exactPaymentScopeId(verified.transactionId),
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

  async #preserveLiveDepositTransition(
    verified: VerifiedPayment,
  ): Promise<void> {
    if (
      verified.scheme !== "batch-settlement" ||
      verified.paymentPayload.payload.type !== "deposit-voucher"
    )
      return;
    const channel: ServerChannelRecord = {
      ...verified.channel,
      signedMaxClaimable: verified.voucher.amount,
      voucherSignature: verified.voucher.signature,
      status: "active",
    };
    validateChannelAccounting(channel);
    await this.#config.store.saveChannel(channel);
  }

  async #claimExactSettlement(
    verified: VerifiedExactPayment,
    fingerprint: Hash32Hex,
  ): Promise<ExactSettlementClaimResult> {
    if (!verified.transaction) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "exact transaction artifact is required",
      );
    }
    const now = new Date().toISOString();
    const attempt: ExactSettlementAttemptRecord = {
      transactionId: verified.transactionId,
      profile: verified.profile,
      amount: verified.accepted.amount,
      paymentOutputIndex: verified.paymentOutputIndex,
      requestFingerprint: fingerprint,
      paymentRequirementsHash: sha256Hex(stableStringify(verified.accepted)),
      paymentPayloadHash: paymentPayloadHash(verified.paymentPayload),
      payToScriptPublicKey: verified.accepted.extra.payToScriptPublicKey!,
      transaction: verified.transaction,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      ...(verified.head && verified.continuation
        ? {
            head: {
              headId: verified.head.headId,
              expectedVersion: verified.head.headVersion,
              expectedOutpoint: verified.head.expectedHeadOutpoint,
              expectedAmount: verified.head.headAmount,
              successor: verified.continuation,
            },
          }
        : {}),
    };
    if (verified.profile === "additive" && !attempt.head) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "additive exact verification did not prove a successor head",
      );
    }
    try {
      return await this.#config.store.claimExactSettlement(attempt);
    } catch (error) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        error instanceof Error
          ? error.message
          : "exact settlement claim failed",
      );
    }
  }

  async #settleExactIfNeeded(
    verified: VerifiedExactPayment,
    claim: ExactSettlementClaimResult,
  ): Promise<VerifiedExactPayment> {
    if (!verified.transaction) return verified;
    if (
      claim.attempt.status === "accepted" ||
      claim.attempt.status === "applied"
    ) {
      if (
        claim.attempt.finality !== "accepted" &&
        claim.attempt.finality !== "confirmed"
      ) {
        throw new KaspaX402Error(
          "invalid_kaspa_transaction",
          "accepted exact settlement is missing durable finality",
        );
      }
      return { ...verified, finality: claim.attempt.finality };
    }
    if (
      (verified.observedFinality === "accepted" ||
        verified.observedFinality === "confirmed") &&
      exactFinalityMeets(
        verified.observedFinality,
        this.#config.acceptedFinality,
      ) &&
      (!verified.accepted.extra.finality ||
        exactFinalityMeets(
          verified.observedFinality,
          verified.accepted.extra.finality,
        ))
    ) {
      await this.#config.store.acceptExactSettlement(
        verified.transactionId,
        verified.observedFinality,
        new Date().toISOString(),
      );
      return { ...verified, finality: verified.observedFinality };
    }
    if (!claim.created) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "exact settlement is pending trusted chain reconciliation and will not be rebroadcast",
      );
    }
    let broadcast: TransactionBroadcast;
    try {
      broadcast = await this.#config.chainProvider.sendTransaction(
        verified.transaction,
      );
    } catch {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "exact settlement broadcast outcome is ambiguous and requires trusted chain reconciliation",
      );
    }
    if (
      broadcast.transactionId.toLowerCase() !==
      verified.transactionId.toLowerCase()
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "broadcast transaction id does not match exact verifier",
      );
    }
    if (
      broadcast.finality !== "broadcast" &&
      !isExactFinality(broadcast.finality)
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "exact transaction broadcast did not reach observable finality",
      );
    }
    await this.#config.store.recordExactSettlementBroadcast(
      verified.transactionId,
      broadcast.finality,
      new Date().toISOString(),
    );
    if (broadcast.finality === "broadcast") {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "exact transaction broadcast did not reach required finality",
      );
    }
    if (
      !exactFinalityMeets(broadcast.finality, this.#config.acceptedFinality)
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "exact transaction broadcast did not reach required finality",
      );
    }
    if (
      verified.accepted.extra.finality &&
      !exactFinalityMeets(broadcast.finality, verified.accepted.extra.finality)
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "exact transaction broadcast did not reach advertised finality",
      );
    }
    await this.#config.store.acceptExactSettlement(
      broadcast.transactionId,
      broadcast.finality,
      new Date().toISOString(),
    );
    return {
      ...verified,
      transactionId: broadcast.transactionId,
      finality: broadcast.finality,
    };
  }

  #buildSuccessfulSettlement(
    verified: VerifiedBatchPayment,
    chargedAmount: SompiString,
    fingerprint: Hash32Hex,
    paymentIdentifier?: string,
  ): PendingSettlement {
    const chargedCumulativeAmount = formatSompiString(
      parseSompiString(verified.channel.chargedCumulativeAmount) +
        parseSompiString(chargedAmount),
    );
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
      transaction: commitmentId,
      network: this.#config.network,
      payer: verified.channel.channelConfig.refundAddress,
      amount: chargedAmount,
      extensions: kaspaSettlementExtensions({
        commitmentId,
        ...(verified.paymentPayload.payload.type === "deposit-voucher"
          ? { fundingAmount: channel.fundingAmount }
          : {}),
        chargedAmount,
        channelState: channelState(channel),
      }),
    };
    return {
      channel,
      settlement,
      commitment: {
        commitmentId,
        channelId: channel.channelId,
        requestFingerprint: fingerprint,
        paymentRequirementsHash: bytesToHex(
          batchPaymentRequirementsHash(verified.accepted),
        ),
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

  #buildSuccessfulExactSettlement(
    verified: VerifiedExactPayment,
    chargedAmount: SompiString,
    fingerprint: Hash32Hex,
  ): PendingExactSettlement {
    const settlement: SettlementResponse = {
      success: true,
      transaction: verified.transactionId,
      network: this.#config.network,
      ...(verified.payerAddress ? { payer: verified.payerAddress } : {}),
      amount: chargedAmount,
      extensions: kaspaSettlementExtensions({
        exactProfile: verified.profile,
        paymentOutputIndex: verified.paymentOutputIndex,
        finality: verified.finality,
        requestHash: fingerprint,
        ...(verified.transactionEncoding
          ? { transactionEncoding: verified.transactionEncoding }
          : {}),
        ...(verified.head
          ? {
              templateId: verified.head.templateId,
              headId: verified.head.headId,
              headVersion: verified.head.headVersion,
              headOutpoint: verified.head.expectedHeadOutpoint,
            }
          : {}),
      }),
    };
    return {
      settlement,
      payment: {
        profile: verified.profile,
        transactionId: verified.transactionId,
        paymentOutputIndex: verified.paymentOutputIndex,
        requestFingerprint: fingerprint,
        paymentRequirementsHash: sha256Hex(stableStringify(verified.accepted)),
        paymentPayloadHash: paymentPayloadHash(verified.paymentPayload),
        amount: chargedAmount,
        ...(verified.payerAddress
          ? { payerAddress: verified.payerAddress }
          : {}),
        finality: verified.finality,
        settlement,
      },
    };
  }

  async #checkIdempotency(
    paymentIdentifier: string | undefined,
    fingerprint: Hash32Hex,
    paymentScopeId: Hash32Hex | undefined,
    paymentPayload: PaymentPayload,
  ): Promise<ServerResponse | undefined> {
    if (!paymentIdentifier) return undefined;
    const record =
      await this.#config.store.loadPaymentIdentifier(paymentIdentifier);
    if (!record) return undefined;
    const currentPayloadHash = paymentPayloadHash(paymentPayload);
    const fingerprintMatches = record.fingerprint === fingerprint;
    const scopeMatches = paymentIdentifierScopeMatches(record, paymentScopeId);
    const payloadMatches = record.paymentPayloadHash === currentPayloadHash;
    if (!fingerprintMatches || !scopeMatches) {
      return paymentIdentifierConflictResponse();
    }
    if (!payloadMatches) {
      return paymentIdentifierConflictResponse();
    }
    return record.response;
  }

  async #checkExactReplay(
    verified: VerifiedExactPayment,
    fingerprint: Hash32Hex,
  ): Promise<ServerResponse | undefined> {
    const record = await this.#config.store.loadExactPayment(
      verified.transactionId,
    );
    if (!record) return undefined;
    if (
      record.requestFingerprint === fingerprint &&
      record.paymentOutputIndex === verified.paymentOutputIndex
    ) {
      return record.response;
    }
    return {
      status: 409,
      headers: {},
      body: {
        error: toX402ErrorReason("exact_payment_replay"),
      },
    };
  }

  async #checkBatchReplay(
    paymentPayload: PaymentPayload,
    fingerprint: Hash32Hex,
  ): Promise<ServerResponse | undefined> {
    if (paymentPayload.accepted.scheme !== "batch-settlement") return undefined;
    const channelId = safePaymentChannelId(paymentPayload);
    if (!channelId) return undefined;
    const channel = await this.#config.store.loadChannel(channelId);
    if (!channel?.lastCommitmentId) return undefined;
    const record = await this.#config.store.loadCommitment(
      channel.lastCommitmentId,
    );
    if (!record) return undefined;
    const payload = paymentPayload.payload;
    if (payload.type !== "deposit-voucher" && payload.type !== "voucher")
      return undefined;
    if (record.requestFingerprint !== fingerprint) return undefined;
    if (record.channelId !== channelId) return undefined;
    if (
      record.paymentRequirementsHash !==
      bytesToHex(batchPaymentRequirementsHash(paymentPayload.accepted))
    )
      return undefined;
    if (
      !sameActiveOutpoint(
        {
          activeOutpoint: record.activeOutpoint,
          activeScriptPublicKey: record.activeScriptPublicKey,
        },
        payload.fundingOutpoint,
        payload.activeScriptPublicKey,
      )
    ) {
      return undefined;
    }
    if (
      record.voucher.amount !== payload.voucher.amount ||
      record.voucher.signature !== payload.voucher.signature
    )
      return undefined;
    return record.response;
  }

  async #assertVerifyNotReplayed(
    verified: VerifiedPayment,
    fingerprint: Hash32Hex,
    paymentPayload: PaymentPayload,
  ): Promise<void> {
    if (verified.scheme === "exact") {
      const record = await this.#config.store.loadExactPayment(
        verified.transactionId,
      );
      if (!record) return;
      if (
        record.requestFingerprint === fingerprint &&
        record.paymentOutputIndex === verified.paymentOutputIndex
      ) {
        return;
      }
      throw new KaspaX402Error(
        "invalid_kaspa_exact_replay",
        "exact payment was already used for another request",
      );
    }
  }

  async #settlementCorrectiveResponse(
    resource: ResourceInfo,
    verified: VerifiedPayment,
    error: unknown,
    paymentAmount?: SompiString,
    requestedScheme?: "exact" | "batch-settlement",
  ): Promise<ServerResponse> {
    if (
      verified.scheme === "exact" &&
      verified.paymentPayload.payload.type === "exact-transaction"
    ) {
      const errorReason =
        error instanceof KaspaX402Error
          ? toX402ErrorReason(error.code)
          : "invalid_payload";
      const message = error instanceof Error ? error.message : "";
      if (!message.includes("exact head changed before settlement claim")) {
        return {
          status: 503,
          headers: {},
          body: { error: "exact_settlement_recovery_required" },
        };
      }
      const paymentRequired = await this.#buildRuntimePaymentRequired({
        resource,
        amount: paymentAmount,
        scheme: "exact",
        error: errorReason,
      });
      return {
        status: 402,
        headers: {
          [PAYMENT_REQUIRED_HEADER]:
            encodePaymentRequiredHeader(paymentRequired),
        },
        body: {
          error: errorReason,
        },
      };
    }
    return this.#correctiveResponse(
      resource,
      verified.paymentPayload,
      error,
      paymentAmount,
      requestedScheme,
    );
  }

  async #correctiveResponse(
    resource: ResourceInfo,
    paymentPayload: PaymentPayload,
    error: unknown,
    paymentAmount?: SompiString,
    requestedScheme?: "exact" | "batch-settlement",
  ): Promise<ServerResponse> {
    const errorReason =
      error instanceof KaspaX402Error
        ? toX402ErrorReason(error.code)
        : "invalid_payload";
    const channelId = safePaymentChannelId(paymentPayload);
    const channel = channelId
      ? await this.#config.store.loadChannel(channelId)
      : undefined;
    const activeChannel = channel?.status === "active" ? channel : undefined;
    const reusableChannel =
      activeChannel && (await this.#canReuseCorrectiveChannel(activeChannel))
        ? activeChannel
        : undefined;
    const scheme =
      paymentPayload.accepted.scheme === "exact"
        ? paymentPayload.accepted.scheme
        : requestedScheme;
    const paymentRequired = await this.#paymentRequiredResponse({
      resource,
      amount: paymentAmount,
      scheme,
      error: errorReason,
      ...(reusableChannel
        ? {
            channel: reusableChannel,
            voucherState: latestVoucher(reusableChannel),
          }
        : {}),
    });
    return {
      ...paymentRequired,
      body: {
        error: errorReason,
      },
    };
  }

  async #requireChannel(channelId: Hash32Hex): Promise<ServerChannelRecord> {
    const channel = await this.#config.store.loadChannel(channelId);
    if (!channel)
      throw new KaspaX402Error("invalid_kaspa_channel_id", "channel not found");
    return channel;
  }

  async #canReuseCorrectiveChannel(
    channel: ServerChannelRecord,
  ): Promise<boolean> {
    try {
      await this.#assertRefundWindow(channel.channelConfig.refundTimeoutDaa);
      return true;
    } catch {
      return false;
    }
  }

  async #expectedPaymentRequired(
    resource: ResourceInfo,
    paymentPayload: PaymentPayload,
    paymentAmount?: SompiString,
    requestedScheme?: "exact" | "batch-settlement",
  ): Promise<PaymentRequired> {
    const payloadChannelId = safePaymentChannelId(paymentPayload);
    const accepted = paymentPayload.accepted;
    if (accepted.scheme === "exact") {
      if (exactRequirementMatchesRoute(this.#config, accepted, paymentAmount)) {
        return {
          x402Version: X402_VERSION,
          resource,
          accepts: [accepted],
          ...requiredPaymentIdentifierExtensions(this.#config),
        };
      }
      return this.#buildRuntimePaymentRequired({
        resource,
        amount: paymentAmount,
        scheme: "exact",
      });
    }
    if (accepted.scheme !== "batch-settlement" || !payloadChannelId) {
      return this.buildPaymentRequired({
        resource,
        amount: paymentAmount,
        scheme: requestedScheme,
      });
    }
    const channel = await this.#config.store.loadChannel(payloadChannelId);
    const acceptedExtra = accepted.extra;
    if (!channel || channel.status !== "active") {
      if (
        this.#config.allowRollingRefundTimeoutDaa &&
        paymentPayload.payload.type === "deposit-voucher" &&
        !acceptedExtra.channelState &&
        !acceptedExtra.voucherState &&
        batchRequirementMatchesRoute(this.#config, accepted, paymentAmount)
      ) {
        return {
          x402Version: X402_VERSION,
          resource,
          accepts: [accepted],
          ...requiredPaymentIdentifierExtensions(this.#config),
        };
      }
      return this.buildPaymentRequired({
        resource,
        amount: paymentAmount,
        scheme: "batch-settlement",
      });
    }
    if (!acceptedExtra.channelState && !acceptedExtra.voucherState) {
      if (
        batchRequirementMatchesRoute(this.#config, accepted, paymentAmount) &&
        accepted.extra.refundTimeoutDaa ===
          channel.channelConfig.refundTimeoutDaa
      ) {
        return {
          x402Version: X402_VERSION,
          resource,
          accepts: [accepted],
          ...requiredPaymentIdentifierExtensions(this.#config),
        };
      }
      return this.buildPaymentRequired({
        resource,
        amount: paymentAmount,
        scheme: "batch-settlement",
        channel,
      });
    }
    return this.buildPaymentRequired({
      resource,
      amount: paymentAmount,
      scheme: "batch-settlement",
      channel,
      voucherState: latestVoucher(channel),
    });
  }

  #facilitatorPaymentRequired(
    resource: ResourceInfo,
    paymentRequirements: PaymentRequirements,
  ): PaymentRequired {
    return {
      x402Version: X402_VERSION,
      resource,
      accepts: [paymentRequirements],
      ...requiredPaymentIdentifierExtensions(this.#config),
    };
  }
}

function makePaymentRequired(
  config: ResolvedServerConfig,
  options: BuildPaymentRequiredOptions,
): PaymentRequired {
  return {
    x402Version: X402_VERSION,
    resource: options.resource,
    accepts: paymentRequirementSchemes(options).map((scheme) =>
      makeAcceptedRequirement(config, options, scheme),
    ),
    ...(options.error ? { error: options.error } : {}),
    ...requiredPaymentIdentifierExtensions(config),
  };
}

function makeExactHeadChallenge(
  head: ExactHeadRecord,
  amount: SompiString,
  maxTimeoutSeconds: number,
): ExactHeadChallenge {
  const expiresAt = new Date(
    Date.now() + maxTimeoutSeconds * 1_000,
  ).toISOString();
  const unsigned: Omit<ExactHeadChallenge, "challengeId"> = {
    headId: head.headId,
    headVersion: head.version,
    templateId: head.templateId,
    transactionEncoding: head.transactionEncoding,
    expectedHeadOutpoint: head.currentOutpoint,
    headAmount: head.currentAmount,
    headScriptPublicKey: head.scriptPublicKey,
    headRedeemScript: head.redeemScript,
    additiveThresholdSompi: head.additiveThresholdSompi,
    paymentOutputIndex: 0,
    expiresAt,
  };
  return {
    ...unsigned,
    challengeId: exactHeadChallengeId(
      head.network,
      head.payTo,
      amount,
      unsigned,
    ),
  };
}

function exactHeadChallengeId(
  network: ExactPaymentRequirements["network"],
  payTo: string,
  amount: SompiString,
  head: Omit<ExactHeadChallenge, "challengeId">,
): Hash32Hex {
  return sha256Hex(
    stableStringify({
      scope: "kaspa:x402:additive-head-challenge:v1",
      network,
      payTo,
      amount,
      ...head,
    }),
  );
}

function makeAcceptedRequirement(
  config: ResolvedServerConfig,
  options: BuildPaymentRequiredOptions,
  scheme: "exact" | "batch-settlement",
): ExactPaymentRequirements | BatchPaymentRequirements {
  if (scheme === "exact") {
    const amount = options.amount ?? config.amount;
    if (parseSompiString(amount) <= 0n) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_amount",
        "exact payment amount must be positive",
      );
    }
    const payToScriptPublicKey = config.addressCodec.scriptPublicKeyForAddress(
      config.payTo,
      config.network,
    );
    if (config.exactProfile === "additive" && !options.exactHead) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_payload",
        "additive exact requirements require head terms",
      );
    }
    if (options.exactHead) {
      assertExactHeadPolicy(
        options.exactHead,
        amount,
        payToScriptPublicKey,
        config.minimumExactAdditiveThresholdSompi,
      );
    }
    return {
      scheme: "exact",
      network: config.network,
      amount,
      asset: "KAS",
      payTo: config.payTo,
      maxTimeoutSeconds: config.maxTimeoutSeconds,
      extra: {
        binding: "kaspa-exact-v2",
        profile: config.exactProfile,
        finality: config.acceptedFinality,
        transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
        payToScriptPublicKey,
        ...(options.exactHead
          ? {
              templateId: options.exactHead.templateId,
              transactionEncoding: options.exactHead.transactionEncoding,
              headId: options.exactHead.headId,
              headVersion: options.exactHead.headVersion,
              expectedHeadOutpoint: options.exactHead.expectedHeadOutpoint,
              headAmount: options.exactHead.headAmount,
              headScriptPublicKey: options.exactHead.headScriptPublicKey,
              headRedeemScript: options.exactHead.headRedeemScript,
              additiveThresholdSompi: options.exactHead.additiveThresholdSompi,
              paymentOutputIndex: options.exactHead.paymentOutputIndex,
              challengeId: options.exactHead.challengeId,
              challengeExpiresAt: options.exactHead.expiresAt,
            }
          : {}),
      },
    };
  }

  return {
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
      refundTimeoutDaa:
        options.channel?.channelConfig.refundTimeoutDaa ??
        config.refundTimeoutDaa,
      ...(config.claimPolicy ? { claimPolicy: config.claimPolicy } : {}),
      ...(options.channel
        ? { channelState: channelState(options.channel) }
        : {}),
      ...(options.voucherState ? { voucherState: options.voucherState } : {}),
    },
  };
}

function paymentRequirementSchemes(
  options: BuildPaymentRequiredOptions,
): Array<"exact" | "batch-settlement"> {
  const schemes =
    options.schemes && options.schemes.length > 0
      ? options.schemes
      : [options.scheme ?? "batch-settlement"];
  return [...new Set(schemes)];
}

function paymentRequirementRouteOptions(
  request: PaidRequest,
): Pick<BuildPaymentRequiredOptions, "scheme" | "schemes"> {
  if (request.paymentSchemes !== undefined)
    return { schemes: request.paymentSchemes };
  return { scheme: request.paymentScheme };
}

function verificationRequestedScheme(
  request: PaidRequest,
): "exact" | "batch-settlement" | undefined {
  if (request.paymentSchemes !== undefined)
    return request.paymentSchemes.length === 1
      ? request.paymentSchemes[0]
      : undefined;
  return request.paymentScheme;
}

function isPaymentSchemeAllowed(
  request: PaidRequest,
  scheme: "exact" | "batch-settlement",
): boolean {
  if (request.paymentSchemes !== undefined)
    return request.paymentSchemes.includes(scheme);
  return (
    request.paymentScheme === undefined || request.paymentScheme === scheme
  );
}

function requiredPaymentIdentifierExtensions(
  config: Pick<ResolvedServerConfig, "requirePaymentIdentifier">,
): Pick<PaymentRequired, "extensions"> | Record<string, never> {
  return config.requirePaymentIdentifier
    ? {
        extensions: {
          "payment-identifier": paymentIdentifierExtension({
            required: true,
          }),
        },
      }
    : {};
}

function facilitatorResource(): ResourceInfo {
  return { url: "kaspa-x402:facilitator" };
}

function facilitatorRequestFingerprint(
  options: DirectPaymentVerificationOptions,
): Hash32Hex {
  if (options.requestHash !== undefined)
    return normalizedFacilitatorRequestHash(options.requestHash);
  const payload = options.paymentPayload.payload;
  if (payload.type === "exact-transaction" && payload.requestHash)
    return payload.requestHash.toLowerCase();
  return sha256Hex(
    stableStringify({
      scope: "kaspa:x402:facilitator-request:v1",
      resource: options.resource ?? null,
      paymentRequirements: options.paymentRequirements,
      paymentPayloadHash: paymentPayloadHash(options.paymentPayload),
    }),
  );
}

function normalizedFacilitatorRequestHash(requestHash: unknown): Hash32Hex {
  hexToBytes(requestHash, {
    expectedLength: 32,
    errorCode: "invalid_kaspa_x402_payload",
    label: "requestHash",
  });
  return (requestHash as string).toLowerCase();
}

function validatedPaymentPayload(paymentPayload: unknown): PaymentPayload {
  const result = validatePaymentPayload(paymentPayload);
  if (!result.ok) throw result.error;
  return result.value;
}

function validatedPaymentRequired(paymentRequired: unknown): PaymentRequired {
  const result = validatePaymentRequired(paymentRequired);
  if (!result.ok) throw result.error;
  return result.value;
}

function verifiedPaymentSummary(
  payment: VerifiedPayment,
): Pick<DirectPaymentVerification, "payer" | "extra"> {
  if (payment.scheme === "exact") {
    return {
      ...(payment.payerAddress ? { payer: payment.payerAddress } : {}),
      extra: {
        paymentOutputIndex: payment.paymentOutputIndex,
        finality: payment.finality,
      },
    };
  }
  return {
    payer: payment.channel.channelConfig.refundAddress,
    extra: {
      channelState: channelState(payment.channel),
    },
  };
}

function assertSettlementRequirements(
  authorized: PaymentRequirements,
  settlement: PaymentRequirements,
): void {
  const authorizedComparable = comparableRequirements(authorized);
  const settlementComparable = comparableRequirements(settlement);
  if (
    stableStringify(authorizedComparable) !==
    stableStringify(settlementComparable)
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_accepted",
      "settlement requirements do not match the authorized payment requirements",
    );
  }

  const authorizedAmount = parseSompiString(authorized.amount);
  const settlementAmount = parseSompiString(settlement.amount);
  if (authorized.scheme === "exact" && settlementAmount !== authorizedAmount) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_amount",
      "exact settlement amount must equal the authorized amount",
    );
  }
  if (settlementAmount > authorizedAmount) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_amount",
      "settlement amount exceeds the authorized amount",
    );
  }
}

function comparableRequirements(
  requirements: PaymentRequirements,
): PaymentRequirements {
  return {
    ...requirements,
    amount: "0",
  } as PaymentRequirements;
}

function settlementFromServerResponse(
  response: ServerResponse,
  network: PaymentRequirements["network"],
): SettlementResponse {
  const paymentResponseHeader = readResponseHeader(
    response.headers,
    PAYMENT_RESPONSE_HEADER,
  );
  if (paymentResponseHeader)
    return decodePaymentResponseHeader(paymentResponseHeader);
  return {
    success: false,
    errorReason: errorMessageFromBody(response.body),
    transaction: "",
    network,
  };
}

function readResponseHeader(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const found = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return found?.[1];
}

function errorMessageFromBody(body: unknown): string {
  if (typeof body === "string") return body;
  if (isRecord(body) && typeof body.error === "string") return body.error;
  return "invalid_payload";
}

function validateExactTerms(
  config: ResolvedServerConfig,
  accepted: ExactPaymentRequirements,
): void {
  if (accepted.network !== config.network) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_network",
      "payment network does not match server config",
    );
  }
  if (accepted.asset !== "KAS") {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_asset",
      "payment asset does not match server config",
    );
  }
  if (accepted.payTo !== config.payTo) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      "payTo does not match server config",
    );
  }
  if (accepted.extra.binding !== "kaspa-exact-v2") {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_binding",
      "exact binding does not match server config",
    );
  }
  if (exactProfileFromAccepted(accepted) !== config.exactProfile) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_binding",
      "exact profile does not match server config",
    );
  }
  const payToScriptPublicKey = config.addressCodec.scriptPublicKeyForAddress(
    accepted.payTo,
    accepted.network,
  );
  if (
    accepted.extra.payToScriptPublicKey?.toLowerCase() !==
    payToScriptPublicKey.toLowerCase()
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_binding",
      "exact payTo script does not match server derivation",
    );
  }
  if (parseSompiString(accepted.amount) <= 0n) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_amount",
      "exact payment amount must be positive",
    );
  }
  if (config.exactProfile === "additive") {
    const head = exactHeadFromAccepted(accepted);
    if (!head)
      throw new KaspaX402Error(
        "invalid_kaspa_x402_payload",
        "additive exact requirements require complete head terms",
      );
    assertExactHeadPolicy(
      head,
      accepted.amount,
      payToScriptPublicKey,
      config.minimumExactAdditiveThresholdSompi,
      true,
    );
    const { challengeId: _challengeId, ...unsigned } = head;
    if (
      exactHeadChallengeId(
        accepted.network,
        accepted.payTo,
        accepted.amount,
        unsigned,
      ) !== head.challengeId.toLowerCase()
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_payload",
        "additive exact challenge id does not bind its advertised terms",
      );
    }
  }
}

function exactRequirementMatchesRoute(
  config: ResolvedServerConfig,
  accepted: ExactPaymentRequirements,
  paymentAmount?: SompiString,
): boolean {
  return (
    accepted.network === config.network &&
    accepted.asset === "KAS" &&
    accepted.payTo === config.payTo &&
    accepted.amount === (paymentAmount ?? config.amount) &&
    accepted.maxTimeoutSeconds === config.maxTimeoutSeconds &&
    accepted.extra.binding === "kaspa-exact-v2" &&
    accepted.extra.profile === config.exactProfile &&
    accepted.extra.finality === config.acceptedFinality
  );
}

function exactProfileFromAccepted(
  accepted: ExactPaymentRequirements,
): "standard-native" | "additive" {
  if (
    accepted.extra.profile === "standard-native" ||
    accepted.extra.profile === "additive"
  )
    return accepted.extra.profile;
  throw new KaspaX402Error(
    "invalid_kaspa_x402_payload",
    "exact v2 requirements must select a profile",
  );
}

function exactHeadFromAccepted(
  accepted: ExactPaymentRequirements,
): ExactHeadChallenge | undefined {
  const extra = accepted.extra;
  if (
    extra.binding !== "kaspa-exact-v2" ||
    extra.profile !== "additive" ||
    extra.templateId !== "kaspa-x402-kip10-additive-v1" ||
    extra.transactionEncoding !== "kaspa-sdk-safe-json-v2.0.0" ||
    !extra.expectedHeadOutpoint ||
    typeof extra.headId !== "string" ||
    typeof extra.headVersion !== "string" ||
    typeof extra.headAmount !== "string" ||
    typeof extra.headScriptPublicKey !== "string" ||
    typeof extra.headRedeemScript !== "string" ||
    typeof extra.additiveThresholdSompi !== "string" ||
    extra.paymentOutputIndex !== 0 ||
    typeof extra.challengeId !== "string" ||
    typeof extra.challengeExpiresAt !== "string"
  ) {
    return undefined;
  }
  return {
    headId: extra.headId,
    headVersion: extra.headVersion,
    templateId: extra.templateId,
    transactionEncoding: extra.transactionEncoding,
    expectedHeadOutpoint: extra.expectedHeadOutpoint,
    headAmount: extra.headAmount,
    headScriptPublicKey: extra.headScriptPublicKey,
    headRedeemScript: extra.headRedeemScript,
    additiveThresholdSompi: extra.additiveThresholdSompi,
    paymentOutputIndex: 0,
    challengeId: extra.challengeId,
    expiresAt: extra.challengeExpiresAt,
  };
}

function assertExactHeadPolicy(
  head: ExactHeadChallenge,
  amount: SompiString,
  payToScriptPublicKey: string,
  minimumAdditiveThresholdSompi: SompiString,
  allowExpired = false,
): void {
  if (head.paymentOutputIndex !== 0) {
    throw new KaspaX402Error(
      "invalid_kaspa_outpoint",
      "additive exact successor must remain at output index 0",
    );
  }
  const threshold = parseSompiString(head.additiveThresholdSompi);
  if (
    threshold < parseSompiString(minimumAdditiveThresholdSompi) ||
    parseSompiString(amount) < threshold
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_amount",
      "additive exact amount does not meet the configured head threshold",
    );
  }
  if (
    parseSompiString(head.headAmount) <= 0n ||
    parseSompiString(head.headVersion) < 0n
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_amount",
      "additive exact head amount and version are invalid",
    );
  }
  if (!allowExpired && Date.parse(head.expiresAt) <= Date.now()) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      "additive exact head challenge has expired",
    );
  }
  try {
    const template = parseKip10AdditiveRedeemScript(head.headRedeemScript);
    const scriptPublicKey = serializedScriptPublicKey(
      payToScriptHashScript(head.headRedeemScript),
    ).toLowerCase();
    if (
      template.amount !== head.additiveThresholdSompi ||
      scriptPublicKey !== head.headScriptPublicKey.toLowerCase() ||
      scriptPublicKey !== payToScriptPublicKey.toLowerCase()
    ) {
      throw new Error("head script terms do not match");
    }
  } catch {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_binding",
      "additive exact head must use the canonical configured KIP-10 script",
    );
  }
}

function validateChannelTerms(
  config: ResolvedServerConfig,
  accepted: BatchPaymentRequirements,
  channelConfig: ChannelConfig,
): void {
  if (
    accepted.network !== config.network ||
    channelConfig.network !== config.network
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_network",
      "payment network does not match server config",
    );
  }
  if (accepted.asset !== "KAS" || channelConfig.asset !== "KAS") {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_asset",
      "payment asset does not match server config",
    );
  }
  if (accepted.payTo !== config.payTo || channelConfig.payTo !== config.payTo) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      "payTo does not match server config",
    );
  }
  if (
    accepted.extra.serverPublicKey !== config.serverPublicKey ||
    channelConfig.serverPublicKey !== config.serverPublicKey
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_public_key",
      "server public key does not match server config",
    );
  }
  if (
    accepted.extra.templateId !== config.templateId ||
    channelConfig.templateId !== config.templateId
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_binding",
      "template id does not match server config",
    );
  }
  if (accepted.extra.refundTimeoutDaa !== channelConfig.refundTimeoutDaa) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      "refund timeout does not match channel config",
    );
  }
  if (
    !config.allowRollingRefundTimeoutDaa &&
    accepted.extra.refundTimeoutDaa !== config.refundTimeoutDaa
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      "refund timeout does not match server config",
    );
  }
}

function batchRequirementMatchesRoute(
  config: ResolvedServerConfig,
  accepted: BatchPaymentRequirements,
  paymentAmount?: SompiString,
): boolean {
  return (
    accepted.network === config.network &&
    accepted.amount === (paymentAmount ?? config.amount) &&
    accepted.asset === "KAS" &&
    accepted.payTo === config.payTo &&
    accepted.maxTimeoutSeconds === config.maxTimeoutSeconds &&
    accepted.extra.binding === "kaspa-escrow-v1" &&
    accepted.extra.templateId === config.templateId &&
    accepted.extra.serverPublicKey === config.serverPublicKey &&
    accepted.extra.minDepositSompi === config.minDepositSompi &&
    ((accepted.extra.claimPolicy === undefined &&
      config.claimPolicy === undefined) ||
      (accepted.extra.claimPolicy !== undefined &&
        config.claimPolicy !== undefined &&
        stableStringify(accepted.extra.claimPolicy) ===
          stableStringify(config.claimPolicy)))
  );
}

function assertRefundPolicyConfig(config: ResolvedServerConfig): void {
  const timeout = parseSompiString(config.refundTimeoutDaa);
  const lead = parseSompiString(config.minimumRefundLeadDaa);
  if (timeout >= KASPA_LOCK_TIME_THRESHOLD) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      "refundTimeoutDaa must remain below the consensus timestamp boundary",
    );
  }
  if (config.allowRollingRefundTimeoutDaa) {
    if (config.maximumRefundHorizonDaa === undefined) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_payload",
        "maximumRefundHorizonDaa is required for rolling refund timeouts",
      );
    }
    const horizon = parseSompiString(config.maximumRefundHorizonDaa);
    if (horizon <= lead) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_payload",
        "maximumRefundHorizonDaa must exceed minimumRefundLeadDaa",
      );
    }
  }
}

function deriveServerEscrow(
  config: ResolvedServerConfig,
  channelConfig: ChannelConfig,
): { escrowAddress: string; activeScriptPublicKey: string } {
  const payoutScriptPublicKeyHash = scriptPublicKeyHash(
    config.addressCodec.scriptPublicKeyForAddress(
      channelConfig.payTo,
      channelConfig.network,
    ),
  );
  const refundScriptPublicKeyHash = scriptPublicKeyHash(
    config.addressCodec.scriptPublicKeyForAddress(
      channelConfig.refundAddress,
      channelConfig.network,
    ),
  );
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
    escrowAddress: deriveEscrowAddress(params, (input) =>
      config.addressCodec.encodeScriptAddress(input),
    ),
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
  const active =
    parseSompiString(channel.chargedCumulativeAmount) -
    parseSompiString(channel.claimedCumulativeAmount);
  const funding = parseSompiString(channel.fundingAmount);
  const signed = parseSompiString(channel.signedMaxClaimable);
  if (active > signed)
    throw new KaspaX402Error(
      "invalid_kaspa_settlement_response",
      "active charged amount cannot exceed signed ceiling",
    );
  if (signed > funding)
    throw new KaspaX402Error(
      "invalid_kaspa_settlement_response",
      "signed ceiling cannot exceed funding amount",
    );
}

function validateChannelPreVoucherAccounting(
  channel: ServerChannelRecord,
): void {
  const charged = parseSompiString(channel.chargedCumulativeAmount);
  const claimed = parseSompiString(channel.claimedCumulativeAmount);
  const active = charged - claimed;
  const funding = parseSompiString(channel.fundingAmount);
  if (claimed > charged)
    throw new KaspaX402Error(
      "invalid_kaspa_settlement_response",
      "claimed amount cannot exceed charged amount",
    );
  if (active > funding)
    throw new KaspaX402Error(
      "invalid_kaspa_settlement_response",
      "active charged amount cannot exceed funding amount",
    );
}

function safePaymentChannelId(
  paymentPayload: PaymentPayload,
): Hash32Hex | undefined {
  const payload = paymentPayload.payload;
  if ("channelId" in payload && typeof payload.channelId === "string")
    return payload.channelId;
  return undefined;
}

function safePaymentScopeIdHint(
  paymentPayload: PaymentPayload,
): Hash32Hex | undefined {
  const channelId = safePaymentChannelId(paymentPayload);
  if (channelId) return channelId;
  const payload = paymentPayload.payload;
  if (
    payload.type === "exact-transaction" &&
    typeof payload.transaction === "string" &&
    typeof payload.paymentOutputIndex === "number"
  ) {
    return exactTransactionArtifactScopeId(payload.transaction);
  }
  return undefined;
}

function safePaymentLockKey(
  paymentPayload: PaymentPayload,
): Hash32Hex | undefined {
  const channelId = safePaymentChannelId(paymentPayload);
  if (channelId) return channelId;
  const payload = paymentPayload.payload;
  if (
    payload.type === "exact-transaction" &&
    typeof payload.transaction === "string" &&
    typeof payload.paymentOutputIndex === "number"
  ) {
    return exactTransactionArtifactScopeId(payload.transaction);
  }
  return undefined;
}

function exactPaymentScopeId(transactionId: Hash32Hex): Hash32Hex {
  return sha256Hex(
    stableStringify({
      scope: "kaspa:x402:exact-payment-transaction:v1",
      transactionId: transactionId.toLowerCase(),
    }),
  );
}

function exactTransactionArtifactScopeId(transaction: string): Hash32Hex {
  return sha256Hex(
    stableStringify({
      scope: "kaspa:x402:exact-payment-transaction-artifact:v1",
      transactionHash: sha256Hex(transaction),
    }),
  );
}

function readHeader(
  headers: PaidRequest["headers"],
  name: string,
): string | undefined {
  if (!headers) return undefined;
  if ("get" in headers && typeof headers.get === "function")
    return headers.get(name) ?? headers.get(name.toLowerCase()) ?? undefined;
  const found = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return found?.[1];
}

function readPaymentIdentifier(
  paymentPayload: PaymentPayload,
): string | undefined {
  const paymentIdentifier = paymentPayload.extensions?.["payment-identifier"];
  if (!isRecord(paymentIdentifier)) return undefined;
  const info = paymentIdentifier.info;
  if (!isRecord(info)) return undefined;
  return typeof info.id === "string" ? info.id : undefined;
}

function fingerprintRequest(
  request: PaidRequest,
  accepted: PaymentRequirements,
): Hash32Hex {
  return sha256Hex(
    stableStringify({
      method: request.method ?? "GET",
      url: request.url,
      body: request.body ?? null,
      paymentRequirementsHash: sha256Hex(stableStringify(accepted)),
    }),
  );
}

function paymentPayloadHash(paymentPayload: PaymentPayload): Hash32Hex {
  return sha256Hex(stableStringify(paymentPayload));
}

function paymentIdentifierScopeMatches(
  record: PaymentIdentifierRecord,
  paymentScopeId: Hash32Hex | undefined,
): boolean {
  return (
    paymentScopeId === undefined ||
    record.paymentScopeId === paymentScopeId ||
    record.channelId === paymentScopeId ||
    record.transactionId === paymentScopeId
  );
}

function paymentIdentifierConflictResponse(): ServerResponse {
  return {
    status: 409,
    headers: {},
    body: {
      error: toX402ErrorReason("payment_identifier_conflict"),
    },
  };
}

function normalizeBroadcastFinality(
  finality: SettlementFinality,
): SettlementFinality {
  return finality === "confirmed"
    ? "confirmed"
    : finality === "accepted"
      ? "accepted"
      : "broadcast";
}

function responseWithSettlement(
  response: ServerResponse,
  settlement: SettlementResponse,
): ServerResponse {
  return {
    ...response,
    headers: {
      ...(response.headers ?? {}),
      [PAYMENT_RESPONSE_HEADER]: encodePaymentResponseHeader(settlement),
    },
  };
}

function idempotencyLockKey(paymentIdentifier: string): Hash32Hex {
  return sha256Hex(`kaspa:x402:payment-identifier-lock:${paymentIdentifier}`);
}

function latestVoucher(channel: ServerChannelRecord): Voucher | undefined {
  return channel.voucherSignature
    ? {
        amount: channel.signedMaxClaimable,
        signature: channel.voucherSignature,
      }
    : undefined;
}

function claimAttemptId(
  channel: ServerChannelRecord,
  transaction: PreparedTransaction,
  claimAmount: SompiString,
): Hash32Hex {
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

function sameActiveOutpoint(
  channel: Pick<
    ServerChannelRecord,
    "activeOutpoint" | "activeScriptPublicKey"
  >,
  outpoint: FundingOutpoint,
  activeScriptPublicKey: string,
): boolean {
  return (
    channel.activeOutpoint.txid.toLowerCase() === outpoint.txid.toLowerCase() &&
    channel.activeOutpoint.index === outpoint.index &&
    channel.activeScriptPublicKey.toLowerCase() ===
      activeScriptPublicKey.toLowerCase()
  );
}

function sameOutpoint(left: FundingOutpoint, right: FundingOutpoint): boolean {
  return (
    left.txid.toLowerCase() === right.txid.toLowerCase() &&
    left.index === right.index
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
        hexToBytes(input.channel.channelId, {
          expectedLength: 32,
          label: "channelId",
        }),
        hexToBytes(input.requestFingerprint, {
          expectedLength: 32,
          label: "requestFingerprint",
        }),
        batchPaymentRequirementsHash(input.accepted),
        hexToBytes(input.channel.activeOutpoint.txid, {
          expectedLength: 32,
          label: "activeOutpoint.txid",
        }),
        le32(input.channel.activeOutpoint.index),
        le64(input.voucher.amount),
        sha256(
          hexToBytes(input.voucher.signature, {
            expectedLength: 64,
            label: "voucher.signature",
          }),
        ),
        le64(input.chargedAmount),
        le64(input.channel.chargedCumulativeAmount),
        le64(input.chargedCumulativeAfter),
        le64(input.channel.claimedCumulativeAmount),
      ]),
    ),
  );
}

function batchPaymentRequirementsHash(
  accepted: BatchPaymentRequirements,
): Uint8Array {
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
      hexToBytes(accepted.extra.serverPublicKey, {
        expectedLength: 32,
        label: "serverPublicKey",
      }),
      le64(accepted.extra.minDepositSompi),
      le64(accepted.extra.refundTimeoutDaa),
    ]),
  );
}

function isAcceptedFinality(
  finality: string,
  required: "accepted" | "confirmed",
): boolean {
  return (
    finality === "confirmed" ||
    (required === "accepted" && finality === "accepted")
  );
}

function exactFinalityMeets(
  actual: "mempool" | "accepted" | "confirmed",
  required: "mempool" | "accepted" | "confirmed",
): boolean {
  const rank = { mempool: 0, accepted: 1, confirmed: 2 } as const;
  return rank[actual] >= rank[required];
}

function isExactFinality(
  value: unknown,
): value is "mempool" | "accepted" | "confirmed" {
  return value === "mempool" || value === "accepted" || value === "confirmed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
