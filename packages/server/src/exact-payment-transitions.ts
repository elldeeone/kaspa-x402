import {
  MAX_DURABLE_HANDLER_RESULT_BYTES,
  durableByteLength,
  durableOpenRecordBytes,
} from "./durable-record-budget.js";
import {
  acceptExactHead,
  applyExactHeadLineage,
  claimExactHead,
  exactSettlementAttemptsMatch,
  normalizeExactHeadRecord,
  normalizeExactSettlementAttempt,
  releaseExactHeadClaim,
} from "./exact-heads.js";
import {
  assertPaymentIdentifierAvailable,
  assertPaymentIdentifierCompletion,
  transitionPaymentIdentifierReservation,
} from "./payment-identifier-state.js";
import type {
  ExactHeadRecord,
  ExactPaymentRecord,
  ExactSettlementAttemptRecord,
  PaymentIdentifierRecord,
  PaymentIdentifierReservationRecord,
  ProtectedHandlerResult,
  ServerStateStore,
} from "./types.js";

type ExactTransitionMethods = {
  claim: "claimExactSettlement";
  broadcast: "recordExactSettlementBroadcast";
  accept: "acceptExactSettlement";
  "begin-handler": "beginExactHandler";
  "record-result": "recordExactHandlerResult";
  recovery: "markExactHandlerRecoveryRequired";
  abandon: "abandonExactSettlement";
  commit: "commitExactPayment";
  "register-head": "registerExactHead";
  "unavailable-head": "markExactHeadUnavailable";
  lineage: "applyExactHeadLineage";
};
/** Commands use the existing store parameters and results, without a second contract. */
export type ExactTransitionCommand = {
  [K in keyof ExactTransitionMethods]: {
    kind: K;
    args: Parameters<ServerStateStore[ExactTransitionMethods[K]]>;
  };
}[keyof ExactTransitionMethods];
type ExactTransitionResults = {
  [K in keyof ExactTransitionMethods]: Awaited<
    ReturnType<ServerStateStore[ExactTransitionMethods[K]]>
  >;
};
export type ExactTransitionResult<C extends ExactTransitionCommand> =
  ExactTransitionResults[C["kind"]];

/** Facts must be read and the resulting changes applied within one atomic operation. */
export interface ExactTransitionSnapshot {
  now: string;
  attempt?: ExactSettlementAttemptRecord;
  head?: ExactHeadRecord;
  payment?: ExactPaymentRecord;
  identifier?: PaymentIdentifierRecord;
  reservation?: PaymentIdentifierReservationRecord;
  heads?: readonly ExactHeadRecord[];
  maxHeads?: number;
}

export type ExactTransitionBudget =
  | { kind: "admit"; attempt: ExactSettlementAttemptRecord; bytes: number }
  | {
      kind: "terminal";
      transactionId: string;
      bytes: number;
      identifierId?: string;
      safelyReleased?: boolean;
    }
  | { kind: "delete"; transactionId: string };

export interface ExactTransitionChanges<R> {
  result: R;
  transactionId?: string;
  attempt?: ExactSettlementAttemptRecord | null;
  head?: ExactHeadRecord;
  payment?: ExactPaymentRecord;
  identifier?: PaymentIdentifierRecord;
  reservation?: PaymentIdentifierReservationRecord;
  budget?: ExactTransitionBudget;
}

/** The storage adapter follows this bounded read set without knowing phase rules. */
export function exactTransitionScope(
  command: ExactTransitionCommand,
  attempt?: ExactSettlementAttemptRecord,
): {
  transactionId?: string;
  headId?: string;
  identifierId?: string;
} {
  if (command.kind === "register-head")
    return { headId: normalizeExactHeadRecord(command.args[0]).headId };
  if (command.kind === "unavailable-head" || command.kind === "lineage")
    return { headId: command.args[0].headId.toLowerCase() };
  const current =
    command.kind === "claim"
      ? normalizeExactSettlementAttempt(command.args[0])
      : attempt;
  const transactionId =
    command.kind === "claim"
      ? command.args[0].transactionId
      : command.kind === "commit"
        ? command.args[0].payment.transactionId
        : command.args[0];
  return {
    transactionId: transactionId.toLowerCase(),
    headId: current?.head?.headId,
    identifierId:
      current?.paymentIdentifier?.id ??
      (command.kind === "commit"
        ? command.args[0].paymentIdentifier?.id
        : undefined),
  };
}

/**
 * Owns complete exact transition decisions, including related ownership records
 * and budget disposition. It never writes or awaits: memory applies the changes
 * synchronously; durable adapters use their existing transaction and indexes.
 */
export function prepareExactTransition<C extends ExactTransitionCommand>(
  command: C,
  snapshot: ExactTransitionSnapshot,
): ExactTransitionChanges<ExactTransitionResult<C>>;
export function prepareExactTransition(
  command: ExactTransitionCommand,
  snapshot: ExactTransitionSnapshot,
): ExactTransitionChanges<unknown> {
  const unchanged = { result: undefined };
  if (command.kind === "register-head") {
    const head = normalizeExactHeadRecord(command.args[0]);
    if (snapshot.head) {
      if (stableJson(snapshot.head) !== stableJson(head))
        throw new Error(
          "exact head id is already registered for different state",
        );
      return {
        head: structuredClone(snapshot.head),
        result: structuredClone(snapshot.head),
      };
    }
    if (
      snapshot.heads?.some((item) =>
        sameOutpoint(item.currentOutpoint, head.currentOutpoint),
      )
    )
      throw new Error("exact head outpoint is already registered");
    if (!snapshot.heads || snapshot.maxHeads === undefined)
      throw new Error("exact head admission snapshot is missing");
    if (snapshot.heads.length >= snapshot.maxHeads)
      throw new Error("exact head admission limit exceeded");
    return { head, result: structuredClone(head) };
  }
  if (command.kind === "unavailable-head" || command.kind === "lineage") {
    const head = snapshot.head;
    if (!head) throw new Error("exact head was not found");
    if (command.kind === "lineage") {
      const next = applyExactHeadLineage(head, command.args[0]);
      return { head: next, result: structuredClone(next) };
    }
    if (head.status === "retired")
      throw new Error("retired exact head cannot be marked unavailable");
    const [input] = command.args;
    if (
      head.version !== input.expectedVersion ||
      !sameOutpoint(head.currentOutpoint, input.expectedOutpoint) ||
      head.currentAmount !== input.expectedAmount ||
      head.status !== input.expectedStatus
    )
      return { result: { applied: false, head: structuredClone(head) } };
    const next: ExactHeadRecord = {
      ...head,
      status: "unavailable",
      unavailableReason: input.reason,
      updatedAt: input.observedAt,
    };
    return {
      head: next,
      result: { applied: true, head: structuredClone(next) },
    };
  }
  if (command.kind === "claim") {
    const attempt = normalizeExactSettlementAttempt(command.args[0]);
    if (snapshot.attempt) {
      if (!exactSettlementAttemptsMatch(snapshot.attempt, attempt))
        throw new Error(
          "exact transaction is already claimed for a different request",
        );
      return {
        result: { attempt: structuredClone(snapshot.attempt), created: false },
      };
    }
    assertPaymentIdentifierAvailable(
      attempt.paymentIdentifier,
      snapshot.reservation,
      snapshot.identifier,
    );
    let head: ExactHeadRecord | undefined;
    if (attempt.profile === "additive") {
      if (!attempt.head)
        throw new Error("additive exact settlement requires a head claim");
      if (!snapshot.head)
        throw new Error("exact head changed before settlement claim");
      head = claimExactHead(snapshot.head, attempt);
    } else if (attempt.head)
      throw new Error("standard-native exact settlement cannot claim a head");
    const claim = attempt.paymentIdentifier;
    const reservation = transitionPaymentIdentifierReservation(
      claim,
      snapshot.reservation,
      { kind: "reserve", observedAt: attempt.createdAt },
    );
    return {
      transactionId: attempt.transactionId,
      attempt,
      head,
      reservation,
      budget: {
        kind: "admit",
        attempt,
        bytes: durableOpenRecordBytes(attempt),
      },
      result: { attempt: structuredClone(attempt), created: true },
    };
  }
  if (command.kind === "commit") {
    const { payment, paymentIdentifier: identifier } = structuredClone(
      command.args[0],
    );
    if (snapshot.payment) {
      if (
        snapshot.payment.requestFingerprint !== payment.requestFingerprint ||
        snapshot.payment.paymentPayloadHash !== payment.paymentPayloadHash ||
        snapshot.payment.paymentOutputIndex !== payment.paymentOutputIndex
      )
        throw new Error(
          "exact payment transaction was already committed for a different request",
        );
      return unchanged;
    }
    const attempt = snapshot.attempt;
    let reservation: PaymentIdentifierReservationRecord | undefined;
    if (identifier) {
      if (!attempt)
        throw new Error(
          "payment identifier completion requires its reserved attempt",
        );
      assertPaymentIdentifierCompletion(
        attempt.paymentIdentifier,
        identifier,
        snapshot.reservation,
        snapshot.identifier,
      );
      reservation = transitionPaymentIdentifierReservation(
        attempt.paymentIdentifier,
        snapshot.reservation,
        { kind: "complete", observedAt: snapshot.now },
      );
    }
    let applied: ExactSettlementAttemptRecord | undefined;
    if (attempt) {
      if (
        attempt.status !== "accepted" ||
        !attempt.handlerStartedAt ||
        !attempt.handlerResult
      )
        throw new Error("exact settlement attempt is not ready to apply");
      const {
        handlerResult: _result,
        handlerCompletedAt: _completed,
        ...compact
      } = attempt;
      applied = {
        ...compact,
        status: "applied",
        transaction: "",
        recoveryReason: undefined,
        updatedAt: snapshot.now,
      };
    }
    return {
      result: undefined,
      transactionId: payment.transactionId.toLowerCase(),
      payment,
      identifier,
      reservation,
      attempt: applied,
      budget: attempt
        ? {
            kind: "terminal",
            transactionId: attempt.transactionId,
            bytes: durableByteLength({
              attempt: applied,
              payment,
              paymentIdentifier: identifier,
            }),
            identifierId: identifier?.id,
          }
        : undefined,
    };
  }
  const attempt = snapshot.attempt;
  if (!attempt) throw new Error("exact settlement attempt was not found");
  const transactionId = attempt.transactionId;
  const claim = attempt.paymentIdentifier;
  const pending = (
    next: ExactSettlementAttemptRecord,
    reservationUpdate: Pick<
      Partial<PaymentIdentifierReservationRecord>,
      "status" | "recoveryReason"
    > = {},
  ) => ({
    result: undefined,
    transactionId,
    attempt: next,
    reservation: transitionPaymentIdentifierReservation(
      claim,
      snapshot.reservation,
      {
        kind: "update",
        update: {
          status: "pending",
          updatedAt: next.updatedAt,
          ...reservationUpdate,
        },
      },
    ),
  });
  switch (command.kind) {
    case "broadcast": {
      const [, finality, observedAt] = command.args;
      if (attempt.status === "accepted" || attempt.status === "applied")
        return unchanged;
      return pending({
        ...attempt,
        status: "broadcast",
        finality,
        updatedAt: observedAt,
      });
    }
    case "accept": {
      const [, finality, observedAt] = command.args;
      if (attempt.status === "applied") return unchanged;
      let head: ExactHeadRecord | undefined;
      if (attempt.head) {
        if (!snapshot.head)
          throw new Error(
            "exact head was not found during settlement acceptance",
          );
        head = acceptExactHead(snapshot.head, attempt, observedAt);
      }
      return {
        ...pending({
          ...attempt,
          status: "accepted",
          finality,
          updatedAt: observedAt,
        }),
        head,
      };
    }
    case "begin-handler": {
      const [, startedAt] = command.args;
      if (attempt.status !== "accepted" || attempt.handlerStartedAt)
        return { result: false };
      return {
        ...pending({
          ...attempt,
          handlerStartedAt: startedAt,
          updatedAt: startedAt,
        }),
        result: true,
      };
    }
    case "record-result": {
      const [, result, completedAt] = command.args;
      assertHandlerResult(attempt, result, completedAt);
      if (attempt.handlerResult) {
        if (stableJson(attempt.handlerResult) !== stableJson(result))
          throw new Error("exact handler result conflicts with durable state");
        return unchanged;
      }
      const next = {
        ...attempt,
        handlerResult: structuredClone(result),
        handlerCompletedAt: completedAt,
        recoveryReason: undefined,
        updatedAt: completedAt,
      };
      return pending(next, { recoveryReason: undefined });
    }
    case "recovery": {
      const [, reason, observedAt] = command.args;
      if (
        attempt.status !== "accepted" ||
        !attempt.handlerStartedAt ||
        attempt.handlerResult
      )
        throw new Error("exact handler is not awaiting recovery");
      return pending(
        { ...attempt, recoveryReason: reason, updatedAt: observedAt },
        { status: "recovery-required", recoveryReason: reason },
      );
    }
    case "abandon": {
      const [, reason, observedAt] = command.args;
      if (attempt.status === "accepted" || attempt.status === "applied")
        throw new Error("accepted exact settlement cannot be abandoned");
      if (
        attempt.handlerStartedAt ||
        attempt.handlerResult ||
        attempt.recoveryReason
      )
        throw new Error("uncertain exact settlement cannot be abandoned");
      const head =
        attempt.head && snapshot.head
          ? releaseExactHeadClaim(snapshot.head, attempt, observedAt)
          : undefined;
      const reservation = transitionPaymentIdentifierReservation(
        claim,
        snapshot.reservation,
        { kind: "release", reason, observedAt, allowPending: true },
      );
      return {
        result: undefined,
        transactionId,
        attempt: null,
        head,
        reservation,
        budget: reservation
          ? {
              kind: "terminal",
              transactionId,
              bytes: durableByteLength({
                paymentIdentifierReservation: reservation,
              }),
              identifierId: reservation.id,
              safelyReleased: true,
            }
          : { kind: "delete", transactionId },
      };
    }
  }
}

function assertHandlerResult(
  attempt: ExactSettlementAttemptRecord,
  result: ProtectedHandlerResult,
  completedAt: string,
): void {
  if (attempt.status !== "accepted" || !attempt.handlerStartedAt)
    throw new Error("exact handler has not started on an accepted settlement");
  if (Number.isNaN(Date.parse(completedAt)))
    throw new Error("exact handler completion time must be an ISO date string");
  if (
    result.status !== undefined &&
    (!Number.isInteger(result.status) ||
      result.status < 100 ||
      result.status > 599)
  )
    throw new Error("exact handler status is invalid");
  if (
    result.headers &&
    Object.values(result.headers).some((value) => typeof value !== "string")
  )
    throw new Error("exact handler headers are invalid");
  if (result.headers && Object.keys(result.headers).length > 64)
    throw new Error("exact handler has too many response headers");
  let serialized: string;
  try {
    serialized = JSON.stringify(result);
  } catch {
    throw new Error("exact handler result must be JSON serializable");
  }
  if (
    new TextEncoder().encode(serialized).byteLength >
    MAX_DURABLE_HANDLER_RESULT_BYTES
  )
    throw new Error("exact handler result exceeds the durable size limit");
  if (
    result.chargedAmount !== undefined &&
    result.chargedAmount !== attempt.amount
  )
    throw new Error("exact handler charge must equal the accepted amount");
}
function sameOutpoint(
  left: { txid: string; index: number },
  right: { txid: string; index: number },
): boolean {
  return (
    left.txid.toLowerCase() === right.txid.toLowerCase() &&
    left.index === right.index
  );
}
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}
