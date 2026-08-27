import {
  X402_VERSION,
  assertBatchVoucherReserve,
  assertMainnetAllowed,
  batchLaneAccounting,
  channelId,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  exactAuthorizationExpiresAt,
  exactRequestAuthorizationDigest,
  formatSompiString,
  hexToBytes,
  paymentIdentifierExtension,
  parseBatchLaneAmount,
  parseSompiString,
  readKaspaSettlementExtension,
  requiredBatchVoucherAmount,
  sha256Hex,
  stableStringify,
  validatePaymentRetry,
  voucherDigest,
  voucherPreimageHex,
  type BatchPaymentRequirements,
  type ChannelConfig,
  type ChannelState,
  type ExactPaymentRequirements,
  type FundingOutpoint,
  type Hash32Hex,
  type PaymentPayload,
  type PaymentRequirements,
  type SettlementResponse,
  type SompiString,
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

export class DirectModeClient {
  readonly #options: DirectModeClientOptions;

  constructor(options: DirectModeClientOptions) {
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
    assertProviderNetwork(this.#options, parsed.accepted.network);
    if (parsed.accepted.scheme === "exact") {
      return this.#createExactPayment(
        parsed.accepted,
        parsed.paymentRequired,
        contextWithRequestHash(context, parsed.accepted),
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
        context,
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
      context,
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
      method: init.method,
      body: init.body,
    });
    const retryInit: HttpRequestInitLike = {
      ...requestInit,
      headers: withHeader(
        init.headers,
        PAYMENT_SIGNATURE_HEADER,
        encodePaymentSignatureHeader(payment.paymentPayload),
      ),
    };
    const retryResponse = await fetch(input, retryInit);
    assertPaidFetchResponseTarget(retryResponse, input, "paid retry");
    if (retryResponse.status === 402) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_payload",
        "corrective 402 requires a new explicit payment authorization; the client will not sign automatically",
      );
    }

    const responseHeader = retryResponse.headers.get(PAYMENT_RESPONSE_HEADER);
    if (!responseHeader) {
      throw new KaspaX402Error(
        "invalid_kaspa_settlement_response",
        "paid retry response is missing PAYMENT-RESPONSE",
      );
    }

    const settlement = await this.applySettlement(
      payment,
      decodePaymentResponseHeader(responseHeader),
    );
    return { response: retryResponse, payment, settlement };
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
      if (parseSompiString(chargedAmount) > parseSompiString(accepted.amount)) {
        throw new KaspaX402Error(
          "invalid_kaspa_settlement_response",
          "charged amount exceeds accepted amount",
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

      await this.#options.store.saveChannel(updated);
      return {
        channel: updated,
        chargedAmount,
        response,
      };
    } catch (error) {
      await this.#options.store.saveChannel({
        ...payment.channel,
        status: "suspicious",
      });
      throw error;
    }
  }

  async listRefundableChannels(
    nowDaa?: SompiString,
  ): Promise<DirectModeChannel[]> {
    const daa =
      nowDaa ?? (await this.#options.fundingProvider.getVirtualDaaScore());
    return this.#options.store.listRefundableChannels(daa);
  }

  async refundChannel(channelId: string): Promise<RefundResult> {
    const target = (await this.#options.store.loadChannels({})).find(
      (candidate) => sameHash32(candidate.id, channelId),
    );
    if (!target) {
      throw new KaspaX402Error("invalid_kaspa_channel_id", "channel not found");
    }
    assertProviderNetwork(this.#options, target.config.network);
    const existingAttempt = await this.#options.store.loadRefundAttempt(
      target.id,
    );
    if (existingAttempt && existingAttempt.status !== "applied") {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "refund attempt is unresolved; reconcile the persisted transaction before another refund",
      );
    }
    if (existingAttempt) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "refund attempt is already applied",
      );
    }
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
    const finality = broadcast.finality ?? "broadcast";
    if (
      finality !== "broadcast" &&
      finality !== "accepted" &&
      finality !== "confirmed"
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "refund broadcast returned unsupported finality",
      );
    }
    if (finality === "broadcast") {
      await this.#options.store.saveRefundAttempt({
        ...attempt,
        status: "broadcast",
        finality: "broadcast",
      });
      return {
        channel: target,
        refundAmount,
        transactionId: attempt.transactionId,
        finality: "broadcast",
        accepted: false,
      };
    }
    const applied = await this.#options.store.applyRefundAttempt({
      channelId: target.id,
      transactionId: attempt.transactionId,
      finality,
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
        finality: attempt.finality,
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
    if (observed.status !== "unknown" && observed.status !== "accepted") {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "refund reconciler returned an unsupported status",
      );
    }
    if (observed.status === "unknown") {
      return {
        channel: target,
        refundAmount: attempt.refundAmount,
        transactionId: attempt.transactionId,
        finality: "unknown",
        accepted: false,
      };
    }
    if (observed.finality !== "accepted" && observed.finality !== "confirmed") {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "accepted refund reconciliation is missing accepted finality",
      );
    }
    const applied = await this.#options.store.applyRefundAttempt({
      channelId: target.id,
      transactionId: attempt.transactionId,
      finality: observed.finality,
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
    if (
      observed.status !== "unknown" &&
      observed.status !== "absent" &&
      observed.status !== "accepted"
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "funding transition reconciler returned an unsupported status",
      );
    }
    if (observed.status === "unknown") {
      return fundingTransitionResult(attempt, "unknown", false);
    }
    if (observed.status === "absent") {
      await this.#options.store.releaseFundingTransitionAttempt(
        attempt.channelId,
        attempt.transactionId,
      );
      return fundingTransitionResult(attempt, "absent", false);
    }
    if (observed.finality !== "accepted" && observed.finality !== "confirmed") {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "accepted funding reconciliation is missing accepted finality",
      );
    }
    const applied = await this.#applyAcceptedFundingTransition(
      attempt,
      observed.finality,
    );
    return fundingTransitionResult(
      applied.attempt,
      observed.finality,
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

      const current = await this.#applyCorrectiveStateIfPresent(
        channel,
        accepted,
      );
      const stillUnspent = await this.#activeOutpointExists(current);
      if (!stillUnspent) {
        await this.#options.store.retireChannel(
          current.id,
          "active outpoint not found",
        );
        continue;
      }

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
      settledTotal: channel.claimedCumulativeAmount,
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
      templateId: "kaspa-x402-escrow-v2",
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
      settledTotal: "0",
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
        settledTotal: "0",
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
      settledTotal: "0",
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
      status: "pending",
    };
    await this.#options.store.claimFundingTransitionAttempt(attempt);
    const channel = await this.#broadcastFundingTransition(attempt);
    const fundingOutpoint = channel.activeOutpoint;
    const fundingAmount = channel.fundingAmount;
    const voucher = await this.#signVoucher(channel, accepted.amount);
    const signedChannel = {
      ...channel,
      signedMaxClaimable: voucher.amount,
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
    const head = exactHeadHint(accepted);
    if (profile === "additive" && !head) {
      throw new KaspaX402Error(
        "invalid_kaspa_x402_payload",
        "additive exact requirements must include head challenge terms",
      );
    }
    const exactRequest: ExactPaymentRequest = {
      network: accepted.network,
      profile,
      origin: context.origin ?? originForUrl(context.url),
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
    return {
      paymentRequired,
      accepted,
      paymentPayload,
      scheme: "exact",
      openedChannel: false,
      ...("transactionId" in exact && exact.transactionId
        ? { transactionId: exact.transactionId }
        : {}),
      paymentOutputIndex: exact.paymentOutputIndex,
      payerAddress,
    };
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
    const expiresAt = Date.parse(exact.authorization.expiresAt);
    if (
      exact.authorization.version !==
        "kaspa-x402-exact-request-authorization-v1" ||
      !Number.isInteger(exact.authorization.inputIndex) ||
      exact.authorization.inputIndex < 0 ||
      !Number.isFinite(expiresAt) ||
      exact.authorization.expiresAt !== request.authorizationExpiresAt ||
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
    await this.#options.fundingProvider.authorizeExactPayment(request);
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
      channel.latestVoucher && channel.latestVoucher.amount === nextAmount
        ? channel.latestVoucher
        : await this.#signVoucher(channel, nextAmount);
    const updated = {
      ...channel,
      signedMaxClaimable: voucher.amount,
      latestVoucher: voucher,
    };
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
          }
        : {
            type: "voucher",
            channelId: updated.id,
            clientPublicKey: updated.clientPublicKey,
            fundingOutpoint: updated.activeOutpoint,
            activeScriptPublicKey: updated.activeScriptPublicKey,
            voucher,
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
      amount,
    };
    const digest = voucherDigest(input);
    const preimage = voucherPreimageHex(input);
    const signature = await this.#options.signer.signVoucher({
      digest,
      preimage,
      channel,
      amount,
    });
    return { covenantId: channel.covenantId, amount, signature };
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
    const finality = broadcast.finality ?? "broadcast";
    if (
      finality !== "broadcast" &&
      finality !== "accepted" &&
      finality !== "confirmed"
    ) {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "funding broadcast returned unsupported finality",
      );
    }
    await this.#options.store.saveFundingTransitionAttempt({
      ...attempt,
      status: "broadcast",
      finality: "broadcast",
    });
    if (finality === "broadcast") {
      throw new KaspaX402Error(
        "invalid_kaspa_transaction",
        "funding transition was broadcast but is not accepted; reconcile the persisted transaction before lane reuse",
      );
    }
    return (await this.#applyAcceptedFundingTransition(attempt, finality))
      .channel;
  }

  async #applyAcceptedFundingTransition(
    attempt: FundingTransitionAttemptRecord,
    finality: "accepted" | "confirmed",
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
        finality,
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
      finality,
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

  #deriveEscrowHead(
    channel: DirectModeChannel,
    settledTotal: SompiString,
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
      settledTotal,
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
    const voucherState = accepted.extra.voucherState;
    if (!voucherState) {
      throw new KaspaX402Error(
        "invalid_kaspa_signature",
        "corrective channel state requires voucher proof",
      );
    }
    if (!this.#options.verifyVoucherSignature) {
      throw new KaspaX402Error(
        "invalid_kaspa_signature",
        "corrective voucher proof verifier is required",
      );
    }
    if (voucherState.amount !== state.signedMaxClaimable) {
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
  if (options.supportedSchemes) return options.supportedSchemes;
  const schemes: ("exact" | "batch-settlement")[] = [];
  if (options.fundingProvider.payExactTransaction) schemes.push("exact");
  schemes.push("batch-settlement");
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
  if (requirement.scheme !== "exact") return true;
  if (!options.fundingProvider.payExactTransaction) return false;
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
      chargedAmount: "0",
      response,
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
  const finality = readExactFinality(responseExtra.finality);
  const requiredFinality = readExactFinality(accepted.extra.finality);
  if (
    requiredFinality &&
    (!finality || !exactFinalityMeets(finality, requiredFinality))
  ) {
    throw new KaspaX402Error(
      "invalid_kaspa_transaction",
      "exact settlement has not reached required finality",
    );
  }
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
    chargedAmount: response.amount,
    response,
    transactionId: response.transaction,
    finality,
  };
}

function exactFinalityMeets(
  actual: "mempool" | "accepted" | "confirmed",
  required: "mempool" | "accepted" | "confirmed",
): boolean {
  const rank = { mempool: 0, accepted: 1, confirmed: 2 } as const;
  return rank[actual] >= rank[required];
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
  if (required && !context.paymentIdentifier) {
    throw new KaspaX402Error(
      "missing_kaspa_payment_identifier",
      "payment-identifier extension is required for this retry",
    );
  }
  if (!context.paymentIdentifier) return undefined;
  return {
    "payment-identifier": paymentIdentifierExtension(
      {
        ...(isRecord(info) ? info : {}),
        required,
        id: context.paymentIdentifier,
      },
      schema,
    ),
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
  if (state.chargedCumulativeAmount !== expectedCharged) {
    throw new KaspaX402Error(
      "invalid_kaspa_settlement_response",
      "settlement charged cumulative amount does not match this request",
    );
  }
  if (state.signedMaxClaimable !== expectedSignedAmount) {
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
    parseSompiString(state.chargedCumulativeAmount) <
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
    parseSompiString(state.signedMaxClaimable) <
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
  batchLaneAccounting(state);
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
    parseSompiString(state.signedMaxClaimable) <
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
    chargedCumulativeAmount: state.chargedCumulativeAmount,
    claimedCumulativeAmount: state.claimedCumulativeAmount,
    signedMaxClaimable: state.signedMaxClaimable,
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
    state.chargedCumulativeAmount !== channel.chargedCumulativeAmount ||
    state.claimedCumulativeAmount !== channel.claimedCumulativeAmount ||
    state.signedMaxClaimable !== channel.signedMaxClaimable
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
  return payload.voucher.amount;
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
  return {
    ...context,
    requestHash:
      context.requestHash ??
      fingerprintHttpRequest(context.url, context, accepted),
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
