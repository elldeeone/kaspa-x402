import type {
  BatchPaymentRequirements,
  ByteHex,
  ChannelConfig,
  ExactPaymentRequirements,
  ExactProfile,
  ExactRequestAuthorization,
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

export type FundingSourceKind =
  "hot-wallet" | "vault-treasury" | "external-wallet-adapter";
export type ChannelStatus =
  "active" | "retired" | "refundable" | "refunded" | "suspicious";

export interface PublicIdentity {
  address: string;
  publicKey?: PublicKeyHex;
}

export interface FundingProviderUtxo {
  outpoint: FundingOutpoint;
  /** Stable KIP-20 covenant lineage reported by authoritative chain readback. */
  covenantId?: Hash32Hex;
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
  settledTotal: SompiString;
  fundingSource?: FundingSourceKind;
}

export interface FundingSuccessorIntent {
  outpoint: FundingOutpoint;
  covenantId: Hash32Hex;
  amount: SompiString;
  scriptPublicKey: ByteHex;
}

/** Exact signed genesis artifact prepared without broadcasting it. */
export interface PreparedEscrowDeposit {
  transaction: ByteHex;
  transactionId: Hash32Hex;
  successor: FundingSuccessorIntent;
  fundingSource?: FundingSourceKind;
}

export interface CovenantGenesisVerificationRequest {
  prepared: PreparedEscrowDeposit;
  utxo: FundingProviderUtxo;
}

export interface CovenantGenesisEvidence {
  covenantId: Hash32Hex;
  authorizingInput: FundingOutpoint;
  genesisOutpoint: FundingOutpoint;
  genesisScriptPublicKey: ByteHex;
  genesisAmount: SompiString;
  totalOutputCount: number;
  authorizedOutputCount: number;
}

export interface EscrowTopUpRequest {
  network: NetworkId;
  channel: DirectModeChannel;
  targetFundingAmount: SompiString;
  fundingSource?: FundingSourceKind;
}

/** Exact signed top-up artifact prepared without broadcasting it. */
export interface PreparedEscrowTopUp {
  transaction: ByteHex;
  transactionId: Hash32Hex;
  successor: FundingSuccessorIntent;
  fundingSource?: FundingSourceKind;
}

export interface CovenantTopUpEvidence {
  covenantId: Hash32Hex;
  spentOutpoint: FundingOutpoint;
  successorOutpoint: FundingOutpoint;
  successorScriptPublicKey: ByteHex;
  successorAmount: SompiString;
  authorizedSuccessorCount: number;
}

export interface ExactPaymentRequest {
  network: NetworkId;
  profile: ExactProfile;
  origin: string;
  resourceUrl: string;
  amount: SompiString;
  payTo: string;
  payToScriptPublicKey: ByteHex;
  paymentOutputIndex?: number;
  requestHash: Hash32Hex;
  paymentRequirementsHash: Hash32Hex;
  authorizationExpiresAt: string;
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
}

export interface ExactTransactionPaymentRequest extends ExactPaymentRequest {
  head?: NonNullable<ExactPaymentRequest["head"]>;
}

export interface ExactTransactionPaymentResult {
  transaction: string;
  transactionEncoding: ExactTransactionEncoding;
  transactionId: Hash32Hex;
  paymentOutputIndex: number;
  authorization: ExactRequestAuthorization;
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
  /** Explicit policy boundary invoked before any exact signing operation. */
  authorizeExactPayment(request: ExactTransactionPaymentRequest): Promise<void>;
  prepareEscrowDeposit(
    request: EscrowDepositRequest,
  ): Promise<PreparedEscrowDeposit>;
  prepareEscrowTopUp(request: EscrowTopUpRequest): Promise<PreparedEscrowTopUp>;
  payExactTransaction?(
    request: ExactTransactionPaymentRequest,
  ): Promise<ExactTransactionPaymentResult>;
  getUtxos(addresses: readonly string[]): Promise<FundingProviderUtxo[]>;
  /** Authoritative active-head lookup; successor covenant scripts may rotate addresses. */
  getUtxo(outpoint: FundingOutpoint): Promise<FundingProviderUtxo | null>;
  /** Recomputes and verifies the complete singleton KIP-20 genesis before pruning. */
  verifyCovenantGenesis(
    request: CovenantGenesisVerificationRequest,
  ): Promise<CovenantGenesisEvidence | null>;
  verifyCovenantTopUp(input: {
    previous: DirectModeChannel;
    prepared: PreparedEscrowTopUp;
    successor: FundingProviderUtxo;
  }): Promise<CovenantTopUpEvidence | null>;
  getVirtualDaaScore(): Promise<SompiString>;
  sendTransaction(transaction: ByteHex): Promise<SendTransactionResult>;
  estimateFees(request: FeeEstimateRequest): Promise<FeeEstimate>;
}

export interface FundingPolicy {
  requiredSource?: FundingSourceKind;
  allowedOrigins?: readonly string[];
  allowedExactProfiles?: readonly ExactProfile[];
  allowedPayTo?: readonly string[];
  maximumExactAmountSompi?: SompiString;
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
  /** Exact transaction-v1 input-0 SIGHASH_ALL digest prepared by the builder. */
  digest: Hash32Hex;
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
  covenantId: Hash32Hex;
  genesisEvidence: CovenantGenesisEvidence;
  lastTopUpEvidence?: CovenantTopUpEvidence;
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
  signedMaxClaimable: SompiString;
  latestVoucher?: Voucher;
  /** True until the current genesis/top-up head has been admitted by the server. */
  requiresDepositVoucher: boolean;
  refundTimeoutDaa: SompiString;
  templateId: "kaspa-x402-escrow-v2";
  status: ChannelStatus;
}

export interface GenesisChannelIntent {
  channelId: Hash32Hex;
  origin: string;
  resourceUrl?: string;
  config: ChannelConfig;
  clientPrivateKey?: string;
  escrowAddress: string;
  fundingSource: FundingSourceKind;
}

export type FundingTransitionAttemptStatus =
  | "pending"
  | "broadcast"
  | "applied";

interface FundingTransitionAttemptBase {
  channelId: Hash32Hex;
  transaction: ByteHex;
  transactionId: Hash32Hex;
  intendedSuccessor: FundingSuccessorIntent;
  fundingSource: FundingSourceKind;
  status: FundingTransitionAttemptStatus;
  finality?: "broadcast" | "accepted" | "confirmed";
}

/** Genesis is reserved before a channel or covenant head exists. */
export interface GenesisFundingTransitionAttempt
  extends FundingTransitionAttemptBase {
  kind: "genesis";
  intent: GenesisChannelIntent;
}

/** Top-up owns the exact persisted lane head until it is reconciled. */
export interface TopUpFundingTransitionAttempt
  extends FundingTransitionAttemptBase {
  kind: "top-up";
  expectedChannel: DirectModeChannel;
}

export type FundingTransitionAttemptRecord =
  | GenesisFundingTransitionAttempt
  | TopUpFundingTransitionAttempt;

export type FundingTransitionAttemptApplyRequest =
  | {
      kind: "genesis";
      channelId: Hash32Hex;
      transactionId: Hash32Hex;
      finality: "accepted" | "confirmed";
      evidence: CovenantGenesisEvidence;
    }
  | {
      kind: "top-up";
      channelId: Hash32Hex;
      transactionId: Hash32Hex;
      finality: "accepted" | "confirmed";
      evidence: CovenantTopUpEvidence;
    };

export interface FundingTransitionAttemptApplyResult {
  channel: DirectModeChannel;
  attempt: FundingTransitionAttemptRecord;
}

export type RefundAttemptStatus = "pending" | "broadcast" | "applied";

/** Durable, exact refund artifact captured before the first broadcast attempt. */
export interface RefundAttemptRecord {
  channelId: Hash32Hex;
  covenantId: Hash32Hex;
  activeOutpoint: FundingOutpoint;
  activeScriptPublicKey: ByteHex;
  fundingAmount: SompiString;
  channelStatus: ChannelStatus;
  refundAmount: SompiString;
  transaction: ByteHex;
  transactionId: Hash32Hex;
  status: RefundAttemptStatus;
  finality?: "broadcast" | "accepted" | "confirmed";
}

export interface RefundAttemptApplyRequest {
  channelId: Hash32Hex;
  transactionId: Hash32Hex;
  finality: "accepted" | "confirmed";
}

export interface RefundAttemptApplyResult {
  channel: DirectModeChannel;
  attempt: RefundAttemptRecord;
}

export interface ChannelStore {
  loadChannels(scope: ChannelLookupScope): Promise<DirectModeChannel[]>;
  saveChannel(channel: DirectModeChannel): Promise<void>;
  retireChannel(channelId: Hash32Hex, reason?: string): Promise<void>;
  deleteChannel(channelId: Hash32Hex): Promise<void>;
  listRefundableChannels(nowDaa?: SompiString): Promise<DirectModeChannel[]>;
  loadFundingTransitionAttempt(
    channelId: Hash32Hex,
  ): Promise<FundingTransitionAttemptRecord | undefined>;
  /** Lists unresolved transitions, optionally narrowed to one payment lane scope. */
  loadOpenFundingTransitionAttempts(
    scope?: ChannelLookupScope,
  ): Promise<FundingTransitionAttemptRecord[]>;
  /** Atomically reserves genesis or the exact current top-up head before broadcast. */
  claimFundingTransitionAttempt(
    attempt: FundingTransitionAttemptRecord,
  ): Promise<void>;
  /** Persists a broadcast-only observation without replacing the signed artifact. */
  saveFundingTransitionAttempt(
    attempt: FundingTransitionAttemptRecord,
  ): Promise<void>;
  /** Applies verified singleton successor evidence with an exact-id head CAS. */
  applyFundingTransitionAttempt(
    request: FundingTransitionAttemptApplyRequest,
  ): Promise<FundingTransitionAttemptApplyResult>;
  /** Releases an open attempt only after trusted evidence proves it safe to rebuild. */
  releaseFundingTransitionAttempt(
    channelId: Hash32Hex,
    transactionId: Hash32Hex,
  ): Promise<void>;
  loadRefundAttempt(
    channelId: Hash32Hex,
  ): Promise<RefundAttemptRecord | undefined>;
  /** Atomically reserves the captured channel head before any broadcast. */
  claimRefundAttempt(attempt: RefundAttemptRecord): Promise<void>;
  /** Persists a broadcast-only observation without replacing the reserved artifact. */
  saveRefundAttempt(attempt: RefundAttemptRecord): Promise<void>;
  /** Atomically compares the captured head, refunds the channel, and applies the attempt. */
  applyRefundAttempt(
    request: RefundAttemptApplyRequest,
  ): Promise<RefundAttemptApplyResult>;
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
  /** Effective response URL. Fetch adapters must expose this so paid flows can reject redirects. */
  url: string;
  /** True when the adapter followed a redirect. Paid flows require this to remain false. */
  redirected: boolean;
}

export interface HttpRequestInitLike {
  headers?: HeadersInitLike;
  method?: string;
  body?: unknown;
  redirect?: "error";
  paymentIdentifier?: string;
  requestHash?: Hash32Hex;
  [key: string]: unknown;
}

export type HeadersInitLike =
  | Record<string, string>
  | Array<[string, string]>
  | { entries(): IterableIterator<[string, string]> };
export type FetchLike = (
  input: string,
  init?: HttpRequestInitLike,
) => Promise<HttpResponseLike>;

export interface PaidFetchResult {
  response: HttpResponseLike;
  payment?: CreatePaymentResult;
  settlement?: ApplySettlementResult;
}

export interface RefundTransactionRequest {
  channel: DirectModeChannel;
  refundAmount: SompiString;
  /** Signs the exact transaction digest after the builder fixes every field. */
  signDigest(digest: Hash32Hex): Promise<SignatureHex>;
}

export interface RefundTransactionResult {
  transaction: ByteHex;
  /** Deterministic id of the exact signed transaction returned above. */
  transactionId: Hash32Hex;
  refundAmount: SompiString;
}

export interface RefundTransactionBuilder {
  buildRefundTransaction(
    request: RefundTransactionRequest,
  ): Promise<RefundTransactionResult>;
}

export interface RefundResult {
  channel: DirectModeChannel;
  refundAmount: SompiString;
  transactionId: Hash32Hex;
  finality: "broadcast" | "accepted" | "confirmed";
  accepted: boolean;
}

export type RefundReconciliation =
  | {
      status: "unknown";
      transactionId: Hash32Hex;
      reason?: string;
    }
  | {
      status: "accepted";
      transactionId: Hash32Hex;
      finality: "accepted" | "confirmed";
    };

/** Trusted chain lookup for one already-persisted refund transaction. */
export interface RefundReconciler {
  reconcileRefund(attempt: RefundAttemptRecord): Promise<RefundReconciliation>;
}

export interface RefundReconcileResult {
  channel: DirectModeChannel;
  refundAmount: SompiString;
  transactionId: Hash32Hex;
  finality: "unknown" | "accepted" | "confirmed";
  accepted: boolean;
}

export type FundingTransitionReconciliation =
  | {
      status: "unknown";
      transactionId: Hash32Hex;
      reason?: string;
    }
  | {
      /** Trusted proof that the exact artifact cannot become accepted. */
      status: "absent";
      transactionId: Hash32Hex;
      reason?: string;
    }
  | {
      status: "accepted";
      transactionId: Hash32Hex;
      finality: "accepted" | "confirmed";
    };

/** Trusted chain lookup for one already-persisted genesis or top-up artifact. */
export interface FundingTransitionReconciler {
  reconcileFundingTransition(
    attempt: FundingTransitionAttemptRecord,
  ): Promise<FundingTransitionReconciliation>;
}

export interface FundingTransitionReconcileResult {
  channelId: Hash32Hex;
  kind: "genesis" | "top-up";
  transactionId: Hash32Hex;
  finality: "unknown" | "absent" | "accepted" | "confirmed";
  accepted: boolean;
  channel?: DirectModeChannel;
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
  refundReconciler?: RefundReconciler;
  fundingTransitionReconciler?: FundingTransitionReconciler;
  verifyVoucherSignature?: (
    voucher: Voucher,
    channel: DirectModeChannel,
  ) => Promise<boolean> | boolean;
  maxPaymentRetries?: number;
  supportedSchemes?: readonly PaymentScheme[];
}
