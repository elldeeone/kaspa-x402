import { parseSompiString } from "./amount.js";
import { sha256Hex } from "./binary.js";
import { stableStringify } from "./stable-json.js";
import type {
  ByteHex,
  FundingOutpoint,
  Hash32Hex,
  NetworkId,
  SompiString,
} from "./types.js";

export const TESTNET_10_CONFIRMATION_THRESHOLD = 30;

export interface ChainCheckpoint {
  blockHash: Hash32Hex;
  blueScore: SompiString;
  daaScore: SompiString;
}

export interface AcceptedTransactionEvidence {
  status: "accepted";
  transactionId: Hash32Hex;
  acceptingBlockHash: Hash32Hex;
  acceptingBlockBlueScore: SompiString;
  /**
   * Authoritatively observed selected-parent distance from the selected-chain
   * tip, including the accepting block. This is deliberately independent of
   * blue-score delta, which is not selected-chain depth.
   */
  confirmationCount: number;
  checkpoint: ChainCheckpoint;
}

export interface ConflictingSpendAbsenceProof {
  kind: "confirmed-conflicting-spend";
  spentOutpoint: FundingOutpoint;
  conflictingTransaction: AcceptedTransactionEvidence;
}

export interface ConsensusRejectionAbsenceProof {
  kind: "consensus-rejection";
  /** Exact artifact rejected by the stable consensus result. */
  rejectedTransactionId: Hash32Hex;
  rejectionCode: string;
  checkpoint: ChainCheckpoint;
}

export interface AbsentTransactionEvidence {
  status: "absent";
  transactionId: Hash32Hex;
  reason: string;
  proof: ConflictingSpendAbsenceProof | ConsensusRejectionAbsenceProof;
}

export interface UnknownTransactionEvidence {
  status: "unknown";
  transactionId: Hash32Hex;
  reason: string;
  checkpoint?: ChainCheckpoint;
}

export type TrustedTransactionEvidence =
  | AcceptedTransactionEvidence
  | AbsentTransactionEvidence
  | UnknownTransactionEvidence;

export type ChainEvidenceDecision =
  | { status: "accepted"; evidence: AcceptedTransactionEvidence }
  | { status: "confirmed"; evidence: AcceptedTransactionEvidence }
  | { status: "absent"; evidence: AbsentTransactionEvidence }
  | { status: "unknown"; evidence: UnknownTransactionEvidence };

/**
 * Converts objective adapter evidence into policy. Adapters never declare a
 * transaction "confirmed"; that decision belongs to deployment policy.
 */
export function decideChainEvidence(
  evidence: TrustedTransactionEvidence,
  requiredConfirmations: number,
): ChainEvidenceDecision {
  assertConfirmationThreshold(requiredConfirmations);
  assertHash32(evidence.transactionId, "transaction evidence id");
  switch (evidence.status) {
    case "accepted": {
      assertAcceptedEvidence(evidence);
      return evidence.confirmationCount >= requiredConfirmations
        ? { status: "confirmed", evidence: structuredClone(evidence) }
        : { status: "accepted", evidence: structuredClone(evidence) };
    }
    case "absent":
      assertAbsentEvidence(evidence, requiredConfirmations);
      return { status: "absent", evidence: structuredClone(evidence) };
    case "unknown":
      if (!evidence.reason.trim()) {
        throw new Error("unknown chain evidence requires a reason");
      }
      if (evidence.checkpoint) assertCheckpoint(evidence.checkpoint);
      return { status: "unknown", evidence: structuredClone(evidence) };
    default:
      throw new Error("unsupported trusted chain evidence status");
  }
}

export interface CovenantLaunchManifest {
  format: "kaspa-x402-covenant-launch-v1";
  network: NetworkId;
  compiler: {
    name: string;
    checkedCommit: string;
    command: string;
  };
  source: {
    path: string;
    sha256: Hash32Hex;
  };
  bytecode: {
    templateId: string;
    compiledBaseSha256: Hash32Hex;
  };
  constructorSlots: Readonly<Record<string, unknown>>;
  abi: Readonly<Record<string, unknown>>;
  selectors: Readonly<Record<string, ByteHex>>;
  /** Digest of compiler, source, bytecode, slots, ABI, and selectors. */
  identitySha256: Hash32Hex;
  genesis: {
    derivation: "kip20-covenant-id-v1";
    covenantId: Hash32Hex;
    authorizingInput: FundingOutpoint;
    transactionId: Hash32Hex;
    outpoint: FundingOutpoint;
    scriptPublicKey: ByteHex;
    value: SompiString;
    claimedCumulativeAmount: SompiString;
    acceptance: AcceptedTransactionEvidence;
  };
}

export interface CovenantLineageHead {
  outpoint: FundingOutpoint;
  scriptPublicKey: ByteHex;
  value: SompiString;
  claimedCumulativeAmount: SompiString;
}

export interface CovenantLineageSuccessor extends CovenantLineageHead {
  covenantId: Hash32Hex;
  authorizingInput: number;
}

export interface CovenantTerminalOutput {
  index: number;
  scriptPublicKey: ByteHex;
  value: SompiString;
}

export interface CovenantLineageTransition {
  kind: "claim" | "top-up" | "refund";
  covenantId: Hash32Hex;
  templateId: string;
  consumedOutpoint: FundingOutpoint;
  transactionId: Hash32Hex;
  /** Exactly one for claim/top-up and zero for a terminal refund. */
  authorizedSuccessorCount: number;
  successor: CovenantLineageSuccessor | null;
  terminalOutput: CovenantTerminalOutput | null;
  acceptance: AcceptedTransactionEvidence;
}

export interface CovenantLineageAcceptedEvent {
  event: "accepted";
  sequence: number;
  transition: CovenantLineageTransition;
}

export interface CovenantLineageRemovedEvent {
  event: "removed";
  sequence: number;
  acceptingBlockHash: Hash32Hex;
  transactionIds: Hash32Hex[];
}

export interface CovenantLineageGenesisAcceptedEvent {
  event: "genesis-accepted";
  sequence: number;
  acceptance: AcceptedTransactionEvidence;
}

export type CovenantLineageEvent =
  | CovenantLineageAcceptedEvent
  | CovenantLineageGenesisAcceptedEvent
  | CovenantLineageRemovedEvent;

export interface CovenantLineageState {
  manifest: CovenantLaunchManifest;
  journal: CovenantLineageEvent[];
  /** Atomically derived from manifest + canonical journal events. */
  currentHead: CovenantLineageHead | null;
  checkpoint: ChainCheckpoint;
  availability: "available" | "unknown";
  unavailableReason?: string;
}

export interface SelectedChainBlock {
  blockHash: Hash32Hex;
  /** Present only when this block authoritatively reaccepts the manifest genesis. */
  genesisAcceptance?: AcceptedTransactionEvidence;
  transitions: CovenantLineageTransition[];
}

export interface CovenantSelectedChainUpdate {
  fromCheckpoint: ChainCheckpoint;
  checkpoint: ChainCheckpoint;
  continuity: "complete" | "pruned";
  /** High-to-low selected-chain removal order from Kaspa RPC. */
  removedChainBlockHashes: Hash32Hex[];
  /** Low-to-high selected-chain addition order from Kaspa RPC. */
  addedChainBlocks: SelectedChainBlock[];
}

export function createCovenantLineageState(
  manifest: CovenantLaunchManifest,
): CovenantLineageState {
  assertLaunchManifest(manifest);
  return {
    manifest: structuredClone(manifest),
    journal: [],
    currentHead: {
      outpoint: structuredClone(manifest.genesis.outpoint),
      scriptPublicKey: manifest.genesis.scriptPublicKey.toLowerCase(),
      value: manifest.genesis.value,
      claimedCumulativeAmount: manifest.genesis.claimedCumulativeAmount,
    },
    checkpoint: structuredClone(manifest.genesis.acceptance.checkpoint),
    availability: "available",
  };
}

/**
 * Applies one selected-chain delta. Removed blocks are journaled before added
 * blocks, and the current head is recomputed rather than accepted from a peer.
 */
export function applyCovenantSelectedChainUpdate(
  current: CovenantLineageState,
  update: CovenantSelectedChainUpdate,
): CovenantLineageState {
  assertLineageState(current);
  assertCheckpoint(update.fromCheckpoint);
  assertCheckpoint(update.checkpoint);
  if (!sameCheckpoint(current.checkpoint, update.fromCheckpoint)) {
    throw new Error("selected-chain update does not resume from durable checkpoint");
  }
  if (update.continuity === "pruned") {
    return {
      ...structuredClone(current),
      availability: "unknown",
      unavailableReason:
        "selected-chain continuity cannot be proven across the pruning horizon",
    };
  }
  if (update.continuity !== "complete") {
    throw new Error("selected-chain update continuity is invalid");
  }

  const next = structuredClone(current);
  let sequence = next.journal.length;
  const removed = new Set<string>();
  for (const hash of update.removedChainBlockHashes) {
    assertHash32(hash, "removed chain block hash");
    const normalized = hash.toLowerCase();
    if (removed.has(normalized)) {
      throw new Error("selected-chain update repeats a removed block");
    }
    removed.add(normalized);
    const transactionIds = canonicalAcceptedEvents(next.journal)
      .filter(
        ({ transition }) =>
          transition.acceptance.acceptingBlockHash.toLowerCase() === normalized,
      )
      .map(({ transition }) => transition.transactionId.toLowerCase());
    const genesisAcceptance = canonicalGenesisAcceptance(next);
    if (
      genesisAcceptance?.acceptingBlockHash.toLowerCase() === normalized
    ) {
      transactionIds.push(next.manifest.genesis.transactionId.toLowerCase());
    }
    next.journal.push({
      event: "removed",
      sequence: sequence++,
      acceptingBlockHash: normalized,
      transactionIds,
    });
  }

  // Re-derive immediately after removals. Added blocks may only extend this
  // rolled-back head, never the stale pre-reorg index.
  deriveCanonicalLineage(next);

  const addedBlocks = new Set<string>();
  const spends = new Set<string>();
  for (const block of update.addedChainBlocks) {
    assertHash32(block.blockHash, "added chain block hash");
    const blockHash = block.blockHash.toLowerCase();
    if (addedBlocks.has(blockHash)) {
      throw new Error("selected-chain update repeats an added block");
    }
    addedBlocks.add(blockHash);
    if (block.genesisAcceptance) {
      assertAcceptedEvidence(block.genesisAcceptance);
      if (
        block.genesisAcceptance.transactionId.toLowerCase() !==
          next.manifest.genesis.transactionId.toLowerCase() ||
        block.genesisAcceptance.acceptingBlockHash.toLowerCase() !== blockHash ||
        !sameCheckpoint(block.genesisAcceptance.checkpoint, update.checkpoint)
      ) {
        throw new Error("reaccepted covenant genesis evidence is inconsistent");
      }
      if (canonicalGenesisAcceptance(next)) {
        throw new Error("selected-chain update repeats an accepted covenant genesis");
      }
      next.journal.push({
        event: "genesis-accepted",
        sequence: sequence++,
        acceptance: structuredClone(block.genesisAcceptance),
      });
      deriveCanonicalLineage(next);
    }
    for (const transition of block.transitions) {
      assertLineageTransition(next.manifest, transition);
      if (
        transition.acceptance.acceptingBlockHash.toLowerCase() !== blockHash
      ) {
        throw new Error("lineage transition accepting block is inconsistent");
      }
      if (!sameCheckpoint(transition.acceptance.checkpoint, update.checkpoint)) {
        throw new Error("lineage transition checkpoint is inconsistent");
      }
      const spentKey = outpointKey(transition.consumedOutpoint);
      if (spends.has(spentKey)) {
        throw new Error(
          "selected-chain update contains branching covenant spends",
        );
      }
      spends.add(spentKey);
      next.journal.push({
        event: "accepted",
        sequence: sequence++,
        transition: structuredClone(transition),
      });
      // Validate each step against the head produced by all preceding steps.
      deriveCanonicalLineage(next);
    }
  }

  next.checkpoint = structuredClone(update.checkpoint);
  deriveCanonicalLineage(next);
  if (canonicalGenesisAcceptance(next)) {
    next.availability = "available";
    delete next.unavailableReason;
  } else {
    next.availability = "unknown";
    next.unavailableReason =
      "covenant genesis was removed from the selected chain and has not been authoritatively reaccepted";
  }
  return next;
}

export function canonicalCovenantTransitions(
  state: CovenantLineageState,
): CovenantLineageTransition[] {
  assertLineageState(state);
  return canonicalAcceptedEvents(state.journal).map(({ transition }) =>
    structuredClone(transition),
  );
}

export function assertCovenantLineageConfirmed(
  state: CovenantLineageState,
  requiredConfirmations: number,
): void {
  assertLineageState(state);
  if (state.availability !== "available") {
    throw new Error(state.unavailableReason ?? "covenant lineage is unavailable");
  }
  const genesisAcceptance = canonicalGenesisAcceptance(state);
  if (!genesisAcceptance) {
    throw new Error("covenant genesis is not on the selected chain");
  }
  const evidence = [
    genesisAcceptance,
    ...canonicalAcceptedEvents(state.journal).map(
      ({ transition }) => transition.acceptance,
    ),
  ];
  for (const item of evidence) {
    if (decideChainEvidence(item, requiredConfirmations).status !== "confirmed") {
      throw new Error("covenant lineage has not reached the configured confirmation threshold");
    }
  }
}

export interface CovenantLineageStore {
  loadCovenantLineage(): Promise<CovenantLineageState>;
  saveCovenantLineage(
    expectedCheckpoint: ChainCheckpoint,
    state: CovenantLineageState,
  ): Promise<void>;
}

export interface CovenantSelectedChainSource {
  selectedChainFrom(input: {
    checkpoint: ChainCheckpoint;
    minConfirmationCount: number;
  }): Promise<CovenantSelectedChainUpdate>;
}

/** Resumes exclusively from the durable checkpoint and saves state by CAS. */
export class CovenantChainObserver {
  readonly #store: CovenantLineageStore;
  readonly #source: CovenantSelectedChainSource;
  readonly #requiredConfirmations: number;

  constructor(input: {
    store: CovenantLineageStore;
    source: CovenantSelectedChainSource;
    requiredConfirmations: number;
  }) {
    assertConfirmationThreshold(input.requiredConfirmations);
    this.#store = input.store;
    this.#source = input.source;
    this.#requiredConfirmations = input.requiredConfirmations;
  }

  async synchronize(): Promise<CovenantLineageState> {
    const current = await this.#store.loadCovenantLineage();
    const update = await this.#source.selectedChainFrom({
      checkpoint: structuredClone(current.checkpoint),
      minConfirmationCount: this.#requiredConfirmations,
    });
    const next = applyCovenantSelectedChainUpdate(current, update);
    await this.#store.saveCovenantLineage(current.checkpoint, next);
    return structuredClone(next);
  }
}

function assertLaunchManifest(manifest: CovenantLaunchManifest): void {
  if (manifest.format !== "kaspa-x402-covenant-launch-v1") {
    throw new Error("covenant launch manifest format is invalid");
  }
  if (manifest.network !== "kaspa:testnet-10" && manifest.network !== "kaspa:mainnet") {
    throw new Error("covenant launch manifest network is invalid");
  }
  if (!/^[0-9a-fA-F]{40}$/.test(manifest.compiler.checkedCommit)) {
    throw new Error("compiler checked commit must be a 20-byte git object id");
  }
  assertHash32(manifest.source.sha256, "covenant source hash");
  assertHash32(manifest.bytecode.compiledBaseSha256, "compiled bytecode hash");
  if (
    !manifest.compiler.name?.trim() ||
    !manifest.compiler.command?.trim() ||
    !manifest.source.path?.trim()
  ) {
    throw new Error("covenant launch manifest build identity is incomplete");
  }
  if (
    !manifest.bytecode.templateId?.trim() ||
    !isRecord(manifest.constructorSlots) ||
    Object.keys(manifest.constructorSlots).length === 0 ||
    !isRecord(manifest.abi) ||
    Object.keys(manifest.abi).length === 0 ||
    !isRecord(manifest.selectors) ||
    Object.keys(manifest.selectors).length === 0
  ) {
    throw new Error("covenant launch manifest template identity is incomplete");
  }
  assertHash32(manifest.identitySha256, "covenant launch identity hash");
  const computedIdentity = sha256Hex(
    stableStringify({
      compiler: manifest.compiler,
      source: manifest.source,
      bytecode: manifest.bytecode,
      constructorSlots: manifest.constructorSlots,
      abi: manifest.abi,
      selectors: manifest.selectors,
    }),
  );
  if (computedIdentity !== manifest.identitySha256.toLowerCase()) {
    throw new Error("covenant launch identity hash is inconsistent");
  }
  for (const [name, selector] of Object.entries(manifest.selectors)) {
    if (!name.trim()) {
      throw new Error("covenant launch manifest selector name is invalid");
    }
    if (typeof selector !== "string") {
      throw new Error(`covenant selector ${name} must be non-empty byte hex`);
    }
    assertByteHex(selector, `covenant selector ${name}`);
  }
  if (manifest.genesis.derivation !== "kip20-covenant-id-v1") {
    throw new Error("covenant launch manifest genesis derivation is invalid");
  }
  assertHash32(manifest.genesis.covenantId, "genesis covenant id", true);
  assertHash32(manifest.genesis.transactionId, "genesis transaction id");
  assertOutpoint(manifest.genesis.authorizingInput, "genesis authorizing input");
  assertOutpoint(manifest.genesis.outpoint, "genesis outpoint");
  if (
    manifest.genesis.outpoint.txid.toLowerCase() !==
      manifest.genesis.transactionId.toLowerCase() ||
    manifest.genesis.acceptance.transactionId.toLowerCase() !==
      manifest.genesis.transactionId.toLowerCase()
  ) {
    throw new Error("covenant launch manifest genesis transaction is inconsistent");
  }
  assertByteHex(manifest.genesis.scriptPublicKey, "genesis script public key");
  parseSompiString(manifest.genesis.value);
  parseSompiString(manifest.genesis.claimedCumulativeAmount);
  assertAcceptedEvidence(manifest.genesis.acceptance);
}

function assertLineageState(state: CovenantLineageState): void {
  assertLaunchManifest(state.manifest);
  assertCheckpoint(state.checkpoint);
  if (state.availability !== "available" && state.availability !== "unknown") {
    throw new Error("covenant lineage availability is invalid");
  }
  for (const [index, event] of state.journal.entries()) {
    if (event.sequence !== index) {
      throw new Error("covenant lineage journal sequence is not append-only");
    }
    if (event.event === "accepted") {
      assertLineageTransition(state.manifest, event.transition);
    } else if (event.event === "genesis-accepted") {
      assertAcceptedEvidence(event.acceptance);
      if (
        event.acceptance.transactionId.toLowerCase() !==
        state.manifest.genesis.transactionId.toLowerCase()
      ) {
        throw new Error("covenant genesis reacceptance transaction is inconsistent");
      }
    } else if (event.event === "removed") {
      assertHash32(event.acceptingBlockHash, "removed accepting block hash");
      for (const id of event.transactionIds) assertHash32(id, "removed transaction id");
    } else {
      throw new Error("covenant lineage journal event is invalid");
    }
  }
  const derived = structuredClone(state);
  deriveCanonicalLineage(derived);
  if (!sameLineageHead(derived.currentHead, state.currentHead)) {
    throw new Error("covenant current head is not the derived journal index");
  }
  if (state.availability === "available" && !canonicalGenesisAcceptance(state)) {
    throw new Error("available covenant lineage is missing its canonical genesis");
  }
}

function assertLineageTransition(
  manifest: CovenantLaunchManifest,
  transition: CovenantLineageTransition,
): void {
  assertHash32(transition.covenantId, "lineage covenant id", true);
  assertHash32(transition.transactionId, "lineage transaction id");
  assertOutpoint(transition.consumedOutpoint, "consumed outpoint");
  assertAcceptedEvidence(transition.acceptance);
  if (
    transition.covenantId.toLowerCase() !==
      manifest.genesis.covenantId.toLowerCase() ||
    transition.templateId !== manifest.bytecode.templateId
  ) {
    throw new Error("lineage transition belongs to the wrong covenant or template");
  }
  if (
    transition.acceptance.transactionId.toLowerCase() !==
    transition.transactionId.toLowerCase()
  ) {
    throw new Error("lineage acceptance transaction id is inconsistent");
  }
  if (transition.kind === "refund") {
    if (
      transition.authorizedSuccessorCount !== 0 ||
      transition.successor !== null ||
      transition.terminalOutput === null
    ) {
      throw new Error("terminal refund must have no covenant successor");
    }
    assertTerminalOutput(transition.terminalOutput);
    return;
  }
  if (
    (transition.kind !== "claim" && transition.kind !== "top-up") ||
    transition.authorizedSuccessorCount !== 1 ||
    transition.successor === null ||
    transition.terminalOutput !== null
  ) {
    throw new Error("non-terminal covenant transition must have one unique successor");
  }
  const successor = transition.successor;
  assertOutpoint(successor.outpoint, "covenant successor outpoint");
  assertByteHex(successor.scriptPublicKey, "covenant successor script");
  assertHash32(successor.covenantId, "successor covenant id", true);
  if (
    successor.outpoint.txid.toLowerCase() !==
      transition.transactionId.toLowerCase() ||
    successor.covenantId.toLowerCase() !== transition.covenantId.toLowerCase() ||
    !Number.isSafeInteger(successor.authorizingInput) ||
    successor.authorizingInput < 0 ||
    successor.authorizingInput > 0xffff_ffff
  ) {
    throw new Error("covenant successor binding is inconsistent");
  }
  parseSompiString(successor.value);
  parseSompiString(successor.claimedCumulativeAmount);
}

function deriveCanonicalLineage(state: CovenantLineageState): void {
  const genesis = state.manifest.genesis;
  const genesisAcceptance = canonicalGenesisAcceptance(state);
  let head: CovenantLineageHead | null = genesisAcceptance ? {
    outpoint: structuredClone(genesis.outpoint),
    scriptPublicKey: genesis.scriptPublicKey.toLowerCase(),
    value: genesis.value,
    claimedCumulativeAmount: genesis.claimedCumulativeAmount,
  } : null;
  const seenTransactions = new Set<string>();
  for (const { transition } of canonicalAcceptedEvents(state.journal)) {
    const transactionId = transition.transactionId.toLowerCase();
    if (seenTransactions.has(transactionId)) {
      throw new Error("canonical covenant lineage repeats a transaction");
    }
    seenTransactions.add(transactionId);
    if (!head || !sameOutpoint(head.outpoint, transition.consumedOutpoint)) {
      throw new Error("covenant lineage is missing a unique predecessor");
    }
    if (transition.kind === "refund") {
      if (
        parseSompiString(transition.terminalOutput!.value) >
        parseSompiString(head.value)
      ) {
        throw new Error("refund terminal output exceeds the consumed value");
      }
      head = null;
      continue;
    }
    const successor = transition.successor!;
    const priorValue = parseSompiString(head.value);
    const nextValue = parseSompiString(successor.value);
    const priorClaimed = parseSompiString(head.claimedCumulativeAmount);
    const nextClaimed = parseSompiString(successor.claimedCumulativeAmount);
    if (transition.kind === "claim") {
      if (
        nextValue >= priorValue ||
        nextClaimed <= priorClaimed ||
        priorValue - nextValue !== nextClaimed - priorClaimed
      ) {
        throw new Error("claim successor has inconsistent value or covenant state");
      }
    } else if (nextValue <= priorValue || nextClaimed !== priorClaimed) {
      throw new Error("top-up successor has inconsistent value or covenant state");
    }
    head = {
      outpoint: structuredClone(successor.outpoint),
      scriptPublicKey: successor.scriptPublicKey.toLowerCase(),
      value: successor.value,
      claimedCumulativeAmount: successor.claimedCumulativeAmount,
    };
  }
  state.currentHead = head;
}

function canonicalAcceptedEvents(
  journal: readonly CovenantLineageEvent[],
): CovenantLineageAcceptedEvent[] {
  const active: CovenantLineageAcceptedEvent[] = [];
  for (const event of journal) {
    if (event.event === "accepted") {
      active.push(event);
      continue;
    }
    if (event.event === "genesis-accepted") continue;
    const removedIds = new Set(event.transactionIds.map((id) => id.toLowerCase()));
    for (let index = active.length - 1; index >= 0; index -= 1) {
      const candidate = active[index]!;
      if (
        candidate.transition.acceptance.acceptingBlockHash.toLowerCase() ===
          event.acceptingBlockHash.toLowerCase() &&
        removedIds.has(candidate.transition.transactionId.toLowerCase())
      ) {
        active.splice(index, 1);
      }
    }
  }
  return active;
}

function canonicalGenesisAcceptance(
  state: Pick<CovenantLineageState, "manifest" | "journal">,
): AcceptedTransactionEvidence | undefined {
  const transactionId = state.manifest.genesis.transactionId.toLowerCase();
  let active: AcceptedTransactionEvidence | undefined =
    state.manifest.genesis.acceptance;
  for (const event of state.journal) {
    if (event.event === "genesis-accepted") {
      active = event.acceptance;
      continue;
    }
    if (
      event.event === "removed" &&
      active?.acceptingBlockHash.toLowerCase() ===
        event.acceptingBlockHash.toLowerCase() &&
      event.transactionIds.some((id) => id.toLowerCase() === transactionId)
    ) {
      active = undefined;
    }
  }
  return active ? structuredClone(active) : undefined;
}

function assertAcceptedEvidence(evidence: AcceptedTransactionEvidence): void {
  assertHash32(evidence.transactionId, "accepted transaction id");
  assertHash32(evidence.acceptingBlockHash, "accepting block hash");
  assertCheckpoint(evidence.checkpoint);
  const acceptingBlueScore = parseSompiString(evidence.acceptingBlockBlueScore);
  const checkpointBlueScore = parseSompiString(evidence.checkpoint.blueScore);
  if (
    !Number.isSafeInteger(evidence.confirmationCount) ||
    evidence.confirmationCount < 1 ||
    checkpointBlueScore < acceptingBlueScore
  ) {
    throw new Error("accepted transaction confirmation evidence is inconsistent");
  }
  if (
    evidence.acceptingBlockHash.toLowerCase() ===
      evidence.checkpoint.blockHash.toLowerCase() &&
    (acceptingBlueScore !== checkpointBlueScore || evidence.confirmationCount !== 1)
  ) {
    throw new Error("accepting block cannot differ from its identical checkpoint");
  }
}

function assertAbsentEvidence(
  evidence: AbsentTransactionEvidence,
  requiredConfirmations: number,
): void {
  if (!evidence.reason.trim()) {
    throw new Error("absent chain evidence requires a reason");
  }
  if (evidence.proof.kind === "confirmed-conflicting-spend") {
    assertOutpoint(evidence.proof.spentOutpoint, "conflicting spent outpoint");
    const decision = decideChainEvidence(
      evidence.proof.conflictingTransaction,
      requiredConfirmations,
    );
    if (
      decision.status !== "confirmed" ||
      evidence.proof.conflictingTransaction.transactionId.toLowerCase() ===
        evidence.transactionId.toLowerCase()
    ) {
      throw new Error("absent evidence needs a distinct confirmed conflicting spend");
    }
    return;
  }
  if (evidence.proof.kind === "consensus-rejection") {
    assertHash32(
      evidence.proof.rejectedTransactionId,
      "consensus rejected transaction id",
    );
    if (
      evidence.proof.rejectedTransactionId.toLowerCase() !==
      evidence.transactionId.toLowerCase()
    ) {
      throw new Error("consensus rejection is not bound to the absent transaction");
    }
    if (!/^[A-Z0-9_]{3,64}$/.test(evidence.proof.rejectionCode)) {
      throw new Error("consensus rejection evidence requires a stable rejection code");
    }
    assertCheckpoint(evidence.proof.checkpoint);
    return;
  }
  throw new Error("unsupported permanent-absence proof");
}

function assertCheckpoint(checkpoint: ChainCheckpoint): void {
  assertHash32(checkpoint.blockHash, "chain checkpoint block hash");
  parseSompiString(checkpoint.blueScore);
  parseSompiString(checkpoint.daaScore);
}

function assertConfirmationThreshold(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("confirmation threshold must be a positive safe integer");
  }
}

function assertOutpoint(outpoint: FundingOutpoint, label: string): void {
  assertHash32(outpoint.txid, `${label} transaction id`);
  if (
    !Number.isSafeInteger(outpoint.index) ||
    outpoint.index < 0 ||
    outpoint.index > 0xffff_ffff
  ) {
    throw new Error(`${label} index is invalid`);
  }
}

function assertTerminalOutput(output: CovenantTerminalOutput): void {
  if (
    !Number.isSafeInteger(output.index) ||
    output.index < 0 ||
    output.index > 0xffff_ffff
  ) {
    throw new Error("terminal output index is invalid");
  }
  assertByteHex(output.scriptPublicKey, "terminal output script");
  if (parseSompiString(output.value) <= 0n) {
    throw new Error("terminal output value must be positive");
  }
}

function assertByteHex(value: string, label: string): void {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(value)) {
    throw new Error(`${label} must be non-empty byte hex`);
  }
}

function assertHash32(value: string, label: string, nonzero = false): void {
  if (
    !/^[0-9a-fA-F]{64}$/.test(value) ||
    (nonzero && /^0{64}$/i.test(value))
  ) {
    throw new Error(`${label} must be ${nonzero ? "non-zero " : ""}32-byte hex`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameOutpoint(left: FundingOutpoint, right: FundingOutpoint): boolean {
  return (
    left.txid.toLowerCase() === right.txid.toLowerCase() &&
    left.index === right.index
  );
}

function outpointKey(outpoint: FundingOutpoint): string {
  return `${outpoint.txid.toLowerCase()}:${outpoint.index}`;
}

function sameCheckpoint(left: ChainCheckpoint, right: ChainCheckpoint): boolean {
  return (
    left.blockHash.toLowerCase() === right.blockHash.toLowerCase() &&
    left.blueScore === right.blueScore &&
    left.daaScore === right.daaScore
  );
}

function sameLineageHead(
  left: CovenantLineageHead | null,
  right: CovenantLineageHead | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    sameOutpoint(left.outpoint, right.outpoint) &&
    left.scriptPublicKey.toLowerCase() === right.scriptPublicKey.toLowerCase() &&
    left.value === right.value &&
    left.claimedCumulativeAmount === right.claimedCumulativeAmount
  );
}
