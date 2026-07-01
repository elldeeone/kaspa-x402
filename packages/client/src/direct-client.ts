import {
  X402_VERSION,
  channelId,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  formatSompiString,
  hexToBytes,
  parseSompiString,
  sha256Hex,
  validatePaymentRetry,
  voucherDigest,
  voucherPreimageHex,
  type BatchPaymentRequirements,
  type ChannelConfig,
  type ChannelState,
  type FundingOutpoint,
  type PaymentPayload,
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
    this.#options = options;
  }

  async createPayment(header: string, context: PaymentRequestContext): Promise<CreatePaymentResult> {
    assertFundingPolicy(this.#options);
    const parsed = parsePaymentRequiredHeaderValue(header, { supportedNetworks: this.#options.supportedNetworks });
    assertProviderNetwork(this.#options, parsed.accepted.network);
    const origin = context.origin ?? originForUrl(context.url);
    const resourceUrl = parsed.paymentRequired.resource.url;
    const existing = await this.#selectExistingChannel(parsed.accepted, origin, resourceUrl);

    if (existing) {
      const { channel, paymentPayload } = await this.#buildVoucherPayload(existing, parsed.accepted, parsed.paymentRequired, context);
      return {
        paymentRequired: parsed.paymentRequired,
        accepted: parsed.accepted,
        paymentPayload,
        channel,
        openedChannel: false,
      };
    }

    const { channel, paymentPayload } = await this.#openDepositVoucherChannel(parsed.accepted, parsed.paymentRequired, context, origin);
    return {
      paymentRequired: parsed.paymentRequired,
      accepted: parsed.accepted,
      paymentPayload,
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
      if (response.extra?.channelId !== undefined && response.extra.channelId !== payment.channel.id) {
        throw new KaspaX402Error("invalid_kaspa_channel_id", "settlement response channel id does not match local channel");
      }

      const chargedAmount = readChargedAmount(response, payment.accepted);
      if (parseSompiString(chargedAmount) > parseSompiString(payment.accepted.amount)) {
        throw new KaspaX402Error("invalid_kaspa_settlement_response", "charged amount exceeds accepted amount");
      }
      if (payment.paymentPayload.payload.type === "deposit-voucher" && response.extra?.fundingAmount !== payment.channel.fundingAmount) {
        throw new KaspaX402Error("invalid_kaspa_settlement_response", "deposit settlement funding amount does not match local channel");
      }

      if (!response.extra?.commitmentId) {
        throw new KaspaX402Error("invalid_kaspa_settlement_response", "successful voucher settlement must include a commitment id");
      }
      const channelState = response.extra?.channelState;
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
      activeScriptPublicKey,
      voucher,
    });

    const retryValidation = validatePaymentRetry({ paymentRequired, paymentPayload });
    if (!retryValidation.ok) throw retryValidation.error;
    await this.#options.store.saveChannel(signedChannel);
    return { channel: signedChannel, paymentPayload };
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
  if (options.fundingProvider.networkId !== network) {
    throw new KaspaX402Error("invalid_kaspa_x402_network", `funding provider network ${options.fundingProvider.networkId} does not match ${network}`);
  }
}

function buildPaymentPayload(
  paymentRequired: CreatePaymentResult["paymentRequired"],
  accepted: BatchPaymentRequirements,
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

function paymentIdentifierExtensions(paymentRequired: CreatePaymentResult["paymentRequired"], context: PaymentRequestContext): PaymentPayload["extensions"] {
  const extension = paymentRequired.extensions?.["payment-identifier"];
  const info = isRecord(extension) ? extension.info : undefined;
  const required = isRecord(info) && info.required === true;
  if (required && !context.paymentIdentifier) {
    throw new KaspaX402Error("missing_kaspa_payment_identifier", "payment-identifier extension is required for this retry");
  }
  if (!context.paymentIdentifier) return undefined;
  return {
    "payment-identifier": {
      info: {
        required,
        id: context.paymentIdentifier,
      },
    },
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
  const amount = response.extra?.chargedAmount;
  if (amount === undefined) {
    throw new KaspaX402Error("invalid_kaspa_settlement_response", "settlement response must include the charged amount");
  }
  parseSompiString(amount);
  parseSompiString(accepted.amount);
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
