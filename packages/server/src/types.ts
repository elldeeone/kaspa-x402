import type {
  BatchPaymentRequirements,
  ByteHex,
  ChannelConfig,
  ClaimPolicy,
  ChannelState,
  FundingOutpoint,
  Hash32Hex,
  NetworkId,
  PaymentPayload,
  PaymentRequired,
  PublicKeyHex,
  ResourceInfo,
  SettlementResponse,
  SignatureHex,
  SompiString,
  Voucher,
} from "@kaspa-x402/core";
import type { DeriveEscrowAddressInput } from "@kaspa-x402/covenant";

export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

export type SettlementFinality = "broadcast" | "accepted" | "confirmed";
export type ChannelStatus = "active" | "retired" | "refunded" | "suspicious";

export interface AddressCodec {
  scriptPublicKeyForAddress(address: string, network: NetworkId): ByteHex;
  encodeScriptAddress(input: DeriveEscrowAddressInput): string;
}

export interface ChainUtxo {
  outpoint: FundingOutpoint;
  amount: SompiString;
  scriptPublicKey: ByteHex;
  finality: SettlementFinality;
}

export interface TransactionBroadcast {
  transactionId: Hash32Hex;
  finality: SettlementFinality;
}

export interface ServerChainProvider {
  getUtxo(outpoint: FundingOutpoint, network: NetworkId): Promise<ChainUtxo | null>;
  estimateClaimFee(channel: ServerChannelRecord): Promise<SompiString>;
  sendTransaction(transaction: ByteHex): Promise<TransactionBroadcast>;
}

export interface VoucherVerificationRequest {
  channelId: Hash32Hex;
  clientPublicKey: PublicKeyHex;
  digest: Hash32Hex;
  preimage: ByteHex;
  voucher: Voucher;
}

export interface VoucherVerifier {
  verifyVoucher(request: VoucherVerificationRequest): Promise<boolean> | boolean;
}

export interface TopUpVerificationRequest {
  previous: ServerChannelRecord;
  next: ServerChannelRecord;
  utxo: ChainUtxo;
  payment: PaymentPayload;
}

export interface TopUpVerifier {
  verifyTopUp(request: TopUpVerificationRequest): Promise<boolean> | boolean;
}

export interface ServerChannelRecord {
  channelId: Hash32Hex;
  channelConfig: ChannelConfig;
  escrowAddress: string;
  activeOutpoint: FundingOutpoint;
  activeScriptPublicKey: ByteHex;
  fundingAmount: SompiString;
  chargedCumulativeAmount: SompiString;
  claimedCumulativeAmount: SompiString;
  signedMaxClaimable: SompiString;
  voucherSignature?: SignatureHex;
  lastCommitmentId?: Hash32Hex;
  status: ChannelStatus;
}

export interface ServerChannelStore {
  loadChannel(channelId: Hash32Hex): Promise<ServerChannelRecord | undefined>;
  saveChannel(channel: ServerChannelRecord): Promise<void>;
  retireChannel(channelId: Hash32Hex, reason?: string): Promise<void>;
  listChannels(): Promise<ServerChannelRecord[]>;
}

export interface PaymentIdentifierRecord {
  id: string;
  fingerprint: Hash32Hex;
  paymentPayloadHash: Hash32Hex;
  response: ServerResponse;
  settlement: SettlementResponse;
  channelId: Hash32Hex;
}

export interface BatchCommitmentRecord {
  commitmentId: Hash32Hex;
  channelId: Hash32Hex;
  requestFingerprint: Hash32Hex;
  paymentRequirementsHash: Hash32Hex;
  activeOutpoint: FundingOutpoint;
  activeScriptPublicKey: ByteHex;
  voucher: Voucher;
  chargedAmount: SompiString;
  chargedCumulativeBefore: SompiString;
  chargedCumulativeAfter: SompiString;
  claimedCumulativeAmount: SompiString;
  paymentIdentifier?: string;
  settlement: SettlementResponse;
  response: ServerResponse;
}

export interface CommitmentStore {
  loadCommitment(commitmentId: Hash32Hex): Promise<BatchCommitmentRecord | undefined>;
}

export interface IdempotencyStore {
  loadPaymentIdentifier(id: string): Promise<PaymentIdentifierRecord | undefined>;
}

export interface SettlementCommit {
  channel: ServerChannelRecord;
  commitment: BatchCommitmentRecord;
  paymentIdentifier?: PaymentIdentifierRecord;
  expected: {
    channelId: Hash32Hex;
    chargedCumulativeAmount: SompiString;
    claimedCumulativeAmount: SompiString;
    signedMaxClaimable: SompiString;
    activeOutpoint: FundingOutpoint;
    activeScriptPublicKey: ByteHex;
    status: ChannelStatus;
  };
}

export interface SettlementCommitStore {
  commitSettlement(record: SettlementCommit): Promise<void>;
}

export type ClaimAttemptStatus = "pending" | "broadcast" | "accepted" | "applied";

export interface ClaimAttemptRecord {
  attemptId: Hash32Hex;
  channelId: Hash32Hex;
  activeOutpoint: FundingOutpoint;
  activeScriptPublicKey: ByteHex;
  fundingAmount: SompiString;
  claimAmount: SompiString;
  chargedCumulativeAmount: SompiString;
  claimedCumulativeAmount: SompiString;
  signedMaxClaimable: SompiString;
  voucherSignature?: SignatureHex;
  channelStatus: ChannelStatus;
  transaction: ByteHex;
  status: ClaimAttemptStatus;
  transactionId?: Hash32Hex;
  finality?: SettlementFinality;
  continuationOutpoint?: FundingOutpoint;
  continuationScriptPublicKey?: ByteHex;
  continuationFundingAmount?: SompiString;
}

export interface ClaimAttemptStore {
  loadOpenClaimAttempt(channelId: Hash32Hex): Promise<ClaimAttemptRecord | undefined>;
  saveClaimAttempt(record: ClaimAttemptRecord): Promise<void>;
  applyClaimAttempt(channel: ServerChannelRecord, attempt: ClaimAttemptRecord): Promise<void>;
  abandonClaimAttempt(attemptId: Hash32Hex, reason?: string): Promise<void>;
}

export interface ServerStateStore extends ServerChannelStore, CommitmentStore, IdempotencyStore, SettlementCommitStore, ClaimAttemptStore {}

export interface ChannelLockManager {
  runExclusive<T>(channelId: Hash32Hex, fn: () => Promise<T>): Promise<T>;
}

export interface ClaimPreview {
  channel: ServerChannelRecord;
  claimAmount: SompiString;
  estimatedFee: SompiString;
  claimable: boolean;
  reason?: string;
}

export interface ClaimTransactionRequest {
  channel: ServerChannelRecord;
  claimAmount: SompiString;
}

export interface ClaimTransactionResult {
  transaction: ByteHex;
  claimAmount: SompiString;
  continuationOutpoint?: FundingOutpoint;
  continuationScriptPublicKey?: ByteHex;
  continuationFundingAmount?: SompiString;
}

export interface ClaimTransactionBuilder {
  buildClaimTransaction(request: ClaimTransactionRequest): Promise<ClaimTransactionResult>;
}

export interface ClaimExecutionResult {
  channel: ServerChannelRecord;
  transactionId: Hash32Hex;
  finality: SettlementFinality;
  accepted: boolean;
}

export interface ClaimRecoveryInput {
  transactionId?: Hash32Hex;
  finality?: Exclude<SettlementFinality, "broadcast">;
}

export interface DirectModeServerConfig {
  network: NetworkId;
  asset?: "KAS";
  payTo: string;
  serverPublicKey: PublicKeyHex;
  serverPrivateKey?: string;
  templateId?: "kaspa-x402-escrow-v1";
  minDepositSompi: SompiString;
  amount: SompiString;
  refundTimeoutDaa: SompiString;
  maxTimeoutSeconds?: number;
  store: ServerStateStore;
  chainProvider: ServerChainProvider;
  addressCodec: AddressCodec;
  voucherVerifier: VoucherVerifier;
  lockManager?: ChannelLockManager;
  claimPolicy?: ClaimPolicy;
  claimBuilder?: ClaimTransactionBuilder;
  requirePaymentIdentifier?: boolean;
  acceptedFinality?: Exclude<SettlementFinality, "broadcast">;
  topUpVerifier?: TopUpVerifier;
}

export interface BuildPaymentRequiredOptions {
  resource: ResourceInfo;
  amount?: SompiString;
  channel?: ServerChannelRecord;
  voucherState?: Voucher;
}

export interface PaidRequest {
  method?: string;
  url: string;
  headers?: HeaderSource;
  body?: unknown;
  resource?: ResourceInfo;
  paymentAmount?: SompiString;
  requestHash?: Hash32Hex;
}

export type HeaderSource = Record<string, string> | { get(name: string): string | null };

export interface ServerResponse {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
}

export interface ProtectedHandlerResult {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  chargedAmount?: SompiString;
}

export interface VerifiedPayment {
  paymentRequired: PaymentRequired;
  paymentPayload: PaymentPayload;
  accepted: BatchPaymentRequirements;
  channel: ServerChannelRecord;
  commitExpectedChannel: ServerChannelRecord;
  voucher: Voucher;
  openedChannel: boolean;
}

export interface HandlerContext {
  request: PaidRequest;
  payment: VerifiedPayment;
  requestFingerprint: Hash32Hex;
  paymentIdentifier?: string;
}

export type ProtectedHandler = (context: HandlerContext) => Promise<ProtectedHandlerResult> | ProtectedHandlerResult;
