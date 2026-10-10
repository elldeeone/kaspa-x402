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
export const MAX_LINEAGE_REMOVED_BLOCKS = 32;
export const MAX_LINEAGE_UPDATE_EVENTS = 64;
export const MAX_LINEAGE_JOURNAL_EVENTS = 128;
export const MAX_LINEAGE_STATE_BYTES = 512 * 1024;
export const MAX_LINEAGE_UPDATE_BYTES = 128 * 1024;

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
  /** Authenticated base of the retained reorganization window. */
  anchor: {
    compactedEvents: number;
    head: CovenantLineageHead | null;
    genesisAcceptance?: AcceptedTransactionEvidence;
    tipTransition?: CovenantLineageTransition;
    manifestIdentitySha256: Hash32Hex;
    checkpointBlockHash: Hash32Hex;
    historyHash: Hash32Hex;
    snapshotHash: Hash32Hex;
    /** Fixed-size conservative filter for older relevant accepting blocks. */
    relevantBlocksBloom: string;
  };
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
  if (serializedBytes(manifest) > MAX_LINEAGE_STATE_BYTES - 4_096)
    throw new Error("covenant launch manifest exceeds the lineage byte limit");
  assertLaunchManifest(manifest);
  const head = {
    outpoint: structuredClone(manifest.genesis.outpoint),
    scriptPublicKey: manifest.genesis.scriptPublicKey.toLowerCase(),
    value: manifest.genesis.value,
    claimedCumulativeAmount: manifest.genesis.claimedCumulativeAmount,
  };
  const anchor = makeLineageAnchor({
    compactedEvents: 0,
    head,
    genesisAcceptance: structuredClone(manifest.genesis.acceptance),
    manifestIdentitySha256: manifest.identitySha256,
    checkpointBlockHash: manifest.genesis.acceptance.checkpoint.blockHash,
    historyHash: sha256Hex(stableStringify({ genesis: manifest.identitySha256 })),
    relevantBlocksBloom: "00".repeat(256),
  });
  const state: CovenantLineageState = {
    manifest: structuredClone(manifest),
    anchor,
    journal: [],
    currentHead: structuredClone(head),
    checkpoint: structuredClone(manifest.genesis.acceptance.checkpoint),
    availability: "available",
  };
  assertLineageBudget(state);
  return state;
}

/**
 * Applies one selected-chain delta. Removed blocks are journaled before added
 * blocks, and the current head is recomputed rather than accepted from a peer.
 */
export function applyCovenantSelectedChainUpdate(
  current: CovenantLineageState,
  update: CovenantSelectedChainUpdate,
): CovenantLineageState {
  if (update.removedChainBlockHashes.length > MAX_LINEAGE_REMOVED_BLOCKS) {
    throw new Error("selected-chain removed block count exceeds the limit");
  }
  const additions = update.addedChainBlocks.reduce(
    (count, block) => count + block.transitions.length + (block.genesisAcceptance ? 1 : 0), 0,
  );
  const updateBytes = serializedBytes(update);
  if (additions + update.removedChainBlockHashes.length > MAX_LINEAGE_UPDATE_EVENTS ||
    updateBytes > MAX_LINEAGE_UPDATE_BYTES) {
    throw new Error("selected-chain update exceeds the event or byte limit");
  }
  // Reject projected work before the validation path clones or derives state.
  assertLineageBudget(current);
  if (current.journal.length + additions + update.removedChainBlockHashes.length >
      MAX_LINEAGE_JOURNAL_EVENTS ||
      serializedBytes(current) + updateBytes > MAX_LINEAGE_STATE_BYTES) {
    throw new Error("projected covenant lineage exceeds the event or byte limit");
  }
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
  const acceptedByBlock = new Map<string, string[]>();
  for (const { transition } of canonicalAcceptedEvents(next.journal)) {
    const hash = transition.acceptance.acceptingBlockHash.toLowerCase();
    const ids = acceptedByBlock.get(hash) ?? [];
    ids.push(transition.transactionId.toLowerCase());
    acceptedByBlock.set(hash, ids);
  }
  const genesisAcceptance = canonicalGenesisAcceptance(next);
  for (const hash of update.removedChainBlockHashes) {
    assertHash32(hash, "removed chain block hash");
    const normalized = hash.toLowerCase();
    if (removed.has(normalized)) {
      throw new Error("selected-chain update repeats a removed block");
    }
    removed.add(normalized);
    const transactionIds = [...(acceptedByBlock.get(normalized) ?? [])];
    if (
      genesisAcceptance?.acceptingBlockHash.toLowerCase() === normalized
    ) {
      transactionIds.push(next.manifest.genesis.transactionId.toLowerCase());
    }
    if (transactionIds.length === 0) {
      if (bloomContains(next.anchor.relevantBlocksBloom, normalized)) {
        return {
          ...structuredClone(current),
          availability: "unknown",
          unavailableReason: "selected-chain removal exceeds the compact reorganization window",
        };
      }
      continue;
    }
    if (next.anchor.compactedEvents > 0 &&
      transactionIds.includes(next.manifest.genesis.transactionId.toLowerCase())) {
      return {
        ...structuredClone(current),
        availability: "unknown",
        unavailableReason: "covenant genesis removal exceeds the compact reorganization window",
      };
    }
    next.journal.push({
      event: "removed",
      sequence: sequence++,
      acceptingBlockHash: normalized,
      transactionIds,
    });
  }

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
    }
  }

  next.checkpoint = structuredClone(update.checkpoint);
  compactLineage(next);
  deriveCanonicalLineage(next);
  assertLineageBudget(next);
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

/** Verify a durable lineage replacement, including a compacted journal prefix. */
export function assertCovenantLineageExtension(
  previous: CovenantLineageState,
  next: CovenantLineageState,
): void {
  const reject = (): never => {
    throw new Error("covenant lineage journal is not append-only");
  };
  const compacted = next.anchor.compactedEvents - previous.anchor.compactedEvents;
  if (!Number.isSafeInteger(compacted) || compacted < 0 ||
    compacted > previous.journal.length) reject();
  const retained = previous.journal.slice(compacted);
  if (next.journal.length < retained.length) reject();
  for (const [index, event] of retained.entries()) {
    if (stableStringify({ ...event, sequence: index }) !==
      stableStringify(next.journal[index])) reject();
  }
  if (compacted === 0) {
    if (stableStringify(previous.anchor) !== stableStringify(next.anchor)) reject();
    return;
  }
  let expectedAnchor: CovenantLineageState["anchor"] | undefined;
  try {
    expectedAnchor = compactedLineageAnchor(
      previous,
      previous.journal.slice(0, compacted),
      next.checkpoint.blockHash,
    );
  } catch {
    reject();
  }
  if (!expectedAnchor ||
    stableStringify(expectedAnchor) !== stableStringify(next.anchor)) reject();
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
  assertLineageBudget(state);
  assertLaunchManifest(state.manifest);
  if (!state.anchor ||
    !Number.isSafeInteger(state.anchor.compactedEvents) ||
    state.anchor.compactedEvents < 0 ||
    !/^[0-9a-f]{512}$/.test(state.anchor.relevantBlocksBloom) ||
    state.anchor.snapshotHash !== makeLineageAnchor(state.anchor).snapshotHash) {
    throw new Error("covenant lineage compact checkpoint is invalid");
  }
  if (state.anchor.manifestIdentitySha256 !== state.manifest.identitySha256 ||
    !/^[0-9a-f]{64}$/.test(state.anchor.checkpointBlockHash)) {
    throw new Error("covenant lineage compact checkpoint is detached from the manifest");
  }
  if (state.anchor.tipTransition) {
    assertLineageTransition(state.manifest, state.anchor.tipTransition);
    const tip = state.anchor.tipTransition.successor;
    const tipHead = tip ? {
      outpoint: tip.outpoint,
      scriptPublicKey: tip.scriptPublicKey,
      value: tip.value,
      claimedCumulativeAmount: tip.claimedCumulativeAmount,
    } : null;
    if (!sameLineageHead(tipHead, state.anchor.head))
      throw new Error("covenant lineage compact head lacks its accepted tip witness");
  } else {
    const genesis = state.manifest.genesis;
    const genesisHead = state.anchor.genesisAcceptance ? {
      outpoint: genesis.outpoint,
      scriptPublicKey: genesis.scriptPublicKey,
      value: genesis.value,
      claimedCumulativeAmount: genesis.claimedCumulativeAmount,
    } : null;
    if (!sameLineageHead(genesisHead, state.anchor.head))
      throw new Error("covenant lineage compact genesis head is invalid");
  }
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
  const genesisAcceptance = canonicalGenesisAcceptance(state);
  let head: CovenantLineageHead | null = state.anchor.genesisAcceptance
    ? structuredClone(state.anchor.head)
    : genesisAcceptance ? {
      outpoint: structuredClone(state.manifest.genesis.outpoint),
      scriptPublicKey: state.manifest.genesis.scriptPublicKey.toLowerCase(),
      value: state.manifest.genesis.value,
      claimedCumulativeAmount: state.manifest.genesis.claimedCumulativeAmount,
    } : null;
  if (!genesisAcceptance) head = null;
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
  const active = new Map<string, CovenantLineageAcceptedEvent>();
  for (const event of journal) {
    if (event.event === "accepted") {
      const id = event.transition.transactionId.toLowerCase();
      if (active.has(id))
        throw new Error("canonical covenant lineage repeats a transaction");
      active.set(id, event);
      continue;
    }
    if (event.event === "genesis-accepted") continue;
    for (const id of event.transactionIds) {
      const key = id.toLowerCase();
      const candidate = active.get(key);
      if (candidate && candidate.transition.acceptance.acceptingBlockHash.toLowerCase() ===
          event.acceptingBlockHash.toLowerCase()) {
        active.delete(key);
      }
    }
  }
  return Array.from(active.values());
}

function canonicalGenesisAcceptance(
  state: Pick<CovenantLineageState, "manifest" | "anchor" | "journal">,
): AcceptedTransactionEvidence | undefined {
  const transactionId = state.manifest.genesis.transactionId.toLowerCase();
  let active: AcceptedTransactionEvidence | undefined =
    state.anchor.genesisAcceptance;
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

function makeLineageAnchor(
  input: Omit<CovenantLineageState["anchor"], "snapshotHash">,
): CovenantLineageState["anchor"] {
  const data = {
    compactedEvents: input.compactedEvents,
    head: input.head,
    ...(input.genesisAcceptance ? { genesisAcceptance: input.genesisAcceptance } : {}),
    ...(input.tipTransition ? { tipTransition: input.tipTransition } : {}),
    manifestIdentitySha256: input.manifestIdentitySha256,
    checkpointBlockHash: input.checkpointBlockHash,
    historyHash: input.historyHash,
    relevantBlocksBloom: input.relevantBlocksBloom,
  };
  return { ...data, snapshotHash: sha256Hex(stableStringify(data)) };
}

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function assertLineageBudget(state: CovenantLineageState): void {
  if (state.journal.length > MAX_LINEAGE_JOURNAL_EVENTS ||
    serializedBytes(state) > MAX_LINEAGE_STATE_BYTES) {
    throw new Error("covenant lineage state exceeds the event or byte limit");
  }
}

function bloomIndexes(blockHash: string): number[] {
  return [0, 1, 2, 3].map((salt) =>
    parseInt(sha256Hex(`${salt}:${blockHash.toLowerCase()}`).slice(0, 8), 16) % 2048,
  );
}

function bloomContains(bloom: string, blockHash: string): boolean {
  return bloomIndexes(blockHash).every((index) =>
    (parseInt(bloom.slice((index >> 3) * 2, (index >> 3) * 2 + 2), 16) &
      (1 << (index & 7))) !== 0,
  );
}

function bloomAdd(bloom: string, blockHash: string): string {
  const bytes = Array.from({ length: 256 }, (_, index) =>
    parseInt(bloom.slice(index * 2, index * 2 + 2), 16),
  );
  for (const index of bloomIndexes(blockHash)) bytes[index >> 3]! |= 1 << (index & 7);
  return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function compactLineage(state: CovenantLineageState): void {
  if (state.journal.length <= 64) return;
  let cutoff = state.journal.length - 64;
  const suffixRemovals = new Set(
    state.journal.slice(cutoff).flatMap((event) =>
      event.event === "removed" ? event.transactionIds.map((id) => id.toLowerCase()) : []),
  );
  for (let index = 0; index < cutoff; index++) {
    const event = state.journal[index]!;
    if (event.event === "accepted" &&
      suffixRemovals.has(event.transition.transactionId.toLowerCase())) {
      cutoff = index;
      break;
    }
  }
  if (cutoff === 0) return;
  const prefix = state.journal.slice(0, cutoff);
  state.anchor = compactedLineageAnchor(
    state, prefix, state.checkpoint.blockHash,
  );
  state.journal = state.journal.slice(cutoff).map((event, sequence) => ({
    ...event, sequence,
  }));
}

function compactedLineageAnchor(
  state: CovenantLineageState,
  prefix: CovenantLineageEvent[],
  checkpointBlockHash: Hash32Hex,
): CovenantLineageState["anchor"] {
  const prefixState: CovenantLineageState = {
    ...state,
    journal: prefix,
    currentHead: state.anchor.head,
  };
  deriveCanonicalLineage(prefixState);
  const canonicalPrefix = canonicalAcceptedEvents(prefix);
  const tipTransition = canonicalPrefix.at(-1)?.transition ?? state.anchor.tipTransition;
  let bloom = state.anchor.relevantBlocksBloom;
  for (const event of prefix) {
    if (event.event === "accepted") {
      bloom = bloomAdd(bloom, event.transition.acceptance.acceptingBlockHash);
    }
  }
  return makeLineageAnchor({
    compactedEvents: state.anchor.compactedEvents + prefix.length,
    head: prefixState.currentHead,
    ...(tipTransition ? { tipTransition } : {}),
    ...(canonicalGenesisAcceptance(prefixState)
      ? { genesisAcceptance: canonicalGenesisAcceptance(prefixState)! } : {}),
    manifestIdentitySha256: state.manifest.identitySha256,
    checkpointBlockHash,
    historyHash: sha256Hex(stableStringify({
      prior: state.anchor.historyHash,
      events: prefix,
    })),
    relevantBlocksBloom: bloom,
  });
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
