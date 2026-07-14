import type {
  BatchPaymentRequirements,
  ByteHex,
  ChannelConfig,
  ClaimPolicy,
  ChannelState,
  ExactPaymentRequirements,
  ExactProfile,
  ExactTransactionEncoding,
  ExactAdditiveTemplateId,
  ExactTransactionPayload,
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
  SupportedKind,
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

export type PreparedTransaction = string;

export interface ServerChainProvider {
  getUtxo(outpoint: FundingOutpoint, network: NetworkId): Promise<ChainUtxo | null>;
  getVirtualDaaScore(): Promise<SompiString>;
  estimateClaimFee(channel: ServerChannelRecord): Promise<SompiString>;
  sendTransaction(transaction: PreparedTransaction): Promise<TransactionBroadcast>;
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

export interface ExactTransactionOutput {
  amount: SompiString;
  scriptPublicKey: ByteHex;
  address?: string;
}

export interface ExactBorrowContinuation {
  outpoint: FundingOutpoint;
  amount: SompiString;
  scriptPublicKey: ByteHex;
}

export interface ExactTransactionVerificationRequest {
  network: NetworkId;
  profile: ExactProfile;
  transaction: PreparedTransaction;
  transactionEncoding: ExactTransactionEncoding;
  paymentOutputIndex: number;
  amount: SompiString;
  payTo: string;
  payToScriptPublicKey: ByteHex;
  requiredFinality: "accepted" | "confirmed";
  requestHash?: Hash32Hex;
  reservation?: ExactBorrowReservation;
}

export interface ExactTransactionVerification {
  transactionId: Hash32Hex;
  paymentOutput: ExactTransactionOutput;
  finality?: "mempool" | "accepted" | "confirmed";
  payerAddress?: string;
  /** Canonical KIP-10 continuation verified from the signed transaction. */
  continuation?: ExactBorrowContinuation;
}

export interface ExactTransactionVerifier {
  verifyExactPayment(request: ExactTransactionVerificationRequest): Promise<ExactTransactionVerification> | ExactTransactionVerification;
}

export interface ExactBorrowReservation {
  reservationId: Hash32Hex;
  templateId: ExactAdditiveTemplateId;
  transactionEncoding: ExactTransactionEncoding;
  borrowOutpoint: FundingOutpoint;
  borrowAmount: SompiString;
  borrowScriptPublicKey: ByteHex;
  borrowRedeemScript: ByteHex;
  additiveThresholdSompi: SompiString;
  paymentOutputIndex: number;
  expiresAt?: string;
}

export interface ExactBorrowReservationRequest {
  network: NetworkId;
  amount: SompiString;
  payTo: string;
  payToScriptPublicKey: ByteHex;
  maxTimeoutSeconds: number;
  resource: ResourceInfo;
  minimumAdditiveThresholdSompi: SompiString;
}

export interface ExactBorrowReservationProvider {
  reserveExactPayment(request: ExactBorrowReservationRequest): Promise<ExactBorrowReservation> | ExactBorrowReservation;
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
  paymentScopeId: Hash32Hex;
  channelId?: Hash32Hex;
  transactionId?: Hash32Hex;
  paymentOutputIndex?: number;
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

export interface ExactPaymentRecord {
  profile: ExactProfile;
  transactionId: Hash32Hex;
  paymentOutputIndex: number;
  requestFingerprint: Hash32Hex;
  paymentRequirementsHash: Hash32Hex;
  paymentPayloadHash: Hash32Hex;
  amount: SompiString;
  payerAddress?: string;
  finality: "mempool" | "accepted" | "confirmed";
  settlement: SettlementResponse;
  response: ServerResponse;
}

export type ExactReservationStatus = "reserved" | "consumed";

export interface ExactReservationRecord extends ExactBorrowReservation {
  status: ExactReservationStatus;
  reservedAt: string;
  transactionId?: Hash32Hex;
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
  /**
   * Atomically writes the commitment, optional payment identifier, and next
   * channel state only if the current channel still matches `expected`.
   */
  commitSettlement(record: SettlementCommit): Promise<void>;
}

export interface ExactSettlementCommit {
  payment: ExactPaymentRecord;
  paymentIdentifier?: PaymentIdentifierRecord;
}

export interface ExactPaymentStore {
  /**
   * Loads the consumed exact-payment record for a transaction id. Exact replay
   * scope is transaction-wide, even though the selected output index remains
   * part of settlement evidence.
   */
  loadExactPayment(transactionId: Hash32Hex): Promise<ExactPaymentRecord | undefined>;
  /**
   * Atomically records a consumed exact transaction and optional payment
   * identifier. Existing identical records are idempotent; conflicting txid or
   * payment-identifier writes must fail without partial writes.
   */
  commitExactPayment(record: ExactSettlementCommit): Promise<void>;
  saveExactReservation(record: ExactReservationRecord): Promise<void>;
  loadExactReservation(reservationId: Hash32Hex): Promise<ExactReservationRecord | undefined>;
  consumeExactReservation(
    reservationId: Hash32Hex,
    transactionId: Hash32Hex,
    continuation?: ExactBorrowContinuation,
  ): Promise<void>;
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
  transaction: PreparedTransaction;
  status: ClaimAttemptStatus;
  transactionId?: Hash32Hex;
  finality?: SettlementFinality;
  continuationOutpoint?: FundingOutpoint;
  continuationScriptPublicKey?: ByteHex;
  continuationFundingAmount?: SompiString;
}

export interface ClaimAttemptStore {
  loadOpenClaimAttempt(channelId: Hash32Hex): Promise<ClaimAttemptRecord | undefined>;
  /** Saves one open claim attempt per channel; durable adapters must reject conflicting open attempts. */
  saveClaimAttempt(record: ClaimAttemptRecord): Promise<void>;
  /** Applies a claim only if the channel still matches the attempt snapshot. */
  applyClaimAttempt(channel: ServerChannelRecord, attempt: ClaimAttemptRecord): Promise<void>;
  abandonClaimAttempt(attemptId: Hash32Hex, reason?: string): Promise<void>;
}

export interface ServerStateStore
  extends ServerChannelStore,
    CommitmentStore,
    IdempotencyStore,
    SettlementCommitStore,
    ExactPaymentStore,
    ClaimAttemptStore {}

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
  transaction: PreparedTransaction;
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
  /** Minimum remaining DAA-score distance before accepting a voucher. */
  minimumRefundLeadDaa?: SompiString;
  /** Allows a previously advertised absolute timeout within the configured rolling window. */
  allowRollingRefundTimeoutDaa?: boolean;
  /** Required when rolling timeouts are enabled. */
  maximumRefundHorizonDaa?: SompiString;
  maxTimeoutSeconds?: number;
  store: ServerStateStore;
  chainProvider: ServerChainProvider;
  addressCodec: AddressCodec;
  voucherVerifier: VoucherVerifier;
  exactTransactionVerifier?: ExactTransactionVerifier;
  /** Exact wire profile offered by this server. Defaults to standard-native. */
  exactProfile?: ExactProfile;
  exactReservationProvider?: ExactBorrowReservationProvider;
  minimumExactAdditiveThresholdSompi?: SompiString;
  lockManager?: ChannelLockManager;
  claimPolicy?: ClaimPolicy;
  claimBuilder?: ClaimTransactionBuilder;
  requirePaymentIdentifier?: boolean;
  allowMainnet?: boolean;
  acceptedFinality?: Exclude<SettlementFinality, "broadcast">;
  topUpVerifier?: TopUpVerifier;
}

export interface BuildPaymentRequiredOptions {
  resource: ResourceInfo;
  amount?: SompiString;
  scheme?: "exact" | "batch-settlement";
  schemes?: readonly ("exact" | "batch-settlement")[];
  channel?: ServerChannelRecord;
  voucherState?: Voucher;
  exactReservation?: ExactBorrowReservation;
  error?: string;
}

export interface DirectPaymentVerificationOptions {
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentPayload["accepted"];
  resource?: ResourceInfo;
  requestHash?: Hash32Hex;
}

export interface DirectPaymentVerification {
  payment: VerifiedPayment;
  requestFingerprint: Hash32Hex;
  payer?: string;
  extra?: Record<string, unknown>;
}

export interface DirectPaymentSettlementOptions extends DirectPaymentVerificationOptions {}

export interface PaidRequest {
  method?: string;
  url: string;
  headers?: HeaderSource;
  body?: unknown;
  resource?: ResourceInfo;
  paymentAmount?: SompiString;
  paymentScheme?: "exact" | "batch-settlement";
  paymentSchemes?: readonly ("exact" | "batch-settlement")[];
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

export interface VerifiedBatchPayment {
  scheme: "batch-settlement";
  paymentRequired: PaymentRequired;
  paymentPayload: PaymentPayload;
  accepted: BatchPaymentRequirements;
  channel: ServerChannelRecord;
  commitExpectedChannel: ServerChannelRecord;
  voucher: Voucher;
  openedChannel: boolean;
}

export interface VerifiedExactPayment {
  scheme: "exact";
  paymentRequired: PaymentRequired;
  paymentPayload: PaymentPayload & { accepted: ExactPaymentRequirements; payload: ExactTransactionPayload };
  accepted: ExactPaymentRequirements;
  profile: ExactProfile;
  transactionId: Hash32Hex;
  paymentOutputIndex: number;
  transaction?: PreparedTransaction;
  transactionEncoding?: ExactTransactionEncoding;
  reservation?: ExactBorrowReservation;
  continuation?: ExactBorrowContinuation;
  payerAddress?: string;
  finality: "mempool" | "accepted" | "confirmed";
  observedFinality?: "mempool" | "accepted" | "confirmed";
}

export type VerifiedPayment = VerifiedBatchPayment | VerifiedExactPayment;

export interface HandlerContext {
  request: PaidRequest;
  payment: VerifiedPayment;
  requestFingerprint: Hash32Hex;
  paymentIdentifier?: string;
}

export type ProtectedHandler = (context: HandlerContext) => Promise<ProtectedHandlerResult> | ProtectedHandlerResult;

export type DirectModeSupportedKind = SupportedKind;
