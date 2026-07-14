import type {
  BatchPaymentRequirements,
  ByteHex,
  ChannelConfig,
  ExactPaymentRequirements,
  ExactProfile,
  ExactTransactionEncoding,
  FundingOutpoint,
  Hash32Hex,
  NetworkId,
  PaymentPayload,
  PaymentRequirements,
  PaymentRequired,
  PaymentScheme,
  PublicKeyHex,
  SettlementResponse,
  SignatureHex,
  SompiString,
  Voucher,
} from "@kaspa-x402/core";
import type { DeriveEscrowAddressInput } from "@kaspa-x402/covenant";

export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

export type FundingSourceKind = "hot-wallet" | "vault-treasury" | "external-wallet-adapter";
export type ChannelStatus = "active" | "retired" | "refundable" | "refunded" | "suspicious";

export interface PublicIdentity {
  address: string;
  publicKey?: PublicKeyHex;
}

export interface FundingProviderUtxo {
  outpoint: FundingOutpoint;
  amount: SompiString;
  scriptPublicKey: ByteHex;
  address?: string;
}

export interface EscrowDepositRequest {
  network: NetworkId;
  channelId: Hash32Hex;
  channelConfig: ChannelConfig;
  escrowAddress: string;
  escrowScriptPublicKey: ByteHex;
  amount: SompiString;
  fundingSource?: FundingSourceKind;
}

export interface EscrowDepositResult {
  outpoint?: FundingOutpoint;
  txid?: Hash32Hex;
  index?: number;
  amount?: SompiString;
  fundingSource?: FundingSourceKind;
  transaction?: ByteHex;
}

export interface ExactPaymentRequest {
  network: NetworkId;
  profile: ExactProfile;
  amount: SompiString;
  payTo: string;
  payToScriptPublicKey?: ByteHex;
  paymentOutputIndex?: number;
  requestHash?: Hash32Hex;
  requiredFinality?: "mempool" | "accepted" | "confirmed";
  fundingSource?: FundingSourceKind;
  head?: {
    headId: Hash32Hex;
    headVersion: SompiString;
    expectedHeadOutpoint: FundingOutpoint;
    headAmount: SompiString;
    headScriptPublicKey: ByteHex;
    headRedeemScript: ByteHex;
    additiveThresholdSompi: SompiString;
    challengeId: Hash32Hex;
    challengeExpiresAt: string;
  };
  reservation?: Pick<
    ExactPaymentRequirements["extra"],
    | "templateId"
    | "transactionEncoding"
    | "borrowOutpoint"
    | "borrowAmount"
    | "borrowScriptPublicKey"
    | "borrowRedeemScript"
    | "additiveThresholdSompi"
    | "paymentOutputIndex"
    | "reservationId"
    | "reservationExpiresAt"
  >;
}

export interface ExactTransactionPaymentRequest extends ExactPaymentRequest {
  head?: NonNullable<ExactPaymentRequest["head"]>;
  reservation?: NonNullable<ExactPaymentRequest["reservation"]>;
}

export interface ExactTransactionPaymentResult {
  transaction: string;
  transactionEncoding: ExactTransactionEncoding;
  transactionId: Hash32Hex;
  paymentOutputIndex: number;
  payerAddress?: string;
  fundingSource?: FundingSourceKind;
}

export type ExactPaymentResult = ExactTransactionPaymentResult;

export interface FeeEstimateRequest {
  network: NetworkId;
  action: "deposit" | "exact" | "refund";
  amount?: SompiString;
}

export interface FeeEstimate {
  feeSompi: SompiString;
}

export interface SendTransactionResult {
  transactionId: Hash32Hex;
  finality?: "broadcast" | "accepted" | "confirmed";
}

export interface FundingProvider {
  readonly networkId: NetworkId;
  readonly sourceKind: FundingSourceKind;
  getPublicIdentity(): Promise<PublicIdentity>;
  fundEscrowDeposit(request: EscrowDepositRequest): Promise<EscrowDepositResult>;
  payExactTransaction?(request: ExactTransactionPaymentRequest): Promise<ExactTransactionPaymentResult>;
  getUtxos(addresses: readonly string[]): Promise<FundingProviderUtxo[]>;
  getVirtualDaaScore(): Promise<SompiString>;
  sendTransaction(transaction: ByteHex): Promise<SendTransactionResult>;
  estimateFees(request: FeeEstimateRequest): Promise<FeeEstimate>;
}

export interface FundingPolicy {
  requiredSource?: FundingSourceKind;
}

export interface ChannelKey {
  privateKey?: string;
  publicKey: PublicKeyHex;
}

export interface VoucherSignRequest {
  digest: Hash32Hex;
  preimage: ByteHex;
  channel: DirectModeChannel;
  amount: SompiString;
}

export interface RefundSignRequest {
  channel: DirectModeChannel;
  refundAmount: SompiString;
}

export interface ChannelSigner {
  generateChannelKey(): Promise<ChannelKey>;
  randomSalt(): Promise<Hash32Hex>;
  randomNonce?(): Promise<Hash32Hex>;
  signVoucher(request: VoucherSignRequest): Promise<SignatureHex>;
  signRefund?(request: RefundSignRequest): Promise<SignatureHex>;
}

export interface AddressCodec {
  scriptPublicKeyForAddress(address: string, network: NetworkId): ByteHex;
  encodeScriptAddress(input: DeriveEscrowAddressInput): string;
}

export interface DirectModeChannel {
  id: Hash32Hex;
  origin: string;
  resourceUrl?: string;
  config: ChannelConfig;
  clientPrivateKey?: string;
  clientPublicKey: PublicKeyHex;
  serverPublicKey: PublicKeyHex;
  activeOutpoint: FundingOutpoint;
  activeScriptPublicKey: ByteHex;
  escrowAddress: string;
  fundingSource: FundingSourceKind;
  fundingAmount: SompiString;
  chargedCumulativeAmount: SompiString;
  claimedCumulativeAmount: SompiString;
  signedCumulativeAmount: SompiString;
  latestVoucher?: Voucher;
  refundTimeoutDaa: SompiString;
  templateId: "kaspa-x402-escrow-v1";
  status: ChannelStatus;
}

export interface ChannelStore {
  loadChannels(scope: ChannelLookupScope): Promise<DirectModeChannel[]>;
  saveChannel(channel: DirectModeChannel): Promise<void>;
  retireChannel(channelId: Hash32Hex, reason?: string): Promise<void>;
  deleteChannel(channelId: Hash32Hex): Promise<void>;
  listRefundableChannels(nowDaa?: SompiString): Promise<DirectModeChannel[]>;
}

export interface ChannelLookupScope {
  origin?: string;
  resourceUrl?: string;
  network?: NetworkId;
  status?: ChannelStatus;
}

export interface PaymentRequestContext {
  url: string;
  method?: string;
  body?: unknown;
  origin?: string;
  paymentIdentifier?: string;
  requestHash?: Hash32Hex;
}

export interface ParsedPaymentRequired {
  paymentRequired: PaymentRequired;
  accepted: PaymentRequirements;
}

export interface CreatePaymentResult {
  paymentRequired: PaymentRequired;
  accepted: PaymentRequirements;
  paymentPayload: PaymentPayload;
  scheme: "exact" | "batch-settlement";
  channel?: DirectModeChannel;
  openedChannel: boolean;
  transactionId?: Hash32Hex;
  paymentOutputIndex?: number;
  payerAddress?: string;
}

export interface ApplySettlementResult {
  channel?: DirectModeChannel;
  chargedAmount: SompiString;
  response: SettlementResponse;
  pending?: boolean;
  transactionId?: Hash32Hex;
  finality?: "mempool" | "accepted" | "confirmed";
}

export interface HeaderBag {
  get(name: string): string | null;
}

export interface HttpResponseLike {
  status: number;
  headers: HeaderBag;
}

export interface HttpRequestInitLike {
  headers?: HeadersInitLike;
  method?: string;
  body?: unknown;
  paymentIdentifier?: string;
  requestHash?: Hash32Hex;
  [key: string]: unknown;
}

export type HeadersInitLike = Record<string, string> | Array<[string, string]> | { entries(): IterableIterator<[string, string]> };
export type FetchLike = (input: string, init?: HttpRequestInitLike) => Promise<HttpResponseLike>;

export interface PaidFetchResult {
  response: HttpResponseLike;
  payment?: CreatePaymentResult;
  settlement?: ApplySettlementResult;
}

export interface RefundTransactionRequest {
  channel: DirectModeChannel;
  refundAmount: SompiString;
  clientSignature: SignatureHex;
}

export interface RefundTransactionResult {
  transaction: ByteHex;
  refundAmount?: SompiString;
}

export interface RefundTransactionBuilder {
  buildRefundTransaction(request: RefundTransactionRequest): Promise<RefundTransactionResult>;
}

export interface RefundResult {
  channel: DirectModeChannel;
  refundAmount: SompiString;
  transactionId: Hash32Hex;
  finality: "broadcast" | "accepted" | "confirmed";
  accepted: boolean;
}

export interface DirectModeClientOptions {
  fundingProvider: FundingProvider;
  signer: ChannelSigner;
  store: ChannelStore;
  addressCodec: AddressCodec;
  refundAddress?: string;
  supportedNetworks?: readonly NetworkId[];
  allowMainnet?: boolean;
  fundingPolicy?: FundingPolicy;
  fetch?: FetchLike;
  refundBuilder?: RefundTransactionBuilder;
  verifyVoucherSignature?: (voucher: Voucher, channel: DirectModeChannel) => Promise<boolean> | boolean;
  maxPaymentRetries?: number;
  supportedSchemes?: readonly PaymentScheme[];
}
