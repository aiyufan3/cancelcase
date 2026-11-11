import type {
  CancellationBasis,
  CancellationRecord,
  CancellationReviewReason,
  Provenance,
} from "./types";
import { compareInstants, isValidInstant } from "./time";

/**
 * Cancellation reducer: TRACKING -> CANCEL_REQUESTED -> CANCEL_CONFIRMED,
 * with NEEDS_REVIEW for missing or conflicting proof.
 *
 * Recording a cancellation here never cancels anything at a merchant or provider.
 * A user-recorded confirmation is a user attestation; an API-observed mandate
 * cancellation is a different observation stored separately.
 */

export type CancellationEvent =
  | { type: "RECORD_CANCELLATION_REQUEST"; requestedAt: string; evidenceIds?: string[] }
  | {
      type: "RECORD_CONFIRMATION";
      receivedAt: string;
      effectiveAt: string | null;
      basis: CancellationBasis | null;
      evidenceIds: string[];
    }
  | {
      type: "OBSERVE_PROVIDER_MANDATE";
      status: string;
      observedAt: string;
      provenance?: Provenance;
      /** The provider's next planned billing, when the read states it (null: it stated none). */
      nextBillingAt?: string | null;
    }
  | {
      type: "RESOLVE_REVIEW";
      effectiveAt: string;
      basis: CancellationBasis;
      evidenceIds: string[];
      resolvedAt: string;
    }
  | { type: "REOPEN_REVIEW"; reason: CancellationReviewReason };

export function initialCancellation(): CancellationRecord {
  return {
    state: "TRACKING",
    requestedAt: null,
    confirmationReceivedAt: null,
    effectiveAt: null,
    basis: null,
    evidenceIds: [],
    reviewReasons: [],
    providerMandateStatus: null,
    providerMandateObservedAt: null,
  };
}

function uniq<T>(ids: T[]): T[] {
  return Array.from(new Set(ids));
}

export function reduceCancellation(
  record: CancellationRecord,
  event: CancellationEvent,
): CancellationRecord {
  switch (event.type) {
    case "RECORD_CANCELLATION_REQUEST": {
      if (!isValidInstant(event.requestedAt)) {
        return {
          ...record,
          state: "NEEDS_REVIEW",
          reviewReasons: uniq([...record.reviewReasons, "INVALID_TIMESTAMP"]),
        };
      }
      // A request never downgrades a confirmed cancellation.
      if (record.state === "CANCEL_CONFIRMED") {
        return { ...record, requestedAt: record.requestedAt ?? event.requestedAt };
      }
      return {
        ...record,
        state: "CANCEL_REQUESTED",
        requestedAt: event.requestedAt,
        evidenceIds: uniq([...record.evidenceIds, ...(event.evidenceIds ?? [])]),
        reviewReasons: [],
      };
    }

    case "RECORD_CONFIRMATION": {
      const reasons: CancellationReviewReason[] = [];
      if (!isValidInstant(event.receivedAt)) reasons.push("INVALID_TIMESTAMP");
      if (event.evidenceIds.length === 0) reasons.push("MISSING_EVIDENCE");
      if (!event.effectiveAt) reasons.push("MISSING_EFFECTIVE_TIME");
      else if (!isValidInstant(event.effectiveAt)) reasons.push("INVALID_TIMESTAMP");
      if (!event.basis) reasons.push("MISSING_BASIS");
      if (
        record.requestedAt &&
        isValidInstant(event.receivedAt) &&
        compareInstants(event.receivedAt, record.requestedAt) === "before"
      ) {
        reasons.push("CONFIRMATION_BEFORE_REQUEST");
      }
      if (
        record.state === "CANCEL_CONFIRMED" &&
        record.effectiveAt &&
        event.effectiveAt &&
        compareInstants(record.effectiveAt, event.effectiveAt) !== "equal"
      ) {
        reasons.push("CONFLICTING_EFFECTIVE_TIME");
      }

      const evidenceIds = uniq([...record.evidenceIds, ...event.evidenceIds]);
      if (reasons.length > 0) {
        return {
          ...record,
          state: "NEEDS_REVIEW",
          confirmationReceivedAt: isValidInstant(event.receivedAt)
            ? event.receivedAt
            : record.confirmationReceivedAt,
          evidenceIds,
          reviewReasons: uniq([...record.reviewReasons, ...reasons]),
        };
      }
      return {
        ...record,
        state: "CANCEL_CONFIRMED",
        confirmationReceivedAt: event.receivedAt,
        effectiveAt: event.effectiveAt,
        basis: event.basis,
        evidenceIds,
        reviewReasons: [],
      };
    }

    case "OBSERVE_PROVIDER_MANDATE": {
      // Provider mandate state is recorded alongside, never merged into, the cancellation state.
      if (
        record.providerMandateObservedAt &&
        compareInstants(event.observedAt, record.providerMandateObservedAt) === "before"
      ) {
        return record; // do not regress on an older observation
      }
      return {
        ...record,
        providerMandateStatus: event.status,
        providerMandateObservedAt: event.observedAt,
        providerMandateProvenance: event.provenance ?? null,
        // Each observation that states the plan replaces it; one that does not leaves it alone.
        ...(event.nextBillingAt !== undefined
          ? { providerMandateNextBillingAt: event.nextBillingAt }
          : {}),
      };
    }

    case "RESOLVE_REVIEW": {
      if (!isValidInstant(event.effectiveAt) || event.evidenceIds.length === 0) {
        return {
          ...record,
          state: "NEEDS_REVIEW",
          reviewReasons: uniq([
            ...record.reviewReasons,
            ...(isValidInstant(event.effectiveAt) ? [] : (["INVALID_TIMESTAMP"] as const)),
            ...(event.evidenceIds.length === 0 ? (["MISSING_EVIDENCE"] as const) : []),
          ]),
        };
      }
      return {
        ...record,
        state: "CANCEL_CONFIRMED",
        confirmationReceivedAt: record.confirmationReceivedAt ?? event.resolvedAt,
        effectiveAt: event.effectiveAt,
        basis: event.basis,
        evidenceIds: uniq([...record.evidenceIds, ...event.evidenceIds]),
        reviewReasons: [],
      };
    }

    case "REOPEN_REVIEW":
      return {
        ...record,
        state: "NEEDS_REVIEW",
        reviewReasons: uniq([...record.reviewReasons, event.reason]),
      };

    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

export function isCancellationConfirmed(record: CancellationRecord): boolean {
  return (
    record.state === "CANCEL_CONFIRMED" &&
    isValidInstant(record.effectiveAt) &&
    record.basis !== null &&
    record.evidenceIds.length > 0
  );
}
