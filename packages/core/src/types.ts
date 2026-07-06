import type { X402_VERSION } from "./constants.js";

export type NetworkId = "kaspa:mainnet" | "kaspa:testnet-10";
export type SompiString = string;
export type Hash32Hex = string;
export type PublicKeyHex = string;
export type SignatureHex = string;
export type ByteHex = string;

export type PaymentScheme = "exact" | "batch-settlement";
export type KaspaBinding = "kaspa-exact-v1" | "kaspa-escrow-v1";

export type JsonRecord = Record<string, unknown>;

export interface ResourceInfo extends JsonRecord {
  url: string;
  description?: string;
  mimeType?: string;
}

export interface BasePaymentRequirements<TScheme extends PaymentScheme, TExtra extends JsonRecord> extends JsonRecord {
  scheme: TScheme;
  network: NetworkId;
  amount: SompiString;
  asset: "KAS";
  payTo: string;
  maxTimeoutSeconds: number;
  extra: TExtra;
}

export interface ExactRequirementsExtra extends JsonRecord {
  binding: "kaspa-exact-v1";
  finality?: "mempool" | "accepted" | "confirmed";
  assetKind?: "native";
  assetDecimals?: 8;
}

export interface ClaimPolicy extends JsonRecord {
  claimWhenUnclaimedAmountExceeds?: SompiString;
  claimAfterSeconds?: number;
}

export interface BatchRequirementsExtra extends JsonRecord {
  binding: "kaspa-escrow-v1";
  templateId: "kaspa-x402-escrow-v1";
  serverPublicKey: PublicKeyHex;
  minDepositSompi: SompiString;
  refundTimeoutDaa: SompiString;
  claimPolicy?: ClaimPolicy;
  channelState?: ChannelState;
  voucherState?: Voucher;
  assetKind?: "native";
  assetDecimals?: 8;
}

export type ExactPaymentRequirements = BasePaymentRequirements<"exact", ExactRequirementsExtra>;
export type BatchPaymentRequirements = BasePaymentRequirements<"batch-settlement", BatchRequirementsExtra>;
export type KaspaRequirementsExtra = ExactRequirementsExtra | BatchRequirementsExtra;
export type PaymentRequirements = ExactPaymentRequirements | BatchPaymentRequirements;

export interface PaymentRequired extends JsonRecord {
  x402Version: typeof X402_VERSION;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  error?: string;
  extensions?: PaymentExtensions;
}

export interface PaymentRequiredEnvelope extends JsonRecord {
  x402Version: typeof X402_VERSION;
  resource: ResourceInfo;
  accepts: JsonRecord[];
  error?: string;
  extensions?: JsonRecord;
}

export interface PaymentPayload extends JsonRecord {
  x402Version: typeof X402_VERSION;
  accepted: PaymentRequirements;
  payload: KaspaPaymentPayload;
  extensions?: PaymentExtensions;
}

export interface FundingOutpoint {
  txid: Hash32Hex;
  index: number;
}

export interface Voucher extends JsonRecord {
  amount: SompiString;
  signature: SignatureHex;
}

export interface ChannelConfig extends JsonRecord {
  network: NetworkId;
  asset: "KAS";
  templateId: "kaspa-x402-escrow-v1";
  clientPublicKey: PublicKeyHex;
  serverPublicKey: PublicKeyHex;
  payTo: string;
  refundAddress: string;
  refundTimeoutDaa: SompiString;
  salt: Hash32Hex;
}

export interface ChannelState extends JsonRecord {
  channelId: Hash32Hex;
  activeOutpoint: FundingOutpoint;
  activeScriptPublicKey: ByteHex;
  fundingAmount: SompiString;
  chargedCumulativeAmount: SompiString;
  claimedCumulativeAmount: SompiString;
  signedMaxClaimable: SompiString;
}

export interface ExactTransferPayload extends JsonRecord {
  type: "exact-transfer";
  payerAddress?: string;
  transactionId: Hash32Hex;
  paymentOutputIndex: number;
  requestHash?: Hash32Hex;
}

export interface DepositVoucherPayload extends JsonRecord {
  type: "deposit-voucher";
  channelConfig: ChannelConfig;
  channelId: Hash32Hex;
  escrowAddress: string;
  fundingOutpoint: FundingOutpoint;
  fundingAmountSompi: SompiString;
  fundingTransaction?: ByteHex;
  activeScriptPublicKey: ByteHex;
  voucher: Voucher;
}

export interface VoucherPayload extends JsonRecord {
  type: "voucher";
  channelId: Hash32Hex;
  clientPublicKey: PublicKeyHex;
  fundingOutpoint: FundingOutpoint;
  activeScriptPublicKey: ByteHex;
  voucher: Voucher;
}

export interface ClaimPayload extends JsonRecord {
  type: "claim";
  channelId: Hash32Hex;
  fundingOutpoint: FundingOutpoint;
  activeScriptPublicKey: ByteHex;
  claimAmount: SompiString;
  voucher: Voucher;
}

export interface RefundPayload extends JsonRecord {
  type: "refund";
  channelId: Hash32Hex;
  fundingOutpoint: FundingOutpoint;
  activeScriptPublicKey: ByteHex;
  refundAddress: string;
  refundAmount: SompiString;
  clientSignature: SignatureHex;
}

export type KaspaPaymentPayload =
  | ExactTransferPayload
  | DepositVoucherPayload
  | VoucherPayload
  | ClaimPayload
  | RefundPayload;

export interface SettlementResponseExtra extends JsonRecord {
  commitmentId?: Hash32Hex;
  chargedAmount?: SompiString;
  fundingAmount?: SompiString;
  paymentOutputIndex?: number;
  finality?: "mempool" | "accepted" | "confirmed";
  requestHash?: Hash32Hex;
  channelState?: ChannelState;
  channelId?: Hash32Hex;
  claimOutpoint?: FundingOutpoint;
  continuationOutpoint?: FundingOutpoint;
  refundAddress?: string;
}

export interface SettlementResponse extends JsonRecord {
  success: boolean;
  errorReason?: string;
  transaction: string;
  network?: NetworkId;
  payer?: string;
  amount?: SompiString;
  extra?: SettlementResponseExtra;
  extensions?: SettlementResponseExtensions;
}

export interface PaymentIdentifierInfo extends JsonRecord {
  required: boolean;
  id?: string;
}

export interface PaymentExtension<TInfo extends JsonRecord> extends JsonRecord {
  info: TInfo;
  schema: JsonRecord;
}

export type PaymentIdentifierExtension = PaymentExtension<PaymentIdentifierInfo>;

export type PaymentExtensions = JsonRecord & {
  "payment-identifier"?: PaymentIdentifierExtension;
};

export type SettlementResponseExtensions = JsonRecord & {
  kaspa?: SettlementResponseExtra;
};

export interface PaymentIdentifierObservation {
  extensionInfo: PaymentIdentifierInfo;
  requestHash: Hash32Hex;
}
