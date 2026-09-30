import type {
  PaymentIdentifierReservationClaim,
  PaymentIdentifierReservationRecord,
  PaymentIdentifierRecord,
} from "./types.js";

/** Ownership facts shared by exact and batch payment identifier reservations. */
export function assertPaymentIdentifierReservationClaim(
  claim: PaymentIdentifierReservationClaim,
): void {
  const hash = (value: string) => /^[0-9a-f]{64}$/.test(value);
  if (
    typeof claim.id !== "string" ||
    !claim.id ||
    claim.id.length > 256 ||
    typeof claim.payerId !== "string" ||
    !claim.payerId ||
    claim.payerId.length > 256 ||
    !hash(claim.fingerprint) ||
    !hash(claim.paymentPayloadHash) ||
    !hash(claim.paymentScopeId) ||
    !hash(claim.ownerId)
  )
    throw new Error("payment identifier reservation is invalid");
  if (claim.paymentKind === "batch-settlement") {
    if (
      !claim.channelId ||
      claim.transactionId ||
      claim.paymentOutputIndex !== undefined
    )
      throw new Error("batch payment identifier ownership is invalid");
  } else if (claim.paymentKind === "exact") {
    if (
      !claim.transactionId ||
      claim.channelId ||
      !Number.isInteger(claim.paymentOutputIndex) ||
      claim.paymentOutputIndex! < 0
    )
      throw new Error("exact payment identifier ownership is invalid");
  } else throw new Error("payment identifier kind is invalid");
}

export function paymentIdentifierReservationClaimsMatch(
  left: PaymentIdentifierReservationClaim,
  right: PaymentIdentifierReservationClaim,
): boolean {
  return (
    left.id === right.id &&
    left.fingerprint === right.fingerprint &&
    left.paymentPayloadHash === right.paymentPayloadHash &&
    left.paymentScopeId === right.paymentScopeId &&
    left.paymentKind === right.paymentKind &&
    left.ownerId === right.ownerId &&
    left.payerId === right.payerId &&
    left.channelId === right.channelId &&
    left.transactionId === right.transactionId &&
    left.paymentOutputIndex === right.paymentOutputIndex
  );
}

/** Checks ownership against the reservation and retained replay record together. */
export function assertPaymentIdentifierAvailable(
  claim: PaymentIdentifierReservationClaim | undefined,
  reservation: PaymentIdentifierReservationRecord | undefined,
  completed: PaymentIdentifierRecord | undefined,
): void {
  if (!claim) return;
  assertPaymentIdentifierReservationClaim(claim);
  if (
    completed &&
    (completed.fingerprint !== claim.fingerprint ||
      completed.paymentPayloadHash !== claim.paymentPayloadHash ||
      completed.paymentScopeId !== claim.paymentScopeId)
  )
    throw new Error("payment identifier is already owned by another payment");
  if (
    reservation &&
    reservation.status !== "safely-released" &&
    !paymentIdentifierReservationClaimsMatch(reservation, claim)
  )
    throw new Error("payment identifier is already owned by another payment");
}

export function assertPaymentIdentifierCompletion(
  claim: PaymentIdentifierReservationClaim | undefined,
  completed: PaymentIdentifierRecord | undefined,
  reservation: PaymentIdentifierReservationRecord | undefined,
  retained: PaymentIdentifierRecord | undefined,
): void {
  if (!claim && !completed) return;
  if (
    !claim ||
    !completed ||
    claim.id !== completed.id ||
    claim.fingerprint !== completed.fingerprint ||
    claim.paymentPayloadHash !== completed.paymentPayloadHash ||
    claim.paymentScopeId !== completed.paymentScopeId ||
    claim.channelId !== completed.channelId ||
    claim.transactionId !== completed.transactionId ||
    claim.paymentOutputIndex !== completed.paymentOutputIndex
  )
    throw new Error("payment identifier completion does not match reservation");
  if (
    !reservation ||
    !paymentIdentifierReservationClaimsMatch(reservation, claim) ||
    reservation.status === "safely-released"
  )
    throw new Error("payment identifier completion lost its reservation");
  assertPaymentIdentifierAvailable(claim, reservation, retained);
}

export type PaymentIdentifierReservationTransition =
  | { kind: "reserve"; observedAt: string }
  | { kind: "complete"; observedAt: string }
  | {
      kind: "update";
      update: Pick<PaymentIdentifierReservationRecord, "status" | "updatedAt"> &
        Pick<Partial<PaymentIdentifierReservationRecord>, "recoveryReason">;
    }
  | {
      kind: "release";
      reason: string;
      observedAt: string;
      allowPending?: boolean;
    };

/** Computes the complete reservation successor; callers keep their storage atomic. */
export function transitionPaymentIdentifierReservation(
  claim: PaymentIdentifierReservationClaim | undefined,
  current: PaymentIdentifierReservationRecord | undefined,
  transition: PaymentIdentifierReservationTransition,
): PaymentIdentifierReservationRecord | undefined {
  if (!claim) return undefined;
  if (transition.kind === "reserve") {
    if (current && current.status !== "safely-released") return undefined;
    return {
      ...structuredClone(claim),
      status: "reserved",
      createdAt: transition.observedAt,
      updatedAt: transition.observedAt,
    };
  }
  if (!current || !paymentIdentifierReservationClaimsMatch(current, claim)) {
    const error =
      transition.kind === "complete"
        ? "payment identifier completion lost its reservation"
        : transition.kind === "release"
          ? "payment identifier release lost its reservation"
          : "payment identifier reservation ownership changed";
    throw new Error(error);
  }
  if (transition.kind === "complete") {
    if (current.status === "safely-released")
      throw new Error("released payment identifier cannot be completed");
    return {
      ...current,
      status: "completed",
      recoveryReason: undefined,
      updatedAt: transition.observedAt,
    };
  }
  if (transition.kind === "release") {
    if (
      (current.status !== "reserved" &&
        !(transition.allowPending && current.status === "pending")) ||
      current.recoveryReason !== undefined
    )
      throw new Error(
        "uncertain or completed payment identifier cannot be released",
      );
    return {
      ...current,
      status: "safely-released",
      recoveryReason: transition.reason,
      updatedAt: transition.observedAt,
    };
  }
  if (current.status === "completed" || current.status === "safely-released")
    throw new Error("terminal payment identifier reservation cannot change");
  return { ...current, ...transition.update };
}
