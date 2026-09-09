import {
  X402_VERSION,
  assertBatchVoucherReserve,
  assertJsonResourceBudget,
  assertMainnetAllowed,
  batchPaymentRequirementsHash,
  batchPresentationDigest,
  batchLaneAccounting,
  bindRequestHashToTrustedContext,
  applyCovenantSelectedChainUpdate,
  assertCovenantLineageConfirmed,
  canonicalCovenantTransitions,
  channelId,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  exactAuthorizationExpiresAt,
  exactRequestAuthorizationDigest,
  decideChainEvidence,
  formatSompiString,
  hexToBytes,
  paymentIdentifierExtension,
  parseBatchLaneAmount,
  parseSompiString,
  readKaspaSettlementExtension,
  requiredBatchVoucherAmount,
  sha256Hex,
  stableStringify,
  trustedSecurityContextHash,
  validateKaspaPaymentRequirement,
  validatePaymentIdentifierInfo,
  validatePaymentRequired,
  validatePaymentRetry,
  voucherDigest,
  voucherPreimageHex,
  type BatchPaymentRequirements,
  type BatchPresentationAuthorization,
  type ChannelConfig,
  type ChannelState,
  type AcceptedTransactionEvidence,
  type ExactPaymentRequirements,
  type FundingOutpoint,
  type Hash32Hex,
  type PaymentPayload,
  type PaymentRequirements,
  type SettlementResponse,
  type SompiString,
  type TrustedTransactionEvidence,
  type Voucher,
} from "@kaspa-x402/core";
import { KaspaX402Error } from "@kaspa-x402/core";
import {
  deriveEscrowAddress,
  escrowScriptPublicKey,
  serializedScriptPublicKey,
} from "@kaspa-x402/covenant";
import {
  parsePaymentRequiredHeaderValue,
  type ParsePaymentRequiredOptions,
} from "./payment-required.js";
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  type ApplySettlementResult,
  type CreatePaymentResult,
  type DirectModeChannel,
  type DirectModeClientOptions,
  type ExactPaymentAttemptFinalizeRequest,
  type ExactPaymentAttemptRecord,
  type ExactPaymentReconcileResult,
  type ExactPaymentRequest,
  type ExactTransactionPaymentResult,
  type FetchLike,
  type FundingProviderUtxo,
  type FundingTransitionAttemptApplyResult,
  type FundingTransitionAttemptRecord,
  type FundingTransitionReconcileResult,
  type HeadersInitLike,
  type HttpRequestInitLike,
  type HttpResponseLike,
  type PaidFetchResult,
  type ParsedPaymentRequired,
  type PaymentRequestContext,
  type RefundAttemptApplyResult,
  type RefundAttemptRecord,
  type RefundReconcileResult,
  type RefundResult,
} from "./types.js";

export class PendingExactPaymentError extends KaspaX402Error {
  readonly payment: CreatePaymentResult;

  constructor(payment: CreatePaymentResult, cause: unknown) {
    const source = cause instanceof KaspaX402Error ? cause : undefined;
    super(
      source?.code ?? "invalid_kaspa_settlement_response",
      source?.message ?? "exact payment completion is ambiguous",
      {
        attemptId: payment.exactAttemptId,
        transactionId: payment.transactionId,
        cause,
      },
    );
    this.name = "PendingExactPaymentError";
    this.payment = payment;
  }
}

export class DirectModeClient {
  readonly #options: DirectModeClientOptions;

  constructor(options: DirectModeClientOptions) {
    if (
      options.fundingProvider.payExactTransaction &&
      !options.fundingProvider.finalizeExactPaymentAttempt
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "exact funding providers must implement atomic preparation and finalization together",
      );
    }
    assertMainnetAllowed(
      options.fundingProvider.networkId,
      options.allowMainnet,
      "DirectModeClient",
    );
    if (
      !options.allowMainnet &&
      options.supportedNetworks?.includes("kaspa:mainnet")
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_network",
        "DirectModeClient requires allowMainnet for kaspa:mainnet",
      );
    }
    if (
      !Number.isSafeInteger(options.confirmationThreshold) ||
      options.confirmationThreshold < 1
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_payload",
        "confirmationThreshold must be a positive safe integer",
      );
    }
    if (
      options.maxPaymentRetries !== undefined &&
      options.maxPaymentRetries !== 0
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_payload",
        "automatic corrective payment retries are disabled because a disclosed artifact remains spendable",
      );
    }
    this.#options = options;
  }

  supportedNetworks(): readonly ("kaspa:mainnet" | "kaspa:testnet-10")[] {
    return supportedNetworksForClient(this.#options);
  }

  supportedSchemes(): readonly ("exact" | "batch-settlement")[] {
    return supportedSchemesForClient(this.#options);
  }

  selectPaymentRequirement(header: string): ParsedPaymentRequired {
    return parsePaymentRequiredHeaderValue(
      header,
      paymentRequiredParseOptionsForClient(this.#options),
    );
  }

  async createPayment(
    header: string,
    context: PaymentRequestContext,
  ): Promise<CreatePaymentResult> {
    assertFundingPolicy(this.#options);
    const parsed = this.selectPaymentRequirement(header);
    const requestContext = contextWithRequestHash(context, parsed.accepted);
    preflightSelectedPayment(
      parsed.paymentRequired,
      parsed.accepted,
      requestContext,
    );
    assertProviderNetwork(this.#options, parsed.accepted.network);
    if (parsed.accepted.scheme === "exact") {
      return this.#createExactPayment(
        parsed.accepted,
        parsed.paymentRequired,
        {
          ...requestContext,
          paymentIdentifier:
            requestContext.paymentIdentifier ??
            defaultExactPaymentIdentifier(context),
        },
      );
    }
    if (parsed.accepted.scheme !== "batch-settlement") {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_scheme",
        "unsupported Kaspa x402 requirement was selected",
      );
    }

    const origin = context.origin ?? originForUrl(context.url);
    const resourceUrl = parsed.paymentRequired.resource.url;
    const accepted = parsed.accepted;
    assertPaymentDestinationPolicy(this.#options, {
      origin,
      payTo: accepted.payTo,
    });
    const existing = await this.#selectExistingChannel(
      accepted,
      origin,
      resourceUrl,
    );

    if (existing) {
      const { channel, paymentPayload } = await this.#buildVoucherPayload(
        existing.channel,
        accepted,
        parsed.paymentRequired,
        requestContext,
        existing.toppedUp,
      );
      return {
        paymentRequired: parsed.paymentRequired,
        accepted,
        paymentPayload,
        scheme: "batch-settlement",
        channel,
        openedChannel: false,
      };
    }

    const unresolvedGenesis = (
      await this.#options.store.loadOpenFundingTransitionAttempts({
        origin,
        resourceUrl,
        network: accepted.network,
      })
    ).find((attempt) => attempt.kind === "genesis");
    if (unresolvedGenesis) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        `genesis funding transition ${unresolvedGenesis.channelId} is unresolved; reconcile it before reopening this payment lane`,
      );
    }

    const { channel, paymentPayload } = await this.#openDepositVoucherChannel(
      accepted,
      parsed.paymentRequired,
      requestContext,
      origin,
    );
    return {
      paymentRequired: parsed.paymentRequired,
      accepted,
      paymentPayload,
      scheme: "batch-settlement",
      channel,
      openedChannel: true,
    };
  }

  async paidFetch(
    input: string,
    init: HttpRequestInitLike = {},
  ): Promise<PaidFetchResult> {
    const fetch = this.#options.fetch ?? globalFetchLike();
    const requestInit = { ...init, redirect: "error" as const };
    const firstResponse = await fetch(input, requestInit);
    assertPaidFetchResponseTarget(firstResponse, input, "payment challenge");
    if (firstResponse.status !== 402) {
      return { response: firstResponse };
    }

    const required = firstResponse.headers.get(PAYMENT_REQUIRED_HEADER);
    if (!required) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_payload",
        "402 response is missing PAYMENT-REQUIRED",
      );
    }

    const payment = await this.createPayment(required, {
      url: input,
      paymentIdentifier: init.paymentIdentifier,
      requestHash: init.requestHash,
      paymentAttemptId: init.paymentAttemptId,
      method: init.method,
      body: init.body,
      trustedSecurityContext: init.trustedSecurityContext,
    });
    const retryInit: HttpRequestInitLike = {
      ...requestInit,
      headers: withHeader(
        init.headers,
        PAYMENT_SIGNATURE_HEADER,
        encodePaymentSignatureHeader(payment.paymentPayload),
      ),
    };
    let retryResponse: HttpResponseLike;
    try {
      retryResponse = await fetch(input, retryInit);
      assertPaidFetchResponseTarget(retryResponse, input, "paid retry");
    } catch (error) {
      if (payment.scheme === "exact") {
        throw pendingExactPaymentError(payment, error);
      }
      await this.quarantineDisclosedPayment(payment);
      throw error;
    }
    if (retryResponse.status === 402) {
      if (payment.scheme === "exact") {
        throw pendingExactPaymentError(
          payment,
          new KaspaX402Error(
            "invalid_kaspa_x402_payload",
            "corrective 402 leaves the disclosed exact artifact pending",
          ),
        );
      }
      await this.quarantineDisclosedPayment(payment);
      throw new KaspaX402Error(
        "invalid_kaspa_x402_payload",
        "corrective 402 requires a new explicit payment authorization; the client will not sign automatically",
      );
    }

    const responseHeader = retryResponse.headers.get(PAYMENT_RESPONSE_HEADER);
    if (!responseHeader) {
      if (payment.scheme === "exact") {
        throw pendingExactPaymentError(
          payment,
          new KaspaX402Error(
            "invalid_kaspa_settlement_response",
            "paid retry response is missing PAYMENT-RESPONSE",
          ),
        );
      }
      await this.quarantineDisclosedPayment(payment);
      throw new KaspaX402Error(
        "invalid_kaspa_settlement_response",
        "paid retry response is missing PAYMENT-RESPONSE",
      );
    }

    let settlementResponse: SettlementResponse;
    try {
      settlementResponse = decodePaymentResponseHeader(responseHeader);
    } catch (error) {
      if (payment.scheme === "exact") {
        throw pendingExactPaymentError(payment, error);
      }
      await this.quarantineDisclosedPayment(payment);
      throw error;
    }
    let settlement: ApplySettlementResult;
    try {
      settlement = await this.applySettlement(payment, settlementResponse);
    } catch (error) {
      if (payment.scheme === "exact") {
        throw pendingExactPaymentError(payment, error);
      }
      throw error;
    }
    if (payment.scheme === "exact" && !settlementResponse.success) {
      throw pendingExactPaymentError(
        payment,
        new KaspaX402Error(
          "invalid_kaspa_settlement_response",
          "merchant reported failure after the exact artifact was disclosed",
        ),
      );
    }
    return { response: retryResponse, payment, settlement };
  }

  async quarantineDisclosedPayment(
    payment: CreatePaymentResult,
  ): Promise<void> {
    if (payment.accepted.scheme !== "batch-settlement" || !payment.channel) {
      return;
    }
    await this.#options.store.quarantineChannel(payment.channel);
  }

  async reconcileExactPayment(
    attemptId: string,
  ): Promise<ExactPaymentReconcileResult> {
    let attempt = await this.#options.store.loadExactPaymentAttempt(attemptId);
    if (!attempt) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "exact payment attempt was not found",
      );
    }
    assertProviderNetwork(this.#options, attempt.payment.accepted.network);
    if (attempt.status !== "pending") {
      attempt = await this.#finalizeResolvedExactAttempt(attempt);
      return exactPaymentReconcileResult(attempt);
    }
    if (!this.#options.exactPaymentReconciler) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "trusted exact payment reconciliation adapter is required",
      );
    }
    const observed =
      await this.#options.exactPaymentReconciler.reconcileExactPayment(attempt);
    assertTransactionId(observed.transactionId, "reconciled exact payment");
    if (!sameHash32(observed.transactionId, attempt.transactionId)) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "reconciled exact transaction id does not match the persisted artifact",
      );
    }
    let decision: ReturnType<typeof decideChainEvidence>;
    try {
      decision = decideChainEvidence(
        observed.evidence,
        this.#options.confirmationThreshold,
      );
    } catch (error) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "exact payment reconciler returned invalid trusted evidence",
        error,
      );
    }
    if (!sameHash32(decision.evidence.transactionId, attempt.transactionId)) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "trusted evidence does not identify the persisted exact artifact",
      );
    }
    if (decision.status === "unknown" || decision.status === "accepted") {
      return {
        attemptId: attempt.attemptId,
        transactionId: attempt.transactionId,
        finality: decision.status,
        accepted: false,
      };
    }
    if (decision.status === "absent") {
      assertExactAbsenceBoundToArtifact(attempt, decision.evidence);
      attempt = await this.#options.store.resolveExactPaymentAttempt({
        attemptId: attempt.attemptId,
        transactionId: attempt.transactionId,
        outcome: "absent",
        evidence: decision.evidence,
      });
    } else {
      if (!observed.output) {
        throw new KaspaX402Error(
          "invalid_kaspa_transaction",
          "confirmed exact payment evidence is missing the accepted output",
        );
      }
      assertExactAcceptedOutput(attempt, observed.output);
      attempt = await this.#options.store.resolveExactPaymentAttempt({
        attemptId: attempt.attemptId,
        transactionId: attempt.transactionId,
        outcome: "accepted",
        evidence: decision.evidence,
        output: observed.output,
      });
    }
    attempt = await this.#finalizeResolvedExactAttempt(attempt);
    return exactPaymentReconcileResult(attempt);
  }

  async applySettlement(
    payment: CreatePaymentResult,
    response: SettlementResponse,
  ): Promise<ApplySettlementResult> {
    if (payment.accepted.scheme === "exact") {
      return applyExactSettlement(payment, response);
    }
    if (!payment.channel) {
      throw new KaspaX402Error(
        "invalid_kaspa_settlement_response",
        "batch settlement is missing local channel state",
      );
    }
    const accepted = payment.accepted as BatchPaymentRequirements;

    if (!response.success) {
      return {
        channel: payment.channel,
        chargedAmount: "0",
        response,
      };
    }

    try {
      if (response.network !== payment.accepted.network) {
        throw new KaspaX402Error(
          "invalid_kaspa_settlement_response",
          "settlement response network does not match accepted requirement",
        );
      }
      const responseExtra = readKaspaSettlementExtension(response);
      if (
        responseExtra?.channelId !== undefined &&
        responseExtra.channelId !== payment.channel.id
      ) {
        throw new KaspaX402Error(
          "invalid_kaspa_channel_id",
          "settlement response channel id does not match local channel",
        );
      }
      if (
        responseExtra?.covenantId !== undefined &&
        responseExtra.covenantId.toLowerCase() !==
          payment.channel.covenantId.toLowerCase()
      ) {
        throw new KaspaX402Error(
          "invalid_kaspa_x402_binding",
          "settlement response covenant id does not match local channel",
        );
      }

      const chargedAmount = readChargedAmount(response, accepted);
      if (chargedAmount !== accepted.amount) {
        throw new KaspaX402Error(
          "invalid_kaspa_settlement_response",
          "settlement amount must equal the accepted fixed charge",
        );
      }
      if (
        payment.paymentPayload.payload.type === "deposit-voucher" &&
        responseExtra?.fundingAmount !== payment.channel.fundingAmount
      ) {
        throw new KaspaX402Error(
          "invalid_kaspa_settlement_response",
          "deposit settlement funding amount does not match local channel",
        );
      }

      if (!responseExtra?.commitmentId) {
        throw new KaspaX402Error(
          "invalid_kaspa_settlement_response",
          "successful voucher settlement must include a commitment id",
        );
      }
      if (
        response.transaction.toLowerCase() !==
        responseExtra.commitmentId.toLowerCase()
      ) {
        throw new KaspaX402Error(
          "invalid_kaspa_settlement_response",
          "batch settlement transaction must equal the commitment id",
        );
      }
      const channelState = responseExtra.channelState;
      if (!channelState) {
        throw new KaspaX402Error(
          "invalid_kaspa_settlement_response",
          "successful voucher settlement must include channel state",
        );
      }
      const updated = applySettlementChannelState(
        payment.channel,
        channelState,
        chargedAmount,
        paymentVoucherAmount(payment.paymentPayload),
      );

      const applied = await this.#options.store.applySettledChannel(
        payment.channel,
        updated,
      );
      return {
        channel: applied,
        chargedAmount,
        response,
      };
    } catch (error) {
      await this.quarantineDisclosedPayment(payment);
      throw error;
    }
  }

  async listRefundableChannels(
    nowDaa?: SompiString,
  ): Promise<DirectModeChannel[]> {
    const daa =
      nowDaa ?? (await this.#options.fundingProvider.getVirtualDaaScore());
    const candidates = await this.#options.store.loadChannels({});
    for (const candidate of candidates) {
      if (
        candidate.status === "active" ||
        candidate.status === "retired" ||
        candidate.status === "refundable" ||
        candidate.status === "suspicious" ||
        candidate.status === "refunded"
      ) {
        const [fundingAttempt, refundAttempt] = await Promise.all([
          this.#options.store.loadFundingTransitionAttempt(candidate.id),
          this.#options.store.loadRefundAttempt(candidate.id),
        ]);
        if (
          (fundingAttempt && fundingAttempt.status !== "applied") ||
          (refundAttempt && refundAttempt.status !== "applied")
        ) {
          continue;
        }
        await this.#reconcileChannelSnapshot(candidate);
      }
    }
    return this.#options.store.listRefundableChannels(daa);
  }

  async reconcileChannel(channelId: string): Promise<DirectModeChannel> {
    const channel = (await this.#options.store.loadChannels({})).find(
      (candidate) => sameHash32(candidate.id, channelId),
    );
    if (!channel) {
      throw new KaspaX402Error("invalid_kaspa_channel_id", "channel not found");
    }
    return this.#reconcileChannelSnapshot(channel);
  }

  async refundChannel(channelId: string): Promise<RefundResult> {
    let target = (await this.#options.store.loadChannels({})).find(
      (candidate) => sameHash32(candidate.id, channelId),
    );
    if (!target) {
      throw new KaspaX402Error("invalid_kaspa_channel_id", "channel not found");
    }
    assertProviderNetwork(this.#options, target.config.network);
    let existingAttempt = await this.#options.store.loadRefundAttempt(
      target.id,
    );
    if (existingAttempt && existingAttempt.status !== "applied") {
      const reconciled = await this.#reconcileRefundAttempt(target, existingAttempt);
      if (reconciled.finality !== "absent") {
        throw new KaspaX402Error(
          "invalid_kaspa_transaction",
          "refund attempt is unresolved or already accepted; reconcile the persisted transaction before another refund",
        );
      }
    }
    if (existingAttempt?.status === "applied") {
      target = await this.#reconcileChannelSnapshot(target);
      existingAttempt = await this.#options.store.loadRefundAttempt(target.id);
      if (existingAttempt) {
        throw new KaspaX402Error(
          "invalid_kaspa_transaction",
          "refund attempt is already applied",
        );
      }
    }
    target = await this.#reconcileChannelSnapshot(target);
    if (!isRefundableChannelStatus(target.status)) {
      throw new KaspaX402Error(
        "invalid_kaspa_settlement_response",
        "channel status does not permit a refund",
      );
    }

    const nowDaa = await this.#options.fundingProvider.getVirtualDaaScore();
    if (parseSompiString(nowDaa) <= parseSompiString(target.refundTimeoutDaa)) {
      throw new KaspaX402Error(
        "invalid_kaspa_settlement_response",
        "channel is not refund-unlocked yet",
      );
    }
    if (!this.#options.signer.signRefund || !this.#options.refundBuilder) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "refund signing and transaction builder adapters are required",
      );
    }

    const refundAmount = target.fundingAmount;
    let signatureRequests = 0;
    const refund = await this.#options.refundBuilder.buildRefundTransaction({
      channel: target,
      refundAmount,
      signDigest: async (digest) => {
        signatureRequests += 1;
        if (signatureRequests > 1) {
          throw new KaspaX402Error(
            "invalid_kaspa_transaction",
            "refund builder requested more than one signing digest",
          );
        }
        return this.#options.signer.signRefund!({
          channel: target,
          refundAmount,
          digest,
        });
      },
    });
    if (signatureRequests !== 1) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "refund builder must request the exact transaction signing digest",
      );
    }
    if (refund.refundAmount !== refundAmount) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "refund transaction amount does not match signed refund amount",
      );
    }
    assertRefundTransactionArtifact(refund.transaction);
    assertTransactionId(refund.transactionId, "prepared refund");
    const refundScriptPublicKey =
      this.#options.addressCodec.scriptPublicKeyForAddress(
        target.config.refundAddress,
        target.config.network,
      );
    const attempt: RefundAttemptRecord = {
      channelId: target.id,
      covenantId: target.covenantId,
      activeOutpoint: target.activeOutpoint,
      activeScriptPublicKey: target.activeScriptPublicKey,
      fundingAmount: target.fundingAmount,
      channelStatus: target.status,
      refundAmount,
      transaction: refund.transaction,
      transactionId: refund.transactionId,
      requiredConfirmations: this.#options.confirmationThreshold,
      refundScriptPublicKey,
      status: "pending",
    };
    await this.#options.store.claimRefundAttempt(attempt);
    const broadcast = await this.#options.fundingProvider.sendTransaction(
      attempt.transaction,
    );
    assertTransactionId(broadcast.transactionId, "broadcast refund");
    if (!sameHash32(broadcast.transactionId, attempt.transactionId)) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "broadcast refund transaction id does not match the persisted signed transaction",
      );
    }
    const decision = trustedChainEvidenceDecision(
      broadcast.evidence,
      attempt.transactionId,
      attempt.requiredConfirmations,
      "broadcast refund",
      attempt.activeOutpoint,
    );
    if (decision.status === "absent") {
      await this.#options.store.releaseRefundAttempt(
        attempt.channelId,
        attempt.transactionId,
      );
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "refund artifact was definitively rejected before acceptance",
      );
    }
    if (decision.status !== "confirmed") {
      await this.#options.store.saveRefundAttempt({
        ...attempt,
        status: "broadcast",
        finality: "broadcast",
        ...(decision.status === "accepted"
          ? { acceptance: decision.evidence }
          : {}),
      });
      return {
        channel: target,
        refundAmount,
        transactionId: attempt.transactionId,
        finality: decision.status === "accepted" ? "accepted" : "broadcast",
        accepted: false,
      };
    }
    const applied = await this.#options.store.applyRefundAttempt({
      channelId: target.id,
      transactionId: attempt.transactionId,
      acceptance: decision.evidence,
    });
    return refundResultFromApplied(applied);
  }

  async reconcileRefund(channelId: string): Promise<RefundReconcileResult> {
    const target = (await this.#options.store.loadChannels({})).find(
      (candidate) => sameHash32(candidate.id, channelId),
    );
    if (!target) {
      throw new KaspaX402Error("invalid_kaspa_channel_id", "channel not found");
    }
    const attempt = await this.#options.store.loadRefundAttempt(target.id);
    if (!attempt) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "refund attempt was not found",
      );
    }
    return this.#reconcileRefundAttempt(target, attempt);
  }

  async #reconcileRefundAttempt(
    target: DirectModeChannel,
    attempt: RefundAttemptRecord,
  ): Promise<RefundReconcileResult> {
    if (attempt.status === "applied") {
      if (attempt.finality !== "accepted" && attempt.finality !== "confirmed") {
        throw new KaspaX402Error(
          "invalid_kaspa_transaction",
          "applied refund attempt is missing accepted finality",
        );
      }
      const applied = await this.#options.store.applyRefundAttempt({
        channelId: target.id,
        transactionId: attempt.transactionId,
        acceptance: requireAcceptedEvidence(
          attempt.acceptance,
          attempt.transactionId,
          "applied refund",
        ),
      });
      return refundResultFromApplied(applied);
    }
    if (!this.#options.refundReconciler) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "trusted refund reconciliation adapter is required",
      );
    }
    const observed =
      await this.#options.refundReconciler.reconcileRefund(attempt);
    assertTransactionId(observed.transactionId, "reconciled refund");
    if (!sameHash32(observed.transactionId, attempt.transactionId)) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "reconciled refund transaction id does not match the persisted signed transaction",
      );
    }
    const decision = trustedChainEvidenceDecision(
      observed.evidence,
      attempt.transactionId,
      attempt.requiredConfirmations,
      "reconciled refund",
      attempt.activeOutpoint,
    );
    if (decision.status === "unknown" || decision.status === "accepted") {
      return {
        channel: target,
        refundAmount: attempt.refundAmount,
        transactionId: attempt.transactionId,
        finality: decision.status,
        accepted: false,
      };
    }
    if (decision.status === "absent") {
      await this.#options.store.releaseRefundAttempt(
        attempt.channelId,
        attempt.transactionId,
      );
      return {
        channel: target,
        refundAmount: attempt.refundAmount,
        transactionId: attempt.transactionId,
        finality: "absent",
        accepted: false,
      };
    }
    const applied = await this.#options.store.applyRefundAttempt({
      channelId: target.id,
      transactionId: attempt.transactionId,
      acceptance: decision.evidence,
    });
    return refundResultFromApplied(applied);
  }

  async reconcileFundingTransition(
    channelId: string,
  ): Promise<FundingTransitionReconcileResult> {
    const attempt =
      await this.#options.store.loadFundingTransitionAttempt(channelId);
    if (!attempt) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "funding transition attempt was not found",
      );
    }
    assertProviderNetwork(
      this.#options,
      attempt.kind === "genesis"
        ? attempt.intent.config.network
        : attempt.expectedChannel.config.network,
    );
    if (attempt.status === "applied") {
      const channel = (await this.#options.store.loadChannels({})).find(
        (candidate) => sameHash32(candidate.id, attempt.channelId),
      );
      if (
        !channel ||
        (attempt.finality !== "accepted" &&
          attempt.finality !== "confirmed")
      ) {
        throw new KaspaX402Error(
          "invalid_kaspa_transaction",
          "applied funding transition has inconsistent channel state",
        );
      }
      return fundingTransitionResult(
        attempt,
        attempt.finality,
        true,
        channel,
      );
    }
    if (!this.#options.fundingTransitionReconciler) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "trusted funding transition reconciliation adapter is required",
      );
    }
    const observed =
      await this.#options.fundingTransitionReconciler.reconcileFundingTransition(
        attempt,
      );
    assertTransactionId(observed.transactionId, "reconciled funding");
    if (!sameHash32(observed.transactionId, attempt.transactionId)) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "reconciled funding transaction id does not match the persisted signed transaction",
      );
    }
    const decision = trustedChainEvidenceDecision(
      observed.evidence,
      attempt.transactionId,
      attempt.requiredConfirmations,
      "reconciled funding",
    );
    if (decision.status === "unknown" || decision.status === "accepted") {
      return fundingTransitionResult(attempt, decision.status, false);
    }
    if (decision.status === "absent") {
      await this.#options.store.releaseFundingTransitionAttempt(
        attempt.channelId,
        attempt.transactionId,
      );
      return fundingTransitionResult(attempt, "absent", false);
    }
    const applied = await this.#applyAcceptedFundingTransition(
      attempt,
      decision.evidence,
    );
    return fundingTransitionResult(
      applied.attempt,
      "confirmed",
      true,
      applied.channel,
    );
  }

  async #selectExistingChannel(
    accepted: BatchPaymentRequirements,
    origin: string,
    resourceUrl: string,
  ): Promise<{ channel: DirectModeChannel; toppedUp: boolean } | undefined> {
    const channels = await this.#options.store.loadChannels({
      origin,
      network: accepted.network,
      status: "active",
    });
    let topUpCandidate: DirectModeChannel | undefined;
    for (const channel of channels) {
      if (!channelMatchesRequirement(channel, accepted, resourceUrl)) continue;

      const openFundingAttempt =
        await this.#options.store.loadFundingTransitionAttempt(channel.id);
      if (openFundingAttempt && openFundingAttempt.status !== "applied") {
        throw new KaspaX402Error(
          "invalid_kaspa_transaction",
          `funding transition ${channel.id} is unresolved; reconcile it before reusing this payment lane`,
        );
      }
      const openRefundAttempt =
        await this.#options.store.loadRefundAttempt(channel.id);
      if (openRefundAttempt) {
        throw new KaspaX402Error(
          "invalid_kaspa_transaction",
          `refund transition ${channel.id} prevents payment lane reuse`,
        );
      }

      // Peer channel metadata is acknowledgement only. Reuse begins from an
      // independently discovered and confirmed selected-chain lineage.
      const current = await this.#reconcileChannelSnapshot(channel);

      if (
        canAuthorizeBatchCharge(
          current,
          accepted.amount,
          accepted.extra.claimReserveSompi,
        )
      ) {
        return {
          channel: current,
          toppedUp: current.requiresDepositVoucher,
        };
      }
      topUpCandidate ??= current;
    }

    if (topUpCandidate) {
      return {
        channel: await this.#topUpChannel(topUpCandidate, accepted),
        toppedUp: true,
      };
    }
    return undefined;
  }

  async #topUpChannel(
    channel: DirectModeChannel,
    accepted: BatchPaymentRequirements,
  ): Promise<DirectModeChannel> {
    const payoutScriptPublicKeyHash = scriptPublicKeyHash(
      this.#options.addressCodec.scriptPublicKeyForAddress(
        channel.config.payTo,
        channel.config.network,
      ),
    );
    const refundScriptPublicKeyHash = scriptPublicKeyHash(
      this.#options.addressCodec.scriptPublicKeyForAddress(
        channel.config.refundAddress,
        channel.config.network,
      ),
    );
    const escrowParams = {
      clientPublicKey: channel.config.clientPublicKey,
      serverPublicKey: channel.config.serverPublicKey,
      network: channel.config.network,
      payoutScriptPublicKeyHash,
      refundScriptPublicKeyHash,
      timeoutDaa: channel.config.refundTimeoutDaa,
      claimedCumulativeAmount: channel.claimedCumulativeAmount,
    };
    const expectedScriptPublicKey = serializedScriptPublicKey(
      escrowScriptPublicKey(escrowParams),
    );
    if (
      expectedScriptPublicKey.toLowerCase() !==
      channel.activeScriptPublicKey.toLowerCase()
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_binding",
        "active covenant script does not match lifetime settled accounting",
      );
    }
    const escrowAddress = deriveEscrowAddress(escrowParams, (input) =>
      this.#options.addressCodec.encodeScriptAddress(input),
    );
    const requiredAuthorization =
      maxBigInt(
        parseSompiString(channel.signedMaxClaimable),
        parseSompiString(channel.chargedCumulativeAmount) +
          parseSompiString(accepted.amount),
      ) - parseSompiString(channel.claimedCumulativeAmount);
    const reserve = parseBatchLaneAmount(
      accepted.extra.claimReserveSompi,
      "claim reserve",
    );
    const targetFundingAmount = formatSompiString(
      maxBigInt(
        requiredAuthorization + reserve,
        parseSompiString(channel.fundingAmount) +
          parseSompiString(accepted.extra.minDepositSompi),
      ),
    );
    parseBatchLaneAmount(targetFundingAmount, "top-up target funding amount");
    const prepared = await this.#options.fundingProvider.prepareEscrowTopUp({
      network: channel.config.network,
      channel,
      targetFundingAmount,
      fundingSource: this.#options.fundingPolicy?.requiredSource,
    });
    if (
      this.#options.fundingPolicy?.requiredSource &&
      prepared.fundingSource &&
      prepared.fundingSource !== this.#options.fundingPolicy.requiredSource
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_payload",
        "top-up funding source does not satisfy policy",
      );
    }
    assertPreparedFundingTransition(prepared, "top-up");
    if (
      !sameHash32(prepared.successor.covenantId, channel.covenantId) ||
      !sameHash32(
        prepared.successor.scriptPublicKey,
        channel.activeScriptPublicKey,
      ) ||
      prepared.successor.amount !== targetFundingAmount
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_binding",
        "prepared top-up successor does not match the active covenant lineage",
      );
    }
    if (escrowAddress !== channel.escrowAddress) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_binding",
        "top-up escrow address does not match the active covenant head",
      );
    }
    const attempt: FundingTransitionAttemptRecord = {
      kind: "top-up",
      channelId: channel.id,
      expectedChannel: channel,
      transaction: prepared.transaction,
      transactionId: prepared.transactionId,
      intendedSuccessor: prepared.successor,
      fundingSource:
        prepared.fundingSource ?? this.#options.fundingProvider.sourceKind,
      requiredConfirmations: this.#options.confirmationThreshold,
      status: "pending",
    };
    await this.#options.store.claimFundingTransitionAttempt(attempt);
    return this.#broadcastFundingTransition(attempt);
  }

  async #openDepositVoucherChannel(
    accepted: BatchPaymentRequirements,
    paymentRequired: CreatePaymentResult["paymentRequired"],
    context: PaymentRequestContext,
    origin: string,
  ): Promise<{ channel: DirectModeChannel; paymentPayload: PaymentPayload }> {
    const identity = await this.#options.fundingProvider.getPublicIdentity();
    const refundAddress = this.#options.refundAddress ?? identity.address;
    const channelKey = await this.#options.signer.generateChannelKey();
    const channelConfig: ChannelConfig = {
      network: accepted.network,
      asset: "KAS",
      templateId: "kaspa-x402-escrow-v4",
      clientPublicKey: channelKey.publicKey,
      serverPublicKey: accepted.extra.serverPublicKey,
      payTo: accepted.payTo,
      refundAddress,
      refundTimeoutDaa: accepted.extra.refundTimeoutDaa,
      salt: await this.#options.signer.randomSalt(),
    };
    const id = channelId(channelConfig);
    const initialFundingAmount = formatSompiString(
      maxBigInt(
        parseBatchLaneAmount(accepted.extra.minDepositSompi, "minimum deposit"),
        parseBatchLaneAmount(accepted.amount, "first batch charge") +
          parseBatchLaneAmount(
            accepted.extra.claimReserveSompi,
            "claim reserve",
          ),
      ),
    );
    parseBatchLaneAmount(initialFundingAmount, "initial funding amount");
    const payoutScriptPublicKeyHash = scriptPublicKeyHash(
      this.#options.addressCodec.scriptPublicKeyForAddress(
        channelConfig.payTo,
        channelConfig.network,
      ),
    );
    const refundScriptPublicKeyHash = scriptPublicKeyHash(
      this.#options.addressCodec.scriptPublicKeyForAddress(
        channelConfig.refundAddress,
        channelConfig.network,
      ),
    );
    const script = escrowScriptPublicKey({
      clientPublicKey: channelConfig.clientPublicKey,
      serverPublicKey: channelConfig.serverPublicKey,
      network: channelConfig.network,
      payoutScriptPublicKeyHash,
      refundScriptPublicKeyHash,
      timeoutDaa: channelConfig.refundTimeoutDaa,
      claimedCumulativeAmount: "0",
    });
    const activeScriptPublicKey = serializedScriptPublicKey(script);
    const escrowAddress = deriveEscrowAddress(
      {
        clientPublicKey: channelConfig.clientPublicKey,
        serverPublicKey: channelConfig.serverPublicKey,
        network: channelConfig.network,
        payoutScriptPublicKeyHash,
        refundScriptPublicKeyHash,
        timeoutDaa: channelConfig.refundTimeoutDaa,
        claimedCumulativeAmount: "0",
      },
      (input) => this.#options.addressCodec.encodeScriptAddress(input),
    );
    const prepared = await this.#options.fundingProvider.prepareEscrowDeposit({
      network: accepted.network,
      channelId: id,
      channelConfig,
      escrowAddress,
      escrowScriptPublicKey: activeScriptPublicKey,
      amount: initialFundingAmount,
      claimedCumulativeAmount: "0",
      fundingSource: this.#options.fundingPolicy?.requiredSource,
    });
    if (
      this.#options.fundingPolicy?.requiredSource &&
      prepared.fundingSource &&
      prepared.fundingSource !== this.#options.fundingPolicy.requiredSource
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_payload",
        "deposit funding source does not satisfy policy",
      );
    }
    assertPreparedFundingTransition(prepared, "genesis");
    if (!sameHash32(prepared.successor.scriptPublicKey, activeScriptPublicKey)) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_binding",
        "prepared genesis successor does not match the escrow script",
      );
    }
    if (
      parseSompiString(prepared.successor.amount) <
      parseSompiString(initialFundingAmount)
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_amount",
        "prepared genesis amount is below the required funding target",
      );
    }
    const attempt: FundingTransitionAttemptRecord = {
      kind: "genesis",
      channelId: id,
      intent: {
        channelId: id,
        origin,
        resourceUrl: paymentRequired.resource.url,
        config: channelConfig,
        ...(channelKey.privateKey
          ? { clientPrivateKey: channelKey.privateKey }
          : {}),
        escrowAddress,
        fundingSource:
          prepared.fundingSource ?? this.#options.fundingProvider.sourceKind,
      },
      transaction: prepared.transaction,
      transactionId: prepared.transactionId,
      intendedSuccessor: prepared.successor,
      fundingSource:
        prepared.fundingSource ?? this.#options.fundingProvider.sourceKind,
      requiredConfirmations: this.#options.confirmationThreshold,
      status: "pending",
    };
    await this.#options.store.claimFundingTransitionAttempt(attempt);
    const channel = await this.#broadcastFundingTransition(attempt);
    const fundingOutpoint = channel.activeOutpoint;
    const fundingAmount = channel.fundingAmount;
    const voucher = await this.#signVoucher(channel, accepted.amount);
    const presentation = await this.#signBatchPresentation(
      channel,
      accepted,
      context,
      voucher,
    );
    const signedChannel = {
      ...channel,
      signedMaxClaimable: voucher.authorizedCumulativeAmount,
      latestVoucher: voucher,
    };
    const paymentPayload = buildPaymentPayload(
      paymentRequired,
      accepted,
      context,
      {
        type: "deposit-voucher",
        channelConfig,
        channelId: id,
        escrowAddress,
        fundingOutpoint,
        fundingAmountSompi: fundingAmount,
        fundingTransaction: prepared.transaction,
        activeScriptPublicKey,
        voucher,
        presentation,
      },
    );

    const retryValidation = validatePaymentRetry({
      paymentRequired,
      paymentPayload,
    });
    if (!retryValidation.ok) throw retryValidation.error;
    await this.#options.store.saveChannel(signedChannel);
    return { channel: signedChannel, paymentPayload };
  }

  async #createExactPayment(
    accepted: ExactPaymentRequirements,
    paymentRequired: CreatePaymentResult["paymentRequired"],
    context: PaymentRequestContext,
  ): Promise<CreatePaymentResult> {
    const profile = exactProfile(accepted);
    const payToScriptPublicKey = accepted.extra.payToScriptPublicKey;
    if (
      accepted.extra.binding === "kaspa-exact-v2" &&
      (!payToScriptPublicKey ||
        accepted.extra.transactionEncoding !== "kaspa-sdk-safe-json-v2.0.0")
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_payload",
        "exact requirements must include transaction encoding and payTo script",
      );
    }
    if (accepted.extra.binding === "kaspa-exact-v2" && payToScriptPublicKey) {
      const expectedPayToScript =
        this.#options.addressCodec.scriptPublicKeyForAddress(
          accepted.payTo,
          accepted.network,
        );
      if (
        expectedPayToScript.toLowerCase() !== payToScriptPublicKey.toLowerCase()
      ) {
        throw new KaspaX402Error(
          "invalid_kaspa_x402_payload",
          "exact payTo address does not match the advertised payment script",
        );
      }
    }
    if (!context.requestHash) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_payload",
        "exact request authorization requires a canonical request hash",
      );
    }
    if (!context.paymentIdentifier) {
      throw new KaspaX402Error(
        "missing_kaspa_payment_identifier",
        "exact payment requires a stable payment identifier",
      );
    }
    const origin = context.origin ?? originForUrl(context.url);
    const intentHash = exactPaymentIntentHash(
      accepted,
      origin,
      paymentRequired.resource.url,
      context.requestHash,
      context.paymentIdentifier,
    );
    const attemptId = exactPaymentAttemptId(
      context.paymentAttemptId,
      context.paymentIdentifier,
    );
    const [existingByAttempt, existingByIdentifier] = await Promise.all([
      this.#options.store.loadExactPaymentAttempt(attemptId),
      this.#options.store.loadExactPaymentAttemptByIdentifier(
        context.paymentIdentifier,
      ),
    ]);
    const existing = existingByAttempt ?? existingByIdentifier;
    if (existing) {
      assertMatchingExactAttempt(existing, attemptId, intentHash);
      if (existing.status === "absent") {
        throw new KaspaX402Error(
          "invalid_kaspa_exact_replay",
          "this exact artifact is permanently absent; authorize a new logical payment with a new identifier",
        );
      }
      const retryValidation = validatePaymentRetry({
        paymentRequired,
        paymentPayload: existing.payment.paymentPayload,
      });
      if (!retryValidation.ok) throw retryValidation.error;
      return {
        ...existing.payment,
        paymentRequired: retryValidation.value.paymentRequired,
      };
    }
    const head = exactHeadHint(accepted);
    if (profile === "additive" && !head) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_payload",
        "additive exact requirements must include head challenge terms",
      );
    }
    const exactRequest: ExactPaymentRequest = {
      attemptId,
      intentHash,
      network: accepted.network,
      profile,
      origin,
      resourceUrl: paymentRequired.resource.url,
      amount: accepted.amount,
      payTo: accepted.payTo,
      payToScriptPublicKey: payToScriptPublicKey!,
      ...(typeof accepted.extra.paymentOutputIndex === "number"
        ? { paymentOutputIndex: accepted.extra.paymentOutputIndex }
        : {}),
      requestHash: context.requestHash,
      paymentRequirementsHash: sha256Hex(stableStringify(accepted)),
      authorizationExpiresAt: exactAuthorizationExpiresAt(
        accepted.maxTimeoutSeconds,
        head?.challengeExpiresAt,
      ),
      requiredFinality: accepted.extra.finality,
      fundingSource: this.#options.fundingPolicy?.requiredSource,
    };
    let exact: ExactTransactionPaymentResult;
    let payload: PaymentPayload["payload"];
    let payerAddress: string | undefined;
    const transactionRequest: ExactPaymentRequest = {
      ...exactRequest,
      ...(head ? { head } : {}),
    };
    const transactionExact =
      await this.#createExactTransaction(transactionRequest);
    this.#assertExactResult(transactionExact, transactionRequest);
    const identity = transactionExact.payerAddress
      ? undefined
      : await this.#options.fundingProvider.getPublicIdentity();
    payerAddress = transactionExact.payerAddress ?? identity?.address;
    payload = {
      type: "exact-transaction" as const,
      profile,
      payerAddress,
      transaction: transactionExact.transaction,
      transactionEncoding: transactionExact.transactionEncoding,
      paymentOutputIndex: transactionExact.paymentOutputIndex,
      authorization: transactionExact.authorization,
      ...(head ? { challengeId: head.challengeId } : {}),
      requestHash: context.requestHash,
    };
    exact = transactionExact;
    const paymentPayload = buildPaymentPayload(
      paymentRequired,
      accepted,
      context,
      payload,
    );
    const retryValidation = validatePaymentRetry({
      paymentRequired,
      paymentPayload,
    });
    if (!retryValidation.ok) throw retryValidation.error;
    const payment: CreatePaymentResult = {
      paymentRequired,
      accepted,
      paymentPayload,
      scheme: "exact",
      openedChannel: false,
      transactionId: exact.transactionId,
      exactAttemptId: attemptId,
      paymentOutputIndex: exact.paymentOutputIndex,
      payerAddress,
    };
    const claimed = await this.#options.store.claimExactPaymentAttempt({
      attemptId,
      intentHash,
      requestHash: context.requestHash,
      origin,
      resourceUrl: paymentRequired.resource.url,
      paymentIdentifier: context.paymentIdentifier,
      transactionId: exact.transactionId,
      inputOutpoints: exact.inputOutpoints.map((outpoint) => ({ ...outpoint })),
      payment,
      status: "pending",
      providerFinalized: false,
    });
    return claimed.payment;
  }

  #assertExactResult(
    exact: ExactTransactionPaymentResult,
    request: ExactPaymentRequest,
  ): void {
    if (
      this.#options.fundingPolicy?.requiredSource &&
      exact.fundingSource &&
      exact.fundingSource !== this.#options.fundingPolicy.requiredSource
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_payload",
        "exact payment funding source does not satisfy policy",
      );
    }
    if (
      !Number.isInteger(exact.paymentOutputIndex) ||
      exact.paymentOutputIndex < 0
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "exact payment output index is invalid",
      );
    }
    if (
      !Array.isArray(exact.inputOutpoints) ||
      exact.inputOutpoints.length === 0 ||
      exact.inputOutpoints.some(
        (outpoint) =>
          !/^[0-9a-fA-F]{64}$/.test(outpoint.txid) ||
          !Number.isSafeInteger(outpoint.index) ||
          outpoint.index < 0,
      )
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "exact transaction adapter returned invalid consumed outpoints",
      );
    }
    const expiresAt = Date.parse(exact.authorization.expiresAt);
    if (
      exact.authorization.version !==
        "kaspa-x402-exact-request-authorization-v1" ||
      !Number.isInteger(exact.authorization.inputIndex) ||
      exact.authorization.inputIndex < 0 ||
      !Number.isFinite(expiresAt) ||
      expiresAt > Date.parse(request.authorizationExpiresAt) ||
      !/^[0-9a-fA-F]{128}$/.test(exact.authorization.signature)
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_signature",
        "exact transaction adapter returned invalid request authorization evidence",
      );
    }
    const expectedDigest = exactRequestAuthorizationDigest({
      network: request.network,
      profile: request.profile,
      transactionId: exact.transactionId,
      paymentOutputIndex: exact.paymentOutputIndex,
      amount: request.amount,
      payTo: request.payTo,
      payToScriptPublicKey: request.payToScriptPublicKey,
      paymentRequirementsHash: request.paymentRequirementsHash,
      requestHash: request.requestHash,
      challengeId: request.head?.challengeId,
      inputIndex: exact.authorization.inputIndex,
      expiresAt: exact.authorization.expiresAt,
    });
    if (exact.authorization.digest.toLowerCase() !== expectedDigest) {
      throw new KaspaX402Error(
        "invalid_kaspa_signature",
        "exact request authorization digest does not match the payment intent",
      );
    }
  }

  async #createExactTransaction(
    request: ExactPaymentRequest,
  ): Promise<ExactTransactionPaymentResult> {
    if (!this.#options.fundingProvider.payExactTransaction) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "exact offers require an exact transaction adapter",
      );
    }
    assertExactFundingPolicy(this.#options, request);
    const exact =
      await this.#options.fundingProvider.payExactTransaction(request);
    if (!isExactTransactionPaymentResult(exact)) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "exact transaction adapter must return signed transaction artifacts",
      );
    }
    if (!/^[0-9a-fA-F]{64}$/.test(exact.transactionId)) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "exact transaction adapter must return transaction id evidence",
      );
    }
    if (exact.transactionEncoding !== "kaspa-sdk-safe-json-v2.0.0") {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "exact transaction encoding does not match accepted terms",
      );
    }
    if (
      request.paymentOutputIndex !== undefined &&
      exact.paymentOutputIndex !== request.paymentOutputIndex
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_outpoint",
        "exact transaction output index does not match accepted terms",
      );
    }
    return exact;
  }

  async #finalizeResolvedExactAttempt(
    attempt: ExactPaymentAttemptRecord,
  ): Promise<ExactPaymentAttemptRecord> {
    if (attempt.status === "pending") return attempt;
    if (attempt.providerFinalized) return attempt;
    const finalize = this.#options.fundingProvider.finalizeExactPaymentAttempt;
    if (!finalize) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "exact funding provider finalizer is unavailable",
      );
    }
    const request: ExactPaymentAttemptFinalizeRequest = {
      attemptId: attempt.attemptId,
      transactionId: attempt.transactionId,
      outcome: attempt.status,
    };
    await finalize.call(this.#options.fundingProvider, request);
    return this.#options.store.markExactPaymentProviderFinalized(
      attempt.attemptId,
      attempt.transactionId,
    );
  }

  async #buildVoucherPayload(
    channel: DirectModeChannel,
    accepted: BatchPaymentRequirements,
    paymentRequired: CreatePaymentResult["paymentRequired"],
    context: PaymentRequestContext,
    useDepositVoucher = false,
  ): Promise<{ channel: DirectModeChannel; paymentPayload: PaymentPayload }> {
    const nextAmount = requiredBatchVoucherAmount(channel, accepted.amount);
    assertBatchVoucherReserve(
      { ...channel, signedMaxClaimable: nextAmount },
      accepted.extra.claimReserveSompi,
    );
    const voucher =
      channel.latestVoucher &&
      channel.latestVoucher.authorizedCumulativeAmount === nextAmount
        ? channel.latestVoucher
        : await this.#signVoucher(channel, nextAmount);
    const updated = {
      ...channel,
      signedMaxClaimable: voucher.authorizedCumulativeAmount,
      latestVoucher: voucher,
    };
    const presentation = await this.#signBatchPresentation(
      updated,
      accepted,
      context,
      voucher,
    );
    const paymentPayload = buildPaymentPayload(
      paymentRequired,
      accepted,
      context,
      useDepositVoucher
        ? {
            type: "deposit-voucher",
            channelConfig: updated.config,
            channelId: updated.id,
            escrowAddress: updated.escrowAddress,
            fundingOutpoint: updated.activeOutpoint,
            fundingAmountSompi: updated.fundingAmount,
            activeScriptPublicKey: updated.activeScriptPublicKey,
            voucher,
            presentation,
          }
        : {
            type: "voucher",
            channelId: updated.id,
            clientPublicKey: updated.clientPublicKey,
            fundingOutpoint: updated.activeOutpoint,
            activeScriptPublicKey: updated.activeScriptPublicKey,
            voucher,
            presentation,
          },
    );

    const retryValidation = validatePaymentRetry({
      paymentRequired,
      paymentPayload,
    });
    if (!retryValidation.ok) throw retryValidation.error;
    await this.#options.store.saveChannel(updated);
    return { channel: updated, paymentPayload };
  }

  async #signVoucher(
    channel: DirectModeChannel,
    amount: SompiString,
  ): Promise<Voucher> {
    const input = {
      network: channel.config.network,
      covenantId: channel.covenantId,
      authorizedCumulativeAmount: amount,
    };
    const digest = voucherDigest(input);
    const preimage = voucherPreimageHex(input);
    const signature = await this.#options.signer.signVoucher({
      digest,
      preimage,
      channel,
      amount,
    });
    return {
      covenantId: channel.covenantId,
      authorizedCumulativeAmount: amount,
      signature,
    };
  }

  async #signBatchPresentation(
    channel: DirectModeChannel,
    accepted: BatchPaymentRequirements,
    context: PaymentRequestContext,
    voucher: Voucher,
  ): Promise<BatchPresentationAuthorization> {
    if (!context.requestHash) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_payload",
        "batch presentation requires the request fingerprint",
      );
    }
    if (!this.#options.signer.signBatchPresentation) {
      throw new KaspaX402Error(
        "invalid_kaspa_signature",
        "batch presentation signing is required",
      );
    }
    const authorization = {
      version: "kaspa-x402-batch-presentation-v1" as const,
      requestFingerprint: context.requestHash,
      acceptedRequirementsHash: batchPaymentRequirementsHash(accepted),
      securityContextHash: accepted.extra.securityContextHash,
      channelId: channel.id,
      covenantId: channel.covenantId,
      voucherDigest: voucherDigest({
        network: channel.config.network,
        covenantId: channel.covenantId,
        authorizedCumulativeAmount: voucher.authorizedCumulativeAmount,
      }),
      paymentIdentifier: context.paymentIdentifier ?? null,
      nonce: this.#options.signer.randomNonce
        ? await this.#options.signer.randomNonce()
        : await this.#options.signer.randomSalt(),
      expiresAt: new Date(
        Date.now() + accepted.maxTimeoutSeconds * 1_000,
      ).toISOString(),
    };
    const digest = batchPresentationDigest(authorization);
    const signature = await this.#options.signer.signBatchPresentation({
      digest,
      authorization,
      channel,
      accepted,
    });
    return { ...authorization, digest, signature };
  }

  async #broadcastFundingTransition(
    attempt: FundingTransitionAttemptRecord,
  ): Promise<DirectModeChannel> {
    const broadcast = await this.#options.fundingProvider.sendTransaction(
      attempt.transaction,
    );
    assertTransactionId(broadcast.transactionId, "broadcast funding");
    if (!sameHash32(broadcast.transactionId, attempt.transactionId)) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "broadcast funding transaction id does not match the persisted signed transaction",
      );
    }
    const decision = trustedChainEvidenceDecision(
      broadcast.evidence,
      attempt.transactionId,
      attempt.requiredConfirmations,
      "broadcast funding",
    );
    if (decision.status === "absent") {
      await this.#options.store.releaseFundingTransitionAttempt(
        attempt.channelId,
        attempt.transactionId,
      );
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "funding artifact was definitively rejected before acceptance",
      );
    }
    await this.#options.store.saveFundingTransitionAttempt({
      ...attempt,
      status: "broadcast",
      finality: "broadcast",
      ...(decision.status === "accepted" || decision.status === "confirmed"
        ? { acceptance: decision.evidence }
        : {}),
    });
    if (decision.status !== "confirmed") {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "funding transition has not reached the configured confirmation threshold; reconcile the persisted transaction before lane reuse",
      );
    }
    return (await this.#applyAcceptedFundingTransition(attempt, decision.evidence))
      .channel;
  }

  async #applyAcceptedFundingTransition(
    attempt: FundingTransitionAttemptRecord,
    acceptance: AcceptedTransactionEvidence,
  ): Promise<FundingTransitionAttemptApplyResult> {
    const successor = await this.#options.fundingProvider.getUtxo(
      attempt.intendedSuccessor.outpoint,
    );
    if (!successorMatchesIntent(successor, attempt)) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_binding",
        "accepted funding transition did not create the reserved singleton successor",
      );
    }
    const successorAcceptance = requireAcceptedEvidence(
      successor.acceptance,
      attempt.transactionId,
      "funding successor",
    );
    const successorDecision = trustedChainEvidenceDecision(
      successorAcceptance,
      attempt.transactionId,
      attempt.requiredConfirmations,
      "funding successor",
    );
    if (
      successorDecision.status !== "confirmed" ||
      !sameAcceptedEvidence(successorDecision.evidence, acceptance)
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "funding successor evidence does not match the accepted transaction",
      );
    }
    const prepared = {
      transaction: attempt.transaction,
      transactionId: attempt.transactionId,
      successor: attempt.intendedSuccessor,
      fundingSource: attempt.fundingSource,
    };
    if (attempt.kind === "genesis") {
      const evidence =
        await this.#options.fundingProvider.verifyCovenantGenesis({
          prepared,
          utxo: successor,
        });
      if (
        !evidence ||
        evidence.totalOutputCount !== 1 ||
        evidence.authorizedOutputCount !== 1 ||
        !sameHash32(
          evidence.covenantId,
          attempt.intendedSuccessor.covenantId,
        ) ||
        !sameOutpoint(
          evidence.genesisOutpoint,
          attempt.intendedSuccessor.outpoint,
        ) ||
        !sameHash32(
          evidence.genesisScriptPublicKey,
          attempt.intendedSuccessor.scriptPublicKey,
        ) ||
        evidence.genesisAmount !== attempt.intendedSuccessor.amount
      ) {
        throw new KaspaX402Error(
          "invalid_kaspa_x402_binding",
          "escrow genesis is not a verified single-output KIP-20 covenant",
        );
      }
      return this.#options.store.applyFundingTransitionAttempt({
        kind: "genesis",
        channelId: attempt.channelId,
        transactionId: attempt.transactionId,
        acceptance,
        evidence,
      });
    }

    const evidence = await this.#options.fundingProvider.verifyCovenantTopUp({
      previous: attempt.expectedChannel,
      prepared,
      successor,
    });
    if (
      !evidence ||
      evidence.authorizedSuccessorCount !== 1 ||
      !sameHash32(evidence.covenantId, attempt.expectedChannel.covenantId) ||
      !sameOutpoint(
        evidence.spentOutpoint,
        attempt.expectedChannel.activeOutpoint,
      ) ||
      !sameOutpoint(
        evidence.successorOutpoint,
        attempt.intendedSuccessor.outpoint,
      ) ||
      !sameHash32(
        evidence.successorScriptPublicKey,
        attempt.intendedSuccessor.scriptPublicKey,
      ) ||
      evidence.successorAmount !== attempt.intendedSuccessor.amount
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_binding",
        "top-up transition is not a verified singleton covenant successor",
      );
    }
    return this.#options.store.applyFundingTransitionAttempt({
      kind: "top-up",
      channelId: attempt.channelId,
      transactionId: attempt.transactionId,
      acceptance,
      evidence,
    });
  }

  async #activeOutpointExists(channel: DirectModeChannel): Promise<boolean> {
    const utxo = await this.#options.fundingProvider.getUtxo(
      channel.activeOutpoint,
    );
    return (
      utxo !== null &&
      utxo.outpoint.txid.toLowerCase() ===
        channel.activeOutpoint.txid.toLowerCase() &&
      utxo.outpoint.index === channel.activeOutpoint.index &&
      utxo.scriptPublicKey.toLowerCase() ===
        channel.activeScriptPublicKey.toLowerCase() &&
      utxo.covenantId?.toLowerCase() === channel.covenantId.toLowerCase() &&
      utxo.amount === channel.fundingAmount
    );
  }

  async #reconcileChannelSnapshot(
    channel: DirectModeChannel,
  ): Promise<DirectModeChannel> {
    const discover = this.#options.fundingProvider.discoverCovenantLineage;
    if (!discover) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "authoritative covenant lineage discovery adapter is required",
      );
    }
    const durable = await this.#options.store.loadCovenantLineage(channel.id);
    if (!durable || !sameHash32(durable.manifest.genesis.covenantId, channel.covenantId)) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_binding",
        "durable covenant launch manifest is missing or inconsistent",
      );
    }
    const update = await discover.call(this.#options.fundingProvider, {
      network: channel.config.network,
      covenantId: channel.covenantId,
      templateId: channel.templateId,
      lineage: durable,
      minConfirmationCount: this.#options.confirmationThreshold,
    });
    let lineage;
    try {
      lineage = applyCovenantSelectedChainUpdate(durable, update);
      assertCovenantLineageConfirmed(
        lineage,
        this.#options.confirmationThreshold,
      );
    } catch (error) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        error instanceof Error
          ? `authoritative covenant lineage is unavailable: ${error.message}`
          : "authoritative covenant lineage is unavailable",
      );
    }

    if (
      stableStringify(durable) === stableStringify(lineage) &&
      channel.status !== "suspicious"
    ) {
      return channel;
    }

    if (lineage.currentHead === null) {
      const refund = canonicalCovenantTransitions(lineage).at(-1);
      const refundScriptPublicKey =
        this.#options.addressCodec.scriptPublicKeyForAddress(
          channel.config.refundAddress,
          channel.config.network,
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
      const terminal = { ...channel, lineage, status: "refunded" as const };
      return this.#options.store.applyCovenantLineage({
        expectedChannel: channel,
        lineage,
        channel: terminal,
      });
    }
    const head = lineage.currentHead;
    const derived = this.#deriveEscrowHead(
      channel,
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
    const utxo = await this.#options.fundingProvider.getUtxo(head.outpoint);
    if (
      !utxo ||
      !sameOutpoint(utxo.outpoint, head.outpoint) ||
      utxo.covenantId?.toLowerCase() !== channel.covenantId.toLowerCase() ||
      utxo.scriptPublicKey.toLowerCase() !== head.scriptPublicKey.toLowerCase() ||
      utxo.amount !== head.value
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_outpoint",
        "derived covenant head is not the unique authoritative UTXO",
      );
    }
    const headAcceptance = requireAcceptedEvidence(
      utxo.acceptance,
      head.outpoint.txid,
      "derived covenant head",
    );
    if (
      trustedChainEvidenceDecision(
        headAcceptance,
        head.outpoint.txid,
        this.#options.confirmationThreshold,
        "derived covenant head",
      ).status !== "confirmed"
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "derived covenant head has not reached the configured confirmation threshold",
      );
    }
    const reconciledBase = structuredClone(channel);
    if (
      reconciledBase.lastTopUpEvidence &&
      !canonicalCovenantTransitions(lineage).some(
        (transition) =>
          transition.kind === "top-up" &&
          sameHash32(
            transition.transactionId,
            reconciledBase.lastTopUpEvidence!.successorOutpoint.txid,
          ),
      )
    ) {
      delete reconciledBase.lastTopUpEvidence;
    }
    const rolledBack = covenantLineageRolledBack(durable, lineage);
    const reconciled: DirectModeChannel = {
      ...reconciledBase,
      activeOutpoint: structuredClone(head.outpoint),
      activeScriptPublicKey: head.scriptPublicKey,
      escrowAddress: derived.escrowAddress,
      fundingAmount: head.value,
      claimedCumulativeAmount: head.claimedCumulativeAmount,
      lineage,
      status:
        channel.status === "suspicious" ||
        channel.status === "refunded" ||
        channel.status === "refundable" ||
        rolledBack
          ? "refundable"
          : channel.status,
    };
    return this.#options.store.applyCovenantLineage({
      expectedChannel: channel,
      lineage,
      channel: reconciled,
    });
  }

  #deriveEscrowHead(
    channel: DirectModeChannel,
    claimedCumulativeAmount: SompiString,
  ): { activeScriptPublicKey: string; escrowAddress: string } {
    const payoutScriptPublicKeyHash = scriptPublicKeyHash(
      this.#options.addressCodec.scriptPublicKeyForAddress(
        channel.config.payTo,
        channel.config.network,
      ),
    );
    const refundScriptPublicKeyHash = scriptPublicKeyHash(
      this.#options.addressCodec.scriptPublicKeyForAddress(
        channel.config.refundAddress,
        channel.config.network,
      ),
    );
    const params = {
      clientPublicKey: channel.config.clientPublicKey,
      serverPublicKey: channel.config.serverPublicKey,
      network: channel.config.network,
      payoutScriptPublicKeyHash,
      refundScriptPublicKeyHash,
      timeoutDaa: channel.config.refundTimeoutDaa,
      claimedCumulativeAmount,
    };
    return {
      activeScriptPublicKey: serializedScriptPublicKey(
        escrowScriptPublicKey(params),
      ),
      escrowAddress: deriveEscrowAddress(params, (input) =>
        this.#options.addressCodec.encodeScriptAddress(input),
      ),
    };
  }

  async #applyCorrectiveStateIfPresent(
    channel: DirectModeChannel,
    accepted: BatchPaymentRequirements,
  ): Promise<DirectModeChannel> {
    const state = accepted.extra.channelState;
    if (!state) return channel;
    if (state.channelId !== channel.id) return channel;
    if (!correctiveStateChanges(channel, state)) return channel;
    const voucherState = channel.latestVoucher;
    if (!voucherState) {
      throw new KaspaX402Error(
        "invalid_kaspa_signature",
        "corrective channel state requires the locally retained voucher proof",
      );
    }
    if (!this.#options.verifyVoucherSignature) {
      throw new KaspaX402Error(
        "invalid_kaspa_signature",
        "corrective voucher proof verifier is required",
      );
    }
    if (
      voucherState.authorizedCumulativeAmount !==
      state.authorizedCumulativeAmount
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_settlement_response",
        "corrective voucher amount must match signed ceiling",
      );
    }
    if (
      voucherState.covenantId.toLowerCase() !== state.covenantId.toLowerCase()
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_binding",
        "corrective voucher covenant does not match channel state",
      );
    }
    const derived = this.#deriveEscrowHead(
      channel,
      state.claimedCumulativeAmount,
    );
    if (
      derived.activeScriptPublicKey.toLowerCase() !==
      state.activeScriptPublicKey.toLowerCase()
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_binding",
        "corrective active script does not match lifetime settled accounting",
      );
    }
    const candidate = {
      ...applyCorrectiveChannelState(channel, state, voucherState),
      escrowAddress: derived.escrowAddress,
    };
    const verified = await this.#options.verifyVoucherSignature(
      voucherState,
      candidate,
    );
    if (!verified) {
      throw new KaspaX402Error(
        "invalid_kaspa_signature",
        "corrective voucher state signature was rejected",
      );
    }
    if (!(await this.#activeOutpointExists(candidate))) {
      throw new KaspaX402Error(
        "invalid_kaspa_outpoint",
        "corrective active outpoint does not match authoritative chain state",
      );
    }
    await this.#options.store.saveChannel(candidate);
    return candidate;
  }
}

function covenantLineageRolledBack(
  previous: DirectModeChannel["lineage"],
  next: DirectModeChannel["lineage"],
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

function isRefundableChannelStatus(
  status: DirectModeChannel["status"],
): boolean {
  return status === "active" || status === "retired" || status === "refundable";
}

function assertRefundTransactionArtifact(transaction: string): void {
  if (
    transaction.length === 0 ||
    transaction.length % 2 !== 0 ||
    !/^[0-9a-f]+$/i.test(transaction)
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_transaction",
      "refund builder must return the exact signed transaction as byte hex",
    );
  }
}

function assertEvidenceTransaction(
  evidence: TrustedTransactionEvidence | null | undefined,
  transactionId: string,
  label: string,
): void {
  if (!evidence || typeof evidence !== "object") {
    throw new KaspaX402Error(
      "invalid_kaspa_transaction",
      `${label} is missing objective chain evidence`,
    );
  }
  assertTransactionId(evidence.transactionId, `${label} evidence`);
  if (!sameHash32(evidence.transactionId, transactionId)) {
    throw new KaspaX402Error(
      "invalid_kaspa_transaction",
      `${label} evidence does not match the persisted transaction`,
    );
  }
}

function trustedChainEvidenceDecision(
  evidence: TrustedTransactionEvidence | null | undefined,
  transactionId: string,
  requiredConfirmations: number,
  label: string,
  expectedSpentOutpoint?: FundingOutpoint,
): ReturnType<typeof decideChainEvidence> {
  assertEvidenceTransaction(evidence, transactionId, label);
  try {
    const decision = decideChainEvidence(evidence!, requiredConfirmations);
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
      `${label} evidence is malformed: ${error instanceof Error ? error.message : "invalid evidence"}`,
    );
  }
}

function sameAcceptedEvidence(
  left: AcceptedTransactionEvidence,
  right: AcceptedTransactionEvidence,
): boolean {
  return (
    left.status === right.status &&
    sameHash32(left.transactionId, right.transactionId) &&
    sameHash32(left.acceptingBlockHash, right.acceptingBlockHash) &&
    left.acceptingBlockBlueScore === right.acceptingBlockBlueScore &&
    left.confirmationCount === right.confirmationCount &&
    sameHash32(left.checkpoint.blockHash, right.checkpoint.blockHash) &&
    left.checkpoint.blueScore === right.checkpoint.blueScore &&
    left.checkpoint.daaScore === right.checkpoint.daaScore
  );
}

function requireAcceptedEvidence(
  evidence: AcceptedTransactionEvidence | undefined,
  transactionId: string,
  label: string,
): AcceptedTransactionEvidence {
  if (!evidence) {
    throw new KaspaX402Error(
      "invalid_kaspa_transaction",
      `${label} is missing objective acceptance evidence`,
    );
  }
  assertEvidenceTransaction(evidence, transactionId, label);
  return evidence;
}

function assertTransactionId(value: string, source: string): void {
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new KaspaX402Error(
      "invalid_kaspa_transaction",
      `${source} transaction id must be 32-byte hex`,
    );
  }
}

function assertPreparedFundingTransition(
  prepared: {
    transaction: string;
    transactionId: string;
    successor: {
      outpoint: FundingOutpoint;
      covenantId: string;
      amount: string;
      scriptPublicKey: string;
    };
  },
  kind: "genesis" | "top-up",
): void {
  if (
    prepared.transaction.length === 0 ||
    prepared.transaction.length % 2 !== 0 ||
    !/^[0-9a-f]+$/i.test(prepared.transaction)
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_transaction",
      `prepared ${kind} must include the exact signed transaction as byte hex`,
    );
  }
  assertTransactionId(prepared.transactionId, `prepared ${kind}`);
  assertTransactionId(
    prepared.successor.outpoint.txid,
    `prepared ${kind} successor`,
  );
  if (
    !sameHash32(
      prepared.transactionId,
      prepared.successor.outpoint.txid,
    ) ||
    !Number.isInteger(prepared.successor.outpoint.index) ||
    prepared.successor.outpoint.index < 0
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_outpoint",
      `prepared ${kind} successor must belong to the signed transaction`,
    );
  }
  assertTransactionId(
    prepared.successor.covenantId,
    `prepared ${kind} covenant`,
  );
  if (/^0{64}$/i.test(prepared.successor.covenantId)) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_binding",
      `prepared ${kind} covenant id must be non-zero`,
    );
  }
  if (
    prepared.successor.scriptPublicKey.length === 0 ||
    prepared.successor.scriptPublicKey.length % 2 !== 0 ||
    !/^[0-9a-f]+$/i.test(prepared.successor.scriptPublicKey)
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_binding",
      `prepared ${kind} successor script is invalid`,
    );
  }
  if (parseSompiString(prepared.successor.amount) <= 0n) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_amount",
      `prepared ${kind} successor amount must be positive`,
    );
  }
}

function sameHash32(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function sameOutpoint(left: FundingOutpoint, right: FundingOutpoint): boolean {
  return sameHash32(left.txid, right.txid) && left.index === right.index;
}

function successorMatchesIntent(
  successor: FundingProviderUtxo | null,
  attempt: FundingTransitionAttemptRecord,
): successor is FundingProviderUtxo {
  return (
    successor !== null &&
    sameOutpoint(successor.outpoint, attempt.intendedSuccessor.outpoint) &&
    successor.covenantId !== undefined &&
    sameHash32(
      successor.covenantId,
      attempt.intendedSuccessor.covenantId,
    ) &&
    sameHash32(
      successor.scriptPublicKey,
      attempt.intendedSuccessor.scriptPublicKey,
    ) &&
    successor.amount === attempt.intendedSuccessor.amount
  );
}

function fundingTransitionResult(
  attempt: FundingTransitionAttemptRecord,
  finality: FundingTransitionReconcileResult["finality"],
  accepted: boolean,
  channel?: DirectModeChannel,
): FundingTransitionReconcileResult {
  return {
    channelId: attempt.channelId,
    kind: attempt.kind,
    transactionId: attempt.transactionId,
    finality,
    accepted,
    ...(channel ? { channel } : {}),
  };
}

function refundResultFromApplied(
  applied: RefundAttemptApplyResult,
): RefundResult & RefundReconcileResult {
  const finality = applied.attempt.finality;
  if (finality !== "accepted" && finality !== "confirmed") {
    throw new KaspaX402Error(
      "invalid_kaspa_transaction",
      "applied refund attempt is missing accepted finality",
    );
  }
  return {
    channel: applied.channel,
    refundAmount: applied.attempt.refundAmount,
    transactionId: applied.attempt.transactionId,
    finality,
    accepted: true,
  };
}

function assertFundingPolicy(options: DirectModeClientOptions): void {
  const required = options.fundingPolicy?.requiredSource;
  if (required && options.fundingProvider.sourceKind !== required) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      `funding source ${options.fundingProvider.sourceKind} does not satisfy policy ${required}`,
    );
  }
}

function assertExactFundingPolicy(
  options: DirectModeClientOptions,
  request: ExactPaymentRequest,
): void {
  const policy = options.fundingPolicy;
  if (!policy) return;
  assertPaymentDestinationPolicy(options, request);
  if (
    policy.allowedExactProfiles &&
    !policy.allowedExactProfiles.includes(request.profile)
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      `exact profile ${request.profile} is not allowed by funding policy`,
    );
  }
  if (
    policy.maximumExactAmountSompi !== undefined &&
    parseSompiString(request.amount) >
      parseSompiString(policy.maximumExactAmountSompi)
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_amount",
      "exact payment amount exceeds funding policy",
    );
  }
}

function assertPaymentDestinationPolicy(
  options: DirectModeClientOptions,
  request: { origin: string; payTo: string },
): void {
  const policy = options.fundingPolicy;
  if (!policy) return;
  if (
    policy.allowedOrigins &&
    !policy.allowedOrigins.includes(request.origin)
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      `payment origin ${request.origin} is not allowed by funding policy`,
    );
  }
  if (policy.allowedPayTo && !policy.allowedPayTo.includes(request.payTo)) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      "payment recipient is not allowed by funding policy",
    );
  }
}

function assertProviderNetwork(
  options: DirectModeClientOptions,
  network: string,
): void {
  if (network === "kaspa:mainnet")
    assertMainnetAllowed(network, options.allowMainnet, "DirectModeClient");
  if (options.fundingProvider.networkId !== network) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_network",
      `funding provider network ${options.fundingProvider.networkId} does not match ${network}`,
    );
  }
}

function supportedNetworksForClient(
  options: DirectModeClientOptions,
): readonly ("kaspa:mainnet" | "kaspa:testnet-10")[] {
  const networks =
    options.supportedNetworks ??
    (options.allowMainnet
      ? ["kaspa:mainnet", "kaspa:testnet-10"]
      : ["kaspa:testnet-10"]);
  return options.allowMainnet
    ? networks
    : networks.filter((network) => network !== "kaspa:mainnet");
}

function supportedSchemesForClient(
  options: DirectModeClientOptions,
): readonly ("exact" | "batch-settlement")[] {
  if (options.supportedSchemes) {
    return options.supportedSchemes.filter(
      (scheme) =>
        (scheme !== "batch-settlement" ||
          Boolean(options.fundingProvider.discoverCovenantLineage)) &&
        (scheme !== "exact" ||
          Boolean(
            options.fundingProvider.payExactTransaction &&
              options.fundingProvider.finalizeExactPaymentAttempt,
          )),
    );
  }
  const schemes: ("exact" | "batch-settlement")[] = [];
  if (
    options.fundingProvider.payExactTransaction &&
    options.fundingProvider.finalizeExactPaymentAttempt
  ) {
    schemes.push("exact");
  }
  if (options.fundingProvider.discoverCovenantLineage) {
    schemes.push("batch-settlement");
  }
  return schemes;
}

function paymentRequiredParseOptionsForClient(
  options: DirectModeClientOptions,
): ParsePaymentRequiredOptions {
  return {
    supportedNetworks: supportedNetworksForClient(options),
    supportedSchemes: supportedSchemesForClient(options),
    supportsRequirement: (requirement) =>
      supportsRequirementForClient(options, requirement),
  };
}

function supportsRequirementForClient(
  options: DirectModeClientOptions,
  requirement: PaymentRequirements,
): boolean {
  if (requirement.scheme === "batch-settlement") {
    return Boolean(options.fundingProvider.discoverCovenantLineage);
  }
  if (requirement.scheme !== "exact") return false;
  if (
    !options.fundingProvider.payExactTransaction ||
    !options.fundingProvider.finalizeExactPaymentAttempt
  ) {
    return false;
  }
  const profile = exactProfile(requirement);
  return profile === "standard-native" || Boolean(exactHeadHint(requirement));
}

function buildPaymentPayload(
  paymentRequired: CreatePaymentResult["paymentRequired"],
  accepted: PaymentRequirements,
  context: PaymentRequestContext,
  payload: PaymentPayload["payload"],
): PaymentPayload {
  const extensions = paymentIdentifierExtensions(paymentRequired, context);
  const paymentPayload: PaymentPayload = {
    x402Version: X402_VERSION,
    accepted,
    payload,
    ...(extensions ? { extensions } : {}),
  };
  return paymentPayload;
}

function applyExactSettlement(
  payment: CreatePaymentResult,
  response: SettlementResponse,
): ApplySettlementResult {
  if (!response.success) {
    return {
      chargedAmount: payment.accepted.amount,
      response,
      pending: true,
      transactionId: payment.transactionId,
    };
  }
  const payload = payment.paymentPayload.payload;
  const accepted = payment.accepted as ExactPaymentRequirements;
  if (payload.type !== "exact-transaction") {
    throw new KaspaX402Error(
      "invalid_kaspa_payment_payload_type",
      "exact settlement does not correspond to an exact payment payload",
    );
  }
  if (response.network !== accepted.network) {
    throw new KaspaX402Error(
      "invalid_kaspa_settlement_response",
      "settlement response network does not match accepted requirement",
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(response.transaction)) {
    throw new KaspaX402Error(
      "invalid_kaspa_transaction",
      "successful exact settlement must include a transaction id",
    );
  }
  if (
    payment.transactionId &&
    response.transaction.toLowerCase() !== payment.transactionId.toLowerCase()
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_transaction",
      "settlement transaction id does not match exact payment transaction",
    );
  }
  if (response.amount !== accepted.amount) {
    throw new KaspaX402Error(
      "invalid_kaspa_settlement_response",
      "exact settlement amount does not match accepted requirement",
    );
  }
  const responseExtra = readKaspaSettlementExtension(response);
  const expectedProfile = exactProfile(accepted);
  if (responseExtra?.exactProfile !== expectedProfile) {
    throw new KaspaX402Error(
      "invalid_kaspa_settlement_response",
      "exact settlement profile does not match accepted requirement",
    );
  }
  if (responseExtra?.paymentOutputIndex === undefined) {
    throw new KaspaX402Error(
      "invalid_kaspa_outpoint",
      "exact settlement must include the payment output index",
    );
  }
  if (responseExtra.paymentOutputIndex !== payload.paymentOutputIndex) {
    throw new KaspaX402Error(
      "invalid_kaspa_outpoint",
      "settlement payment output index does not match exact payment payload",
    );
  }
  // Merchant finality metadata is acknowledgement only. Only the configured
  // trusted chain reconciler may finalize this durable exact attempt.
  if (responseExtra.finality !== undefined) readExactFinality(responseExtra.finality);
  if (payload.requestHash) {
    const responseRequestHash = responseExtra.requestHash;
    if (
      typeof responseRequestHash !== "string" ||
      responseRequestHash.toLowerCase() !== payload.requestHash.toLowerCase()
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_settlement_response",
        "exact settlement request hash does not match payment payload",
      );
    }
  }
  return {
    chargedAmount: accepted.amount,
    response,
    pending: true,
    transactionId: payment.transactionId,
  };
}

function pendingExactPaymentError(
  payment: CreatePaymentResult,
  error: unknown,
): PendingExactPaymentError {
  return error instanceof PendingExactPaymentError
    ? error
    : new PendingExactPaymentError(payment, error);
}

function exactPaymentIntentHash(
  accepted: ExactPaymentRequirements,
  origin: string,
  resourceUrl: string,
  requestHash: Hash32Hex,
  paymentIdentifier: string,
): Hash32Hex {
  return sha256Hex(
    stableStringify({
      scope: "kaspa:x402:exact-intent:v1",
      origin,
      resourceUrl,
      requestHash: requestHash.toLowerCase(),
      paymentIdentifier,
      accepted,
    }),
  );
}

function defaultExactPaymentIdentifier(
  context: PaymentRequestContext,
): string {
  try {
    return sha256Hex(
      stableStringify({
        scope: "kaspa:x402:exact-request-identifier:v1",
        origin: context.origin ?? originForUrl(context.url),
        url: context.url,
        requestIdentity: context.requestHash ?? {
          method: context.method ?? "GET",
          body: context.body ?? null,
        },
      }),
    );
  } catch (error) {
    throw new KaspaX402Error(
      "missing_kaspa_payment_identifier",
      "paymentIdentifier is required when the exact request is outside the JSON canonicalization profile",
      error,
    );
  }
}

function exactPaymentAttemptId(
  supplied: Hash32Hex | undefined,
  paymentIdentifier: string,
): Hash32Hex {
  const derived = sha256Hex(
    stableStringify({
      scope: "kaspa:x402:exact-attempt:v1",
      paymentIdentifier,
    }),
  );
  if (supplied !== undefined) {
    if (!/^[0-9a-fA-F]{64}$/.test(supplied)) {
      throw new KaspaX402Error(
        "invalid_kaspa_exact_replay",
        "exact payment attempt id must be 32-byte hex",
      );
    }
    if (!sameHash32(supplied, derived)) {
      throw new KaspaX402Error(
        "invalid_kaspa_exact_replay",
        "supplied exact payment attempt id does not match the stable payment identifier",
      );
    }
  }
  return derived;
}

function assertMatchingExactAttempt(
  attempt: ExactPaymentAttemptRecord,
  attemptId: Hash32Hex,
  intentHash: Hash32Hex,
): void {
  if (
    !sameHash32(attempt.attemptId, attemptId) ||
    !sameHash32(attempt.intentHash, intentHash)
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_exact_replay",
      "the exact attempt or payment identifier already owns different immutable intent",
    );
  }
}

function assertExactAcceptedOutput(
  attempt: ExactPaymentAttemptRecord,
  output: NonNullable<ExactPaymentAttemptRecord["output"]>,
): void {
  const accepted = attempt.payment.accepted as ExactPaymentRequirements;
  const payload = attempt.payment.paymentPayload.payload;
  if (
    payload.type !== "exact-transaction" ||
    !sameHash32(output.transactionId, attempt.transactionId) ||
    output.outputIndex !== payload.paymentOutputIndex
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_transaction",
      "trusted exact output does not identify the persisted payment output",
    );
  }
  const head = exactHeadHint(accepted);
  const expectedAmount = head
    ? formatSompiString(
        parseSompiString(head.headAmount) + parseSompiString(accepted.amount),
      )
    : accepted.amount;
  const expectedScript = head?.headScriptPublicKey ?? accepted.extra.payToScriptPublicKey;
  if (
    output.amount !== expectedAmount ||
    typeof expectedScript !== "string" ||
    output.scriptPublicKey.toLowerCase() !== expectedScript.toLowerCase()
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_binding",
      "trusted exact output does not match the accepted amount and script",
    );
  }
}

function assertExactAbsenceBoundToArtifact(
  attempt: ExactPaymentAttemptRecord,
  evidence: Extract<TrustedTransactionEvidence, { status: "absent" }>,
): void {
  if (evidence.proof.kind === "consensus-rejection") return;
  const spentOutpoint = evidence.proof.spentOutpoint;
  const bound = attempt.inputOutpoints.some(
    (input) =>
      sameHash32(input.txid, spentOutpoint.txid) &&
      input.index === spentOutpoint.index,
  );
  if (!bound) {
    throw new KaspaX402Error(
      "invalid_kaspa_transaction",
      "conflicting-spend absence proof is not bound to an input of the exact artifact",
    );
  }
}

function exactPaymentReconcileResult(
  attempt: ExactPaymentAttemptRecord,
): ExactPaymentReconcileResult {
  return {
    attemptId: attempt.attemptId,
    transactionId: attempt.transactionId,
    finality: attempt.status === "accepted" ? "confirmed" : "absent",
    accepted: attempt.status === "accepted",
  };
}

function readExactFinality(
  value: unknown,
): "mempool" | "accepted" | "confirmed" | undefined {
  if (value === undefined) return undefined;
  if (value === "mempool" || value === "accepted" || value === "confirmed")
    return value;
  throw new KaspaX402Error(
    "invalid_kaspa_transaction",
    "exact settlement finality is invalid",
  );
}

function exactHeadHint(
  accepted: ExactPaymentRequirements,
): ExactPaymentRequest["head"] | undefined {
  const extra = accepted.extra;
  if (
    extra.binding !== "kaspa-exact-v2" ||
    extra.profile !== "additive" ||
    !extra.expectedHeadOutpoint ||
    typeof extra.headId !== "string" ||
    typeof extra.headVersion !== "string" ||
    typeof extra.headAmount !== "string" ||
    typeof extra.headScriptPublicKey !== "string" ||
    typeof extra.headRedeemScript !== "string" ||
    typeof extra.additiveThresholdSompi !== "string" ||
    typeof extra.challengeId !== "string" ||
    typeof extra.challengeExpiresAt !== "string"
  ) {
    return undefined;
  }
  return {
    headId: extra.headId,
    headVersion: extra.headVersion,
    expectedHeadOutpoint: extra.expectedHeadOutpoint,
    headAmount: extra.headAmount,
    headScriptPublicKey: extra.headScriptPublicKey,
    headRedeemScript: extra.headRedeemScript,
    additiveThresholdSompi: extra.additiveThresholdSompi,
    challengeId: extra.challengeId,
    challengeExpiresAt: extra.challengeExpiresAt,
  };
}

function exactProfile(
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

function isExactTransactionPaymentResult(
  exact: unknown,
): exact is ExactTransactionPaymentResult {
  return (
    isRecord(exact) &&
    typeof exact.transaction === "string" &&
    exact.transactionEncoding === "kaspa-sdk-safe-json-v2.0.0" &&
    isRecord(exact.authorization)
  );
}

function paymentIdentifierExtensions(
  paymentRequired: CreatePaymentResult["paymentRequired"],
  context: PaymentRequestContext,
): PaymentPayload["extensions"] {
  const extension = paymentRequired.extensions?.["payment-identifier"];
  const info = isRecord(extension) ? extension.info : undefined;
  const schema =
    isRecord(extension) && isRecord(extension.schema)
      ? extension.schema
      : undefined;
  const required = isRecord(info) && info.required === true;
  if (isRecord(info)) {
    const advertised = validatePaymentIdentifierInfo(info, schema);
    if (!advertised.ok) throw advertised.error;
  }
  if (required && !context.paymentIdentifier) {
    throw new KaspaX402Error(
      "missing_kaspa_payment_identifier",
      "payment-identifier extension is required for this retry",
    );
  }
  if (!context.paymentIdentifier) return undefined;
  const extensions = {
    "payment-identifier": paymentIdentifierExtension(
      {
        ...(isRecord(info) ? info : {}),
        required,
        id: context.paymentIdentifier,
      },
      schema,
    ),
  };
  const intended = validatePaymentIdentifierInfo(
    extensions["payment-identifier"].info,
    extensions["payment-identifier"].schema,
  );
  if (!intended.ok) throw intended.error;
  return extensions;
}

function preflightSelectedPayment(
  paymentRequired: CreatePaymentResult["paymentRequired"],
  accepted: PaymentRequirements,
  context: PaymentRequestContext,
): void {
  const requiredValidation = validatePaymentRequired(paymentRequired);
  if (!requiredValidation.ok) throw requiredValidation.error;
  const acceptedValidation = validateKaspaPaymentRequirement(accepted);
  if (!acceptedValidation.ok) throw acceptedValidation.error;
  const acceptedIdentity = stableStringify(accepted);
  if (
    !paymentRequired.accepts.some(
      (offered) => stableStringify(offered) === acceptedIdentity,
    )
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_accepted",
      "selected payment requirements are not present in the challenge",
    );
  }
  if (!context.requestHash) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      "selected payment preflight requires a request hash",
    );
  }
  hexToBytes(context.requestHash, {
    expectedLength: 32,
    errorCode: "invalid_kaspa_x402_payload",
    label: "request hash",
  });
  if (
    context.trustedSecurityContext &&
    accepted.scheme === "batch-settlement" &&
    accepted.extra.securityContextHash.toLowerCase() !==
      trustedSecurityContextHash(context.trustedSecurityContext)
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_binding",
      "batch challenge security context does not match the trusted request context",
    );
  }
  const extensions = paymentIdentifierExtensions(paymentRequired, context);
  assertJsonResourceBudget(
    {
      version: "kaspa-x402-prospective-payment-intent-v1",
      requestUrl: context.url,
      origin: context.origin ?? null,
      resource: paymentRequired.resource,
      accepted,
      requestHash: context.requestHash,
      method: context.method ?? "GET",
      body: context.body ?? null,
      extensions: extensions ?? {},
      securityContextHash: context.trustedSecurityContext
        ? trustedSecurityContextHash(context.trustedSecurityContext)
        : null,
    },
    { label: "prospective payment intent" },
  );
  const intendedPayload = intendedPaymentPayloadForPreflight(
    accepted,
    context,
    extensions,
  );
  const retryValidation = validatePaymentRetry({
    paymentRequired,
    paymentPayload: intendedPayload,
  });
  if (!retryValidation.ok) throw retryValidation.error;
}

function intendedPaymentPayloadForPreflight(
  accepted: PaymentRequirements,
  context: PaymentRequestContext,
  extensions: PaymentPayload["extensions"],
): PaymentPayload {
  const zeroHash = "00".repeat(32);
  const nonzeroHash = `01${"00".repeat(31)}`;
  const zeroSignature = "00".repeat(64);
  if (accepted.scheme === "exact") {
    return {
      x402Version: X402_VERSION,
      accepted,
      payload: {
        type: "exact-transaction",
        profile: accepted.extra.profile,
        ...(accepted.extra.profile === "additive" && accepted.extra.challengeId
          ? { challengeId: accepted.extra.challengeId }
          : {}),
        transaction: "{}",
        transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
        paymentOutputIndex: accepted.extra.paymentOutputIndex ?? 0,
        requestHash: context.requestHash!,
        authorization: {
          version: "kaspa-x402-exact-request-authorization-v1",
          inputIndex: 0,
          expiresAt: "1970-01-01T00:00:00.000Z",
          digest: zeroHash,
          signature: zeroSignature,
        },
      },
      ...(extensions ? { extensions } : {}),
    };
  }
  return {
    x402Version: X402_VERSION,
    accepted,
    payload: {
      type: "voucher",
      channelId: zeroHash,
      clientPublicKey: zeroHash,
      fundingOutpoint: { txid: zeroHash, index: 0 },
      activeScriptPublicKey: "000000",
      voucher: {
        covenantId: nonzeroHash,
        authorizedCumulativeAmount: accepted.amount,
        signature: zeroSignature,
      },
      presentation: {
        version: "kaspa-x402-batch-presentation-v1",
        requestFingerprint: context.requestHash!,
        acceptedRequirementsHash: batchPaymentRequirementsHash(accepted),
        securityContextHash: accepted.extra.securityContextHash,
        channelId: zeroHash,
        covenantId: nonzeroHash,
        voucherDigest: zeroHash,
        paymentIdentifier: context.paymentIdentifier ?? null,
        nonce: zeroHash,
        expiresAt: "1970-01-01T00:00:00.000Z",
        digest: zeroHash,
        signature: zeroSignature,
      },
    },
    ...(extensions ? { extensions } : {}),
  };
}

function channelMatchesRequirement(
  channel: DirectModeChannel,
  accepted: BatchPaymentRequirements,
  resourceUrl: string,
): boolean {
  return (
    channel.status === "active" &&
    (!channel.resourceUrl || channel.resourceUrl === resourceUrl) &&
    channel.config.network === accepted.network &&
    channel.config.asset === accepted.asset &&
    channel.config.payTo === accepted.payTo &&
    channel.config.serverPublicKey === accepted.extra.serverPublicKey &&
    channel.config.templateId === accepted.extra.templateId &&
    channel.config.refundTimeoutDaa === accepted.extra.refundTimeoutDaa
  );
}

function applySettlementChannelState(
  channel: DirectModeChannel,
  state: ChannelState,
  chargedAmount: SompiString,
  expectedSignedAmount: SompiString,
): DirectModeChannel {
  validateChannelStateIdentity(channel, state);
  const expectedCharged = addAmounts(
    channel.chargedCumulativeAmount,
    chargedAmount,
  );
  if (state.authorizedCumulativeAmount !== expectedCharged) {
    throw new KaspaX402Error(
      "invalid_kaspa_settlement_response",
      "settlement charged cumulative amount does not match this request",
    );
  }
  if (state.authorizedCumulativeAmount !== expectedSignedAmount) {
    throw new KaspaX402Error(
      "invalid_kaspa_settlement_response",
      "settlement signed ceiling does not match the submitted voucher",
    );
  }
  validateChannelStateAccounting(channel, state);
  return channelWithState(channel, state);
}

function applyCorrectiveChannelState(
  channel: DirectModeChannel,
  state: ChannelState,
  voucher: Voucher,
): DirectModeChannel {
  validateChannelId(channel, state);
  validateChannelStateAccounting(channel, state, true);
  if (
    parseSompiString(state.authorizedCumulativeAmount) <
    parseSompiString(channel.chargedCumulativeAmount)
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_settlement_response",
      "corrective charged amount moved backward",
    );
  }
  if (
    parseSompiString(state.claimedCumulativeAmount) <
    parseSompiString(channel.claimedCumulativeAmount)
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_settlement_response",
      "corrective claimed amount moved backward",
    );
  }
  if (
    parseSompiString(state.authorizedCumulativeAmount) <
    parseSompiString(channel.signedMaxClaimable)
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_settlement_response",
      "corrective signed ceiling moved backward",
    );
  }
  return {
    ...channelWithState(channel, state),
    latestVoucher: voucher,
  };
}

function validateChannelStateIdentity(
  channel: DirectModeChannel,
  state: ChannelState,
): void {
  validateChannelId(channel, state);
  if (!sameActiveOutpoint(channel, state)) {
    throw new KaspaX402Error(
      "invalid_kaspa_outpoint",
      "settlement active outpoint does not match local channel",
    );
  }
}

function validateChannelId(
  channel: DirectModeChannel,
  state: ChannelState,
): void {
  if (state.channelId !== channel.id) {
    throw new KaspaX402Error(
      "invalid_kaspa_channel_id",
      "settlement channel id does not match local channel",
    );
  }
  if (state.covenantId.toLowerCase() !== channel.covenantId.toLowerCase()) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_binding",
      "settlement covenant id does not match local channel",
    );
  }
}

function sameActiveOutpoint(
  channel: DirectModeChannel,
  state: ChannelState,
): boolean {
  return (
    state.activeOutpoint.txid.toLowerCase() ===
      channel.activeOutpoint.txid.toLowerCase() &&
    state.activeOutpoint.index === channel.activeOutpoint.index &&
    state.activeScriptPublicKey.toLowerCase() ===
      channel.activeScriptPublicKey.toLowerCase()
  );
}

function validateChannelStateAccounting(
  channel: DirectModeChannel,
  state: ChannelState,
  allowActiveTransition = false,
): void {
  batchLaneAccounting({
    fundingAmount: state.fundingAmount,
    chargedCumulativeAmount: state.authorizedCumulativeAmount,
    claimedCumulativeAmount: state.claimedCumulativeAmount,
    signedMaxClaimable: state.authorizedCumulativeAmount,
  });
  if (!allowActiveTransition && state.fundingAmount !== channel.fundingAmount) {
    throw new KaspaX402Error(
      "invalid_kaspa_settlement_response",
      "settlement funding amount does not match local channel",
    );
  }
  if (
    !allowActiveTransition &&
    state.claimedCumulativeAmount !== channel.claimedCumulativeAmount
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_settlement_response",
      "settlement claimed amount does not match local channel",
    );
  }
  if (
    parseSompiString(state.authorizedCumulativeAmount) <
    parseSompiString(channel.signedMaxClaimable)
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_settlement_response",
      "settlement signed ceiling moved backward",
    );
  }
}

function channelWithState(
  channel: DirectModeChannel,
  state: ChannelState,
): DirectModeChannel {
  return {
    ...channel,
    covenantId: state.covenantId,
    activeOutpoint: state.activeOutpoint,
    activeScriptPublicKey: state.activeScriptPublicKey,
    fundingAmount: state.fundingAmount,
    chargedCumulativeAmount: state.authorizedCumulativeAmount,
    claimedCumulativeAmount: state.claimedCumulativeAmount,
    signedMaxClaimable: state.authorizedCumulativeAmount,
    requiresDepositVoucher: false,
  };
}

function correctiveStateChanges(
  channel: DirectModeChannel,
  state: ChannelState,
): boolean {
  return (
    state.activeOutpoint.txid.toLowerCase() !==
      channel.activeOutpoint.txid.toLowerCase() ||
    state.activeOutpoint.index !== channel.activeOutpoint.index ||
    state.activeScriptPublicKey.toLowerCase() !==
      channel.activeScriptPublicKey.toLowerCase() ||
    state.fundingAmount !== channel.fundingAmount ||
    state.authorizedCumulativeAmount !== channel.chargedCumulativeAmount ||
    state.claimedCumulativeAmount !== channel.claimedCumulativeAmount ||
    state.authorizedCumulativeAmount !== channel.signedMaxClaimable
  );
}

function readChargedAmount(
  response: SettlementResponse,
  accepted: BatchPaymentRequirements,
): SompiString {
  const responseExtra = readKaspaSettlementExtension(response);
  const amount = response.amount ?? responseExtra?.chargedAmount;
  if (amount === undefined) {
    throw new KaspaX402Error(
      "invalid_kaspa_settlement_response",
      "settlement response must include the charged amount",
    );
  }
  parseSompiString(amount);
  parseSompiString(accepted.amount);
  if (
    responseExtra?.chargedAmount !== undefined &&
    responseExtra.chargedAmount !== amount
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_settlement_response",
      "settlement charged amount does not match extension metadata",
    );
  }
  return amount;
}

function addAmounts(a: SompiString, b: SompiString): SompiString {
  return formatSompiString(parseSompiString(a) + parseSompiString(b));
}

function canAuthorizeBatchCharge(
  channel: DirectModeChannel,
  maximumNewCharge: SompiString,
  claimReserve: SompiString,
): boolean {
  try {
    const signedMaxClaimable = requiredBatchVoucherAmount(
      channel,
      maximumNewCharge,
    );
    assertBatchVoucherReserve({ ...channel, signedMaxClaimable }, claimReserve);
    return true;
  } catch {
    return false;
  }
}

function maxBigInt(left: bigint, right: bigint): bigint {
  return left >= right ? left : right;
}

function paymentVoucherAmount(paymentPayload: PaymentPayload): SompiString {
  const payload = paymentPayload.payload;
  if (payload.type !== "deposit-voucher" && payload.type !== "voucher") {
    throw new KaspaX402Error(
      "invalid_kaspa_payment_payload_type",
      "settlement response does not correspond to a voucher payment",
    );
  }
  return payload.voucher.authorizedCumulativeAmount;
}

function scriptPublicKeyHash(scriptPublicKey: string): string {
  return sha256Hex(hexToBytes(scriptPublicKey));
}

function originForUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function contextWithRequestHash(
  context: PaymentRequestContext,
  accepted: PaymentRequirements,
): PaymentRequestContext {
  const requestHash =
    context.requestHash ?? fingerprintHttpRequest(context.url, context, accepted);
  return {
    ...context,
    requestHash: bindRequestHashToTrustedContext(
      requestHash,
      context.trustedSecurityContext,
    ),
  };
}

function fingerprintHttpRequest(
  input: string,
  init: Pick<PaymentRequestContext, "method" | "body">,
  accepted: PaymentRequirements,
): string {
  try {
    return sha256Hex(
      stableStringify({
        method: init.method ?? "GET",
        url: input,
        body: init.body ?? null,
        paymentRequirementsHash: sha256Hex(stableStringify(accepted)),
      }),
    );
  } catch (error) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      "requestHash is required when the request body is outside the JSON canonicalization profile",
      error,
    );
  }
}

function withHeader(
  headers: HeadersInitLike | undefined,
  name: string,
  value: string,
): Record<string, string> {
  const next: Record<string, string> = {};
  if (headers && Array.isArray(headers)) {
    for (const [key, item] of headers) next[key] = item;
  } else if (hasHeaderEntries(headers)) {
    for (const [key, item] of headers.entries()) next[key] = item;
  } else if (headers) {
    Object.assign(next, headers);
  }
  next[name] = value;
  return next;
}

function globalFetchLike(): FetchLike {
  const candidate = globalThis.fetch;
  if (typeof candidate !== "function") {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      "no fetch adapter was provided",
    );
  }
  return candidate as unknown as FetchLike;
}

function assertPaidFetchResponseTarget(
  response: HttpResponseLike,
  requestedUrl: string,
  stage: string,
): void {
  let expected: URL;
  let effective: URL;
  try {
    const browserBase = (globalThis as { location?: { href?: string } })
      .location?.href;
    expected = browserBase
      ? new URL(requestedUrl, browserBase)
      : new URL(requestedUrl);
    effective = new URL(response.url);
  } catch {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      `${stage} did not expose a valid effective response URL`,
    );
  }
  if (response.redirected || effective.href !== expected.href) {
    throw new KaspaX402Error(
      "invalid_kaspa_x402_payload",
      `${stage} redirected away from the authorized request URL`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasHeaderEntries(
  value: HeadersInitLike | undefined,
): value is { entries(): IterableIterator<[string, string]> } {
  return (
    value !== undefined &&
    typeof value === "object" &&
    "entries" in value &&
    typeof value.entries === "function"
  );
}
