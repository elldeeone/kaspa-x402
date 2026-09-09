import type { X402_VERSION } from "./constants.js";

export type NetworkId = "kaspa:mainnet" | "kaspa:testnet-10";
export type SompiString = string;
export type Hash32Hex = string;
export type PublicKeyHex = string;
export type SignatureHex = string;
export type ByteHex = string;

export type PaymentScheme = "exact" | "batch-settlement";
export type KaspaBinding = "kaspa-exact-v2" | "kaspa-escrow-v3";
export type ExactTransactionEncoding = "kaspa-sdk-safe-json-v2.0.0";
export type ExactAdditiveTemplateId = "kaspa-x402-kip10-additive-v1";
export type ExactProfile = "standard-native" | "additive";

export interface ExactRequestAuthorization extends JsonRecord {
  version: "kaspa-x402-exact-request-authorization-v1";
  inputIndex: number;
  expiresAt: string;
  digest: Hash32Hex;
  signature: SignatureHex;
}

export type JsonRecord = Record<string, unknown>;

export interface ResourceInfo extends JsonRecord {
  url: string;
  description?: string;
  mimeType?: string;
}

export interface BasePaymentRequirements<
  TScheme extends PaymentScheme,
  TExtra extends JsonRecord,
> extends JsonRecord {
  scheme: TScheme;
  network: NetworkId;
  amount: SompiString;
  asset: "KAS";
  payTo: string;
  maxTimeoutSeconds: number;
  extra: TExtra;
}

export interface ExactRequirementsExtra extends JsonRecord {
  binding: "kaspa-exact-v2";
  profile: ExactProfile;
  finality?: "mempool" | "accepted" | "confirmed";
  payToScriptPublicKey?: ByteHex;
  templateId?: ExactAdditiveTemplateId;
  transactionEncoding?: ExactTransactionEncoding;
  headId?: Hash32Hex;
  headVersion?: SompiString;
  expectedHeadOutpoint?: FundingOutpoint;
  headAmount?: SompiString;
  headScriptPublicKey?: ByteHex;
  headRedeemScript?: ByteHex;
  challengeId?: Hash32Hex;
  challengeExpiresAt?: string;
  additiveThresholdSompi?: SompiString;
  paymentOutputIndex?: number;
  assetKind?: "native";
  assetDecimals?: 8;
}

export interface ClaimPolicy extends JsonRecord {
  claimWhenUnclaimedAmountExceeds?: SompiString;
  claimAfterSeconds?: number;
}

export interface BatchRequirementsExtra extends JsonRecord {
  binding: "kaspa-escrow-v3";
  templateId: "kaspa-x402-escrow-v4";
  serverPublicKey: PublicKeyHex;
  minDepositSompi: SompiString;
  claimReserveSompi: SompiString;
  refundTimeoutDaa: SompiString;
  securityContextHash: Hash32Hex;
  mcpErrorChargeSompi?: SompiString;
  claimPolicy?: ClaimPolicy;
  channelState?: ChannelState;
  assetKind?: "native";
  assetDecimals?: 8;
}

export type ExactPaymentRequirements = BasePaymentRequirements<
  "exact",
  ExactRequirementsExtra
>;
export type BatchPaymentRequirements = BasePaymentRequirements<
  "batch-settlement",
  BatchRequirementsExtra
>;
export type KaspaRequirementsExtra =
  ExactRequirementsExtra | BatchRequirementsExtra;
export type PaymentRequirements =
  ExactPaymentRequirements | BatchPaymentRequirements;

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
  /** Stable KIP-20 covenant lineage authorized by this voucher. */
  covenantId: Hash32Hex;
  /** Exact lifetime cumulative fixed charges authorized for this lineage. */
  authorizedCumulativeAmount: SompiString;
  signature: SignatureHex;
}

export interface BatchPresentationAuthorization extends JsonRecord {
  version: "kaspa-x402-batch-presentation-v1";
  requestFingerprint: Hash32Hex;
  acceptedRequirementsHash: Hash32Hex;
  securityContextHash: Hash32Hex;
  channelId: Hash32Hex;
  covenantId: Hash32Hex;
  voucherDigest: Hash32Hex;
  paymentIdentifier: string | null;
  nonce: Hash32Hex;
  expiresAt: string;
  digest: Hash32Hex;
  signature: SignatureHex;
}

export type BatchPaymentOperation = "open" | "charge" | "top-up";

export interface BatchPaymentAuthorizationIntent extends JsonRecord {
  scope: "kaspa:x402:batch-payment-intent:v1";
  operation: BatchPaymentOperation;
  origin: string;
  resource: string;
  network: "kaspa:testnet-10";
  asset: "KAS";
  payTo: string;
  serverPublicKey: PublicKeyHex;
  clientPublicKey: PublicKeyHex | null;
  requestFingerprint: Hash32Hex;
  acceptedRequirementsHash: Hash32Hex;
  securityContextHash: Hash32Hex;
  fixedChargeSompi: SompiString;
  mcpErrorChargeSompi: SompiString | null;
  authorizedCumulativeBefore: SompiString;
  authorizedCumulativeAfter: SompiString;
  claimedCumulativeAmount: SompiString;
  initialDepositSompi: SompiString;
  currentFundingSompi: SompiString;
  topUpSompi: SompiString;
  resultingFundingSompi: SompiString;
  resultingExposureSompi: SompiString;
  claimReserveSompi: SompiString;
  refundTimeoutDaa: SompiString;
  authoritativeCurrentDaa: SompiString;
  refundDistanceDaa: SompiString;
  fundingSource: string;
  channelId: Hash32Hex | null;
  covenantId: Hash32Hex | null;
  paymentIdentifier: string | null;
}

export interface BatchPaymentAuthorizationPolicy {
  maximumBatchChargeSompi: SompiString;
  maximumInitialDepositSompi: SompiString;
  maximumTopUpSompi: SompiString;
  maximumCumulativeAuthorizationSompi: SompiString;
  maximumTotalExposureSompi: SompiString;
  minimumRefundLeadDaa: SompiString;
  maximumRefundHorizonDaa: SompiString;
  allowedOrigins: readonly string[];
  allowedResources: readonly string[];
  allowedPayTo: readonly string[];
  allowedServerPublicKeys: readonly PublicKeyHex[];
  allowedFundingSources: readonly string[];
}

export interface ChannelConfig extends JsonRecord {
  network: NetworkId;
  asset: "KAS";
  templateId: "kaspa-x402-escrow-v4";
  clientPublicKey: PublicKeyHex;
  serverPublicKey: PublicKeyHex;
  payTo: string;
  refundAddress: string;
  refundTimeoutDaa: SompiString;
  salt: Hash32Hex;
}

export interface ChannelState extends JsonRecord {
  channelId: Hash32Hex;
  /** Stable KIP-20 covenant lineage. This does not locate the current UTXO. */
  covenantId: Hash32Hex;
  activeOutpoint: FundingOutpoint;
  activeScriptPublicKey: ByteHex;
  fundingAmount: SompiString;
  /** Exact lifetime cumulative fixed charges authorized by the payer. */
  authorizedCumulativeAmount: SompiString;
  /** On-chain lifetime gross amount removed from escrow, including claim fees. */
  claimedCumulativeAmount: SompiString;
}

export interface ExactTransactionPayload extends JsonRecord {
  type: "exact-transaction";
  profile?: ExactProfile;
  challengeId?: Hash32Hex;
  payerAddress?: string;
  transaction: string;
  transactionEncoding: ExactTransactionEncoding;
  paymentOutputIndex: number;
  requestHash: Hash32Hex;
  authorization: ExactRequestAuthorization;
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
  presentation: BatchPresentationAuthorization;
}

export interface VoucherPayload extends JsonRecord {
  type: "voucher";
  channelId: Hash32Hex;
  clientPublicKey: PublicKeyHex;
  fundingOutpoint: FundingOutpoint;
  activeScriptPublicKey: ByteHex;
  voucher: Voucher;
  presentation: BatchPresentationAuthorization;
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
  covenantId: Hash32Hex;
  fundingOutpoint: FundingOutpoint;
  activeScriptPublicKey: ByteHex;
  refundAddress: string;
  refundAmount: SompiString;
  clientSignature: SignatureHex;
}

export type KaspaPaymentPayload =
  | ExactTransactionPayload
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
  transactionEncoding?: ExactTransactionEncoding;
  exactProfile?: ExactProfile;
  templateId?: ExactAdditiveTemplateId;
  headId?: Hash32Hex;
  headVersion?: SompiString;
  headOutpoint?: FundingOutpoint;
  channelState?: ChannelState;
  channelId?: Hash32Hex;
  covenantId?: Hash32Hex;
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

export type PaymentIdentifierExtension =
  PaymentExtension<PaymentIdentifierInfo>;

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
