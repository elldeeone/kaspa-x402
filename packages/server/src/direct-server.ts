import {
  X402_VERSION,
  KASPA_LOCK_TIME_THRESHOLD,
  KASPA_X402_RESOURCE_BUDGET,
  applyBatchClaimAccounting,
  applyCovenantSelectedChainUpdate,
  assertEncodedHeaderBudget,
  assertCovenantLineageConfirmed,
  assertMainnetAllowed,
  assertBatchVoucherReserve,
  assertJsonResourceBudget,
  batchPresentationDigest,
  batchPresentationDigestInput,
  batchPresentationExpiryError,
  batchLaneAccounting,
  batchCommitmentId,
  batchPaymentRequirementsHash,
  bindRequestHashToTrustedContext,
  canonicalCovenantTransitions,
  channelId,
  createCovenantLineageState,
  decideChainEvidence,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  exactAuthorizationExpiryError,
  exactRequestAuthorizationDigest,
  exactRequestAuthorizationId,
  exactTransactionReplayIdentityHash,
  formatSompiString,
  hexToBytes,
  kaspaSettlementExtensions,
  parseBatchLaneAmount,
  parseSompiString,
  paymentIdentifierExtension,
  paymentReplayIdentityHash,
  requiredBatchVoucherAmount,
  sha256Hex,
  stableStringify,
  normalizePaymentPayloadHex,
  normalizePaymentRequirementsHex,
  trustedSecurityContextHash,
  toX402ErrorReason,
  utf8ByteLength,
  validatePaymentPayload,
  validatePaymentRequired,
  validatePaymentRetry,
  voucherDigest,
  voucherPreimageHex,
  type BatchPaymentRequirements,
  type AcceptedTransactionEvidence,
  type ChannelConfig,
  type CovenantLaunchManifest,
  type CovenantLineageState,
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
  type TrustedSecurityContext,
  type TrustedTransactionEvidence,
  type Voucher,
  type VoucherPayload,
} from "@kaspa-x402/core";
import { KaspaX402Error } from "@kaspa-x402/core";
import {
  deriveEscrowAddress,
  ESCROW_V4_LAUNCH_IDENTITY,
  escrowScriptPublicKey,
  parseKip10AdditiveRedeemScript,
  payToScriptHashScript,
  serializedScriptPublicKey,
} from "@kaspa-x402/covenant";
import { activeChargedAmount, MemoryChannelLockManager } from "./stores.js";
import { sameCovenantLineage } from "./channel-lineage.js";
import { exactSettlementAttemptsMatch } from "./exact-heads.js";
import {
  MemoryPublicBoundaryController,
  PublicBoundaryError,
  type PublicBoundaryController,
  type PublicBoundaryPermit,
} from "./public-boundary.js";
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  type BatchCommitmentRecord,
  type BatchSettlementAttemptRecord,
  type BuildPaymentRequiredOptions,
  type ChainUtxo,
  type ChannelLockManager,
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
  type ExactHeadLineageStep,
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
      | "reconcileExactHeadOnOffer"
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

const lockByStoreCoordinationDomain = new Map<string, ChannelLockManager>();

export class DirectModeServer {
  readonly #config: ResolvedServerConfig;
  readonly #publicBoundary: PublicBoundaryController;

  constructor(config: DirectModeServerConfig) {
    this.#config = {
      asset: "KAS",
      templateId: "kaspa-x402-escrow-v4",
      maxTimeoutSeconds: 60,
      acceptedFinality: "accepted",
      exactProfile: "standard-native",
      minimumExactAdditiveThresholdSompi: "10000000",
      minimumRefundLeadDaa: "1000",
      allowRollingRefundTimeoutDaa: false,
      reconcileExactHeadOnOffer: false,
      lockManager: new MemoryChannelLockManager(),
      ...config,
    };
    assertMainnetAllowed(
      this.#config.network,
      this.#config.allowMainnet,
      "DirectModeServer",
    );
    assertRefundPolicyConfig(this.#config);
    if (
      !Number.isSafeInteger(this.#config.confirmationThreshold) ||
      this.#config.confirmationThreshold < 1
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_payload",
        "confirmationThreshold must be a positive safe integer",
      );
    }
    parseBatchLaneAmount(this.#config.minDepositSompi, "minimum deposit");
    parseBatchLaneAmount(this.#config.claimReserveSompi, "claim reserve");
    assertServerCoordinationTopology(
      this.#config.store,
      this.#config.lockManager,
    );
    this.#publicBoundary =
      config.publicBoundaryController ??
      new MemoryPublicBoundaryController(config.publicBoundaryPolicy);
  }

  async #runAdapter<T>(
    adapter: string,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    return this.#publicBoundary.runAdapter(adapter, operation);
  }

  buildPaymentRequired(options: BuildPaymentRequiredOptions): PaymentRequired {
    const paymentRequired = makePaymentRequired(this.#config, options);
    assertJsonResourceBudget(paymentRequired, {
      label: "payment requirements",
    });
    return paymentRequired;
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

  async paymentRequiredResponseAsync(
    options: BuildPaymentRequiredOptions,
    status = 402,
  ): Promise<ServerResponse> {
    return this.#paymentRequiredResponse(options, status);
  }

  async #paymentRequiredResponse(
    options: BuildPaymentRequiredOptions,
    status = 402,
  ): Promise<ServerResponse> {
    let paymentRequired: PaymentRequired;
    try {
      paymentRequired = await this.#buildRuntimePaymentRequired(options);
    } catch (error) {
      if (error instanceof PublicBoundaryError)
        return publicBoundaryResponse(error);
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
    const schemes = paymentRequirementSchemes(this.#config, options);
    if (
      this.#config.exactProfile === "additive" &&
      schemes.includes("exact") &&
      !options.exactHead
    ) {
      const amount = options.amount ?? this.#config.amount;
      const payToScriptPublicKey =
        this.#config.addressCodec.scriptPublicKeyForAddress(
          this.#config.payTo,
          this.#config.network,
        );
      for (let selectionAttempt = 0; selectionAttempt < 2; selectionAttempt++) {
        const selectionKey = sha256Hex(
          stableStringify({
            scope: "kaspa:x402:additive-head-selection:v1",
            network: this.#config.network,
            amount,
            payTo: this.#config.payTo,
            resource: options.resource,
            selectionAttempt,
          }),
        );
        let head = await this.#config.store.selectExactHead({
          network: this.#config.network,
          amount,
          payTo: this.#config.payTo,
          payToScriptPublicKey,
          minimumAdditiveThresholdSompi:
            this.#config.minimumExactAdditiveThresholdSompi,
          selectionKey,
        });
        if (!head) break;
        if (this.#config.reconcileExactHeadOnOffer) {
          try {
            head = await this.reconcileExactHead(head.headId);
          } catch (error) {
            const current = await this.#config.store.loadExactHead(head.headId);
            if (current?.status !== "unavailable") throw error;
            head = current;
          }
          if (head.status !== "available") continue;
        }
        const exactHead = makeExactHeadChallenge(
          head,
          amount,
          this.#config.maxTimeoutSeconds,
        );
        return makePaymentRequired(this.#config, { ...options, exactHead });
      }
      if (schemes.includes("batch-settlement")) {
        await this.#assertRefundWindow(this.#config.refundTimeoutDaa);
        return makePaymentRequired(this.#config, {
          ...options,
          schemes: ["batch-settlement"],
        });
      }
      throw new KaspaX402Error(
        "invalid_kaspa_x402_payload",
        "additive exact head is unavailable",
      );
    }
    if (schemes.includes("batch-settlement")) {
      await this.#assertRefundWindow(this.#config.refundTimeoutDaa);
    }
    return makePaymentRequired(this.#config, options);
  }

  async extractPayment(header: string): Promise<PaymentPayload> {
    return normalizePaymentPayloadHex(decodePaymentSignatureHeader(header));
  }

  supportedKinds(): SupportedKind[] {
    const kinds: SupportedKind[] = [];
    if (
      this.#config.exactTransactionVerifier &&
      (this.#config.exactProfile !== "additive" ||
        this.#config.exactSettlementReconciler)
    ) {
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
    if (this.#config.network === "kaspa:testnet-10") {
      kinds.push({
        x402Version: X402_VERSION,
        scheme: "batch-settlement",
        network: this.#config.network,
        extra: {
          asset: this.#config.asset,
          binding: "kaspa-escrow-v3",
          templateId: this.#config.templateId,
          modes: this.#config.claimBuilder
            ? ["verify", "settle", "claim"]
            : ["verify", "settle"],
        },
      });
    }
    return kinds;
  }

  /** Share admission and adapter limits with embedding-specific public actions. */
  async runPublicAdapter<T>(
    adapter: string,
    trustedSecurityContext: TrustedSecurityContext | undefined,
    channelKey: string | undefined,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const requestPermit = this.#publicBoundary.enterRequest(
      trustedSecurityContext,
    );
    let channelPermit: PublicBoundaryPermit | undefined;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      channelPermit?.release();
      requestPermit.release();
    };
    let operationStarted = false;
    try {
      if (channelKey)
        channelPermit = this.#publicBoundary.enterChannel(channelKey);
      return await this.#runAdapter(adapter, () => {
        operationStarted = true;
        const pending = Promise.resolve().then(operation);
        void pending.then(release, release);
        return pending;
      });
    } finally {
      // Admission failures never start the operation, so no pending work owns
      // these permits. Timed-out operations retain them until they settle.
      if (!operationStarted) release();
    }
  }

  async verifyPayment(
    options: DirectPaymentVerificationOptions,
  ): Promise<DirectPaymentVerification> {
    let requestPermit: PublicBoundaryPermit;
    try {
      requestPermit = this.#publicBoundary.enterRequest(
        options.trustedSecurityContext,
      );
    } catch (error) {
      throw boundaryError(error);
    }
    let channelPermit: PublicBoundaryPermit | undefined;
    try {
      const payment = validatedPaymentPayload(options.paymentPayload);
      const key = safePaymentLockKey(payment);
      if (key) channelPermit = this.#publicBoundary.enterChannel(key);
      return await this.#verifyPaymentDirect(options);
    } catch (error) {
      throw boundaryError(error);
    } finally {
      channelPermit?.release();
      requestPermit.release();
    }
  }

  async #verifyPaymentDirect(
    options: DirectPaymentVerificationOptions,
  ): Promise<DirectPaymentVerification> {
    const resource = options.resource ?? facilitatorResource();
    const paymentPayload = validatedPaymentPayload(options.paymentPayload);
    const paymentRequired = validatedPaymentRequired(
      this.#facilitatorPaymentRequired(resource, options.paymentRequirements),
    );
    assertTrustedBatchContext(
      paymentPayload.accepted,
      options.trustedSecurityContext,
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
    if (payment.scheme === "exact") {
      const requiredFinality = strongerExactFinality(
        this.#config.acceptedFinality,
        payment.accepted.extra.finality,
      );
      if (
        !exactFinalityMeets(payment.finality ?? "mempool", requiredFinality)
      ) {
        throw new KaspaX402Error(
          "invalid_kaspa_transaction",
          "exact verification did not reach the authenticated finality requirement",
        );
      }
    }
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
    assertTrustedBatchContext(
      paymentPayload.accepted,
      options.trustedSecurityContext,
    );
    assertSettlementRequirements(
      paymentPayload.accepted,
      settlementRequirements,
    );
    const requestHash = facilitatorRequestHash({
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
        requestHash,
        trustedSecurityContext: options.trustedSecurityContext,
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
    let permit: PublicBoundaryPermit;
    try {
      permit = this.#publicBoundary.enterRequest(request.trustedSecurityContext);
    } catch (error) {
      return error instanceof PublicBoundaryError
        ? publicBoundaryResponse(error)
        : {
            status: 400,
            headers: {},
            body: { error: "invalid_payload" },
          };
    }
    try {
      return await this.#handlePaidRequest(request, handler);
    } catch (error) {
      if (error instanceof PublicBoundaryError)
        return publicBoundaryResponse(error);
      throw error;
    } finally {
      permit.release();
    }
  }

  async #handlePaidRequest(
    request: PaidRequest,
    handler: ProtectedHandler,
  ): Promise<ServerResponse> {
    const resource = request.resource ?? { url: request.url };
    try {
      assertJsonResourceBudget(
        {
          method: request.method ?? null,
          url: request.url,
          resource,
          body: request.body ?? null,
          paymentAmount: request.paymentAmount ?? null,
          paymentScheme: request.paymentScheme ?? null,
          paymentSchemes: request.paymentSchemes ?? null,
          requestHash: request.requestHash ?? null,
          mcpErrorChargeSompi: request.mcpErrorChargeSompi ?? null,
          ...(request.trustedSecurityContext
            ? { trustedSecurityContext: request.trustedSecurityContext }
            : {}),
        },
        { label: "paid request" },
      );
      if (request.trustedSecurityContext)
        trustedSecurityContextHash(request.trustedSecurityContext);
    } catch {
      return {
        status: 400,
        headers: {},
        body: { error: "invalid_payload" },
      };
    }
    const paymentAmount = request.paymentAmount;
    const requiredOptions = paymentRequirementRouteOptions(request);
    const requestedScheme = verificationRequestedScheme(request);
    let paymentHeader: string | undefined;
    try {
      paymentHeader = readHeader(request.headers, PAYMENT_SIGNATURE_HEADER);
    } catch {
      return {
        status: 400,
        headers: {},
        body: { error: "invalid_payload" },
      };
    }
    if (!paymentHeader) {
      return this.#paymentRequiredResponse({
        resource,
        amount: paymentAmount,
        ...requiredOptions,
      });
    }
    try {
      assertEncodedHeaderBudget(paymentHeader, PAYMENT_SIGNATURE_HEADER);
    } catch {
      return {
        status: 400,
        headers: {},
        body: { error: "invalid_payload" },
      };
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
    if (
      (this.#config.requirePaymentIdentifier ||
        paymentPayload.accepted.scheme === "exact") &&
      !paymentIdentifier
    ) {
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
          fingerprint = fingerprintRequest(request, paymentPayload.accepted);
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
            request.trustedSecurityContext,
            request.mcpErrorChargeSompi,
          );
        } catch (error) {
          if (error instanceof PublicBoundaryError)
            return publicBoundaryResponse(error);
          return this.#correctiveResponse(
            resource,
            paymentPayload,
            error,
            paymentAmount,
            requestedScheme,
            request.trustedSecurityContext,
          );
        }
        const runVerified = async () => {
          let recoveredExactHandlerResult: ProtectedHandlerResult | undefined;
          let recoveredBatchHandlerResult: ProtectedHandlerResult | undefined;
          let batchAttemptId: Hash32Hex | undefined;
          if (verified.scheme === "batch-settlement") {
            try {
              const existingAttempt =
                await this.#config.store.loadBatchSettlementAttempt(
                  this.#batchSettlementAttemptId(verified, fingerprint),
                );
              if (!existingAttempt)
                verified = this.#prepareLiveDepositTransition(verified);
              const claim = existingAttempt
                ? { attempt: existingAttempt, created: false }
                : await this.#claimBatchSettlement(
                    verified,
                    fingerprint,
                    paymentIdentifier,
                  );
              batchAttemptId = claim.attempt.attemptId;
              recoveredBatchHandlerResult = claim.attempt.handlerResult;
              if (
                claim.attempt.status !== "pending" ||
                (claim.attempt.handlerStartedAt && !recoveredBatchHandlerResult)
              ) {
                return batchSettlementRecoveryRequiredResponse();
              }
              if (!recoveredBatchHandlerResult) {
                const handlerStarted =
                  await this.#config.store.beginBatchHandler(
                    batchAttemptId,
                    new Date().toISOString(),
                  );
                if (!handlerStarted)
                  return batchSettlementRecoveryRequiredResponse();
              }
            } catch (error) {
              if (isPaymentIdentifierOwnershipError(error))
                return paymentIdentifierConflictResponse();
              return batchSettlementRecoveryRequiredResponse();
            }
          }
          if (verified.scheme === "exact") {
            const replay = await this.#checkExactReplay(verified, fingerprint);
            if (replay) return replay;
            try {
              if (!verified.recoveryOnly) {
                this.#assertExactAuthorizationLive(verified);
              }
            } catch (error) {
              return this.#correctiveResponse(
                resource,
                verified.paymentPayload,
                error,
                paymentAmount,
                requestedScheme,
                request.trustedSecurityContext,
              );
            }
            try {
              const claim = await this.#claimExactSettlement(
                verified,
                fingerprint,
                paymentIdentifier,
              );
              verified = await this.#settleExactIfNeeded(verified, claim);
              const durableAttempt =
                await this.#config.store.loadExactSettlementAttempt(
                  verified.transactionId,
                );
              recoveredExactHandlerResult = durableAttempt?.handlerResult;
              if (
                durableAttempt?.handlerStartedAt &&
                !recoveredExactHandlerResult
              ) {
                return {
                  status: 503,
                  headers: {},
                  body: { error: "exact_settlement_recovery_required" },
                };
              }
              if (!recoveredExactHandlerResult) {
                const handlerStarted =
                  await this.#config.store.beginExactHandler(
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
              }
            } catch (error) {
              if (isPaymentIdentifierOwnershipError(error))
                return paymentIdentifierConflictResponse();
              return this.#settlementCorrectiveResponse(
                resource,
                verified,
                error,
                paymentAmount,
                requestedScheme,
                request.trustedSecurityContext,
              );
            }
          }
          let handlerResult: ProtectedHandlerResult;
          if (recoveredExactHandlerResult || recoveredBatchHandlerResult) {
            handlerResult =
              recoveredExactHandlerResult ?? recoveredBatchHandlerResult!;
          } else {
            try {
              handlerResult = await this.#runAdapter(
                "protected-handler",
                () =>
                  handler({
                    request,
                    payment: verified,
                    requestFingerprint: fingerprint,
                    paymentIdentifier,
                  }),
              );
            } catch {
              if (verified.scheme === "exact") {
                await this.#config.store.markExactHandlerRecoveryRequired(
                  verified.transactionId,
                  "protected handler threw after exact settlement acceptance",
                  new Date().toISOString(),
                );
              } else if (batchAttemptId) {
                await markBatchHandlerRecoveryRequiredSafely(
                  this.#config.store,
                  batchAttemptId,
                  "protected handler threw after batch payment verification",
                );
              }
              return {
                status: 500,
                headers: {},
              };
            }
          }

          let chargedAmount: SompiString;
          try {
            const mcpErrorCharge =
              request.method === "MCP" &&
              verified.scheme === "batch-settlement" &&
              isMcpErrorResultBody(handlerResult.body)
                ? verified.accepted.extra.mcpErrorChargeSompi
                : undefined;
            if (
              request.method === "MCP" &&
              verified.scheme === "batch-settlement" &&
              isMcpErrorResultBody(handlerResult.body) &&
              mcpErrorCharge !== verified.accepted.amount
            ) {
              throw new KaspaX402Error(
                "invalid_kaspa_settlement_response",
                "MCP error result lacks an explicit payer-approved fixed charge",
              );
            }
            chargedAmount =
              handlerResult.chargedAmount ??
              mcpErrorCharge ??
              verified.accepted.amount;
            parseSompiString(chargedAmount);
            if (chargedAmount !== verified.accepted.amount) {
              throw new KaspaX402Error(
                "invalid_kaspa_settlement_response",
                "settlement amount must equal the accepted fixed charge",
              );
            }
          } catch (error) {
            if (verified.scheme === "exact") {
              await this.#config.store.markExactHandlerRecoveryRequired(
                verified.transactionId,
                error instanceof Error
                  ? error.message
                  : "protected handler result is invalid",
                new Date().toISOString(),
              );
              return {
                status: 500,
                headers: {},
                body: { error: "exact_settlement_recovery_required" },
              };
            }
            if (batchAttemptId) {
              await markBatchHandlerRecoveryRequiredSafely(
                this.#config.store,
                batchAttemptId,
                error instanceof Error
                  ? error.message
                  : "protected handler result is invalid",
              );
              return batchSettlementRecoveryRequiredResponse(500);
            }
            return this.#correctiveResponse(
              resource,
              paymentPayload,
              error,
              paymentAmount,
              requestedScheme,
              request.trustedSecurityContext,
            );
          }

          if (verified.scheme === "exact") {
            if (!recoveredExactHandlerResult) {
              try {
                await this.#config.store.recordExactHandlerResult(
                  verified.transactionId,
                  handlerResult,
                  new Date().toISOString(),
                );
              } catch (error) {
                try {
                  await this.#config.store.markExactHandlerRecoveryRequired(
                    verified.transactionId,
                    error instanceof Error
                      ? error.message
                      : "exact handler result persistence failed",
                    new Date().toISOString(),
                  );
                } catch {
                  // A post-write transport error may mean the result is already durable.
                }
                return {
                  status: 500,
                  headers: {},
                  body: { error: "exact_settlement_recovery_required" },
                };
              }
            }
            return this.#commitExactResponse(
              verified,
              handlerResult,
              chargedAmount,
              fingerprint,
              paymentIdentifier,
            );
          }
          if (!batchAttemptId)
            return batchSettlementRecoveryRequiredResponse(500);
          if (!recoveredBatchHandlerResult) {
            try {
              await this.#config.store.recordBatchHandlerResult(
                batchAttemptId,
                handlerResult,
                new Date().toISOString(),
              );
            } catch (error) {
              await markBatchHandlerRecoveryRequiredSafely(
                this.#config.store,
                batchAttemptId,
                error instanceof Error
                  ? error.message
                  : "batch handler result persistence failed",
              );
              return batchSettlementRecoveryRequiredResponse(500);
            }
          }
          return this.#commitBatchResponse(
            verified,
            handlerResult,
            chargedAmount,
            fingerprint,
            batchAttemptId,
            paymentIdentifier,
          );
        };

        if (verified.scheme !== "exact") return runVerified();
        const verifiedLockKey = exactPaymentScopeId(verified.transactionId);
        return verifiedLockKey === paymentLockKey
          ? runVerified()
          : lockManager.runExclusive(verifiedLockKey, runVerified);
      });

    let channelPermit: PublicBoundaryPermit;
    try {
      channelPermit = this.#publicBoundary.enterChannel(paymentLockKey);
    } catch (error) {
      return publicBoundaryResponse(error);
    }
    try {
      return await (paymentIdentifier
        ? lockManager.runExclusive(idempotencyLockKey(paymentIdentifier), run)
        : run());
    } finally {
      channelPermit.release();
    }
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
    const result = await this.#runAdapter("exact-settlement-reconciler", () =>
      this.#config.exactSettlementReconciler!.reconcileExactSettlement(attempt),
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
      !exactFinalityMeets(result.finality, attempt.requiredFinality) ||
      !exactFinalityMeets(result.finality, this.#config.acceptedFinality)
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "exact reconciliation did not reach the stored finality requirement",
      );
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

  /**
   * Supplies an operator-confirmed handler result after an accepted payment
   * whose application outcome was uncertain. The payer's identical retry then
   * completes the atomic payment/response commit without rerunning the handler.
   */
  async recoverExactHandler(
    transactionId: Hash32Hex,
    handlerResult: ProtectedHandlerResult,
  ): Promise<ExactSettlementAttemptRecord> {
    const attempt =
      await this.#config.store.loadExactSettlementAttempt(transactionId);
    if (
      !attempt ||
      attempt.status !== "accepted" ||
      !attempt.handlerStartedAt ||
      attempt.handlerResult
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "exact handler is not awaiting operator recovery",
      );
    }
    const chargedAmount = handlerResult.chargedAmount ?? attempt.amount;
    if (chargedAmount !== attempt.amount) {
      throw new KaspaX402Error(
        "invalid_kaspa_settlement_response",
        "exact handler recovery amount must equal the accepted amount",
      );
    }
    await this.#config.store.recordExactHandlerResult(
      transactionId,
      { ...handlerResult, chargedAmount },
      new Date().toISOString(),
    );
    return (await this.#config.store.loadExactSettlementAttempt(
      transactionId,
    ))!;
  }

  /** Supplies the operator-confirmed result for an uncertain batch handler. */
  async recoverBatchHandler(
    attemptId: Hash32Hex,
    handlerResult: ProtectedHandlerResult,
  ): Promise<BatchSettlementAttemptRecord> {
    const attempt =
      await this.#config.store.loadBatchSettlementAttempt(attemptId);
    if (
      !attempt ||
      attempt.status !== "pending" ||
      !attempt.handlerStartedAt ||
      attempt.handlerResult
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "batch handler is not awaiting operator recovery",
      );
    }
    const chargedAmount = handlerResult.chargedAmount ?? attempt.maximumCharge;
    if (chargedAmount !== attempt.maximumCharge) {
      throw new KaspaX402Error(
        "invalid_kaspa_settlement_response",
        "batch handler recovery amount must equal the accepted fixed charge",
      );
    }
    return this.#config.lockManager.runExclusive(
      attempt.channelId,
      async () => {
        await this.#config.store.recordBatchHandlerResult(
          attemptId,
          { ...handlerResult, chargedAmount },
          new Date().toISOString(),
        );
        return (await this.#config.store.loadBatchSettlementAttempt(
          attemptId,
        ))!;
      },
    );
  }

  /** Safely releases a batch reservation that never started protected work. */
  async abandonBatchSettlement(
    attemptId: Hash32Hex,
    reason = "pre-handler batch attempt abandoned",
  ): Promise<void> {
    const attempt =
      await this.#config.store.loadBatchSettlementAttempt(attemptId);
    if (!attempt) return;
    await this.#config.lockManager.runExclusive(attempt.channelId, () =>
      this.#config.store.abandonBatchSettlement(
        attemptId,
        reason,
        new Date().toISOString(),
      ),
    );
  }

  async reconcileExactHead(
    headId: Hash32Hex,
    candidateTransactionIds: readonly Hash32Hex[] = [],
  ): Promise<ExactHeadRecord> {
    if (!this.#config.exactHeadReconciler) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "exact head reconciler is required",
      );
    }
    if (
      candidateTransactionIds.length > 64 ||
      candidateTransactionIds.some(
        (transactionId) => !/^[0-9a-fA-F]{64}$/.test(transactionId),
      )
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "exact head reconciliation candidates are invalid",
      );
    }
    const head = await this.#config.store.loadExactHead(headId);
    if (!head) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "exact head was not found",
      );
    }
    if (head.status === "claimed" || head.status === "retired") {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "claimed or retired exact heads cannot be externally reconciled",
      );
    }

    const result = await this.#runAdapter("exact-head-reconciler", () =>
      this.#config.exactHeadReconciler!.reconcileExactHead(
        head,
        candidateTransactionIds,
      ),
    );
    const observedAt = new Date().toISOString();
    if (result.status === "unknown") {
      return (
        await this.#config.store.markExactHeadUnavailable({
          ...exactHeadUnavailableSnapshot(head),
          reason: result.reason,
          observedAt,
        })
      ).head;
    }
    if (result.status === "current") {
      if (
        !sameOutpoint(result.outpoint, head.currentOutpoint) ||
        result.amount !== head.currentAmount ||
        result.scriptPublicKey.toLowerCase() !==
          head.scriptPublicKey.toLowerCase()
      ) {
        const unavailable = await this.#config.store.markExactHeadUnavailable({
          ...exactHeadUnavailableSnapshot(head),
          reason: "trusted current-head evidence does not match durable state",
          observedAt,
        });
        if (!unavailable.applied) return unavailable.head;
        throw new KaspaX402Error(
          "invalid_kaspa_transaction",
          "trusted current-head evidence does not match durable state",
        );
      }
      return head;
    }

    try {
      assertExactHeadLineageResult(head, result.steps);
    } catch (error) {
      const unavailable = await this.#config.store.markExactHeadUnavailable({
        ...exactHeadUnavailableSnapshot(head),
        reason: "trusted external-head evidence failed lineage validation",
        observedAt,
      });
      if (!unavailable.applied) return unavailable.head;
      throw error;
    }
    return this.#config.store.applyExactHeadLineage({
      headId: head.headId,
      expectedVersion: head.version,
      expectedOutpoint: head.currentOutpoint,
      expectedAmount: head.currentAmount,
      steps: result.steps,
      observedAt,
    });
  }

  async listClaimableChannels(): Promise<ServerChannelRecord[]> {
    const channels = await this.#config.store.listChannels();
    const reconciled: ServerChannelRecord[] = [];
    for (const channel of channels) {
      if (channel.status !== "active") continue;
      if (await this.#config.store.loadOpenClaimAttempt(channel.channelId)) {
        continue;
      }
      const current = await this.#config.lockManager.runExclusive(
        channel.channelId,
        () => this.#reconcileChannelSnapshot(channel),
      );
      if (current.status === "active" && activeChargedAmount(current) > 0n) {
        reconciled.push(current);
      }
    }
    return reconciled;
  }

  async reconcileChannel(channelId: Hash32Hex): Promise<ServerChannelRecord> {
    return this.#config.lockManager.runExclusive(channelId, async () => {
      const channel = await this.#requireChannel(channelId);
      return this.#reconcileChannelSnapshot(channel);
    });
  }

  async retireChannel(
    channelId: Hash32Hex,
    reason = "operator retirement",
  ): Promise<void> {
    await this.#config.lockManager.runExclusive(channelId, async () => {
      const loaded = await this.#requireChannel(channelId);
      const channel = await this.#reconcileChannelSnapshot(loaded);
      if (
        channel.status === "refunded" ||
        channel.lineage.currentHead === null
      ) {
        throw new KaspaX402Error(
          "invalid_kaspa_channel_id",
          "terminal refunded channel cannot be retired",
        );
      }
      const leaseId = channelOperationLeaseId("retirement", channel, reason);
      const now = new Date().toISOString();
      await this.#config.store.claimChannelOperation({
        leaseId,
        channelId: channel.channelId,
        covenantId: channel.covenantId,
        kind: "retirement",
        expected: channel,
        status: "reserved",
        createdAt: now,
        updatedAt: now,
      });
      await this.#config.store.retireChannel(
        channel.channelId,
        leaseId,
        channel,
        reason,
      );
    });
  }

  async previewClaim(
    channelId: Hash32Hex,
    requestedClaimAmount?: SompiString,
  ): Promise<ClaimPreview> {
    return this.#config.lockManager.runExclusive(channelId, () =>
      this.#previewClaim(channelId, requestedClaimAmount),
    );
  }

  async #previewClaim(
    channelId: Hash32Hex,
    requestedClaimAmount?: SompiString,
  ): Promise<ClaimPreview> {
    const loaded = await this.#requireChannel(channelId);
    await this.#rejectOpenClaimAttempt(channelId);
    const channel = await this.#reconcileChannelSnapshot(loaded);
    if (channel.status !== "active") {
      throw new KaspaX402Error(
        "invalid_kaspa_channel_id",
        "channel is not active",
      );
    }
    const activeAmount = activeChargedAmount(channel);
    const claimAmount = requestedClaimAmount ?? formatSompiString(activeAmount);
    const estimatedFee = await this.#runAdapter("chain-provider", () =>
      this.#config.chainProvider.estimateClaimFee(channel),
    );
    const claim = parseSompiString(claimAmount);
    const fee = parseSompiString(estimatedFee);
    let reason: string | undefined;
    if (claim === 0n) {
      reason = requestedClaimAmount
        ? "claim amount must be positive"
        : "channel has no active charge";
    } else {
      try {
        applyBatchClaimAccounting(channel, claimAmount);
      } catch (error) {
        reason =
          error instanceof Error ? error.message : "claim amount is invalid";
      }
    }
    reason ??= !channel.voucherSignature
      ? "channel has no signed voucher"
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

  async executeClaim(
    channelId: Hash32Hex,
    claimAmount?: SompiString,
  ): Promise<ClaimExecutionResult> {
    return this.#config.lockManager.runExclusive(channelId, async () => {
      if (!this.#config.claimBuilder) {
        throw new KaspaX402Error(
          "invalid_kaspa_transaction",
          "claim transaction builder is required",
        );
      }
      const preview = await this.#previewClaim(channelId, claimAmount);
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
      const operationLeaseId = channelOperationLeaseId(
        "claim",
        preview.channel,
        preview.claimAmount,
      );
      const operationClaim = await this.#config.store.claimChannelOperation({
        leaseId: operationLeaseId,
        channelId: preview.channel.channelId,
        covenantId: preview.channel.covenantId,
        kind: "claim",
        expected: preview.channel,
        status: "reserved",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      let claim;
      try {
        claim = await this.#runAdapter("claim-builder", () =>
          this.#config.claimBuilder!.buildClaimTransaction({
            channel: preview.channel,
            claimAmount: preview.claimAmount,
          }),
        );
      } catch (error) {
        if (operationClaim.created) {
          await this.#config.store.abandonChannelOperation(
            operationLeaseId,
            "claim construction failed before any broadcast",
            new Date().toISOString(),
          );
        }
        throw error;
      }
      const abandonPreparedClaim = async (reason: string) => {
        if (!operationClaim.created) return;
        await this.#config.store.abandonChannelOperation(
          operationLeaseId,
          reason,
          new Date().toISOString(),
        );
      };
      if (claim.claimAmount !== preview.claimAmount) {
        await abandonPreparedClaim(
          "claim amount validation failed before broadcast",
        );
        throw new KaspaX402Error(
          "invalid_kaspa_transaction",
          "claim transaction amount does not match preview",
        );
      }
      if (!/^[0-9a-f]{64}$/.test(claim.transactionId)) {
        await abandonPreparedClaim(
          "claim transaction id validation failed before broadcast",
        );
        throw new KaspaX402Error(
          "invalid_kaspa_transaction",
          "claim transaction id must be canonical lowercase hash hex",
        );
      }
      if (
        !claim.continuationOutpoint ||
        !claim.continuationScriptPublicKey ||
        !claim.continuationFundingAmount
      ) {
        await abandonPreparedClaim(
          "claim continuation validation failed before broadcast",
        );
        throw new KaspaX402Error(
          "invalid_kaspa_transaction",
          "claim transaction must provide continuation channel state",
        );
      }
      if (claim.continuationOutpoint.txid !== claim.transactionId) {
        await abandonPreparedClaim(
          "claim continuation ownership failed before broadcast",
        );
        throw new KaspaX402Error(
          "invalid_kaspa_outpoint",
          "claim continuation outpoint must belong to the prepared claim transaction",
        );
      }
      const claimedAccounting = applyBatchClaimAccounting(
        preview.channel,
        claim.claimAmount,
      );
      if (claim.continuationFundingAmount !== claimedAccounting.fundingAmount) {
        await abandonPreparedClaim(
          "claim funding validation failed before broadcast",
        );
        throw new KaspaX402Error(
          "invalid_kaspa_transaction",
          "claim continuation amount must equal funding minus the authorized claim",
        );
      }
      const continuationEscrow = deriveServerEscrow(
        this.#config,
        preview.channel.channelConfig,
        claimedAccounting.claimedCumulativeAmount,
      );
      const attempt: ClaimAttemptRecord = {
        attemptId: claimAttemptId(
          preview.channel,
          claim.transaction,
          claim.claimAmount,
        ),
        channelId: preview.channel.channelId,
        covenantId: preview.channel.covenantId,
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
        transactionId: claim.transactionId,
        requiredConfirmations: this.#config.confirmationThreshold,
        continuationOutpoint: claim.continuationOutpoint,
        continuationScriptPublicKey: claim.continuationScriptPublicKey,
        continuationFundingAmount: claim.continuationFundingAmount,
        status: "pending",
        operationLeaseId,
        expected: preview.channel,
      };
      try {
        await this.#config.store.saveClaimAttempt(attempt);
      } catch (error) {
        if (operationClaim.created) {
          await this.#config.store.abandonChannelOperation(
            operationLeaseId,
            "claim attempt was not persisted before broadcast",
            new Date().toISOString(),
          );
        }
        throw error;
      }
      const broadcast = await this.#runAdapter("chain-provider", () =>
        this.#config.chainProvider.sendTransaction(claim.transaction),
      );
      if (
        !/^[0-9a-fA-F]{64}$/.test(broadcast.transactionId) ||
        broadcast.transactionId.toLowerCase() !== attempt.transactionId
      ) {
        throw new KaspaX402Error(
          "invalid_kaspa_transaction",
          "broadcast claim transaction id does not match the persisted signed transaction",
        );
      }
      const decision = trustedChainEvidenceDecision(
        broadcast.evidence,
        attempt.transactionId,
        attempt.requiredConfirmations,
        "broadcast claim evidence",
        attempt.activeOutpoint,
      );
      if (decision.status === "absent") {
        await this.#config.store.abandonClaimAttempt(
          attempt.attemptId,
          decision.evidence.reason,
        );
        throw new KaspaX402Error(
          "invalid_kaspa_transaction",
          "claim transaction was definitively rejected",
        );
      }
      const accepted = decision.status === "confirmed";
      const broadcastAttempt: ClaimAttemptRecord = {
        ...attempt,
        finality:
          decision.status === "accepted"
            ? "accepted"
            : decision.status === "confirmed"
              ? "confirmed"
              : "broadcast",
        ...(decision.status === "accepted" || decision.status === "confirmed"
          ? { acceptance: decision.evidence }
          : {}),
        status: "broadcast",
      };
      await this.#config.store.saveClaimAttempt(broadcastAttempt);
      let resultFinality: SettlementFinality = broadcastAttempt.finality!;
      let continuation: (ChainUtxo & { covenantId: Hash32Hex }) | undefined;
      if (accepted) {
        if (claim.continuationOutpoint.txid !== attempt.transactionId) {
          throw new KaspaX402Error(
            "invalid_kaspa_outpoint",
            "continuation outpoint must belong to the accepted claim transaction",
          );
        }
        continuation = await this.#verifiedFundingUtxo(
          claim.continuationOutpoint,
          claim.continuationScriptPublicKey,
          claim.continuationFundingAmount,
          preview.channel.covenantId,
        );
        resultFinality = "confirmed";
      }
      const updated = accepted
        ? {
            ...preview.channel,
            version: incrementChannelVersion(preview.channel.version),
            escrowAddress: continuationEscrow.escrowAddress,
            activeOutpoint: claim.continuationOutpoint,
            activeScriptPublicKey: claim.continuationScriptPublicKey,
            ...claimedAccounting,
            lineage: appendClaimLineage(
              preview.channel,
              claim.transactionId,
              claim.continuationOutpoint,
              claim.continuationScriptPublicKey,
              claim.continuationFundingAmount,
              claimedAccounting.claimedCumulativeAmount,
              continuation!.acceptance,
            ),
          }
        : preview.channel;
      if (accepted) {
        const acceptedAttempt: ClaimAttemptRecord = {
          ...broadcastAttempt,
          continuationOutpoint: claim.continuationOutpoint,
          continuationScriptPublicKey: claim.continuationScriptPublicKey,
          continuationFundingAmount: claim.continuationFundingAmount,
          finality: "confirmed",
          acceptance: continuation!.acceptance,
          status: "accepted",
        };
        await this.#config.store.saveClaimAttempt(acceptedAttempt);
        await this.#config.store.applyClaimAttempt(updated, acceptedAttempt);
      }
      return {
        channel: updated,
        transactionId: attempt.transactionId,
        finality: resultFinality,
        accepted,
      };
    });
  }

  async abandonClaimAttempt(channelId: Hash32Hex): Promise<void> {
    await this.#config.lockManager.runExclusive(channelId, async () => {
      const attempt = await this.#config.store.loadOpenClaimAttempt(channelId);
      if (!attempt) return;
      if (attempt.status === "accepted") {
        throw new KaspaX402Error(
          "invalid_kaspa_transaction",
          "accepted claim attempts must be recovered, not abandoned",
        );
      }
      if (!this.#config.claimReconciler) {
        throw new KaspaX402Error(
          "invalid_kaspa_transaction",
          "trusted claim reconciler is required before abandonment",
        );
      }
      const reconciliation = await this.#runAdapter("claim-reconciler", () =>
        this.#config.claimReconciler!.reconcileClaim(attempt),
      );
      if (
        !/^[0-9a-f]{64}$/.test(reconciliation.transactionId) ||
        reconciliation.transactionId !== attempt.transactionId
      ) {
        throw new KaspaX402Error(
          "invalid_kaspa_transaction",
          "claim reconciliation transaction id does not match the persisted signed transaction",
        );
      }
      const decision = trustedChainEvidenceDecision(
        reconciliation.evidence,
        attempt.transactionId,
        attempt.requiredConfirmations,
        "claim reconciliation evidence",
        attempt.activeOutpoint,
      );
      if (decision.status === "unknown" || decision.status === "accepted") {
        throw new KaspaX402Error(
          "invalid_kaspa_transaction",
          "claim reconciliation remains unknown",
        );
      }
      if (decision.status === "confirmed") {
        throw new KaspaX402Error(
          "invalid_kaspa_transaction",
          "accepted claim attempts must be recovered, not abandoned",
        );
      }
      await this.#config.store.abandonClaimAttempt(
        attempt.attemptId,
        decision.evidence.reason,
      );
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
          attempt.status !== "pending")
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
      const transactionId = attempt.transactionId;
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
        channel.covenantId.toLowerCase() !== attempt.covenantId.toLowerCase() ||
        channel.chargedCumulativeAmount !== attempt.chargedCumulativeAmount ||
        channel.claimedCumulativeAmount !== attempt.claimedCumulativeAmount ||
        channel.signedMaxClaimable !== attempt.signedMaxClaimable ||
        channel.voucherSignature !== attempt.voucherSignature
      ) {
        throw new KaspaX402Error(
          "invalid_kaspa_settlement_response",
          "channel state changed after claim attempt",
        );
      }
      const claimedAccounting = applyBatchClaimAccounting(
        channel,
        attempt.claimAmount,
      );
      if (
        claimedAccounting.fundingAmount !== attempt.continuationFundingAmount
      ) {
        throw new KaspaX402Error(
          "invalid_kaspa_transaction",
          "claim continuation amount does not match recovered accounting",
        );
      }
      const continuationEscrow = deriveServerEscrow(
        this.#config,
        channel.channelConfig,
        claimedAccounting.claimedCumulativeAmount,
      );
      const continuation = await this.#verifiedFundingUtxo(
        attempt.continuationOutpoint,
        attempt.continuationScriptPublicKey,
        attempt.continuationFundingAmount,
        attempt.covenantId,
        attempt.requiredConfirmations,
      );
      const updated = {
        ...channel,
        version: incrementChannelVersion(channel.version),
        escrowAddress: continuationEscrow.escrowAddress,
        activeOutpoint: attempt.continuationOutpoint,
        activeScriptPublicKey: attempt.continuationScriptPublicKey,
        ...claimedAccounting,
        lineage: appendClaimLineage(
          channel,
          transactionId,
          attempt.continuationOutpoint,
          attempt.continuationScriptPublicKey,
          attempt.continuationFundingAmount,
          claimedAccounting.claimedCumulativeAmount,
          continuation.acceptance,
        ),
      };
      validateChannelAccounting(updated);
      let recoveredAttempt = attempt;
      if (recoveredAttempt.status === "pending") {
        recoveredAttempt = {
          ...recoveredAttempt,
          finality: "confirmed",
          acceptance: continuation.acceptance,
          status: "broadcast",
        };
        await this.#config.store.saveClaimAttempt(recoveredAttempt);
      }
      if (recoveredAttempt.status === "broadcast") {
        recoveredAttempt = {
          ...recoveredAttempt,
          finality: "confirmed",
          acceptance: continuation.acceptance,
          status: "accepted",
        };
        await this.#config.store.saveClaimAttempt(recoveredAttempt);
      }
      await this.#config.store.applyClaimAttempt(updated, recoveredAttempt);
      return {
        channel: updated,
        transactionId,
        finality: "confirmed",
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
    trustedSecurityContext?: PaidRequest["trustedSecurityContext"],
    mcpErrorChargeSompi?: SompiString,
  ): Promise<VerifiedPayment> {
    assertTrustedBatchContext(paymentPayload.accepted, trustedSecurityContext);
    const paymentRequired = await this.#expectedPaymentRequired(
      resource,
      paymentPayload,
      paymentAmount,
      requestedScheme,
      trustedSecurityContext,
      mcpErrorChargeSompi,
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
        requestFingerprint,
      );
    }
    if (payload.type === "voucher") {
      return this.#verifyVoucher(
        paymentRequired,
        paymentPayload,
        accepted,
        payload,
        requestFingerprint,
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
    const expiryError = exactAuthorizationExpiryError({
      maxTimeoutSeconds: accepted.maxTimeoutSeconds,
      authorizationExpiresAt: payload.authorization.expiresAt,
      ...(head ? { challengeExpiresAt: head.expiresAt } : {}),
    });
    const initiallyExpiredEvidence =
      expiryError === "expired_authorization" ||
      expiryError === "expired_challenge";
    if (expiryError && !initiallyExpiredEvidence) {
      throw new KaspaX402Error(
        "invalid_kaspa_signature",
        `exact request authorization expiry is invalid: ${expiryError}`,
      );
    }
    const paymentRequirementsHash = sha256Hex(stableStringify(accepted));
    const requiredFinality = strongerExactFinality(
      this.#config.acceptedFinality,
      accepted.extra.finality,
    );
    const verification = await this.#runAdapter("exact-transaction-verifier", () =>
      this.#config.exactTransactionVerifier!.verifyExactPayment({
        network: accepted.network,
        profile,
        transaction: payload.transaction,
        transactionEncoding: payload.transactionEncoding,
        paymentOutputIndex: payload.paymentOutputIndex,
        amount: accepted.amount,
        payTo: accepted.payTo,
        payToScriptPublicKey,
        requiredFinality,
        requestHash: requestFingerprint,
        paymentRequirementsHash,
        authorization: payload.authorization,
        ...(head ? { head } : {}),
      }),
    );
    if (!/^[0-9a-fA-F]{64}$/.test(verification.transactionId)) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "exact verifier returned an invalid transaction id",
      );
    }
    if (
      !/^[0-9a-fA-F]{64}$/.test(verification.requestAuthorization.publicKey)
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_signature",
        "exact verifier returned an invalid payer public key",
      );
    }
    const expectedAuthorizationDigest = exactRequestAuthorizationDigest({
      network: accepted.network,
      profile,
      transactionId: verification.transactionId,
      paymentOutputIndex: payload.paymentOutputIndex,
      amount: accepted.amount,
      payTo: accepted.payTo,
      payToScriptPublicKey,
      paymentRequirementsHash,
      requestHash: requestFingerprint,
      challengeId: head?.challengeId,
      inputIndex: payload.authorization.inputIndex,
      expiresAt: payload.authorization.expiresAt,
    });
    const requestAuthorizationId = exactRequestAuthorizationId(
      payload.authorization,
    );
    if (
      payload.authorization.digest.toLowerCase() !==
        expectedAuthorizationDigest ||
      verification.requestAuthorization.digest.toLowerCase() !==
        expectedAuthorizationDigest ||
      verification.requestAuthorization.authorizationId.toLowerCase() !==
        requestAuthorizationId ||
      verification.requestAuthorization.inputIndex !==
        payload.authorization.inputIndex
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_signature",
        "exact verifier did not authenticate the expected payer request authorization",
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
    const currentExpiryError = exactAuthorizationExpiryError({
      maxTimeoutSeconds: accepted.maxTimeoutSeconds,
      authorizationExpiresAt: payload.authorization.expiresAt,
      ...(head ? { challengeExpiresAt: head.expiresAt } : {}),
    });
    let recoveryOnly = false;
    if (currentExpiryError) {
      const currentlyExpiredEvidence =
        currentExpiryError === "expired_authorization" ||
        currentExpiryError === "expired_challenge";
      if (!currentlyExpiredEvidence) {
        throw new KaspaX402Error(
          "invalid_kaspa_signature",
          `exact request authorization expiry is invalid: ${currentExpiryError}`,
        );
      }
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
    const verified: VerifiedExactPayment = {
      scheme: "exact",
      profile,
      paymentRequired,
      paymentPayload,
      accepted,
      transactionId: verification.transactionId,
      requestAuthorizationId,
      payerPublicKey: verification.requestAuthorization.publicKey.toLowerCase(),
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
    if (currentExpiryError) {
      const existing = await this.#config.store.loadExactSettlementAttempt(
        verification.transactionId,
      );
      const candidate = this.#buildExactSettlementAttempt(
        verified,
        requestFingerprint,
        readPaymentIdentifier(paymentPayload),
        new Date().toISOString(),
      );
      if (
        !existing ||
        (existing.status !== "accepted" && existing.status !== "applied") ||
        !exactSettlementAttemptsMatch(existing, candidate)
      ) {
        throw new KaspaX402Error(
          "invalid_kaspa_signature",
          `exact request authorization expiry is invalid: ${currentExpiryError}`,
        );
      }
      recoveryOnly = true;
    }
    return recoveryOnly ? { ...verified, recoveryOnly: true } : verified;
  }

  #assertExactAuthorizationLive(verified: VerifiedExactPayment): void {
    const expiryError = exactAuthorizationExpiryError({
      maxTimeoutSeconds: verified.accepted.maxTimeoutSeconds,
      authorizationExpiresAt:
        verified.paymentPayload.payload.authorization.expiresAt,
      ...(verified.head ? { challengeExpiresAt: verified.head.expiresAt } : {}),
    });
    if (expiryError) {
      throw new KaspaX402Error(
        "invalid_kaspa_signature",
        `exact request authorization expiry is invalid: ${expiryError}`,
      );
    }
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
    requestFingerprint: Hash32Hex,
  ): Promise<VerifiedPayment> {
    validateChannelTerms(this.#config, accepted, payload.channelConfig);
    if (channelId(payload.channelConfig) !== payload.channelId) {
      throw new KaspaX402Error(
        "invalid_kaspa_channel_id",
        "channel id does not match channel config",
      );
    }
    let existing = await this.#config.store.loadChannel(payload.channelId);
    if (existing && existing.status !== "active") {
      throw new KaspaX402Error(
        "invalid_kaspa_channel_id",
        "existing channel is not active",
      );
    }
    if (
      existing &&
      payload.voucher.covenantId.toLowerCase() !==
        existing.covenantId.toLowerCase()
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_binding",
        "voucher covenant id does not match the existing channel lineage",
      );
    }
    if (
      existing &&
      sameActiveOutpoint(
        existing,
        payload.fundingOutpoint,
        payload.activeScriptPublicKey,
      )
    )
      this.#assertVoucherAmountAndBinding(
        existing,
        accepted,
        payload.voucher,
      );
    await this.#verifyVoucherProof(
      payload.channelId,
      payload.channelConfig.clientPublicKey,
      payload.channelConfig.network,
      payload.voucher,
    );
    await this.#verifyBatchPresentationProof(
      payload.channelId,
      payload.channelConfig.clientPublicKey,
      accepted,
      paymentPayload,
      requestFingerprint,
      payload.voucher,
    );
    await this.#assertRefundWindow(payload.channelConfig.refundTimeoutDaa);
    if (existing) {
      await this.#rejectOpenClaimAttempt(existing.channelId);
      existing = await this.#reconcileChannelSnapshot(existing);
      if (existing.status !== "active") {
        throw new KaspaX402Error(
          "invalid_kaspa_channel_id",
          "authoritative channel is not active",
        );
      }
    }
    const derived = deriveServerEscrow(
      this.#config,
      payload.channelConfig,
      existing?.claimedCumulativeAmount ?? "0",
    );
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
    let genesisEvidence = existing?.genesisEvidence;
    if (!existing) {
      const genesis = await this.#runAdapter("chain-provider", () =>
        this.#config.chainProvider.verifyCovenantGenesis({
          utxo,
          payment: paymentPayload,
        }),
      );
      if (
        !genesis ||
        genesis.totalOutputCount !== 1 ||
        genesis.authorizedOutputCount !== 1 ||
        genesis.covenantId.toLowerCase() !== utxo.covenantId.toLowerCase() ||
        genesis.genesisOutpoint.txid.toLowerCase() !==
          payload.fundingOutpoint.txid.toLowerCase() ||
        genesis.genesisOutpoint.index !== payload.fundingOutpoint.index ||
        genesis.genesisScriptPublicKey.toLowerCase() !==
          payload.activeScriptPublicKey.toLowerCase() ||
        genesis.genesisAmount !== utxo.amount
      ) {
        throw new KaspaX402Error(
          "invalid_kaspa_x402_binding",
          "escrow genesis is not a verified singleton KIP-20 covenant",
        );
      }
      const genesisDecision = trustedChainEvidenceDecision(
        genesis.acceptance,
        payload.fundingOutpoint.txid,
        this.#config.confirmationThreshold,
        "escrow genesis evidence",
      );
      if (
        genesisDecision.status !== "confirmed" ||
        !sameAcceptedEvidence(genesisDecision.evidence, utxo.acceptance)
      ) {
        throw new KaspaX402Error(
          "invalid_kaspa_x402_binding",
          "escrow genesis evidence does not match the authoritative UTXO",
        );
      }
      genesisEvidence = genesis;
    }
    const initial: ServerChannelRecord = {
      channelId: payload.channelId,
      covenantId: utxo.covenantId,
      version: existing?.version ?? "0",
      genesisEvidence: genesisEvidence!,
      channelConfig: payload.channelConfig,
      escrowAddress: payload.escrowAddress,
      activeOutpoint: payload.fundingOutpoint,
      activeScriptPublicKey: payload.activeScriptPublicKey,
      fundingAmount: utxo.amount,
      chargedCumulativeAmount: existing?.chargedCumulativeAmount ?? "0",
      claimedCumulativeAmount: existing?.claimedCumulativeAmount ?? "0",
      signedMaxClaimable: existing?.signedMaxClaimable ?? "0",
      voucherSignature: existing?.voucherSignature,
      lastCommitmentId: existing?.lastCommitmentId,
      lineage:
        existing?.lineage ??
        createCovenantLineageState(
          covenantLaunchManifest(
            this.#config.network,
            genesisEvidence!,
            payload.channelConfig.templateId,
          ),
        ),
      status: "active",
    };

    if (
      existing &&
      existing.covenantId.toLowerCase() !== utxo.covenantId.toLowerCase()
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_binding",
        "top-up covenant id does not match the existing channel lineage",
      );
    }

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
      const transition = await this.#runAdapter("top-up-verifier", () =>
        this.#config.topUpVerifier!.verifyTopUp({
          previous: existing,
          next: initial,
          utxo,
          payment: paymentPayload,
        }),
      );
      if (
        !transition ||
        parseBatchLaneAmount(
          initial.fundingAmount,
          "top-up successor funding amount",
        ) <=
          parseBatchLaneAmount(
            existing.fundingAmount,
            "top-up predecessor funding amount",
          ) ||
        transition.authorizedSuccessorCount !== 1 ||
        transition.covenantId.toLowerCase() !==
          existing.covenantId.toLowerCase() ||
        transition.spentOutpoint.txid.toLowerCase() !==
          existing.activeOutpoint.txid.toLowerCase() ||
        transition.spentOutpoint.index !== existing.activeOutpoint.index ||
        transition.successorOutpoint.txid.toLowerCase() !==
          initial.activeOutpoint.txid.toLowerCase() ||
        transition.successorOutpoint.index !== initial.activeOutpoint.index ||
        transition.successorScriptPublicKey.toLowerCase() !==
          initial.activeScriptPublicKey.toLowerCase() ||
        transition.successorAmount !== initial.fundingAmount
      )
        throw new KaspaX402Error(
          "invalid_kaspa_outpoint",
          "top-up transition was rejected",
        );
      const transitionDecision = trustedChainEvidenceDecision(
        transition.acceptance,
        initial.activeOutpoint.txid,
        this.#config.confirmationThreshold,
        "top-up transition evidence",
      );
      if (
        transitionDecision.status !== "confirmed" ||
        !sameAcceptedEvidence(transitionDecision.evidence, utxo.acceptance) ||
        !Number.isSafeInteger(transition.authorizingInput) ||
        transition.authorizingInput < 0
      ) {
        throw new KaspaX402Error(
          "invalid_kaspa_transaction",
          "top-up transition lacks confirmed objective chain evidence",
        );
      }
      initial.lineage = applyCovenantSelectedChainUpdate(existing.lineage, {
        fromCheckpoint: existing.lineage.checkpoint,
        checkpoint: transition.acceptance.checkpoint,
        continuity: "complete",
        removedChainBlockHashes: [],
        addedChainBlocks: [
          {
            blockHash: transition.acceptance.acceptingBlockHash,
            transitions: [
              {
                kind: "top-up",
                covenantId: transition.covenantId,
                templateId: initial.channelConfig.templateId,
                consumedOutpoint: transition.spentOutpoint,
                transactionId: transition.successorOutpoint.txid,
                authorizedSuccessorCount: transition.authorizedSuccessorCount,
                successor: {
                  outpoint: transition.successorOutpoint,
                  covenantId: transition.covenantId,
                  authorizingInput: transition.authorizingInput,
                  scriptPublicKey: transition.successorScriptPublicKey,
                  value: transition.successorAmount,
                  claimedCumulativeAmount: initial.claimedCumulativeAmount,
                },
                terminalOutput: null,
                acceptance: transition.acceptance,
              },
            ],
          },
        ],
      });
    }

    this.#assertVoucherAmountAndBinding(initial, accepted, payload.voucher);
    return {
      scheme: "batch-settlement",
      paymentRequired,
      paymentPayload: paymentPayload as VerifiedBatchPayment["paymentPayload"],
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
    requestFingerprint: Hash32Hex,
  ): Promise<VerifiedPayment> {
    const loaded = await this.#requireChannel(payload.channelId);
    validateChannelTerms(this.#config, accepted, loaded.channelConfig);
    if (loaded.status !== "active") {
      throw new KaspaX402Error(
        "invalid_kaspa_channel_id",
        "channel is not active",
      );
    }
    if (payload.clientPublicKey !== loaded.channelConfig.clientPublicKey) {
      throw new KaspaX402Error(
        "invalid_kaspa_public_key",
        "client public key does not match channel",
      );
    }
    if (
      !sameActiveOutpoint(
        loaded,
        payload.fundingOutpoint,
        payload.activeScriptPublicKey,
      )
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_outpoint",
        "payment outpoint does not match active channel",
      );
    }
    this.#assertVoucherAmountAndBinding(loaded, accepted, payload.voucher);
    await this.#verifyVoucherProof(
      loaded.channelId,
      loaded.channelConfig.clientPublicKey,
      loaded.channelConfig.network,
      payload.voucher,
    );
    await this.#verifyBatchPresentationProof(
      loaded.channelId,
      loaded.channelConfig.clientPublicKey,
      accepted,
      paymentPayload,
      requestFingerprint,
      payload.voucher,
    );
    await this.#rejectOpenClaimAttempt(loaded.channelId);
    const channel = await this.#reconcileChannelSnapshot(loaded);
    validateChannelTerms(this.#config, accepted, channel.channelConfig);
    await this.#assertRefundWindow(channel.channelConfig.refundTimeoutDaa);
    if (channel.status !== "active") {
      throw new KaspaX402Error(
        "invalid_kaspa_channel_id",
        "channel is not active",
      );
    }
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
      channel.covenantId,
    );
    this.#assertVoucherAmountAndBinding(channel, accepted, payload.voucher);
    return {
      scheme: "batch-settlement",
      paymentRequired,
      paymentPayload: paymentPayload as VerifiedBatchPayment["paymentPayload"],
      accepted,
      channel,
      commitExpectedChannel: channel,
      voucher: payload.voucher,
      openedChannel: false,
    };
  }

  #assertVoucherAmountAndBinding(
    channel: ServerChannelRecord,
    accepted: BatchPaymentRequirements,
    voucher: Voucher,
  ): void {
    validateChannelPreVoucherAccounting(channel);
    if (voucher.covenantId.toLowerCase() !== channel.covenantId.toLowerCase()) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_binding",
        "voucher covenant id does not match the channel lineage",
      );
    }
    const requiredVoucherAmount = requiredBatchVoucherAmount(
      channel,
      accepted.amount,
    );
    if (voucher.authorizedCumulativeAmount !== requiredVoucherAmount) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_amount",
        "voucher amount does not match required cumulative amount",
      );
    }
    const authorized = {
      ...channel,
      signedMaxClaimable: voucher.authorizedCumulativeAmount,
      voucherSignature: voucher.signature,
    };
    validateChannelAccounting(authorized);
    assertBatchVoucherReserve(authorized, accepted.extra.claimReserveSompi);
  }

  async #verifyVoucherProof(
    channelId: Hash32Hex,
    clientPublicKey: string,
    network: ChannelConfig["network"],
    voucher: Voucher,
  ): Promise<void> {
    const input = {
      network,
      covenantId: voucher.covenantId,
      authorizedCumulativeAmount: voucher.authorizedCumulativeAmount,
    };
    const verified = await this.#runAdapter("voucher-verifier", () =>
      this.#config.voucherVerifier.verifyVoucher({
        channelId,
        clientPublicKey,
        digest: voucherDigest(input),
        preimage: voucherPreimageHex(input),
        voucher,
      }),
    );
    if (!verified)
      throw new KaspaX402Error(
        "invalid_kaspa_signature",
        "voucher signature was rejected",
      );
  }

  async #verifyBatchPresentationProof(
    channelId: Hash32Hex,
    clientPublicKey: string,
    accepted: BatchPaymentRequirements,
    paymentPayload: PaymentPayload,
    requestFingerprint: Hash32Hex,
    voucher: Voucher,
  ): Promise<void> {
    const payload = paymentPayload.payload;
    if (payload.type !== "deposit-voucher" && payload.type !== "voucher") {
      throw new KaspaX402Error(
        "invalid_kaspa_payment_payload_type",
        "batch presentation requires a voucher payment payload",
      );
    }
    const presentation = payload.presentation;
    const expectedVoucherDigest = voucherDigest({
      network: accepted.network,
      covenantId: voucher.covenantId,
      authorizedCumulativeAmount: voucher.authorizedCumulativeAmount,
    });
    const expectedPaymentIdentifier =
      readPaymentIdentifier(paymentPayload) ?? null;
    if (
      presentation.version !== "kaspa-x402-batch-presentation-v1" ||
      presentation.requestFingerprint.toLowerCase() !==
        requestFingerprint.toLowerCase() ||
      presentation.acceptedRequirementsHash.toLowerCase() !==
        batchPaymentRequirementsHash(accepted) ||
      presentation.securityContextHash.toLowerCase() !==
        accepted.extra.securityContextHash.toLowerCase() ||
      presentation.channelId.toLowerCase() !== channelId.toLowerCase() ||
      presentation.covenantId.toLowerCase() !==
        voucher.covenantId.toLowerCase() ||
      presentation.voucherDigest.toLowerCase() !== expectedVoucherDigest ||
      presentation.paymentIdentifier !== expectedPaymentIdentifier
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_binding",
        "batch presentation does not bind the selected request, terms, identity, channel, covenant, and voucher",
      );
    }
    const expectedDigest = batchPresentationDigest(
      batchPresentationDigestInput(presentation),
    );
    if (presentation.digest.toLowerCase() !== expectedDigest) {
      throw new KaspaX402Error(
        "invalid_kaspa_signature",
        "batch presentation digest does not match its signed fields",
      );
    }
    const assertLive = () => {
      const expiryError = batchPresentationExpiryError({
        maxTimeoutSeconds: accepted.maxTimeoutSeconds,
        expiresAt: presentation.expiresAt,
      });
      if (expiryError) {
        throw new KaspaX402Error(
          "invalid_kaspa_signature",
          `batch presentation expiry is invalid: ${expiryError}`,
        );
      }
    };
    assertLive();
    const verified = await this.#runAdapter("batch-presentation-verifier", () =>
      this.#config.batchPresentationVerifier.verifyPresentation({
        channelId,
        clientPublicKey,
        digest: expectedDigest,
        signature: presentation.signature,
        presentation,
      }),
    );
    if (!verified) {
      throw new KaspaX402Error(
        "invalid_kaspa_signature",
        "batch presentation signature was rejected",
      );
    }
    assertLive();
  }

  async #assertRefundWindow(timeoutDaa: SompiString): Promise<void> {
    const timeout = parseSompiString(timeoutDaa);
    const current = parseSompiString(
      await this.#runAdapter("chain-provider", () =>
        this.#config.chainProvider.getVirtualDaaScore(),
      ),
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
    covenantId?: Hash32Hex,
    requiredConfirmations = this.#config.confirmationThreshold,
  ): Promise<ChainUtxo & { covenantId: Hash32Hex }> {
    const utxo = await this.#runAdapter("chain-provider", () =>
      this.#config.chainProvider.getUtxo(outpoint, this.#config.network),
    );
    if (!utxo)
      throw new KaspaX402Error(
        "invalid_kaspa_outpoint",
        "funding outpoint was not found",
      );
    if (!utxo.covenantId || /^0{64}$/i.test(utxo.covenantId)) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_binding",
        "funding outpoint is missing a non-zero covenant id",
      );
    }
    const acceptanceDecision = trustedChainEvidenceDecision(
      utxo.acceptance,
      outpoint.txid,
      requiredConfirmations,
      "funding outpoint evidence",
    );
    if (acceptanceDecision.status !== "confirmed") {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "funding outpoint has not reached the configured confirmation threshold",
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
    if (
      covenantId !== undefined &&
      utxo.covenantId.toLowerCase() !== covenantId.toLowerCase()
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_binding",
        "funding covenant id does not match the channel lineage",
      );
    }
    return {
      ...utxo,
      covenantId: utxo.covenantId,
      finality: "confirmed",
    } as ChainUtxo & { covenantId: Hash32Hex };
  }

  async #commitBatchResponse(
    verified: VerifiedBatchPayment,
    handlerResult: ProtectedHandlerResult,
    chargedAmount: SompiString,
    fingerprint: Hash32Hex,
    batchAttemptId: Hash32Hex,
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
      void error;
      return batchSettlementRecoveryRequiredResponse(500);
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
        batchAttemptId,
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

  #prepareLiveDepositTransition<T extends VerifiedPayment>(verified: T): T {
    if (
      verified.scheme !== "batch-settlement" ||
      verified.paymentPayload.payload.type !== "deposit-voucher"
    )
      return verified;
    const previous = verified.openedChannel
      ? null
      : verified.commitExpectedChannel;
    const channel: ServerChannelRecord = {
      ...verified.channel,
      version: previous ? incrementChannelVersion(previous.version) : "0",
      signedMaxClaimable: verified.voucher.authorizedCumulativeAmount,
      voucherSignature: verified.voucher.signature,
      status: "active",
    };
    validateChannelAccounting(channel);
    return {
      ...verified,
      channel,
      commitExpectedChannel: channel,
      channelTransitionPrevious: previous,
    } as T;
  }

  async #claimBatchSettlement(
    verified: VerifiedBatchPayment,
    fingerprint: Hash32Hex,
    paymentIdentifier?: string,
  ) {
    const now = new Date().toISOString();
    const paymentRequirementsHash = batchPaymentRequirementsHash(
      verified.accepted,
    );
    const payloadHash = paymentPayloadHash(verified.paymentPayload);
    const expected = expectedSettlementChannelState(
      verified.commitExpectedChannel,
    );
    const attemptId = this.#batchSettlementAttemptId(verified, fingerprint);
    const operationKind =
      verified.paymentPayload.payload.type !== "deposit-voucher"
        ? "payment"
        : verified.openedChannel
          ? "deposit"
          : sameActiveOutpoint(
                verified.channel,
                verified.channelTransitionPrevious!.activeOutpoint,
                verified.channelTransitionPrevious!.activeScriptPublicKey,
              )
            ? "deposit"
            : "top-up";
    const attempt: BatchSettlementAttemptRecord = {
      attemptId,
      channelId: verified.channel.channelId,
      covenantId: verified.channel.covenantId,
      requestFingerprint: fingerprint,
      paymentRequirementsHash,
      paymentPayloadHash: payloadHash,
      maximumCharge: verified.accepted.amount,
      expected,
      operationKind,
      payerId: verified.channel.channelConfig.clientPublicKey,
      ...(paymentIdentifier
        ? {
            paymentIdentifier: {
              id: paymentIdentifier,
              fingerprint,
              paymentPayloadHash: payloadHash,
              paymentScopeId: verified.channel.channelId,
              paymentKind: "batch-settlement" as const,
              ownerId: attemptId,
              payerId: verified.channel.channelConfig.clientPublicKey,
              channelId: verified.channel.channelId,
            },
          }
        : {}),
      ...(verified.channelTransitionPrevious !== undefined
        ? {
            channelTransition: {
              previous: verified.channelTransitionPrevious,
              next: verified.channel,
            },
          }
        : {}),
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    return this.#config.store.claimBatchSettlement(attempt);
  }

  #batchSettlementAttemptId(
    verified: VerifiedBatchPayment,
    fingerprint: Hash32Hex,
  ): Hash32Hex {
    return batchSettlementAttemptId({
      channelId: verified.channel.channelId,
      covenantId: verified.channel.covenantId,
      requestFingerprint: fingerprint,
      paymentRequirementsHash: batchPaymentRequirementsHash(verified.accepted),
      paymentPayloadHash: paymentPayloadHash(verified.paymentPayload),
    });
  }

  async #claimExactSettlement(
    verified: VerifiedExactPayment,
    fingerprint: Hash32Hex,
    paymentIdentifier?: string,
  ): Promise<ExactSettlementClaimResult> {
    const now = new Date().toISOString();
    const attempt = this.#buildExactSettlementAttempt(
      verified,
      fingerprint,
      paymentIdentifier,
      now,
    );
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

  #buildExactSettlementAttempt(
    verified: VerifiedExactPayment,
    fingerprint: Hash32Hex,
    paymentIdentifier: string | undefined,
    now: string,
  ): ExactSettlementAttemptRecord {
    if (!verified.transaction) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "exact transaction artifact is required",
      );
    }
    const payloadHash = paymentPayloadHash(verified.paymentPayload);
    const payerId = verified.payerPublicKey;
    const paymentScopeId =
      safePaymentScopeIdHint(verified.paymentPayload) ??
      exactPaymentScopeId(verified.transactionId);
    const attempt: ExactSettlementAttemptRecord = {
      transactionId: verified.transactionId,
      profile: verified.profile,
      amount: verified.accepted.amount,
      paymentOutputIndex: verified.paymentOutputIndex,
      requestFingerprint: fingerprint,
      paymentRequirementsHash: sha256Hex(stableStringify(verified.accepted)),
      paymentPayloadHash: payloadHash,
      requestAuthorizationId: verified.requestAuthorizationId,
      payToScriptPublicKey: verified.accepted.extra.payToScriptPublicKey!,
      transaction: verified.transaction,
      // The route matcher already requires the advertised exact finality to
      // equal this configured threshold. Persist that immutable value so
      // recovery cannot later weaken it.
      requiredFinality: this.#config.acceptedFinality,
      payerId,
      ...(paymentIdentifier
        ? {
            paymentIdentifier: {
              id: paymentIdentifier,
              fingerprint,
              paymentPayloadHash: payloadHash,
              paymentScopeId,
              paymentKind: "exact" as const,
              ownerId: verified.transactionId,
              payerId,
              transactionId: verified.transactionId,
              paymentOutputIndex: verified.paymentOutputIndex,
            },
          }
        : {}),
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
    return attempt;
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
      if (
        !exactFinalityMeets(
          claim.attempt.finality,
          claim.attempt.requiredFinality,
        ) ||
        !exactFinalityMeets(
          claim.attempt.finality,
          this.#config.acceptedFinality,
        )
      ) {
        throw new KaspaX402Error(
          "invalid_kaspa_transaction",
          "accepted exact settlement is below the required finality",
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
    if (verified.recoveryOnly) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "expired exact recovery cannot construct or rebroadcast a transaction",
      );
    }
    if (!verified.transaction) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "exact settlement is missing the verified transaction artifact",
      );
    }
    const transaction = verified.transaction;
    let broadcast: TransactionBroadcast;
    try {
      broadcast = await this.#runAdapter("chain-provider", () =>
        this.#config.chainProvider.sendTransaction(transaction),
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
      channelId: verified.channel.channelId,
      presentationDigest: verified.paymentPayload.payload.presentation.digest,
      requestFingerprint: fingerprint,
      activeOutpoint: verified.channel.activeOutpoint,
      voucher: verified.voucher,
      fixedCharge: chargedAmount,
      authorizedCumulativeBefore: verified.channel.chargedCumulativeAmount,
      authorizedCumulativeAfter: chargedCumulativeAmount,
      claimedCumulativeAmount: verified.channel.claimedCumulativeAmount,
    });
    const channel: ServerChannelRecord = {
      ...verified.channel,
      version: incrementChannelVersion(verified.channel.version),
      chargedCumulativeAmount,
      signedMaxClaimable: verified.voucher.authorizedCumulativeAmount,
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
        covenantId: channel.covenantId,
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
        covenantId: channel.covenantId,
        requestFingerprint: fingerprint,
        paymentRequirementsHash: batchPaymentRequirementsHash(
          verified.accepted,
        ),
        paymentPayloadHash: paymentPayloadHash(verified.paymentPayload),
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
        requestAuthorizationId: verified.requestAuthorizationId,
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
      batchPaymentRequirementsHash(paymentPayload.accepted)
    )
      return undefined;
    if (record.paymentPayloadHash !== paymentPayloadHash(paymentPayload))
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
      record.voucher.authorizedCumulativeAmount !==
        payload.voucher.authorizedCumulativeAmount ||
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
    trustedSecurityContext?: PaidRequest["trustedSecurityContext"],
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
        ...(trustedSecurityContext ? { trustedSecurityContext } : {}),
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
      trustedSecurityContext,
    );
  }

  async #correctiveResponse(
    resource: ResourceInfo,
    paymentPayload: PaymentPayload,
    error: unknown,
    paymentAmount?: SompiString,
    requestedScheme?: "exact" | "batch-settlement",
    trustedSecurityContext?: PaidRequest["trustedSecurityContext"],
  ): Promise<ServerResponse> {
    const errorReason =
      error instanceof KaspaX402Error
        ? toX402ErrorReason(error.code)
        : "invalid_payload";
    const scheme =
      paymentPayload.accepted.scheme === "exact"
        ? paymentPayload.accepted.scheme
        : requestedScheme;
    if (
      error instanceof KaspaX402Error &&
      [
        "invalid_kaspa_signature",
        "invalid_kaspa_x402_amount",
      ].includes(error.code) &&
      paymentPayload.accepted.scheme === "batch-settlement"
    ) {
      const paymentRequired: PaymentRequired = {
        x402Version: X402_VERSION,
        resource,
        accepts: [paymentPayload.accepted],
        error: errorReason,
        ...requiredPaymentIdentifierExtensions(this.#config),
      };
      return {
        status: 402,
        headers: {
          [PAYMENT_REQUIRED_HEADER]:
            encodePaymentRequiredHeader(paymentRequired),
        },
        body: { error: errorReason },
      };
    }
    const paymentRequired = await this.#paymentRequiredResponse({
      resource,
      amount: paymentAmount,
      scheme,
      error: errorReason,
      ...(trustedSecurityContext ? { trustedSecurityContext } : {}),
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

  async #reconcileChannelSnapshot(
    channel: ServerChannelRecord,
  ): Promise<ServerChannelRecord> {
    const update = await this.#runAdapter("chain-provider", () =>
      this.#config.chainProvider.discoverCovenantLineage({
        network: channel.channelConfig.network,
        covenantId: channel.covenantId,
        templateId: channel.channelConfig.templateId,
        lineage: channel.lineage,
        minConfirmationCount: this.#config.confirmationThreshold,
      }),
    );
    let lineage: CovenantLineageState;
    try {
      lineage = applyCovenantSelectedChainUpdate(channel.lineage, update);
      assertCovenantLineageConfirmed(
        lineage,
        this.#config.confirmationThreshold,
      );
    } catch (error) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        error instanceof Error
          ? `authoritative covenant lineage is unavailable: ${error.message}`
          : "authoritative covenant lineage is unavailable",
      );
    }

    if (sameCovenantLineage(channel.lineage, lineage)) {
      const existingLease = await this.#config.store.loadChannelOperation(
        channel.channelId,
      );
      if (
        existingLease &&
        (existingLease.kind === "recovery" ||
          existingLease.kind === "refund") &&
        stableStringify(existingLease.expected) === stableStringify(channel)
      ) {
        await this.#config.store.abandonChannelOperation(
          existingLease.leaseId,
          "authoritative lineage confirms the durable head is unchanged",
          new Date().toISOString(),
        );
      }
      return channel;
    }

    const operationKind = "recovery" as const;
    const leaseId = channelOperationLeaseId(
      operationKind,
      channel,
      "authoritative-lineage",
    );
    const now = new Date().toISOString();
    await this.#config.store.claimChannelOperation({
      leaseId,
      channelId: channel.channelId,
      covenantId: channel.covenantId,
      kind: operationKind,
      expected: channel,
      status: "reserved",
      createdAt: now,
      updatedAt: now,
    });

    if (lineage.currentHead === null) {
      const refund = canonicalCovenantTransitions(lineage).at(-1);
      const refundScriptPublicKey =
        this.#config.addressCodec.scriptPublicKeyForAddress(
          channel.channelConfig.refundAddress,
          channel.channelConfig.network,
        );
      if (
        refund?.kind !== "refund" ||
        refund.terminalOutput?.scriptPublicKey.toLowerCase() !==
          refundScriptPublicKey.toLowerCase()
      ) {
        throw new KaspaX402Error(
          "invalid_kaspa_x402_binding",
          "authoritative terminal output does not match the configured refund script",
        );
      }
      const terminal = {
        ...channel,
        version: incrementChannelVersion(channel.version),
        lineage,
        status: "refunded" as const,
      };
      await this.#config.store.applyCovenantLineage(channel, terminal, leaseId);
      return terminal;
    }

    const head = lineage.currentHead;
    const derived = deriveServerEscrow(
      this.#config,
      channel.channelConfig,
      head.claimedCumulativeAmount,
    );
    if (
      derived.activeScriptPublicKey.toLowerCase() !==
      head.scriptPublicKey.toLowerCase()
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_binding",
        "authoritative successor does not match the escrow covenant template state",
      );
    }
    await this.#verifiedFundingUtxo(
      head.outpoint,
      head.scriptPublicKey,
      head.value,
      channel.covenantId,
    );
    const reconciled: ServerChannelRecord = {
      ...channel,
      version: incrementChannelVersion(channel.version),
      escrowAddress: derived.escrowAddress,
      activeOutpoint: structuredClone(head.outpoint),
      activeScriptPublicKey: head.scriptPublicKey,
      fundingAmount: head.value,
      claimedCumulativeAmount: head.claimedCumulativeAmount,
      lineage,
      status:
        channel.status === "refunded" ||
        serverCovenantLineageRolledBack(channel.lineage, lineage)
          ? "suspicious"
          : channel.status,
    };
    await this.#config.store.applyCovenantLineage(channel, reconciled, leaseId);
    return reconciled;
  }

  async #expectedPaymentRequired(
    resource: ResourceInfo,
    paymentPayload: PaymentPayload,
    paymentAmount?: SompiString,
    requestedScheme?: "exact" | "batch-settlement",
    trustedSecurityContext?: PaidRequest["trustedSecurityContext"],
    mcpErrorChargeSompi?: SompiString,
  ): Promise<PaymentRequired> {
    const payloadChannelId = safePaymentChannelId(paymentPayload);
    const accepted = paymentPayload.accepted;
    if (accepted.scheme === "exact") {
      if (exactRequirementMatchesRoute(this.#config, accepted, paymentAmount)) {
        return {
          x402Version: X402_VERSION,
          resource,
          accepts: [accepted],
          ...requiredPaymentIdentifierExtensions(this.#config, true),
        };
      }
      return this.#buildRuntimePaymentRequired({
        resource,
        amount: paymentAmount,
        scheme: "exact",
        ...(trustedSecurityContext ? { trustedSecurityContext } : {}),
      });
    }
    if (accepted.scheme !== "batch-settlement" || !payloadChannelId) {
      return this.buildPaymentRequired({
        resource,
        amount: paymentAmount,
        scheme: requestedScheme,
        ...(trustedSecurityContext ? { trustedSecurityContext } : {}),
      });
    }
    const channel = await this.#config.store.loadChannel(payloadChannelId);
    const acceptedExtra = accepted.extra;
    if (!channel || channel.status !== "active") {
      if (
        this.#config.allowRollingRefundTimeoutDaa &&
        paymentPayload.payload.type === "deposit-voucher" &&
        !acceptedExtra.channelState &&
        batchRequirementMatchesRoute(
          this.#config,
          accepted,
          paymentAmount,
          mcpErrorChargeSompi,
        )
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
        ...(mcpErrorChargeSompi ? { mcpErrorChargeSompi } : {}),
        ...(trustedSecurityContext ? { trustedSecurityContext } : {}),
      });
    }
    if (!acceptedExtra.channelState) {
      if (
        batchRequirementMatchesRoute(
          this.#config,
          accepted,
          paymentAmount,
          mcpErrorChargeSompi,
        ) &&
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
        ...(mcpErrorChargeSompi ? { mcpErrorChargeSompi } : {}),
        ...(trustedSecurityContext ? { trustedSecurityContext } : {}),
      });
    }
    return this.buildPaymentRequired({
      resource,
      amount: paymentAmount,
      scheme: "batch-settlement",
      channel,
      ...(mcpErrorChargeSompi ? { mcpErrorChargeSompi } : {}),
      ...(trustedSecurityContext ? { trustedSecurityContext } : {}),
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
      ...requiredPaymentIdentifierExtensions(
        this.#config,
        paymentRequirements.scheme === "exact",
      ),
    };
  }
}

function makePaymentRequired(
  config: ResolvedServerConfig,
  options: BuildPaymentRequiredOptions,
): PaymentRequired {
  const schemes = paymentRequirementSchemes(config, options);
  return {
    x402Version: X402_VERSION,
    resource: options.resource,
    accepts: schemes.map((scheme) =>
      normalizePaymentRequirementsHex(
        makeAcceptedRequirement(config, options, scheme),
      ),
    ),
    ...(options.error ? { error: options.error } : {}),
    ...requiredPaymentIdentifierExtensions(config, schemes.includes("exact")),
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

  if (config.network !== "kaspa:testnet-10") {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_network",
      "batch settlement is restricted to kaspa:testnet-10 in Alpha.11",
    );
  }
  const amount = options.amount ?? config.amount;
  if (
    options.mcpErrorChargeSompi !== undefined &&
    options.mcpErrorChargeSompi !== amount
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_amount",
      "MCP error charge must equal the batch fixed charge",
    );
  }
  return {
    scheme: "batch-settlement",
    network: config.network,
    amount,
    asset: "KAS",
    payTo: config.payTo,
    maxTimeoutSeconds: config.maxTimeoutSeconds,
    extra: {
      binding: "kaspa-escrow-v3",
      templateId: config.templateId,
      serverPublicKey: config.serverPublicKey,
      minDepositSompi: advertisedBatchMinimumDeposit(config, amount),
      claimReserveSompi: config.claimReserveSompi,
      refundTimeoutDaa:
        options.channel?.channelConfig.refundTimeoutDaa ??
        config.refundTimeoutDaa,
      securityContextHash:
        options.securityContextHash ??
        (options.trustedSecurityContext
          ? trustedSecurityContextHash(options.trustedSecurityContext)
          : sha256Hex(
              stableStringify({
                scope: "kaspa:x402:security-context:v1",
                resource: options.resource,
              }),
            )),
      ...(options.mcpErrorChargeSompi
        ? { mcpErrorChargeSompi: options.mcpErrorChargeSompi }
        : {}),
      ...(config.claimPolicy ? { claimPolicy: config.claimPolicy } : {}),
      ...(options.channel
        ? { channelState: channelState(options.channel) }
        : {}),
    },
  };
}

function paymentRequirementSchemes(
  config: ResolvedServerConfig,
  options: BuildPaymentRequiredOptions,
): Array<"exact" | "batch-settlement"> {
  const schemes =
    options.schemes && options.schemes.length > 0
      ? options.schemes
      : [options.scheme ?? "batch-settlement"];
  const unique = [...new Set(schemes)];
  if (
    config.exactProfile === "additive" &&
    !config.exactSettlementReconciler &&
    unique.includes("exact")
  ) {
    const executable = unique.filter((scheme) => scheme !== "exact");
    if (executable.length === 0) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "additive exact requires a trusted settlement reconciler",
      );
    }
    return executable;
  }
  return unique;
}

function paymentRequirementRouteOptions(
  request: PaidRequest,
): Pick<
  BuildPaymentRequiredOptions,
  "scheme" | "schemes" | "trustedSecurityContext" | "mcpErrorChargeSompi"
> {
  const trustedSecurityContext = request.trustedSecurityContext;
  const mcpErrorChargeSompi = request.mcpErrorChargeSompi;
  if (request.paymentSchemes !== undefined)
    return {
      schemes: request.paymentSchemes,
      ...(trustedSecurityContext ? { trustedSecurityContext } : {}),
      ...(mcpErrorChargeSompi ? { mcpErrorChargeSompi } : {}),
    };
  return {
    scheme: request.paymentScheme,
    ...(trustedSecurityContext ? { trustedSecurityContext } : {}),
    ...(mcpErrorChargeSompi ? { mcpErrorChargeSompi } : {}),
  };
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

function isMcpErrorResultBody(body: unknown): boolean {
  return (
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    (body as { isError?: unknown }).isError === true
  );
}

function requiredPaymentIdentifierExtensions(
  config: Pick<ResolvedServerConfig, "requirePaymentIdentifier">,
  exactRequired = false,
): Pick<PaymentRequired, "extensions"> | Record<string, never> {
  return config.requirePaymentIdentifier || exactRequired
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
  return bindRequestHashToTrustedContext(
    facilitatorRequestHash(options),
    options.trustedSecurityContext,
  );
}

function facilitatorRequestHash(
  options: DirectPaymentVerificationOptions,
): Hash32Hex {
  if (options.requestHash !== undefined) {
    return normalizedFacilitatorRequestHash(options.requestHash);
  }
  const payload = options.paymentPayload.payload;
  if (payload.type === "exact-transaction") {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      "exact facilitator requests require an independently computed requestHash",
    );
  }
  return sha256Hex(
    stableStringify({
      scope: "kaspa:x402:facilitator-request:v1",
      resource: options.resource ?? null,
      paymentRequirements: options.paymentRequirements,
      paymentPayloadHash: paymentPayloadHash(options.paymentPayload),
    }),
  );
}

function assertTrustedBatchContext(
  accepted: PaymentRequirements,
  context: DirectPaymentVerificationOptions["trustedSecurityContext"],
): void {
  if (!context || accepted.scheme !== "batch-settlement") return;
  if (
    accepted.extra.securityContextHash.toLowerCase() !==
    trustedSecurityContextHash(context)
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_binding",
      "batch payment security context does not match the trusted caller context",
    );
  }
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
  return normalizePaymentPayloadHex(result.value);
}

function validatedPaymentRequired(paymentRequired: unknown): PaymentRequired {
  const result = validatePaymentRequired(paymentRequired);
  if (!result.ok) throw result.error;
  return {
    ...result.value,
    accepts: result.value.accepts.map(normalizePaymentRequirementsHex),
  };
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
  if (config.exactProfile === "additive" && !config.exactSettlementReconciler) {
    throw new KaspaX402Error(
      "invalid_kaspa_transaction",
      "additive exact requires a trusted settlement reconciler",
    );
  }
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
  if (config.network !== "kaspa:testnet-10") {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_network",
      "batch settlement is restricted to kaspa:testnet-10 in Alpha.11",
    );
  }
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
  if (accepted.extra.claimReserveSompi !== config.claimReserveSompi) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      "claim reserve does not match server config",
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
  mcpErrorChargeSompi?: SompiString,
): boolean {
  const amount = paymentAmount ?? config.amount;
  return (
    accepted.network === config.network &&
    accepted.amount === amount &&
    accepted.asset === "KAS" &&
    accepted.payTo === config.payTo &&
    accepted.maxTimeoutSeconds === config.maxTimeoutSeconds &&
    accepted.extra.binding === "kaspa-escrow-v3" &&
    accepted.extra.templateId === config.templateId &&
    accepted.extra.serverPublicKey === config.serverPublicKey &&
    accepted.extra.minDepositSompi ===
      advertisedBatchMinimumDeposit(config, amount) &&
    accepted.extra.claimReserveSompi === config.claimReserveSompi &&
    accepted.extra.mcpErrorChargeSompi === mcpErrorChargeSompi &&
    ((accepted.extra.claimPolicy === undefined &&
      config.claimPolicy === undefined) ||
      (accepted.extra.claimPolicy !== undefined &&
        config.claimPolicy !== undefined &&
        stableStringify(accepted.extra.claimPolicy) ===
          stableStringify(config.claimPolicy)))
  );
}

function advertisedBatchMinimumDeposit(
  config: Pick<ResolvedServerConfig, "minDepositSompi" | "claimReserveSompi">,
  amount: SompiString,
): SompiString {
  const configuredMinimum = parseBatchLaneAmount(
    config.minDepositSompi,
    "minimum deposit",
  );
  const firstVoucherCapacity =
    parseBatchLaneAmount(amount, "batch payment amount") +
    parseBatchLaneAmount(config.claimReserveSompi, "claim reserve");
  const advertised = formatSompiString(
    configuredMinimum > firstVoucherCapacity
      ? configuredMinimum
      : firstVoucherCapacity,
  );
  parseBatchLaneAmount(advertised, "advertised minimum deposit");
  return advertised;
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
  claimedCumulativeAmount: SompiString = "0",
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
    claimedCumulativeAmount,
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
    covenantId: channel.covenantId,
    activeOutpoint: channel.activeOutpoint,
    activeScriptPublicKey: channel.activeScriptPublicKey,
    fundingAmount: channel.fundingAmount,
    authorizedCumulativeAmount: channel.signedMaxClaimable,
    claimedCumulativeAmount: channel.claimedCumulativeAmount,
  };
}

function expectedSettlementChannelState(channel: ServerChannelRecord) {
  return structuredClone(channel);
}

function incrementChannelVersion(version: SompiString): SompiString {
  return (parseBatchLaneAmount(version, "channel version") + 1n).toString();
}

function validateChannelAccounting(channel: ServerChannelRecord): void {
  batchLaneAccounting(channel);
}

function validateChannelPreVoucherAccounting(
  channel: ServerChannelRecord,
): void {
  batchLaneAccounting(channel);
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
      scope: "kaspa:x402:exact-payment-transaction-artifact:v2",
      transactionIdentityHash: exactTransactionReplayIdentityHash(transaction),
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
  const record = headers as Record<string, string>;
  let visited = 0;
  let found: string | undefined;
  for (const key in record) {
    if (!Object.hasOwn(record, key)) continue;
    visited += 1;
    if (
      visited > KASPA_X402_RESOURCE_BUDGET.maxObjectProperties ||
      utf8ByteLength(key) > KASPA_X402_RESOURCE_BUDGET.maxStringBytes
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_payload",
        "HTTP headers exceed the structural limit",
      );
    }
    if (key.toLowerCase() !== name.toLowerCase()) continue;
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (
      !descriptor ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string"
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_payload",
        "HTTP header must be a plain string value",
      );
    }
    found = descriptor.value;
  }
  return found;
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
  const requestHash =
    request.requestHash ??
    sha256Hex(
      stableStringify({
        method: request.method ?? "GET",
        url: request.url,
        body: request.body ?? null,
        paymentRequirementsHash: sha256Hex(stableStringify(accepted)),
      }),
    );
  return bindRequestHashToTrustedContext(
    requestHash,
    request.trustedSecurityContext,
  );
}

function paymentPayloadHash(paymentPayload: PaymentPayload): Hash32Hex {
  return paymentReplayIdentityHash(paymentPayload);
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

function assertServerCoordinationTopology(
  store: DirectModeServerConfig["store"],
  lock: ChannelLockManager,
): void {
  if (!store.coordinationDomain || !lock.coordinationDomain)
    throw new Error("store and lock coordination domains are required");
  if (
    store.coordinationScope === "deployment-wide" &&
    (lock.coordinationScope !== "deployment-wide" ||
      lock.coordinationDomain !== store.coordinationDomain)
  ) {
    throw new Error(
      "deployment-wide store requires a deployment-wide lock for the same domain",
    );
  }
  const registered = lockByStoreCoordinationDomain.get(
    store.coordinationDomain,
  );
  if (
    registered &&
    registered !== lock &&
    !(
      registered.coordinationScope === "deployment-wide" &&
      lock.coordinationScope === "deployment-wide" &&
      registered.coordinationDomain === lock.coordinationDomain
    )
  ) {
    throw new Error(
      "shared store cannot be used by multiple server instances without one deployment-wide lock",
    );
  }
  lockByStoreCoordinationDomain.set(store.coordinationDomain, lock);
}

function isPaymentIdentifierOwnershipError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("payment identifier");
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

function batchSettlementAttemptId(input: {
  channelId: Hash32Hex;
  covenantId: Hash32Hex;
  requestFingerprint: Hash32Hex;
  paymentRequirementsHash: Hash32Hex;
  paymentPayloadHash: Hash32Hex;
}): Hash32Hex {
  return sha256Hex(
    stableStringify({
      scope: "kaspa:x402:batch-settlement-attempt:v2",
      ...input,
    }),
  );
}

function batchSettlementRecoveryRequiredResponse(status = 503): ServerResponse {
  return {
    status,
    headers: {},
    body: { error: "batch_settlement_recovery_required" },
  };
}

async function markBatchHandlerRecoveryRequiredSafely(
  store: DirectModeServerConfig["store"],
  attemptId: Hash32Hex,
  reason: string,
): Promise<void> {
  try {
    await store.markBatchHandlerRecoveryRequired(
      attemptId,
      reason,
      new Date().toISOString(),
    );
  } catch {
    // A post-write transport error may mean the recovery marker is durable.
  }
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

function covenantLaunchManifest(
  network: DirectModeServerConfig["network"],
  genesis: NonNullable<ServerChannelRecord["genesisEvidence"]>,
  templateId: "kaspa-x402-escrow-v4",
): CovenantLaunchManifest {
  return {
    format: "kaspa-x402-covenant-launch-v1",
    network,
    compiler: structuredClone(ESCROW_V4_LAUNCH_IDENTITY.compiler),
    source: structuredClone(ESCROW_V4_LAUNCH_IDENTITY.source),
    bytecode: {
      ...structuredClone(ESCROW_V4_LAUNCH_IDENTITY.bytecode),
      templateId,
    },
    constructorSlots: structuredClone(
      ESCROW_V4_LAUNCH_IDENTITY.constructorSlots,
    ),
    abi: structuredClone(ESCROW_V4_LAUNCH_IDENTITY.abi),
    selectors: structuredClone(ESCROW_V4_LAUNCH_IDENTITY.selectors),
    identitySha256: ESCROW_V4_LAUNCH_IDENTITY.identitySha256,
    genesis: {
      derivation: "kip20-covenant-id-v1",
      covenantId: genesis.covenantId,
      authorizingInput: structuredClone(genesis.authorizingInput),
      transactionId: genesis.genesisOutpoint.txid,
      outpoint: structuredClone(genesis.genesisOutpoint),
      scriptPublicKey: genesis.genesisScriptPublicKey,
      value: genesis.genesisAmount,
      claimedCumulativeAmount: "0",
      acceptance: structuredClone(genesis.acceptance),
    },
  };
}

function serverCovenantLineageRolledBack(
  previous: CovenantLineageState,
  next: CovenantLineageState,
): boolean {
  const canonical = new Set(
    canonicalCovenantTransitions(next).map((transition) =>
      transition.transactionId.toLowerCase(),
    ),
  );
  return canonicalCovenantTransitions(previous).some(
    (transition) => !canonical.has(transition.transactionId.toLowerCase()),
  );
}

function trustedChainEvidenceDecision(
  evidence: TrustedTransactionEvidence | null | undefined,
  expectedTransactionId: Hash32Hex,
  requiredConfirmations: number,
  label: string,
  expectedSpentOutpoint?: FundingOutpoint,
): ReturnType<typeof decideChainEvidence> {
  if (
    !evidence ||
    typeof evidence !== "object" ||
    typeof evidence.transactionId !== "string" ||
    evidence.transactionId.toLowerCase() !== expectedTransactionId.toLowerCase()
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_transaction",
      `${label} does not match the persisted transaction`,
    );
  }
  try {
    const decision = decideChainEvidence(evidence, requiredConfirmations);
    if (
      decision.status === "absent" &&
      expectedSpentOutpoint &&
      decision.evidence.proof.kind === "confirmed-conflicting-spend" &&
      !sameOutpoint(
        decision.evidence.proof.spentOutpoint,
        expectedSpentOutpoint,
      )
    ) {
      return {
        status: "unknown",
        evidence: {
          status: "unknown",
          transactionId: decision.evidence.transactionId,
          reason: `${label} conflicting spend is not bound to the reserved outpoint`,
          checkpoint: decision.evidence.proof.conflictingTransaction.checkpoint,
        },
      };
    }
    return decision;
  } catch (error) {
    throw new KaspaX402Error(
      "invalid_kaspa_transaction",
      `${label} is malformed: ${error instanceof Error ? error.message : "invalid evidence"}`,
    );
  }
}

function sameAcceptedEvidence(
  left: AcceptedTransactionEvidence,
  right: AcceptedTransactionEvidence,
): boolean {
  return (
    left.status === right.status &&
    left.transactionId.toLowerCase() === right.transactionId.toLowerCase() &&
    left.acceptingBlockHash.toLowerCase() ===
      right.acceptingBlockHash.toLowerCase() &&
    left.acceptingBlockBlueScore === right.acceptingBlockBlueScore &&
    left.confirmationCount === right.confirmationCount &&
    left.checkpoint.blockHash.toLowerCase() ===
      right.checkpoint.blockHash.toLowerCase() &&
    left.checkpoint.blueScore === right.checkpoint.blueScore &&
    left.checkpoint.daaScore === right.checkpoint.daaScore
  );
}

function appendClaimLineage(
  channel: ServerChannelRecord,
  transactionId: Hash32Hex,
  continuationOutpoint: FundingOutpoint,
  continuationScriptPublicKey: string,
  continuationFundingAmount: SompiString,
  claimedCumulativeAmount: SompiString,
  acceptance: AcceptedTransactionEvidence,
): CovenantLineageState {
  return applyCovenantSelectedChainUpdate(channel.lineage, {
    fromCheckpoint: channel.lineage.checkpoint,
    checkpoint: acceptance.checkpoint,
    continuity: "complete",
    removedChainBlockHashes: [],
    addedChainBlocks: [
      {
        blockHash: acceptance.acceptingBlockHash,
        transitions: [
          {
            kind: "claim",
            covenantId: channel.covenantId,
            templateId: channel.channelConfig.templateId,
            consumedOutpoint: channel.activeOutpoint,
            transactionId,
            authorizedSuccessorCount: 1,
            successor: {
              outpoint: continuationOutpoint,
              covenantId: channel.covenantId,
              authorizingInput: 0,
              scriptPublicKey: continuationScriptPublicKey,
              value: continuationFundingAmount,
              claimedCumulativeAmount,
            },
            terminalOutput: null,
            acceptance,
          },
        ],
      },
    ],
  });
}

function channelOperationLeaseId(
  kind: "claim" | "refund" | "recovery" | "retirement",
  channel: ServerChannelRecord,
  discriminator: string,
): Hash32Hex {
  return sha256Hex(
    stableStringify({
      scope: "kaspa:x402:channel-operation-lease:v1",
      kind,
      channel,
      discriminator,
    }),
  );
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

function assertExactHeadLineageResult(
  head: ExactHeadRecord,
  steps: readonly ExactHeadLineageStep[],
): void {
  if (steps.length === 0 || steps.length > 64) {
    throw new KaspaX402Error(
      "invalid_kaspa_transaction",
      "exact head reconciliation requires between 1 and 64 lineage steps",
    );
  }
  const threshold = parseSompiString(head.additiveThresholdSompi);
  let currentOutpoint = head.currentOutpoint;
  let currentAmount = parseSompiString(head.currentAmount);
  for (const step of steps) {
    if (
      (step.finality !== "accepted" && step.finality !== "confirmed") ||
      !/^[0-9a-fA-F]{64}$/.test(step.transactionId) ||
      !sameOutpoint(step.spentOutpoint, currentOutpoint) ||
      step.successor.outpoint.txid.toLowerCase() !==
        step.transactionId.toLowerCase() ||
      step.successor.outpoint.index !== currentOutpoint.index ||
      step.successor.scriptPublicKey.toLowerCase() !==
        head.scriptPublicKey.toLowerCase() ||
      parseSompiString(step.successor.amount) < currentAmount + threshold
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "exact head reconciliation does not prove a valid KIP-10 successor lineage",
      );
    }
    currentOutpoint = step.successor.outpoint;
    currentAmount = parseSompiString(step.successor.amount);
  }
}

function sameOutpoint(left: FundingOutpoint, right: FundingOutpoint): boolean {
  return (
    left.txid.toLowerCase() === right.txid.toLowerCase() &&
    left.index === right.index
  );
}

function exactHeadUnavailableSnapshot(head: ExactHeadRecord) {
  if (head.status === "retired")
    throw new Error("retired exact head cannot be marked unavailable");
  return {
    headId: head.headId,
    expectedVersion: head.version,
    expectedOutpoint: head.currentOutpoint,
    expectedAmount: head.currentAmount,
    expectedStatus: head.status,
  } as const;
}

function scriptPublicKeyHash(scriptPublicKey: string): string {
  return sha256Hex(hexToBytes(scriptPublicKey));
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

function strongerExactFinality(
  left: "accepted" | "confirmed",
  right: "mempool" | "accepted" | "confirmed" | undefined,
): "accepted" | "confirmed" {
  return left === "confirmed" || right === "confirmed"
    ? "confirmed"
    : "accepted";
}

function isExactFinality(
  value: unknown,
): value is "mempool" | "accepted" | "confirmed" {
  return value === "mempool" || value === "accepted" || value === "confirmed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function publicBoundaryResponse(error: unknown): ServerResponse {
  if (!(error instanceof PublicBoundaryError)) throw error;
  return {
    status: error.status,
    headers: { "retry-after": "1" },
    body: { error: error.reason },
  };
}

function boundaryError(error: unknown): Error {
  if (error instanceof PublicBoundaryError) {
    return new KaspaX402Error(
      "invalid_kaspa_transaction",
      error.reason,
      { status: error.status },
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}
