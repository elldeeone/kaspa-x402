import { hexToBytes, sha256Hex } from "./binary.js";
import { KaspaX402Error } from "./errors.js";
import { assertJsonResourceBudget } from "./resource-budget.js";
import { validatePaymentPayload } from "./schema-validation.js";
import { stableStringify } from "./stable-json.js";
import type {
  BatchPresentationAuthorization,
  ChannelConfig,
  ChannelState,
  FundingOutpoint,
  Hash32Hex,
  JsonRecord,
  PaymentPayload,
  PaymentRequirements,
  Voucher,
} from "./types.js";

export function canonicalPaymentReplayProjection(
  input: PaymentPayload,
): JsonRecord {
  const validation = validatePaymentPayload(input);
  if (!validation.ok) throw validation.error;
  const paymentPayload = normalizePaymentPayloadHex(validation.value);
  const payload = paymentPayload.payload;
  const common = {
    version: "kaspa-x402-payment-replay-v1",
    scheme: paymentPayload.accepted.scheme,
    network: paymentPayload.accepted.network,
    acceptedRequirementsHash: sha256Hex(
      stableStringify(paymentPayload.accepted),
    ),
  };

  switch (payload.type) {
    case "exact-transaction":
      return {
        ...common,
        payloadType: payload.type,
        profile: payload.profile ?? null,
        challengeId: payload.challengeId ?? null,
        transactionIdentityHash: exactTransactionReplayIdentityHash(
          payload.transaction,
        ),
        transactionEncoding: payload.transactionEncoding,
        paymentOutputIndex: payload.paymentOutputIndex,
        requestHash: payload.requestHash,
        authorization: {
          version: payload.authorization.version,
          inputIndex: payload.authorization.inputIndex,
          expiresAt: payload.authorization.expiresAt,
          digest: payload.authorization.digest,
          signature: payload.authorization.signature,
        },
      };
    case "deposit-voucher":
      return {
        ...common,
        payloadType: payload.type,
        channelConfig: knownChannelConfig(payload.channelConfig),
        channelId: payload.channelId,
        escrowAddress: payload.escrowAddress,
        fundingOutpoint: knownOutpoint(payload.fundingOutpoint),
        fundingAmountSompi: payload.fundingAmountSompi,
        fundingTransactionHash: payload.fundingTransaction
          ? sha256Hex(hexToBytes(payload.fundingTransaction))
          : null,
        activeScriptPublicKey: payload.activeScriptPublicKey,
        voucher: knownVoucher(payload.voucher),
        presentation: knownPresentation(payload.presentation),
      };
    case "voucher":
      return {
        ...common,
        payloadType: payload.type,
        channelId: payload.channelId,
        clientPublicKey: payload.clientPublicKey,
        fundingOutpoint: knownOutpoint(payload.fundingOutpoint),
        activeScriptPublicKey: payload.activeScriptPublicKey,
        voucher: knownVoucher(payload.voucher),
        presentation: knownPresentation(payload.presentation),
      };
    case "claim":
      return {
        ...common,
        payloadType: payload.type,
        channelId: payload.channelId,
        fundingOutpoint: knownOutpoint(payload.fundingOutpoint),
        activeScriptPublicKey: payload.activeScriptPublicKey,
        claimAmount: payload.claimAmount,
        voucher: knownVoucher(payload.voucher),
      };
    case "refund":
      return {
        ...common,
        payloadType: payload.type,
        channelId: payload.channelId,
        covenantId: payload.covenantId,
        fundingOutpoint: knownOutpoint(payload.fundingOutpoint),
        activeScriptPublicKey: payload.activeScriptPublicKey,
        refundAddress: payload.refundAddress,
        refundAmount: payload.refundAmount,
        clientSignature: payload.clientSignature,
      };
    default:
      throw new KaspaX402Error(
        "invalid_kaspa_payment_payload_type",
        "unsupported payment replay payload type",
      );
  }
}

export function paymentReplayIdentityHash(
  paymentPayload: PaymentPayload,
): Hash32Hex {
  return sha256Hex(
    stableStringify(canonicalPaymentReplayProjection(paymentPayload)),
  );
}

/**
 * Normalizes only schema-known hexadecimal fields. Unknown extension values
 * remain untouched and are excluded from replay identity.
 */
export function normalizePaymentPayloadHex(
  paymentPayload: PaymentPayload,
): PaymentPayload {
  const accepted = normalizePaymentRequirementsHex(paymentPayload.accepted);
  const payload = paymentPayload.payload;
  switch (payload.type) {
    case "exact-transaction":
      return {
        ...paymentPayload,
        accepted,
        payload: {
          ...payload,
          ...(payload.challengeId
            ? { challengeId: payload.challengeId.toLowerCase() }
            : {}),
          requestHash: payload.requestHash.toLowerCase(),
          authorization: {
            ...payload.authorization,
            digest: payload.authorization.digest.toLowerCase(),
            signature: payload.authorization.signature.toLowerCase(),
          },
        },
      };
    case "deposit-voucher":
      return {
        ...paymentPayload,
        accepted,
        payload: {
          ...payload,
          channelConfig: normalizeChannelConfig(payload.channelConfig),
          channelId: payload.channelId.toLowerCase(),
          fundingOutpoint: normalizeOutpoint(payload.fundingOutpoint),
          ...(payload.fundingTransaction
            ? { fundingTransaction: payload.fundingTransaction.toLowerCase() }
            : {}),
          activeScriptPublicKey: payload.activeScriptPublicKey.toLowerCase(),
          voucher: normalizeVoucher(payload.voucher),
          presentation: normalizePresentation(payload.presentation),
        },
      };
    case "voucher":
      return {
        ...paymentPayload,
        accepted,
        payload: {
          ...payload,
          channelId: payload.channelId.toLowerCase(),
          clientPublicKey: payload.clientPublicKey.toLowerCase(),
          fundingOutpoint: normalizeOutpoint(payload.fundingOutpoint),
          activeScriptPublicKey: payload.activeScriptPublicKey.toLowerCase(),
          voucher: normalizeVoucher(payload.voucher),
          presentation: normalizePresentation(payload.presentation),
        },
      };
    case "claim":
      return {
        ...paymentPayload,
        accepted,
        payload: {
          ...payload,
          channelId: payload.channelId.toLowerCase(),
          fundingOutpoint: normalizeOutpoint(payload.fundingOutpoint),
          activeScriptPublicKey: payload.activeScriptPublicKey.toLowerCase(),
          voucher: normalizeVoucher(payload.voucher),
        },
      };
    case "refund":
      return {
        ...paymentPayload,
        accepted,
        payload: {
          ...payload,
          channelId: payload.channelId.toLowerCase(),
          covenantId: payload.covenantId.toLowerCase(),
          fundingOutpoint: normalizeOutpoint(payload.fundingOutpoint),
          activeScriptPublicKey: payload.activeScriptPublicKey.toLowerCase(),
          clientSignature: payload.clientSignature.toLowerCase(),
        },
      };
  }
}

export function normalizePaymentRequirementsHex(
  accepted: PaymentRequirements,
): PaymentRequirements {
  if (accepted.scheme === "exact") {
    const extra = accepted.extra;
    return {
      ...accepted,
      extra: {
        ...extra,
        ...(extra.payToScriptPublicKey
          ? { payToScriptPublicKey: extra.payToScriptPublicKey.toLowerCase() }
          : {}),
        ...(extra.headId ? { headId: extra.headId.toLowerCase() } : {}),
        ...(extra.expectedHeadOutpoint
          ? {
              expectedHeadOutpoint: normalizeOutpoint(
                extra.expectedHeadOutpoint,
              ),
            }
          : {}),
        ...(extra.headScriptPublicKey
          ? { headScriptPublicKey: extra.headScriptPublicKey.toLowerCase() }
          : {}),
        ...(extra.headRedeemScript
          ? { headRedeemScript: extra.headRedeemScript.toLowerCase() }
          : {}),
        ...(extra.challengeId
          ? { challengeId: extra.challengeId.toLowerCase() }
          : {}),
      },
    };
  }
  const extra = accepted.extra;
  return {
    ...accepted,
    extra: {
      ...extra,
      serverPublicKey: extra.serverPublicKey.toLowerCase(),
      securityContextHash: extra.securityContextHash.toLowerCase(),
      ...(extra.channelState
        ? { channelState: normalizeChannelState(extra.channelState) }
        : {}),
    },
  };
}

function normalizeOutpoint(outpoint: FundingOutpoint): FundingOutpoint {
  return { ...outpoint, txid: outpoint.txid.toLowerCase() };
}

function normalizeVoucher(voucher: Voucher): Voucher {
  return {
    ...voucher,
    covenantId: voucher.covenantId.toLowerCase(),
    signature: voucher.signature.toLowerCase(),
  };
}

function normalizePresentation(
  presentation: BatchPresentationAuthorization,
): BatchPresentationAuthorization {
  return {
    ...presentation,
    requestFingerprint: presentation.requestFingerprint.toLowerCase(),
    acceptedRequirementsHash:
      presentation.acceptedRequirementsHash.toLowerCase(),
    securityContextHash: presentation.securityContextHash.toLowerCase(),
    channelId: presentation.channelId.toLowerCase(),
    covenantId: presentation.covenantId.toLowerCase(),
    voucherDigest: presentation.voucherDigest.toLowerCase(),
    nonce: presentation.nonce.toLowerCase(),
    digest: presentation.digest.toLowerCase(),
    signature: presentation.signature.toLowerCase(),
  };
}

function normalizeChannelConfig(config: ChannelConfig): ChannelConfig {
  return {
    ...config,
    clientPublicKey: config.clientPublicKey.toLowerCase(),
    serverPublicKey: config.serverPublicKey.toLowerCase(),
    salt: config.salt.toLowerCase(),
  };
}

function normalizeChannelState(state: ChannelState): ChannelState {
  return {
    ...state,
    channelId: state.channelId.toLowerCase(),
    covenantId: state.covenantId.toLowerCase(),
    activeOutpoint: normalizeOutpoint(state.activeOutpoint),
    activeScriptPublicKey: state.activeScriptPublicKey.toLowerCase(),
  };
}

function knownOutpoint(outpoint: FundingOutpoint): JsonRecord {
  return { txid: outpoint.txid, index: outpoint.index };
}

function knownVoucher(voucher: Voucher): JsonRecord {
  return {
    covenantId: voucher.covenantId,
    authorizedCumulativeAmount: voucher.authorizedCumulativeAmount,
    signature: voucher.signature,
  };
}

function knownPresentation(
  presentation: BatchPresentationAuthorization,
): JsonRecord {
  return {
    version: presentation.version,
    requestFingerprint: presentation.requestFingerprint,
    acceptedRequirementsHash: presentation.acceptedRequirementsHash,
    securityContextHash: presentation.securityContextHash,
    channelId: presentation.channelId,
    covenantId: presentation.covenantId,
    voucherDigest: presentation.voucherDigest,
    nonce: presentation.nonce,
    expiresAt: presentation.expiresAt,
    digest: presentation.digest,
    signature: presentation.signature,
  };
}

function knownChannelConfig(config: ChannelConfig): JsonRecord {
  return {
    network: config.network,
    asset: config.asset,
    templateId: config.templateId,
    clientPublicKey: config.clientPublicKey,
    serverPublicKey: config.serverPublicKey,
    payTo: config.payTo,
    refundAddress: config.refundAddress,
    refundTimeoutDaa: config.refundTimeoutDaa,
    salt: config.salt,
  };
}

export function exactTransactionReplayIdentityHash(
  transaction: string,
): Hash32Hex {
  assertJsonResourceBudget(
    { transaction },
    { label: "exact transaction artifact" },
  );
  try {
    const value = JSON.parse(transaction) as unknown;
    assertJsonResourceBudget(value, {
      label: "exact transaction artifact",
    });
    return sha256Hex(
      stableStringify({
        scope: "kaspa:x402:exact-consensus-transaction-projection:v1",
        transaction: exactTransactionProjection(value),
      }),
    );
  } catch (error) {
    if (error instanceof KaspaX402Error) throw error;
    return sha256Hex(
      stableStringify({
        scope: "kaspa:x402:opaque-exact-transaction-artifact:v1",
        artifactHash: sha256Hex(transaction),
      }),
    );
  }
}

function exactTransactionProjection(value: unknown): JsonRecord {
  const transaction = requiredRecord(value, "transaction");
  const version = uint32(transaction.version, "transaction version");
  if (version !== 0 && version !== 1)
    throw new Error("unsupported exact transaction version");
  const inputs = requiredArray(transaction.inputs, "transaction inputs");
  const outputs = requiredArray(transaction.outputs, "transaction outputs");
  if (inputs.length === 0 || outputs.length === 0)
    throw new Error("exact transaction inputs and outputs must be non-empty");
  return {
    version,
    inputs: inputs.map((input, index) => {
      const record = requiredRecord(input, `transaction input ${index}`);
      const outpoint = requiredRecord(
        record.previousOutpoint,
        `transaction input ${index} outpoint`,
      );
      return {
        previousOutpoint: {
          transactionId: exactHex(
            outpoint.transactionId,
            `transaction input ${index} transaction id`,
            64,
          ),
          index: uint32(
            outpoint.index,
            `transaction input ${index} outpoint index`,
          ),
        },
        sequence: uintString(
          record.sequence,
          `transaction input ${index} sequence`,
        ),
      };
    }),
    outputs: outputs.map((output, index) => {
      const record = requiredRecord(output, `transaction output ${index}`);
      if (record.covenant !== null)
        throw new Error(`transaction output ${index} covenant must be null`);
      return {
        value: uintString(record.value, `transaction output ${index} value`),
        scriptPublicKey: exactHex(
          record.scriptPublicKey,
          `transaction output ${index} script public key`,
        ),
        covenant: null,
      };
    }),
    lockTime: uintString(
      transaction.lockTime ?? "0",
      "transaction lock time",
    ),
    subnetworkId: exactHex(
      transaction.subnetworkId ?? "00".repeat(20),
      "transaction subnetwork id",
      40,
    ),
    gas: uintString(transaction.gas ?? "0", "transaction gas"),
    payload: exactHex(
      transaction.payload ?? "",
      "transaction payload",
      undefined,
      true,
    ),
  };
}

function requiredRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requiredArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function uint32(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 0xffff_ffff
  ) {
    throw new Error(`${label} must be a uint32`);
  }
  return value;
}

function uintString(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value))
    throw new Error(`${label} must be a canonical unsigned decimal string`);
  return value;
}

function exactHex(
  value: unknown,
  label: string,
  length?: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length % 2 !== 0 ||
    !/^[0-9a-fA-F]*$/.test(value) ||
    (length !== undefined && value.length !== length)
  ) {
    throw new Error(`${label} must be canonical byte hex`);
  }
  return value.toLowerCase();
}
