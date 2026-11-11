import type { AppContext } from "../context";
import { cases, claims } from "../db/repos";
import type { ClaimReservationRecord } from "../records";
import { logAudit } from "./audit";
import { AppError } from "./errors";
import type { CaseBundle } from "./snapshot";

/**
 * One active or unresolved financial claim per charge.
 *
 * The reservation row (primary key = charge) is taken inside the same SQLite transaction that
 * creates the claim-opening operation, so a second approval, a second tab, a graph replay, a
 * restart or another process on the same database file cannot open a second claim. It is
 * released only by a verified non-dispatch outcome (never sent, definitive provider failure),
 * by a provider read-back that reports the case resolved, or by an explicit human recovery
 * decision that is backed by a read-back. A local channel change never releases it.
 */

export type ClaimState = "none" | "reserved" | "open";

export function claimForCharge(ctx: AppContext, chargeId: string): ClaimReservationRecord | null {
  return claims.getForPayment(ctx.db, chargeId);
}

export function claimState(rec: ClaimReservationRecord | null): ClaimState {
  if (!rec) return "none";
  return rec.state === "OPEN" ? "open" : "reserved";
}

/** Refuse to start a new claim-opening action while the charge already has one. */
export function assertNoClaimForCharge(ctx: AppContext, bundle: CaseBundle): void {
  const existing = claimForCharge(ctx, bundle.charge.id);
  if (!existing) return;
  throw new AppError(
    "CLAIM_ALREADY_ACTIVE",
    existing.state === "OPEN"
      ? "A provider case is already open for this charge. A second claim for the same charge is not allowed; refresh the provider case instead."
      : "A submission for this charge is prepared, executing or has an unknown result. Resolve it before starting another claim.",
    409,
    { state: existing.state, channel: existing.channel },
  );
}

/** Release a reservation held by an operation that verifiably did not open a claim. */
export function releaseClaimForOperation(
  ctx: AppContext,
  chargeId: string,
  operationId: string,
  caseId: string,
  reason: string,
): boolean {
  const released = claims.release(ctx.db, chargeId, operationId);
  if (released) {
    logAudit(ctx, {
      action: "claim.released",
      caseId,
      operationId,
      reasonCode: reason,
    });
  }
  return released;
}

/** Mark the reservation as an open provider claim and reflect it on the case record. */
export function openClaimForOperation(
  ctx: AppContext,
  input: {
    chargeId: string;
    caseId: string;
    operationId: string | null;
    providerRef: string | null;
  },
): void {
  const now = ctx.clock.now().toISOString();
  claims.markOpen(ctx.db, input.chargeId, input.operationId, input.providerRef, now);
  const rec = cases.get(ctx.db, input.caseId);
  if (rec)
    cases.update(ctx.db, { ...rec, claimActive: true, claimClosedReason: null, updatedAt: now });
  logAudit(ctx, {
    action: "claim.opened",
    caseId: input.caseId,
    operationId: input.operationId,
  });
}

/**
 * Record an already-open provider claim that this application did not create (an imported
 * Sandbox case). Fails when a different claim already holds the charge.
 */
export function registerExistingClaim(
  ctx: AppContext,
  input: { chargeId: string; caseId: string; providerRef: string },
): void {
  ctx.db
    .transaction(() => {
      const now = ctx.clock.now().toISOString();
      const existing = claims.listForPayment(ctx.db, input.chargeId);
      if (existing.length > 0) {
        if (
          existing.every(
            (claim) => claim.state === "OPEN" && claim.providerRef === input.providerRef,
          )
        )
          return;
        throw new AppError(
          "CLAIM_ALREADY_ACTIVE",
          "Another claim already holds this payment; it cannot be attached to a second provider case.",
          409,
        );
      }
      const reserved = claims.reserve(ctx.db, {
        chargeId: input.chargeId,
        environment: ctx.config.mode,
        caseId: input.caseId,
        channel: "paypal",
        state: "OPEN",
        operationId: null,
        providerRef: input.providerRef,
        openedAt: now,
        updatedAt: now,
      });
      if (!reserved)
        throw new AppError(
          "CLAIM_ALREADY_ACTIVE",
          "Another claim reserved this payment concurrently; the import was not applied.",
          409,
        );
      logAudit(ctx, { action: "claim.registered", caseId: input.caseId, reasonCode: "IMPORTED" });
    })
    .immediate();
}

/** The provider reported the case closed: the charge may carry a new claim after a new review. */
export function releaseClaimOnProviderResolution(
  ctx: AppContext,
  input: { chargeId: string; caseId: string; providerRef: string; status: string },
): boolean {
  return ctx.db
    .transaction(() => {
      const existing = claims.listForPayment(ctx.db, input.chargeId).filter((claim) => {
        if (claim.state !== "OPEN") return false;
        if (claim.providerRef) return claim.providerRef === input.providerRef;
        // Older migrated claims may have no provider_ref. Release one only when its own case's
        // provider observation establishes that this is the dispute the provider resolved.
        return (
          cases.get(ctx.db, claim.caseId)?.providerObservation?.disputeId === input.providerRef
        );
      });
      const released = existing.filter((claim) => claims.releaseObserved(ctx.db, claim));
      if (released.length === 0) return false;
      for (const caseId of new Set([input.caseId, ...released.map((claim) => claim.caseId)])) {
        const rec = cases.get(ctx.db, caseId);
        if (rec && !claims.getForPayment(ctx.db, rec.chargeId))
          cases.update(ctx.db, {
            ...rec,
            claimActive: false,
            claimClosedReason: `Provider reported the case ${input.status}.`,
            updatedAt: ctx.clock.now().toISOString(),
          });
      }
      logAudit(ctx, {
        action: "claim.released",
        caseId: input.caseId,
        reasonCode: `PROVIDER_${input.status}`,
      });
      return true;
    })
    .immediate();
}
