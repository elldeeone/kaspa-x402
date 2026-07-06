import {
  X402_VERSION,
  assertMainnetAllowed,
  channelId,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  formatSompiString,
  hexToBytes,
  paymentIdentifierExtension,
  parseSompiString,
  readKaspaSettlementExtension,
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
  type PaymentPayload,
  type PaymentRequirements,
  type SettlementResponse,
  type SompiString,
  type Voucher,
} from "@kaspa-x402/core";
import { KaspaX402Error } from "@kaspa-x402/core";
import { deriveEscrowAddress, escrowScriptPublicKey, serializedScriptPublicKey } from "@kaspa-x402/covenant";
import { parsePaymentRequiredHeaderValue } from "./payment-required.js";
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  type ApplySettlementResult,
  type CreatePaymentResult,
  type DirectModeChannel,
  type DirectModeClientOptions,
  type EscrowDepositResult,
  type FetchLike,
  type HeadersInitLike,
  type HttpRequestInitLike,
  type PaidFetchResult,
  type PaymentRequestContext,
  type RefundResult,
} from "./types.js";

export class DirectModeClient {
  readonly #options: DirectModeClientOptions;

  constructor(options: DirectModeClientOptions) {
    assertMainnetAllowed(options.fundingProvider.networkId, options.allowMainnet, "DirectModeClient");
    if (!options.allowMainnet && options.supportedNetworks?.includes("kaspa:mainnet")) {
      throw new KaspaX402Error("invalid_kaspa_x402_network", "DirectModeClient requires allowMainnet for kaspa:mainnet");
    }
    this.#options = options;
  }

  supportedNetworks(): readonly ("kaspa:mainnet" | "kaspa:testnet-10")[] {
    return supportedNetworksForClient(this.#options);
  }

  supportedSchemes(): readonly ("exact" | "batch-settlement")[] {
    return supportedSchemesForClient(this.#options);
  }

  async createPayment(header: string, context: PaymentRequestContext): Promise<CreatePaymentResult> {
    assertFundingPolicy(this.#options);
    const parsed = parsePaymentRequiredHeaderValue(header, {
      supportedNetworks: supportedNetworksForClient(this.#options),
      supportedSchemes: supportedSchemesForClient(this.#options),
    });
    assertProviderNetwork(this.#options, parsed.accepted.network);
    if (parsed.accepted.scheme === "exact") {
      return this.#createExactPayment(parsed.accepted, parsed.paymentRequired, contextWithRequestHash(context, parsed.accepted));
    }
    if (parsed.accepted.scheme !== "batch-settlement") {
      throw new KaspaX402Error("invalid_kaspa_x402_scheme", "unsupported Kaspa x402 requirement was selected");
    }

    const origin = context.origin ?? originForUrl(context.url);
    const resourceUrl = parsed.paymentRequired.resource.url;
    const accepted = parsed.accepted;
    const existing = await this.#selectExistingChannel(accepted, origin, resourceUrl);

    if (existing) {
      const { channel, paymentPayload } = await this.#buildVoucherPayload(existing, accepted, parsed.paymentRequired, context);
      return {
        paymentRequired: parsed.paymentRequired,
        accepted,
        paymentPayload,
        scheme: "batch-settlement",
        channel,
        openedChannel: false,
      };
    }

    const { channel, paymentPayload } = await this.#openDepositVoucherChannel(accepted, parsed.paymentRequired, context, origin);
    return {
      paymentRequired: parsed.paymentRequired,
      accepted,
      paymentPayload,
      scheme: "batch-settlement",
      channel,
      openedChannel: true,
    };
  }

  async paidFetch(input: string, init: HttpRequestInitLike = {}): Promise<PaidFetchResult> {
    const fetch = this.#options.fetch ?? globalFetchLike();
    const firstResponse = await fetch(input, init);
    if (firstResponse.status !== 402) {
      return { response: firstResponse };
    }

    let required = firstResponse.headers.get(PAYMENT_REQUIRED_HEADER);
    if (!required) {
      throw new KaspaX402Error("invalid_kaspa_x402_payload", "402 response is missing PAYMENT-REQUIRED");
    }

    const maxPaymentRetries = this.#options.maxPaymentRetries ?? 2;
    for (let attempt = 0; attempt <= maxPaymentRetries; attempt += 1) {
      const payment = await this.createPayment(required, {
        url: input,
        paymentIdentifier: init.paymentIdentifier,
        requestHash: init.requestHash,
        method: init.method,
        body: init.body,
      });
      const retryInit: HttpRequestInitLike = {
        ...init,
        headers: withHeader(init.headers, PAYMENT_SIGNATURE_HEADER, encodePaymentSignatureHeader(payment.paymentPayload)),
      };
      const retryResponse = await fetch(input, retryInit);
      if (retryResponse.status === 402) {
        const corrective = retryResponse.headers.get(PAYMENT_REQUIRED_HEADER);
        if (!corrective) {
          throw new KaspaX402Error("invalid_kaspa_x402_payload", "corrective 402 response is missing PAYMENT-REQUIRED");
        }
        required = corrective;
        continue;
      }

      const responseHeader = retryResponse.headers.get(PAYMENT_RESPONSE_HEADER);
      if (!responseHeader) {
        throw new KaspaX402Error("invalid_kaspa_settlement_response", "paid retry response is missing PAYMENT-RESPONSE");
      }

      const settlement = await this.applySettlement(payment, decodePaymentResponseHeader(responseHeader));
      return { response: retryResponse, payment, settlement };
    }

    throw new KaspaX402Error("invalid_kaspa_x402_payload", "too many corrective 402 payment retries");
  }

  async applySettlement(payment: CreatePaymentResult, response: SettlementResponse): Promise<ApplySettlementResult> {
    if (payment.accepted.scheme === "exact") {
      return applyExactSettlement(payment, response);
    }
    if (!payment.channel) {
      throw new KaspaX402Error("invalid_kaspa_settlement_response", "batch settlement is missing local channel state");
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
        throw new KaspaX402Error("invalid_kaspa_settlement_response", "settlement response network does not match accepted requirement");
      }
      const responseExtra = readKaspaSettlementExtension(response);
      if (responseExtra?.channelId !== undefined && responseExtra.channelId !== payment.channel.id) {
        throw new KaspaX402Error("invalid_kaspa_channel_id", "settlement response channel id does not match local channel");
      }

      const chargedAmount = readChargedAmount(response, accepted);
      if (parseSompiString(chargedAmount) > parseSompiString(accepted.amount)) {
        throw new KaspaX402Error("invalid_kaspa_settlement_response", "charged amount exceeds accepted amount");
      }
      if (payment.paymentPayload.payload.type === "deposit-voucher" && responseExtra?.fundingAmount !== payment.channel.fundingAmount) {
        throw new KaspaX402Error("invalid_kaspa_settlement_response", "deposit settlement funding amount does not match local channel");
      }

      if (!responseExtra?.commitmentId) {
        throw new KaspaX402Error("invalid_kaspa_settlement_response", "successful voucher settlement must include a commitment id");
      }
      if (response.transaction.toLowerCase() !== responseExtra.commitmentId.toLowerCase()) {
        throw new KaspaX402Error("invalid_kaspa_settlement_response", "batch settlement transaction must equal the commitment id");
      }
      const channelState = responseExtra.channelState;
      if (!channelState) {
        throw new KaspaX402Error("invalid_kaspa_settlement_response", "successful voucher settlement must include channel state");
      }
      const updated = applySettlementChannelState(payment.channel, channelState, chargedAmount, paymentVoucherAmount(payment.paymentPayload));

      await this.#options.store.saveChannel(updated);
      return {
        channel: updated,
        chargedAmount,
        response,
      };
    } catch (error) {
      await this.#options.store.saveChannel({ ...payment.channel, status: "suspicious" });
      throw error;
    }
  }

  async listRefundableChannels(nowDaa?: SompiString): Promise<DirectModeChannel[]> {
    const daa = nowDaa ?? (await this.#options.fundingProvider.getVirtualDaaScore());
    return this.#options.store.listRefundableChannels(daa);
  }

  async refundChannel(channelId: string): Promise<RefundResult> {
    const target = (await this.#options.store.loadChannels({})).find((candidate) => candidate.id === channelId);
    if (!target) {
      throw new KaspaX402Error("invalid_kaspa_channel_id", "channel not found");
    }
    assertProviderNetwork(this.#options, target.config.network);

    const nowDaa = await this.#options.fundingProvider.getVirtualDaaScore();
    if (parseSompiString(nowDaa) < parseSompiString(target.refundTimeoutDaa)) {
      throw new KaspaX402Error("invalid_kaspa_settlement_response", "channel is not refund-unlocked yet");
    }
    if (!this.#options.signer.signRefund || !this.#options.refundBuilder) {
      throw new KaspaX402Error("invalid_kaspa_transaction", "refund signing and transaction builder adapters are required");
    }

    const refundAmount = target.fundingAmount;
    const clientSignature = await this.#options.signer.signRefund({ channel: target, refundAmount });
    const refund = await this.#options.refundBuilder.buildRefundTransaction({ channel: target, refundAmount, clientSignature });
    if (refund.refundAmount !== undefined && refund.refundAmount !== refundAmount) {
      throw new KaspaX402Error("invalid_kaspa_transaction", "refund transaction amount does not match signed refund amount");
    }
    const broadcast = await this.#options.fundingProvider.sendTransaction(refund.transaction);
    const finality = broadcast.finality ?? "broadcast";
    const accepted = finality === "accepted" || finality === "confirmed";
    const updated = accepted ? { ...target, status: "refunded" as const } : target;
    if (accepted) {
      await this.#options.store.saveChannel(updated);
    }
    return {
      channel: updated,
      refundAmount: refund.refundAmount ?? refundAmount,
      transactionId: broadcast.transactionId,
      finality,
      accepted,
    };
  }

  async #selectExistingChannel(
    accepted: BatchPaymentRequirements,
    origin: string,
    resourceUrl: string,
  ): Promise<DirectModeChannel | undefined> {
    const channels = await this.#options.store.loadChannels({ origin, network: accepted.network, status: "active" });
    for (const channel of channels) {
      if (!channelMatchesRequirement(channel, accepted, resourceUrl)) continue;

      const current = await this.#applyCorrectiveStateIfPresent(channel, accepted);
      const stillUnspent = await this.#activeOutpointExists(current);
      if (!stillUnspent) {
        await this.#options.store.retireChannel(current.id, "active outpoint not found");
        continue;
      }

      if (parseSompiString(current.fundingAmount) >= parseSompiString(addAmounts(activeClaimableAmount(current), accepted.amount))) {
        return current;
      }
    }

    return undefined;
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
      templateId: "kaspa-x402-escrow-v1",
      clientPublicKey: channelKey.publicKey,
      serverPublicKey: accepted.extra.serverPublicKey,
      payTo: accepted.payTo,
      refundAddress,
      refundTimeoutDaa: accepted.extra.refundTimeoutDaa,
      salt: await this.#options.signer.randomSalt(),
    };
    const id = channelId(channelConfig);
    if (parseSompiString(accepted.extra.minDepositSompi) < parseSompiString(accepted.amount)) {
      throw new KaspaX402Error("invalid_kaspa_x402_amount", "minimum deposit cannot cover the first voucher");
    }
    const payoutScriptPublicKeyHash = scriptPublicKeyHash(
      this.#options.addressCodec.scriptPublicKeyForAddress(channelConfig.payTo, channelConfig.network),
    );
    const refundScriptPublicKeyHash = scriptPublicKeyHash(
      this.#options.addressCodec.scriptPublicKeyForAddress(channelConfig.refundAddress, channelConfig.network),
    );
    const script = escrowScriptPublicKey({
      clientPublicKey: channelConfig.clientPublicKey,
      serverPublicKey: channelConfig.serverPublicKey,
      network: channelConfig.network,
      payoutScriptPublicKeyHash,
      refundScriptPublicKeyHash,
      timeoutDaa: channelConfig.refundTimeoutDaa,
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
      },
      (input) => this.#options.addressCodec.encodeScriptAddress(input),
    );
    const deposit = await this.#options.fundingProvider.fundEscrowDeposit({
      network: accepted.network,
      channelId: id,
      channelConfig,
      escrowAddress,
      escrowScriptPublicKey: activeScriptPublicKey,
      amount: accepted.extra.minDepositSompi,
      fundingSource: this.#options.fundingPolicy?.requiredSource,
    });
    if (this.#options.fundingPolicy?.requiredSource && deposit.fundingSource && deposit.fundingSource !== this.#options.fundingPolicy.requiredSource) {
      throw new KaspaX402Error("invalid_kaspa_x402_payload", "deposit funding source does not satisfy policy");
    }
    const funding = await this.#resolveFundingUtxo(deposit, escrowAddress, activeScriptPublicKey);
    const fundingOutpoint = funding.outpoint;
    const fundingAmount = funding.amount;
    if (parseSompiString(fundingAmount) < parseSompiString(accepted.extra.minDepositSompi)) {
      throw new KaspaX402Error("invalid_kaspa_x402_amount", "resolved funding amount is below the required minimum deposit");
    }
    if (parseSompiString(fundingAmount) < parseSompiString(accepted.amount)) {
      throw new KaspaX402Error("invalid_kaspa_x402_amount", "resolved funding amount cannot cover the first voucher");
    }
    const channel: DirectModeChannel = {
      id,
      origin,
      resourceUrl: paymentRequired.resource.url,
      config: channelConfig,
      clientPrivateKey: channelKey.privateKey,
      clientPublicKey: channelConfig.clientPublicKey,
      serverPublicKey: channelConfig.serverPublicKey,
      activeOutpoint: fundingOutpoint,
      activeScriptPublicKey,
      escrowAddress,
      fundingSource: deposit.fundingSource ?? this.#options.fundingProvider.sourceKind,
      fundingAmount,
      chargedCumulativeAmount: "0",
      claimedCumulativeAmount: "0",
      signedCumulativeAmount: "0",
      refundTimeoutDaa: channelConfig.refundTimeoutDaa,
      templateId: channelConfig.templateId,
      status: "active",
    };
    const voucher = await this.#signVoucher(channel, accepted.amount);
    const signedChannel = {
      ...channel,
      signedCumulativeAmount: voucher.amount,
      latestVoucher: voucher,
    };
    const paymentPayload = buildPaymentPayload(paymentRequired, accepted, context, {
      type: "deposit-voucher",
      channelConfig,
      channelId: id,
      escrowAddress,
      fundingOutpoint,
      fundingAmountSompi: fundingAmount,
      ...(deposit.transaction ? { fundingTransaction: deposit.transaction } : {}),
      activeScriptPublicKey,
      voucher,
    });

    const retryValidation = validatePaymentRetry({ paymentRequired, paymentPayload });
    if (!retryValidation.ok) throw retryValidation.error;
    await this.#options.store.saveChannel(signedChannel);
    return { channel: signedChannel, paymentPayload };
  }

  async #createExactPayment(
    accepted: ExactPaymentRequirements,
    paymentRequired: CreatePaymentResult["paymentRequired"],
    context: PaymentRequestContext,
  ): Promise<CreatePaymentResult> {
    if (!this.#options.fundingProvider.payExact) {
      throw new KaspaX402Error("invalid_kaspa_transaction", "exact payment adapter is required");
    }
    const exact = await this.#options.fundingProvider.payExact({
      network: accepted.network,
      amount: accepted.amount,
      payTo: accepted.payTo,
      requestHash: context.requestHash,
      requiredFinality: accepted.extra.finality,
      fundingSource: this.#options.fundingPolicy?.requiredSource,
    });
    if (this.#options.fundingPolicy?.requiredSource && exact.fundingSource && exact.fundingSource !== this.#options.fundingPolicy.requiredSource) {
      throw new KaspaX402Error("invalid_kaspa_x402_payload", "exact payment funding source does not satisfy policy");
    }
    if (!Number.isInteger(exact.paymentOutputIndex) || exact.paymentOutputIndex < 0) {
      throw new KaspaX402Error("invalid_kaspa_transaction", "exact payment output index is invalid");
    }
    if (!/^[0-9a-fA-F]{64}$/.test(exact.transactionId)) {
      throw new KaspaX402Error("invalid_kaspa_transaction", "exact payment transaction id is invalid");
    }
    const finality = readExactPaymentFinality(exact.finality);
    const requiredFinality = readExactFinality(accepted.extra.finality);
    if (requiredFinality && !exactFinalityMeets(finality, requiredFinality)) {
      throw new KaspaX402Error("invalid_kaspa_transaction", "exact payment adapter returned payment below required finality");
    }
    const identity = exact.payerAddress ? undefined : await this.#options.fundingProvider.getPublicIdentity();
    const paymentPayload = buildPaymentPayload(paymentRequired, accepted, context, {
      type: "exact-transfer",
      payerAddress: exact.payerAddress ?? identity?.address,
      transactionId: exact.transactionId,
      paymentOutputIndex: exact.paymentOutputIndex,
      ...(context.requestHash ? { requestHash: context.requestHash } : {}),
    });
    const retryValidation = validatePaymentRetry({ paymentRequired, paymentPayload });
    if (!retryValidation.ok) throw retryValidation.error;
    return {
      paymentRequired,
      accepted,
      paymentPayload,
      scheme: "exact",
      openedChannel: false,
      transactionId: exact.transactionId,
      paymentOutputIndex: exact.paymentOutputIndex,
      payerAddress: exact.payerAddress ?? identity?.address,
    };
  }

  async #buildVoucherPayload(
    channel: DirectModeChannel,
    accepted: BatchPaymentRequirements,
    paymentRequired: CreatePaymentResult["paymentRequired"],
    context: PaymentRequestContext,
  ): Promise<{ channel: DirectModeChannel; paymentPayload: PaymentPayload }> {
    const nextAmount = maxAmount(channel.signedCumulativeAmount, addAmounts(activeClaimableAmount(channel), accepted.amount));
    const voucher =
      channel.latestVoucher && channel.latestVoucher.amount === nextAmount
        ? channel.latestVoucher
        : await this.#signVoucher(channel, nextAmount);
    const updated = {
      ...channel,
      signedCumulativeAmount: voucher.amount,
      latestVoucher: voucher,
    };
    const paymentPayload = buildPaymentPayload(paymentRequired, accepted, context, {
      type: "voucher",
      channelId: updated.id,
      clientPublicKey: updated.clientPublicKey,
      fundingOutpoint: updated.activeOutpoint,
      activeScriptPublicKey: updated.activeScriptPublicKey,
      voucher,
    });

    const retryValidation = validatePaymentRetry({ paymentRequired, paymentPayload });
    if (!retryValidation.ok) throw retryValidation.error;
    await this.#options.store.saveChannel(updated);
    return { channel: updated, paymentPayload };
  }

  async #signVoucher(channel: DirectModeChannel, amount: SompiString): Promise<Voucher> {
    const input = {
      network: channel.config.network,
      activeScriptPublicKey: channel.activeScriptPublicKey,
      outpoint: channel.activeOutpoint,
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
    return { amount, signature };
  }

  async #resolveFundingUtxo(
    deposit: EscrowDepositResult,
    escrowAddress: string,
    activeScriptPublicKey: string,
  ): Promise<{ outpoint: FundingOutpoint; amount: SompiString }> {
    const utxos = await this.#options.fundingProvider.getUtxos([escrowAddress]);
    const expectedOutpoint = deposit.outpoint ?? (deposit.txid && deposit.index !== undefined ? { txid: deposit.txid, index: deposit.index } : undefined);
    const matches = utxos.filter((utxo) => {
      if (expectedOutpoint) {
        return (
          utxo.outpoint.txid.toLowerCase() === expectedOutpoint.txid.toLowerCase() &&
          utxo.outpoint.index === expectedOutpoint.index &&
          utxo.scriptPublicKey.toLowerCase() === activeScriptPublicKey.toLowerCase() &&
          (deposit.amount === undefined || utxo.amount === deposit.amount)
        );
      }
      if (deposit.txid && utxo.outpoint.txid.toLowerCase() !== deposit.txid.toLowerCase()) return false;
      if (deposit.amount !== undefined && utxo.amount !== deposit.amount) return false;
      if (utxo.scriptPublicKey.toLowerCase() !== activeScriptPublicKey.toLowerCase()) return false;
      return true;
    });
    if (matches.length !== 1) {
      throw new KaspaX402Error("invalid_kaspa_outpoint", "funding provider did not return a resolvable escrow outpoint");
    }
    return {
      outpoint: matches[0].outpoint,
      amount: matches[0].amount,
    };
  }

  async #activeOutpointExists(channel: DirectModeChannel): Promise<boolean> {
    const utxos = await this.#options.fundingProvider.getUtxos([channel.escrowAddress]);
    return utxos.some(
      (utxo) =>
        utxo.outpoint.txid.toLowerCase() === channel.activeOutpoint.txid.toLowerCase() &&
        utxo.outpoint.index === channel.activeOutpoint.index &&
        utxo.scriptPublicKey.toLowerCase() === channel.activeScriptPublicKey.toLowerCase() &&
        utxo.amount === channel.fundingAmount,
    );
  }

  async #applyCorrectiveStateIfPresent(channel: DirectModeChannel, accepted: BatchPaymentRequirements): Promise<DirectModeChannel> {
    const state = accepted.extra.channelState;
    if (!state) return channel;
    if (state.channelId !== channel.id) return channel;
    if (!correctiveStateChanges(channel, state)) return channel;
    const voucherState = accepted.extra.voucherState;
    if (!voucherState) {
      throw new KaspaX402Error("invalid_kaspa_signature", "corrective channel state requires voucher proof");
    }
    if (!this.#options.verifyVoucherSignature) {
      throw new KaspaX402Error("invalid_kaspa_signature", "corrective voucher proof verifier is required");
    }
    if (voucherState.amount !== state.signedMaxClaimable) {
      throw new KaspaX402Error("invalid_kaspa_settlement_response", "corrective voucher amount must match signed ceiling");
    }
    const candidate = correctiveChannelCandidate(channel, state, voucherState);
    const verified = await this.#options.verifyVoucherSignature(voucherState, candidate);
    if (!verified) {
      throw new KaspaX402Error("invalid_kaspa_signature", "corrective voucher state signature was rejected");
    }
    const updated = applyCorrectiveChannelState(channel, state, voucherState);
    await this.#options.store.saveChannel(updated);
    return updated;
  }
}

function assertFundingPolicy(options: DirectModeClientOptions): void {
  const required = options.fundingPolicy?.requiredSource;
  if (required && options.fundingProvider.sourceKind !== required) {
    throw new KaspaX402Error("invalid_kaspa_x402_payload", `funding source ${options.fundingProvider.sourceKind} does not satisfy policy ${required}`);
  }
}

function assertProviderNetwork(options: DirectModeClientOptions, network: string): void {
  if (network === "kaspa:mainnet") assertMainnetAllowed(network, options.allowMainnet, "DirectModeClient");
  if (options.fundingProvider.networkId !== network) {
    throw new KaspaX402Error("invalid_kaspa_x402_network", `funding provider network ${options.fundingProvider.networkId} does not match ${network}`);
  }
}

function supportedNetworksForClient(options: DirectModeClientOptions): readonly ("kaspa:mainnet" | "kaspa:testnet-10")[] {
  const networks = options.supportedNetworks ?? (options.allowMainnet ? ["kaspa:mainnet", "kaspa:testnet-10"] : ["kaspa:testnet-10"]);
  return options.allowMainnet ? networks : networks.filter((network) => network !== "kaspa:mainnet");
}

function supportedSchemesForClient(options: DirectModeClientOptions): readonly ("exact" | "batch-settlement")[] {
  if (options.supportedSchemes) return options.supportedSchemes;
  const schemes: ("exact" | "batch-settlement")[] = [];
  if (options.fundingProvider.payExact) schemes.push("exact");
  schemes.push("batch-settlement");
  return schemes;
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

function applyExactSettlement(payment: CreatePaymentResult, response: SettlementResponse): ApplySettlementResult {
  if (!response.success) {
    return {
      chargedAmount: "0",
      response,
    };
  }
  const payload = payment.paymentPayload.payload;
  const accepted = payment.accepted as ExactPaymentRequirements;
  if (payload.type !== "exact-transfer") {
    throw new KaspaX402Error("invalid_kaspa_payment_payload_type", "exact settlement does not correspond to an exact payment payload");
  }
  if (response.network !== accepted.network) {
    throw new KaspaX402Error("invalid_kaspa_settlement_response", "settlement response network does not match accepted requirement");
  }
  if (!/^[0-9a-fA-F]{64}$/.test(response.transaction)) {
    throw new KaspaX402Error("invalid_kaspa_transaction", "successful exact settlement must include a transaction id");
  }
  if (response.transaction.toLowerCase() !== payload.transactionId.toLowerCase()) {
    throw new KaspaX402Error("invalid_kaspa_transaction", "settlement transaction id does not match exact payment payload");
  }
  if (response.amount !== accepted.amount) {
    throw new KaspaX402Error("invalid_kaspa_settlement_response", "exact settlement amount does not match accepted requirement");
  }
  const responseExtra = readKaspaSettlementExtension(response);
  if (responseExtra?.paymentOutputIndex === undefined) {
    throw new KaspaX402Error("invalid_kaspa_outpoint", "exact settlement must include the payment output index");
  }
  if (responseExtra.paymentOutputIndex !== payload.paymentOutputIndex) {
    throw new KaspaX402Error("invalid_kaspa_outpoint", "settlement payment output index does not match exact payment payload");
  }
  const finality = readExactFinality(responseExtra.finality);
  const requiredFinality = readExactFinality(accepted.extra.finality);
  if (requiredFinality && (!finality || !exactFinalityMeets(finality, requiredFinality))) {
    throw new KaspaX402Error("invalid_kaspa_transaction", "exact settlement has not reached required finality");
  }
  if (payload.requestHash) {
    const responseRequestHash = responseExtra.requestHash;
    if (typeof responseRequestHash !== "string" || responseRequestHash.toLowerCase() !== payload.requestHash.toLowerCase()) {
      throw new KaspaX402Error("invalid_kaspa_settlement_response", "exact settlement request hash does not match payment payload");
    }
  }
  return {
    chargedAmount: response.amount,
    response,
    transactionId: response.transaction,
    finality,
  };
}

function exactFinalityMeets(actual: "mempool" | "accepted" | "confirmed", required: "mempool" | "accepted" | "confirmed"): boolean {
  const rank = { mempool: 0, accepted: 1, confirmed: 2 } as const;
  return rank[actual] >= rank[required];
}

function readExactFinality(value: unknown): "mempool" | "accepted" | "confirmed" | undefined {
  if (value === undefined) return undefined;
  if (value === "mempool" || value === "accepted" || value === "confirmed") return value;
  throw new KaspaX402Error("invalid_kaspa_transaction", "exact settlement finality is invalid");
}

function readExactPaymentFinality(value: unknown): "mempool" | "accepted" | "confirmed" {
  if (value === "mempool" || value === "accepted" || value === "confirmed") return value;
  if (value === "broadcast") {
    throw new KaspaX402Error("invalid_kaspa_transaction", "exact payment adapter must wait for observable finality");
  }
  throw new KaspaX402Error("invalid_kaspa_transaction", "exact payment adapter must return observable finality");
}

function paymentIdentifierExtensions(paymentRequired: CreatePaymentResult["paymentRequired"], context: PaymentRequestContext): PaymentPayload["extensions"] {
  const extension = paymentRequired.extensions?.["payment-identifier"];
  const info = isRecord(extension) ? extension.info : undefined;
  const schema = isRecord(extension) && isRecord(extension.schema) ? extension.schema : undefined;
  const required = isRecord(info) && info.required === true;
  if (required && !context.paymentIdentifier) {
    throw new KaspaX402Error("missing_kaspa_payment_identifier", "payment-identifier extension is required for this retry");
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

function channelMatchesRequirement(channel: DirectModeChannel, accepted: BatchPaymentRequirements, resourceUrl: string): boolean {
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
  const expectedCharged = addAmounts(channel.chargedCumulativeAmount, chargedAmount);
  if (state.chargedCumulativeAmount !== expectedCharged) {
    throw new KaspaX402Error("invalid_kaspa_settlement_response", "settlement charged cumulative amount does not match this request");
  }
  if (state.signedMaxClaimable !== expectedSignedAmount) {
    throw new KaspaX402Error("invalid_kaspa_settlement_response", "settlement signed ceiling does not match the submitted voucher");
  }
  validateChannelStateAccounting(channel, state);
  return channelWithState(channel, state);
}

function applyCorrectiveChannelState(channel: DirectModeChannel, state: ChannelState, voucher: Voucher): DirectModeChannel {
  validateChannelId(channel, state);
  const activeChanged = !sameActiveOutpoint(channel, state);
  validateChannelStateAccounting(channel, state, { allowSignedReset: activeChanged });
  if (parseSompiString(state.chargedCumulativeAmount) < parseSompiString(channel.chargedCumulativeAmount)) {
    throw new KaspaX402Error("invalid_kaspa_settlement_response", "corrective charged amount moved backward");
  }
  if (parseSompiString(state.claimedCumulativeAmount) < parseSompiString(channel.claimedCumulativeAmount)) {
    throw new KaspaX402Error("invalid_kaspa_settlement_response", "corrective claimed amount moved backward");
  }
  if (!activeChanged && parseSompiString(state.signedMaxClaimable) < parseSompiString(channel.signedCumulativeAmount)) {
    throw new KaspaX402Error("invalid_kaspa_settlement_response", "corrective signed ceiling moved backward");
  }
  return {
    ...channelWithState(channel, state),
    latestVoucher: voucher,
  };
}

function validateChannelStateIdentity(channel: DirectModeChannel, state: ChannelState): void {
  validateChannelId(channel, state);
  if (!sameActiveOutpoint(channel, state)) {
    throw new KaspaX402Error("invalid_kaspa_outpoint", "settlement active outpoint does not match local channel");
  }
}

function validateChannelId(channel: DirectModeChannel, state: ChannelState): void {
  if (state.channelId !== channel.id) {
    throw new KaspaX402Error("invalid_kaspa_channel_id", "settlement channel id does not match local channel");
  }
}

function sameActiveOutpoint(channel: DirectModeChannel, state: ChannelState): boolean {
  return (
    state.activeOutpoint.txid.toLowerCase() === channel.activeOutpoint.txid.toLowerCase() &&
    state.activeOutpoint.index === channel.activeOutpoint.index &&
    state.activeScriptPublicKey.toLowerCase() === channel.activeScriptPublicKey.toLowerCase()
  );
}

function validateChannelStateAccounting(channel: DirectModeChannel, state: ChannelState, options: { allowSignedReset?: boolean } = {}): void {
  if (state.fundingAmount !== channel.fundingAmount) {
    if (!options.allowSignedReset) {
      throw new KaspaX402Error("invalid_kaspa_settlement_response", "settlement funding amount does not match local channel");
    }
  }
  if (parseSompiString(state.claimedCumulativeAmount) > parseSompiString(state.chargedCumulativeAmount)) {
    throw new KaspaX402Error("invalid_kaspa_settlement_response", "claimed amount cannot exceed charged amount");
  }
  if (parseSompiString(state.claimedCumulativeAmount) < parseSompiString(channel.claimedCumulativeAmount)) {
    throw new KaspaX402Error("invalid_kaspa_settlement_response", "claimed amount moved backward");
  }
  const activeChargedAmount = parseSompiString(state.chargedCumulativeAmount) - parseSompiString(state.claimedCumulativeAmount);
  if (activeChargedAmount > parseSompiString(state.fundingAmount)) {
    throw new KaspaX402Error("invalid_kaspa_settlement_response", "active charged amount cannot exceed funding amount");
  }
  if (activeChargedAmount > parseSompiString(state.signedMaxClaimable)) {
    throw new KaspaX402Error("invalid_kaspa_settlement_response", "active charged amount cannot exceed signed ceiling");
  }
  if (parseSompiString(state.signedMaxClaimable) > parseSompiString(state.fundingAmount)) {
    throw new KaspaX402Error("invalid_kaspa_settlement_response", "signed ceiling cannot exceed active funding amount");
  }
  if (!options.allowSignedReset && parseSompiString(state.signedMaxClaimable) < parseSompiString(channel.signedCumulativeAmount)) {
    throw new KaspaX402Error("invalid_kaspa_settlement_response", "settlement signed ceiling moved backward");
  }
}

function channelWithState(channel: DirectModeChannel, state: ChannelState): DirectModeChannel {
  return {
    ...channel,
    activeOutpoint: state.activeOutpoint,
    activeScriptPublicKey: state.activeScriptPublicKey,
    fundingAmount: state.fundingAmount,
    chargedCumulativeAmount: state.chargedCumulativeAmount,
    claimedCumulativeAmount: state.claimedCumulativeAmount,
    signedCumulativeAmount: state.signedMaxClaimable,
  };
}

function correctiveChannelCandidate(channel: DirectModeChannel, state: ChannelState, voucher: Voucher): DirectModeChannel {
  return {
    ...channelWithState(channel, state),
    latestVoucher: voucher,
  };
}

function correctiveStateChanges(channel: DirectModeChannel, state: ChannelState): boolean {
  return (
    state.activeOutpoint.txid.toLowerCase() !== channel.activeOutpoint.txid.toLowerCase() ||
    state.activeOutpoint.index !== channel.activeOutpoint.index ||
    state.activeScriptPublicKey.toLowerCase() !== channel.activeScriptPublicKey.toLowerCase() ||
    state.fundingAmount !== channel.fundingAmount ||
    state.chargedCumulativeAmount !== channel.chargedCumulativeAmount ||
    state.claimedCumulativeAmount !== channel.claimedCumulativeAmount ||
    state.signedMaxClaimable !== channel.signedCumulativeAmount
  );
}

function readChargedAmount(response: SettlementResponse, accepted: BatchPaymentRequirements): SompiString {
  const responseExtra = readKaspaSettlementExtension(response);
  const amount = response.amount ?? responseExtra?.chargedAmount;
  if (amount === undefined) {
    throw new KaspaX402Error("invalid_kaspa_settlement_response", "settlement response must include the charged amount");
  }
  parseSompiString(amount);
  parseSompiString(accepted.amount);
  if (responseExtra?.chargedAmount !== undefined && responseExtra.chargedAmount !== amount) {
    throw new KaspaX402Error("invalid_kaspa_settlement_response", "settlement charged amount does not match extension metadata");
  }
  return amount;
}

function addAmounts(a: SompiString, b: SompiString): SompiString {
  return formatSompiString(parseSompiString(a) + parseSompiString(b));
}

function subtractAmounts(a: SompiString, b: SompiString): SompiString {
  const result = parseSompiString(a) - parseSompiString(b);
  if (result < 0n) {
    throw new KaspaX402Error("invalid_kaspa_x402_amount", "amount subtraction underflow");
  }
  return formatSompiString(result);
}

function activeClaimableAmount(channel: DirectModeChannel): SompiString {
  return subtractAmounts(channel.chargedCumulativeAmount, channel.claimedCumulativeAmount);
}

function paymentVoucherAmount(paymentPayload: PaymentPayload): SompiString {
  const payload = paymentPayload.payload;
  if (payload.type !== "deposit-voucher" && payload.type !== "voucher") {
    throw new KaspaX402Error("invalid_kaspa_payment_payload_type", "settlement response does not correspond to a voucher payment");
  }
  return payload.voucher.amount;
}

function maxAmount(a: SompiString, b: SompiString): SompiString {
  return parseSompiString(a) >= parseSompiString(b) ? a : b;
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

function contextWithRequestHash(context: PaymentRequestContext, accepted: PaymentRequirements): PaymentRequestContext {
  return {
    ...context,
    requestHash: context.requestHash ?? fingerprintHttpRequest(context.url, context, accepted),
  };
}

function fingerprintHttpRequest(input: string, init: Pick<PaymentRequestContext, "method" | "body">, accepted: PaymentRequirements): string {
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

function withHeader(headers: HeadersInitLike | undefined, name: string, value: string): Record<string, string> {
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
    throw new KaspaX402Error("invalid_kaspa_x402_payload", "no fetch adapter was provided");
  }
  return candidate as unknown as FetchLike;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasHeaderEntries(value: HeadersInitLike | undefined): value is { entries(): IterableIterator<[string, string]> } {
  return value !== undefined && typeof value === "object" && "entries" in value && typeof value.entries === "function";
}
