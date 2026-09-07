import type {
  BatchPaymentRequirements,
  ByteHex,
  ChannelConfig,
  ClaimPolicy,
  ChannelState,
  ExactPaymentRequirements,
  ExactProfile,
  ExactRequestAuthorization,
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
  /** Stable KIP-20 covenant lineage reported by authoritative chain readback. */
  covenantId?: Hash32Hex;
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
  getUtxo(
    outpoint: FundingOutpoint,
    network: NetworkId,
  ): Promise<ChainUtxo | null>;
  getVirtualDaaScore(): Promise<SompiString>;
  /**
   * Verifies the complete, unpruned KIP-20 genesis transaction at admission.
   * The adapter must recompute the id from its authorizing input and ordered
   * authorized outputs; returning null means the evidence is unavailable or invalid.
   */
  verifyCovenantGenesis(
    request: CovenantGenesisVerificationRequest,
  ): Promise<CovenantGenesisVerification | null>;
  estimateClaimFee(channel: ServerChannelRecord): Promise<SompiString>;
  sendTransaction(
    transaction: PreparedTransaction,
  ): Promise<TransactionBroadcast>;
}

export interface CovenantGenesisVerificationRequest {
  utxo: ChainUtxo;
  payment: PaymentPayload;
}

export interface CovenantGenesisVerification {
  covenantId: Hash32Hex;
  authorizingInput: FundingOutpoint;
  genesisOutpoint: FundingOutpoint;
  genesisScriptPublicKey: ByteHex;
  genesisAmount: SompiString;
  /** Singleton escrow genesis intentionally permits exactly one total output. */
  totalOutputCount: number;
  /** Batch escrow admission intentionally permits exactly one authorized output. */
  authorizedOutputCount: number;
}

export interface ChannelSignatureVerificationRequest {
  channelId: Hash32Hex;
  publicKey: PublicKeyHex;
  digest: Hash32Hex;
  preimage: string;
  signature: SignatureHex;
  purpose: "voucher" | "request-authorization";
}

export interface ChannelSignatureVerifier {
  verifySignature(
    request: ChannelSignatureVerificationRequest,
  ): Promise<boolean> | boolean;
}

export interface ExactTransactionOutput {
  amount: SompiString;
  scriptPublicKey: ByteHex;
  address?: string;
}

export interface ExactHeadContinuation {
  outpoint: FundingOutpoint;
  amount: SompiString;
  scriptPublicKey: ByteHex;
}

export interface ExactHeadChallenge {
  headId: Hash32Hex;
  headVersion: SompiString;
  templateId: ExactAdditiveTemplateId;
  transactionEncoding: ExactTransactionEncoding;
  expectedHeadOutpoint: FundingOutpoint;
  headAmount: SompiString;
  headScriptPublicKey: ByteHex;
  headRedeemScript: ByteHex;
  additiveThresholdSompi: SompiString;
  paymentOutputIndex: 0;
  challengeId: Hash32Hex;
  expiresAt: string;
}

export type ExactHeadStatus =
  "available" | "claimed" | "unavailable" | "retired";

/** Durable current state for one reusable KIP-10 additive head chain. */
export interface ExactHeadRecord {
  headId: Hash32Hex;
  network: NetworkId;
  payTo: string;
  templateId: ExactAdditiveTemplateId;
  transactionEncoding: ExactTransactionEncoding;
  currentOutpoint: FundingOutpoint;
  currentAmount: SompiString;
  scriptPublicKey: ByteHex;
  redeemScript: ByteHex;
  additiveThresholdSompi: SompiString;
  version: SompiString;
  status: ExactHeadStatus;
  createdAt: string;
  updatedAt: string;
  claimTransactionId?: Hash32Hex;
  lastTransactionId?: Hash32Hex;
  unavailableReason?: string;
}

/** Public, key-free manifest for independently auditing one KIP-10 head lineage. */
export interface ExactHeadManifest {
  format: "kaspa-x402-exact-head-manifest-v1";
  headId: Hash32Hex;
  network: NetworkId;
  payTo: string;
  ownerPublicKey: PublicKeyHex;
  additiveThresholdSompi: SompiString;
  redeemScript: ByteHex;
  scriptPublicKey: ByteHex;
  currentOutpoint: FundingOutpoint;
  currentAmount: SompiString;
  version: SompiString;
  status: ExactHeadStatus;
  createdAt: string;
  updatedAt: string;
  lastTransactionId?: Hash32Hex;
  unavailableReason?: string;
}

export interface ExactHeadSelectionRequest {
  network: NetworkId;
  amount: SompiString;
  payTo: string;
  payToScriptPublicKey: ByteHex;
  minimumAdditiveThresholdSompi: SompiString;
  selectionKey: Hash32Hex;
}

/** One accepted transaction link from a known KIP-10 head outpoint to its same-index successor. */
export interface ExactHeadLineageStep {
  transactionId: Hash32Hex;
  spentOutpoint: FundingOutpoint;
  successor: ExactHeadContinuation;
  finality: "accepted" | "confirmed";
}

export type ExactHeadReconciliation =
  | {
      status: "current";
      outpoint: FundingOutpoint;
      amount: SompiString;
      scriptPublicKey: ByteHex;
      finality: "accepted" | "confirmed";
    }
  | {
      status: "advanced";
      steps: ExactHeadLineageStep[];
    }
  | { status: "unknown"; reason: string };

/** Trusted chain adapter that proves current UTXO state or a complete successor lineage. */
export interface ExactHeadReconciler {
  reconcileExactHead(
    head: ExactHeadRecord,
    candidateTransactionIds?: readonly Hash32Hex[],
  ): Promise<ExactHeadReconciliation> | ExactHeadReconciliation;
}

export interface ExactHeadLineageApply {
  headId: Hash32Hex;
  expectedVersion: SompiString;
  expectedOutpoint: FundingOutpoint;
  expectedAmount: SompiString;
  steps: ExactHeadLineageStep[];
  observedAt: string;
}

/** Snapshot-guarded fail-closed transition for untrusted or incomplete head evidence. */
export interface ExactHeadUnavailableApply {
  headId: Hash32Hex;
  expectedVersion: SompiString;
  expectedOutpoint: FundingOutpoint;
  expectedAmount: SompiString;
  expectedStatus: Exclude<ExactHeadStatus, "retired">;
  reason: string;
  observedAt: string;
}

export interface ExactHeadUnavailableResult {
  applied: boolean;
  head: ExactHeadRecord;
}

export interface ExactTransactionVerificationRequest {
  /** Authenticate expired evidence for durable recovery; caller must enforce expiry before new work. */
  allowExpiredAuthorization?: boolean;
  network: NetworkId;
  profile: ExactProfile;
  transaction: PreparedTransaction;
  transactionEncoding: ExactTransactionEncoding;
  paymentOutputIndex: number;
  amount: SompiString;
  payTo: string;
  payToScriptPublicKey: ByteHex;
  requiredFinality: "accepted" | "confirmed";
  requestHash: Hash32Hex;
  paymentRequirementsHash: Hash32Hex;
  authorization: ExactRequestAuthorization;
  head?: ExactHeadChallenge;
}

export interface ExactTransactionVerification {
  transactionId: Hash32Hex;
  paymentOutput: ExactTransactionOutput;
  finality?: "mempool" | "accepted" | "confirmed";
  payerAddress?: string;
  requestAuthorization: {
    authorizationId: Hash32Hex;
    digest: Hash32Hex;
    inputIndex: number;
    publicKey: PublicKeyHex;
  };
  /** Canonical KIP-10 continuation verified from the signed transaction. */
  continuation?: ExactHeadContinuation;
}

export interface ExactTransactionVerifier {
  verifyExactPayment(
    request: ExactTransactionVerificationRequest,
  ): Promise<ExactTransactionVerification> | ExactTransactionVerification;
}

export interface TopUpVerificationRequest {
  previous: ServerChannelRecord;
  next: ServerChannelRecord;
  utxo: ChainUtxo;
  payment: PaymentPayload;
}

export interface TopUpVerificationResult {
  covenantId: Hash32Hex;
  spentOutpoint: FundingOutpoint;
  successorOutpoint: FundingOutpoint;
  successorScriptPublicKey: ByteHex;
  successorAmount: SompiString;
  /** The transition must create one and only one successor for this covenant. */
  authorizedSuccessorCount: number;
}

export interface TopUpVerifier {
  verifyTopUp(
    request: TopUpVerificationRequest,
  ): Promise<TopUpVerificationResult | null> | TopUpVerificationResult | null;
}

export interface ServerChannelRecord {
  channelId: Hash32Hex;
  covenantId: Hash32Hex;
  genesisEvidence: CovenantGenesisVerification;
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
  /** Atomically preserves the one-covenant-lineage-to-one-channel invariant. */
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
  covenantId: Hash32Hex;
  requestFingerprint: Hash32Hex;
  paymentRequirementsHash: Hash32Hex;
  paymentEvidenceHash: Hash32Hex;
  requestAuthorizationId: Hash32Hex;
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
  loadCommitment(
    commitmentId: Hash32Hex,
  ): Promise<BatchCommitmentRecord | undefined>;
}

export interface IdempotencyStore {
  loadPaymentIdentifier(
    id: string,
  ): Promise<PaymentIdentifierRecord | undefined>;
}

export interface ExactPaymentRecord {
  profile: ExactProfile;
  transactionId: Hash32Hex;
  paymentOutputIndex: number;
  requestFingerprint: Hash32Hex;
  paymentRequirementsHash: Hash32Hex;
  paymentPayloadHash: Hash32Hex;
  requestAuthorizationId: Hash32Hex;
  amount: SompiString;
  payerAddress?: string;
  finality: "mempool" | "accepted" | "confirmed";
  settlement: SettlementResponse;
  response: ServerResponse;
}

export type ExactSettlementAttemptStatus =
  "pending" | "broadcast" | "accepted" | "applied";

export interface ExactSettlementHeadClaim {
  headId: Hash32Hex;
  expectedVersion: SompiString;
  expectedOutpoint: FundingOutpoint;
  expectedAmount: SompiString;
  successor: ExactHeadContinuation;
}

/**
 * Durable replay and recovery evidence written before exact settlement can
 * broadcast or invoke protected application work.
 */
export interface ExactSettlementAttemptRecord {
  /** Marks identifier admission performed by this store version, including absent identifiers. */
  identifierAdmissionVersion?: 1;
  paymentIdentifier?: string;
  transactionId: Hash32Hex;
  profile: ExactProfile;
  amount: SompiString;
  paymentOutputIndex: number;
  requestFingerprint: Hash32Hex;
  paymentRequirementsHash: Hash32Hex;
  paymentPayloadHash: Hash32Hex;
  requestAuthorizationId: Hash32Hex;
  payToScriptPublicKey: ByteHex;
  transaction: PreparedTransaction;
  /** Immutable finality threshold advertised for this signed payment attempt. */
  requiredFinality: "accepted" | "confirmed";
  status: ExactSettlementAttemptStatus;
  createdAt: string;
  updatedAt: string;
  finality?: SettlementFinality;
  handlerStartedAt?: string;
  handlerResult?: ProtectedHandlerResult;
  handlerCompletedAt?: string;
  head?: ExactSettlementHeadClaim;
  recoveryReason?: string;
}

export interface ExactSettlementClaimRequest extends ExactSettlementAttemptRecord {
  /** Atomically reject first-seen artifacts already accepted on chain. */
  existingOnly?: boolean;
}

export interface ExactSettlementClaimResult {
  attempt: ExactSettlementAttemptRecord;
  created: boolean;
}

export type ExactSettlementReconciliation =
  | {
      status: "accepted";
      transactionId: Hash32Hex;
      finality: "accepted" | "confirmed";
      paymentOutput: ExactTransactionOutput;
      continuation?: ExactHeadContinuation;
    }
  | { status: "rejected"; transactionId: Hash32Hex; reason: string }
  | { status: "unknown"; transactionId: Hash32Hex; reason?: string };

/** Trusted chain adapter used to resolve an ambiguous exact broadcast without rebroadcasting it. */
export interface ExactSettlementReconciler {
  reconcileExactSettlement(
    attempt: ExactSettlementAttemptRecord,
  ): Promise<ExactSettlementReconciliation> | ExactSettlementReconciliation;
}

export interface SettlementCommit {
  batchAttemptId: Hash32Hex;
  channel: ServerChannelRecord;
  commitment: BatchCommitmentRecord;
  paymentIdentifier?: PaymentIdentifierRecord;
  expected: {
    channelId: Hash32Hex;
    covenantId: Hash32Hex;
    fundingAmount: SompiString;
    chargedCumulativeAmount: SompiString;
    claimedCumulativeAmount: SompiString;
    signedMaxClaimable: SompiString;
    voucherSignature?: SignatureHex;
    activeOutpoint: FundingOutpoint;
    activeScriptPublicKey: ByteHex;
    status: ChannelStatus;
  };
}

export type BatchSettlementAttemptStatus = "pending" | "applied";

/** Durable evidence written before protected batch work can begin. */
export interface BatchSettlementAttemptRecord {
  /** Persisted completion terms permit trusted recovery without a payer retry. */
  paymentRequirements?: BatchPaymentRequirements;
  paymentPayloadHash?: Hash32Hex;
  paymentType?: "deposit-voucher" | "voucher";
  attemptId: Hash32Hex;
  channelId: Hash32Hex;
  covenantId: Hash32Hex;
  requestFingerprint: Hash32Hex;
  paymentRequirementsHash: Hash32Hex;
  paymentEvidenceHash: Hash32Hex;
  requestAuthorizationId: Hash32Hex;
  paymentIdentifier?: string;
  maximumCharge: SompiString;
  /** Verified channel state adopted atomically with this work reservation. */
  adoptedChannel: ServerChannelRecord;
  /** Prior state required before adoption; absent only for a new channel. */
  prior?: SettlementCommit["expected"];
  expected: SettlementCommit["expected"];
  status: BatchSettlementAttemptStatus;
  createdAt: string;
  updatedAt: string;
  handlerStartedAt?: string;
  handlerResult?: ProtectedHandlerResult;
  handlerCompletedAt?: string;
  recoveryReason?: string;
}

export interface BatchSettlementClaimResult {
  attempt: BatchSettlementAttemptRecord;
  created: boolean;
}

export interface BatchSettlementAttemptStore {
  /** Atomically claims one verified payment attempt against its channel snapshot. */
  claimBatchSettlement(
    attempt: BatchSettlementAttemptRecord,
  ): Promise<BatchSettlementClaimResult>;
  loadBatchSettlementAttempt(
    attemptId: Hash32Hex,
  ): Promise<BatchSettlementAttemptRecord | undefined>;
  /** Returns true exactly once, preventing protected-handler replay. */
  beginBatchHandler(attemptId: Hash32Hex, startedAt: string): Promise<boolean>;
  /** Persists protected work before settlement commit so retries can resume safely. */
  recordBatchHandlerResult(
    attemptId: Hash32Hex,
    result: ProtectedHandlerResult,
    completedAt: string,
  ): Promise<void>;
  /** Records an uncertain handler outcome that requires explicit operator recovery. */
  markBatchHandlerRecoveryRequired(
    attemptId: Hash32Hex,
    reason: string,
    observedAt: string,
  ): Promise<void>;
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
  loadExactPayment(
    transactionId: Hash32Hex,
  ): Promise<ExactPaymentRecord | undefined>;
  /**
   * Atomically records a consumed exact transaction and optional payment
   * identifier. Existing identical records are idempotent; conflicting txid or
   * payment-identifier writes must fail without partial writes.
   */
  commitExactPayment(record: ExactSettlementCommit): Promise<void>;
}

export interface ExactHeadStore {
  registerExactHead(record: ExactHeadRecord): Promise<ExactHeadRecord>;
  loadExactHead(headId: Hash32Hex): Promise<ExactHeadRecord | undefined>;
  listExactHeads(): Promise<ExactHeadRecord[]>;
  /** Read-only selection: issuing a 402 must not mutate or lease the head. */
  selectExactHead(
    request: ExactHeadSelectionRequest,
  ): Promise<ExactHeadRecord | undefined>;
  /** Atomically claims a transaction and, for additive exact, its expected head snapshot. */
  claimExactSettlement(
    attempt: ExactSettlementClaimRequest,
  ): Promise<ExactSettlementClaimResult>;
  loadExactSettlementAttempt(
    transactionId: Hash32Hex,
  ): Promise<ExactSettlementAttemptRecord | undefined>;
  recordExactSettlementBroadcast(
    transactionId: Hash32Hex,
    finality: SettlementFinality,
    observedAt: string,
  ): Promise<void>;
  /** Atomically records finality and advances a claimed additive head to its verified successor. */
  acceptExactSettlement(
    transactionId: Hash32Hex,
    finality: Exclude<SettlementFinality, "broadcast">,
    observedAt: string,
  ): Promise<void>;
  /** Returns true exactly once, preventing protected-handler replay after a crash. */
  beginExactHandler(
    transactionId: Hash32Hex,
    startedAt: string,
  ): Promise<boolean>;
  /** Persists protected work before the payment/response commit so retries can resume safely. */
  recordExactHandlerResult(
    transactionId: Hash32Hex,
    result: ProtectedHandlerResult,
    completedAt: string,
  ): Promise<void>;
  /** Records an uncertain handler outcome that requires explicit operator recovery. */
  markExactHandlerRecoveryRequired(
    transactionId: Hash32Hex,
    reason: string,
    observedAt: string,
  ): Promise<void>;
  /** Releases only a not-yet-accepted attempt after trusted negative reconciliation. */
  abandonExactSettlement(
    transactionId: Hash32Hex,
    reason: string,
    observedAt: string,
  ): Promise<void>;
  /** Fail closed when trusted successor lineage cannot be established. */
  markExactHeadUnavailable(
    input: ExactHeadUnavailableApply,
  ): Promise<ExactHeadUnavailableResult>;
  /** Atomically applies a fully verified external successor chain from the expected head snapshot. */
  applyExactHeadLineage(input: ExactHeadLineageApply): Promise<ExactHeadRecord>;
}

export type ClaimAttemptStatus =
  "pending" | "broadcast" | "accepted" | "applied";

export interface ClaimAttemptRecord {
  attemptId: Hash32Hex;
  /** Unique execution epoch fencing stale holders after abandonment. */
  attemptEpoch: string;
  channelId: Hash32Hex;
  covenantId: Hash32Hex;
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
  /** Deterministic id of the exact signed transaction captured before broadcast. */
  transactionId: Hash32Hex;
  /** Immutable finality threshold captured before the first broadcast. */
  requiredFinality: "accepted" | "confirmed";
  status: ClaimAttemptStatus;
  finality?: SettlementFinality;
  continuationOutpoint?: FundingOutpoint;
  continuationScriptPublicKey?: ByteHex;
  continuationFundingAmount?: SompiString;
}

export interface ClaimAttemptStore {
  loadOpenClaimAttempt(
    channelId: Hash32Hex,
  ): Promise<ClaimAttemptRecord | undefined>;
  /** Saves one open claim attempt per channel; durable adapters must reject conflicting open attempts. */
  saveClaimAttempt(record: ClaimAttemptRecord): Promise<void>;
  /** Applies a claim only if the channel still matches the attempt snapshot. */
  applyClaimAttempt(
    channel: ServerChannelRecord,
    attempt: ClaimAttemptRecord,
  ): Promise<void>;
  abandonClaimAttempt(attemptId: Hash32Hex, reason?: string): Promise<void>;
}

export interface ServerStateStore
  extends
    ServerChannelStore,
    CommitmentStore,
    IdempotencyStore,
    SettlementCommitStore,
    BatchSettlementAttemptStore,
    ExactPaymentStore,
    ExactHeadStore,
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
  /** Deterministic id of the exact signed transaction returned above. */
  transactionId: Hash32Hex;
  claimAmount: SompiString;
  continuationOutpoint?: FundingOutpoint;
  continuationScriptPublicKey?: ByteHex;
  continuationFundingAmount?: SompiString;
}

export interface ClaimTransactionBuilder {
  buildClaimTransaction(
    request: ClaimTransactionRequest,
  ): Promise<ClaimTransactionResult>;
}

export type ClaimReconciliation =
  | {
      status: "accepted";
      transactionId: Hash32Hex;
      finality: "accepted" | "confirmed";
    }
  | { status: "rejected"; transactionId: Hash32Hex; reason: string }
  | { status: "unknown"; transactionId: Hash32Hex; reason?: string };

/** Trusted chain lookup for one already-persisted claim transaction. */
export interface ClaimReconciler {
  reconcileClaim(
    attempt: ClaimAttemptRecord,
  ): Promise<ClaimReconciliation> | ClaimReconciliation;
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
  templateId?: "kaspa-x402-escrow-v3";
  minDepositSompi: SompiString;
  /** Deterministic reserve the client must leave beyond its signed claim ceiling. */
  claimReserveSompi: SompiString;
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
  channelSignatureVerifier: ChannelSignatureVerifier;
  exactTransactionVerifier?: ExactTransactionVerifier;
  exactSettlementReconciler?: ExactSettlementReconciler;
  exactHeadReconciler?: ExactHeadReconciler;
  /** Reconciles only the selected additive head before advertising it. */
  reconcileExactHeadOnOffer?: boolean;
  /** Exact wire profile offered by this server. Defaults to standard-native. */
  exactProfile?: ExactProfile;
  minimumExactAdditiveThresholdSompi?: SompiString;
  lockManager?: ChannelLockManager;
  claimPolicy?: ClaimPolicy;
  claimBuilder?: ClaimTransactionBuilder;
  claimReconciler?: ClaimReconciler;
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
  exactHead?: ExactHeadChallenge;
  error?: string;
}

export interface DirectPaymentVerificationOptions {
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentPayload["accepted"];
  resource?: ResourceInfo;
  requestHash: Hash32Hex;
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

export type HeaderSource =
  Record<string, string> | { get(name: string): string | null };

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
  paymentPayload: PaymentPayload & {
    accepted: ExactPaymentRequirements;
    payload: ExactTransactionPayload;
  };
  accepted: ExactPaymentRequirements;
  profile: ExactProfile;
  transactionId: Hash32Hex;
  requestAuthorizationId: Hash32Hex;
  paymentOutputIndex: number;
  transaction?: PreparedTransaction;
  transactionEncoding?: ExactTransactionEncoding;
  head?: ExactHeadChallenge;
  continuation?: ExactHeadContinuation;
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

export type ProtectedHandler = (
  context: HandlerContext,
) => Promise<ProtectedHandlerResult> | ProtectedHandlerResult;

export type DirectModeSupportedKind = SupportedKind;
